// Regime detection — VIX proxy from SPY 30-day historical volatility
const { getBars } = require('./marketdata');
const { hvToVixProxy } = require('./greek');
const { getRegimeByVix } = require('./config');

let _cachedRegime = null;
let _cacheTime    = 0;
const CACHE_TTL   = 60 * 60 * 1000; // refresh once per hour

async function getVIX() {
  // Primary: try VXX (VIX futures ETF available from the market data provider) as a rough proxy
  // Fallback: compute SPY 30-day realized volatility × 100
  try {
    const bars = await getBars('VXX', '1Day', 5);
    if (bars.length > 0) {
      const vxx = bars[bars.length - 1].c;
      // VXX ≈ VIX * ~0.9 at most market regimes; use as proxy
      // Scale so VXX 20 ≈ VIX 22 (empirical ratio ~1.1)
      return vxx * 1.1;
    }
  } catch {
    // VXX unavailable — fall through
  }

  // Fallback: SPY 30-day HV as VIX proxy
  const spyBars = await getBars('SPY', '1Day', 35);
  return hvToVixProxy(spyBars);
}

async function getRegime() {
  const now = Date.now();
  if (_cachedRegime && (now - _cacheTime) < CACHE_TTL) return _cachedRegime;

  const vix    = await getVIX();
  const regime = getRegimeByVix(vix);

  _cachedRegime = { ...regime, vix: parseFloat(vix.toFixed(2)) };
  _cacheTime    = now;

  console.log(`[regime] VIX proxy: ${vix.toFixed(1)} → ${regime.name} | Sizing: ${(regime.sizingMod * 100).toFixed(0)}%`);
  return _cachedRegime;
}

// Weekly drawdown as % of total budget (used by Rachel's circuit breaker)
function getWeeklyDrawdownPct(weeklyPnL, totalBudget) {
  return Math.abs(Math.min(0, weeklyPnL)) / totalBudget;
}

module.exports = { getRegime, getVIX, getWeeklyDrawdownPct };
