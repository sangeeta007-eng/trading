/**
 * govt/options.js — turns a rating into an actual contract.
 *
 * Reuses council/agent2_structurer.js rather than reimplementing strike and
 * expiry selection. That file already encodes the delta band, the DTE window,
 * the ATR-sized target and stop, the liquidity/spread checks and the
 * feasibility test — a second copy here would drift from it within a week
 * and quietly recommend different contracts on two pages of the same site.
 *
 * Direction follows METHODOLOGY.md's hard gate, not preference:
 *   Stage 2 (BUY / BUY ON DIP) -> CALL
 *   Stage 4 (SELL)             -> PUT
 *   anything else              -> no contract, and the page says why
 *
 * A symbol with no contract is reported as such. It is never filled in with
 * a plausible-looking strike.
 */
const {
  structureContract, spreadCap,
  MIN_OPEN_INTEREST, MAX_PREMIUM_PER_CONTRACT, MIN_DTE_FOR_HOLD,
} = require('../council/agent2_structurer');
const { getOptionsChain, getOptionQuotes, calcDelta } = require('../marketdata');
const { ratingRank } = require('./scan');

// Midpoint of the council's 0.50-0.65 delta band — what a reference contract
// aims at when no contract clears the full recommendation filters.
const REFERENCE_DELTA = 0.575;
// How far off the target delta a contract may be and still be considered,
// so liquidity can break the tie.
const DELTA_TOLERANCE = 0.08;
const MAX_DTE_FOR_REF = 60;

function fmtDate(d) { return d.toISOString().split('T')[0]; }

/**
 * The nearest thing to a tradable contract, whether or not it clears the
 * council's risk filters — so the page can always answer "what strike, what
 * expiry?" instead of a wall of vetoes.
 *
 * This is NOT a second recommendation engine. It selects on delta and DTE
 * only, then reports which of the council's ACTUAL thresholds (imported
 * above, never re-typed) the contract fails. A reference contract that fails
 * a check is rendered as failing it. The distinction between "the engine
 * recommends this" and "this is what the chain looks like" is the whole
 * point, and the page states it on every such row.
 */
async function referenceContract(symbol, bias, spot) {
  const optType = bias === 'CALL' ? 'call' : 'put';
  const today = new Date();
  const minExp = new Date(today); minExp.setDate(today.getDate() + MIN_DTE_FOR_HOLD);
  const maxExp = new Date(today); maxExp.setDate(today.getDate() + MAX_DTE_FOR_REF);

  const chain = await getOptionsChain(
    symbol, optType, fmtDate(minExp), fmtDate(maxExp), spot * 0.75, spot * 1.25
  );
  if (!chain.length) return null;

  // Rank by how close to the target delta, using the same Black-Scholes
  // helper the council uses.
  const scored = chain
    .map(c => ({ c, d: calcDelta(c, spot) }))
    .filter(x => x.d && x.d.delta != null)
    .map(x => ({ ...x, miss: Math.abs(Math.abs(x.d.delta) - REFERENCE_DELTA) }))
    .sort((a, b) => a.miss - b.miss);
  if (!scored.length) return null;

  // Delta alone picked contracts nobody trades — an INTC strike with 0 open
  // interest was chosen over a near-identical delta with 75,000. So among
  // everything within DELTA_TOLERANCE of the target, prefer the liquid one.
  // A reference contract is only useful if it resembles something fillable.
  const best = scored[0];
  const close = scored.filter(x => x.miss <= best.miss + DELTA_TOLERANCE);
  close.sort((a, b) => (b.d.openInterest || 0) - (a.d.openInterest || 0));

  // Live quotes for a handful of the closest, so the printed price is a real
  // bid/ask and not a stale close.
  const top = close.slice(0, 8);
  let quotes = {};
  try { quotes = await getOptionQuotes(top.map(x => x.d.symbol)); } catch { /* fall back to close */ }

  const withQuote = top.find(x => quotes[x.d.symbol]) || top[0];
  const q = quotes[withQuote.d.symbol];
  const mid = q ? q.mid : withQuote.d.midPrice;
  const spread = q ? q.ask - q.bid : null;

  // Which of the council's real thresholds this contract would fail.
  const fails = [];
  if (mid * 100 > MAX_PREMIUM_PER_CONTRACT) {
    fails.push(`costs $${(mid * 100).toFixed(0)} per contract, over the $${MAX_PREMIUM_PER_CONTRACT} cap`);
  }
  if (withQuote.d.openInterest < MIN_OPEN_INTEREST) {
    fails.push(`open interest ${withQuote.d.openInterest} is under ${MIN_OPEN_INTEREST}`);
  }
  if (spread != null && spread > spreadCap(mid)) {
    fails.push(`bid/ask spread $${spread.toFixed(2)} is wider than the $${spreadCap(mid).toFixed(2)} allowed`);
  }
  if (!q) fails.push('no live quote — price shown is the last close');

  return {
    optType,
    style: withQuote.c.style || null,
    strike: withQuote.d.strike,
    expiration: withQuote.d.expDate,
    dte: Math.round((new Date(withQuote.d.expDate) - today) / 86400000),
    delta: withQuote.d.delta,
    iv: withQuote.d.iv,
    bid: q ? q.bid : null,
    ask: q ? q.ask : null,
    mid,
    costPerContract: mid * 100,
    openInterest: withQuote.d.openInterest,
    fails,
  };
}

