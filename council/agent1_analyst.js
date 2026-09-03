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
const { getSeasonality } = require('./seasonality');
const { weinsteinStage, tudorRegime, raschkePullback, RASCHKE_ADX_MIN } = require('./methodology');
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

// Pullback-within-trend entry model. The trend still has to be intact (price
// on the right side of the 21 EMA, ADX above the chop floor, weekly timeframe
// agreeing) — but the *entry* is timed to a pullback toward that trend line
// rather than a chase after an extended move.
//
// This deliberately inverts the previous conviction formula, which scored
// `separation from the 21 EMA` as a positive and maxed out at 3% extended.
// That rewarded buying whatever had already run hardest, which is how the
// report kept surfacing metals near their highs.
const IDEAL_EXTENSION_PCT = 4;  // at the EMA = best entry; 4%+ away = no credit
const MAX_EXTENSION_PCT   = 8;  // beyond this it's a chase, not a pullback — no trade

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

// 0-100 conviction, weighted toward a good entry price rather than a strong
// recent move. Every component is computed from real bars or real IV history
// — nothing here is a sentiment guess.
function computeConviction({ rsi14, biasCenter, price, e21, adxVal, ivRank, ivSampleReal }) {
  // Entry quality (35%) — how close price sits to the trend line it pulled
  // back to. At the 21 EMA scores 100; IDEAL_EXTENSION_PCT away scores 0.
  const sepPct = Math.abs(price - e21) / e21 * 100;
  const pullbackScore = Math.max(0, 100 - (sepPct / IDEAL_EXTENSION_PCT) * 100);

  // Momentum reset (25%) — centered on a neutral RSI, because a pullback in
  // an uptrend (or a bounce in a downtrend) shows momentum cooling back to
  // the middle, not pinned at an extreme.
  const rsiScore = scoreCentering(rsi14, biasCenter, 10);

  // Trend strength (25%) — the trend being pulled back into must be real.
  // Scaled so Raschke's ADX 30 threshold is full marks; anything under it
  // scores proportionally less rather than being silently accepted.
  const adxScore = adxVal == null ? 50 : Math.min(100, (adxVal / RASCHKE_ADX_MIN) * 100);

  // Premium cheapness (15%) — desks buy volatility when it's cheap relative
  // to its own history, not when it's rich. Only counted when there's a real
  // IV sample behind the rank; otherwise neutral, so the placeholder 50 can
  // never inflate or depress conviction on its own.
  const ivScore = ivSampleReal ? Math.max(0, 100 - ivRank) : 50;

  return Math.round(pullbackScore * 0.35 + rsiScore * 0.25 + adxScore * 0.25 + ivScore * 0.15);
}

