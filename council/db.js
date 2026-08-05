/**
 * council/db.js — SQLite persistence for the 4-Agent Options Trading Council.
 * Uses Node's built-in node:sqlite (no native build step required).
 *
 * This is a recommendation tracker, not a broker order ledger — there are no
 * order IDs or fill confirmations here. A recommendation becomes ACTIVE the
 * moment Agent 3 approves it (assumed entry = the computed limit price), and
 * council/sync.js later closes it out by comparing real live market quotes
 * against the stored target/stop/expiry — never a real account fill.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'council.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_history (
    trade_id        TEXT PRIMARY KEY,
    ticker          TEXT NOT NULL,
    option_type     TEXT NOT NULL,
    contract_symbol TEXT NOT NULL,
    strike          REAL,
    expiration      TEXT,
    delta           REAL,
    rsi_at_entry    REAL,
    iv_at_entry     REAL,
    entry_price     REAL,
    target_price    REAL,
    stop_price      REAL,
    qty             INTEGER,
    allocation      REAL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    reject_reason   TEXT,
    opened_at       TEXT NOT NULL,
    closed_at       TEXT,
    exit_price      REAL,
    holding_days    REAL,
    pnl_pct         REAL,
    pnl_dollar      REAL,
    conviction_score REAL,
    regime_at_entry TEXT,
    iv_hv_ratio     REAL
  );

  CREATE TABLE IF NOT EXISTS thresholds (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    delta_min     REAL NOT NULL DEFAULT 0.50,
    delta_max     REAL NOT NULL DEFAULT 0.65,
    dte_min       INTEGER NOT NULL DEFAULT 21,
    dte_max       INTEGER NOT NULL DEFAULT 45,
    updated_at    TEXT NOT NULL,
    note          TEXT
  );

  CREATE TABLE IF NOT EXISTS learning_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tuned_at       TEXT NOT NULL,
    trigger_reason TEXT NOT NULL,
    old_values     TEXT NOT NULL,
    new_values     TEXT NOT NULL,
    win_rate       REAL,
    avg_holding_days REAL
  );
`);

// Seed default thresholds row if missing
db.prepare(`
  INSERT OR IGNORE INTO thresholds (id, delta_min, delta_max, dte_min, dte_max, updated_at, note)
  VALUES (1, 0.50, 0.65, 21, 45, ?, 'default (PRD baseline)')
`).run(new Date().toISOString());

// ── Thresholds ────────────────────────────────────────────────────────────────

function getThresholds() {
  return db.prepare('SELECT * FROM thresholds WHERE id = 1').get();
}

function updateThresholds({ delta_min, delta_max, dte_min, dte_max }, note) {
  db.prepare(`
    UPDATE thresholds SET delta_min = ?, delta_max = ?, dte_min = ?, dte_max = ?, updated_at = ?, note = ?
    WHERE id = 1
  `).run(delta_min, delta_max, dte_min, dte_max, new Date().toISOString(), note || null);
}

function logTuning({ trigger_reason, old_values, new_values, win_rate, avg_holding_days }) {
  db.prepare(`
    INSERT INTO learning_log (tuned_at, trigger_reason, old_values, new_values, win_rate, avg_holding_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), trigger_reason, JSON.stringify(old_values), JSON.stringify(new_values), win_rate ?? null, avg_holding_days ?? null);
}

function getTuningHistory(limit = 20) {
  return db.prepare('SELECT * FROM learning_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ── Recommendation lifecycle ────────────────────────────────────────────────

function insertTrade(t) {
  db.prepare(`
    INSERT INTO trade_history (
      trade_id, ticker, option_type, contract_symbol, strike, expiration,
      delta, rsi_at_entry, iv_at_entry, entry_price, target_price, stop_price,
      qty, allocation, status, reject_reason, opened_at,
      conviction_score, regime_at_entry, iv_hv_ratio
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    t.trade_id, t.ticker, t.option_type, t.contract_symbol, t.strike, t.expiration,
    t.delta, t.rsi_at_entry, t.iv_at_entry, t.entry_price, t.target_price, t.stop_price,
    t.qty, t.allocation, t.status || 'ACTIVE', t.reject_reason || null,
    t.opened_at || new Date().toISOString(),
    t.conviction_score ?? null, t.regime_at_entry ?? null, t.iv_hv_ratio ?? null
  );
  return t.trade_id;
}

function getActiveTrades() {
  return db.prepare(`SELECT * FROM trade_history WHERE status = 'ACTIVE'`).all();
}

function getTradeById(trade_id) {
  return db.prepare('SELECT * FROM trade_history WHERE trade_id = ?').get(trade_id);
}

function getTradesByStatus(status) {
  return db.prepare('SELECT * FROM trade_history WHERE status = ?').all(status);
}

function closeTrade(trade_id, { exit_price, status, holding_days, pnl_pct, pnl_dollar, closed_at }) {
  db.prepare(`
    UPDATE trade_history
    SET exit_price = ?, status = ?, holding_days = ?, pnl_pct = ?, pnl_dollar = ?, closed_at = ?
    WHERE trade_id = ?
  `).run(exit_price, status, holding_days, pnl_pct, pnl_dollar, closed_at || new Date().toISOString(), trade_id);
}

function getRecentClosedTrades(limit = 10) {
  return db.prepare(`
    SELECT * FROM trade_history
    WHERE status IN ('CLOSED_WIN', 'CLOSED_LOSS')
    ORDER BY closed_at DESC LIMIT ?
  `).all(limit);
}

function countClosedTrades() {
  return db.prepare(`SELECT COUNT(*) AS n FROM trade_history WHERE status IN ('CLOSED_WIN','CLOSED_LOSS')`).get().n;
}

function countOpenTrades() {
  return db.prepare(`SELECT COUNT(*) AS n FROM trade_history WHERE status = 'ACTIVE'`).get().n;
}

module.exports = {
  getThresholds, updateThresholds, logTuning, getTuningHistory,
  insertTrade, getActiveTrades, getTradeById, getTradesByStatus, closeTrade,
  getRecentClosedTrades, countClosedTrades, countOpenTrades,
};
