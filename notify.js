const nodemailer = require('nodemailer');
require('dotenv').config();

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function send(subject, text, html) {
  console.log('\n' + text);
  if (!process.env.GMAIL_APP_PASSWORD) { console.log('[notify] No password set — console only.'); return; }
  await getTransporter().sendMail({
    from: `"Trading Council" <${process.env.GMAIL_USER}>`,
    to:   process.env.NOTIFY_EMAIL,
    subject, text, html,
  });
  console.log(`[notify] ✉️  Sent → ${process.env.NOTIFY_EMAIL}`);
}

// ── Plain-text formatting (console log + email fallback) ───────────────────

function dirLabel(direction) {
  return direction === 'Bullish' ? '📈 CALL' : '📉 PUT';
}

function formatRecommendation(c, i) {
  const leg1 = c.leg1;
  return `
┌─ RECOMMENDATION ${i + 1} ── ${c.direction.toUpperCase()} ──────────────────
│ ${dirLabel(c.direction)} — place this manually on your broker
│ 🏷️  Underlying ETF:  ${c.symbol}
│ 📊 IV Rank:          ${c.ivRank?.toFixed(0) ?? '—'}
│
│   Contract:  ${leg1.contract.symbol}
│   Strike:    $${leg1.contract.strike_price}  (Δ${leg1.delta.toFixed(2)})
│   Expiry:    ${leg1.contract.expiration_date}
│   Buy Limit: $${leg1.limitPrice} × ${leg1.qty} contracts (~$${c.netDebit.toFixed(0)})
│
│ 💡 ${c.reason}
└${'─'.repeat(60)}`;
}

function formatPlaybookItem(item, i) {
  const pnlStr = item.unrealizedPct != null
    ? `${item.unrealizedPct >= 0 ? '+' : ''}${(item.unrealizedPct * 100).toFixed(1)}% (${item.unrealizedDollar >= 0 ? '+' : ''}$${item.unrealizedDollar.toFixed(0)})`
    : 'no live quote';
  const dte = item.daysToExpiry != null ? `${item.daysToExpiry.toFixed(0)}d to expiry` : 'expiry unknown';
  // Target/stop % is ATR-derived per symbol now (not a flat 12%/10%) — always
  // compute it from the actual prices rather than hardcode a label that can
  // now be wrong.
  const targetPct = (item.entryLimit && item.target != null) ? ((item.target / item.entryLimit - 1) * 100).toFixed(1) : null;
  const stopPct = (item.entryLimit && item.stop != null) ? ((item.stop / item.entryLimit - 1) * 100).toFixed(1) : null;

  return `
┌─ RECOMMENDATION ${i + 1} ── ${item.symbol} (${item.optionType.toUpperCase()}) ── ${item.underlying} ────
│ Strike: $${item.strike?.toFixed(2)}  |  Expiry: ${item.expiration} (${dte})  |  Qty: ${item.qty}
│ Recommended Entry: LIMIT $${item.entryLimit?.toFixed(2)}
│ Target: SELL @ $${item.target?.toFixed(2)}${targetPct != null ? ` (+${targetPct}%)` : ''}
│ Stop:   SELL @ $${item.stop?.toFixed(2)}${stopPct != null ? ` (${stopPct}%)` : ''}
│ Now (live): ${item.currentPrice != null ? '$' + item.currentPrice.toFixed(2) : '—'}  |  Hypothetical P&L: ${pnlStr}  |  Recommended ${item.daysHeld.toFixed(1)}d ago
└${'─'.repeat(60)}`;
}

