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
  return watchlist.sort((a, b) => b.conviction - a.conviction);
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

  if (regime?.sizingMod <= 0) {
    return { call: 'SIT OUT', reason: `Extreme volatility regime (VIX proxy ~${regime.vix}). Buying premium here is historically the worst risk/reward there is.${macroNote}` };
  }
  if (!hot.length) {
    return { call: 'SIT OUT', reason: `Nothing cleared the bar — ${tradable} of ${scanned} ETFs are in a tradable stage (${breadthPct}% breadth) and none produced a contract worth the entry.${macroNote}` };
  }
  if (macroSoon.length) {
    return { call: 'WAIT IF YOU CAN', reason: `${hot.length} pick${hot.length === 1 ? '' : 's'} cleared, but${macroNote} Entering the day after usually gets you a similar setup at a cheaper premium.` };
  }
  if (breadthPct < 15) {
    return { call: 'SELECTIVE', reason: `Only ${tradable} of ${scanned} ETFs are in a tradable stage (${breadthPct}% breadth) — thin participation, so treat the ${hot.length} pick${hot.length === 1 ? '' : 's'} below as the exception rather than a broad green light.` };
  }
  return { call: 'GOOD DAY TO BUY', reason: `${tradable} of ${scanned} ETFs in a tradable stage (${breadthPct}% breadth), ${regime?.name || 'regime'} conditions, and ${hot.length} pick${hot.length === 1 ? '' : 's'} cleared every gate.` };
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

  const verdict = dailyVerdict({ results, hot, regime });
  console.log(`[council] Verdict: ${verdict.call} — ${verdict.reason}`);

  return { results, reconciliation, thresholds, regime, watchlist, verdict };
}

if (require.main === module) {
  runCouncil().catch(err => {
    console.error('[council] Fatal error:', err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { runCouncil };