async function analyze(symbol, sectorPercentile = null) {
  // 260 bars ~= 1 trading year: enough for Weinstein's 30-week MA and its
  // slope, and for the 200-day line. Every shorter indicator is computed
  // from the same fetch.
  const bars = await getBars(symbol, '1Day', 260);
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
  const extensionPct = Math.abs(price - e21) / e21 * 100;
  let bias = 'NEUTRAL';
  if (price > e21 && rsi14 > 45 && rsi14 < 65 && trendOk) bias = 'CALL';
  else if (price < e21 && rsi14 < 55 && rsi14 > 35 && trendOk) bias = 'PUT';

  // Extension gate: an intact trend that price has run far away from is a
  // chase, not a pullback. Entering here means paying up and having the
  // stop sit a long way below — the exact thing that kept putting metals
  // near their highs on this list.
  let extensionLine = null;
  if (bias !== 'NEUTRAL') {
    if (extensionPct > MAX_EXTENSION_PCT) {
      extensionLine = `Entry Quality: price is ${extensionPct.toFixed(1)}% from its 21 EMA — beyond the ${MAX_EXTENSION_PCT}% chase limit. The trend is real but this is not a pullback entry, so no trade.`;
      bias = 'NEUTRAL';
    } else {
      extensionLine = `Entry Quality: price is ${extensionPct.toFixed(1)}% from its 21 EMA (${extensionPct <= 1.5 ? 'right at the trend line — prime pullback entry' : extensionPct <= IDEAL_EXTENSION_PCT ? 'near the trend line — reasonable entry' : `stretched, ${MAX_EXTENSION_PCT}% is the chase limit`}).`;
    }
  }

  // ── Published methodology gates (see council/methodology.js) ────────────
  // Weinstein decides whether the symbol is in a tradable stage at all;
  // Tudor Jones's 200-day decides whether the direction is on the right
  // side of the long-term line. Both are hard gates — they are the whole
  // point of using a defined method rather than reacting to a chart.
  let stageLine = null, tudorLine = null, raschke = null, raschkeLine = null;
  if (bias !== 'NEUTRAL') {
    const stage = weinsteinStage(bars);
    if (!stage.available) {
      stageLine = `Weinstein Stage: not enough history to classify (${stage.reason}) — no trade rather than a guess.`;
      bias = 'NEUTRAL';
    } else {
      const stageOk = (bias === 'CALL' && stage.stage === 2) || (bias === 'PUT' && stage.stage === 4);
      stageLine = `Weinstein Stage: ${stage.label} — 30-week MA $${stage.ma.toFixed(2)}, ${stage.slopePct >= 0 ? 'up' : 'down'} ${Math.abs(stage.slopePct).toFixed(1)}% over the last month.${stageOk ? '' : ` A ${bias} needs Stage ${bias === 'CALL' ? 2 : 4}, so no trade.`}`;
      if (!stageOk) bias = 'NEUTRAL';
    }
  }
  if (bias !== 'NEUTRAL') {
    const tudor = tudorRegime(bars, bias);
    if (!tudor.available) {
      tudorLine = `200-day line: not enough history (${tudor.reason}) — no trade rather than a guess.`;
      bias = 'NEUTRAL';
    } else {
      tudorLine = tudor.label;
      if (!tudor.aligned) bias = 'NEUTRAL';
    }
  }
  if (bias !== 'NEUTRAL') {
    raschke = raschkePullback(bars, adxVal, bias);
    if (raschke.available) {
      raschkeLine = `${raschke.label}${raschke.qualifies ? ' Textbook setup.' : raschke.strongTrend ? '' : ` Tradable, but below Raschke's ADX ${RASCHKE_ADX_MIN} bar — conviction scored down accordingly.`}`;
    }
  }

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

  // Seasonality: informational only, never a veto — a single real historical
  // pattern shouldn't override a live technical + relative-strength setup,
  // but it's useful context. Only fetched once the setup has already
  // survived every other check (this needs ~10 years of daily bars per
  // symbol, real but not cheap — no point spending that API cost on a
  // symbol that's already NEUTRAL).
  let seasonalityLine = null;
  if (bias !== 'NEUTRAL') {
    const season = await getSeasonality(symbol);
    if (season.available) {
      const favorable = (bias === 'CALL' && season.avgReturn > 0) || (bias === 'PUT' && season.avgReturn < 0);
      seasonalityLine = `Seasonality: ${symbol} has averaged ${(season.avgReturn * 100).toFixed(1)}% in ${season.month} over the last ${season.sampleYears} years (up in ${season.winCount}/${season.sampleYears}) — ${favorable ? 'agrees with' : 'runs counter to'} this ${bias} bias. Historical pattern, not a filter — shown for context only.`;
    } else {
      seasonalityLine = `Seasonality: not enough real history to compute (${season.reason})`;
    }
  }

  // A pullback is momentum cooling back toward neutral, so both directions
  // score best around a mid-range RSI — not pinned at an extreme.
  const ivSampleReal = analytics.getIVHistoryCount(symbol) >= 10;
  const conviction = bias === 'NEUTRAL' ? 0 : computeConviction({
    rsi14, biasCenter: 50, price, e21, adxVal, ivRank, ivSampleReal,
  });

  const reasonLines = [
    `Price Action: ${symbol} ($${price.toFixed(2)}) is ${price > e21 ? 'above' : 'below'} 21 EMA ($${e21.toFixed(2)})${e9 ? `, 9 EMA ($${e9.toFixed(2)})` : ''}.`,
    ...(extensionLine ? [extensionLine] : []),
    `Momentum: 14-day RSI is at ${rsi14.toFixed(1)}${stoch.k != null ? `, Stochastic %K ${stoch.k.toFixed(1)} / %D ${stoch.d.toFixed(1)}` : ''}.`,
    `Trend Strength: ADX(14) ${adxVal != null ? adxVal.toFixed(1) : 'n/a'} (${trendOk ? 'trending — tradable' : `below ${ADX_MIN_TREND} — too choppy to trade`}).`,
    `Volatility: IV Rank is at ${ivRank.toFixed(0)}%${ivSampleReal ? ' (real — scored into conviction; cheaper premium ranks higher)' : ' (placeholder — under 10 days of IV history, so it is NOT scored into conviction)'}, 30d realized vol ${(hv * 100).toFixed(1)}%.`,
    ...(stageLine ? [stageLine] : []),
    ...(tudorLine ? [tudorLine] : []),
    ...(raschkeLine ? [raschkeLine] : []),
    ...(weeklyLine ? [weeklyLine] : []),
    ...(sectorLine ? [sectorLine] : []),
    ...(seasonalityLine ? [seasonalityLine] : []),
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
