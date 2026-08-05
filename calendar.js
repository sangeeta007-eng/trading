/**
 * calendar.js — economic event calendar.
 *
 * FOMC/CPI/NFP dates below are real, verified dates for 2026 (pulled from
 * the Federal Reserve's published meeting calendar and the BLS release
 * schedule — see sources in the commit that added them). This list needs a
 * manual refresh once these get stale (roughly annually) — there's no live
 * feed for it, and none is needed: these dates are published a year ahead
 * by the Fed/BLS, so a periodic manual update is both sufficient and honest
 * (no fabricated "current" data pretending to be live).
 *
 * OPEX and Quad Witching are NOT in this list — they're pure calendar rules
 * (3rd Friday of the month / quarter) and are computed on demand instead,
 * so they never go stale.
 */

const HIGH_IMPACT_EVENTS = [
  // FOMC rate decisions (2nd day of each 2-day meeting) — federalreserve.gov/monetarypolicy/fomccalendars.htm
  { date: '2026-01-28', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-03-18', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-04-29', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-06-17', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-07-29', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-09-16', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-10-28', type: 'FOMC', label: 'FOMC Rate Decision' },
  { date: '2026-12-09', type: 'FOMC', label: 'FOMC Rate Decision' },

  // CPI (Consumer Price Index) — bls.gov/cpi/, 8:30 AM ET
  { date: '2026-01-13', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-02-13', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-03-11', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-04-10', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-05-12', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-06-10', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-07-14', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-08-12', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-09-11', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-10-14', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-11-10', type: 'CPI', label: 'CPI Inflation Report' },
  { date: '2026-12-10', type: 'CPI', label: 'CPI Inflation Report' },

  // NFP (Employment Situation / jobs report) — bls.gov/schedule/, 8:30 AM ET
  { date: '2026-01-09', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-02-11', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-03-06', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-04-03', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-05-08', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-06-05', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-07-02', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-08-07', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-09-04', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-10-02', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-11-06', type: 'NFP', label: 'Non-Farm Payrolls' },
  { date: '2026-12-04', type: 'NFP', label: 'Non-Farm Payrolls' },
];

function fmt(d) { return d.toISOString().split('T')[0]; }

// nth weekday of a given month (weekday: 0=Sun..6=Sat, n: 1-based)
function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, monthIndex, day));
}

// Monthly options expiration — 3rd Friday of every month.
function isOpex(date = new Date()) {
  const opex = nthWeekdayOfMonth(date.getUTCFullYear(), date.getUTCMonth(), 5, 3);
  return fmt(date) === fmt(opex);
}

// Quad witching — 3rd Friday of March, June, September, December.
function isQuadWitching(date = new Date()) {
  return [2, 5, 8, 11].includes(date.getUTCMonth()) && isOpex(date);
}

// Returns real calendar events (FOMC/CPI/NFP) within daysAhead of now, plus
// OPEX/quad-witching if either falls within that window (computed, not looked up).
function getUpcomingEvents(daysAhead = 1) {
  const now = new Date();
  const limit = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const today = fmt(now);
  const limitStr = fmt(limit);

  const events = HIGH_IMPACT_EVENTS.filter(e => e.date >= today && e.date <= limitStr);

  for (let d = new Date(now); d <= limit; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    if (isQuadWitching(d)) events.push({ date: fmt(d), type: 'QUAD_WITCHING', label: 'Quad Witching' });
    else if (isOpex(d)) events.push({ date: fmt(d), type: 'OPEX', label: 'Monthly Options Expiration' });
  }

  return events;
}

function isHighRiskWindow(daysAhead = 1) {
  return getUpcomingEvents(daysAhead).length > 0;
}

module.exports = { getUpcomingEvents, isHighRiskWindow, isOpex, isQuadWitching, HIGH_IMPACT_EVENTS };
