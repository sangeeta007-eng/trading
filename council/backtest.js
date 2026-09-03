/**
 * council/backtest.js — walk-forward test of the live entry rules against
 * real historical bars.
 *
 * This exists because every methodology the engine claims to follow shares
 * one rule above all others: do not deploy capital on a strategy whose
 * expectancy you have not measured. Until this file existed, the engine's
 * rules were merely plausible.
 *
 * WHAT IS EXACT
 *   - Every entry signal, evaluated using only bars available on that day.
 *     No lookahead: the decision at day i sees bars[0..i] and nothing more.
 *   - The underlying's actual forward path over the holding window.
 *
 * WHAT IS APPROXIMATED (and why the result is an estimate, not a fact)
 *   - Historical option prices are not available from the data provider, so
 *     the option leg is priced with Black-Scholes. Three consequences:
 *       1. Implied vol is proxied by trailing 30-day realized vol x 1.15.
 *          Real IV is usually above realized vol; the multiplier is a
 *          rough correction, not a measurement.
 *       2. IV is held constant through the trade. In reality it moves, and
 *          a vol collapse can lose money on a correct directional call.
 *       3. A spread cost is charged: entry at the ask, exit at the bid,
 *          modelled as +/-2% around fair value.
 *   - Sector relative-strength ranking is omitted (it needs cross-sectional
 *     data at each historical date). The live engine applies it, so the
 *     live filter is slightly stricter than what is tested here.
 *
 * Read the output as a base rate with real error bars around it, not as a
 * predicted return.
 */
const { getBars } = require('../marketdata');
const { bsPrice, bsDelta, historicalVol } = require('../greek');
const { RISK_FREE_RATE } = require('../config');
const { rsi, adx, ema9, ema21 } = require('./indicators');
const { weinsteinStage, tudorRegime, RASCHKE_ADX_MIN } = require('./methodology');
const { sma } = require('../marketdata');

const WARMUP_BARS = 220;      // enough for the 200-day line and Weinstein's slope
const IV_OVER_HV = 1.15;      // realized vol understates implied; rough correction
const SPREAD_HAIRCUT = 0.02;  // ~2% each way, i.e. buy at ask / sell at bid
const ENTRY_DTE = 45;

// Mirrors the live entry rules in agent1_analyst.js, evaluated on a bar
// slice ending at the decision day. Kept deliberately in one place so a
// change here and a change there can be compared directly.
function evaluateSignal(slice) {
  if (slice.length < WARMUP_BARS) return null;
  const price = slice[slice.length - 1].c;

  // Connors RSI(2) dip — must mirror agent1_analyst.js exactly, or the
  // measured number stops describing what actually ships.
  const ma200 = sma(slice, 200);
  if (ma200 == null || price <= ma200) return null;
  const r2 = rsi(slice, 2);
  if (r2 == null || r2 >= 15) return null;

  return { bias: 'CALL', price, rsi2: r2, ma200 };
}

// Picks the strike whose Black-Scholes delta is closest to the target.
function pickStrike(spot, T, iv, optType, targetDelta) {
  let best = null;
  for (let pct = -0.20; pct <= 0.20; pct += 0.01) {
    const strike = Math.round(spot * (1 + pct) * 2) / 2; // half-dollar grid
    const d = Math.abs(bsDelta(spot, strike, T, RISK_FREE_RATE, iv, optType));
    const gap = Math.abs(d - targetDelta);
    if (!best || gap < best.gap) best = { strike, delta: d, gap };
  }
  return best;
}

