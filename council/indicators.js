/**
 * council/indicators.js — deterministic technical indicators computed from
 * real OHLCV bars. No LLM text completion is involved in any of these numbers.
 */
const { ema, sma } = require('../marketdata');

// Wilder's RSI
function rsi(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const closes = bars.map(b => b.c);
  let gains = 0, losses = 0;
  for (let i = 1; i <= n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / n, avgLoss = losses / n;
  for (let i = n + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Stochastic Oscillator %K (fast) and %D (3-period SMA of %K)
function stochastic(bars, n = 14, dPeriod = 3) {
  if (bars.length < n + dPeriod) return { k: null, d: null };
  const kValues = [];
  for (let i = n - 1; i < bars.length; i++) {
    const window = bars.slice(i - n + 1, i + 1);
    const high = Math.max(...window.map(b => b.h));
    const low  = Math.min(...window.map(b => b.l));
    const close = bars[i].c;
    kValues.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }
  const k = kValues[kValues.length - 1];
  const dSlice = kValues.slice(-dPeriod);
  const d = dSlice.reduce((s, v) => s + v, 0) / dSlice.length;
  return { k, d };
}

function ema9(bars) { return ema(bars, 9); }
function ema21(bars) { return ema(bars, 21); }

// Wilder's ADX(14) — trend strength, independent of direction.
// Used to avoid trading RSI/EMA signals in a directionless, choppy market.
function adx(bars, n = 14) {
  if (bars.length < n * 2 + 1) return null;

  const plusDM = [], minusDM = [], TR = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    TR.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    ));
  }

  function wilderSmooth(arr) {
    const out = [arr.slice(0, n).reduce((a, b) => a + b, 0)];
    for (let i = n; i < arr.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / n + arr[i]);
    return out;
  }

  const smTR = wilderSmooth(TR), smPlusDM = wilderSmooth(plusDM), smMinusDM = wilderSmooth(minusDM);
  const plusDI = smPlusDM.map((v, i) => (smTR[i] === 0 ? 0 : (100 * v) / smTR[i]));
  const minusDI = smMinusDM.map((v, i) => (smTR[i] === 0 ? 0 : (100 * v) / smTR[i]));
  const dx = plusDI.map((v, i) => {
    const sum = v + minusDI[i];
    return sum === 0 ? 0 : (100 * Math.abs(v - minusDI[i])) / sum;
  });

  if (dx.length < n) return null;
  let adxVal = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adxVal = (adxVal * (n - 1) + dx[i]) / n;
  return adxVal;
}

// Wilder's ATR(14) — average true range, in the underlying's own price
// units (dollars). Used to size targets/stops to each symbol's actual
// volatility instead of a flat percentage that treats a sleepy utility ETF
// the same as a volatile semiconductor one.
function atr(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const TR = [];
  for (let i = 1; i < bars.length; i++) {
    TR.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    ));
  }
  let val = TR.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < TR.length; i++) val = (val * (n - 1) + TR[i]) / n;
  return val;
}

module.exports = { rsi, stochastic, ema9, ema21, sma, adx, atr };
