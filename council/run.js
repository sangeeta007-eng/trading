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
const db = require('./db');

// HOT = actually approved and actionable this session (buying now / already
// bought). PAUSED = a real, fully-qualified setup (same structuring/sizing
// math as HOT) that Agent 3 specifically held back on portfolio-level
// grounds (currently: weekly drawdown circuit breaker) rather than a flaw
// in the setup itself — shown with full real numbers, just marked as a
// suggestion to sit out this week rather than dropped from the report.
// WARM = a real non-neutral technical setup (conviction >= 50) that didn't
// get a workable contract this session (liquidity/pricing), not a bad
// setup — worth watching. All three grounded in the same conviction score
// and risk outcome used for actual trading decisions — no separate,
// fabricated sentiment layer.
const WARM_CONVICTION_FLOOR = 50;

function classifyWatchlist(results) {
  const watchlist = [];
  for (const r of results) {
    const { analysis, structured, risk } = r;
    if (!analysis || !analysis.bias || analysis.bias === 'NEUTRAL') continue;

    const conviction = analysis.conviction || 0;
    const approved = risk?.approved === true;
    const paused = risk?.status === 'PAUSED';
    let tier = null;
    if (approved) tier = 'HOT';
    else if (paused) tier = 'PAUSED';
    else if (conviction >= WARM_CONVICTION_FLOOR) tier = 'WARM';
    if (!tier) continue;

    watchlist.push({
      symbol: analysis.symbol, bias: analysis.bias, conviction, tier, approved,
      price: analysis.price, rsi: analysis.rsi, adx: analysis.adx,
      contract: structured?.ok ? {
        strike: structured.strike, expiration: structured.expiration, dte: structured.dte,
        entryLimit: structured.entryLimit, targetLimit: structured.targetLimit, stopLimit: structured.stopLimit,
        delta: structured.delta, ivRank: structured.ivRank,
        qty: (approved || paused) ? risk.qty : null,
        tradeCost: (approved || paused) ? risk.tradeCost : null,
      } : null,
      blockedReason: !approved ? (risk?.vetoReason || structured?.vetoReason || null) : null,
      blockedDetail: !approved ? (risk?.detail || structured?.detail || null) : null,
    });
  }
  return watchlist.sort((a, b) => b.conviction - a.conviction);
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
  const paused = watchlist.filter(w => w.tier === 'PAUSED');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  console.log(`\n[council] 🔥 HOT: ${hot.map(w => w.symbol).join(', ') || 'none'} | ⏸️  PAUSED: ${paused.map(w => w.symbol).join(', ') || 'none'} | 🌤️  WARM: ${warm.map(w => w.symbol).join(', ') || 'none'}`);

  return { results, reconciliation, thresholds, regime, watchlist };
}

if (require.main === module) {
  runCouncil().catch(err => {
    console.error('[council] Fatal error:', err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { runCouncil };
