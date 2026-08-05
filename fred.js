/**
 * fred.js — real Fed funds rate + Treasury yield curve data from FRED
 * (Federal Reserve Economic Data, published by the St. Louis Fed). Free,
 * authoritative, government source — the actual published numbers, no
 * sentiment, no interpretation. Needs a free FRED_API_KEY (see .env.example
 * — sign up at https://fred.stlouisfed.org/docs/api/api_key.html).
 *
 * Currently informational only — surfaced in reports, not yet wired into
 * any sizing or veto decision.
 */
const axios = require('axios');
require('dotenv').config();

const api = axios.create({ baseURL: 'https://api.stlouisfed.org/fred' });

async function getSeriesLatest(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null; // not configured — caller treats this as DATA_INSUFFICIENT, never guesses a rate
  const res = await api.get('/series/observations', {
    params: { series_id: seriesId, api_key: key, file_type: 'json', sort_order: 'desc', limit: 5 },
  });
  // FRED marks missing/not-yet-published observations with "." — skip those
  // rather than parse a bogus number from them.
  const obs = (res.data.observations || []).filter(o => o.value !== '.');
  if (!obs.length) return null;
  return { date: obs[0].date, value: parseFloat(obs[0].value) };
}

// Effective Federal Funds Rate (daily series, real number, real date).
async function getFedFundsRate() {
  return getSeriesLatest('DFF');
}

// 10-Year minus 2-Year Treasury yield spread — the classic yield-curve
// recession-warning indicator. Negative = inverted.
async function getYieldCurveSpread() {
  return getSeriesLatest('T10Y2Y');
}

async function getMacroSnapshot() {
  const [fedFunds, yieldCurve] = await Promise.all([
    getFedFundsRate().catch(() => null),
    getYieldCurveSpread().catch(() => null),
  ]);
  return {
    fedFunds,
    yieldCurve,
    yieldCurveInverted: yieldCurve != null ? yieldCurve.value < 0 : null,
  };
}

module.exports = { getFedFundsRate, getYieldCurveSpread, getMacroSnapshot };
