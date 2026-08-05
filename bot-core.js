/**
 * bot-core.js — shared session logic used by both bot.js (CLI) and server.js (web).
 *
 * This is a recommendation engine, not a trading bot: it runs the 4-Agent
 * Council against real market data, tracks hypothetical outcomes against
 * real live quotes, and reports everything by email/dashboard. It never
 * places a real order — see marketdata.js, which is read-only by design.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const analytics = require('./analytics');
const { isTradingOpen } = require('./marketdata');
const { runCouncil } = require('./council/run');
const { buildPlaybook } = require('./council/playbook');
const { sendSessionReport } = require('./notify');

// Static copy of the same report the email sends, written to disk so
// GitHub Pages (or any static host) can serve an always-on version —
// nothing here is regenerated differently, it's the same html.
function writeStaticReport(html) {
  const reportDir = path.join(__dirname, 'report');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'index.html'), html);
}

function toRecommendationCard(result) {
  const { analysis, structured, risk, outcome } = result;
  const direction = structured.bias === 'CALL' ? 'Bullish' : 'Bearish';

  return {
    advisor: 'council', direction, symbol: structured.symbol,
    optType: structured.optType,
    leg1: {
      contract: { symbol: structured.contractSymbol, strike_price: String(structured.strike), expiration_date: structured.expiration },
      limitPrice: structured.entryLimit, qty: risk.qty, delta: structured.delta,
    },
    leg2: null,
    netDebit: risk.tradeCost,
    ivRank: structured.ivRank,
    reason: analysis.reasonLines.join(' '),
    shortReason: `${structured.symbol} ${direction} — Δ${structured.delta.toFixed(2)}, target +${((structured.targetLimit / structured.entryLimit - 1) * 100).toFixed(1)}%`,
    tradeId: outcome.trade_id,
  };
}

function toOutcomeCard(closed) {
  const label = closed.status === 'CLOSED_WIN' ? 'Target reached' : closed.status === 'CLOSED_LOSS' ? 'Stop reached' : 'Expired (near expiration, no target/stop hit)';
  return {
    symbol: closed.symbol,
    reason: `${label} (hypothetical) @ ${(closed.pnlPct * 100).toFixed(1)}% ($${closed.pnlDollar.toFixed(0)}), held ${closed.holdingDays.toFixed(1)}d`,
    pnl: closed.pnlDollar, pnlPct: closed.pnlPct,
  };
}

async function runSession() {
  console.log(`\n[${new Date().toISOString()}] ══ 4-Agent Council Session ══`);

  if (!await isTradingOpen()) {
    console.log('[bot] Market is closed — no fresh recommendations (live quotes wouldn\'t be current).');
    return { marketClosed: true, newCampaigns: [], exits: [] };
  }

  const { results, reconciliation, regime, watchlist } = await runCouncil();

  const exits = reconciliation.closed.map(toOutcomeCard);
  const newCampaigns = results
    .filter(r => r.structured?.ok && r.risk?.approved)
    .map(toRecommendationCard);

  const playbook = await buildPlaybook();

  const html = await sendSessionReport({
    newCampaigns, exits, regime, watchlist, playbook,
    weeklyPnL: analytics.getWeeklyPnL(),
    monthlyPnL: analytics.getMonthlyPnL(),
  });
  writeStaticReport(html);

  return { newCampaigns, exits, regime, watchlist, playbook, weeklyPnL: analytics.getWeeklyPnL() };
}

module.exports = { runSession };
