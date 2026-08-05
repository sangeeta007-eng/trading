/**
 * Agent 1 — Market & Technical Analyst ("The Strategist")
 *
 * Scans the liquid ETF universe and determines directional bias using only
 * real OHLCV bars pulled from the market data provider — no guessed prices or indicators.
 *
 * Bullish Call Setup: Price > 21 EMA AND 45 < RSI < 65 AND ADX >= trend-strength floor
 * Bearish Put Setup:  Price < 21 EMA AND 35 < RSI < 55 AND ADX >= trend-strength floor
 * Otherwise: NEUTRAL / NO TRADE
 *
 * Any non-neutral daily signal is then checked against the weekly trend
 * (weekly close vs. 10-week EMA) — a daily setup the weekly trend
 * contradicts is downgraded back to NEUTRAL. A single timeframe is a much
 * weaker read than two agreeing ones.
 *
 * A preliminary 0-100 conviction score (RSI centering + trend separation +
 * ADX) is also computed here, purely from real technicals, so the council
 * can process the strongest setups first instead of a fixed symbol order.
 * Agent 3 folds in IV-based factors afterward for final position sizing.
 *
 * Sector relative strength: before scoring individual symbols, every ETF in
 * the universe is ranked by trailing-month return relative to SPY. A CALL
 * setup is only kept if that symbol is in the top half of the ranking
 * (a real leader, not just "up") — a PUT setup only if it's in the bottom
 * half (a real laggard). "QQQ looks bullish" isn't the same as "QQQ is
 * actually where the money is rotating to."
 */
const { getBars, ema } = require('../marketdata');
const { historicalVol } = require('../greek');
const { rsi, stochastic, ema9, ema21, adx } = require('./indicators');
const analytics = require('../analytics');

// Liquid ETF universe — broad market, sectors, and macro hedges with deep,
// reliably tight options markets (carried over from the retired advisor bot's
// vetted allowlist). VXX is excluded — it's a regime signal, not traded.
const DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'MDY',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLU', 'XLP', 'XLY', 'XLB',
  'GLD', 'TLT', 'SLV', 'USO', 'UNG',
  'SOXX', 'SMH',
];

const ADX_MIN_TREND = 18; // below this, treat the market as too choppy/directionless to trade
const RS_LOOKBACK_DAYS = 21; // ~1 trading month

// Ranks every symbol in the universe by trailing-month return relative to
// SPY. Returns { [symbol]: percentile }, where 100 = strongest relative
// performer, 0 = weakest. A symbol whose bars couldn't be fetched is simply
// left out of the ranking (not guessed into a percentile).
async function computeSectorRanking(universe) {
  const returns = {};
  for (const symbol of universe) {
    try {
      const bars = await getBars(symbol, '1Day', RS_LOOKBACK_DAYS + 1);
      if (bars.length >= 2) returns[symbol] = (bars[bars.length - 1].c - bars[0].c) / bars[0].c;
    } catch { /* leave this symbol out of the ranking rather than guess */ }
  }

  const spyReturn = returns['SPY'];
  if (spyReturn == null) return {}; // no benchmark, no ranking — don't fabricate one

  const relative = Object.entries(returns).map(([symbol, ret]) => [symbol, ret - spyReturn]);
  relative.sort((a, b) => b[1] - a[1]); // strongest first

  const percentile = {};
  relative.forEach(([symbol], i) => {
    percentile[symbol] = relative.length > 1 ? Math.round(100 * (1 - i / (relative.length - 1))) : 50;
  });
  return percentile;
}

function scoreCentering(value, center, halfWidth) {
  return Math.max(0, 100 - (Math.abs(value - center) / halfWidth) * 100);
}

function computeConviction({ rsi14, biasCenter, price, e21, adxVal }) {
  const rsiScore = scoreCentering(rsi14, biasCenter, 10);
  const sepPct = Math.abs(price - e21) / e21 * 100;
  const trendScore = Math.min(100, (sepPct / 3) * 100);
  const adxScore = adxVal == null ? 50 : Math.min(100, (adxVal / 40) * 100);
  return Math.round(rsiScore * 0.4 + trendScore * 0.3 + adxScore * 0.3);
}

