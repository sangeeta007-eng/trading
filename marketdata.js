/**
 * marketdata.js — READ-ONLY market data interface.
 *
 * This is the ONLY file in the codebase allowed to know which provider
 * supplies market data, or anything about that provider's API shape (auth
 * headers, base URLs, response field names). Every other file — all four
 * council agents, regime.js, bot-core.js — imports only the generic
 * functions below (getBars, getOptionsChain, getOptionQuotes, isTradingOpen,
 * ema, sma, calcDelta) and knows nothing about where the data comes from.
 *
 * Currently implemented against Alpaca's market-data API (free, no trading
 * account required — see MARKET_DATA_* in .env). To switch providers,
 * rewrite the internals of this file only; keep the exported function
 * names and return shapes identical and nothing elsewhere needs to change.
 *
 * This file intentionally contains no order-placement, account, or position
 * functions — full stop, regardless of provider. This is a recommendation
 * engine, not an execution system; the user trades manually on their own
 * broker (Fidelity/Robinhood).
 */
const axios = require('axios');
const { bsDelta, impliedVol } = require('./greek');
const { RISK_FREE_RATE } = require('./config');
require('dotenv').config();

// ── Provider-specific setup (Alpaca) — the only section that changes on a provider swap ──

const headers = {
  'APCA-API-KEY-ID':     process.env.MARKET_DATA_KEY,
  'APCA-API-SECRET-KEY': process.env.MARKET_DATA_SECRET,
  'Content-Type':        'application/json',
};

const api = axios.create({ baseURL: process.env.MARKET_DATA_BASE_URL, headers });
const dataApi = axios.create({ baseURL: process.env.MARKET_DATA_URL, headers });
const optionsDataApi = axios.create({ baseURL: 'https://data.alpaca.markets/v1beta1', headers });

// ── Generic interface — every caller in the codebase only ever sees this ──

async function isTradingOpen() { return (await api.get('/clock')).data.is_open; }

// Calendar days needed to comfortably cover `limit` bars of a given
// timeframe (padded for weekends/holidays). 2.1x covers daily bars (5
// trading days/week); weekly/monthly bars need the multiple of 7/30
// calendar days per bar instead, or this silently under-fetches and
// returns far fewer bars than asked for.
function calendarDaysFor(timeframe, limit) {
  if (/week/i.test(timeframe)) return Math.ceil(limit * 7 * 1.3);
  if (/month/i.test(timeframe)) return Math.ceil(limit * 31 * 1.3);
  return Math.ceil(limit * 2.1); // daily (or intraday, comfortably covered by the same padding)
}

// Get most recent N bars for the given timeframe (always most recent, never first-N bug)
async function getBars(symbol, timeframe = '1Day', limit = 60) {
  const start = new Date();
  start.setDate(start.getDate() - calendarDaysFor(timeframe, limit));
  const res = await dataApi.get(`/stocks/${symbol}/bars`, {
    params: { timeframe, start: start.toISOString().split('T')[0], feed: 'sip', limit: 1000 },
  });
  const bars = res.data.bars || [];
  return bars.slice(-limit);
}

// EMA (exponential moving average) from bars
function ema(bars, n) {
  if (bars.length < n) return null;
  const k    = 2 / (n + 1);
  let   val  = bars[0].c;
  for (let i = 1; i < bars.length; i++) val = bars[i].c * k + val * (1 - k);
  return val;
}

// SMA from bars
function sma(bars, n) {
  if (bars.length < n) return null;
  return bars.slice(-n).reduce((s, b) => s + b.c, 0) / n;
}

// ── Options chain with Greeks ─────────────────────────────────────────────────

async function getOptionsChain(underlyingSymbol, type, expDateGte, expDateLte, strikeGte, strikeLte) {
  const params = {
    underlying_symbols: underlyingSymbol,
    type,
    expiration_date_gte: expDateGte,
    expiration_date_lte: expDateLte,
    limit: 100,
  };
  if (strikeGte != null) params.strike_price_gte = strikeGte.toFixed(2);
  if (strikeLte != null) params.strike_price_lte = strikeLte.toFixed(2);

  // Paginate — a single page (limit 100) can otherwise miss strikes near the
  // money on high-priced underlyings with many listed strikes.
  let all = [];
  let pageToken;
  do {
    const res = await api.get('/options/contracts', { params: { ...params, page_token: pageToken } });
    all = all.concat(res.data.option_contracts || []);
    pageToken = res.data.next_page_token;
  } while (pageToken && all.length < 500);

  return all;
}

// Returns delta for a contract given current spot price and time to expiry
function calcDelta(contract, spotPrice) {
  const strike  = parseFloat(contract.strike_price);
  const expDate = new Date(contract.expiration_date);
  const T       = Math.max(0.001, (expDate - new Date()) / (365 * 24 * 60 * 60 * 1000));
  const midPrice = parseFloat(contract.close_price) || 0;
  const type    = contract.type; // 'call' or 'put'

  if (midPrice <= 0) return null;

  const iv = impliedVol(midPrice, spotPrice, strike, T, RISK_FREE_RATE, type);
  if (!iv || iv <= 0) return null;

  return {
    delta:  bsDelta(spotPrice, strike, T, RISK_FREE_RATE, iv, type),
    iv,
    T,
    midPrice,
    strike,
    expDate: contract.expiration_date,
    symbol:  contract.symbol,
    openInterest: parseInt(contract.open_interest || 0),
    volume: parseInt(contract.volume || 0),
  };
}

// Real-time bid/ask for specific OCC contract symbols (batched).
// Returns { [symbol]: { bid, ask, mid } }. Falls back gracefully — caller
// should treat a missing entry as DATA_INSUFFICIENT.
async function getOptionQuotes(symbols) {
  if (!symbols.length) return {};
  const out = {};
  // API caps symbols per request; chunk defensively at 50.
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    try {
      const res = await optionsDataApi.get('/options/quotes/latest', {
        params: { symbols: chunk.join(',') },
      });
      const quotes = res.data.quotes || {};
      for (const [sym, q] of Object.entries(quotes)) {
        const bid = parseFloat(q.bp), ask = parseFloat(q.ap);
        if (bid > 0 && ask > 0) out[sym] = { bid, ask, mid: (bid + ask) / 2 };
      }
    } catch (err) {
      console.error(`[marketdata] getOptionQuotes failed: ${err.response?.data?.message || err.message}`);
    }
  }
  return out;
}

module.exports = {
  isTradingOpen,
  getBars, ema, sma,
  getOptionsChain, calcDelta, getOptionQuotes,
};
