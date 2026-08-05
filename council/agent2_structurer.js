/**
 * Agent 2 — Option Structurer ("The Quant")
 *
 * Locates exact option contracts from real market chain + quote data and
 * performs tick-precise pricing math. No price, strike, or Greek is ever
 * guessed — a missing real-time quote disqualifies a contract rather than
 * being estimated.
 */
const { getOptionsChain, getOptionQuotes, getBars } = require('../marketdata');
const { impliedVol, bsDelta } = require('../greek');
const { RISK_FREE_RATE } = require('../config');
const { atr } = require('./indicators');
const analytics = require('../analytics');
const db = require('./db');

const MIN_OPEN_INTEREST = 1000;
const MIN_VOLUME        = 500;
const MAX_SPREAD        = 0.08;
const TARGET_ATR_MULT   = 1.8; // target = entry + 1.8x underlying ATR(14), translated through delta
const STOP_ATR_MULT     = 1.0; // stop   = entry - 1.0x underlying ATR(14), translated through delta
// ATR translated through delta can swing wildly (options leverage) — a cheap,
// high-delta contract can imply a 40%+ stop. Clamp to a band that keeps a
// single stopped-out trade consistent with Agent 3's 10-15% position sizing
// and 5% weekly-drawdown limit, while still letting real volatility move the
// exit within that band instead of using one flat number for every symbol.
const TARGET_MIN_PCT    = 0.15;
const TARGET_MAX_PCT    = 0.35;
const STOP_MIN_PCT      = 0.08;
const STOP_MAX_PCT      = 0.20;

function fmtDate(d) { return d.toISOString().split('T')[0]; }

function tickSize(price) { return price < 3 ? 0.01 : 0.05; }
function roundToTick(price, tick, dir) {
  const fn = dir === 'up' ? Math.ceil : Math.floor;
  return Number((fn(price / tick) * tick).toFixed(2));
}