async function analyze(symbol, sectorPercentile = null) {
  const bars = await getBars(symbol, '1Day', 60);
  if (bars.length < 30) {
    return { symbol, bias: 'NEUTRAL', vetoReason: 'DATA_INSUFFICIENT', reasonLines: [`Only ${bars.length} daily bars available (need 30+ for ADX).`] };
  }

  const price   = bars[bars.length - 1].c;
  const e9      = ema9(bars);
  const e21     = ema21(bars);
  const rsi14   = rsi(bars, 14);
  const stoch   = stochastic(bars, 14, 3);
  const adxVal  = adx(bars, 14);
  const hv      = historicalVol(bars, 30);
  const ivRank  = analytics.getIVRank(symbol);

  if (rsi14 === null || e21 === null) {
    return { symbol, bias: 'NEUTRAL', vetoReason: 'DATA_INSUFFICIENT', reasonLines: ['Indicators could not be computed from available bars.'] };
  }

  const trendOk = adxVal != null && adxVal >= ADX_MIN_TREND;
  let bias = 'NEUTRAL';
  if (price > e21 && rsi14 > 45 && rsi14 < 65 && trendOk) bias = 'CALL';
  else if (price < e21 && rsi14 < 55 && rsi14 > 35 && trendOk) bias = 'PUT';

  // Multi-timeframe confirmation: a daily-only signal is a much weaker read
  // than one the weekly trend agrees with. Only fetched when the daily
  // checks already found something — no point spending the API call on a
  // symbol that's already NEUTRAL.
  let weeklyLine = null;
  if (bias !== 'NEUTRAL') {
    const weeklyBars = await getBars(symbol, '1Week', 30);
    if (weeklyBars.length < 12) {
      weeklyLine = `Weekly Confirmation: only ${weeklyBars.length} weekly bars available — can't verify multi-timeframe agreement, downgrading to NEUTRAL rather than assume it.`;
      bias = 'NEUTRAL';
    } else {
      const weeklyClose = weeklyBars[weeklyBars.length - 1].c;
      const weeklyEma10 = ema(weeklyBars, 10);
      const weeklyTrendUp = weeklyClose > weeklyEma10;
      const agrees = (bias === 'CALL' && weeklyTrendUp) || (bias === 'PUT' && !weeklyTrendUp);
      weeklyLine = `Weekly Confirmation: weekly close $${weeklyClose.toFixed(2)} is ${weeklyTrendUp ? 'above' : 'below'} its 10-week EMA ($${weeklyEma10.toFixed(2)}) — ${agrees ? 'agrees with' : 'CONTRADICTS'} the daily signal.`;
      if (!agrees) bias = 'NEUTRAL';
    }
  }

  // Sector relative strength: only trade a symbol that's actually leading
  // (for calls) or lagging (for puts) the broad market, not just moving.
  let sectorLine = null;
  if (bias !== 'NEUTRAL' && sectorPercentile != null && sectorPercentile[symbol] != null) {
    const pct = sectorPercentile[symbol];
    const isLeader = pct >= 50;
    const qualifies = (bias === 'CALL' && isLeader) || (bias === 'PUT' && !isLeader);
    sectorLine = `Relative Strength: ${symbol} ranks in the ${pct}th percentile vs. SPY over the last ${RS_LOOKBACK_DAYS} trading days — ${qualifies ? 'a real' : 'NOT a'} ${bias === 'CALL' ? 'leader' : 'laggard'}.`;
    if (!qualifies) bias = 'NEUTRAL';
  }

  const conviction = bias === 'NEUTRAL' ? 0 : computeConviction({
    rsi14, biasCenter: bias === 'CALL' ? 55 : 45, price, e21, adxVal,
  });

  const reasonLines = [
    `Price Action: ${symbol} ($${price.toFixed(2)}) is ${price > e21 ? 'above' : 'below'} 21 EMA ($${e21.toFixed(2)})${e9 ? `, 9 EMA ($${e9.toFixed(2)})` : ''}.`,
    `Momentum: 14-day RSI is at ${rsi14.toFixed(1)}${stoch.k != null ? `, Stochastic %K ${stoch.k.toFixed(1)} / %D ${stoch.d.toFixed(1)}` : ''}.`,
    `Trend Strength: ADX(14) ${adxVal != null ? adxVal.toFixed(1) : 'n/a'} (${trendOk ? 'trending — tradable' : `below ${ADX_MIN_TREND} — too choppy to trade`}).`,
    `Volatility: IV Rank is at ${ivRank.toFixed(0)}%, 30d realized vol ${(hv * 100).toFixed(1)}%.`,
    ...(weeklyLine ? [weeklyLine] : []),
    ...(sectorLine ? [sectorLine] : []),
    `Decision: ${bias === 'CALL' ? `BULLISH BIAS (CALL) — conviction ${conviction}/100` : bias === 'PUT' ? `BEARISH BIAS (PUT) — conviction ${conviction}/100` : 'NO TRADE — setup criteria not met'}`,
  ];

  return { symbol, price, ema9: e9, ema21: e21, rsi: rsi14, stochastic: stoch, adx: adxVal, hv, ivRank, bias, conviction, reasonLines };
}

async function scanUniverse(universe = DEFAULT_UNIVERSE) {
  const sectorPercentile = await computeSectorRanking(universe);
  const results = [];
  for (const symbol of universe) {
    try {
      results.push(await analyze(symbol, sectorPercentile));
    } catch (err) {
      results.push({ symbol, bias: 'NEUTRAL', vetoReason: 'DATA_INSUFFICIENT', reasonLines: [`Agent 1 error: ${err.response?.data?.message || err.message}`] });
    }
  }
  return results;
}

module.exports = { analyze, scanUniverse, computeSectorRanking, DEFAULT_UNIVERSE, ADX_MIN_TREND };
