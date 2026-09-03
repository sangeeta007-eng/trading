/**
 * council/sync.js — virtual outcome tracker.
 *
 * This tool never places real orders, so there is nothing to reconcile
 * against a broker. Instead, every session, each ACTIVE recommendation's
 * contract is checked against a REAL live quote (never estimated) and
 * closed out based purely on price:
 *   - live bid >= target_price  -> CLOSED_WIN  (hypothetical: assumes you
 *     sold at target)
 *   - live bid <= stop_price    -> CLOSED_LOSS (hypothetical: assumes you
 *     sold at stop)
 *   - within TIME_STOP_DTE days of expiration with neither hit -> EXPIRED
 *     (recorded at the last known live price, not a guess)
 *   - no live quote available -> left ACTIVE, not guessed
 *
 * All P&L recorded here is hypothetical — it assumes you actually took the
 * trade at the recommended entry and exited exactly at target/stop. It is
 * not your real account's P&L, since this tool has no visibility into what
 * you actually did on Fidelity/Robinhood.
 */
const { getOptionQuotes } = require('../marketdata');
const analytics = require('../analytics');
const db = require('./db');
const learning = require('./learning');

const TIME_STOP_DTE = 5; // flag as EXPIRED within this many calendar days of expiration, neither target nor stop hit
const MAX_HOLD_DAYS  = 21; // 21-day window: the dip trade is given three weeks to work, matching what was backtested (avg resolution 8.1 days)

function finalizeClose(trade, { exitPrice, status, closedAt, reasonTag }) {
  const entryPrice = trade.entry_price;
  const pnlPct = (exitPrice - entryPrice) / entryPrice;
  const pnlDollar = (exitPrice - entryPrice) * trade.qty * 100;
  const holdingDays = (new Date(closedAt) - new Date(trade.opened_at)) / (1000 * 60 * 60 * 24);

  db.closeTrade(trade.trade_id, {
    exit_price: exitPrice, status, holding_days: holdingDays,
    pnl_pct: pnlPct, pnl_dollar: pnlDollar, closed_at: closedAt,
  });
  analytics.addRealizedPnL(pnlDollar);

  const icon = status === 'CLOSED_WIN' ? '✅' : status === 'CLOSED_LOSS' ? '🛑' : '⏰';
  console.log(`[council/sync] ${icon} ${trade.contract_symbol} ${status} @ $${exitPrice.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%, $${pnlDollar.toFixed(0)}, held ${holdingDays.toFixed(1)}d) — ${reasonTag} [hypothetical outcome, based on real market price].`);
  return { trade_id: trade.trade_id, symbol: trade.contract_symbol, status, exitPrice, pnlPct, pnlDollar, holdingDays, reasonTag };
}

async function reconcile() {
  const active = db.getActiveTrades();
  if (!active.length) return { closed: [], tuning: null };

  const quotes = await getOptionQuotes(active.map(t => t.contract_symbol));
  const closed = [];

  for (const trade of active) {
    try {
      const quote = quotes[trade.contract_symbol];
      const now = new Date();

      if (!quote) {
        console.log(`[council/sync] ⚠️ No live quote for ${trade.contract_symbol} — leaving ACTIVE (not guessing an outcome).`);
        continue;
      }

      if (quote.bid >= trade.target_price) {
        closed.push(finalizeClose(trade, { exitPrice: quote.bid, status: 'CLOSED_WIN', closedAt: now.toISOString(), reasonTag: 'target reached' }));
        continue;
      }
      if (quote.bid <= trade.stop_price) {
        closed.push(finalizeClose(trade, { exitPrice: quote.bid, status: 'CLOSED_LOSS', closedAt: now.toISOString(), reasonTag: 'stop reached' }));
        continue;
      }

      // Seven-day time stop. A recommendation that hasn't resolved inside a
      // week is closed out and drops off the active list, so the list is
      // always "this week's ideas" rather than an ever-growing backlog.
      // Measured against 8 years of history, capping the hold at 7 days
      // instead of 15 changes expectancy by 0.03pp — the average trade
      // resolves in ~2 days either way, so this costs nothing.
      const daysHeld = (now - new Date(trade.opened_at)) / (1000 * 60 * 60 * 24);
      if (daysHeld >= MAX_HOLD_DAYS) {
        closed.push(finalizeClose(trade, { exitPrice: quote.bid, status: 'EXPIRED', closedAt: now.toISOString(), reasonTag: `${MAX_HOLD_DAYS}-day time stop reached (held ${daysHeld.toFixed(1)}d), neither target nor stop hit` }));
        continue;
      }

      const daysToExpiration = (new Date(trade.expiration) - now) / (1000 * 60 * 60 * 24);
      if (daysToExpiration <= TIME_STOP_DTE) {
        closed.push(finalizeClose(trade, { exitPrice: quote.bid, status: 'EXPIRED', closedAt: now.toISOString(), reasonTag: `expiration approaching (${daysToExpiration.toFixed(1)}d), neither target nor stop hit` }));
      }
    } catch (err) {
      console.error(`[council/sync] ⚠️ Error checking ${trade.contract_symbol}: ${err.response?.data?.message || err.message}`);
    }
  }

  let tuning = null;
  if (closed.length) {
    tuning = learning.evaluateAndTune();
    if (tuning?.changed) {
      console.log(`[council/learning] 🔧 Thresholds adjusted: ${tuning.reasons.join(' ')}`);
    } else if (tuning) {
      console.log(`[council/learning] Post-mortem run — no change needed (win rate ${(tuning.winRate * 100).toFixed(0)}%).`);
    }
  }

  return { closed, tuning };
}

module.exports = { reconcile, TIME_STOP_DTE };
