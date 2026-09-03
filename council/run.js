/**
 * council/run.js — orchestrates the 4-Agent Options Trading Council.
 * Recommendation-only: no order is ever placed. Usage: node council/run.js
 */
require('dotenv').config();
const { isTradingOpen } = require('../marketdata');
const { getRegime } = require('../regime');
const agent1 = require('./agent1_analyst');
const agent2 = require('./agent2_structurer');
const agent3 = require('./agent3_risk');
const agent4 = require('./agent4_strategist');
const sync = require('./sync');
const calendar = require('../calendar');
const db = require('./db');

// HOT = a real, tradable setup: a live contract was found that cleared the
// per-trade quality bar (delta band, spread, liquidity, expected move), and
// it's sized against configured capital. Portfolio-level context — macro
// events, regime, how much is already open, weekly drawdown — rides along
// as `advisories` on the pick rather than suppressing it, because whether
// those outweigh the setup is the user's judgment call, not this tool's.
// WARM = a real non-neutral technical setup (conviction >= 50) where no
// contract cleared that quality bar this session — worth watching, nothing
// to place yet. Both grounded in the same conviction score and real market
// data — no separate, fabricated sentiment layer.
const WARM_CONVICTION_FLOOR = 50;
const MAX_STOCK_PICKS = 4; // individual stocks carry single-company gap risk — keep the list short

function classifyWatchlist(results) {
  const watchlist = [];
  for (const r of results) {
    const { analysis, structured, risk } = r;
    if (!analysis || !analysis.bias || analysis.bias === 'NEUTRAL') continue;

    const conviction = analysis.conviction || 0;
    const approved = risk?.approved === true;
    let tier = null;
    if (approved) tier = 'HOT';
    else if (conviction >= WARM_CONVICTION_FLOOR) tier = 'WARM';
    if (!tier) continue;

    watchlist.push({
      symbol: analysis.symbol, bias: analysis.bias, conviction, tier, approved,
      assetType: analysis.assetType || 'ETF', eventGap: analysis.eventGap || null,
      price: analysis.price, rsi: analysis.rsi, adx: analysis.adx,
      advisories: approved ? (risk.advisories || []) : [],
      contract: structured?.ok ? {
        strike: structured.strike, expiration: structured.expiration, dte: structured.dte,
        entryLimit: structured.entryLimit, targetLimit: structured.targetLimit, stopLimit: structured.stopLimit,
        delta: structured.delta, ivRank: structured.ivRank,
        qty: approved ? risk.qty : null,
        tradeCost: approved ? risk.tradeCost : null,
      } : null,
      blockedReason: !approved ? (risk?.vetoReason || structured?.vetoReason || null) : null,
      blockedDetail: !approved ? (risk?.detail || structured?.detail || null) : null,
    });
  }
  watchlist.sort((a, b) => b.conviction - a.conviction);

  // Cap individual stocks. They carry single-company risk an ETF doesn't —
  // one earnings miss or one piece of company news can gap a stock in a way
  // a basket of 30+ holdings cannot — so the list stays short by design.
  const capped = [];
  let stocksKept = 0;
  for (const w of watchlist) {
    if (w.assetType === 'STOCK') {
      if (stocksKept >= MAX_STOCK_PICKS) continue;
      stocksKept++;
    }
    capped.push(w);
  }
  return capped;
}

// A plain daily call on whether this is a day to be putting money to work,
// stated from what the scan actually found rather than a mood reading.
// "Sit out" here is advice, not a block — every qualifying pick is still
// listed underneath it.
function dailyVerdict({ results, hot, regime }) {
  const scanned = results.length;
  const tradable = results.filter(r => r.bias && r.bias !== 'NEUTRAL').length;
  const breadthPct = scanned ? Math.round((tradable / scanned) * 100) : 0;
  const macroSoon = calendar.getUpcomingEvents(1).filter(e => ['FOMC', 'CPI', 'NFP'].includes(e.type));
  const macroNote = macroSoon.length ? ` ${macroSoon[0].label} lands ${macroSoon[0].date}, which inflates premiums today and crushes them after.` : '';

  const macroPlain = macroSoon.length
    ? ` A big government report (${macroSoon[0].label}) comes out ${macroSoon[0].date}, and option prices are temporarily inflated ahead of it — they usually deflate right after, so buying today means overpaying.`
    : '';

  if (regime?.sizingMod <= 0) {
    return {
      call: 'SIT OUT',
      reason: `Extreme volatility regime (VIX proxy ~${regime.vix}). Buying premium here is historically the worst risk/reward there is.${macroNote}`,
      plain: `The market is in a panic right now, which makes options very expensive. You'd be paying top dollar for the same bet. Best to wait for things to settle.${macroPlain}`,
    };
  }
  if (!hot.length) {
    return {
      call: 'SIT OUT',
      reason: `Nothing cleared the bar — ${tradable} of ${scanned} ETFs are in a tradable stage (${breadthPct}% breadth) and none produced a contract worth the entry.${macroNote}`,
      plain: `Nothing worth buying today. Out of ${scanned} funds checked, only ${tradable} are even in a clean trend, and none of those had an option at a sensible price. Some days there just isn't a good trade — that's normal, and forcing one is how people lose money.${macroPlain}`,
    };
  }
  if (macroSoon.length) {
    return {
      call: 'WAIT IF YOU CAN',
      reason: `${hot.length} pick${hot.length === 1 ? '' : 's'} cleared, but${macroNote} Entering the day after usually gets you a similar setup at a cheaper premium.`,
      plain: `There ${hot.length === 1 ? 'is 1 decent setup' : `are ${hot.length} decent setups`} below, but today is an expensive day to buy.${macroPlain} If you can hold off until the day after, you'd likely get the same trade for less.`,
    };
  }
  if (breadthPct < 15) {
    return {
      call: 'SELECTIVE',
      reason: `Only ${tradable} of ${scanned} ETFs are in a tradable stage (${breadthPct}% breadth) — thin participation, so treat the ${hot.length} pick${hot.length === 1 ? '' : 's'} below as the exception rather than a broad green light.`,
      plain: `Only ${tradable} out of ${scanned} funds are in a clean trend right now, so the market isn't broadly healthy. The pick${hot.length === 1 ? '' : 's'} below ${hot.length === 1 ? 'is an exception' : 'are exceptions'} rather than a sign it's a good day generally. Smaller size than usual would be sensible.`,
    };
  }
  return {
    call: 'GOOD DAY TO BUY',
    reason: `${tradable} of ${scanned} ETFs in a tradable stage (${breadthPct}% breadth), ${regime?.name || 'regime'} conditions, and ${hot.length} pick${hot.length === 1 ? '' : 's'} cleared every gate.`,
    plain: `A healthy day. ${tradable} of the ${scanned} funds checked are in clean trends, market conditions are calm, no big news due, and ${hot.length} setup${hot.length === 1 ? '' : 's'} passed every check.`,
  };
}

