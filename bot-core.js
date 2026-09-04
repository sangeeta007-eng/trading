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
const { sendSessionReport, sendFailureAlert } = require('./notify');
const { getMacroSnapshot } = require('./fred');
const { getMarketNews, getSymbolNews } = require('./news');
const { structureSpread } = require('./council/spread_structurer');
const { DEFAULT_UNIVERSE } = require('./council/agent1_analyst');
const { getBars } = require('./marketdata');

// Defined-risk put credit spreads, scanned across the universe. This is the
// only structure here with measured positive expectancy (+1.6%/trade over 8
// years vs -3.3% for buying) — see STRATEGY_RESEARCH.md. Deliberately
// unfiltered: every trend filter tested made the bad years worse.
async function scanSpreads(limit = 4) {
  const found = [];
  for (const sym of DEFAULT_UNIVERSE) {
    try {
      const bars = await getBars(sym, '1Day', 5);
      if (!bars.length) continue;
      const s = await structureSpread(sym, bars[bars.length - 1].c);
      if (s.ok) found.push(s);
    } catch { /* one symbol failing must not take down the session */ }
  }
  // Best paid for the risk taken.
  return found.sort((a, b) => b.creditPctOfWidth - a.creditPctOfWidth).slice(0, limit);
}


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

  try {
    // The scan runs whether or not the market is open. It used to return
    // here, which meant pressing "Run a Fresh Session Now" outside market
    // hours regenerated nothing at all — the page reloaded onto the same
    // stale report with no indication why, which reads as a broken button.
    // Now a session always produces a current report; when the market is
    // shut the report says so at the top and every price is labelled as
    // last-close rather than live. Email still only goes out on a live
    // session, so closed-market runs don't fill the inbox.
    const marketOpen = await isTradingOpen();
    if (!marketOpen) {
      console.log('[bot] Market is closed — scanning on last-close quotes; report will be labelled stale and no email sent.');
    }

    const { results, reconciliation, regime, watchlist, verdict, dipWatch } = await runCouncil();

    const exits = reconciliation.closed.map(toOutcomeCard);
    const newCampaigns = results
      .filter(r => r.structured?.ok && r.risk?.approved)
      .map(toRecommendationCard);

    const playbook = await buildPlaybook();
    // Real Fed funds rate + yield curve data (fred.js) — informational, not
    // yet a sizing/veto input. Never throws: no FRED_API_KEY configured
    // just means the report shows the section as "not configured."
    const macro = await getMacroSnapshot();

    // Real, dated headlines — market/macro backdrop plus per-pick context.
    // Displayed for you to read; never scored or fed into a decision.
    const marketNews = await getMarketNews({ limit: 5, lookbackDays: 2 });
    const spreads = await scanSpreads(4);
    for (const w of watchlist.filter(x => x.tier === 'HOT')) {
      w.news = await getSymbolNews(w.symbol, { limit: 3, lookbackDays: 7 });
    }

    const html = await sendSessionReport({
      newCampaigns, exits, regime, watchlist, playbook, macro, verdict, marketNews, spreads, dipWatch,
      marketOpen, deliver: marketOpen,
      weeklyPnL: analytics.getWeeklyPnL(),
      monthlyPnL: analytics.getMonthlyPnL(),
    });
    writeStaticReport(html);

    return { marketClosed: !marketOpen, newCampaigns, exits, regime, watchlist, playbook, weeklyPnL: analytics.getWeeklyPnL() };
  } catch (err) {
    // A crashed session produces no report at all — that silence could be
    // mistaken for a normal "nothing new today" run. Alert distinctly
    // rather than let it pass unnoticed, then let the caller's own error
    // handling (bot.js's exit code, server.js's dashboard broadcast) still
    // run exactly as before.
    console.error('[bot-core] Session failed:', err.response?.data || err.message);
    try {
      await sendFailureAlert(err);
    } catch (alertErr) {
      console.error('[bot-core] Also failed to send the failure alert:', alertErr.message);
    }
    throw err;
  }
}

module.exports = { runSession };
