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

// Liquidity tiers, tried in order until one yields a usable contract.
//
// A single hard OI floor was silently emptying the chain. Measured on XLP:
// 72 contracts in the window, exactly 2 with OI > 1000, 0 with OI > 1000 AND
// volume > 500 — the reference feed reports 0 volume and 0 OI for most
// contracts, which is a data gap, not an illiquid market. The filter was
// discarding 70 of 72 contracts on the strength of missing data, and then
// the delta band had nothing left to match against, so a genuine signal
// (XLP, conviction 60) reported "no contract met the requirements" as though
// the market were at fault.
//
// Relaxing in stages keeps the strict bar as the preference while refusing
// to turn a data gap into a silent no-trade. Whichever tier produced the
// pick is recorded and shown, so a loosely-sourced contract never passes
// itself off as a strictly-sourced one.
const LIQUIDITY_TIERS = [
  { oi: 1000, vol: 500, label: 'open interest > 1000 and volume > 500' },
  { oi: 1000, vol: 0,   label: 'open interest > 1000 (volume feed reported nothing)' },
  { oi: 250,  vol: 0,   label: 'open interest > 250' },
  { oi: 0,    vol: 0,   label: 'any contract with a live two-sided quote' },
];

// How far the delta band may be widened when nothing sits inside it. The
// learning loop can tune the band to 0.6-0.7, and on a thin chain there may
// be no contract in a 0.10-wide window at all — XLP's only quoted contract
// was delta 0.52. Widening symmetrically and saying so beats reporting no
// trade on a day the signal actually fired.
const DELTA_WIDENING = [0, 0.05, 0.10, 0.15];
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
// THE STOP IS ON THE UNDERLYING, NOT ON THE OPTION.
//
// This is the single most important structural decision in the file, and it
// reverses how the engine used to work. Measured over 8 years of real bars
// on the Connors dip entry, stopping on the option's own price gave:
//     option -30% ..... -0.22%/trade, 59.4% win, worst trade -100%
//     option -65% ..... +3.61%/trade, 73.8% win, worst trade -100%
//     no stop at all .. +5.16%/trade, 75.1% win, worst trade -100%
// and stopping on the underlying instead gave:
//     underlying -1.0 ATR .. -0.01%/trade, 60.4% win, worst trade -100%
//     underlying -2.0 ATR .. +2.36%/trade, 70.6% win, worst trade -100%
//     underlying -2.5 ATR .. +3.38%/trade, 73.2% win, worst trade -100%
//
// Read the worst-trade column: it is -100% in every row. A stop of any kind,
// at any level, on either instrument, never once prevented a total loss —
// options gap straight through stops overnight. So a stop is not, and cannot
// be, the risk control on a long option. What it can do is define when the
// *thesis* is dead, and the thesis here is "this dipped below its own trend
// and should revert." That thesis fails when the underlying keeps falling,
// which has nothing to do with what IV or theta did to the premium in the
// meantime. Hence: stop on price, at 2.5x the symbol's own ATR(14) below
// entry. It matches the best premium-stop result (3.38% vs 3.61%) while
// being expressed as something you can actually read and act on — "exit if
// XOM closes under $103.40" rather than an alarming "-60%".
//
// The real risk control is position sizing, enforced in agent3_risk.js: size
// so that losing the entire premium is survivable, because sometimes you do.
const STOP_UNDERLYING_ATR_MULT = 2.5;
// The premium stop is kept only as a disaster backstop, set far enough out
// that it does not fire on ordinary noise ahead of the underlying stop.
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

  // Quote the whole window once. Quotes are the real liquidity evidence —
  // a live two-sided quote inside the spread cap says more about whether a
  // contract is tradable than a reference-data OI field that is frequently
  // just absent.
  const quotes = await getOptionQuotes(contracts.map(c => c.symbol));

  // Everything that is priceable and not too wide, measured once. The tiers
  // below then select from this rather than re-fetching.
  const priced = [];
  for (const c of contracts) {
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

    // Expected-move sanity check: compares two independent volatility
    // measures. ATR is the underlying's own realized (historical) daily
    // range; expectedMove is the option market's forward-looking (implied)
    // range by expiration (spot × IV × √T — the standard ~1-stdev move). If
    // the ATR-based target below would require the underlying to move
    // further than the market itself expects as likely, this contract's
    // target is a low-probability stretch.
    const expectedMove = spotPrice * iv * Math.sqrt(T);
    const requiredMove = TARGET_ATR_MULT * underlyingATR;

    priced.push({
      contract: c, symbol: c.symbol, strike, expiration: c.expiration_date,
      bid: q.bid, ask: q.ask, mid: q.mid, spread, iv, delta,
      openInterest: parseInt(c.open_interest || 0), volume: parseInt(c.volume || 0),
      dte: Math.round((expDate - Date.now()) / (24 * 60 * 60 * 1000)),
      expectedMove, requiredMove,
      moveFeasible: requiredMove <= expectedMove,
    });
  }

  if (!priced.length) {
    return {
      ok: false, vetoReason: 'DATA_INSUFFICIENT',
      detail: `None of the ${contracts.length} ${optType} contracts for ${symbol} in the ${dte_min}-${dte_max} DTE window had a live two-sided quote inside a ${(MAX_SPREAD_PCT * 100).toFixed(0)}%-of-mid spread. That is a market/data condition, not a rejected setup.`,
    };
  }

  // Walk the relaxation ladder: strictest liquidity tier and the tuned delta
  // band first, loosening only as far as needed to find something real, and
  // recording exactly what had to give.
  let candidates = [];
  let liquidityNote = null;
  let deltaNote = null;
  let relaxed = [];
  let usedDeltaMin = delta_min, usedDeltaMax = delta_max;

  outer:
  for (const widen of DELTA_WIDENING) {
    const lo = Math.max(0.05, delta_min - widen);
    const hi = Math.min(0.95, delta_max + widen);
    for (const tier of LIQUIDITY_TIERS) {
      // >= not >, deliberately. The last tier is {oi:0, vol:0} and means
      // "don't filter on reference data at all" — with `>` a contract whose
      // feed reports OI 0 and volume 0 fails `0 > 0`, so the catch-all tier
      // caught nothing and the whole ladder still bottomed out empty. That
      // is the exact case it exists to handle: XLP had a perfectly good
      // delta-0.64 contract at strike 84 with a 13-cent spread, excluded
      // solely because its OI field was blank.
      const found = priced.filter(c =>
        c.openInterest >= tier.oi && c.volume >= tier.vol &&
        c.delta >= lo && c.delta <= hi && c.moveFeasible);
      if (found.length) {
        candidates = found;
        liquidityNote = tier.label;
        usedDeltaMin = lo; usedDeltaMax = hi;
        relaxed = [];
        if (tier !== LIQUIDITY_TIERS[0]) relaxed.push(`liquidity relaxed to ${tier.label}`);
        if (widen > 0) relaxed.push(`delta band widened from ${delta_min}-${delta_max} to ${lo.toFixed(2)}-${hi.toFixed(2)}`);
        deltaNote = `${lo.toFixed(2)}-${hi.toFixed(2)}`;
        break outer;
      }
    }
  }

  if (!candidates.length) {
    const deltas = [...new Set(priced.map(c => c.delta.toFixed(2)))].sort();
    const infeasible = priced.filter(c => !c.moveFeasible).length;
    return {
      ok: false, vetoReason: 'DATA_INSUFFICIENT',
      detail: `${priced.length} of ${contracts.length} contracts were priceable, but none fell inside the delta band even widened to ±${DELTA_WIDENING[DELTA_WIDENING.length - 1]} (tuned band ${delta_min}-${delta_max}; deltas actually available: ${deltas.join(', ') || 'none'})${infeasible ? `, and ${infeasible} could not reach the target inside the expected move` : ''}.`,
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

  const targetDelta = (usedDeltaMin + usedDeltaMax) / 2;
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

  // The primary exit: a price on the UNDERLYING, not on the option. See the
  // block comment at STOP_UNDERLYING_ATR_MULT for the measured reasoning.
  // Expressed to the cent so it can be read straight off a stock chart.
  const stopUnderlying = Number((spotPrice - STOP_UNDERLYING_ATR_MULT * underlyingATR).toFixed(2));
  const stopUnderlyingPct = (spotPrice - stopUnderlying) / spotPrice;

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
    stopUnderlying, stopUnderlyingPct, stopUnderlyingAtrMult: STOP_UNDERLYING_ATR_MULT,
    maxLossPerContract: entryLimit * 100, // a long option's true worst case: the whole premium
    expectedMove: best.expectedMove, requiredMove: best.requiredMove,
    underlyingATR, targetAtrMult: TARGET_ATR_MULT, stopAtrMult: STOP_ATR_MULT,
    feasibility, targetHoldDays: TARGET_HOLD_TRADING_DAYS,
    // What, if anything, had to be loosened to find this contract. Shown on
    // the pick so a loosely-sourced one never passes as strictly-sourced.
    relaxed, deltaBandUsed: deltaNote, chainSize: contracts.length, pricedCount: priced.length,
    targetPct, stopPct,
    targetClamped: Math.abs(targetPct - rawTargetMove / entryLimit) > 1e-9,
    stopClamped: Math.abs(stopPct - rawStopMove / entryLimit) > 1e-9,
    thresholdsUsed: { delta_min, delta_max, dte_min, dte_max },
    liquidityNote,
  };
}

// The filter thresholds are exported so govt/options.js can report WHICH of
// them a contract fails, instead of keeping its own copy of the numbers and
// drifting out of step with the values actually enforced here.
module.exports = {
  structureContract, tickSize, roundToTick,
  LIQUIDITY_TIERS, DELTA_WIDENING, MAX_SPREAD_PCT, MAX_SPREAD_FLOOR, spreadCap,
  MAX_PREMIUM_PER_CONTRACT, MIN_DTE_FOR_HOLD,
};
