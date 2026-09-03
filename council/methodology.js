/**
 * council/methodology.js — the published methods this engine is modelled on.
 *
 * Three practitioners, each doing a different job, layered rather than
 * stacked on top of each other as redundant signals:
 *
 *   1. Stan Weinstein — Stage Analysis ("Secrets for Profiting in Bull and
 *      Bear Markets"). Answers "is this thing even in a tradable trend?"
 *      Four stages around the 30-week moving average: 1 basing, 2 advancing,
 *      3 topping, 4 declining. Buy calls only in Stage 2, puts only in
 *      Stage 4. This is the quality filter.
 *
 *   2. Linda Raschke — the ADX pullback (often called the "Holy Grail"
 *      setup, from "Street Smarts"). Answers "when do I enter?" Requires a
 *      genuinely strong trend (ADX >= 30), waits for a pullback to the
 *      20-period EMA, and enters as the trend resumes. This is the entry
 *      timing, and it's why the engine buys dips instead of chasing.
 *
 *   3. Paul Tudor Jones — risk discipline. Answers "how do I not blow up?"
 *      The 200-day moving average as a line in the sand ("nothing good
 *      happens below the 200-day"), asymmetric reward-to-risk on every
 *      trade, and a hard predefined stop. This is the risk layer.
 *
 * These are faithful implementations of publicly documented principles,
 * simplified to what real OHLCV and options data can actually support.
 * None of these people are affiliated with this tool or endorse it, and a
 * simplified version of a method is not the method — treat it as the
 * engine's stated ruleset, not as their track record.
 */
const { sma, ema } = require('../marketdata');

const WEINSTEIN_MA_DAYS = 150;   // ~30 weeks of trading days
const WEINSTEIN_SLOPE_LOOKBACK = 21; // ~1 month, Weinstein wants the MA itself turning
const RASCHKE_ADX_MIN = 30;      // his setup demands a genuinely strong trend, not just "trending"
const RASCHKE_EMA = 20;
const TUDOR_MA_DAYS = 200;

// ── 1. Weinstein Stage Analysis ──────────────────────────────────────────
// Stage 2 (advancing): price above a rising 30-week MA.
// Stage 4 (declining): price below a falling 30-week MA.
// Stage 1/3 are the flat basing/topping zones either side — no trade.
function weinsteinStage(bars) {
  if (bars.length < WEINSTEIN_MA_DAYS + WEINSTEIN_SLOPE_LOOKBACK) {
    return { available: false, reason: `need ${WEINSTEIN_MA_DAYS + WEINSTEIN_SLOPE_LOOKBACK} daily bars, have ${bars.length}` };
  }

  const ma = sma(bars, WEINSTEIN_MA_DAYS);
  const maPrior = sma(bars.slice(0, bars.length - WEINSTEIN_SLOPE_LOOKBACK), WEINSTEIN_MA_DAYS);
  if (ma == null || maPrior == null) return { available: false, reason: 'moving average could not be computed' };

  const price = bars[bars.length - 1].c;
  const slopePct = ((ma - maPrior) / maPrior) * 100;
  const rising = slopePct > 0.5;   // meaningfully up over the month, not noise
  const falling = slopePct < -0.5;
  const above = price > ma;

  let stage, label;
  if (above && rising)        { stage = 2; label = 'Stage 2 — advancing (Weinstein: the only stage to buy calls)'; }
  else if (!above && falling) { stage = 4; label = 'Stage 4 — declining (Weinstein: the only stage to buy puts)'; }
  else if (above && !rising)  { stage = 3; label = 'Stage 3 — topping, 30-week MA has flattened (no trade)'; }
  else                        { stage = 1; label = 'Stage 1 — basing, 30-week MA flat or price below it (no trade)'; }

  return { available: true, stage, label, ma, slopePct, price };
}

