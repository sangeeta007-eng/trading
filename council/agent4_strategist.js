/**
 * Agent 4 — Chief Strategist & Auto-Learning Engine ("The Planner")
 *
 * Synthesizes Agents 1-3 into a human-readable, fully-grounded report with
 * exact manual trade instructions (you place these yourself on your own
 * broker — usually Robinhood), and archives every proposal (approved or
 * rejected) to trade_history for the learning loop. This tool never places
 * a real order — see marketdata.js, which is read-only market data by design.
 */
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { IV_RANK_MIN_SAMPLE } = require('./agent3_risk');

function bar(ch = '=') { return ch.repeat(80); }

function buildVetoReport({ analysis, structured, risk }) {
  const reason = risk?.vetoReason || structured?.vetoReason || 'DATA_INSUFFICIENT';
  const detail = risk?.detail || structured?.detail || 'No further detail.';
  return [
    bar(), '                 4-AGENT TRADE RECOMMENDATION — NO TRADE', bar(),
    `Ticker: ${analysis.symbol}`,
    `Agent 1 Bias: ${analysis.bias}`,
    `Veto: ${reason}`,
    `Detail: ${detail}`,
    bar(),
  ].join('\n');
}

function buildReport({ analysis, structured, risk }) {
  const action = structured.optType === 'call' ? 'BUY TO OPEN (CALL OPTION)' : 'BUY TO OPEN (PUT OPTION)';
  const contractLabel = `${structured.symbol} ${structured.expiration} $${structured.strike} ${structured.optType.toUpperCase()}`;

  const lines = [];
  lines.push(bar());
  lines.push('                    4-AGENT TRADE RECOMMENDATION REPORT');
  lines.push(bar());
  lines.push('');
  lines.push('[SUMMARY & RECOMMENDATION]');
  lines.push(`Action: ${action}`);
  lines.push(`Ticker: ${structured.symbol}`);
  lines.push(`Contract: ${contractLabel}`);
  lines.push(`Position Sizing: ${risk.qty} Contracts (~$${risk.tradeCost.toFixed(0)} / ${(risk.allocationPct * 100).toFixed(1)}% of configured capital)`);
  lines.push(`Rough Probability of Finishing ITM: ~${(structured.delta * 100).toFixed(0)}% (delta itself — a standard options-theory approximation, not a backtested model; treat as directional context, not a precise forecast)`);
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('[AGENT 1: MARKET ANALYST LOGIC]');
  analysis.reasonLines.forEach(l => lines.push(`• ${l}`));
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('[AGENT 2: OPTION STRUCTURER CALCULATIONS]');
  lines.push(`• Selected Expiry: ${structured.expiration} (${structured.dte} DTE)`);
  lines.push(`• Selected Strike: $${structured.strike.toFixed(2)} (Delta: ${structured.delta.toFixed(2)}, IV: ${(structured.iv * 100).toFixed(1)}%, IV Rank: ${structured.ivRank.toFixed(0)})`);
  lines.push(`• Liquidity: OI ${structured.openInterest} / Vol ${structured.volume} (${structured.liquidityNote})`);
  lines.push(`• Entry Pricing (slippage-adjusted): Bid $${structured.bid.toFixed(2)} / Ask $${structured.ask.toFixed(2)} -> Entry = Ask = $${structured.entryLimit.toFixed(2)} (what you'd actually pay on a marketable order)`);
  lines.push(`• Underlying Volatility: ${structured.symbol} ATR(14) = $${structured.underlyingATR.toFixed(2)}/day (avg true range — real, not guessed)`);
  lines.push(`• Target Sell Calculation: ${structured.targetAtrMult}x ATR × Delta ${structured.delta.toFixed(2)} = ${(structured.targetPct * 100).toFixed(1)}% move${structured.targetClamped ? ' (clamped to the 15-35% band)' : ''} -> Entry $${structured.entryLimit.toFixed(2)} -> Round UP ($${structured.tick} tick) = $${structured.targetLimit.toFixed(2)} (+${(((structured.targetLimit / structured.entryLimit) - 1) * 100).toFixed(1)}%)`);
  lines.push(`• Stop-Loss Calculation: ${structured.stopAtrMult}x ATR × Delta ${structured.delta.toFixed(2)} = ${(structured.stopPct * 100).toFixed(1)}% move${structured.stopClamped ? ' (clamped to the 8-20% band)' : ''} -> Entry $${structured.entryLimit.toFixed(2)} -> Round DOWN ($${structured.tick} tick) = $${structured.stopLimit.toFixed(2)} (${(((structured.stopLimit / structured.entryLimit) - 1) * 100).toFixed(1)}%)`);
  lines.push(`• Expected Move Check: underlying needs to move ~$${structured.requiredMove.toFixed(2)} (${structured.targetAtrMult}x ATR) to hit target; the option market itself expects ~$${structured.expectedMove.toFixed(2)} by expiration (target is within the market's own expected range)`);
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('[AGENT 3: RISK GUARDIAN VALIDATION]');
  lines.push(`• Configured Capital: $${risk.capital.toFixed(2)} (set TOTAL_BUDGET in .env to match your real account)`);
  lines.push(`• Allocation Band: $${risk.allocationMin.toFixed(2)} - $${risk.allocationMax.toFixed(2)} (10-15%)`);
  lines.push(`• Recommended Cost: ${risk.qty} Contracts × $${structured.entryLimit.toFixed(2)} × 100 = $${risk.tradeCost.toFixed(2)} [APPROVED]`);
  lines.push(`• Active Recommendations: ${risk.openPositions} / ${risk.maxOpenPositions} [APPROVED]`);
  lines.push(`• Weekly Drawdown (hypothetical): ${(risk.weeklyDrawdownPct * 100).toFixed(1)}% (limit 5%) [APPROVED]`);
  lines.push(`• Net Directional Exposure: ${risk.netExposureBefore.toFixed(2)} -> ${risk.netExposureAfter.toFixed(2)} (cap ±1.3, correlation proxy) [APPROVED]`);
  lines.push(`• Conviction: ${risk.conviction}/100 (IV favorability ${risk.ivFavorability.toFixed(0)}${risk.ivHvRatio != null ? `, IV/HV ${risk.ivHvRatio.toFixed(2)}` : ''}) -> allocation ${(risk.allocationPct * 100).toFixed(1)}% of capital`);
  lines.push(risk.ivGateActive
    ? `• IV Safety Gates: ACTIVE (${risk.ivSampleSize} days of IV history — IV Rank veto and IV/HV ratio veto both live for ${structured.symbol})`
    : `• IV Safety Gates: NOT YET ACTIVE for ${structured.symbol} — only ${risk.ivSampleSize}/${IV_RANK_MIN_SAMPLE} days of IV history collected. The IV Rank veto and IV/HV ratio veto are both skipped (not passed) until then — this pick isn't protected by those two checks yet.`);
  lines.push('• Status: RECOMMENDED');
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('[AGENT 4: MANUAL TRADE INSTRUCTIONS — place these yourself]');
  lines.push('This tool does not place real orders. Enter these manually on your broker');
  lines.push('(Fidelity/Robinhood). We track the outcome using real market quotes so');
  lines.push('future reports show whether it hit target or stop — but the actual trade,');
  lines.push('fill price, and execution are entirely up to you.');
  lines.push('');
  lines.push('1. ENTRY:');
  lines.push(`   - Action: BUY TO OPEN | Symbol: ${structured.contractSymbol} | Quantity: ${risk.qty}`);
  lines.push(`   - Suggested: LIMIT @ $${structured.entryLimit.toFixed(2)} (current ask; adjust to live bid/ask when you place it)`);
  lines.push('');
  lines.push('2. TAKE PROFIT:');
  lines.push(`   - Action: SELL TO CLOSE | Quantity: ${risk.qty} | LIMIT @ $${structured.targetLimit.toFixed(2)} (+${(((structured.targetLimit / structured.entryLimit) - 1) * 100).toFixed(1)}%)`);
  lines.push('');
  lines.push('3. STOP LOSS:');
  lines.push(`   - Action: SELL TO CLOSE | Quantity: ${risk.qty} | STOP @ $${structured.stopLimit.toFixed(2)} (${(((structured.stopLimit / structured.entryLimit) - 1) * 100).toFixed(1)}%)`);
  lines.push(bar());

  return lines.join('\n');
}

