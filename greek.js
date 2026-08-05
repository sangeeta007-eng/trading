// Black-Scholes Greeks — pure JS, no deps

// Abramowitz & Stegun approximation for normal CDF (max error 7.5e-8)
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - d * p : d * p;
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function _d1d2(S, K, T, r, sigma) {
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return { d1, d2: d1 - sigma * Math.sqrt(T) };
}

// Call or put price
function bsPrice(S, K, T, r, sigma, type = 'call') {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const { d1, d2 } = _d1d2(S, K, T, r, sigma);
  const disc = Math.exp(-r * T);
  return type === 'call'
    ? S * normCDF(d1) - K * disc * normCDF(d2)
    : K * disc * normCDF(-d2) - S * normCDF(-d1);
}

// Delta: 0–1 for calls, –1–0 for puts
function bsDelta(S, K, T, r, sigma, type = 'call') {
  if (T <= 0) {
    if (type === 'call') return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const { d1 } = _d1d2(S, K, T, r, sigma);
  return type === 'call' ? normCDF(d1) : normCDF(d1) - 1;
}

// Vega (sensitivity to 1% move in IV, in dollar terms per contract)
function bsVega(S, K, T, r, sigma) {
  if (T <= 0) return 0;
  const { d1 } = _d1d2(S, K, T, r, sigma);
  return S * Math.sqrt(T) * normPDF(d1);
}

// Newton-Raphson implied volatility from market option price
function impliedVol(marketPrice, S, K, T, r, type = 'call') {
  if (T <= 0 || marketPrice <= 0) return 0;
  const intrinsic = Math.max(0, type === 'call' ? S - K : K - S);
  if (marketPrice < intrinsic - 0.01) return 0;

  let sigma = 0.30;
  for (let i = 0; i < 200; i++) {
    const price = bsPrice(S, K, T, r, sigma, type);
    const vega  = bsVega(S, K, T, r, sigma);
    const diff  = marketPrice - price;
    if (Math.abs(diff) < 0.0001) break;
    if (Math.abs(vega) < 1e-10) { sigma += 0.01; continue; }
    sigma = sigma + diff / vega;
    sigma = Math.max(0.001, Math.min(sigma, 20));
  }
  return sigma;
}

// Annualized historical volatility from daily bar closes (returns decimal, e.g. 0.20 = 20%)
function historicalVol(bars, window = 30) {
  if (bars.length < window + 1) return 0.20;
  const recent = bars.slice(-(window + 1));
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i].c / recent[i - 1].c));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance * 252);
}

// Convert annualized HV to a VIX-like number (×100)
function hvToVixProxy(bars) {
  return historicalVol(bars, 30) * 100;
}

module.exports = { normCDF, normPDF, bsPrice, bsDelta, bsVega, impliedVol, historicalVol, hvToVixProxy };