// ── 2. Raschke ADX pullback ──────────────────────────────────────────────
// Strong trend + price pulled back to the 20 EMA = the entry. Scores how
// close to that ideal the current bar is.
function raschkePullback(bars, adxVal, bias) {
  const e20 = ema(bars, RASCHKE_EMA);
  if (e20 == null || adxVal == null) return { available: false, reason: 'insufficient bars for 20 EMA / ADX' };

  const price = bars[bars.length - 1].c;
  const distancePct = ((price - e20) / e20) * 100;
  const strongTrend = adxVal >= RASCHKE_ADX_MIN;

  // A pullback means price came back toward the EMA from the trend's
  // direction — above it for an uptrend, below for a downtrend.
  const onCorrectSide = bias === 'CALL' ? price > e20 : price < e20;
  const absDistance = Math.abs(distancePct);

  return {
    available: true,
    strongTrend, adx: adxVal, ema20: e20, distancePct, onCorrectSide,
    // Textbook entry: strong trend, right side of the EMA, sitting on it.
    qualifies: strongTrend && onCorrectSide && absDistance <= 4,
    label: `Raschke pullback: ADX ${adxVal.toFixed(1)} (${strongTrend ? `>= ${RASCHKE_ADX_MIN}, strong enough` : `below ${RASCHKE_ADX_MIN} — trend too weak for this setup`}), price ${absDistance.toFixed(1)}% ${distancePct >= 0 ? 'above' : 'below'} its 20 EMA.`,
  };
}

// ── 3. Tudor Jones risk line ─────────────────────────────────────────────
// The 200-day is the regime line. Longs above it, shorts below it.
function tudorRegime(bars, bias) {
  if (bars.length < TUDOR_MA_DAYS) {
    return { available: false, reason: `need ${TUDOR_MA_DAYS} daily bars, have ${bars.length}` };
  }
  const ma200 = sma(bars, TUDOR_MA_DAYS);
  const price = bars[bars.length - 1].c;
  const above = price > ma200;
  const aligned = bias === 'CALL' ? above : !above;

  return {
    available: true, ma200, price, above, aligned,
    label: `200-day line: price $${price.toFixed(2)} is ${above ? 'above' : 'below'} the 200-day MA ($${ma200.toFixed(2)}) — ${aligned ? 'on the right side for this direction' : 'the WRONG side for this direction (Tudor Jones: nothing good happens below the 200-day)'}.`,
  };
}

// ── Feasibility of the profit goal ───────────────────────────────────────
// Can this contract realistically deliver the target gain inside the
// intended holding window? Compares the underlying move required against
// the move the options market itself is pricing over that window — both
// real numbers, no forecasting.
function profitFeasibility({ premium, delta, spot, iv, targetPct, holdTradingDays }) {
  const neededPremiumMove = premium * targetPct;
  const neededUnderlyingMove = neededPremiumMove / delta;          // first-order: dPremium ~= delta x dUnderlying
  const impliedMove = spot * iv * Math.sqrt(holdTradingDays / 252); // ~1 sigma over the holding window
  const neededPctOfUnderlying = (neededUnderlyingMove / spot) * 100;

  return {
    neededUnderlyingMove, neededPctOfUnderlying, impliedMove,
    ratio: neededUnderlyingMove / impliedMove,
    achievable: neededUnderlyingMove <= impliedMove,
    label: `To gain ${(targetPct * 100).toFixed(0)}% on this premium, ${'the underlying'} needs to move $${neededUnderlyingMove.toFixed(2)} (${neededPctOfUnderlying.toFixed(2)}%) within ~${holdTradingDays} trading days. The options market is pricing a typical move of $${impliedMove.toFixed(2)} over that window.`,
  };
}

module.exports = {
  weinsteinStage, raschkePullback, tudorRegime, profitFeasibility,
  WEINSTEIN_MA_DAYS, RASCHKE_ADX_MIN, TUDOR_MA_DAYS,
};
