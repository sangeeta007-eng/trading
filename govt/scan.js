/**
 * govt/scan.js — trend ratings for the government-stake universe.
 *
 * Deliberately runs the SAME ruleset as the rest of the site (see
 * METHODOLOGY.md) rather than inventing a second, private definition of
 * "a buy". If Weinstein/Raschke/PTJ gate the options picks, they gate this
 * page too — otherwise the two halves of the site could disagree about the
 * same symbol on the same day, which is worse than either being wrong.
 *
 * The one deliberate difference: this page rates SHARES, not options. No
 * strike, no expiry, no theta. So the output is a plain verdict on the stock
 * itself (BUY / BUY ON DIP / HOLD / AVOID / SELL), and the scoring drops the
 * options-only inputs (delta, IV rank, feasibility) entirely.
 *
 * Read-only throughout — marketdata.js cannot place an order by design.
 */
const { getBars, sma, ema } = require('../marketdata');
const { rsi, adx } = require('./../council/indicators');

// Weinstein's 30-week moving average, in daily bars. Same constant the
// council uses so a symbol cannot be Stage 2 on one page and Stage 4 on
// the other.
const STAGE_MA = 150;
const LONG_MA = 200;       // PTJ's line in the sand
const SLOPE_LOOKBACK = 30; // ~6 weeks, for deciding if the 30-week MA is rising

function pctChange(bars, n) {
  if (bars.length < n + 1) return null;
  const then = bars[bars.length - 1 - n].c;
  const now = bars[bars.length - 1].c;
  return then ? (now / then - 1) * 100 : null;
}

// Slope of the 150-day MA over the last SLOPE_LOOKBACK bars, as a percent
// of the MA itself — so a $3 stock and a $300 stock are judged on the same
// scale. A flat MA is Stage 1/3 (basing/topping), not a trend.
function maSlopePct(bars, period) {
  if (bars.length < period + SLOPE_LOOKBACK) return null;
  const now = sma(bars, period);
  const past = sma(bars.slice(0, bars.length - SLOPE_LOOKBACK), period);
  if (!now || !past) return null;
  return ((now - past) / past) * 100;
}

// Weinstein stage. FLAT_BAND is the dead zone where the MA is not really
// going anywhere — without it, noise flips a basing stock between Stage 2
// and Stage 4 day to day.
const FLAT_BAND = 1.0; // percent move in the 150d MA over ~6 weeks

function weinsteinStage(price, ma150, slope) {
  if (ma150 == null || slope == null) return { stage: null, label: 'insufficient history' };
  const above = price > ma150;
  const rising = slope > FLAT_BAND;
  const falling = slope < -FLAT_BAND;
  if (above && rising) return { stage: 2, label: 'Stage 2 — advancing' };
  if (!above && falling) return { stage: 4, label: 'Stage 4 — declining' };
  if (above) return { stage: 3, label: 'Stage 3 — topping' };
  return { stage: 1, label: 'Stage 1 — basing' };
}

/**
 * Score 0-100. Every component is a real measurement; none is a guess.
 *
 *   30  Weinstein stage (the quality filter)
 *   20  above the 200-day (PTJ hard line)
 *   20  ADX vs Raschke's 30 bar (trend strength)
 *   15  entry quality — how close to the 20-EMA the pullback is
 *   15  RSI not stretched
 */
function scoreSymbol(m) {
  let score = 0;
  const reasons = [];

  if (m.stage === 2) { score += 30; reasons.push('Stage 2 (above a rising 30-week MA)'); }
  else if (m.stage === 3) { score += 12; reasons.push('Stage 3 — above the MA but it has flattened'); }
  else if (m.stage === 1) { score += 8; reasons.push('Stage 1 — basing, no trend to trade'); }
  else if (m.stage === 4) { reasons.push('Stage 4 — below a falling 30-week MA'); }

  if (m.ma200 != null && m.price > m.ma200) { score += 20; reasons.push('above the 200-day'); }
  else if (m.ma200 != null) { reasons.push('BELOW the 200-day'); }

  if (m.adx != null) {
    score += Math.min(20, (m.adx / 30) * 20);
    if (m.adx < 30) reasons.push(`ADX ${m.adx.toFixed(1)} — below Raschke's 30 bar, scored down`);
    else reasons.push(`ADX ${m.adx.toFixed(1)} — genuinely trending`);
  }

  // Raschke's entry: price pulled back near the 20-EMA inside an existing
  // trend. Full marks within 3%, nothing beyond 12% — chasing an extended
  // move is exactly what this is meant to discourage.
  if (m.emaDistPct != null) {
    const d = Math.abs(m.emaDistPct);
    const entry = d <= 3 ? 15 : d >= 12 ? 0 : 15 * (1 - (d - 3) / 9);
    score += entry;
    if (d > 12) reasons.push(`${d.toFixed(1)}% from the 20-EMA — extended, no pullback entry here`);
    else if (d <= 3) reasons.push('sitting on the 20-EMA — pullback entry available');
  }

  if (m.rsi != null) {
    if (m.rsi >= 40 && m.rsi <= 65) { score += 15; }
    else if (m.rsi > 75) { score += 0; reasons.push(`RSI ${m.rsi.toFixed(0)} — overbought`); }
    else if (m.rsi < 30) { score += 5; reasons.push(`RSI ${m.rsi.toFixed(0)} — oversold, but falling knives are Stage 4`); }
    else { score += 9; }
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons };
}

