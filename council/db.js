/**
 * council/db.js — SQLite persistence for the 4-Agent Options Trading Council.
 * Uses Node's built-in node:sqlite (no native build step required).
 *
 * This is a recommendation tracker, not a broker order ledger — there are no
 * order IDs or fill confirmations here. A recommendation becomes ACTIVE the
 * moment Agent 3 approves it (assumed entry = the computed limit price), and
 * council/sync.js later closes it out by comparing real live market quotes
 * against the stored target/stop/expiry — never a real account fill.
 *
 * WHY THE DATABASE HANDLE IS NOT KEPT OPEN
 *
 * This module used to do `const db = new DatabaseSync(DB_PATH)` at load time
 * and hold that handle for the life of the process. Fine for a CLI run that
 * exits in seconds; not fine for server.js, which runs for days. On Windows an
 * open handle prevents the file from being replaced, and because CI also
 * commits council.db, every `git pull` attempted while the dashboard was
 * running died with:
 *
 *     error: unable to unlink old 'council/council.db': Invalid argument
 *
 * The fix is not to stop tracking the database or to stop pulling — it is to
 * stop holding the file open. Every operation here is short and synchronous,
 * so each one opens the file, does its work, and closes it. Between calls,
 * which is virtually all of the time, nothing holds the file and git can
 * replace it freely.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'council.db');

const SCHEMA = `
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
`;

// SQLite serialises writers with a file lock. Short-lived connections make
// contention rare, but a local CLI session and the dashboard can still
// overlap, so a busy database is retried briefly rather than thrown straight
// back at the caller.
const BUSY_RETRIES = 5;
const BUSY_PAUSE_MS = 40;

// These operations are synchronous by design (node:sqlite is a sync API), so
// the pause has to be synchronous too — setTimeout would return control and
// let the caller proceed as though the write had happened.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Open the database, ensure the schema, run `fn`, and always close.
 *
 * The schema is ensured on every open rather than once per process. At these
 * table counts that costs microseconds, and it is precisely what keeps this
 * module correct when the file underneath it is swapped out mid-process by
 * the git checkout described at the top of this file.
 */
function withDb(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    let db;
    try {
      db = new DatabaseSync(DB_PATH);
      db.exec(SCHEMA);
      db.prepare(`
        INSERT OR IGNORE INTO thresholds (id, delta_min, delta_max, dte_min, dte_max, updated_at, note)
        VALUES (1, 0.50, 0.65, 21, 45, ?, 'default (PRD baseline)')
      `).run(new Date().toISOString());
      return fn(db);
    } catch (err) {
      lastErr = err;
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(err.message)) throw err;
      sleepSync(BUSY_PAUSE_MS * (attempt + 1));
    } finally {
      // Close on every path, including the throwing one — a leaked handle
      // here would reintroduce exactly the lock this design exists to remove.
      try { if (db) db.close(); } catch { /* already closed */ }
    }
  }
  throw lastErr;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

function getThresholds() {
  return withDb(db => db.prepare('SELECT * FROM thresholds WHERE id = 1').get());
}

function updateThresholds({ delta_min, delta_max, dte_min, dte_max }, note) {
  withDb(db => db.prepare(`
    UPDATE thresholds SET delta_min = ?, delta_max = ?, dte_min = ?, dte_max = ?, updated_at = ?, note = ?
    WHERE id = 1
  `).run(delta_min, delta_max, dte_min, dte_max, new Date().toISOString(), note || null));
}

function logTuning({ trigger_reason, old_values, new_values, win_rate, avg_holding_days }) {
  withDb(db => db.prepare(`
    INSERT INTO learning_log (tuned_at, trigger_reason, old_values, new_values, win_rate, avg_holding_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), trigger_reason, JSON.stringify(old_values), JSON.stringify(new_values), win_rate ?? null, avg_holding_days ?? null));
}

function getTuningHistory(limit = 20) {
  return withDb(db => db.prepare('SELECT * FROM learning_log ORDER BY id DESC LIMIT ?').all(limit));
}

// ── Recommendation lifecycle ────────────────────────────────────────────────

function insertTrade(t) {
  withDb(db => db.prepare(`
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
  ));
  return t.trade_id;
}

function getActiveTrades() {
  return withDb(db => db.prepare(`SELECT * FROM trade_history WHERE status = 'ACTIVE'`).all());
}

function getTradeById(trade_id) {
  return withDb(db => db.prepare('SELECT * FROM trade_history WHERE trade_id = ?').get(trade_id));
}

function getTradesByStatus(status) {
  return withDb(db => db.prepare('SELECT * FROM trade_history WHERE status = ?').all(status));
}

function closeTrade(trade_id, { exit_price, status, holding_days, pnl_pct, pnl_dollar, closed_at }) {
  withDb(db => db.prepare(`
    UPDATE trade_history
    SET exit_price = ?, status = ?, holding_days = ?, pnl_pct = ?, pnl_dollar = ?, closed_at = ?
    WHERE trade_id = ?
  `).run(exit_price, status, holding_days, pnl_pct, pnl_dollar, closed_at || new Date().toISOString(), trade_id));
}

function getRecentClosedTrades(limit = 10) {
  return withDb(db => db.prepare(`
    SELECT * FROM trade_history
    WHERE status IN ('CLOSED_WIN', 'CLOSED_LOSS')
    ORDER BY closed_at DESC LIMIT ?
  `).all(limit));
}

function countClosedTrades() {
  return withDb(db => db.prepare(`SELECT COUNT(*) AS n FROM trade_history WHERE status IN ('CLOSED_WIN','CLOSED_LOSS')`).get().n);
}

function countOpenTrades() {
  return withDb(db => db.prepare(`SELECT COUNT(*) AS n FROM trade_history WHERE status = 'ACTIVE'`).get().n);
}

module.exports = {
  getThresholds, updateThresholds, logTuning, getTuningHistory,
  insertTrade, getActiveTrades, getTradeById, getTradesByStatus, closeTrade,
  getRecentClosedTrades, countClosedTrades, countOpenTrades,
};