async function runCouncil({ universe = agent1.DEFAULT_UNIVERSE } = {}) {
  console.log('');
  console.log('='.repeat(80));
  console.log('  4-AGENT OPTIONS TRADING COUNCIL — Recommendation Engine');
  console.log(`  Universe: ${universe.join(', ')}`);
  console.log('='.repeat(80));

  const marketOpen = await isTradingOpen();
  if (!marketOpen) {
    console.log('[council] Market is closed — quotes would be stale, skipping this scan.');
  }

  const regime = await getRegime();
  console.log(`[council] Regime: ${regime.name} (VIX proxy ~${regime.vix}) | Sizing mod ${(regime.sizingMod * 100).toFixed(0)}% | Max new/session ${regime.maxNewPerDay === Infinity ? '∞' : regime.maxNewPerDay}`);

  // Reconcile filled entries/exits and expiration time-stops before scanning for new entries.
  const reconciliation = await sync.reconcile();

  const analyses = await agent1.scanUniverse(universe);
  const neutral = analyses.filter(a => a.bias === 'NEUTRAL');
  const actionable = analyses.filter(a => a.bias !== 'NEUTRAL').sort((a, b) => (b.conviction || 0) - (a.conviction || 0));

  for (const analysis of neutral) {
    console.log(`\n[council] ${analysis.symbol}: NEUTRAL — ${analysis.reasonLines[analysis.reasonLines.length - 1] || analysis.vetoReason}`);
  }

  const results = neutral.map(analysis => ({ analysis }));
  let sessionNewCount = 0;

  for (const analysis of actionable) {
    const structured = await agent2.structureContract(analysis.symbol, analysis.bias, analysis.price);
    const risk = await agent3.evaluate(structured, { analysis, regime, sessionNewCount });
    const outcome = await agent4.finalize({ analysis, structured, risk, regime });

    if (risk.approved) sessionNewCount++;

    console.log('\n' + outcome.report);
    results.push({ analysis, structured, risk, outcome });
  }

  const thresholds = db.getThresholds();
  console.log(`\n[council] Active thresholds → Delta ${thresholds.delta_min}-${thresholds.delta_max} | DTE ${thresholds.dte_min}-${thresholds.dte_max}`);

  const watchlist = classifyWatchlist(results);
  const hot = watchlist.filter(w => w.tier === 'HOT');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  console.log(`\n[council] 🔥 HOT: ${hot.map(w => w.symbol + (w.advisories?.length ? `(${w.advisories.length} advisory)` : '')).join(', ') || 'none'} | 🌤️  WARM: ${warm.map(w => w.symbol).join(', ') || 'none'}`);

    // The dip entry is rare by design (~1 signal every 2-3 days across 35
  // symbols). Surfacing what's approaching the trigger keeps the quiet days
  // informative instead of blank.
  const dipWatch = results
    .filter(r => r.analysis?.rsi2 != null && r.analysis.rsi2 < 25 && r.analysis.entryModel !== 'CONNORS_DIP')
    .map(r => ({ symbol: r.analysis.symbol, assetType: r.analysis.assetType, rsi2: r.analysis.rsi2, price: r.analysis.price }))
    .sort((a, b) => a.rsi2 - b.rsi2)
    .slice(0, 8);

  const verdict = dailyVerdict({ results, hot, regime });
  console.log(`[council] Verdict: ${verdict.call} — ${verdict.reason}`);

  return { results, reconciliation, thresholds, regime, watchlist, verdict, dipWatch };
}

if (require.main === module) {
  runCouncil().catch(err => {
    console.error('[council] Fatal error:', err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { runCouncil, MAX_STOCK_PICKS };
