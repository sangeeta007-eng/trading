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

// A session that errors out produces no report at all — silence that could
// easily be mistaken for "nothing new today" when something actually broke.
// This is a distinct, clearly-labeled alert so a crashed run doesn't go
// unnoticed among routine "Daily update" emails.
async function sendFailureAlert(err) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const message = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));

  const text = `
⚠ TRADING COUNCIL SESSION FAILED — ${ts} ET

The session did not complete. This is NOT "nothing new to report" —
something broke, and no fresh recommendations or outcome checks happened
this run.

Error: ${message}

Check the full log at:
https://github.com/sangeeta007-eng/trading/actions
`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#f3f1ea; font-family:Verdana, Tahoma, Arial, Helvetica, sans-serif;">
<div style="max-width:600px; margin:40px auto; padding:22px; background:#fdfbf6; border:2px solid #b91c1c; border-radius:8px; letter-spacing:0.15px;">
  <div style="font-size:18px; font-weight:700; color:#b91c1c; margin-bottom:10px; line-height:1.4;">⚠ Trading Council session FAILED</div>
  <div style="font-size:14px; line-height:1.6; color:#2b2723; margin-bottom:14px;">${ts} ET — the session did not complete. This is not "nothing new to report" — something broke, and no fresh recommendations or outcome checks happened this run.</div>
  <div style="font-size:13px; font-family:monospace; background:#f7f5ef; border:1px solid #e6e0d4; border-radius:4px; padding:12px; color:#2b2723; word-break:break-word; line-height:1.5;">${message}</div>
  <div style="font-size:13px; color:#6b6358; margin-top:14px; line-height:1.6;">Full log: <a href="https://github.com/sangeeta007-eng/trading/actions" style="color:#166534;">github.com/sangeeta007-eng/trading/actions</a></div>
</div>
</body></html>`;

  await send(`[Trading Council] ⚠ SESSION FAILED — ${ts}`, text, html);
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
    ? `Strike $${w.contract.strike.toFixed(2)} | Exp ${w.contract.expiration} | Δ${w.contract.delta.toFixed(2)} | Entry ~$${w.contract.entryLimit.toFixed(2)} | Target $${w.contract.targetLimit.toFixed(2)} | Stop $${w.contract.stopLimit.toFixed(2)}${w.contract.qty ? ` | Suggested Qty ${w.contract.qty}` : ''}`
    : 'No live contract selected yet';
  const statusLine = w.tier === 'HOT'
    ? 'ACTIONABLE NOW — this is in the recommendations below, place it manually'
    : `Not yet actionable — ${w.blockedDetail || w.blockedReason || 'pending better conditions'}`;
  const advisoryLines = (w.advisories || []).map(a => `        ⚠ ${a.message}`);

  return [
    `   ${icon}  ${w.symbol.padEnd(6)} ${dirLabel.padEnd(16)} conviction ${w.conviction}/100`,
    `        ${contractLine}`,
    `        ${statusLine}`,
    ...advisoryLines,
  ].join('\n');
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

function buildTextBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, ts, target }) {
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
  const macroLine = macro?.fedFunds
    ? `Fed Funds ${macro.fedFunds.value.toFixed(2)}% (${macro.fedFunds.date}) | 10Y-2Y Curve ${macro.yieldCurve ? macro.yieldCurve.value.toFixed(2) + 'pp' + (macro.yieldCurveInverted ? ' [INVERTED]' : '') : 'n/a'}`
    : 'not configured — set FRED_API_KEY in .env';

  return `
╔══════════════════════════════════════════════════════╗
   4-AGENT TRADING COUNCIL — DAILY RECOMMENDATIONS
   ${ts} ET
╚══════════════════════════════════════════════════════╝

Want a fresh run right now instead of waiting for the next scheduled one?
https://github.com/sangeeta007-eng/trading/actions/workflows/trading-session.yml
Click "Run workflow" (gray), then the green one that appears. Market hours
only (9:30am-4pm ET weekdays) — outside that it reports closed, not a guess.

This is a recommendation-only report. Nothing here was traded automatically
— review it and place any trades yourself on your own broker.

${verdict ? `TODAY'S CALL: ${verdict.call}
   ${verdict.reason}
` : ''}
📊 MARKET REGIME
   ${regimeLine}

