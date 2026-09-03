/**
 * council/backtest-cli.js — `npm run backtest`
 *
 * Re-measures the live entry rules against real historical bars and writes
 * backtest_results.json, which the daily report reads and displays. Run
 * this after ANY change to the entry rules: shipping a rule change without
 * re-measuring is how the engine ended up with negative expectancy in the
 * first place.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bt = require('./backtest');
const { DEFAULT_UNIVERSE } = require('./agent1_analyst');

const YEARS = parseInt(process.env.BACKTEST_YEARS) || 8;
const OUT = path.join(__dirname, '..', 'backtest_results.json');

(async () => {
  console.log(`Backtesting ${DEFAULT_UNIVERSE.length} symbols over ${YEARS} years...`);
  const r = await bt.run({
    universe: DEFAULT_UNIVERSE, years: YEARS,
    targetPct: 0.135, stopPct: 0.65, holdDays: 21, targetDelta: 0.6,
  });
  const o = r.overall;

  // Signal-only edge, exact from bars (no option approximation): does a
  // signal beat simply buying on a random day?
  const hold = 21, calls = [], puts = [], base = [];
  for (const sym of DEFAULT_UNIVERSE) {
    let bars;
    try { bars = await require('../marketdata').getBars(sym, '1Day', YEARS * 260); } catch { continue; }
    if (!bars || bars.length < 300) continue;
    for (let i = 220; i < bars.length - hold; i++) {
      const j = Math.min(i + hold, bars.length - 1);
      const raw = (bars[j].c - bars[i].c) / bars[i].c;
      base.push(raw);
      const s = bt.evaluateSignal(bars.slice(Math.max(0, i - 300), i + 1));
      if (!s) continue;
      if (s.bias === 'CALL') calls.push(raw); else puts.push(-raw);
    }
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const win = a => a.length ? a.filter(x => x > 0).length / a.length : 0;

  const out = {
    generatedAt: new Date().toISOString(),
    params: r.params,
    optionSim: {
      trades: o.n, winRate: o.winRate, lossRate: o.lossRate,
      avgWin: o.avgWin, avgLoss: o.avgLoss, expectancy: o.expectancy, avgDays: o.avgDays,
    },
    signalEdge: {
      holdDays: hold,
      call: { n: calls.length, avgReturn: avg(calls), winRate: win(calls) },
      put: { n: puts.length, avgReturn: avg(puts), winRate: win(puts) },
      baselineLong: { n: base.length, avgReturn: avg(base), winRate: win(base) },
      callEdgeVsBaseline: avg(calls) - avg(base),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`\n  trades      ${o.n}`);
  console.log(`  win rate    ${(o.winRate * 100).toFixed(1)}%  (breakeven ${(r.params.breakeven * 100).toFixed(1)}%)`);
  console.log(`  expectancy  ${(o.expectancy * 100).toFixed(2)}% per trade`);
  console.log(`  signal edge ${(out.signalEdge.callEdgeVsBaseline * 100).toFixed(2)}% vs buy-any-day baseline`);
  console.log(`\n  -> ${OUT}`);
  if (o.expectancy <= 0) console.log('\n  WARNING: negative expectancy. These rules lose money as configured.');
})().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