// Which ratings are tradable at all, and in which direction.
const BIAS_FOR = {
  'BUY': 'CALL',
  'BUY ON DIP': 'CALL',
  'SELL': 'PUT',
};

function biasFor(rating) {
  return BIAS_FOR[rating] || null;
}

/**
 * Structure a contract for one measured symbol. Never throws: an options
 * chain that is missing, illiquid or too thin is a normal outcome for the
 * microcaps in this universe, and must show as "no contract" rather than
 * taking down the page.
 */
async function structureFor(m) {
  const bias = biasFor(m.rating);
  if (!bias) {
    return {
      ok: false,
      skipped: true,
      reason: m.rating === 'HOLD'
        ? 'No contract: HOLD is not a tradable stage — a CALL needs Stage 2, a PUT needs Stage 4.'
        : 'No contract: AVOID means no long entry, and it is not a confirmed downtrend either, so neither side qualifies.',
    };
  }

  try {
    const s = await structureContract(m.symbol, bias, m.price);
    if (s.ok) return { ...s, bias, cleared: true };

    // Vetoed. Most vetoes in this universe are risk-budget or liquidity
    // limits (premium cap, open interest) rather than "the chart is wrong",
    // and answering "what strike, what expiry?" with a wall of vetoes would
    // fail the question. So fall back to a reference contract and show it
    // plainly as not cleared, with the reason attached.
    let reference = null;
    try { reference = await referenceContract(m.symbol, bias, m.price); }
    catch { /* reference is a nicety; its failure must not mask the veto */ }

    return {
      ok: false, cleared: false, bias, reference,
      reason: s.detail || s.vetoReason || 'did not clear the council filters',
    };
  } catch (err) {
    return { ok: false, cleared: false, bias, reason: `Chain lookup failed: ${err.response?.data?.message || err.message}` };
  }
}

/**
 * Structure contracts across a scan. Sequential on purpose — each call
 * paginates an options chain, and firing 20 of those at the market-data API
 * at once invites rate-limiting, which would show up as phantom "no
 * contract" rows.
 *
 * `limit` caps how many are attempted so a refresh stays a reasonable wait;
 * the strongest-rated symbols are structured first, and the rest are
 * labelled as not attempted rather than silently omitted. Measured at ~0.5s
 * per symbol, so the default comfortably covers this universe — it exists to
 * bound the wait if the ledger grows, not because 20 is expensive today.
 */
async function structureAll(rows, { limit = 30 } = {}) {
  const tradable = rows.filter(r => biasFor(r.rating));
  // Best first, using the page's single shared verdict order rather than a
  // private copy — when `limit` bites, the symbols that get structured must
  // be the ones that appear at the top of the tables.
  const ordered = [...tradable].sort((a, b) => ratingRank(a.rating) - ratingRank(b.rating) || b.score - a.score);

  const out = new Map();
  for (const m of ordered.slice(0, limit)) {
    out.set(m.symbol, await structureFor(m));
  }
  for (const m of ordered.slice(limit)) {
    out.set(m.symbol, { ok: false, notAttempted: true, reason: `Not attempted this run — only the top ${limit} rated symbols are structured, to keep a refresh under a minute or so.` });
  }
  for (const m of rows.filter(r => !biasFor(r.rating))) {
    out.set(m.symbol, await structureFor(m));
  }
  return out;
}

module.exports = { structureAll, structureFor, biasFor };