🏛 MACRO BACKDROP (real, from FRED — informational only)
   ${macroLine}

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
//
// Palette and type choices below are deliberately dyslexia-friendly, not just
// "clean": warm off-white instead of stark white (less glare), a font stack
// led by Verdana (wide letterforms, easy to tell similar letters apart),
// generous line-height/letter-spacing, no italics for emphasis, and
// zebra-striped rows (done as literal per-row inline colors, not CSS
// :nth-child, so it also renders correctly in email clients like Outlook
// that strip <style> blocks). Every text/background pair below was checked
// against WCAG AA (>=4.5:1) — see notify.js commit history if you need to
// re-verify after changing a color.
const FONT_STACK = 'Verdana, Tahoma, Arial, Helvetica, sans-serif';

const COLOR = {
  hot: '#c2410c', hotBg: '#fdf1e8', hotBorder: '#f3d0b3',
  warm: '#a16207', warmBg: '#fdf6e3', warmBorder: '#f0e0b0',
  target: '#166534', stop: '#b91c1c',
  text: '#2b2723', muted: '#6b6358', border: '#e6e0d4',
  bg: '#f3f1ea', card: '#fdfbf6', zebra: '#f7f5ef',
  headerBg: '#2b2723', headerText: '#f3f1ea',
  advisory: '#475569', advisoryBg: '#f1f4f8', advisoryBorder: '#dbe3ec',
};

function td(content, style = '') {
  return `<td style="padding:11px 12px; border:1px solid ${COLOR.border}; font-size:15px; line-height:1.5; color:${COLOR.text}; ${style}">${content}</td>`;
}

function th(content) {
  return `<th style="padding:11px 12px; border:1px solid ${COLOR.border}; font-size:12px; letter-spacing:0.4px; color:${COLOR.headerText}; text-align:left;">${content}</th>`;
}

function tableWrap(title, titleColor, headerBg, headers, rowsHtml, emptyMsg) {
  const body = rowsHtml || `<tr>${td(emptyMsg, `color:${COLOR.muted};`)}${headers.slice(1).map(() => '<td style="border:1px solid ' + COLOR.border + ';"></td>').join('')}</tr>`;
  return `
  <div style="margin:24px 0;">
    <div style="font-size:16px; font-weight:700; color:${titleColor}; margin-bottom:10px;">${title}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:${FONT_STACK};">
      <thead><tr style="background:${headerBg};">${headers.map(th).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function convictionBadge(conviction) {
  const color = conviction >= 70 ? COLOR.target : conviction >= 50 ? COLOR.warm : COLOR.muted;
  return `<span style="color:${color}; font-weight:700;">${conviction}/100</span>`;
}

// Zebra background for rows that don't already carry a semantic tint
// (hot/warm rows keep their own colored background instead).
function zebra(i) { return i % 2 === 0 ? COLOR.card : COLOR.zebra; }

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
      ${td(c && c.qty ? c.qty + ' × $' + c.tradeCost.toFixed(0) : '—')}
      ${td(convictionBadge(w.conviction))}
      ${td(w.advisories?.length ? `<b style="color:${COLOR.advisory};">⚠ ${w.advisories.length}</b>` : '—')}
    </tr>`;
  }).join('');
}