async function structureContract(symbol, bias, spotPrice) {
  const optType = bias === 'CALL' ? 'call' : 'put';
  const { delta_min, delta_max, dte_min, dte_max } = db.getThresholds();

  const today = new Date();
  const minExp = new Date(today); minExp.setDate(today.getDate() + dte_min);
  const maxExp = new Date(today); maxExp.setDate(today.getDate() + dte_max);

  // Bound the strike search to a band around spot wide enough to contain
  // 0.50-0.65 delta contracts on either side, without pulling the whole chain.
  const strikeGte = spotPrice * 0.75;
  const strikeLte = spotPrice * 1.25;

  // Underlying's own realized volatility (ATR) — used below to size the
  // target/stop to how much this specific symbol actually moves, instead of
  // a flat percentage that would treat a sleepy utility ETF the same as a
  // volatile semiconductor one.
  const underlyingBars = await getBars(symbol, '1Day', 30);
  const underlyingATR = atr(underlyingBars, 14);
  if (!underlyingATR) {
    return { ok: false, vetoReason: 'DATA_INSUFFICIENT', detail: `Could not compute ATR(14) for ${symbol} (only ${underlyingBars.length} daily bars) — needed to size target/stop to real volatility.` };
  }

  let contracts;
  try {
    contracts = await getOptionsChain(symbol, optType, fmtDate(minExp), fmtDate(maxExp), strikeGte, strikeLte);
  } catch (err) {
    return { ok: false, vetoReason: 'DATA_INSUFFICIENT', detail: `Chain lookup failed: ${err.response?.data?.message || err.message}` };
  }
  if (!contracts.length) {
    return { ok: false, vetoReason: 'DATA_INSUFFICIENT', detail: `No ${optType} contracts for ${symbol} in ${dte_min}-${dte_max} DTE window.` };
  }

  // Liquidity pre-filter on reference data (OI/volume).
  let liquid = contracts.filter(c => parseInt(c.open_interest || 0) > MIN_OPEN_INTEREST && parseInt(c.volume || 0) > MIN_VOLUME);
  let liquidityNote = `OI > ${MIN_OPEN_INTEREST} and Volume > ${MIN_VOLUME}`;
  if (!liquid.length) {
    // The market data provider's paper/reference feed frequently reports volume=0 (data gap, not
    // actually zero volume) — relax to OI-only rather than hallucinate a pass.
    const oiOnly = contracts.filter(c => parseInt(c.open_interest || 0) > MIN_OPEN_INTEREST);
    if (!oiOnly.length) {
      return { ok: false, vetoReason: 'DATA_INSUFFICIENT', detail: `No contracts cleared OI > ${MIN_OPEN_INTEREST}.` };
    }
    liquid = oiOnly;
    liquidityNote = `OI > ${MIN_OPEN_INTEREST} (volume feed unavailable — relaxed)`;
  }

  const quotes = await getOptionQuotes(liquid.map(c => c.symbol));

  const candidates = [];
  for (const c of liquid) {
    const q = quotes[c.symbol];
    if (!q) continue; // no live quote — do not estimate, just exclude
    const spread = q.ask - q.bid;
    if (spread >= MAX_SPREAD) continue;

    const strike  = parseFloat(c.strike_price);
    const expDate = new Date(c.expiration_date);
    const T = Math.max(0.001, (expDate - Date.now()) / (365 * 24 * 60 * 60 * 1000));
    const iv = impliedVol(q.mid, spotPrice, strike, T, RISK_FREE_RATE, optType);
    if (!iv || iv <= 0) continue;
    const delta = Math.abs(bsDelta(spotPrice, strike, T, RISK_FREE_RATE, iv, optType));
    if (delta < delta_min || delta > delta_max) continue;

    // Expected-move sanity check: compares two independent volatility
    // measures. ATR is the underlying's own realized (historical) daily
    // range; expectedMove is the option market's forward-looking (implied)
    // range by expiration (spot × IV × √T — the standard ~1-stdev move). If
    // the ATR-based target below would require the underlying to move
    // further than the market itself expects as likely, this contract's
    // target is a low-probability stretch — skip it rather than recommend a
    // target the market is already telling us is unlikely.
    const expectedMove = spotPrice * iv * Math.sqrt(T);
    const requiredMove = TARGET_ATR_MULT * underlyingATR;
    if (requiredMove > expectedMove) continue;

    candidates.push({
      contract: c, symbol: c.symbol, strike, expiration: c.expiration_date,
      bid: q.bid, ask: q.ask, mid: q.mid, spread, iv, delta,
      openInterest: parseInt(c.open_interest || 0), volume: parseInt(c.volume || 0),
      dte: Math.round((expDate - Date.now()) / (24 * 60 * 60 * 1000)),
      expectedMove, requiredMove,
    });
  }

  if (!candidates.length) {
    return {
      ok: false, vetoReason: 'DATA_INSUFFICIENT',
      detail: `No contract met Delta ${delta_min}-${delta_max}, spread < $${MAX_SPREAD}, live-quote, and expected-move requirements (checked ${liquid.length} liquid contracts, ${liquidityNote}).`,
    };
  }

  const targetDelta = (delta_min + delta_max) / 2;
  candidates.sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));
  const best = candidates[0];

  // Entry priced at the ASK, not the mid — the mid is a fair-value estimate,
  // but a real marketable buy order fills at the ask. Pricing entry at mid
  // was quietly assuming a better fill than you'll actually get; this way
  // target/stop are calculated off what you'd really pay.
  const tick = tickSize(best.ask);
  const entryLimit = Number(best.ask.toFixed(2));

  // Target/stop sized to the underlying's own ATR(14), translated into an
  // expected premium move via delta (first-order: premium move ≈ delta ×
  // underlying move) — replaces a flat percentage with a move scaled to how
  // much this specific symbol actually tends to travel. The raw ATR-derived
  // percentage is then clamped to a sane band (see constants above) so a
  // cheap, high-delta contract can't imply an outsized stop.
  const rawTargetMove = TARGET_ATR_MULT * underlyingATR * best.delta;
  const rawStopMove    = STOP_ATR_MULT * underlyingATR * best.delta;
  const targetPct = Math.min(TARGET_MAX_PCT, Math.max(TARGET_MIN_PCT, rawTargetMove / entryLimit));
  const stopPct    = Math.min(STOP_MAX_PCT, Math.max(STOP_MIN_PCT, rawStopMove / entryLimit));
  const targetLimit = roundToTick(entryLimit * (1 + targetPct), tick, 'up');
  // A stop can never be computed at/below zero, nor at/above entry.
  const stopLimit = Math.max(tick, Math.min(roundToTick(entryLimit * (1 - stopPct), tick, 'down'), entryLimit - tick));

  analytics.recordIV(symbol, best.iv);
  const ivRank = analytics.getIVRank(symbol);

  return {
    ok: true,
    symbol, optType, bias, spotPrice,
    contract: best.contract, contractSymbol: best.symbol,
    strike: best.strike, expiration: best.expiration, dte: best.dte,
    delta: best.delta, iv: best.iv, ivRank,
    bid: best.bid, ask: best.ask, spread: best.spread,
    openInterest: best.openInterest, volume: best.volume,
    entryLimit, targetLimit, stopLimit, tick,
    expectedMove: best.expectedMove, requiredMove: best.requiredMove,
    underlyingATR, targetAtrMult: TARGET_ATR_MULT, stopAtrMult: STOP_ATR_MULT,
    targetPct, stopPct,
    targetClamped: Math.abs(targetPct - rawTargetMove / entryLimit) > 1e-9,
    stopClamped: Math.abs(stopPct - rawStopMove / entryLimit) > 1e-9,
    thresholdsUsed: { delta_min, delta_max, dte_min, dte_max },
    liquidityNote,
  };
}

module.exports = { structureContract, tickSize, roundToTick };