function formatWatchlistItem(w) {
  const icon = w.tier === 'HOT' ? '🔥 HOT ' : '🌤️  WARM';
  const dirLabel = w.bias === 'CALL' ? 'CALL (bullish)' : 'PUT (bearish)';
  const contractLine = w.contract
    ? `Strike $${w.contract.strike.toFixed(2)} | Exp ${w.contract.expiration} | Δ${w.contract.delta.toFixed(2)} | Entry ~$${w.contract.entryLimit.toFixed(2)} | Target $${w.contract.targetLimit.toFixed(2)} | Stop $${w.contract.stopLimit.toFixed(2)}`
    : 'No live contract selected yet';
  const statusLine = w.tier === 'HOT'
    ? 'ACTIONABLE NOW — this is in the recommendations below, place it manually'
    : `Not yet actionable — ${w.blockedDetail || w.blockedReason || 'pending better conditions'}`;

  return `   ${icon}  ${w.symbol.padEnd(6)} ${dirLabel.padEnd(16)} conviction ${w.conviction}/100
        ${contractLine}
        ${statusLine}`;
}

function formatOutcome(e, i) {
  const pnlStr = e.pnl != null ? (e.pnl >= 0 ? `+$${e.pnl.toFixed(2)}` : `-$${Math.abs(e.pnl).toFixed(2)}`) : '—';
  return `
┌─ OUTCOME ${i + 1} (hypothetical) ─────────────────────────────
│ 📋 Contract:  ${e.symbol}
│ 📍 ${e.reason}
│ 💰 P&L:       ${pnlStr}  (${e.pnlPct != null ? (e.pnlPct * 100).toFixed(1) + '%' : '—'})
└${'─'.repeat(60)}`;
}

function buildTextBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, ts, target }) {
  const recommendationBlock = newCampaigns.length
    ? newCampaigns.map((c, i) => formatRecommendation(c, i)).join('\n')
    : '  No new recommendations this session.';

  const outcomeBlock = exits.length
    ? exits.map((e, i) => formatOutcome(e, i)).join('\n')
    : '  No positions closed out this session.';

  const hot = watchlist.filter(w => w.tier === 'HOT');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  const watchlistBlock = watchlist.length
    ? [...hot, ...warm].map(formatWatchlistItem).join('\n')
    : '   Nothing hot or warm this session — no qualifying setups.';

  const playbookBlock = playbook.length
    ? playbook.map((p, i) => formatPlaybookItem(p, i)).join('\n')
    : '  No active recommendations.';

  const totalDeployed = newCampaigns.reduce((s, c) => s + c.netDebit, 0);
  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const regimeLine = `${regime.name} | VIX ~${regime.vix?.toFixed(1)} | Sizing ${(regime.sizingMod * 100).toFixed(0)}%`;
  const weekProgress = `$${weeklyPnL.toFixed(2)} / $${target} target (${((weeklyPnL / target) * 100).toFixed(0)}%)`;

  return `
╔══════════════════════════════════════════════════════╗
   4-AGENT TRADING COUNCIL — DAILY RECOMMENDATIONS
   ${ts} ET
╚══════════════════════════════════════════════════════╝

This is a recommendation-only report. Nothing here was traded automatically
— review it and place any trades yourself on your own broker.

📊 MARKET REGIME
   ${regimeLine}

📈 SESSION SNAPSHOT
   New recommendations:   ${newCampaigns.length}
   Positions closed out:  ${exits.length}
   Capital recommended:   $${totalDeployed.toFixed(0)}
   Session P&L (hypothetical): ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(2)}
   Weekly P&L progress (hypothetical): ${weekProgress}

══ 🔥 HOT & 🌤️  WARM WATCHLIST ═════════════════════════
   HOT = actionable now — see the recommendation below.
   WARM = real setup, good potential, not yet actionable — may take a
          few days (waiting on a portfolio slot or better pricing).
${watchlistBlock}

══ NEW RECOMMENDATIONS — place these manually ═════════
${recommendationBlock}

══ POSITIONS CLOSED OUT (hypothetical) ═════════════════
${outcomeBlock}

══ ACTIVE RECOMMENDATIONS — exact entry/exit ═══════════
${playbookBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Weekly P&L (hypothetical): ${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}
Monthly P&L (hypothetical): ${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— 4-Agent Options Trading Council 🤖
`;
}

// ── HTML formatting (tables + color) ────────────────────────────────────────

