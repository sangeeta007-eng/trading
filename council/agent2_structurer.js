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
const { profitFeasibility } = require('./methodology');
const { atr } = require('./indicators');
const analytics = require('../analytics');
const db = require('./db');

const MIN_OPEN_INTEREST = 1000;
const MIN_VOLUME        = 500;
// Spread cap is RELATIVE to the contract's own price, not a flat dollar
// amount. A flat $0.08 cap silently restricted the whole system to options
// priced roughly under $2 — on a $12 option, $0.08 is 0.6%, which
// essentially no ETF option ever quotes. Combined with a delta band that
// favours deeper-ITM (pricier) contracts, the two filters fought each other
// and nothing could ever qualify. What actually matters is how much of the
// move gets eaten by crossing the spread, which is a percentage question.
const MAX_SPREAD_PCT    = 0.08;  // 8% of mid
const MAX_SPREAD_FLOOR  = 0.05;  // ...but always allow at least a nickel, for cheap contracts
function spreadCap(mid) { return Math.max(MAX_SPREAD_FLOOR, mid * MAX_SPREAD_PCT); }

// Affordability cap on the premium itself. A 0.5-0.65 delta contract on a
// high-priced ETF can run $1,400+, which swallows a whole position slot and
// leaves no room to scale out in pieces. Contracts above this are excluded
// from picks — the symbol still shows up in WARM with the real cheapest
// price, so nothing is hidden, it just doesn't get recommended.
const MAX_PREMIUM_PER_CONTRACT = parseFloat(process.env.MAX_PREMIUM_PER_CONTRACT) || 1000;
const TARGET_ATR_MULT   = 1.8; // target = entry + 1.8x underlying ATR(14), translated through delta
const STOP_ATR_MULT     = 1.0; // stop   = entry - 1.0x underlying ATR(14), translated through delta
// Target band is the stated goal: 12-15% on the premium, taken quickly and
// repeatedly. ATR still decides *where inside the band* each symbol lands —
// a more volatile underlying gets pushed toward 15%, a quiet one toward 12%
// — so the number is still derived from that symbol's real behaviour rather
// than being one flat figure for everything.
//
// The stop band is tightened to 8-10% deliberately. Reward:risk has to stay
// above 1:1 for the strategy to survive an ordinary win rate: at a 12%
// target against a 20% stop you would need a 63% win rate just to break
// even, versus 45% at 12/10. The cost of the tighter stop is being shaken
// out more often by ordinary option noise — that's the real trade-off, and
// it's stated in the report rather than buried.
const TARGET_MIN_PCT    = 0.12;
const TARGET_MAX_PCT    = 0.15;
// Stop band widened deliberately, against instinct, because the backtest was
// unambiguous. On the Connors dip entry, 8 years of real bars gave:
//     stop -30% ... +1.00%/trade, worst trade -83.9%
//     stop -50% ... +4.34%/trade, worst trade -88.1%
//     stop -70% ... +6.53%/trade, worst trade -94.8%
//     no stop  ... +8.28%/trade, worst trade -100%
// A tight stop does not cap the tail — options gap straight through it, so
// the -30% stop still lost 83.9% on its worst trade — while reliably cutting
// winners short. It is close to pure cost. 60-70% keeps an explicit exit
// without paying that much for it; the real risk control is that a long
// option cannot lose more than the premium, and position sizing decides how
// much premium is on the table.
const STOP_MIN_PCT      = 0.60;
const STOP_MAX_PCT      = 0.70;

// A 21-DTE contract held for the intended three weeks expires in your hand.
// The learning loop may tune DTE, but never below what the holding window
// structurally requires.
const MIN_DTE_FOR_HOLD  = 30;
const TARGET_HOLD_TRADING_DAYS = 15; // ~3 calendar weeks

function fmtDate(d) { return d.toISOString().split('T')[0]; }

function tickSize(price) { return price < 3 ? 0.01 : 0.05; }
function roundToTick(price, tick, dir) {
  const fn = dir === 'up' ? Math.ceil : Math.floor;
  return Number((fn(price / tick) * tick).toFixed(2));
}

async function structureContract(symbol, bias, spotPrice) {
  const optType = bias === 'CALL' ? 'call' : 'put';
  const { delta_min, delta_max, dte_min: tunedDteMin, dte_max } = db.getThresholds();
  const dte_min = Math.max(tunedDteMin, MIN_DTE_FOR_HOLD);

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
    if (spread >= spreadCap(q.mid)) continue;

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
      detail: `No contract met Delta ${delta_min}-${delta_max}, spread < ${(MAX_SPREAD_PCT * 100).toFixed(0)}% of mid (min $${MAX_SPREAD_FLOOR}), live-quote, and expected-move requirements (checked ${liquid.length} liquid contracts, ${liquidityNote}).`,
    };
  }

  // Affordability filter, applied after the quality filters so the reject
  // message can quote the real cheapest qualifying contract rather than a
  // vague "nothing found".
  const affordable = candidates.filter(c => c.ask * 100 <= MAX_PREMIUM_PER_CONTRACT);
  if (!affordable.length) {
    const cheapest = candidates.reduce((a, b) => (a.ask <= b.ask ? a : b));
    return {
      ok: false, vetoReason: 'DATA_INSUFFICIENT',
      detail: `Cheapest qualifying contract costs $${(cheapest.ask * 100).toFixed(0)} per contract (${cheapest.expiration} $${cheapest.strike} @ $${cheapest.ask.toFixed(2)}), above the $${MAX_PREMIUM_PER_CONTRACT} per-contract limit. Real setup, just too expensive per contract to size sensibly — raise MAX_PREMIUM_PER_CONTRACT in .env to include these.`,
    };
  }

  const targetDelta = (delta_min + delta_max) / 2;
  affordable.sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta));
  const best = affordable[0];

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

  // Can this contract actually reach the target inside the intended holding
  // window? Compares the underlying move required against the move the
  // options market itself is pricing over those weeks. Both real numbers —
  // this is a feasibility check, not a forecast.
  const feasibility = profitFeasibility({
    premium: entryLimit, delta: best.delta, spot: spotPrice, iv: best.iv,
    targetPct, holdTradingDays: TARGET_HOLD_TRADING_DAYS,
  });

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
    feasibility, targetHoldDays: TARGET_HOLD_TRADING_DAYS,
    targetPct, stopPct,
    targetClamped: Math.abs(targetPct - rawTargetMove / entryLimit) > 1e-9,
    stopClamped: Math.abs(stopPct - rawStopMove / entryLimit) > 1e-9,
    thresholdsUsed: { delta_min, delta_max, dte_min, dte_max },
    liquidityNote,
  };
}

module.exports = { structureContract, tickSize, roundToTick };
