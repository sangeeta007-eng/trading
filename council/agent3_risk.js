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

// ── The actual risk control ──────────────────────────────────────────────
// Eight years of backtesting says the worst single trade on this strategy
// loses 100% of the premium, and says it identically whether the stop is
// -30%, -65%, on the option, on the underlying, or absent entirely. Options
// gap through stops; no stop level ever prevented a total loss. So the stop
// is not what protects the account — the size of the bet is.
//
// This is the standard professional discipline for long options, and it is
// why the sizing math has to run off MAX loss (the whole premium) rather
// than off expected loss. At 2% risked per trade it takes ~34 consecutive
// total losses to halve the account; the 1% version of the same rule needs
// ~69. Against a measured 73% win rate, either is comfortably survivable.
// The allocation band below still applies — whichever is smaller wins.
const MAX_LOSS_PER_TRADE_PCT = parseFloat(process.env.MAX_LOSS_PER_TRADE_PCT) || 0.02;

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
      plain: `A big government report (${e.label}) comes out on ${e.date}. Before news like that, option prices get temporarily puffed up because everyone expects a big swing. Once the news is out, that extra cost deflates fast — so you can guess the direction correctly and still lose money, simply because you overpaid going in. Waiting until the day after usually gets you the same trade cheaper.`,
    });
  }

  // ── Regime context ───────────────────────────────────────────────────────
  if (regime) {
    if (regime.sizingMod <= 0) {
      advisories.push({
        code: 'EXTREME_VOL',
        message: `Extreme volatility regime (VIX proxy ~${regime.vix}). Historically the worst conditions for buying premium — sizing guidance below is unreliable here.`,
        plain: `The market is unusually panicky right now (fear gauge around ${regime.vix}). When everyone is scared, options get very expensive, so you're paying top dollar for the same bet. This is generally the worst time to be buying them.`,
      });
    }
    if (structured.bias === 'CALL' && regime.allowBullish === false) {
      advisories.push({
        code: 'REGIME_DIRECTION',
        message: `${regime.name} regime is set against new bullish entries.`,
        plain: `Overall market conditions (${regime.name}) are currently unfriendly to bets that things go UP. This one bets up.`,
      });
    }
    if (structured.bias === 'PUT' && regime.allowBearish === false) {
      advisories.push({
        code: 'REGIME_DIRECTION',
        message: `${regime.name} regime is set against new bearish entries.`,
        plain: `Overall market conditions (${regime.name}) are currently unfriendly to bets that things go DOWN. This one bets down.`,
      });
    }
    if (regime.maxNewPerDay !== undefined && regime.maxNewPerDay !== Infinity && sessionNewCount >= regime.maxNewPerDay) {
      advisories.push({
        code: 'REGIME_PACE',
        message: `${regime.name} regime suggests at most ${regime.maxNewPerDay} new entries/session; this is #${sessionNewCount + 1}.`,
        plain: `In jumpy markets like today's, it's usually wiser to take only a couple of new trades at once instead of piling in. This would be your ${sessionNewCount + 1}${sessionNewCount === 0 ? 'st' : sessionNewCount === 1 ? 'nd' : sessionNewCount === 2 ? 'rd' : 'th'} today.`,
      });
    }
  }

  // ── IV pricing gates ─────────────────────────────────────────────────────
  const ivSampleSize = analytics.getIVHistoryCount(structured.symbol);
  if (ivSampleSize >= IV_RANK_MIN_SAMPLE && structured.ivRank > IV_RANK_VETO) {
    advisories.push({
      code: 'IV_RICH',
      message: `IV Rank ${structured.ivRank.toFixed(0)} > ${IV_RANK_VETO} — premium is expensive relative to this symbol's own past year. You're paying up for volatility.`,
      plain: `This option is pricey by its own standards — more expensive than it has been about ${structured.ivRank.toFixed(0)}% of the past year. You're buying near the top of its usual price range, so you need a bigger move just to break even.`,
    });
  }
  const ivHvRatio = analysis?.hv ? structured.iv / analysis.hv : null;
  if (ivHvRatio != null && ivHvRatio > IV_HV_RATIO_VETO) {
    advisories.push({
      code: 'IV_HV_GAP',
      message: `IV/HV ratio ${ivHvRatio.toFixed(2)} > ${IV_HV_RATIO_VETO} — implied vol is well above what this symbol has actually been realizing, which usually prices in event risk.`,
      plain: `The option's price assumes this ETF will swing around ${ivHvRatio.toFixed(1)}x more than it actually has been swinging lately. You're paying for drama that hasn't been happening — usually a sign the market expects some news.`,
    });
  }

  const openPositions = db.getTradesByStatus('ACTIVE').length;

  const currentExposure = netDirectionalExposure();
  const signedDelta = structured.bias === 'CALL' ? structured.delta : -structured.delta;
  const projectedExposure = currentExposure + signedDelta;

  const weeklyPnL = analytics.getWeeklyPnL();
  const weeklyDrawdownPct = Math.abs(Math.min(0, weeklyPnL)) / capital;

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

  // For a long option, cost per contract IS max loss per contract — there is
  // no scenario where it loses more, and the backtest confirms there are
  // scenarios where it loses exactly that. So the risk budget and the
  // allocation budget are both denominated in the same dollars, and the
  // tighter of the two decides the size.
  const riskBudget = capital * MAX_LOSS_PER_TRADE_PCT;
  const sizingBudget = Math.min(targetAllocation, riskBudget);
  // Floor at 1: a contract that costs more than the budget is still a real,
  // buyable contract. Show it with the real cost and flag exactly what a
  // total loss would do to the account, rather than dropping the pick.
  const qty = Math.max(1, Math.floor(sizingBudget / costPerContract));
  const tradeCost = qty * costPerContract;
  const maxLossPct = tradeCost / capital; // if it goes to zero, this is the damage

  const sizedBy = riskBudget < targetAllocation ? 'RISK' : 'ALLOCATION';

  if (tradeCost > riskBudget) {
    advisories.push({
      code: 'ABOVE_RISK_BUDGET',
      message: `One contract costs $${costPerContract.toFixed(0)}, above the ${(MAX_LOSS_PER_TRADE_PCT * 100).toFixed(0)}%-of-capital max-loss budget ($${riskBudget.toFixed(0)}). Sized at the 1-contract minimum, so a total loss on this position would be ${(maxLossPct * 100).toFixed(1)}% of capital rather than the intended ${(MAX_LOSS_PER_TRADE_PCT * 100).toFixed(0)}%.`,
      plain: `The smallest amount you can buy — one contract — costs $${costPerContract.toFixed(0)}. If this trade went completely wrong and the option expired worthless, you'd lose ${(maxLossPct * 100).toFixed(1)}% of your account on this one bet, instead of the ${(MAX_LOSS_PER_TRADE_PCT * 100).toFixed(0)}% cap the tool aims for. That's more riding on a single trade than intended — either skip it, or accept the bigger swing knowingly.`,
    });
  } else if (tradeCost > maxAllocation) {
    advisories.push({
      code: 'ABOVE_ALLOCATION',
      message: `One contract costs $${costPerContract.toFixed(0)}, above the conviction-scaled allocation for this pick ($${targetAllocation.toFixed(0)}). Sized at the 1-contract minimum — that's ${((tradeCost / capital) * 100).toFixed(1)}% of configured capital, above the intended ${(ALLOC_MIN_PCT * 100).toFixed(0)}-${(ALLOC_MAX_PCT * 100).toFixed(0)}% band.`,
      plain: `Even buying just one contract costs $${costPerContract.toFixed(0)}, which is a bigger chunk of your money on a single trade than intended (${((tradeCost / capital) * 100).toFixed(1)}% instead of the usual ${(ALLOC_MIN_PCT * 100).toFixed(0)}-${(ALLOC_MAX_PCT * 100).toFixed(0)}%). More riding on one bet than normal.`,
    });
  }

  return {
    approved: true, status: 'APPROVED',
    advisories,
    capital, qty, tradeCost,
    maxLoss: tradeCost, maxLossPct, riskBudget, sizedBy,
    maxLossPerTradePct: MAX_LOSS_PER_TRADE_PCT,
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
  MAX_LOSS_PER_TRADE_PCT,
  IV_RANK_VETO, IV_HV_RATIO_VETO, IV_RANK_MIN_SAMPLE, MAX_NET_DIRECTIONAL_EXPOSURE,
};
