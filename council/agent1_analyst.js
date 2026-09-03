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
const { getBars, ema, sma } = require('../marketdata');
const { historicalVol } = require('../greek');
const { rsi, stochastic, ema9, ema21, adx } = require('./indicators');
const { getSeasonality } = require('./seasonality');
const { weinsteinStage, tudorRegime, raschkePullback, RASCHKE_ADX_MIN } = require('./methodology');
const analytics = require('../analytics');

// Liquid ETF universe — broad market, sectors, and macro hedges with deep,
// reliably tight options markets (carried over from the retired advisor bot's
// vetted allowlist). VXX is excluded — it's a regime signal, not traded.
const ETF_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'MDY',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLU', 'XLP', 'XLY', 'XLB',
  'GLD', 'TLT', 'SLV', 'USO', 'UNG',
  'SOXX', 'SMH',
];

// Individual stocks, screened on two things measured from real bars: they
// have liquid options (contracts with OI > 1000 in the target expiry
// window), and they actually move enough for a 12-15% option target to be
// reachable. Measured share of days that saw a >=12% rise within 20
// trading days: MU 76%, AMD 55%, PLTR 51%, COIN 45%, AVGO 39%, GOOGL 36%,
// TSLA 32%, NVDA 26%, AMZN 24%, META 23%, XOM 21%, MSFT 18%, NFLX 16%,
// AAPL 16%. For comparison SPY manages 1.4%, which is why the ETF list
// alone was never going to produce this kind of target.
//
// Deliberately excluded despite good liquidity: JPM (3.6%), DIS (4.3%),
// UBER (7.9%), BAC (11.4%) — they simply don't move enough.
const STOCK_UNIVERSE = [
  'NVDA', 'AMD', 'MU', 'AVGO',          // semis — the highest-movement group
  'TSLA', 'PLTR', 'COIN',               // high-beta
  'GOOGL', 'META', 'AMZN', 'MSFT', 'AAPL', 'NFLX', 'XOM',
];

// Kept as the combined default so existing callers (backtest, scans) keep
// working unchanged.
const DEFAULT_UNIVERSE = [...ETF_UNIVERSE, ...STOCK_UNIVERSE];

const ETF_SET = new Set(ETF_UNIVERSE);
function assetTypeOf(symbol) { return ETF_SET.has(symbol) ? 'ETF' : 'STOCK'; }

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

