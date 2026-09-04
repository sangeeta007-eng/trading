/**
 * govt/sectors.js — sector exposure for the tracked universe.
 *
 * The market-data provider (marketdata.js / Alpaca) serves prices and option
 * chains only; it has no concept of what a fund holds or what business a
 * company is in. So this is a genuinely separate source, and it is kept in
 * its own file rather than smuggled into marketdata.js, which is documented
 * as the single provider-aware module for PRICES.
 *
 * Source: Yahoo Finance's quoteSummary endpoint (no key, but unofficial and
 * crumb-gated). Two consequences drive the design here:
 *
 *   1. It can break or rate-limit without notice, so everything is cached to
 *      disk and a failed refresh falls back to the cache. Sector weights move
 *      slowly — a fund does not change what it holds hour to hour — so a
 *      multi-day TTL costs nothing in accuracy and removes ~29 network calls
 *      from most refreshes.
 *   2. Nothing here is ever estimated. If a symbol has no data, it renders as
 *      unavailable rather than as a plausible-looking guess. Invented sector
 *      percentages on a page that also says BUY would be worse than a blank.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_PATH = path.join(__dirname, 'sectors-cache.json');
const TTL_DAYS = 7;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// Yahoo's sector keys are snake_case and a couple are plain odd ("realestate").
const SECTOR_LABEL = {
  technology: 'Technology',
  basic_materials: 'Materials',
  industrials: 'Industrials',
  healthcare: 'Healthcare',
  financial_services: 'Financials',
  energy: 'Energy',
  utilities: 'Utilities',
  consumer_cyclical: 'Consumer Cyclical',
  consumer_defensive: 'Consumer Staples',
  communication_services: 'Communications',
  realestate: 'Real Estate',
};

function label(key) {
  return SECTOR_LABEL[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return { entries: {} }; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function isFresh(entry) {
  if (!entry || !entry.fetchedAt) return false;
  return (Date.now() - new Date(entry.fetchedAt)) < TTL_DAYS * 86400000;
}

// ── Yahoo session ───────────────────────────────────────────────────────────
// The endpoint requires a cookie plus a matching "crumb"; one session is
// established per run and reused for every symbol.

async function openSession() {
  const jar = await axios.get('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA }, timeout: 15000, validateStatus: () => true,
  });
  const cookie = (jar.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const crumb = (await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }, timeout: 15000,
  })).data;
  if (!crumb || typeof crumb !== 'string' || crumb.length > 40) throw new Error('could not obtain a Yahoo crumb');
  return { cookie, crumb };
}

async function fetchModule(session, symbol, module) {
  const res = await axios.get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}`, {
    params: { modules: module, crumb: session.crumb },
    headers: { 'User-Agent': UA, Cookie: session.cookie },
    timeout: 20000,
  });
  const result = res.data?.quoteSummary?.result;
  return result && result[0] ? result[0][module] : null;
}

// ── Public shape ────────────────────────────────────────────────────────────

async function fetchEtf(session, symbol) {
  const t = await fetchModule(session, symbol, 'topHoldings');
  if (!t) return null;

  const sectors = (t.sectorWeightings || [])
    .map(o => {
      const key = Object.keys(o)[0];
      const raw = o[key] && o[key].raw;
      return { key, name: label(key), pct: raw != null ? raw * 100 : null };
    })
    // Drop the zero rows Yahoo pads every fund with — a list of eleven
    // sectors that are nine 0.00% entries communicates nothing.
    .filter(s => s.pct != null && s.pct > 0.05)
    .sort((a, b) => b.pct - a.pct);

  const holdings = (t.holdings || [])
    .map(h => ({ symbol: h.symbol, name: h.holdingName, pct: h.holdingPercent?.raw != null ? h.holdingPercent.raw * 100 : null }))
    .filter(h => h.pct != null);

  return { type: 'ETF', sectors, holdings, fetchedAt: new Date().toISOString() };
}

async function fetchStock(session, symbol) {
  const p = await fetchModule(session, symbol, 'assetProfile');
  if (!p || (!p.sector && !p.industry)) return null;
  return { type: 'STOCK', sector: p.sector || null, industry: p.industry || null, fetchedAt: new Date().toISOString() };
}

/**
 * Resolve sector data for a list of {symbol, kind} entries.
 * Returns a Map keyed by symbol. Never throws: on any failure the cached
 * value is used, and a symbol with neither is simply absent from the map,
 * which the page renders as "not available".
 */
async function getSectors(entries) {
  const cache = loadCache();
  const out = new Map();
  const stale = [];

  for (const e of entries) {
    const hit = cache.entries[e.symbol];
    if (isFresh(hit)) out.set(e.symbol, hit);
    else stale.push(e);
  }

  if (!stale.length) return { map: out, fetched: 0, error: null, fromCache: out.size };

  let session;
  try { session = await openSession(); }
  catch (err) {
    // No session: serve whatever is cached, however old, and say so.
    for (const e of stale) if (cache.entries[e.symbol]) out.set(e.symbol, cache.entries[e.symbol]);
    return { map: out, fetched: 0, error: `Yahoo session failed (${err.message}) — using cached sector data`, fromCache: out.size };
  }

  let fetched = 0;
  let error = null;
  for (const e of stale) {
    try {
      const data = e.kind === 'ETF' ? await fetchEtf(session, e.symbol) : await fetchStock(session, e.symbol);
      if (data) { cache.entries[e.symbol] = data; out.set(e.symbol, data); fetched++; }
      else if (cache.entries[e.symbol]) out.set(e.symbol, cache.entries[e.symbol]);
    } catch (err) {
      error = err.response?.status ? `Yahoo returned ${err.response.status}` : err.message;
      if (cache.entries[e.symbol]) out.set(e.symbol, cache.entries[e.symbol]);
    }
  }

  cache.lastRun = new Date().toISOString();
  try { saveCache(cache); } catch { /* a read-only FS must not fail the page */ }

  return { map: out, fetched, error, fromCache: out.size - fetched };
}

module.exports = { getSectors, SECTOR_LABEL, TTL_DAYS };
