/**
 * council/seasonality.js — real historical seasonality, computed directly
 * from real daily bars (via marketdata.js's getBars). No estimate, no
 * "typically" claim from training knowledge — every number here is
 * literally averaged from that symbol's own real price history.
 *
 * For the current calendar month, computes each historical year's actual
 * return (first trading day's open to last trading day's close) for that
 * month, then averages across years. A year's month is only counted if it
 * has enough trading days to be a real, complete month — the in-progress
 * current year's current month is naturally excluded since it isn't
 * complete yet.
 */
const { getBars } = require('../marketdata');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const YEARS_LOOKBACK = 10;
const MIN_TRADING_DAYS_FOR_COMPLETE_MONTH = 10; // below this, treat as a partial month (holiday-shortened months still clear this easily)
const MIN_YEARS_REQUIRED = 5; // fewer than this and a month-average isn't a meaningful sample

async function getSeasonality(symbol, referenceDate = new Date()) {
  // ~10 years of daily bars, padded generously — getBars trims to the most
  // recent N after paginating the full requested range.
  const bars = await getBars(symbol, '1Day', Math.ceil(YEARS_LOOKBACK * 260));
  if (bars.length < 260 * MIN_YEARS_REQUIRED) {
    return { available: false, reason: `Only ${bars.length} daily bars available — need several years of real history for a meaningful seasonal average.` };
  }

  const targetMonth = referenceDate.getMonth();

  // Group bars by (year, month)
  const byYearMonth = new Map();
  for (const bar of bars) {
    const d = new Date(bar.t);
    if (d.getMonth() !== targetMonth) continue;
    const year = d.getFullYear();
    if (!byYearMonth.has(year)) byYearMonth.set(year, []);
    byYearMonth.get(year).push(bar);
  }

  const currentYear = referenceDate.getFullYear();
  const yearReturns = [];
  for (const [year, monthBars] of byYearMonth) {
    if (year === currentYear) continue; // in-progress month, not a completed real sample
    if (monthBars.length < MIN_TRADING_DAYS_FOR_COMPLETE_MONTH) continue; // listing gap / partial data, not a real complete month
    monthBars.sort((a, b) => new Date(a.t) - new Date(b.t));
    const openPrice = monthBars[0].o;
    const closePrice = monthBars[monthBars.length - 1].c;
    yearReturns.push({ year, return: (closePrice - openPrice) / openPrice });
  }

  if (yearReturns.length < MIN_YEARS_REQUIRED) {
    return { available: false, reason: `Only ${yearReturns.length} complete historical ${MONTH_NAMES[targetMonth]}s found in real data — need at least ${MIN_YEARS_REQUIRED} for a meaningful average.` };
  }

  const avgReturn = yearReturns.reduce((s, y) => s + y.return, 0) / yearReturns.length;
  const winCount = yearReturns.filter(y => y.return > 0).length;
  const winRate = winCount / yearReturns.length;

  return {
    available: true,
    month: MONTH_NAMES[targetMonth],
    sampleYears: yearReturns.length,
    years: yearReturns.map(y => y.year),
    avgReturn, winRate, winCount,
  };
}

module.exports = { getSeasonality, MONTH_NAMES };