// Advisories are context attached to a real pick — never a reason it was
// withheld. Rendered under the HOT table so the numbers stay scannable and
// the caveats stay readable, rather than crushed into a table cell.
function buildAdvisoryBlock(hot) {
  const withAdvisories = hot.filter(w => w.advisories?.length);
  if (!withAdvisories.length) return '';

  const items = withAdvisories.map(w => `
    <div style="margin-bottom:12px;">
      <div style="font-weight:700; font-size:14px; color:${COLOR.text}; margin-bottom:4px;">${w.symbol} ${w.bias}</div>
      ${w.advisories.map(a => `<div style="font-size:14px; line-height:1.6; color:${COLOR.text}; margin-bottom:4px;">⚠ ${a.message}</div>`).join('')}
    </div>`).join('');

  return `
  <div style="margin:16px 0 24px; background:${COLOR.advisoryBg}; border:1px solid ${COLOR.advisoryBorder}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:15px; font-weight:700; color:${COLOR.advisory}; margin-bottom:10px;">⚠ Advisories on the picks above — context, not blockers</div>
    ${items}
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted}; margin-top:8px;">
      These don't remove a pick from HOT. They're conditions worth weighing before you place it — the call is yours.
    </div>
  </div>`;
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
      ${td(w.blockedDetail || w.blockedReason || 'pending better conditions', `color:${COLOR.muted}; font-size:13px;`)}
    </tr>`;
  }).join('');
}

function buildRecommendationRows(newCampaigns) {
  return newCampaigns.map((c, i) => {
    const leg1 = c.leg1;
    const bull = c.direction === 'Bullish';
    return `<tr style="background:${zebra(i)};">
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
  return playbook.map((p, i) => {
    const pnlColor = p.unrealizedPct == null ? COLOR.muted : p.unrealizedPct >= 0 ? COLOR.target : COLOR.stop;
    const pnlStr = p.unrealizedPct != null
      ? `${p.unrealizedPct >= 0 ? '+' : ''}${(p.unrealizedPct * 100).toFixed(1)}% (${p.unrealizedDollar >= 0 ? '+' : ''}$${p.unrealizedDollar.toFixed(0)})`
      : 'no live quote';
    const bull = p.optionType === 'call';
    return `<tr style="background:${zebra(i)};">
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
  return exits.map((e, i) => {
    const win = (e.pnl || 0) >= 0;
    const pnlStr = e.pnl != null ? (win ? `+$${e.pnl.toFixed(2)}` : `-$${Math.abs(e.pnl).toFixed(2)}`) : '—';
    return `<tr style="background:${zebra(i)};">
      ${td(`<b>${e.symbol}</b>`)}
      ${td(e.reason)}
      ${td(pnlStr, `color:${win ? COLOR.target : COLOR.stop}; font-weight:700;`)}
      ${td(e.pnlPct != null ? (e.pnlPct * 100).toFixed(1) + '%' : '—')}
    </tr>`;
  }).join('');
}

// ── Exit strategy block — see EXIT_STRATEGY.md for the full write-up and
// the trailing-stop floor-activation math this summarizes. ─────────────────
function buildExitStrategyBlock() {
  const box = (label, rows) => `
    <div style="background:${COLOR.card}; border:1px solid ${COLOR.border}; border-radius:6px; padding:14px 16px; margin-bottom:12px;">
      <div style="font-weight:700; font-size:14px; margin-bottom:6px; color:${COLOR.text};">${label}</div>
      <div style="font-size:14px; line-height:1.6; color:${COLOR.text};">${rows}</div>
    </div>`;

  return `
  <div style="margin:24px 0;">
    <div style="font-size:16px; font-weight:700; color:${COLOR.text}; margin-bottom:10px;">🎯 Exit Strategy — set once, walk away</div>
    <div style="font-size:14px; line-height:1.6; color:${COLOR.text}; margin-bottom:12px;">
      For every <b style="color:${COLOR.hot};">HOT</b> pick, place two orders on your broker right after you buy, both marked
      <b>GTC (Good-Til-Cancelled)</b> so they stay active without you watching the position:
    </div>
    ${box('1. Stop-Loss (protects the downside from day one)',
      'SELL TO CLOSE, STOP (or stop-limit) order at the <b>Stop</b> price shown in the table above. GTC. This fires automatically if the trade fails, capping the loss — you never have to watch for it.')}
    ${box('2. Take-Profit — two ways to run it',
      `<b>Simple:</b> SELL TO CLOSE, LIMIT order at the <b>Target</b> price shown. GTC. Fires automatically once reached, locks in the full computed gain.<br><br>
       <b>Let-it-run version:</b> instead of a flat limit, use a <b>GTC trailing stop-limit</b> order. Set the trail % so it never gives back more than you're comfortable with off the peak price, while letting the position keep running if it moves further than the original target. See the full math (which trail % protects which profit floor) in Exit Strategy in the repo — the short version: an 8% trail won't lock in a floor of at least +10% profit until the position first reaches about +20% gain; a 4% trail locks that floor in earlier (around +15% gain) but is more likely to trigger early on normal day-to-day option price noise. Tighter trail = protects sooner but exits more easily on noise; looser trail = lets it run more but the floor guarantee kicks in later.`)}
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted};">
      Most brokers let you place the stop-loss and take-profit as a single <b>OCO (one-cancels-other)</b> bracket — if one fires, the other cancels automatically. Verify your specific broker supports OCO and trailing stops on <i>options</i> (not just stocks) before relying on it — coverage varies by broker.
      <br><br>
      <b style="color:${COLOR.warm};">WARM</b> picks: no orders to place yet. WARM means a real setup exists but isn't actionable this session (see the reason shown in its row) — nothing to enter or exit until it upgrades to HOT.
      <br><br>
      This is order-mechanics information, not personalized investment advice — you're deciding your own risk tolerance on the trail %, not this tool.
    </div>
  </div>`;
}

// Real Fed funds rate + yield curve data (fred.js) — informational only,
// not yet a sizing/veto input. Shows "not configured" honestly rather than
// hiding the section or guessing a number when FRED_API_KEY isn't set.
function buildMacroBlock(macro) {
  const fedLine = macro?.fedFunds
    ? `Fed Funds Rate: <b>${macro.fedFunds.value.toFixed(2)}%</b> (as of ${macro.fedFunds.date})`
    : 'Fed Funds Rate: not configured — set FRED_API_KEY in .env (free, see .env.example)';
  const curveLine = macro?.yieldCurve
    ? `10Y-2Y Yield Curve: <b>${macro.yieldCurve.value.toFixed(2)}pp</b> (as of ${macro.yieldCurve.date}) — ${macro.yieldCurveInverted ? '<b style="color:#b91c1c;">INVERTED</b> (a real recession-risk signal, not a trading veto here)' : 'normal (not inverted)'}`
    : '10Y-2Y Yield Curve: not configured';

  return `
  <div style="margin:24px 0; background:${COLOR.card}; border:1px solid ${COLOR.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:15px; font-weight:700; color:${COLOR.text}; margin-bottom:8px;">🏛 Macro Backdrop (real, from FRED — informational only)</div>
    <div style="font-size:14px; line-height:1.8; color:${COLOR.text};">${fedLine}<br>${curveLine}</div>
  </div>`;
}

// The day's plain call on whether to be putting money to work. Never
// suppresses anything — the picks are listed underneath regardless.
function buildVerdictBanner(v) {
  if (!v) return '';
  const tone = v.call === 'GOOD DAY TO BUY'
    ? { bg: '#eef3ea', border: '#c9dcc0', fg: COLOR.target }
    : v.call === 'SIT OUT'
    ? { bg: '#fdf1e8', border: COLOR.hot, fg: COLOR.hot }
    : { bg: '#fdf6e3', border: COLOR.warmBorder, fg: COLOR.warm };
  return `
  <div style="margin-bottom:16px; background:${tone.bg}; border:2px solid ${tone.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:16px; font-weight:700; color:${tone.fg}; margin-bottom:6px;">Today's call: ${v.call}</div>
    <div style="font-size:14px; line-height:1.6; color:${COLOR.text};">${v.reason}</div>
  </div>`;
}

function buildHtmlBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, ts, target }) {
  const hot = watchlist.filter(w => w.tier === 'HOT');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  const totalDeployed = newCampaigns.reduce((s, c) => s + c.netDebit, 0);
  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const weekPct = ((weeklyPnL / target) * 100).toFixed(0);

  const hotTable = tableWrap(
    '🔥 HOT — Actionable Now', COLOR.hot, COLOR.hot,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Entry', 'Target ▲', 'Stop ▼', 'Size', 'Conv.', '⚠'],
    buildHotRows(hot), 'Nothing hot this session.'
  );
  const warmTable = tableWrap(
    '🌤️ WARM — Good Setup, Not Yet Actionable', COLOR.warm, COLOR.warm,
    ['Symbol', 'Direction', 'Conviction', 'Entry', 'Target', 'Stop', 'Why Not Yet'],
    buildWarmRows(warm), 'Nothing warm this session.'
  );
  const recTable = tableWrap(
    'New Recommendations — place these manually', COLOR.text, COLOR.headerBg,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Buy Limit × Qty', 'Cost', 'IV Rank'],
    buildRecommendationRows(newCampaigns), 'No new recommendations this session.'
  );
  const outcomeTable = tableWrap(
    'Positions Closed Out (hypothetical)', COLOR.text, COLOR.headerBg,
    ['Symbol', 'Outcome', 'P&L $', 'P&L %'],
    buildOutcomeRows(exits), 'No positions closed out this session.'
  );
  const playbookTable = tableWrap(
    'Active Recommendations — exact entry/exit', COLOR.text, COLOR.headerBg,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Entry', 'Target ▲', 'Stop ▼', 'Now', 'P&L (hyp.)', 'Held'],
    buildPlaybookRows(playbook), 'No active recommendations.'
  );

  const generatedIso = new Date().toISOString();

  return `<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:${COLOR.bg};">
<div style="max-width:900px; margin:0 auto; padding:24px; font-family:${FONT_STACK}; color:${COLOR.text}; letter-spacing:0.15px;">
  <div style="background:${COLOR.headerBg}; color:${COLOR.headerText}; padding:20px 24px; border-radius:8px 8px 0 0;">
    <div style="font-size:19px; font-weight:700; line-height:1.4;">4-Agent Trading Council — Daily Recommendations</div>
    <div id="report-ts" data-generated="${generatedIso}" data-ts-label="${ts} ET" style="font-size:13px; color:#c9c3b8; margin-top:6px;">Report generated: ${ts} ET</div>
  </div>
  <div style="background:${COLOR.card}; padding:20px 24px; border:1px solid ${COLOR.border}; border-top:none;">
    <div style="text-align:center; margin-bottom:16px;">
      <button id="run-now-btn" onclick="runNow()" style="display:inline-block; background:${COLOR.hot}; color:#fff; font-weight:700; font-size:14px; border:none; cursor:pointer; padding:12px 22px; border-radius:6px; font-family:${FONT_STACK};">▶ Run a Fresh Session Now</button>
      <div id="run-now-status" style="font-size:12px; color:${COLOR.muted}; margin-top:6px; line-height:1.6;">Runs during market hours only (9:30am-4pm ET weekdays) — outside that window it reports the market as closed rather than guessing. Takes about 30-60 seconds, then this page updates on its own.</div>
    </div>
    <script>
      async function runNow() {
        const btn = document.getElementById('run-now-btn');
        const status = document.getElementById('run-now-status');
        btn.disabled = true;
        btn.textContent = 'Starting session…';
        try {
          const res = await fetch('https://trading-refresh.ignite-shakti-website.workers.dev', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || 'Unknown error');
          status.textContent = 'Session started — this page will refresh automatically in about a minute.';
          status.style.color = '${COLOR.target}';
          let secondsLeft = 65;
          const timer = setInterval(() => {
            secondsLeft--;
            btn.textContent = 'Refreshing in ' + secondsLeft + 's…';
            if (secondsLeft <= 0) { clearInterval(timer); location.reload(); }
          }, 1000);
        } catch (err) {
          status.textContent = '⚠ Could not start a session: ' + err.message + ' — try the GitHub Actions page directly: github.com/sangeeta007-eng/trading/actions';
          status.style.color = '${COLOR.stop}';
          btn.disabled = false;
          btn.textContent = '▶ Run a Fresh Session Now';
        }
      }
    </script>
    <div style="background:#eef3ea; border:1px solid #c9dcc0; border-radius:6px; padding:12px 14px; font-size:14px; line-height:1.6; color:#2f4a26; margin-bottom:14px;">
      This is a recommendation-only report. Nothing here was traded automatically — review it and place any trades yourself on your own broker.
    </div>
    <div style="font-size:13px; line-height:1.8; color:${COLOR.muted}; margin-bottom:20px;">
      Legend: <span style="color:${COLOR.target}; font-weight:700;">green = target, exit for profit</span> &nbsp;·&nbsp; <span style="color:${COLOR.stop}; font-weight:700;">red = stop, exit for loss</span> &nbsp;·&nbsp; <span style="color:${COLOR.hot}; font-weight:700;">🔥 HOT = act now</span> &nbsp;·&nbsp; <span style="color:${COLOR.warm}; font-weight:700;">🌤️ WARM = watch, not yet</span>
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:12px; background:${COLOR.zebra}; border:1px solid ${COLOR.border}; font-size:13px; line-height:1.6; color:${COLOR.muted};">Regime<br><b style="color:${COLOR.text}; font-size:15px;">${regime.name}</b> (VIX ~${regime.vix?.toFixed(1)})</td>
        <td style="padding:12px; background:${COLOR.zebra}; border:1px solid ${COLOR.border}; font-size:13px; line-height:1.6; color:${COLOR.muted};">New Picks<br><b style="color:${COLOR.text}; font-size:15px;">${newCampaigns.length}</b></td>
        <td style="padding:12px; background:${COLOR.zebra}; border:1px solid ${COLOR.border}; font-size:13px; line-height:1.6; color:${COLOR.muted};">Closed Out<br><b style="color:${COLOR.text}; font-size:15px;">${exits.length}</b></td>
        <td style="padding:12px; background:${COLOR.zebra}; border:1px solid ${COLOR.border}; font-size:13px; line-height:1.6; color:${COLOR.muted};">Weekly P&L (hyp.)<br><b style="color:${weeklyPnL >= 0 ? COLOR.target : COLOR.stop}; font-size:15px;">${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)} (${weekPct}%)</b></td>
      </tr>
    </table>

    ${buildVerdictBanner(verdict)}
    ${buildMacroBlock(macro)}
    ${hotTable}
    ${buildAdvisoryBlock(hot)}
    ${warmTable}
    ${buildExitStrategyBlock()}
    ${recTable}
    ${outcomeTable}
    ${playbookTable}

    <div style="margin-top:20px; padding-top:16px; border-top:1px solid ${COLOR.border}; font-size:13px; line-height:1.6; color:${COLOR.muted};">
      Weekly P&L (hypothetical): <b style="color:${weeklyPnL >= 0 ? COLOR.target : COLOR.stop};">${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}</b>
      &nbsp;|&nbsp; Monthly P&L (hypothetical): <b style="color:${monthlyPnL >= 0 ? COLOR.target : COLOR.stop};">${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}</b>
    </div>
    <div style="margin-top:8px; font-size:13px; color:${COLOR.muted};">— 4-Agent Options Trading Council 🤖</div>
  </div>
</div>
<script>
(function() {
  // Marks the timestamp red/bold if this page is being viewed well after it
  // was generated (>90min, or a different calendar day) — inert in email
  // clients (they strip <script>), active on the static report page. This
  // never guesses at fresher data; it only flags that what's on screen is old.
  var el = document.getElementById('report-ts');
  if (!el) return;
  var generated = new Date(el.getAttribute('data-generated'));
  var now = new Date();
  var ageMin = (now - generated) / 60000;
  var sameDay = now.toDateString() === generated.toDateString();
  if (ageMin > 90 || !sameDay) {
    var h = Math.floor(ageMin / 60), m = Math.round(ageMin % 60);
    var ageStr = (h > 0 ? h + 'h ' : '') + m + 'm';
    el.textContent = '⚠ This report is from ' + el.getAttribute('data-ts-label') + ' (' + ageStr + ' ago) — waiting for the next session.';
    el.style.color = '#fca5a5';
    el.style.fontWeight = '700';
  }
})();
</script>
</body></html>`;
}

// ── Main session email ────────────────────────────────────────────────────────

async function sendSessionReport({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist = [], playbook = [], macro = null, verdict = null }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const target = parseFloat(process.env.WEEKLY_TARGET) || 750;
  const ctx = { newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, ts, target };

  const text = buildTextBody(ctx);
  const html = buildHtmlBody(ctx);

  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const subjectPnL = realizedPnL !== 0 ? ` | P&L ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)}` : '';
  const subjectTag = newCampaigns.length > 0 ? `${newCampaigns.length} new pick(s)` : exits.length > 0 ? `${exits.length} closed` : 'Daily update';
  await send(`[Trading Council] ${subjectTag}${subjectPnL} — ${ts}`, text, html);
  return html;
}

module.exports = { sendSessionReport, sendFailureAlert, buildHtmlBody };