/**
 * Rating. The hard gates come FIRST and override the score, exactly as
 * they do in the options engine — a high score below the 200-day is still
 * not a buy, and no amount of momentum rescues Stage 4.
 */
function rate(m, score) {
  if (m.stage == null) return { rating: 'NO DATA', why: 'not enough price history to judge a trend' };
  if (m.stage === 4) return { rating: 'SELL', why: 'Stage 4 — below a falling 30-week MA. A confirmed downtrend: Weinstein rules this out on the long side regardless of how the daily chart looks.' };
  // Below the 200-day but NOT in a confirmed Stage 4 downtrend — typically
  // basing or topping under the line. That is "do not open a long", which is
  // a different statement from "sell". Collapsing the two into SELL was
  // overstating the rule: a stock basing 2% under its 200-day is not the
  // same signal as one 20% below a falling MA.
  if (m.ma200 != null && m.price < m.ma200) return { rating: 'AVOID', why: 'below the 200-day. "Nothing good happens below the 200-day" is a hard gate here — no long entry — but the 30-week MA is not falling, so this is not a confirmed downtrend either.' };
  if (m.stage === 3) return { rating: 'HOLD', why: 'Stage 3 — still above the MA, but the MA has stopped rising. Hold, do not add.' };
  if (m.stage === 1) return { rating: 'HOLD', why: 'Stage 1 — basing. Nothing to trade until a trend establishes.' };
  if (score >= 65) return { rating: 'BUY', why: 'Stage 2, above the 200-day, and priced near a pullback entry rather than extended.' };
  if (score >= 50) return { rating: 'BUY ON DIP', why: 'trend qualifies but price is extended — the setup is right, the entry is not. Wait for a pull back toward the 20-EMA.' };
  return { rating: 'HOLD', why: 'Stage 2 but weak on trend strength and entry quality.' };
}

// The order verdicts are presented in, everywhere on the page: best first,
// worst last. Defined once here because three files sort by it (the two
// tables and the contract structuring queue) and three private copies would
// eventually disagree about where AVOID sits.
const RATING_ORDER = ['BUY', 'BUY ON DIP', 'HOLD', 'AVOID', 'SELL', 'NO DATA'];

function ratingRank(rating) {
  const i = RATING_ORDER.indexOf(rating);
  return i === -1 ? RATING_ORDER.length : i;
}

// Group rows by verdict, best verdict first, and strongest score first
// within each group. Returns [{ rating, rows }] with empty groups dropped,
// so a table never renders a heading with nothing under it.
function groupByRating(rows) {
  return RATING_ORDER
    .map(rating => ({
      rating,
      rows: rows
        .filter(r => r.rating === rating)
        .sort((a, b) => (b.score || 0) - (a.score || 0)),
    }))
    .filter(g => g.rows.length);
}

async function measure(symbol) {
  const bars = await getBars(symbol, '1Day', 260);
  if (!bars.length) return { symbol, error: 'no bars returned' };

  const price = bars[bars.length - 1].c;
  const ma150 = sma(bars, STAGE_MA);
  const ma200 = sma(bars, LONG_MA);
  const slope = maSlopePct(bars, STAGE_MA);
  const { stage, label } = weinsteinStage(price, ma150, slope);
  const ema20 = ema(bars, 20); // Raschke's pullback reference
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);

  const m = {
    symbol,
    price,
    ma150, ma200, slope, stage, stageLabel: label,
    rsi: rsi(bars, 14),
    adx: adx(bars, 14),
    ema20,
    emaDistPct: ema20 ? ((price - ema20) / ema20) * 100 : null,
    ret1m: pctChange(bars, 21),
    ret3m: pctChange(bars, 63),
    ret6m: pctChange(bars, 126),
    ret1d: pctChange(bars, 1),
    high52: Math.max(...highs),
    low52: Math.min(...lows),
    bars: bars.length,
    asOf: bars[bars.length - 1].t,
  };
  m.offHighPct = ((m.price - m.high52) / m.high52) * 100;

  const { score, reasons } = scoreSymbol(m);
  const { rating, why } = rate(m, score);
  return { ...m, score, reasons, rating, why };
}

/**
 * Scan every company in the ledger plus every ETF that appears in any
 * holdings list. One symbol failing must never take down the whole page —
 * a microcap with a data gap should show as "no data", not blank the run.
 */
async function scanUniverse(ledger) {
  const companies = ledger.positions.map(p => p.symbol);
  const etfs = [...new Set(ledger.positions.flatMap(p => p.etfs.map(e => e.symbol)))];
  const etfNames = {};
  for (const p of ledger.positions) for (const e of p.etfs) etfNames[e.symbol] = e.name;

  const out = { companies: [], etfs: [], failed: [] };

  for (const sym of companies) {
    try { out.companies.push(await measure(sym)); }
    catch (err) { out.failed.push({ symbol: sym, error: err.response?.data?.message || err.message }); }
  }
  for (const sym of etfs.sort()) {
    try {
      const m = await measure(sym);
      // Which tracked companies sit inside this fund — the reason it is here.
      m.name = etfNames[sym];
      m.holds = ledger.positions.filter(p => p.etfs.some(e => e.symbol === sym)).map(p => p.symbol);
      out.etfs.push(m);
    } catch (err) { out.failed.push({ symbol: sym, error: err.response?.data?.message || err.message }); }
  }

  return out;
}

module.exports = { scanUniverse, measure, weinsteinStage, scoreSymbol, rate, RATING_ORDER, ratingRank, groupByRating };