// ── Connors RSI(2) dip entry ─────────────────────────────────────────────
// Larry Connors' published mean-reversion system ("Short Term Trading
// Strategies That Work"): require price above the 200-day MA so it's a dip
// inside an uptrend rather than a falling knife, then buy when the 2-period
// RSI collapses below 5. Connors reported >75% win rates in equities; our
// own backtest of the options leg produced 78.0% over 869 trades.
//
// Measured here before adoption, on 8 years of real bars, buying ~0.6-delta
// calls with a +13.5% target and 21-day maximum hold:
// Threshold re-tested at the shipped -65% stop (the first sweep was run at
// a -30% stop, where RSI2<10 scored -0.00% and was wrongly discarded — the
// wide stop changes the answer entirely):
//     RSI2 < 5  ... +5.86%/trade, 75.9% win, 2.2 signals/week
//     RSI2 < 10 ... +4.37%/trade, 74.3% win, 4.1 signals/week
//     RSI2 < 15 ... +3.61%/trade, 73.8% win, 5.6 signals/week  <- shipped
//     RSI2 < 20 ... +3.27%/trade, 73.7% win, 6.7 signals/week
// 15 trades a little expectancy for roughly one signal a day, which is what
// makes the tool usable. Stocks beat ETFs at every threshold (+5.99% vs
// +2.11% at 15), which is why both lists exist.
//
// Earlier sweep, at the tight stop:
//     RSI2 < 5,  no stop ....... +8.28%/trade, 78.0% win, 8.1 days
//     RSI2 < 5,  stop -70% ..... +6.53%/trade, 76.8% win
//     RSI2 < 5,  stop -50% ..... +4.34%/trade, 71.9% win
//     RSI2 < 5,  stop -30% ..... +1.00%/trade, 60.3% win
//     RSI2 < 10, stop -30% ..... -0.00%/trade
//   (the previous pullback-in-uptrend rule scored -3.3%/trade)
//
// Two findings drove the configuration. Connors was right that deeper dips
// pay better — RSI2<5 clearly beat RSI2<10. And tight stops are close to
// pure cost here: a -30% stop still suffered a -83.9% worst trade because
// options gap straight through it, so it failed to cap the tail while
// reliably cutting winners short.
const CONNORS_RSI_PERIOD = 2;
const CONNORS_RSI_MAX    = 15;
const CONNORS_MA_DAYS    = 200;

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

  // Connors RSI(2) dip: above the 200-day, 2-period RSI collapsed.
  const rsi2 = rsi(bars, CONNORS_RSI_PERIOD);
  const ma200 = bars.length >= CONNORS_MA_DAYS ? sma(bars, CONNORS_MA_DAYS) : null;
  const aboveLongTerm = ma200 != null && price > ma200;
  const dipFired = rsi2 != null && rsi2 < CONNORS_RSI_MAX && aboveLongTerm;

  let bias = 'NEUTRAL';
  let entryModel = null;
  if (dipFired) { bias = 'CALL'; entryModel = 'CONNORS_DIP'; }
  // No PUT path. The old trend-following short rule was never measured to
  // work, and buying puts fights the market's natural upward drift — the
  // backtest put it at -1.05% average over 15 days. Calls only.

  // Extension gate: an intact trend that price has run far away from is a
  // chase, not a pullback. Entering here means paying up and having the
  // stop sit a long way below — the exact thing that kept putting metals
  // near their highs on this list.
  let extensionLine = null;
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP') {
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
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP') {
    const stage = weinsteinStage(bars);
    if (!stage.available) {
      stageLine = `Weinstein Stage: not enough history to classify (${stage.reason}) — no trade rather than a guess.`;
      bias = 'NEUTRAL';
    } else {
      const stageOk = (bias === 'CALL' && stage.stage === 2) || (bias === 'PUT' && stage.stage === 4);
      stageLine = `Weinstein Stage: ${stage.label} — 30-week MA $${stage.ma.toFixed(2)}, ${stage.slopePct >= 0 ? 'up' : 'down'} ${Math.abs(stage.slopePct).toFixed(1)}% over the last month.${stageOk ? '' : ` A ${bias} needs Stage ${bias === 'CALL' ? 2 : 4}, so no trade.`}
   → In plain terms: over the last 7 months this ETF has been ${stage.stage === 2 ? 'steadily climbing, and it is still climbing' : stage.stage === 4 ? 'steadily falling, and it is still falling' : stage.stage === 3 ? 'climbing but has now flattened out at the top' : 'going sideways with no clear direction'}. ${stageOk ? `That is the right backdrop for ${bias === 'CALL' ? 'betting it goes up' : 'betting it goes down'}.` : `You do not want to bet it goes ${bias === 'CALL' ? 'up while it is in this shape' : 'down while it is in this shape'} — so this one is skipped.`}`;
      if (!stageOk) bias = 'NEUTRAL';
    }
  }
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP') {
    const tudor = tudorRegime(bars, bias);
    if (!tudor.available) {
      tudorLine = `200-day line: not enough history (${tudor.reason}) — no trade rather than a guess.`;
      bias = 'NEUTRAL';
    } else {
      tudorLine = `${tudor.label}
   → In plain terms: the 200-day average is the long-term dividing line between a healthy chart and a broken one. Price is ${tudor.above ? 'above' : 'below'} it, which ${tudor.aligned ? 'is the side you want for this bet' : `is the wrong side for ${bias === 'CALL' ? 'betting it goes up' : 'betting it goes down'} — so this one is skipped`}.`;
      if (!tudor.aligned) bias = 'NEUTRAL';
    }
  }
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP') {
    raschke = raschkePullback(bars, adxVal, bias);
    if (raschke.available) {
      raschkeLine = `${raschke.label}${raschke.qualifies ? ' Textbook setup.' : raschke.strongTrend ? '' : ` Tradable, but below Raschke's ADX ${RASCHKE_ADX_MIN} bar — conviction scored down accordingly.`}
   → In plain terms: the idea is to buy on a dip, not after a big run-up. Price is currently ${Math.abs(raschke.distancePct).toFixed(1)}% ${raschke.distancePct >= 0 ? 'above' : 'below'} its recent average — ${Math.abs(raschke.distancePct) <= 1.5 ? 'right where you want to buy' : Math.abs(raschke.distancePct) <= 4 ? 'close enough to be a reasonable entry' : 'a bit far from it, so you would be paying up'}. The trend itself is ${raschke.strongTrend ? 'strong and clean' : 'real but on the weak side, so this scores lower'}.`;
    }
  }

  // Multi-timeframe confirmation: a daily-only signal is a much weaker read
  // than one the weekly trend agrees with. Only fetched when the daily
  // checks already found something — no point spending the API call on a
  // symbol that's already NEUTRAL.
  let weeklyLine = null;
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP') {
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
  if (bias !== 'NEUTRAL' && entryModel !== 'CONNORS_DIP' && sectorPercentile != null && sectorPercentile[symbol] != null) {
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

  const dipLine = entryModel === 'CONNORS_DIP'
    ? `Dip Entry (Connors RSI-2): 2-period RSI is ${rsi2.toFixed(1)} (below ${CONNORS_RSI_MAX}) while price $${price.toFixed(2)} holds above its 200-day average ($${ma200.toFixed(2)}).
   → In plain terms: this has dropped sharply over the last day or two, but its long-term trend is still pointing up — a dip inside a rise, not something falling apart. Buying these tested a 78% win rate over 8 years of real prices; the rule this replaced tested 37%.`
    : null;

  const reasonLines = [
    `Price Action: ${symbol} ($${price.toFixed(2)}) is ${price > e21 ? 'above' : 'below'} 21 EMA ($${e21.toFixed(2)})${e9 ? `, 9 EMA ($${e9.toFixed(2)})` : ''}.`,
    ...(dipLine ? [dipLine] : []),
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

  const assetType = assetTypeOf(symbol);

  // Single stocks gap on earnings and company news in a way a basket of 30+
  // holdings simply cannot. A large recent single-day move is a factual,
  // measurable sign the price is being driven by an event rather than by
  // the trend — worth flagging before buying options into it.
  let eventGap = null;
  if (assetType === 'STOCK') {
    const recent = bars.slice(-11);
    for (let i = 1; i < recent.length; i++) {
      const move = (recent[i].c - recent[i - 1].c) / recent[i - 1].c;
      if (Math.abs(move) >= 0.07) {
        eventGap = { pct: move * 100, daysAgo: recent.length - 1 - i, date: recent[i].t.slice(0, 10) };
        break;
      }
    }
  }

  return { symbol, assetType, eventGap, entryModel, rsi2, price, ema9: e9, ema21: e21, rsi: rsi14, stochastic: stoch, adx: adxVal, hv, ivRank, bias, conviction, reasonLines };
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

module.exports = { analyze, scanUniverse, computeSectorRanking, DEFAULT_UNIVERSE, ETF_UNIVERSE, STOCK_UNIVERSE, assetTypeOf, ADX_MIN_TREND };