const COLOR = {
  hot: '#dc2626', hotBg: '#fef2f2', hotBorder: '#fecaca',
  warm: '#d97706', warmBg: '#fffbeb', warmBorder: '#fde68a',
  target: '#16a34a', stop: '#dc2626', text: '#111827', muted: '#6b7280', border: '#e5e7eb',
};

function td(content, style = '') {
  return `<td style="padding:8px 10px; border:1px solid ${COLOR.border}; font-size:13px; color:${COLOR.text}; ${style}">${content}</td>`;
}

function th(content) {
  return `<th style="padding:8px 10px; border:1px solid ${COLOR.border}; font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:#fff; text-align:left;">${content}</th>`;
}

function tableWrap(title, titleColor, headerBg, headers, rowsHtml, emptyMsg) {
  const body = rowsHtml || `<tr>${td(emptyMsg, `color:${COLOR.muted}; font-style:italic;`)}${headers.slice(1).map(() => '<td style="border:1px solid ' + COLOR.border + ';"></td>').join('')}</tr>`;
  return `
  <div style="margin:20px 0;">
    <div style="font-size:15px; font-weight:700; color:${titleColor}; margin-bottom:8px;">${title}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:Arial,Helvetica,sans-serif;">
      <thead><tr style="background:${headerBg};">${headers.map(th).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function convictionBadge(conviction) {
  const color = conviction >= 70 ? COLOR.target : conviction >= 50 ? COLOR.warm : COLOR.muted;
  return `<span style="color:${color}; font-weight:700;">${conviction}/100</span>`;
}

function buildHotRows(hot) {
  return hot.map(w => {
    const c = w.contract;
    return `<tr style="background:${COLOR.hotBg};">
      ${td(`<b>${w.symbol}</b>`)}
      ${td(w.bias === 'CALL' ? '▲ CALL' : '▼ PUT', `color:${w.bias === 'CALL' ? COLOR.target : COLOR.stop}; font-weight:600;`)}
      ${td(c ? '$' + c.strike.toFixed(2) : '—')}
      ${td(c ? c.expiration : '—')}
      ${td(c ? 'Δ' + c.delta.toFixed(2) : '—')}
      ${td(c ? '$' + c.entryLimit.toFixed(2) : '—')}
      ${td(c ? '$' + c.targetLimit.toFixed(2) + ' (+' + ((c.targetLimit / c.entryLimit - 1) * 100).toFixed(1) + '%)' : '—', `color:${COLOR.target}; font-weight:700;`)}
      ${td(c ? '$' + c.stopLimit.toFixed(2) + ' (' + ((c.stopLimit / c.entryLimit - 1) * 100).toFixed(1) + '%)' : '—', `color:${COLOR.stop}; font-weight:700;`)}
      ${td(convictionBadge(w.conviction))}
    </tr>`;
  }).join('');
}

function buildWarmRows(warm) {
  return warm.map(w => {
    const c = w.contract;
    return `<tr style="background:${COLOR.warmBg};">
      ${td(`<b>${w.symbol}</b>`)}
      ${td(w.bias === 'CALL' ? '▲ CALL' : '▼ PUT', `color:${w.bias === 'CALL' ? COLOR.target : COLOR.stop}; font-weight:600;`)}
      ${td(convictionBadge(w.conviction))}
      ${td(c ? '$' + c.entryLimit.toFixed(2) : '—')}
      ${td(c ? '$' + c.targetLimit.toFixed(2) : '—', c ? `color:${COLOR.target};` : '')}
      ${td(c ? '$' + c.stopLimit.toFixed(2) : '—', c ? `color:${COLOR.stop};` : '')}
      ${td(w.blockedDetail || w.blockedReason || 'pending better conditions', `color:${COLOR.muted}; font-size:12px;`)}
    </tr>`;
  }).join('');
}

function buildRecommendationRows(newCampaigns) {
  return newCampaigns.map(c => {
    const leg1 = c.leg1;
    const bull = c.direction === 'Bullish';
    return `<tr>
      ${td(`<b>${c.symbol}</b>`)}
      ${td(bull ? '▲ CALL' : '▼ PUT', `color:${bull ? COLOR.target : COLOR.stop}; font-weight:600;`)}
      ${td('$' + leg1.contract.strike_price)}
      ${td(leg1.contract.expiration_date)}
      ${td('Δ' + leg1.delta.toFixed(2))}
      ${td('$' + leg1.limitPrice + ' × ' + leg1.qty)}
      ${td('$' + c.netDebit.toFixed(0))}
      ${td(c.ivRank?.toFixed(0) ?? '—')}
    </tr>`;
  }).join('');
}

function buildPlaybookRows(playbook) {
  return playbook.map(p => {
    const pnlColor = p.unrealizedPct == null ? COLOR.muted : p.unrealizedPct >= 0 ? COLOR.target : COLOR.stop;
    const pnlStr = p.unrealizedPct != null
      ? `${p.unrealizedPct >= 0 ? '+' : ''}${(p.unrealizedPct * 100).toFixed(1)}% (${p.unrealizedDollar >= 0 ? '+' : ''}$${p.unrealizedDollar.toFixed(0)})`
      : 'no live quote';
    const bull = p.optionType === 'call';
    return `<tr>
      ${td(`<b>${p.symbol}</b>`)}
      ${td(bull ? '▲ CALL' : '▼ PUT', `color:${bull ? COLOR.target : COLOR.stop}; font-weight:600;`)}
      ${td('$' + p.strike.toFixed(2))}
      ${td(p.expiration)}
      ${td('$' + p.entryLimit.toFixed(2))}
      ${td('$' + p.target.toFixed(2), `color:${COLOR.target}; font-weight:700;`)}
      ${td('$' + p.stop.toFixed(2), `color:${COLOR.stop}; font-weight:700;`)}
      ${td(p.currentPrice != null ? '$' + p.currentPrice.toFixed(2) : '—')}
      ${td(pnlStr, `color:${pnlColor}; font-weight:600;`)}
      ${td(p.daysHeld.toFixed(1) + 'd')}
    </tr>`;
  }).join('');
}

function buildOutcomeRows(exits) {
  return exits.map(e => {
    const win = (e.pnl || 0) >= 0;
    const pnlStr = e.pnl != null ? (win ? `+$${e.pnl.toFixed(2)}` : `-$${Math.abs(e.pnl).toFixed(2)}`) : '—';
    return `<tr>
      ${td(`<b>${e.symbol}</b>`)}
      ${td(e.reason)}
      ${td(pnlStr, `color:${win ? COLOR.target : COLOR.stop}; font-weight:700;`)}
      ${td(e.pnlPct != null ? (e.pnlPct * 100).toFixed(1) + '%' : '—')}
    </tr>`;
  }).join('');
}

function buildHtmlBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, ts, target }) {
  const hot = watchlist.filter(w => w.tier === 'HOT');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  const totalDeployed = newCampaigns.reduce((s, c) => s + c.netDebit, 0);
  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const weekPct = ((weeklyPnL / target) * 100).toFixed(0);

  const hotTable = tableWrap(
    '🔥 HOT — Actionable Now', COLOR.hot, COLOR.hot,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Entry', 'Target ▲', 'Stop ▼', 'Conv.'],
    buildHotRows(hot), 'Nothing hot this session.'
  );
  const warmTable = tableWrap(
    '🌤️ WARM — Good Setup, Not Yet Actionable', COLOR.warm, COLOR.warm,
    ['Symbol', 'Direction', 'Conviction', 'Entry', 'Target', 'Stop', 'Why Not Yet'],
    buildWarmRows(warm), 'Nothing warm this session.'
  );
  const recTable = tableWrap(
    'New Recommendations — place these manually', COLOR.text, '#1f2937',
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Buy Limit × Qty', 'Cost', 'IV Rank'],
    buildRecommendationRows(newCampaigns), 'No new recommendations this session.'
  );
  const outcomeTable = tableWrap(
    'Positions Closed Out (hypothetical)', COLOR.text, '#1f2937',
    ['Symbol', 'Outcome', 'P&L $', 'P&L %'],
    buildOutcomeRows(exits), 'No positions closed out this session.'
  );
  const playbookTable = tableWrap(
    'Active Recommendations — exact entry/exit', COLOR.text, '#1f2937',
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Entry', 'Target ▲', 'Stop ▼', 'Now', 'P&L (hyp.)', 'Held'],
    buildPlaybookRows(playbook), 'No active recommendations.'
  );

  return `<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#f3f4f6;">
<div style="max-width:900px; margin:0 auto; padding:24px; font-family:Arial,Helvetica,sans-serif; color:${COLOR.text};">
  <div style="background:#111827; color:#fff; padding:20px 24px; border-radius:8px 8px 0 0;">
    <div style="font-size:18px; font-weight:700;">4-Agent Trading Council — Daily Recommendations</div>
    <div style="font-size:12px; color:#9ca3af; margin-top:4px;">${ts} ET</div>
  </div>
  <div style="background:#fff; padding:20px 24px; border:1px solid ${COLOR.border}; border-top:none;">
    <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:10px 14px; font-size:13px; color:#1e40af; margin-bottom:12px;">
      This is a recommendation-only report. Nothing here was traded automatically — review it and place any trades yourself on your own broker.
    </div>
    <div style="font-size:12px; color:${COLOR.muted}; margin-bottom:20px;">
      Legend: <span style="color:${COLOR.target}; font-weight:700;">green = target, exit for profit</span> &nbsp;·&nbsp; <span style="color:${COLOR.stop}; font-weight:700;">red = stop, exit for loss</span> &nbsp;·&nbsp; <span style="color:${COLOR.hot}; font-weight:700;">🔥 HOT = act now</span> &nbsp;·&nbsp; <span style="color:${COLOR.warm}; font-weight:700;">🌤️ WARM = watch, not yet</span>
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:10px; background:#f9fafb; border:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted};">Regime<br><b style="color:${COLOR.text}; font-size:14px;">${regime.name}</b> (VIX ~${regime.vix?.toFixed(1)})</td>
        <td style="padding:10px; background:#f9fafb; border:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted};">New Picks<br><b style="color:${COLOR.text}; font-size:14px;">${newCampaigns.length}</b></td>
        <td style="padding:10px; background:#f9fafb; border:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted};">Closed Out<br><b style="color:${COLOR.text}; font-size:14px;">${exits.length}</b></td>
        <td style="padding:10px; background:#f9fafb; border:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted};">Weekly P&L (hyp.)<br><b style="color:${weeklyPnL >= 0 ? COLOR.target : COLOR.stop}; font-size:14px;">${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)} (${weekPct}%)</b></td>
      </tr>
    </table>

    ${hotTable}
    ${warmTable}
    ${recTable}
    ${outcomeTable}
    ${playbookTable}

    <div style="margin-top:20px; padding-top:16px; border-top:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted};">
      Weekly P&L (hypothetical): <b style="color:${weeklyPnL >= 0 ? COLOR.target : COLOR.stop};">${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}</b>
      &nbsp;|&nbsp; Monthly P&L (hypothetical): <b style="color:${monthlyPnL >= 0 ? COLOR.target : COLOR.stop};">${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}</b>
    </div>
    <div style="margin-top:8px; font-size:12px; color:${COLOR.muted};">— 4-Agent Options Trading Council 🤖</div>
  </div>
</div>
</body></html>`;
}

// ── Main session email ────────────────────────────────────────────────────────

async function sendSessionReport({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist = [], playbook = [] }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const target = parseFloat(process.env.WEEKLY_TARGET) || 750;
  const ctx = { newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, ts, target };

  const text = buildTextBody(ctx);
  const html = buildHtmlBody(ctx);

  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const subjectPnL = realizedPnL !== 0 ? ` | P&L ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)}` : '';
  const subjectTag = newCampaigns.length > 0 ? `${newCampaigns.length} new pick(s)` : exits.length > 0 ? `${exits.length} closed` : 'Daily update';
  await send(`[Trading Council] ${subjectTag}${subjectPnL} — ${ts}`, text, html);
}

module.exports = { sendSessionReport };
