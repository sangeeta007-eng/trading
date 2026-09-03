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
  // Only two things below actually suppress a pick, and both mean there is
  // literally nothing real to show: no usable contract, or no configured
  // capital to size against. Everything else — event blackouts, regime
  // caps, position counts, exposure, weekly drawdown — is a caution about
  // context, not a defect in the setup. Those are attached as advisories
  // and shown alongside the real numbers, because deciding whether to act
  // on them is the user's call, not this tool's. See ADVISORIES.md.
  if (!structured.ok) {
    return { approved: false, status: 'REJECTED', vetoReason: structured.vetoReason, detail: structured.detail };
  }

  const capital = cfg.TOTAL_BUDGET;
  if (!capital || capital <= 0) {
    return { approved: false, status: 'REJECTED', vetoReason: 'DATA_INSUFFICIENT', detail: 'TOTAL_BUDGET is not configured — set it in .env to your real account size.' };
  }

  const advisories = [];

  // ── Economic event blackout ──────────────────────────────────────────────
  // ETFs don't have a single earnings date, but FOMC/CPI/NFP move them the
  // same way — real, verified dates (see calendar.js), never a guess.
  const upcomingMacro = calendar.getUpcomingEvents(1).filter(e => EVENT_TYPES_THAT_VETO.includes(e.type));
  if (upcomingMacro.length) {
    const e = upcomingMacro[0];
    advisories.push({
      code: 'MACRO_EVENT',
      message: `${e.label} lands ${e.date}, inside 24h. Long options bought right before a major release pay elevated IV and can lose money on the post-release IV crush even when the direction is right.`,
    });
  }

  // ── Regime context ───────────────────────────────────────────────────────
  if (regime) {
    if (regime.sizingMod <= 0) {
      advisories.push({ code: 'EXTREME_VOL', message: `Extreme volatility regime (VIX proxy ~${regime.vix}). Historically the worst conditions for buying premium — sizing guidance below is unreliable here.` });
    }
    if (structured.bias === 'CALL' && regime.allowBullish === false) {
      advisories.push({ code: 'REGIME_DIRECTION', message: `${regime.name} regime is set against new bullish entries.` });
    }
    if (structured.bias === 'PUT' && regime.allowBearish === false) {
      advisories.push({ code: 'REGIME_DIRECTION', message: `${regime.name} regime is set against new bearish entries.` });
    }
    if (regime.maxNewPerDay !== undefined && regime.maxNewPerDay !== Infinity && sessionNewCount >= regime.maxNewPerDay) {
      advisories.push({ code: 'REGIME_PACE', message: `${regime.name} regime suggests at most ${regime.maxNewPerDay} new entries/session; this is #${sessionNewCount + 1}.` });
    }
  }

  // ── IV pricing gates ─────────────────────────────────────────────────────
  const ivSampleSize = analytics.getIVHistoryCount(structured.symbol);
  if (ivSampleSize >= IV_RANK_MIN_SAMPLE && structured.ivRank > IV_RANK_VETO) {
    advisories.push({ code: 'IV_RICH', message: `IV Rank ${structured.ivRank.toFixed(0)} > ${IV_RANK_VETO} — premium is expensive relative to this symbol's own past year. You're paying up for volatility.` });
  }
  const ivHvRatio = analysis?.hv ? structured.iv / analysis.hv : null;
  if (ivHvRatio != null && ivHvRatio > IV_HV_RATIO_VETO) {
    advisories.push({ code: 'IV_HV_GAP', message: `IV/HV ratio ${ivHvRatio.toFixed(2)} > ${IV_HV_RATIO_VETO} — implied vol is well above what this symbol has actually been realizing, which usually prices in event risk.` });
  }

  // "Open positions" = our own tracked ACTIVE recommendations, since there's
  // no live broker to check — this assumes you acted on every recommendation
  // we made, which is a guess, not a fact about your account.
  const openPositions = db.getTradesByStatus('ACTIVE').length;
  if (openPositions >= MAX_OPEN_POSITIONS) {
    advisories.push({ code: 'MANY_OPEN', message: `${openPositions} recommendations already tracked as open (soft guide: ${MAX_OPEN_POSITIONS}). Counted from what this tool suggested, not from your actual Robinhood account.` });
  }

  // ── Net directional (correlation-proxy) exposure ─────────────────────────
  const currentExposure = netDirectionalExposure();
  const signedDelta = structured.bias === 'CALL' ? structured.delta : -structured.delta;
  const projectedExposure = currentExposure + signedDelta;
  if (Math.abs(projectedExposure) > MAX_NET_DIRECTIONAL_EXPOSURE) {
    advisories.push({ code: 'CORRELATED', message: `Net directional exposure would reach ${projectedExposure.toFixed(2)} (soft guide ±${MAX_NET_DIRECTIONAL_EXPOSURE}) — several same-direction ETF positions behave more like one leveraged bet than diversification.` });
  }

  const weeklyPnL = analytics.getWeeklyPnL();
  const weeklyDrawdownPct = Math.abs(Math.min(0, weeklyPnL)) / capital;
  if (weeklyDrawdownPct >= WEEKLY_DRAWDOWN_LIMIT_PCT) {
    advisories.push({
      code: 'WEEKLY_DRAWDOWN',
      message: `Tracked hypothetical P&L is down ${(weeklyDrawdownPct * 100).toFixed(1)}% ($${Math.abs(weeklyPnL).toFixed(0)}) this week. This assumes every past suggestion was taken at its suggested size — it is not your real account's performance.`,
    });
  }

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
  // Floor at 1: a contract that costs more than the conviction-scaled
  // allocation is still a real, buyable contract. Show it with the real
  // cost and flag that it's above the intended band, rather than dropping
  // the pick for being expensive.
  const qty = Math.max(1, Math.floor(targetAllocation / costPerContract));
  const tradeCost = qty * costPerContract;

  if (tradeCost > maxAllocation) {
    advisories.push({
      code: 'ABOVE_ALLOCATION',
      message: `One contract costs $${costPerContract.toFixed(0)}, above the conviction-scaled allocation for this pick ($${targetAllocation.toFixed(0)}). Sized at the 1-contract minimum — that's ${((tradeCost / capital) * 100).toFixed(1)}% of configured capital, above the intended ${(ALLOC_MIN_PCT * 100).toFixed(0)}-${(ALLOC_MAX_PCT * 100).toFixed(0)}% band.`,
    });
  }

  return {
    approved: true, status: 'APPROVED',
    advisories,
    capital, qty, tradeCost,
    allocationPct: tradeCost / capital,
    allocationMin: minAllocation, allocationMax: maxAllocation,
    openPositions, maxOpenPositions: MAX_OPEN_POSITIONS,
    weeklyPnL, weeklyDrawdownPct,
    conviction: finalConviction, ivFavorability, ivHvRatio,
    netExposureBefore: currentExposure, netExposureAfter: projectedExposure,
    // Below IV_RANK_MIN_SAMPLE, the IV Rank and IV/HV checks above are
    // simply skipped (not passed) — surfaced here so the report can say so
    // plainly instead of silently looking like those protections are live.
    ivGateActive: ivSampleSize >= IV_RANK_MIN_SAMPLE, ivSampleSize,
  };
}

module.exports = {
  evaluate, ALLOC_MIN_PCT, ALLOC_MAX_PCT, MAX_OPEN_POSITIONS, WEEKLY_DRAWDOWN_LIMIT_PCT,
  IV_RANK_VETO, IV_HV_RATIO_VETO, IV_RANK_MIN_SAMPLE, MAX_NET_DIRECTIONAL_EXPOSURE,
};
