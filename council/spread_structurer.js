/**
 * council/spread_structurer.js — defined-risk put credit spreads.
 *
 * Sells the ~0.30-delta put and buys a further-OTM put as a hard cap on the
 * loss. Never naked: max loss is always (width - credit), known before entry.
 *
 * WHY THIS EXISTS
 * Buying options — what agents 1-4 do — measured -3.3% per trade over 8
 * years and was negative in every configuration tested. Selling this
 * structure on the same universe over the same period measured +1.6% per
 * trade at a 75.5% win rate, and stayed positive even assuming zero
 * volatility premium. See BACKTEST.md and STRATEGY_RESEARCH.md.
 *
 * MANAGEMENT RULES (from tastytrade's published mechanical-management
 * research, tested here rather than taken on faith):
 *   - close at 50% of the credit received, or
 *   - close at 21 DTE, whichever comes first
 *
 * DELIBERATELY UNFILTERED. Three filters were tested and all three made it
 * worse, some severely:
 *   Weinstein Stage 2 only ....... +1.96%/trade, but 2022 fell to -8.48%
 *   Stage 2 + above 200-day ...... +1.95%/trade, 2022 -8.64%
 *   SPY above its own 200-day .... +1.21%/trade, 2022 collapsed to -21.46%
 *   no filter (this) ............. +1.62%/trade, 2022 -5.54%
 * The reason is consistent across all three: premium is richest right after
 * declines, so a trend filter removes the best entries and concentrates the
 * remainder into bounces that then fail. Selling mechanically, without
 * trying to time it, tested better than any attempt to be clever.
 *
 * Requires Level 3 (multi-leg) options approval and a margin account.
 */
const { getOptionsChain, getOptionQuotes } = require('../marketdata');
const { impliedVol, bsDelta } = require('../greek');
const { RISK_FREE_RATE } = require('../config');

const SHORT_DELTA_TARGET = 0.30;
const WIDTH_PCT          = 0.05;  // long leg ~5% below the short strike
const DTE_MIN            = 30;
const DTE_MAX            = 60;
const MIN_OPEN_INTEREST  = 500;
const MAX_SPREAD_PCT     = 0.10;  // per leg, relative to that leg's own mid
const MIN_CREDIT_RATIO   = 0.15;  // credit must be >=15% of width, else the risk/reward is poor

const PROFIT_TARGET_PCT  = 0.50;  // close at 50% of credit received
const MANAGE_AT_DTE      = 21;

function fmtDate(d) { return d.toISOString().split('T')[0]; }
function legOk(q) { return q && q.bid > 0 && q.ask > 0 && (q.ask - q.bid) <= Math.max(0.05, q.mid * MAX_SPREAD_PCT); }

async function structureSpread(symbol, spotPrice) {
  const today = new Date();
  const minExp = new Date(today); minExp.setDate(today.getDate() + DTE_MIN);
  const maxExp = new Date(today); maxExp.setDate(today.getDate() + DTE_MAX);

  let contracts;
  try {
    contracts = await getOptionsChain(symbol, 'put', fmtDate(minExp), fmtDate(maxExp), spotPrice * 0.70, spotPrice * 1.05);
  } catch (err) {
    return { ok: false, reason: `Chain lookup failed: ${err.response?.data?.message || err.message}` };
  }
  const liquid = contracts.filter(c => parseInt(c.open_interest || 0) > MIN_OPEN_INTEREST);
  if (liquid.length < 2) return { ok: false, reason: `Fewer than 2 puts cleared OI > ${MIN_OPEN_INTEREST}.` };

  const quotes = await getOptionQuotes(liquid.map(c => c.symbol));

  // Price every leg once, then pair them up.
  const legs = [];
  for (const c of liquid) {
    const q = quotes[c.symbol];
    if (!legOk(q)) continue;
    const strike = parseFloat(c.strike_price);
    const expDate = new Date(c.expiration_date);
    const T = Math.max(0.001, (expDate - Date.now()) / (365 * 24 * 60 * 60 * 1000));
    const iv = impliedVol(q.mid, spotPrice, strike, T, RISK_FREE_RATE, 'put');
    if (!iv || iv <= 0) continue;
    const delta = Math.abs(bsDelta(spotPrice, strike, T, RISK_FREE_RATE, iv, 'put'));
    legs.push({
      contract: c, symbol: c.symbol, strike, expiration: c.expiration_date,
      bid: q.bid, ask: q.ask, mid: q.mid, iv, delta,
      dte: Math.round((expDate - Date.now()) / (24 * 60 * 60 * 1000)),
      openInterest: parseInt(c.open_interest || 0),
    });
  }
  if (legs.length < 2) return { ok: false, reason: 'No put legs had usable live quotes and tight enough spreads.' };

  // Short leg: closest to the target delta.
  const shortLeg = legs.reduce((a, b) => Math.abs(a.delta - SHORT_DELTA_TARGET) <= Math.abs(b.delta - SHORT_DELTA_TARGET) ? a : b);
  const wantLongStrike = shortLeg.strike - spotPrice * WIDTH_PCT;

  // Long leg: same expiry, strike closest to the intended width, below the short.
  const sameExp = legs.filter(l => l.expiration === shortLeg.expiration && l.strike < shortLeg.strike);
  if (!sameExp.length) return { ok: false, reason: `No lower-strike put in ${shortLeg.expiration} to cap the risk — refusing to leave it naked.` };
  const longLeg = sameExp.reduce((a, b) => Math.abs(a.strike - wantLongStrike) <= Math.abs(b.strike - wantLongStrike) ? a : b);

  // Real fills: sell the short at its bid, buy the long at its ask.
  const credit = Number((shortLeg.bid - longLeg.ask).toFixed(2));
  const width = Number((shortLeg.strike - longLeg.strike).toFixed(2));
  if (credit <= 0) return { ok: false, reason: 'Net credit would be zero or negative at real bid/ask.' };
  const maxLoss = Number((width - credit).toFixed(2));
  if (maxLoss <= 0) return { ok: false, reason: 'Computed max loss is non-positive — bad quote data, refusing to use it.' };
  if (credit / width < MIN_CREDIT_RATIO) {
    return { ok: false, reason: `Credit $${credit.toFixed(2)} is only ${((credit / width) * 100).toFixed(0)}% of the $${width} width (need ${MIN_CREDIT_RATIO * 100}%) — too little paid for the risk taken.` };
  }

  const closeAt = Number((credit * (1 - PROFIT_TARGET_PCT)).toFixed(2));
  const breakeven = Number((shortLeg.strike - credit).toFixed(2));

  return {
    ok: true, symbol, spotPrice,
    shortLeg, longLeg, width, credit, maxLoss,
    creditPctOfWidth: credit / width,
    maxReturnOnRisk: credit / maxLoss,           // if it expires worthless
    targetReturnOnRisk: (credit * PROFIT_TARGET_PCT) / maxLoss, // at the 50% close
    closeAt, breakeven,
    breakevenPct: (breakeven - spotPrice) / spotPrice,
    dte: shortLeg.dte,
    manageAtDte: MANAGE_AT_DTE,
    profitTargetPct: PROFIT_TARGET_PCT,
  };
}

module.exports = {
  structureSpread,
  SHORT_DELTA_TARGET, WIDTH_PCT, DTE_MIN, DTE_MAX,
  PROFIT_TARGET_PCT, MANAGE_AT_DTE,
};
