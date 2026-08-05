// Analytics — JSON-backed persistence for hypothetical P&L and IV history
const fs   = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');

// ── File helpers ──────────────────────────────────────────────────────────────

function loadAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8')); }
  catch { return defaultAnalytics(); }
}

function saveAnalytics(data) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
}

function defaultAnalytics() {
  const now = new Date().toISOString();
  return {
    weeklyPnL:  { startDate: now, realized: 0 },
    monthlyPnL: { startDate: now, realized: 0 },
    ivHistory: {},    // symbol → [{ date, iv }]
  };
}

// ── Weekly / Monthly P&L (hypothetical — see council/sync.js) ─────────────────

function getWeeklyPnL() {
  const data = loadAnalytics();
  const start = new Date(data.weeklyPnL.startDate);
  const now   = new Date();
  // Reset weekly on Monday
  if (now.getDay() === 1 && (now - start) > 24 * 60 * 60 * 1000) {
    data.weeklyPnL = { startDate: now.toISOString(), realized: 0 };
    saveAnalytics(data);
    return 0;
  }
  return data.weeklyPnL.realized;
}

function getMonthlyPnL() {
  const data = loadAnalytics();
  const start = new Date(data.monthlyPnL.startDate);
  const now   = new Date();
  if (now.getMonth() !== start.getMonth() || now.getFullYear() !== start.getFullYear()) {
    data.monthlyPnL = { startDate: now.toISOString(), realized: 0 };
    saveAnalytics(data);
    return 0;
  }
  return data.monthlyPnL.realized;
}

function addRealizedPnL(amount) {
  const data = loadAnalytics();
  data.weeklyPnL.realized  = (data.weeklyPnL.realized  || 0) + amount;
  data.monthlyPnL.realized = (data.monthlyPnL.realized || 0) + amount;
  saveAnalytics(data);
}

// ── IV history for IV Rank ────────────────────────────────────────────────────

function recordIV(symbol, iv) {
  const data  = loadAnalytics();
  if (!data.ivHistory[symbol]) data.ivHistory[symbol] = [];
  const today = new Date().toISOString().split('T')[0];
  data.ivHistory[symbol] = data.ivHistory[symbol].filter(r => r.date !== today);
  data.ivHistory[symbol].push({ date: today, iv });
  // Keep only 252 trading days (~1 year)
  if (data.ivHistory[symbol].length > 252) {
    data.ivHistory[symbol] = data.ivHistory[symbol].slice(-252);
  }
  saveAnalytics(data);
}

function getIVRank(symbol) {
  const data    = loadAnalytics();
  const history = (data.ivHistory[symbol] || []).map(r => r.iv);
  if (history.length < 10) return 50; // default mid-rank if insufficient data
  const current = history[history.length - 1];
  const low     = Math.min(...history);
  const high    = Math.max(...history);
  if (high === low) return 50;
  return ((current - low) / (high - low)) * 100;
}

// Callers that want to gate/veto on IV Rank need to know whether the value
// above is real (enough history) or the neutral 50 placeholder — otherwise
// a threshold check would be vetoing/allowing trades based on a fake number.
function getIVHistoryCount(symbol) {
  const data = loadAnalytics();
  return (data.ivHistory[symbol] || []).length;
}

module.exports = {
  loadAnalytics, saveAnalytics,
  getWeeklyPnL, getMonthlyPnL, addRealizedPnL,
  recordIV, getIVRank, getIVHistoryCount,
};
