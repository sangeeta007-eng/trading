/**
 * Agent 4 (continued) — Auto-Learning Engine
 *
 * Every 10 closed trades, runs a deterministic post-mortem against
 * trade_history and adjusts the delta/DTE thresholds that Agent 2 reads.
 * Pure arithmetic over recorded data — never an LLM guess.
 *
 * There is no walk-forward backtest gating these changes before they go
 * live — the market data provider's free tier doesn't expose enough historical options chain
 * data to backtest against honestly. Instead, changes are bounded (can never
 * drift past BOUNDS from the PRD baseline), every change is logged with the
 * stats that triggered it (learning_log table), and revertToBaseline() lets
 * you undo a bad adjustment in one call.
 */
const db = require('./db');

const TUNE_EVERY_N_TRADES = 10;
const WIN_RATE_FLOOR = 0.60;
const TIGHTENED_DELTA = { min: 0.60, max: 0.70 };
const HOLDING_DAYS_CEILING = 5;
const PROFIT_TARGET_PCT = 0.12;
const TIGHTENED_DTE = { min: 30, max: 45 };

const BASELINE = { delta_min: 0.50, delta_max: 0.65, dte_min: 21, dte_max: 45 };
const BOUNDS = { delta_min_floor: 0.45, delta_max_ceiling: 0.80, dte_min_floor: 14, dte_max_ceiling: 60 };

function clampThresholds({ delta_min, delta_max, dte_min, dte_max }) {
  return {
    delta_min: Math.max(BOUNDS.delta_min_floor, delta_min),
    delta_max: Math.min(BOUNDS.delta_max_ceiling, delta_max),
    dte_min: Math.max(BOUNDS.dte_min_floor, dte_min),
    dte_max: Math.min(BOUNDS.dte_max_ceiling, dte_max),
  };
}

function revertToBaseline(reason = 'Manual revert to PRD baseline.') {
  const old_values = db.getThresholds();
  db.updateThresholds(BASELINE, reason);
  db.logTuning({ trigger_reason: reason, old_values, new_values: BASELINE, win_rate: null, avg_holding_days: null });
  return BASELINE;
}

function evaluateAndTune() {
  const totalClosed = db.countClosedTrades();
  if (totalClosed === 0 || totalClosed % TUNE_EVERY_N_TRADES !== 0) return null;

  const lastN = db.getRecentClosedTrades(TUNE_EVERY_N_TRADES);
  if (lastN.length < TUNE_EVERY_N_TRADES) return null;

  const wins = lastN.filter(t => t.status === 'CLOSED_WIN').length;
  const winRate = wins / lastN.length;
  const avgHoldingDays = lastN.reduce((s, t) => s + (t.holding_days || 0), 0) / lastN.length;

  const current = db.getThresholds();
  const nextDelta = { min: current.delta_min, max: current.delta_max };
  const nextDte   = { min: current.dte_min, max: current.dte_max };
  const reasons = [];

  if (winRate < WIN_RATE_FLOOR) {
    nextDelta.min = TIGHTENED_DELTA.min;
    nextDelta.max = TIGHTENED_DELTA.max;
    reasons.push(`Win rate ${(winRate * 100).toFixed(0)}% < ${(WIN_RATE_FLOOR * 100).toFixed(0)}% over last ${TUNE_EVERY_N_TRADES} trades — raised delta filter to ${TIGHTENED_DELTA.min}-${TIGHTENED_DELTA.max} (higher probability, lower leverage).`);
  }

  const nonWinners = lastN.filter(t => (t.pnl_pct ?? 0) < PROFIT_TARGET_PCT);
  const avgHoldNonWinners = nonWinners.length
    ? nonWinners.reduce((s, t) => s + (t.holding_days || 0), 0) / nonWinners.length
    : 0;
  if (nonWinners.length && avgHoldNonWinners > HOLDING_DAYS_CEILING) {
    nextDte.min = TIGHTENED_DTE.min;
    nextDte.max = TIGHTENED_DTE.max;
    reasons.push(`Avg holding time ${avgHoldNonWinners.toFixed(1)}d for trades that didn't reach +${(PROFIT_TARGET_PCT * 100).toFixed(0)}% (> ${HOLDING_DAYS_CEILING}d) — tightened DTE to ${TIGHTENED_DTE.min}-${TIGHTENED_DTE.max} to mitigate theta decay.`);
  }

  if (!reasons.length) {
    db.logTuning({
      trigger_reason: `Post-mortem #${totalClosed / TUNE_EVERY_N_TRADES}: no threshold change (win rate ${(winRate * 100).toFixed(0)}%, avg hold ${avgHoldingDays.toFixed(1)}d — within bounds).`,
      old_values: current, new_values: current, win_rate: winRate, avg_holding_days: avgHoldingDays,
    });
    return { changed: false, winRate, avgHoldingDays };
  }

  const oldValues = { delta_min: current.delta_min, delta_max: current.delta_max, dte_min: current.dte_min, dte_max: current.dte_max };
  const newValues = clampThresholds({ delta_min: nextDelta.min, delta_max: nextDelta.max, dte_min: nextDte.min, dte_max: nextDte.max });

  db.updateThresholds(newValues, reasons.join(' '));
  db.logTuning({ trigger_reason: reasons.join(' '), old_values: oldValues, new_values: newValues, win_rate: winRate, avg_holding_days: avgHoldingDays });

  return { changed: true, winRate, avgHoldingDays, reasons, oldValues, newValues };
}

module.exports = { evaluateAndTune, revertToBaseline, TUNE_EVERY_N_TRADES, BASELINE, BOUNDS };
