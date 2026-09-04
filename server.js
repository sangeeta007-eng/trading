/**
 * Wealth Advisor — Web Dashboard Server
 * Run: node server.js
 * Open: http://localhost:3000
 */

require('dotenv').config();
const express = require('express');
const fs   = require('fs');
const path = require('path');
const app  = express();
const PORT = process.env.PORT || 3000;

// Bot modules
const cfg       = require('./config');
const analytics = require('./analytics');
const { getRegime } = require('./regime');
const { buildPlaybook } = require('./council/playbook');
const { sendSessionReport }  = require('./notify');

app.use(express.json());

// ── SSE: stream live console output to browser ────────────────────────────────
let sseClients = [];

function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ── Run session endpoint ──────────────────────────────────────────────────────
let running = false;

app.post('/api/run', async (req, res) => {
  if (running) return res.json({ ok: false, error: 'Session already running' });
  running = true;

  // Intercept console.log → stream to browser
  const origLog   = console.log;
  const origError = console.error;
  const origWarn  = console.warn;
  const intercept = (...a) => {
    const msg = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    origLog(...a);
    broadcast({ type: 'log', message: msg });
  };
  console.log   = intercept;
  console.error = (...a) => { intercept('[ERROR]', ...a); origError(...a); };
  console.warn  = (...a) => { intercept('[WARN]',  ...a); origWarn(...a); };

  try {
    const result = await require('./bot-core').runSession();
    broadcast({ type: 'result', data: result });
    res.json({ ok: true, data: result });
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
    res.json({ ok: false, error: err.message });
  } finally {
    console.log   = origLog;
    console.error = origError;
    console.warn  = origWarn;
    running = false;
    broadcast({ type: 'done' });
  }
});

// ── Government Stakes page ────────────────────────────────────────────────────
//
// Separate from /api/run on purpose: this scan is read-only price work with
// no options chain and no email, so it must not be blocked by (or block) a
// council session that happens to be running.
let govtRunning = false;

app.post('/api/govt/refresh', async (req, res) => {
  if (govtRunning) return res.status(409).json({ ok: false, error: 'A government-stakes refresh is already running' });
  govtRunning = true;
  try {
    const { scan, disc } = await require('./govt/run').runGovtScan();
    res.json({
      ok: true,
      companies: scan.companies.length,
      etfs: scan.etfs.length,
      failed: scan.failed.map(f => f.symbol),
      newFilings: disc.newCandidates.length,
    });
  } catch (err) {
    console.error('[server] Government stakes refresh failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    govtRunning = false;
  }
});

// Serve the generated page. Regenerates on first visit if it has never been
// built, so a fresh checkout does not 404 before the first scheduled run.
app.get('/govt.html', async (req, res) => {
  const file = path.join(__dirname, 'report', 'govt.html');
  if (!fs.existsSync(file)) {
    try { await require('./govt/run').runGovtScan(); }
    catch (err) { return res.status(503).send(`Government Stakes page could not be generated: ${err.message}`); }
  }
  res.sendFile(file);
});

// ── Status endpoint: recommendations + regime ─────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const [regime, playbook] = await Promise.all([getRegime(), buildPlaybook()]);
    const weeklyPnL  = analytics.getWeeklyPnL();
    const monthlyPnL = analytics.getMonthlyPnL();
    res.json({ ok: true, regime, weeklyPnL, monthlyPnL, playbook, capital: cfg.TOTAL_BUDGET });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Serve the dashboard HTML ──────────────────────────────────────────────────
app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Wealth Advisor Dashboard running at http://localhost:${PORT}\n`);
});