function simulateTrade({ bars, entryIndex, bias, targetPct, stopPct, holdDays, targetDelta }) {
  const slice = bars.slice(0, entryIndex + 1);
  const spot = slice[slice.length - 1].c;
  const hv = historicalVol(slice, 30);
  if (!hv || hv <= 0) return null;
  const iv = hv * IV_OVER_HV;

  const optType = bias === 'CALL' ? 'call' : 'put';
  const T0 = ENTRY_DTE / 365;
  const pick = pickStrike(spot, T0, iv, optType, targetDelta);
  if (!pick) return null;

  const fairEntry = bsPrice(spot, pick.strike, T0, RISK_FREE_RATE, iv, optType);
  if (!fairEntry || fairEntry <= 0.05) return null;
  const entryPrice = fairEntry * (1 + SPREAD_HAIRCUT); // pay the ask

  const targetPrice = entryPrice * (1 + targetPct);
  const stopPrice = entryPrice * (1 - stopPct);

  for (let d = 1; d <= holdDays; d++) {
    const i = entryIndex + d;
    if (i >= bars.length) break;
    const T = Math.max(0.001, (ENTRY_DTE - d) / 365);
    const fair = bsPrice(bars[i].c, pick.strike, T, RISK_FREE_RATE, iv, optType);
    const exitable = fair * (1 - SPREAD_HAIRCUT); // sell into the bid

    if (exitable >= targetPrice) return { outcome: 'WIN', pnlPct: (exitable - entryPrice) / entryPrice, days: d };
    if (exitable <= stopPrice) return { outcome: 'LOSS', pnlPct: (exitable - entryPrice) / entryPrice, days: d };
  }

  // Ran out of window — close at whatever it is worth.
  const iEnd = Math.min(entryIndex + holdDays, bars.length - 1);
  const Tend = Math.max(0.001, (ENTRY_DTE - holdDays) / 365);
  const fairEnd = bsPrice(bars[iEnd].c, pick.strike, Tend, RISK_FREE_RATE, iv, optType);
  const exitEnd = fairEnd * (1 - SPREAD_HAIRCUT);
  return { outcome: 'TIMEOUT', pnlPct: (exitEnd - entryPrice) / entryPrice, days: holdDays };
}

async function backtestSymbol(symbol, opts) {
  const { years, targetPct, stopPct, holdDays, targetDelta } = opts;
  const bars = await getBars(symbol, '1Day', Math.ceil(years * 260));
  if (bars.length < WARMUP_BARS + holdDays + 20) {
    return { symbol, error: `only ${bars.length} bars` };
  }

  const trades = [];
  let lastExit = -1;
  for (let i = WARMUP_BARS; i < bars.length - holdDays; i++) {
    if (i <= lastExit) continue; // one position per symbol at a time, as in live use
    const slice = bars.slice(Math.max(0, i - 300), i + 1);
    const sig = evaluateSignal(slice);
    if (!sig) continue;

    const res = simulateTrade({ bars, entryIndex: i, bias: sig.bias, targetPct, stopPct, holdDays, targetDelta });
    if (!res) continue;
    trades.push({ symbol, date: bars[i].t.split('T')[0], bias: sig.bias, ...res });
    lastExit = i + res.days;
  }
  return { symbol, trades };
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const timeouts = trades.filter(t => t.outcome === 'TIMEOUT');
  const avg = arr => arr.length ? arr.reduce((s, t) => s + t.pnlPct, 0) / arr.length : 0;
  const expectancy = avg(trades);

  return {
    n,
    winRate: wins.length / n,
    lossRate: losses.length / n,
    timeoutRate: timeouts.length / n,
    avgWin: avg(wins), avgLoss: avg(losses), avgTimeout: avg(timeouts),
    expectancy,
    avgDays: trades.reduce((s, t) => s + t.days, 0) / n,
    totalReturnPerTrade: expectancy,
  };
}

async function run(opts = {}) {
  const {
    universe, years = 8, targetPct = 0.15, stopPct = 0.10,
    holdDays = 15, targetDelta = 0.6,
  } = opts;

  const all = [];
  const perSymbol = {};
  for (const symbol of universe) {
    const r = await backtestSymbol(symbol, { years, targetPct, stopPct, holdDays, targetDelta });
    if (r.error) { perSymbol[symbol] = { error: r.error }; continue; }
    perSymbol[symbol] = summarize(r.trades);
    all.push(...r.trades);
  }

  // Breakeven win rate ignoring timeouts, for reference against the result.
  const breakeven = stopPct / (targetPct + stopPct);

  return { overall: summarize(all), perSymbol, trades: all, params: { years, targetPct, stopPct, holdDays, targetDelta, breakeven } };
}

module.exports = { run, backtestSymbol, evaluateSignal, summarize };
