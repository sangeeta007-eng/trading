/**
 * council/glance.js — rates the whole trading universe for the quick-view
 * table at the top of the daily report.
 *
 * WHY THIS EXISTS
 * The options engine only surfaces symbols that clear a deliberately narrow
 * dip trigger (Connors RSI(2) below its threshold while above the 200-day).
 * That is correct for deciding what to *buy*, but it means that on most days
 * the report showed nothing at all — 35 symbols scanned, a blank page, and no
 * way to tell "the market is fine, nothing is on sale today" apart from
 * "everything is falling apart". The whole picture was being thrown away to
 * show one narrow slice of it.
 *
 * The Government Stakes page already solved this: it rates every symbol it
 * tracks BUY / BUY ON DIP / HOLD / AVOID / SELL and puts that in one table at
 * the top, with the reasoning below. This applies the same treatment to the
 * trading universe.
 *
 * It deliberately imports rate/measure/groupByRating from govt/scan.js rather
 * than reimplementing them. Two independent definitions of what "BUY" means,
 * on two pages the same person reads on the same morning, would eventually
 * disagree — and the day they disagree is the day the tool stops being
 * trustworthy. One definition, used twice.
 */
const { measure, scoreSymbol, rate, groupByRating } = require('../govt/scan');
const { getSectors } = require('../govt/sectors');
const { DEFAULT_UNIVERSE, assetTypeOf } = require('./agent1_analyst');

async function buildGlance(universe = DEFAULT_UNIVERSE) {
  const etfs = [];
  const stocks = [];

  for (const symbol of universe) {
    let m;
    try {
      m = await measure(symbol);
    } catch (err) {
      // One symbol's data failing must not blank the whole table.
      etfs.push({ symbol, error: err.message, rating: 'NO DATA' });
      continue;
    }
    if (!m || m.error) {
      (assetTypeOf(symbol) === 'STOCK' ? stocks : etfs).push({ symbol, error: m?.error || 'no data', rating: 'NO DATA' });
      continue;
    }
    const { score, reasons } = scoreSymbol(m);
    const { rating, why } = rate(m, score);
    const row = { ...m, score, reasons, rating, why };
    (assetTypeOf(symbol) === 'STOCK' ? stocks : etfs).push(row);
  }

  // Sector exposure, same provider and disk cache the Government Stakes page
  // uses. Its own failure domain: a failed lookup leaves the column blank
  // rather than taking the table down.
  let sectors = new Map();
  try {
    const res = await getSectors([
      ...stocks.map(m => ({ symbol: m.symbol, kind: 'STOCK' })),
      ...etfs.map(m => ({ symbol: m.symbol, kind: 'ETF' })),
    ]);
    sectors = res.map;
  } catch { /* column degrades to "—" */ }

  const rated = [...etfs, ...stocks].filter(m => m.rating && m.rating !== 'NO DATA');
  const counts = {};
  for (const m of rated) counts[m.rating] = (counts[m.rating] || 0) + 1;

  return { etfs, stocks, sectors, counts, scanned: universe.length };
}

module.exports = { buildGlance, groupByRating };