// ── Dashboard HTML ────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Option Trading Suggestion One</title>
<style>
  :root {
    --bg: #080c18;
    --surface: #0e1525;
    --surface2: #141c30;
    --border: #1e2d4a;
    --accent: #2563eb;
    --green: #10b981;
    --red: #ef4444;
    --yellow: #f59e0b;
    --text: #e2e8f0;
    --muted: #64748b;
    --font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'SF Mono', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100vh; }

  /* Header */
  .header {
    background: linear-gradient(135deg, #0a0f1e 0%, #0e1a2e 100%);
    border-bottom: 1px solid var(--border);
    padding: 20px 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header-left { display: flex; align-items: center; gap: 16px; }
  .logo { width: 44px; height: 44px; background: var(--accent); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 22px; }
  .header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .header p { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  #marketBadge { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 20px; background: #1a2a1a; color: var(--green); border: 1px solid #1e3a1e; }
  #clock { font-size: 13px; color: var(--muted); font-family: var(--mono); }

  /* Main layout */
  .main { max-width: 1400px; margin: 0 auto; padding: 32px 40px; display: grid; gap: 24px; }

  /* Metrics row */
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .metric-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .metric-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 8px; }
  .metric-value { font-size: 26px; font-weight: 700; font-family: var(--mono); }
  .metric-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .yellow { color: var(--yellow); }
  .blue { color: #60a5fa; }

  /* Regime bar */
  .regime-bar {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .regime-info { display: flex; align-items: center; gap: 16px; }
  .regime-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .regime-dot.off { background: var(--yellow); box-shadow: 0 0 8px var(--yellow); }
  .regime-dot.extreme { background: var(--red); box-shadow: 0 0 8px var(--red); }
  .regime-name { font-size: 15px; font-weight: 600; }
  .regime-meta { font-size: 13px; color: var(--muted); }
  .regime-rules { display: flex; gap: 24px; }
  .regime-rule { font-size: 12px; color: var(--muted); }
  .regime-rule span { color: var(--text); font-weight: 500; }

  /* Run button */
  .run-section { display: flex; align-items: center; gap: 16px; }
  #runBtn {
    background: linear-gradient(135deg, #1d4ed8, #2563eb);
    color: white;
    border: none;
    border-radius: 10px;
    padding: 14px 32px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: all 0.2s;
    box-shadow: 0 4px 20px rgba(37,99,235,0.3);
    letter-spacing: 0.2px;
  }
  #runBtn:hover:not(:disabled) { background: linear-gradient(135deg, #1e40af, #1d4ed8); transform: translateY(-1px); box-shadow: 0 6px 24px rgba(37,99,235,0.4); }
  #runBtn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  #runBtn .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #runStatus { font-size: 13px; color: var(--muted); }

  /* Sections */
  .section-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }

  /* Direction filter tabs */
  .direction-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .dir-tab {
    padding: 7px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border); background: var(--surface2);
    color: var(--muted); transition: all 0.15s;
  }
  .dir-tab.active-all  { background: var(--accent); color: #fff; border-color: var(--accent); }
  .dir-tab.active-call { background: rgba(16,185,129,0.2); color: var(--green); border-color: rgba(16,185,129,0.4); }
  .dir-tab.active-put  { background: rgba(239,68,68,0.2);  color: var(--red);   border-color: rgba(239,68,68,0.4); }
  .trade-card[data-dir="Bearish"].hide-call,
  .trade-card[data-dir="Bullish"].hide-put { display: none; }

  /* Trade cards */
  .trade-grid { display: grid; gap: 16px; }
  .trade-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    animation: fadeUp 0.4s ease;
  }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  .trade-card-header {
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  .trade-card-header.bullish { border-left: 4px solid var(--green); }
  .trade-card-header.bearish { border-left: 4px solid var(--red); }
  .trade-header-left { display: flex; align-items: center; gap: 12px; }
  .trade-ticker { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .trade-direction-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 3px 10px;
    border-radius: 6px;
  }
  .badge-call { background: rgba(16,185,129,0.15); color: var(--green); border: 1px solid rgba(16,185,129,0.3); }
  .badge-put  { background: rgba(239,68,68,0.15);  color: var(--red);   border: 1px solid rgba(239,68,68,0.3); }
  .trade-advisor { font-size: 12px; color: var(--muted); }
  .trade-debit { text-align: right; }
  .trade-debit .amount { font-size: 18px; font-weight: 700; font-family: var(--mono); }
  .trade-debit .label { font-size: 11px; color: var(--muted); }

  .trade-card-body { padding: 20px; display: grid; grid-template-columns: repeat(3, 1fr) 2fr; gap: 20px; }
  .trade-field label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); display: block; margin-bottom: 5px; }
  .trade-field .val { font-size: 15px; font-weight: 600; font-family: var(--mono); }
  .trade-field .val.delta { color: #60a5fa; }

  .trade-reasoning {
    background: var(--surface2);
    border-radius: 8px;
    padding: 14px;
  }
  .trade-reasoning .reason-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin-bottom: 6px; }
  .trade-reasoning .reason-text { font-size: 13px; color: #94a3b8; line-height: 1.6; }

  /* Open positions */
  .positions-table { width: 100%; border-collapse: collapse; }
  .positions-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); padding: 10px 16px; text-align: left; border-bottom: 1px solid var(--border); }
  .positions-table td { padding: 14px 16px; border-bottom: 1px solid #0f1827; font-size: 13px; }
  .positions-table tr:last-child td { border-bottom: none; }
  .positions-table .mono { font-family: var(--mono); }

  /* Watchlist tables */
  .wl-table-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 20px; }
  .wl-table-title { padding: 12px 16px; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .wl-table-title.hot { background: rgba(239,68,68,0.12); color: #f87171; }
  .wl-table-title.warm { background: rgba(245,158,11,0.12); color: #fbbf24; }
  .wl-table { width: 100%; border-collapse: collapse; background: var(--surface); }
  .wl-table th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .wl-table td { padding: 10px 12px; border-bottom: 1px solid #0f1827; font-size: 13px; font-family: var(--mono); white-space: nowrap; }
  .wl-table tr:last-child td { border-bottom: none; }
  .wl-table .why-cell { white-space: normal; font-family: var(--font); color: var(--muted); font-size: 12px; min-width: 200px; }
  .wl-legend { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .wl-legend b { font-weight: 700; }
  .pnl-pos { color: var(--green); font-weight: 600; }
  .pnl-neg { color: var(--red);   font-weight: 600; }

  /* Log console */
  #logConsole {
    background: #040810;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.7;
    color: #64748b;
    height: 260px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  #logConsole .log-ok    { color: #10b981; }
  #logConsole .log-err   { color: #ef4444; }
  #logConsole .log-warn  { color: #f59e0b; }
  #logConsole .log-info  { color: #60a5fa; }
  #logConsole .log-plain { color: #64748b; }

  /* Portfolio summary pills */
  .portfolio-pills { display: flex; gap: 10px; flex-wrap: wrap; }
  .pill {
    padding: 5px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .pill-call { background: rgba(16,185,129,0.12); color: var(--green); border: 1px solid rgba(16,185,129,0.25); }
  .pill-put  { background: rgba(239,68,68,0.12);  color: var(--red);   border: 1px solid rgba(239,68,68,0.25); }
  .pill-neutral { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }

  /* Empty state */
  .empty-state { text-align: center; padding: 48px; color: var(--muted); }
  .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
  .empty-state p { font-size: 14px; }

  /* Exit cards */
  .exit-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; }
  .exit-symbol { font-family: var(--mono); font-size: 14px; font-weight: 600; }
  .exit-reason { font-size: 12px; color: var(--muted); margin-top: 4px; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .full-col { }
  .card-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }

  /* Hot & Warm watchlist */
  .watchlist-grid { display: grid; gap: 12px; }
  .watchlist-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; }
  .watchlist-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .watchlist-left { display: flex; align-items: center; gap: 12px; }
  .watchlist-symbol { font-size: 18px; font-weight: 800; }
  .tier-badge { font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.6px; }
  .tier-hot  { background: rgba(239,68,68,0.15);  color: #f87171; border: 1px solid rgba(239,68,68,0.35); }
  .tier-warm { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.35); }
  .watchlist-conviction { font-family: var(--mono); font-size: 13px; color: var(--muted); }
  .watchlist-detail { font-size: 12px; color: #94a3b8; line-height: 1.6; }
  .watchlist-blocked { font-size: 12px; color: var(--yellow); margin-top: 4px; }

  /* Position playbook */
  .playbook-grid { display: grid; gap: 12px; padding: 20px; }
  .playbook-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .playbook-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .playbook-symbol { font-family: var(--mono); font-size: 14px; font-weight: 700; }
  .playbook-grid-fields { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
  .playbook-field label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); display: block; margin-bottom: 3px; }
  .playbook-field .val { font-size: 13px; font-weight: 600; font-family: var(--mono); }
  .unmanaged-flag { font-size: 11px; color: var(--yellow); margin-top: 8px; display: flex; align-items: center; gap: 6px; }

  @media (max-width: 900px) {
    .main { padding: 20px; }
    .metrics { grid-template-columns: repeat(2, 1fr); }
    .trade-card-body { grid-template-columns: 1fr 1fr; }
    .two-col { grid-template-columns: 1fr; }
    .header { padding: 16px 20px; }
    .regime-rules { display: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo">📊</div>
    <div>
      <h1>Option Trading Suggestion One</h1>
      <p>4-Agent Options Trading Council · Recommendation Only — you trade manually</p>
    </div>
  </div>
  <div class="header-right">
    <div id="marketBadge">⬤ Checking market...</div>
    <div id="clock"></div>
  </div>
</div>

<div class="main">

  <!-- Metrics -->
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Configured Capital</div>
      <div class="metric-value blue" id="metCapital">—</div>
      <div class="metric-sub">Set TOTAL_BUDGET in .env to your real account size</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Weekly P&L (hypothetical)</div>
      <div class="metric-value" id="metWeekly">—</div>
      <div class="metric-sub" id="metWeeklyTarget">Target: $750</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Active Recommendations</div>
      <div class="metric-value blue" id="metPositions">—</div>
      <div class="metric-sub">Max 3 at a time</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Monthly P&L (hypothetical)</div>
      <div class="metric-value" id="metMonthly">—</div>
      <div class="metric-sub">Month to date</div>
    </div>
  </div>

  <!-- Regime -->
  <div class="regime-bar">
    <div class="regime-info">
      <div class="regime-dot" id="regimeDot"></div>
      <div>
        <div class="regime-name" id="regimeName">Loading regime...</div>
        <div class="regime-meta" id="regimeMeta"></div>
      </div>
    </div>
    <div class="regime-rules">
      <div class="regime-rule">Entry Direction: <span id="regimeEntry">—</span></div>
      <div class="regime-rule">Position Sizing: <span id="regimeSizing">—</span></div>
      <div class="regime-rule">Max New/Day: <span id="regimeMax">—</span></div>
    </div>
  </div>

  <!-- Run button -->
  <div class="run-section">
    <button id="runBtn" onclick="runSession()">
      <div class="spinner" id="spinner"></div>
      <span id="btnText">▶ Run Option Trading Suggestion One</span>
    </button>
    <div id="runStatus">Last run: Never</div>
    <div class="portfolio-pills" id="portfolioPills"></div>
  </div>

  <!-- Hot & Warm Watchlist -->
  <div>
    <div class="section-title">🔥 Hot &amp; 🌤️ Warm Watchlist</div>
    <div class="wl-legend">
      Legend: <b style="color:var(--green);">green = target, exit for profit</b> ·
      <b style="color:var(--red);">red = stop, exit for loss</b> ·
      <b style="color:#f87171;">🔥 HOT = act now</b> ·
      <b style="color:#fbbf24;">🌤️ WARM = watch, not yet</b>
    </div>
    <div id="watchlistGrid">
      <div class="empty-state"><div class="icon">🔥</div><p>Run a session to see which ETFs are hot (buy now) or warm (promising, not yet actionable).</p></div>
    </div>
  </div>

  <!-- New Suggestions -->
  <div>
    <div class="section-title">New Trading Suggestions</div>
    <div class="direction-tabs" id="dirTabs" style="display:none;">
      <div class="dir-tab active-all" onclick="filterTrades('all')" id="tabAll">All</div>
      <div class="dir-tab" onclick="filterTrades('call')" id="tabCall">▲ Calls</div>
      <div class="dir-tab" onclick="filterTrades('put')"  id="tabPut">▼ Puts</div>
    </div>
    <div class="trade-grid" id="tradeGrid">
      <div class="empty-state">
        <div class="icon">🔍</div>
        <p>Click "Run" to generate trading suggestions from all four advisors.</p>
      </div>
    </div>
  </div>

  <div class="two-col">
    <!-- Position playbook -->
    <div>
      <div class="section-title">Position Playbook — Exact Entry/Exit</div>
      <div class="card-wrap" style="padding: 0; overflow: hidden;">
        <div id="positionsWrap">
          <div class="empty-state"><div class="icon">📂</div><p>No active recommendations</p></div>
        </div>
      </div>
    </div>

    <!-- Exits -->
    <div>
      <div class="section-title">Exits This Session</div>
      <div id="exitsGrid">
        <div class="empty-state"><div class="icon">🚪</div><p>No exits this session</p></div>
      </div>
    </div>
  </div>

  <!-- Log console -->
  <div>
    <div class="section-title">Live Session Log</div>
    <div id="logConsole"><span class="log-plain">Waiting for session to start...</span></div>
  </div>

</div>

<script>
// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  document.getElementById('clock').textContent = now + ' ET';
}
setInterval(updateClock, 1000);
updateClock();

// ── Status poll ───────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const r = await fetch('/api/status').then(r => r.json());
    if (!r.ok) return;

    // Metrics
    document.getElementById('metCapital').textContent = '$' + r.capital.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0});

    const wp = r.weeklyPnL;
    const wpEl = document.getElementById('metWeekly');
    wpEl.textContent = (wp >= 0 ? '+' : '') + '$' + Math.abs(wp).toFixed(2);
    wpEl.className = 'metric-value ' + (wp >= 0 ? 'green' : 'red');
    document.getElementById('metWeeklyTarget').textContent = 'Target: $750 (' + (wp / 750 * 100).toFixed(0) + '% there)';

    document.getElementById('metPositions').textContent = r.playbook.length;

    const mp = r.monthlyPnL;
    const mpEl = document.getElementById('metMonthly');
    mpEl.textContent = (mp >= 0 ? '+' : '') + '$' + Math.abs(mp).toFixed(2);
    mpEl.className = 'metric-value ' + (mp >= 0 ? 'green' : 'red');

    // Regime
    const rg = r.regime;
    const dot = document.getElementById('regimeDot');
    dot.className = 'regime-dot' + (rg.name === 'Risk-OFF' ? ' off' : rg.name === 'Extreme Risk' ? ' extreme' : '');
    document.getElementById('regimeName').textContent = rg.name + '  |  VIX ~' + rg.vix;
    document.getElementById('regimeMeta').textContent = 'Weekly target: $' + rg.weeklyTargetLow + ' – $' + rg.weeklyTargetHigh;
    const entryDir = rg.sizingMod === 0 ? 'All Entries Frozen' : (rg.allowBullish && rg.allowBearish) ? 'Calls & Puts' : rg.allowBearish ? 'Puts Only' : rg.allowBullish ? 'Calls Only' : 'Paused';
    document.getElementById('regimeEntry').textContent = entryDir;
    document.getElementById('regimeSizing').textContent = (rg.sizingMod * 100).toFixed(0) + '%';
    document.getElementById('regimeMax').textContent = rg.maxNewPerDay === Infinity ? 'Unlimited' : rg.maxNewPerDay + ' per day';

    // Market badge
    const badge = document.getElementById('marketBadge');
    // Use clock: market open Mon-Fri 9:30-16:00 ET
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay(), h = et.getHours(), m = et.getMinutes();
    const open = day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 30)) && h < 16;
    badge.textContent = open ? '⬤ Market Open' : '◯ Market Closed';
    badge.style.color = open ? 'var(--green)' : 'var(--muted)';
    badge.style.background = open ? '#1a2a1a' : '#1a1a1a';
    badge.style.borderColor = open ? '#1e3a1e' : '#2a2a2a';

    // Portfolio pills — calls vs puts breakdown among active recommendations
    const playbook = r.playbook || [];
    const callRecs = playbook.filter(p => p.optionType === 'call').length;
    const putRecs  = playbook.filter(p => p.optionType === 'put').length;
    const pillsEl = document.getElementById('portfolioPills');
    pillsEl.innerHTML = [
      callRecs > 0 ? \`<span class="pill pill-call">▲ \${callRecs} Call\${callRecs > 1 ? 's' : ''}</span>\` : '',
      putRecs  > 0 ? \`<span class="pill pill-put">▼ \${putRecs} Put\${putRecs > 1 ? 's' : ''}</span>\`   : '',
      callRecs === 0 && putRecs === 0 ? '<span class="pill pill-neutral">No active recommendations</span>' : '',
    ].join('');

    // Position playbook (exact entry/exit per position)
    renderPlaybook(r.playbook || []);
  } catch(e) { console.error('Status load error', e); }
}

function renderPlaybook(playbook) {
  const wrap = document.getElementById('positionsWrap');
  if (!playbook.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">📂</div><p>No active recommendations</p></div>';
    return;
  }
  wrap.innerHTML = '<div class="playbook-grid">' + playbook.map(renderPlaybookCard).join('') + '</div>';
}

function renderPlaybookCard(p) {
  const pnlCls = (p.unrealizedPct || 0) >= 0 ? 'pnl-pos' : 'pnl-neg';
  const pnlStr = p.unrealizedPct != null
    ? \`\${p.unrealizedPct >= 0 ? '+' : ''}\${(p.unrealizedPct * 100).toFixed(1)}% (\${p.unrealizedDollar >= 0 ? '+' : ''}$\${p.unrealizedDollar.toFixed(0)})\`
    : 'no live quote';

  const dte = p.daysToExpiry != null ? \`\${p.daysToExpiry.toFixed(0)}d\` : '—';
  const isCall = p.optionType === 'call';
  return \`
    <div class="playbook-card">
      <div class="playbook-top">
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="trade-direction-badge \${isCall ? 'badge-call' : 'badge-put'}">\${isCall ? 'CALL' : 'PUT'}</span>
          <div class="playbook-symbol">\${p.underlying} · \${p.symbol}</div>
        </div>
        <div class="\${pnlCls}" style="font-family:var(--mono); font-weight:700;">\${pnlStr}</div>
      </div>
      <div class="playbook-grid-fields">
        <div class="playbook-field"><label>Strike</label><div class="val">$\${p.strike.toFixed(2)}</div></div>
        <div class="playbook-field"><label>Expiry</label><div class="val">\${p.expiration} (\${dte})</div></div>
        <div class="playbook-field"><label>Qty</label><div class="val">\${p.qty}</div></div>
        <div class="playbook-field"><label>Held</label><div class="val">\${p.daysHeld.toFixed(1)}d</div></div>
        <div class="playbook-field"><label>Recommended Entry</label><div class="val">$\${p.entryLimit.toFixed(2)}</div></div>
        <div class="playbook-field"><label>Target</label><div class="val" style="color:var(--green);">$\${p.target.toFixed(2)}</div></div>
        <div class="playbook-field"><label>Stop</label><div class="val" style="color:var(--red);">$\${p.stop.toFixed(2)}</div></div>
        <div class="playbook-field"><label>Current (live)</label><div class="val">\${p.currentPrice != null ? '$' + p.currentPrice.toFixed(2) : '—'}</div></div>
      </div>
    </div>\`;
}

function renderWatchlist(watchlist) {
  const grid = document.getElementById('watchlistGrid');
  if (!watchlist || !watchlist.length) {
    grid.innerHTML = '<div class="empty-state"><div class="icon">🔥</div><p>Nothing hot or warm this session — no qualifying setups.</p></div>';
    return;
  }
  const hot = watchlist.filter(w => w.tier === 'HOT');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  grid.innerHTML = renderHotTable(hot) + renderWarmTable(warm);
}

function convictionSpan(c) {
  const color = c >= 70 ? 'var(--green)' : c >= 50 ? '#fbbf24' : 'var(--muted)';
  return \`<span style="color:\${color}; font-weight:700;">\${c}/100</span>\`;
}

function dirCell(bias) {
  const bull = bias === 'CALL';
  return \`<span style="color:\${bull ? 'var(--green)' : 'var(--red)'}; font-weight:600;">\${bull ? '▲ CALL' : '▼ PUT'}</span>\`;
}

function renderHotTable(hot) {
  const rows = hot.length ? hot.map(w => {
    const c = w.contract;
    return \`<tr>
      <td><b>\${w.symbol}</b></td>
      <td>\${dirCell(w.bias)}</td>
      <td>\${c ? '$' + c.strike.toFixed(2) : '—'}</td>
      <td>\${c ? c.expiration : '—'}</td>
      <td>\${c ? 'Δ' + c.delta.toFixed(2) : '—'}</td>
      <td>\${c ? '$' + c.entryLimit.toFixed(2) : '—'}</td>
      <td style="color:var(--green); font-weight:700;">\${c ? '$' + c.targetLimit.toFixed(2) : '—'}</td>
      <td style="color:var(--red); font-weight:700;">\${c ? '$' + c.stopLimit.toFixed(2) : '—'}</td>
      <td>\${convictionSpan(w.conviction)}</td>
    </tr>\`;
  }).join('') : \`<tr><td colspan="9" style="font-family:var(--font); color:var(--muted); font-style:italic;">Nothing hot this session.</td></tr>\`;

  return \`
  <div class="wl-table-wrap">
    <div class="wl-table-title hot">🔥 HOT — Actionable Now</div>
    <table class="wl-table">
      <thead><tr><th>Symbol</th><th>Direction</th><th>Strike</th><th>Expiry</th><th>Delta</th><th>Entry</th><th>Target ▲</th><th>Stop ▼</th><th>Conv.</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

function renderWarmTable(warm) {
  const rows = warm.length ? warm.map(w => {
    const c = w.contract;
    return \`<tr>
      <td><b>\${w.symbol}</b></td>
      <td>\${dirCell(w.bias)}</td>
      <td>\${convictionSpan(w.conviction)}</td>
      <td>\${c ? '$' + c.entryLimit.toFixed(2) : '—'}</td>
      <td style="\${c ? 'color:var(--green);' : ''}">\${c ? '$' + c.targetLimit.toFixed(2) : '—'}</td>
      <td style="\${c ? 'color:var(--red);' : ''}">\${c ? '$' + c.stopLimit.toFixed(2) : '—'}</td>
      <td class="why-cell">\${w.blockedDetail || w.blockedReason || 'pending better conditions'}</td>
    </tr>\`;
  }).join('') : \`<tr><td colspan="7" style="font-family:var(--font); color:var(--muted); font-style:italic;">Nothing warm this session.</td></tr>\`;

  return \`
  <div class="wl-table-wrap">
    <div class="wl-table-title warm">🌤️ WARM — Good Setup, Not Yet Actionable</div>
    <table class="wl-table">
      <thead><tr><th>Symbol</th><th>Direction</th><th>Conviction</th><th>Entry</th><th>Target</th><th>Stop</th><th>Why Not Yet</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

// ── Run session ───────────────────────────────────────────────────────────────
let sseSource = null;
const logEl = document.getElementById('logConsole');

function appendLog(message) {
  const div = document.createElement('div');
  let cls = 'log-plain';
  if (message.includes('✅') || message.includes('Campaign opened') || message.includes('PASS')) cls = 'log-ok';
  else if (message.includes('❌') || message.includes('ERROR') || message.includes('failed')) cls = 'log-err';
  else if (message.includes('⚠️') || message.includes('WARN')) cls = 'log-warn';
  else if (message.includes('[regime]') || message.includes('[bot]') || message.includes('[council')) cls = 'log-info';
  div.className = cls;
  div.textContent = message;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function runSession() {
  const btn  = document.getElementById('runBtn');
  const spin = document.getElementById('spinner');
  const text = document.getElementById('btnText');
  const stat = document.getElementById('runStatus');

  btn.disabled = true;
  spin.style.display = 'block';
  text.textContent = 'Running Analysis...';
  stat.textContent = 'Session in progress...';

  // Clear previous results
  logEl.innerHTML = '';
  document.getElementById('tradeGrid').innerHTML = '<div class="empty-state"><div class="icon">⏳</div><p>Advisors scanning the market...</p></div>';
  document.getElementById('exitsGrid').innerHTML = '<div class="empty-state"><div class="icon">⏳</div><p>Checking positions...</p></div>';

  // Connect SSE for live logs
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/api/stream');
  sseSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'log') {
      appendLog(msg.message);
    } else if (msg.type === 'result') {
      renderResults(msg.data);
    } else if (msg.type === 'done' || msg.type === 'error') {
      sseSource.close();
      btn.disabled = false;
      spin.style.display = 'none';
      text.textContent = '▶ Run Option Trading Suggestion One';
      stat.textContent = 'Last run: ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET';
      loadStatus();
      if (msg.type === 'error') appendLog('[ERROR] ' + msg.message);
    }
  };

  // Trigger the run
  try {
    await fetch('/api/run', { method: 'POST' });
  } catch(e) {
    appendLog('[ERROR] Could not connect to server: ' + e.message);
    btn.disabled = false;
    spin.style.display = 'none';
    text.textContent = '▶ Run Option Trading Suggestion One';
  }
}

let _activeFilter = 'all';
function filterTrades(dir) {
  _activeFilter = dir;
  document.getElementById('tabAll').className  = 'dir-tab' + (dir === 'all'  ? ' active-all'  : '');
  document.getElementById('tabCall').className = 'dir-tab' + (dir === 'call' ? ' active-call' : '');
  document.getElementById('tabPut').className  = 'dir-tab' + (dir === 'put'  ? ' active-put'  : '');
  document.querySelectorAll('#tradeGrid .trade-card').forEach(el => {
    el.classList.remove('hide-call', 'hide-put');
    if (dir === 'call') el.classList.add('hide-call');
    if (dir === 'put')  el.classList.add('hide-put');
  });
}

function renderResults(data) {
  renderWatchlist(data.watchlist);
  if (data.playbook) renderPlaybook(data.playbook);

  // New campaigns
  const grid = document.getElementById('tradeGrid');
  const tabs = document.getElementById('dirTabs');
  if (!data.newCampaigns || !data.newCampaigns.length) {
    tabs.style.display = 'none';
    grid.innerHTML = '<div class="empty-state"><div class="icon">🔎</div><p>No new trades this session. Advisors are holding or waiting for better setups.</p></div>';
  } else {
    tabs.style.display = 'flex';
    const calls = data.newCampaigns.filter(c => c.direction === 'Bullish').length;
    const puts  = data.newCampaigns.filter(c => c.direction === 'Bearish').length;
    document.getElementById('tabCall').textContent = \`▲ Calls (\${calls})\`;
    document.getElementById('tabPut').textContent  = \`▼ Puts (\${puts})\`;
    document.getElementById('tabAll').textContent  = \`All (\${data.newCampaigns.length})\`;
    grid.innerHTML = data.newCampaigns.map(c => renderTradeCard(c)).join('');
    filterTrades(_activeFilter);
  }

  // Exits
  const exitsGrid = document.getElementById('exitsGrid');
  if (!data.exits || !data.exits.length) {
    exitsGrid.innerHTML = '<div class="empty-state"><div class="icon">🚪</div><p>No exits this session</p></div>';
  } else {
    exitsGrid.innerHTML = data.exits.map(e => \`
      <div class="exit-card">
        <div>
          <div class="exit-symbol">\${e.symbol || '—'}</div>
          <div class="exit-reason">\${e.reason || ''}</div>
        </div>
        <div class="\${e.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}" style="font-family:var(--mono); font-size:15px; font-weight:700;">
          \${e.pnl != null ? (e.pnl >= 0 ? '+' : '') + '$' + e.pnl.toFixed(2) : '—'}
        </div>
      </div>
    \`).join('');
  }
}

function renderTradeCard(c) {
  const isBull = c.direction === 'Bullish';
  const advisorMap = {
    council: { name: '4-Agent Council', role: 'Analyst · Structurer · Risk · Strategist' },
  };
  const adv = advisorMap[c.advisor] || { name: c.advisor, role: '' };
  const leg1 = c.leg1 || {};
  const contract = leg1.contract || {};

  return \`
  <div class="trade-card" data-dir="\${isBull ? 'Bullish' : 'Bearish'}">
    <div class="trade-card-header \${isBull ? 'bullish' : 'bearish'}">
      <div class="trade-header-left">
        <div class="trade-ticker">\${c.symbol}</div>
        <span class="trade-direction-badge \${isBull ? 'badge-call' : 'badge-put'}">\${isBull ? '▲ CALL' : '▼ PUT'}</span>
        <div class="trade-advisor">\${adv.name} · \${adv.role}</div>
      </div>
      <div class="trade-debit">
        <div class="amount \${isBull ? 'green' : 'red'}">$\${(c.netDebit || 0).toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
        <div class="label">Capital Deployed</div>
      </div>
    </div>
    <div class="trade-card-body">
      <div class="trade-field">
        <label>Contract</label>
        <div class="val" style="font-size:12px;">\${contract.symbol || '—'}</div>
      </div>
      <div class="trade-field">
        <label>Strike · Delta</label>
        <div class="val">$\${contract.strike_price || '—'} · <span class="delta">Δ\${(leg1.delta || 0).toFixed(2)}</span></div>
      </div>
      <div class="trade-field">
        <label>Expiry</label>
        <div class="val">\${contract.expiration_date || '—'}</div>
      </div>
      <div class="trade-field">
        <label>Why This Trade</label>
        <div class="trade-reasoning">
          <div class="reason-text">\${c.reason || '—'}</div>
        </div>
      </div>
    </div>
  </div>
  \`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadStatus();
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;
