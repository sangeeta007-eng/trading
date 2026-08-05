/**
 * Agent 3 — Risk & Portfolio Guardian ("The Risk Officer")
 *
 * Holds absolute veto power. This is a recommendation engine, not a broker —
 * there's no live account to query, so sizing runs against a configurable
 * capital figure (TOTAL_BUDGET in .env, set to match your real Fidelity/
 * Robinhood balance) and "open positions" means our own tracked ACTIVE
 * recommendations, not live broker positions.
 *
 * Beyond the PRD baseline (sizing, max positions, weekly drawdown), this
 * agent also enforces:
 *   - VIX-regime gating (halt/size-down in high-vol regimes)
 *   - IV Rank / IV-vs-realized-vol vetoes (don't recommend overpaying for premium)
 *   - Net signed delta exposure cap (a correlation proxy — three same-
 *     direction ETF options aren't 3 diversified bets, they're ~1 leveraged one)
 *   - Conviction-scaled allocation (10-15% band, not always maxed out)
 */
const cfg = require('../config');
const analytics = require('../analytics');
const calendar = require('../calendar');
const db = require('./db');

const ALLOC_MIN_PCT = 0.10;
const ALLOC_MAX_PCT = 0.15;
const MAX_OPEN_POSITIONS = 3;
const WEEKLY_DRAWDOWN_LIMIT_PCT = 0.05;

const IV_RANK_VETO = 70;       // don't recommend buying premium this rich
const IV_RANK_MIN_SAMPLE = 10; // below this, getIVRank's 50 is a placeholder, not a real reading
const IV_HV_RATIO_VETO = 2.0;  // implied vol this far above realized vol suggests an event-risk premium
const IV_HV_RATIO_CAUTION = 1.5;

const MAX_NET_DIRECTIONAL_EXPOSURE = 1.3; // signed sum of active deltas — caps stacking correlated same-direction picks

const EVENT_TYPES_THAT_VETO = ['FOMC', 'CPI', 'NFP']; // OPEX/quad-witching are reported, not vetoed

function netDirectionalExposure() {
  const active = db.getTradesByStatus('ACTIVE');
  return active.reduce((sum, t) => sum + (t.option_type === 'call' ? t.delta : -t.delta), 0);
}