// Logs every proposal to trade_history. Approved ones become ACTIVE
// recommendations immediately (assumed entry = the computed limit price) —
// there is no order to wait on since nothing is actually submitted anywhere.
async function finalize({ analysis, structured, risk, regime }) {
  const trade_id = uuidv4();

  if (!risk.approved) {
    db.insertTrade({
      trade_id, ticker: analysis.symbol, option_type: structured.optType || 'n/a',
      contract_symbol: structured.contractSymbol || 'n/a', strike: structured.strike || null,
      expiration: structured.expiration || null, delta: structured.delta || null,
      rsi_at_entry: analysis.rsi || null, iv_at_entry: structured.iv || null,
      entry_price: structured.entryLimit || null, target_price: structured.targetLimit || null,
      stop_price: structured.stopLimit || null, qty: 0, allocation: 0,
      status: 'REJECTED', reject_reason: risk.vetoReason,
      regime_at_entry: regime?.name || null,
    });
    return { trade_id, report: buildVetoReport({ analysis, structured, risk }) };
  }

  const report = buildReport({ analysis, structured, risk });

  db.insertTrade({
    trade_id, ticker: structured.symbol, option_type: structured.optType,
    contract_symbol: structured.contractSymbol, strike: structured.strike,
    expiration: structured.expiration, delta: structured.delta,
    rsi_at_entry: analysis.rsi, iv_at_entry: structured.iv,
    entry_price: structured.entryLimit, target_price: structured.targetLimit,
    stop_price: structured.stopLimit,
    qty: risk.qty, allocation: risk.tradeCost, status: 'ACTIVE',
    conviction_score: risk.conviction ?? null, regime_at_entry: regime?.name || null, iv_hv_ratio: risk.ivHvRatio ?? null,
  });

  return { trade_id, report };
}

module.exports = { buildReport, buildVetoReport, finalize };
