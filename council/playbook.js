/**
 * council/playbook.js — exact entry/exit detail for every active recommendation.
 *
 * Sourced entirely from trade_history + real live quotes — there is no
 * broker account to read positions from. "Current price" and P&L here are
 * hypothetical: they assume you took the trade at the recommended entry and
 * are still holding it, priced off the real live market, not a guess.
 */
const { getOptionQuotes } = require('../marketdata');
const db = require('./db');

async function buildPlaybook() {
  const active = db.getActiveTrades();
  if (!active.length) return [];

  const quotes = await getOptionQuotes(active.map(t => t.contract_symbol));

  return active.map(t => {
    const quote = quotes[t.contract_symbol];
    const currentPrice = quote ? quote.mid : null;
    const unrealizedPct = currentPrice != null ? (currentPrice - t.entry_price) / t.entry_price : null;
    const unrealizedDollar = currentPrice != null ? (currentPrice - t.entry_price) * t.qty * 100 : null;
    const daysToExpiry = t.expiration ? (new Date(t.expiration) - Date.now()) / (1000 * 60 * 60 * 24) : null;
    const daysHeld = (Date.now() - new Date(t.opened_at)) / (1000 * 60 * 60 * 24);

    return {
      symbol: t.contract_symbol, underlying: t.ticker, optionType: t.option_type,
      strike: t.strike, expiration: t.expiration, daysToExpiry,
      qty: t.qty, entryLimit: t.entry_price,
      target: t.target_price, stop: t.stop_price,
      daysHeld, currentPrice, unrealizedPct, unrealizedDollar,
      quoteAvailable: !!quote,
    };
  });
}

module.exports = { buildPlaybook };