async function evaluate(structured, { analysis, regime, sessionNewCount = 0 } = {}) {
  if (!structured.ok) {
    return { approved: false, status: 'REJECTED', vetoReason: structured.vetoReason, detail: structured.detail };
  }

  // ── Economic event blackout ──────────────────────────────────────────────
  // ETFs don't have a single earnings date, but FOMC/CPI/NFP move them the
  // same way — real, verified dates (see calendar.js), never a guess.
  const upcomingMacro = calendar.getUpcomingEvents(1).filter(e => EVENT_TYPES_THAT_VETO.includes(e.type));
  if (upcomingMacro.length) {
    const e = upcomingMacro[0];
    return {
      approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED',
      detail: `HOLD — ${e.label} on ${e.date}, within 24h. IV and price both tend to move sharply around this release; no new recommendations until it's passed.`,
    };
  }

  // ── Regime gate ──────────────────────────────────────────────────────────
  if (regime) {
    if (regime.sizingMod <= 0) {
      return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `Extreme volatility regime (VIX proxy ~${regime.vix}) — no new recommendations.` };
    }
    if (structured.bias === 'CALL' && regime.allowBullish === false) {
      return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `${regime.name} regime disallows new bullish entries.` };
    }
    if (structured.bias === 'PUT' && regime.allowBearish === false) {
      return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `${regime.name} regime disallows new bearish entries.` };
    }
    if (regime.maxNewPerDay !== undefined && regime.maxNewPerDay !== Infinity && sessionNewCount >= regime.maxNewPerDay) {
      return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `${regime.name} regime caps new recommendations at ${regime.maxNewPerDay}/session (already recommended ${sessionNewCount}).` };
    }
  }

  // ── IV pricing gates ─────────────────────────────────────────────────────
  const ivSampleSize = analytics.getIVHistoryCount(structured.symbol);
  if (ivSampleSize >= IV_RANK_MIN_SAMPLE && structured.ivRank > IV_RANK_VETO) {
    return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `IV Rank ${structured.ivRank.toFixed(0)} > ${IV_RANK_VETO} — premium is too rich to recommend buying long options.` };
  }
  const ivHvRatio = analysis?.hv ? structured.iv / analysis.hv : null;
  if (ivHvRatio != null && ivHvRatio > IV_HV_RATIO_VETO) {
    return { approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED', detail: `IV/HV ratio ${ivHvRatio.toFixed(2)} > ${IV_HV_RATIO_VETO} — implied vol is pricing in outsized event risk relative to realized vol.` };
  }

  const capital = cfg.TOTAL_BUDGET;
  if (!capital || capital <= 0) {
    return { approved: false, status: 'REJECTED', vetoReason: 'DATA_INSUFFICIENT', detail: 'TOTAL_BUDGET is not configured — set it in .env to your real account size.' };
  }

  // "Open positions" = our own tracked ACTIVE recommendations, since there's
  // no live broker to check — this assumes you acted on every recommendation
  // we made. If you skip one, tell it to ignore that symbol or clear the DB row.
  const openPositions = db.getTradesByStatus('ACTIVE').length;
  if (openPositions >= MAX_OPEN_POSITIONS) {
    return {
      approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED',
      detail: `Max open recommendations reached (${openPositions}/${MAX_OPEN_POSITIONS}).`,
      capital, openPositions, maxOpenPositions: MAX_OPEN_POSITIONS,
    };
  }

  // ── Net directional (correlation-proxy) exposure cap ────────────────────
  const currentExposure = netDirectionalExposure();
  const signedDelta = structured.bias === 'CALL' ? structured.delta : -structured.delta;
  const projectedExposure = currentExposure + signedDelta;
  if (Math.abs(projectedExposure) > MAX_NET_DIRECTIONAL_EXPOSURE) {
    return {
      approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED',
      detail: `Net directional exposure would be ${projectedExposure.toFixed(2)} (cap ±${MAX_NET_DIRECTIONAL_EXPOSURE}) — too many correlated same-direction recommendations already active.`,
      currentExposure, signedDelta,
    };
  }

  const weeklyPnL = analytics.getWeeklyPnL();
  const weeklyDrawdownPct = Math.abs(Math.min(0, weeklyPnL)) / capital;
  // This one is deliberately NOT an early hard block like the checks above.
  // Those represent things that make the setup itself unreliable (bad data,
  // no real contract, an event about to move price). A weekly drawdown pause
  // is a portfolio-level "don't add risk this week" call, not a flaw in this
  // specific pick — so sizing still gets computed normally below and the
  // real numbers still get shown, just marked paused rather than hidden.
  const weeklyDrawdownPaused = weeklyDrawdownPct >= WEEKLY_DRAWDOWN_LIMIT_PCT;

  // ── Conviction-scaled sizing (10-15% band) ──────────────────────────────
  let ivFavorability = 100 - Math.min(100, structured.ivRank);
  if (ivHvRatio != null && ivHvRatio > IV_HV_RATIO_CAUTION) ivFavorability *= 0.7;
  const baseConviction = analysis?.conviction ?? 50;
  const finalConviction = Math.round(baseConviction * 0.7 + ivFavorability * 0.3);

  const allocationPct = ALLOC_MIN_PCT + (ALLOC_MAX_PCT - ALLOC_MIN_PCT) * (finalConviction / 100);
  const regimeSizingMod = regime?.sizingMod ?? 1.0;
  const maxAllocation = capital * ALLOC_MAX_PCT * regimeSizingMod;
  const targetAllocation = capital * allocationPct * regimeSizingMod;
  const minAllocation = capital * ALLOC_MIN_PCT * regimeSizingMod;

  const costPerContract = structured.entryLimit * 100;
  const qty = Math.max(0, Math.floor(targetAllocation / costPerContract));

  if (qty < 1) {
    return {
      approved: false, status: 'REJECTED', vetoReason: 'RISK_BOUNDS_EXCEEDED',
      detail: `Single contract cost $${costPerContract.toFixed(2)} exceeds the conviction-scaled allocation ($${targetAllocation.toFixed(2)}, conviction ${finalConviction}/100) — cannot recommend even 1 contract within risk bounds.`,
      capital, targetAllocation, finalConviction,
    };
  }

  const tradeCost = qty * costPerContract;

  // Everything below is real and fully computed either way — only the
  // approved/status/detail framing differs based on the drawdown pause.
  const sizing = {
    capital, qty, tradeCost,
    allocationPct: tradeCost / capital,
    allocationMin: minAllocation, allocationMax: maxAllocation,
    openPositions, maxOpenPositions: MAX_OPEN_POSITIONS,
    weeklyPnL, weeklyDrawdownPct, weeklyDrawdownPaused,
    conviction: finalConviction, ivFavorability, ivHvRatio,
    netExposureBefore: currentExposure, netExposureAfter: projectedExposure,
    // Below IV_RANK_MIN_SAMPLE, the IV Rank and IV/HV vetoes above are
    // simply skipped (not passed) — surfaced here so the report can say so
    // plainly instead of silently looking like those protections are live.
    ivGateActive: ivSampleSize >= IV_RANK_MIN_SAMPLE, ivSampleSize,
  };

  if (weeklyDrawdownPaused) {
    return {
      approved: false, status: 'PAUSED', vetoReason: 'WEEKLY_DRAWDOWN_PAUSED',
      detail: `Weekly (hypothetical) drawdown ${(weeklyDrawdownPct * 100).toFixed(1)}% ≥ ${(WEEKLY_DRAWDOWN_LIMIT_PCT * 100).toFixed(0)}% limit — real, fully-qualified setup, but new entries are paused this week rather than dropped. Resets Monday.`,
      ...sizing,
    };
  }

  return { approved: true, status: 'APPROVED', ...sizing };
}

module.exports = {
  evaluate, ALLOC_MIN_PCT, ALLOC_MAX_PCT, MAX_OPEN_POSITIONS, WEEKLY_DRAWDOWN_LIMIT_PCT,
  IV_RANK_VETO, IV_HV_RATIO_VETO, IV_RANK_MIN_SAMPLE, MAX_NET_DIRECTIONAL_EXPOSURE,
};
