/**
 * news.js — real, dated headlines from the market-data provider's news feed
 * (Benzinga wire via Alpaca; same credentials as price data, no extra key).
 *
 * DELIBERATE DESIGN LIMIT: this module returns headlines. It does not score
 * them, rank them bullish/bearish, or feed them into any trading decision.
 *
 * That is not laziness. Turning headlines into a trading signal means one of
 * two things: paying for a sentiment dataset, or having a language model
 * invent a number from the text. The second is indistinguishable from
 * fabrication — it produces a confident-looking score with nothing real
 * underneath, and it cannot be backtested here because historical news
 * archives aren't available through this feed. Every other number in this
 * engine traces to something measurable; a sentiment score would not.
 *
 * So: real headlines, real timestamps, real sources, shown next to the pick
 * for a human to read and weigh. That's the honest use of this data.
 */
const axios = require('axios');
require('dotenv').config();

const api = axios.create({
  baseURL: 'https://data.alpaca.markets/v1beta1',
  headers: {
    'APCA-API-KEY-ID': process.env.MARKET_DATA_KEY,
    'APCA-API-SECRET-KEY': process.env.MARKET_DATA_SECRET,
  },
});

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function normalize(items) {
  return (items || []).map(n => ({
    headline: n.headline,
    source: n.source,
    createdAt: n.created_at,
    url: n.url,
    symbols: n.symbols || [],
  }));
}

// Headlines mentioning a specific symbol. Returns [] rather than throwing —
// news is context, and a news outage should never stop a session.
async function getSymbolNews(symbol, { limit = 4, lookbackDays = 7 } = {}) {
  try {
    const res = await api.get('/news', {
      params: { symbols: symbol, limit, start: daysAgo(lookbackDays), sort: 'desc' },
    });
    return normalize(res.data.news);
  } catch {
    return [];
  }
}

// Broad market / macro / geopolitical headlines — no symbol filter, so this
// picks up rate decisions, conflicts, tariffs, and the rest of the backdrop.
async function getMarketNews({ limit = 6, lookbackDays = 2 } = {}) {
  try {
    const res = await api.get('/news', {
      params: { limit, start: daysAgo(lookbackDays), sort: 'desc' },
    });
    return normalize(res.data.news);
  } catch {
    return [];
  }
}

module.exports = { getSymbolNews, getMarketNews };
