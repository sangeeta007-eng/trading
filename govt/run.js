/**
 * govt/run.js — regenerates report/govt.html.
 *
 * Entry point for all three refresh paths, so they cannot drift apart:
 *   npm run govt                   (manual, local)
 *   the Refresh button on the page (server.js -> /api/govt/refresh)
 *   the scheduled session          (bot-core.js, after the council run)
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const { isTradingOpen } = require('../marketdata');
const { scanUniverse } = require('./scan');
const { structureAll } = require('./options');
const { discover } = require('./discover');
const { buildGovtPage } = require('./report');

const LEDGER_PATH = path.join(__dirname, 'positions.json');
const OUT_PATH = path.join(__dirname, '..', 'report', 'govt.html');

function loadLedger() {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

async function runGovtScan() {
  const ledger = loadLedger();
  console.log(`[govt] ${ledger.positions.length} listed positions, ${ledger.privatePositions.length} private, scanning…`);

  // A closed market is not an error here — unlike the options engine, this
  // page is perfectly meaningful on last-close prices. It just has to say so.
  let marketOpen = false;
  try { marketOpen = await isTradingOpen(); }
  catch (err) { console.warn(`[govt] Could not read market clock (${err.message}) — labelling prices as last-close.`); }

  const scan = await scanUniverse(ledger);
  console.log(`[govt] Priced ${scan.companies.length} companies, ${scan.etfs.length} ETFs${scan.failed.length ? `, ${scan.failed.length} failed` : ''}.`);

  // Never let a dead news feed stop the page from regenerating.
  let disc = { newCandidates: [], allCandidates: [], checked: false, error: 'not run' };
  try { disc = await discover(ledger); }
  catch (err) { disc = { newCandidates: [], allCandidates: [], checked: false, error: err.message }; }
  console.log(`[govt] Watch feed: ${disc.allCandidates.length} filings, ${disc.newCandidates.length} new${disc.error ? ` (error: ${disc.error})` : ''}.`);

  // Concrete contracts — strike, expiry, style, delta, entry/target/stop —
  // for every symbol the trend rules say is tradable. Non-fatal for the same
  // reason as the watch feed: an options chain outage should cost the page
  // its contract detail, not the whole page.
  let contracts = new Map();
  try {
    contracts = await structureAll([...scan.companies, ...scan.etfs]);
    const cleared = [...contracts.values()].filter(c => c.cleared).length;
    const refs = [...contracts.values()].filter(c => !c.cleared && c.reference).length;
    console.log(`[govt] Contracts: ${cleared} cleared the council filters, ${refs} shown as reference only.`);
  } catch (err) {
    console.error(`[govt] Contract structuring failed (page still builds): ${err.message}`);
  }

  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const html = buildGovtPage({ ledger, scan, disc, contracts, marketOpen, ts });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, html);
  console.log(`[govt] Wrote ${OUT_PATH}`);

  return { ledger, scan, disc, contracts, marketOpen, html };
}

module.exports = { runGovtScan, loadLedger };

if (require.main === module) {
  runGovtScan()
    .then(({ scan, disc }) => {
      const all = [...scan.companies, ...scan.etfs];
      const line = r => all.filter(x => x.rating === r).map(x => x.symbol).join(' ') || '—';
      console.log(`\n  BUY:        ${line('BUY')}`);
      console.log(`  BUY ON DIP: ${line('BUY ON DIP')}`);
      console.log(`  HOLD:       ${line('HOLD')}`);
      console.log(`  AVOID:      ${line('AVOID')}`);
      console.log(`  SELL:       ${line('SELL')}`);
      const noData = all.filter(x => x.rating === 'NO DATA');
      if (noData.length) console.log(`  NO DATA:    ${noData.map(x => x.symbol).join(' ')}`);
      if (disc.newCandidates.length) {
        console.log(`\n  ${disc.newCandidates.length} new filing(s) to review — see govt/candidates.json`);
      }
    })
    .catch(err => { console.error('[govt] Failed:', err.response?.data || err.message); process.exit(1); });
}
