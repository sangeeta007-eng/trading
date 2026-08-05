/**
 * bot.js — single-session runner
 * Usage: npm start  OR  node bot.js
 * For the web dashboard: node server.js
 *
 * Recommendation-only — this never places a real order (see marketdata.js,
 * which is read-only market data by design). Runs exactly one session and
 * exits — it does NOT self-schedule. Scheduling is owned by exactly one
 * external mechanism at a time (currently Windows Task Scheduler locally;
 * GitHub Actions once that's set up) — never both, to avoid two schedulers
 * layering and running overlapping/duplicate sessions.
 *
 * Each run checks active recommendations against real live quotes
 * (target/stop/expiry) and scans for new ones; sendSessionReport emails the
 * result. A closed market is a no-op inside runSession — no email is sent.
 */
require('dotenv').config();
const { runSession } = require('./bot-core');

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('   4-AGENT OPTIONS TRADING COUNCIL — Recommendation Engine');
console.log('   Market Analyst · Option Structurer · Risk Guardian · Chief Strategist');
console.log('╠══════════════════════════════════════════════════════╣');
console.log('   Recommendation-only — no real orders are ever placed.');
console.log('   Sizing:   10-15% of configured capital (TOTAL_BUDGET in .env)');
console.log('   Entries:  DTE 21-45 | Delta 0.50-0.65 (auto-tuned every 10 trades)');
console.log('   Outcomes: tracked hypothetically via real live quotes (council/sync.js)');
console.log('   Single session, then exits — scheduling is external (Task Scheduler / GitHub Actions).');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

runSession()
  .then(() => process.exit(0))
  .catch(() => {
    // bot-core.js already logs the error and sends a failure-alert email —
    // this just sets the exit code so Task Scheduler/GitHub Actions see
    // the run as failed.
    process.exit(1);
  });
