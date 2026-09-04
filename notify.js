const nodemailer = require('nodemailer');
const { MAX_STOCK_PICKS } = require('./council/run');
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
  const advisoryLines = (w.advisories || []).flatMap(a => a.plain
    ? [`        ⚠ ${a.plain}`, `          (In market terms: ${a.message})`]
    : [`        ⚠ ${a.message}`]);

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

function buildTextBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, spreads, ts, target }) {
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

  const spreadsTextBlock = spreads?.length
    ? ['💰 CREDIT SPREADS — the structure that tested positive',
       '   (+1.6%/trade over 8 years, 75% win rate, vs -3.3% for buying below)',
       ...spreads.map(s => [
         `   ${s.symbol}: SELL $${s.shortLeg.strike}p / BUY $${s.longLeg.strike}p, exp ${s.shortLeg.expiration} (${s.dte}d)`,
         `        you get paid $${s.credit.toFixed(2)} | worst case $${s.maxLoss.toFixed(2)} | breakeven $${s.breakeven.toFixed(2)} (${(s.breakevenPct * 100).toFixed(1)}%)`,
         `        return if it works ${(s.targetReturnOnRisk * 100).toFixed(1)}% | close at $${s.closeAt.toFixed(2)} or at 21 days to expiry`,
       ].join('\n')),
       '   Risk: wins small and frequent (+15%), losses rarer and large (-40%).',
       '   2022 lost 5.5%/trade across the year. This is not free money.',
      ].join('\n') + '\n'
    : '';

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

⚠ MEASURED RESULT: tested on 8 years of real prices, these exact rules
   LOST about 3.3% per trade over 3,145 simulated trades (37.5% win rate
   vs the 40% needed to break even). After a buy signal the fund rose
   0.50% on average, versus 1.00% for buying on any random day — the
   signal picked worse than chance. Treat everything below as research
   output, not advice to place money. Run: npm run backtest

This is a recommendation-only report. Nothing here was traded automatically
— review it and place any trades yourself on your own broker.

${verdict ? `TODAY'S CALL: ${verdict.call}
   ${verdict.plain || verdict.reason}
${verdict.plain ? `   (In market terms: ${verdict.reason})\n` : ''}` : ''}
${spreadsTextBlock}

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
  // Page header only — deliberately NOT headerBg, which every table header
  // also uses. A deep blue tells this page apart from the Government Stakes
  // page at a glance when both are open in tabs, without touching the warm
  // neutral palette the tables rely on for readability.
  pageHeaderBg: '#0047ab', pageHeaderLink: '#cfe2fa',
  advisory: '#475569', advisoryBg: '#f1f4f8', advisoryBorder: '#dbe3ec',
};

// The same HTML is both emailed and published as a static page, so a bare
// relative link would work on the site and be dead in the inbox. Set
// SITE_BASE_URL (e.g. https://igniteshakti.com) and emails get a working
// absolute link; leave it unset and the published page still links fine.
// The hub page listing every tool. Same default as govt/report.js, and
// deliberately NOT SITE_BASE_URL: that is where these pages are served from
// (GitHub Pages) and is fetched by CI, whereas this is only ever rendered as
// a link for a person to click. Conflating the two once pointed CI at the
// hub page.
const HOME_URL = process.env.HOME_URL || 'https://igniteshakti.com/tradinglink';

function govtPageUrl() {
  const base = process.env.SITE_BASE_URL;
  if (!base) return './govt.html';
  return `${base.replace(/\/+$/, '')}/govt.html`;
}

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
      ${td(c && c.stopUnderlying != null
            ? `${w.symbol} below $${c.stopUnderlying.toFixed(2)}<div style="font-size:11px; font-weight:400; color:${COLOR.muted};">stock now $${w.price.toFixed(2)} · −${(c.stopUnderlyingPct * 100).toFixed(1)}%</div>`
            : '—', `color:${COLOR.stop}; font-weight:700;`)}
      ${td(c && c.qty
            ? `${c.qty} × $${c.tradeCost.toFixed(0)}${c.maxLossPct != null ? `<div style="font-size:11px; font-weight:400; color:${COLOR.muted};">risking ${(c.maxLossPct * 100).toFixed(1)}% of capital</div>` : ''}`
            : '—')}
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
      ${w.advisories.map(a => `
        <div style="margin-bottom:10px;">
          <div style="font-size:15px; line-height:1.7; color:${COLOR.text};">⚠ ${a.plain || a.message}</div>
          ${a.plain ? `<div style="font-size:13px; line-height:1.6; color:${COLOR.muted}; margin-top:3px; padding-left:18px;"><b>In market terms:</b> ${a.message}</div>` : ''}
        </div>`).join('')}
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
      ${td(c && c.stopUnderlying != null ? `${w.symbol} below $${c.stopUnderlying.toFixed(2)}` : '—', c ? `color:${COLOR.stop};` : '')}
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
    ${box('1. Stop — watch the STOCK price, not the option price',
      `The <b>Stop ▼</b> column gives a price on the <b>underlying stock or ETF</b>, not on the option. If the stock closes below that level, the reason for the trade is gone — sell the option at the market next session, whatever it's worth.<br><br>
       <b>Why not a stop order on the option itself?</b> Because it doesn't work, and this was measured rather than assumed. Across 8 years of real bars, the worst single trade lost <b>100% of the premium</b> — and it lost exactly 100% whether the stop was set at −30%, −65%, on the underlying, or not set at all. Options gap overnight; a stop order can't fill at a price the market skipped past. Meanwhile a tight stop on the option reliably sells you out of good trades over ordinary price noise: the −30% option stop turned a <b>+3.6%</b> average trade into <b>−0.2%</b>. So a stop on the option costs real money and buys no protection.<br><br>
       <b>What actually protects you is the size of the bet</b> — see the <b>Size</b> column, which is set so that losing the entire premium costs a small, fixed slice of your capital. That's the real safety net, and it's the one professionals rely on for long options.`)}
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

// Measured performance of these exact rules, from council/backtest.js.
// This sits at the top of every report because it is the single most
// important fact about the picks below: as of the last run, the rules do
// not have a positive measured expectancy. Hiding that while presenting
// "actionable" picks would be dishonest.
// ── Quick view ──────────────────────────────────────────────────────────────
//
// One table, everything in it, no prose. Modelled directly on the Government
// Stakes page's quick view so the two read the same way, and using the same
// BUY / BUY ON DIP / HOLD / AVOID / SELL vocabulary from the same code.
//
// This exists because the report used to show only the handful of symbols
// that cleared the narrow dip trigger — which on most days is none, leaving a
// blank page that looks identical whether the market is calm or collapsing.
// The reasoning, contracts, stops and sizing all stay in the detailed tables
// below; this is purely the glance.
const GLANCE_RATING_COLOR = {
  'BUY': COLOR.target,
  'BUY ON DIP': COLOR.hot,
  'HOLD': COLOR.advisory,
  'AVOID': COLOR.warm,
  'SELL': COLOR.stop,
  'NO DATA': COLOR.muted,
};

function glanceSectors(d) {
  if (!d) return `<span style="color:${COLOR.muted};">—</span>`;
  if (d.type === 'STOCK') return d.industry || d.sector || `<span style="color:${COLOR.muted};">—</span>`;
  if (!d.sectors || !d.sectors.length) return `<span style="color:${COLOR.muted};">—</span>`;
  return d.sectors.slice(0, 2)
    .map(x => `${x.name} <b>${x.pct.toFixed(0)}%</b>`)
    .join(`<span style="color:${COLOR.muted};"> · </span>`);
}

// ret1m arrives already expressed in percent — govt/scan.js's pctChange does
// the x100 itself. Scaling again here turned a 10% month into "1007.7%".
function glancePct(v) {
  if (v == null || !isFinite(v)) return td('—', `color:${COLOR.muted};`);
  const c = v >= 0 ? COLOR.target : COLOR.stop;
  return td(`${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, `color:${c}; font-weight:600;`);
}

function glanceSectionRow(title, count) {
  return `<tr><td colspan="5" style="padding:10px 12px; border:1px solid ${COLOR.border}; background:${COLOR.headerBg || '#3b3833'}; color:#fff; font-size:13px; font-weight:700; letter-spacing:0.5px;">
    ${title} <span style="font-weight:400; color:#c9c3b8;">— ${count}</span></td></tr>`;
}

function glanceGroupRow(rating, count) {
  const color = GLANCE_RATING_COLOR[rating] || COLOR.muted;
  return `<tr><td colspan="5" style="padding:9px 12px; border:1px solid ${COLOR.border}; background:${COLOR.bg || '#faf8f5'}; font-size:13px; font-weight:700; letter-spacing:0.4px; color:${color};">
    ${rating} <span style="font-weight:400; color:${COLOR.muted};">— ${count} ${count === 1 ? 'symbol' : 'symbols'}</span></td></tr>`;
}

function glanceRows(rows, sectors) {
  const { groupByRating } = require('./council/glance');
  let i = 0;
  return groupByRating(rows.filter(m => m.rating)).map(g =>
    glanceGroupRow(g.rating, g.rows.length) +
    g.rows.map(m => {
      const bg = i++ % 2 === 0 ? COLOR.card : COLOR.zebra;
      return `<tr style="background:${bg};">
        ${td(`<b>${m.symbol}</b>`)}
        ${td(glanceSectors(sectors.get ? sectors.get(m.symbol) : null), 'font-size:12px;')}
        ${td(m.price != null ? '$' + m.price.toFixed(2) : '—')}
        ${glancePct(m.ret1m)}
        ${td(`<b style="color:${GLANCE_RATING_COLOR[m.rating] || COLOR.muted};">${m.rating}</b>`)}
      </tr>`;
    }).join('')
  ).join('');
}

function buildQuickGlance(glance) {
  if (!glance || (!glance.etfs?.length && !glance.stocks?.length)) return '';
  const c = glance.counts || {};
  const chip = (label, n) => n
    ? `<span style="display:inline-block; margin:0 6px 6px 0; padding:4px 10px; border-radius:12px; font-size:13px; font-weight:700; color:#fff; background:${GLANCE_RATING_COLOR[label] || COLOR.muted};">${label} ${n}</span>`
    : '';

  const body =
    glanceSectionRow('🗂 ETFs', `${glance.etfs.filter(m => m.rating).length} funds`) +
    glanceRows(glance.etfs, glance.sectors) +
    glanceSectionRow('🏢 STOCKS', `${glance.stocks.filter(m => m.rating).length} companies`) +
    glanceRows(glance.stocks, glance.sectors);

  return `
  <div style="margin:0 0 22px;">
    <div style="font-size:17px; font-weight:700; color:${COLOR.text}; margin-bottom:6px;">⚡ Quick view — is each one healthy to own?</div>
    <div style="font-size:14px; line-height:1.6; color:${COLOR.muted}; margin-bottom:10px;">
      All ${glance.scanned} symbols, rated on trend health. No reasoning here on purpose — the why, the contracts, the stops and the sizing are all in the detailed tables below.
    </div>
    <div style="margin-bottom:8px;">${chip('BUY', c['BUY'])}${chip('BUY ON DIP', c['BUY ON DIP'])}${chip('HOLD', c['HOLD'])}${chip('AVOID', c['AVOID'])}${chip('SELL', c['SELL'])}</div>
    <div style="font-size:13px; line-height:1.6; color:${COLOR.text}; background:${COLOR.advisoryBg}; border-left:4px solid ${COLOR.advisory}; border-radius:4px; padding:9px 12px; margin-bottom:12px;">
      <b>These are share verdicts, not option picks.</b> ${c['BUY'] ? `"BUY ${c['BUY']}" means ${c['BUY']} ${c['BUY'] === 1 ? 'symbol is' : 'symbols are'} in a healthy uptrend and fine to <i>own</i>` : 'A BUY here means the symbol is in a healthy uptrend and fine to <i>own</i>'} — it does <b>not</b> mean buy a call option on it today.
      Options are only worth buying on a dip, so the option picks further down are a much shorter list, and are often empty even on a day when most of this table is green. Both can be true at once.
    </div>
    <div style="overflow-x:auto; -webkit-overflow-scrolling:touch;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; min-width:560px;">
      <tr>${['Symbol', 'Sectors held', 'Price', '1M', 'Verdict'].map(h => `<th style="padding:9px 10px; border:1px solid ${COLOR.border}; background:${COLOR.headerBg || '#3b3833'}; color:#fff; font-size:12px; text-align:left; letter-spacing:0.4px;">${h}</th>`).join('')}</tr>
      ${body}
    </table>
    </div>
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted}; margin-top:8px;">
      <b>How to read the verdicts.</b>
      <b style="color:${COLOR.target};">BUY</b> — in a confirmed uptrend and priced near a pullback rather than extended.
      <b style="color:${COLOR.hot};">BUY ON DIP</b> — the trend qualifies but it has run too far; wait for it to pull back.
      <b style="color:${COLOR.advisory};">HOLD</b> — no fresh entry, but nothing wrong with it.
      <b style="color:${COLOR.warm};">AVOID</b> — below its 200-day line. Not necessarily falling, but no long entry here.
      <b style="color:${COLOR.stop};">SELL</b> — confirmed downtrend below a falling 30-week average.
      <br><br>
      These are trend verdicts on the underlying, and they answer "is this healthy?". They are <i>not</i> the same question as
      "is there an option worth buying today?" — that is the narrower dip trigger, and its answers are the HOT picks below.
      A symbol can read BUY here and still produce no option pick, which simply means it is in good shape but not on sale.
    </div>
  </div>`;
}

// The headline expectancy is an 8-year average, and an average can hide a
// signal that helps in some years and hurts in others. This one does: the
// dip entry's edge over simply buying on a random day flips sign roughly
// year to year. Saying "+3.3% per trade" without saying that would be
// technically true and practically misleading, so the year-by-year split is
// shown whenever it is unstable — not buried in a repo file.
function buildEdgeStabilityNote(s) {
  const yrs = s?.byYear;
  if (!Array.isArray(yrs) || yrs.length < 3) return '';
  const pos = s.positiveYears, tot = s.totalYears;
  const stable = pos === tot || pos === 0;
  const cells = yrs.map(r => {
    const good = r.edge > 0;
    return `<td style="padding:5px 7px; text-align:center; border:1px solid ${COLOR.border}; font-size:12px;">
      <div style="color:${COLOR.muted};">${r.year}</div>
      <div style="font-weight:700; color:${good ? COLOR.target : COLOR.stop};">${r.edge >= 0 ? '+' : ''}${(r.edge * 100).toFixed(2)}</div>
    </td>`;
  }).join('');

  return `
    <div style="margin:10px 0 4px; padding:12px 14px; background:${COLOR.card}; border:1px solid ${COLOR.advisoryBorder}; border-radius:5px;">
      <div style="font-size:14px; font-weight:700; color:${stable ? COLOR.text : COLOR.advisory}; margin-bottom:6px;">
        ${stable ? 'Edge is consistent across years' : `⚠ The edge is NOT consistent — it helped in ${pos} of ${tot} years and hurt in ${tot - pos}`}
      </div>
      <div style="font-size:14px; line-height:1.7; color:${COLOR.text}; margin-bottom:8px;">
        This row is the honest one. It asks: after a buy signal, did the fund actually rise <i>more</i> over the next 21 days than
        it would have on any random day? Positive means the timing added something; negative means you'd have done better
        buying blind.
        ${stable ? '' : ` It swings from <b style="color:${COLOR.stop};">${(s.worstYearEdge * 100).toFixed(2)}</b> in its worst year to
        <b style="color:${COLOR.target};">+${(s.bestYearEdge * 100).toFixed(2)}</b> in its best.`}
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:8px;"><tr>${cells}</tr></table>
      <div style="font-size:13px; line-height:1.6; color:${COLOR.muted};">
        <b>What this means in plain terms:</b> most of what this strategy earns comes from the market drifting upward over three weeks
        (${(s.baselineLong.avgReturn * 100).toFixed(2)}% on average, for buying <i>anything</i> on <i>any</i> day) multiplied by the leverage an option gives you —
        not from the dip timing being clever. The timing contributes about ${(s.callEdgeVsBaseline * 100).toFixed(2)} percentage points on average,
        and that contribution is unreliable. Treat this as a disciplined way to take leveraged long exposure with defined size and defined exits,
        <b>not</b> as a system that predicts which dips will bounce. In a year when the market falls, expect it to lose money.
      </div>
    </div>`;
}

function buildEvidenceBanner() {
  let bt;
  try { bt = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'backtest_results.json'), 'utf8')); }
  catch { return ''; }

  const o = bt.optionSim, s = bt.signalEdge;
  const negative = o.expectancy <= 0;
  const tone = negative
    ? { bg: '#fdf1e8', border: COLOR.stop, fg: COLOR.stop }
    : { bg: '#eef3ea', border: '#c9dcc0', fg: COLOR.target };

  return `
  <div style="margin-bottom:16px; background:${tone.bg}; border:2px solid ${tone.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:16px; font-weight:700; color:${tone.fg}; margin-bottom:8px;">
      ${negative ? '⚠ These rules have NOT been shown to make money' : '✓ Measured expectancy is positive'}
    </div>
    <div style="font-size:15px; line-height:1.7; color:${COLOR.text}; margin-bottom:10px;">
      ${negative
        ? `Tested against ${bt.params.years} years of real prices, these exact rules produced <b>${o.trades.toLocaleString()} trades</b> and <b>lost an average of ${Math.abs(o.expectancy * 100).toFixed(1)}% per trade</b>. Only ${(o.winRate * 100).toFixed(0)}% were winners, against the ${(bt.params.breakeven * 100).toFixed(0)}% needed just to break even. Worse: after a buy signal the fund rose <b>${(s.call.avgReturn * 100).toFixed(2)}%</b> on average over ${s.signalEdge?.holdDays || s.holdDays} days, versus <b>${(s.baselineLong.avgReturn * 100).toFixed(2)}%</b> for simply buying on any random day — so the signal picked <i>worse</i> than chance. Treat everything below as research output, not advice to place money.`
        : `Tested over ${bt.params.years} years: ${o.trades.toLocaleString()} trades, ${(o.winRate * 100).toFixed(0)}% win rate, ${(o.expectancy * 100).toFixed(2)}% average per trade.`}
    </div>
    ${buildEdgeStabilityNote(s)}
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted};">
      <b>In market terms:</b> ${o.trades.toLocaleString()} simulated trades, win rate ${(o.winRate * 100).toFixed(1)}% vs ${(bt.params.breakeven * 100).toFixed(1)}% breakeven, expectancy ${(o.expectancy * 100).toFixed(2)}%/trade, mean hold ${o.avgDays.toFixed(1)}d. Signal edge vs buy-and-hold baseline: ${(s.callEdgeVsBaseline * 100).toFixed(2)}%. Option leg is Black-Scholes-approximated (IV proxied at 1.15x realized, 2% spread each way); underlying moves are exact. Run <code>npm run backtest</code> to reproduce.
    </div>
  </div>`;
}

// Real headlines, shown for you to read. Deliberately NOT scored or turned
// into a signal — see news.js for why that line is drawn where it is.
function buildNewsBlock(marketNews, hot) {
  const item = n => `
    <div style="font-size:14px; line-height:1.6; color:${COLOR.text}; margin-bottom:7px;">
      <span style="color:${COLOR.muted}; font-size:12px;">${new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      &nbsp;${n.url ? `<a href="${n.url}" style="color:${COLOR.text}; text-decoration:underline;">${n.headline}</a>` : n.headline}
      <span style="color:${COLOR.muted}; font-size:12px;">— ${n.source}</span>
    </div>`;

  const perPick = (hot || []).filter(w => w.news?.length).map(w => `
    <div style="margin-top:12px;">
      <div style="font-size:14px; font-weight:700; color:${COLOR.text}; margin-bottom:5px;">${w.symbol}</div>
      ${w.news.map(item).join('')}
    </div>`).join('');

  if (!marketNews?.length && !perPick) return '';

  return `
  <div style="margin:24px 0; background:${COLOR.card}; border:1px solid ${COLOR.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:15px; font-weight:700; color:${COLOR.text}; margin-bottom:4px;">📰 What's in the news</div>
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted}; margin-bottom:10px;">
      Real headlines from the last couple of days, for you to read and weigh. They are <b>not</b> scored or used to pick anything — turning news into a number would mean inventing that number, and nothing else here works that way.
    </div>
    ${marketNews?.length ? `<div style="font-size:14px; font-weight:700; color:${COLOR.text}; margin-bottom:5px;">Market &amp; macro</div>${marketNews.map(item).join('')}` : ''}
    ${perPick}
  </div>`;
}

// Defined-risk put credit spreads — the only structure here with measured
// positive expectancy. Shown above the long-option picks for that reason.
function buildSpreadBlock(spreads) {
  if (!spreads?.length) return '';

  const rows = spreads.map((s, i) => `<tr style="background:${zebra(i)};">
      ${td(`<b>${s.symbol}</b>`)}
      ${td(`Sell $${s.shortLeg.strike}p<br>Buy $${s.longLeg.strike}p`, 'font-size:14px;')}
      ${td(`${s.shortLeg.expiration}<br><span style="color:${COLOR.muted}; font-size:13px;">${s.dte}d</span>`)}
      ${td(`<b style="color:${COLOR.target};">$${s.credit.toFixed(2)}</b>`)}
      ${td(`$${s.maxLoss.toFixed(2)}`, `color:${COLOR.stop};`)}
      ${td(`<b>${(s.targetReturnOnRisk * 100).toFixed(1)}%</b>`, `color:${COLOR.target};`)}
      ${td(`$${s.breakeven.toFixed(2)}<br><span style="color:${COLOR.muted}; font-size:13px;">${(s.breakevenPct * 100).toFixed(1)}%</span>`)}
      ${td(`$${s.closeAt.toFixed(2)}`)}
    </tr>`).join('');

  return `
  <div style="margin:24px 0;">
    <div style="font-size:16px; font-weight:700; color:${COLOR.target}; margin-bottom:6px;">💰 Credit Spreads — the strategy that actually tested positive</div>
    <div style="font-size:14px; line-height:1.7; color:${COLOR.text}; margin-bottom:10px;">
      Instead of <i>buying</i> an option and needing a move, you <i>sell</i> one and get paid up front. You keep the payment if the fund simply stays above the breakeven price — it can go up, sideways, or even drift down a little and you still win. A second option is bought below as a hard cap, so the worst case is a known number before you enter, not open-ended.
      <br><br>
      Over 8 years on these same funds this measured <b>+1.6% per trade at a 75% win rate</b>, versus <b>−3.3%</b> for the buying strategy below. Needs Level 3 approval, which you have.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:${FONT_STACK};">
      <thead><tr style="background:${COLOR.target};">${['Fund', 'The trade', 'Expires', 'You get paid', 'Worst case', 'Return if it works', 'Breakeven', 'Close at'].map(th).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:13px; line-height:1.7; color:${COLOR.muted}; margin-top:10px;">
      <b>How to place it:</b> on Robinhood pick the fund → Trade Options → switch to the multi-leg/spread builder → <b>Sell to Open</b> the higher strike, <b>Buy to Open</b> the lower one, same expiry, as a single order for the net credit shown. Then set a GTC buy-to-close at the "Close at" price, which takes half the payment as profit.
      <br><br>
      <b>Exit rules (tested, not guessed):</b> close at half the credit received, or at 21 days to expiry, whichever comes first.
      <br><br>
      <b>The real risk:</b> wins are frequent but small, losses are rarer and larger — averaging +15% against −40% of the amount at risk. In 2022's grinding decline this lost 5.5% per trade across the year. It is not free money.
    </div>
  </div>`;
}

// Stocks carry a risk ETFs structurally don't: one company, one earnings
// date, one piece of news. A recent large single-day move is a factual sign
// the price is already being driven by an event.
function buildStockRiskNote(hotStocks) {
  const gapped = hotStocks.filter(w => w.eventGap);
  return `
  <div style="margin:-8px 0 24px; background:#fdf1e8; border:1px solid ${COLOR.hotBorder}; border-radius:6px; padding:12px 14px;">
    <div style="font-size:14px; line-height:1.7; color:${COLOR.text};">
      <b style="color:${COLOR.hot};">Why stocks are capped at ${MAX_STOCK_PICKS}.</b> An ETF holds dozens of companies, so no single piece of news moves it much. A stock is one company — an earnings miss or a lawsuit can drop it 20% overnight, straight through your stop, before you can act. They're here because they actually move enough to reach a 12-15% target (MU rose 12%+ within 20 days on 76% of days; SPY managed 1.4%), but that same movement is the risk.
      <br><br>
      <b>Check the earnings date before buying any of these.</b> This tool does not have earnings dates and will not guess at them.
      ${gapped.length ? `<br><br><b style="color:${COLOR.hot};">Already moving on news:</b> ${gapped.map(w => `${w.symbol} moved ${w.eventGap.pct >= 0 ? '+' : ''}${w.eventGap.pct.toFixed(1)}% in a single day on ${w.eventGap.date}`).join('; ')}. A move that size is an event, not a trend — worth knowing what it was before buying into it.` : ''}
    </div>
  </div>`;
}

// The dip trigger fires roughly once every 2-3 days across the whole
// universe — that selectivity is where the 75% win rate comes from. This
// shows what's approaching it so a quiet day still tells you something.
function buildDipWatch(dipWatch) {
  if (!dipWatch?.length) return '';
  const rows = dipWatch.map((d, i) => `<tr style="background:${zebra(i)};">
      ${td(`<b>${d.symbol}</b> <span style="color:${COLOR.muted}; font-size:12px;">${d.assetType}</span>`)}
      ${td(`$${d.price.toFixed(2)}`)}
      ${td(`<b>${d.rsi2.toFixed(1)}</b>`, `color:${d.rsi2 < 10 ? COLOR.hot : COLOR.muted};`)}
      ${td(d.rsi2 < 10 ? 'very close' : d.rsi2 < 15 ? 'getting close' : 'watching')}
    </tr>`).join('');

  return `
  <div style="margin:24px 0;">
    <div style="font-size:16px; font-weight:700; color:${COLOR.text}; margin-bottom:6px;">👀 Dip Watch — approaching the buy trigger</div>
    <div style="font-size:14px; line-height:1.7; color:${COLOR.text}; margin-bottom:10px;">
      Nothing here is a buy yet. The trigger needs a 2-day RSI below 5, which is a genuinely hard drop — it happens about once every 2-3 days across all 35 symbols, and that rarity is exactly where the 75% win rate comes from. These are the ones falling toward it.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:${FONT_STACK};">
      <thead><tr style="background:${COLOR.headerBg};">${['Symbol', 'Price', '2-day RSI (need < 5)', 'Status'].map(th).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// Plain-English glossary for the column headings and recurring terms, so
// the tables can be read without already knowing options vocabulary.
function buildGlossary() {
  const terms = [
    ['Strike', 'The price the ETF has to pass for your bet to be "in the money." Think of it as the finish line.'],
    ['Expiry', 'The deadline. After this date the option is worthless, win or lose. Always exit well before it.'],
    ['Delta', 'Roughly how much the option moves per $1 the ETF moves — and loosely, the odds it finishes a winner. 0.60 means it gains about 60 cents per $1 move.'],
    ['Entry', 'What you pay per share of the contract. One contract = 100 shares, so $1.56 entry = $156 per contract.'],
    ['Target ▲', 'The price to sell at for your profit. Set this as a GTC limit sell right after buying and forget it.'],
    ['Stop ▼', 'A price on the <b>stock</b>, not the option. If the stock closes below it, the reason you bought is gone — sell and move on. Deliberately not a stop order on the option: those get triggered by ordinary price noise and still don\'t stop a bad gap.'],
    ['Size', 'How many contracts, and the total dollars that costs.'],
    ['Conv.', 'Conviction, 0-100 — how well this setup scored against the rules. Higher is a cleaner fit, not a promise.'],
    ['IV Rank', "How expensive this option is versus its own past year. 80 means pricier than 80% of the past year — you're overpaying."],
    ['ADX', 'Trend strength, 0-100. Under 20 means the price is drifting sideways; 30+ is a strong, clean trend.'],
    ['21 EMA', 'A smoothed average of the last few weeks of price. The engine buys when price dips back to this line, not when it has run far above it.'],
  ];
  return `
  <div style="margin:24px 0; background:${COLOR.zebra}; border:1px solid ${COLOR.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:15px; font-weight:700; color:${COLOR.text}; margin-bottom:10px;">📖 What the columns mean</div>
    ${terms.map(([t, d]) => `<div style="font-size:14px; line-height:1.7; color:${COLOR.text}; margin-bottom:6px;"><b>${t}</b> — ${d}</div>`).join('')}
  </div>`;
}

// The day's plain call on whether to be putting money to work. Never
// suppresses anything — the picks are listed underneath regardless.
function buildVerdictBanner(v) {
  if (!v) return '';
  const tone = v.call === 'GOOD DAY TO BUY'
    ? { bg: '#eef3ea', border: '#c9dcc0', fg: COLOR.target }
    : (v.call === 'SIT OUT' || v.call === 'NO OPTION TRADE TODAY')
    ? { bg: '#fdf1e8', border: COLOR.hot, fg: COLOR.hot }
    : { bg: '#fdf6e3', border: COLOR.warmBorder, fg: COLOR.warm };
  return `
  <div style="margin-bottom:16px; background:${tone.bg}; border:2px solid ${tone.border}; border-radius:6px; padding:14px 16px;">
    <div style="font-size:16px; font-weight:700; color:${tone.fg}; margin-bottom:8px;">Today's call: ${v.call}</div>
    ${v.plain ? `<div style="font-size:15px; line-height:1.7; color:${COLOR.text}; margin-bottom:10px;">${v.plain}</div>` : ''}
    <div style="font-size:13px; line-height:1.6; color:${COLOR.muted};"><b>In market terms:</b> ${v.reason}</div>
  </div>`;
}

// Says plainly whether the numbers below are live or last-close. A report
// generated outside market hours is still useful for planning, but every
// price in it is a leftover from the previous session and the option quotes
// especially go wide and stale overnight — acting on them as if they were
// live is how you overpay. So it's stated once, loudly, at the very top.
function buildMarketStatusBanner(marketOpen, ts) {
  if (marketOpen) {
    return `
    <div style="margin:0 0 16px; background:#eef7ee; border-left:5px solid ${COLOR.target}; border-radius:4px; padding:12px 14px;">
      <div style="font-size:15px; font-weight:700; color:${COLOR.target};">● Live — market is open</div>
      <div style="font-size:14px; line-height:1.6; color:${COLOR.text}; margin-top:4px;">
        Every price below is a real quote pulled just now (${ts} ET). These are tradable numbers.
      </div>
    </div>`;
  }
  return `
    <div style="margin:0 0 16px; background:#fdf1e8; border-left:5px solid ${COLOR.stop}; border-radius:4px; padding:12px 14px;">
      <div style="font-size:15px; font-weight:700; color:${COLOR.stop};">■ Market is CLOSED — these are last-close prices, not live</div>
      <div style="font-size:14px; line-height:1.6; color:${COLOR.text}; margin-top:4px;">
        This report was generated at ${ts} ET, while the market was shut. The scan is real and current, but every
        price shown is left over from the last session. <b>Option quotes in particular go stale and wide overnight</b> —
        the entry price you see here is not what you would pay at the open.
        <br><br>
        Use this to plan. Re-run it once the market is open (9:30am–4:00pm ET, weekdays) before placing anything.
      </div>
    </div>`;
}

function buildHtmlBody({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, marketNews, spreads, dipWatch, glance = null, marketOpen = true, ts, target }) {
  const hot = watchlist.filter(w => w.tier === 'HOT');
  const hotStocks = hot.filter(w => w.assetType === 'STOCK');
  const hotEtfs = hot.filter(w => w.assetType !== 'STOCK');
  const warm = watchlist.filter(w => w.tier === 'WARM');
  const totalDeployed = newCampaigns.reduce((s, c) => s + c.netDebit, 0);
  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const weekPct = ((weeklyPnL / target) * 100).toFixed(0);

  const stockTable = tableWrap(
    '📈 STOCKS — options on individual companies', COLOR.hot, COLOR.hot,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Entry', 'Target ▲', 'Stop ▼', 'Size', 'Conv.', '⚠'],
    buildHotRows(hotStocks), 'No stock setups cleared today.'
  );
  const etfTable = tableWrap(
    '🗂 ETFs — options on funds (baskets of many companies)', COLOR.hot, COLOR.hot,
    ['Symbol', 'Direction', 'Strike', 'Expiry', 'Delta', 'Entry', 'Target ▲', 'Stop ▼', 'Size', 'Conv.', '⚠'],
    buildHotRows(hotEtfs), 'No ETF setups cleared today.'
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
  <div style="background:${COLOR.pageHeaderBg}; color:${COLOR.headerText}; padding:20px 24px; border-radius:8px 8px 0 0;">
    <div style="font-size:19px; font-weight:700; line-height:1.4;">4-Agent Trading Council — Daily Recommendations</div>
    <div id="report-ts" data-generated="${generatedIso}" data-ts-label="${ts} ET" style="font-size:13px; color:${COLOR.pageHeaderLink}; margin-top:6px;">Report generated: ${ts} ET</div>
    <div style="font-size:13px; margin-top:10px; line-height:1.9;">
      <a href="${HOME_URL}" style="color:${COLOR.pageHeaderLink}; text-decoration:underline;">🏠 All tools — igniteshakti.com →</a>
      <span style="color:#7ea8dd; padding:0 8px;">|</span>
      <a href="${govtPageUrl()}" style="color:${COLOR.pageHeaderLink}; text-decoration:underline;">🏛 Government Stakes — where Washington is putting money →</a>
    </div>
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

    ${buildMarketStatusBanner(marketOpen, ts)}
    ${buildQuickGlance(glance)}
    ${buildEvidenceBanner()}
    ${buildVerdictBanner(verdict)}
    ${buildMacroBlock(macro)}
    ${buildNewsBlock(marketNews, hot)}
    ${stockTable}
    ${hotStocks.length ? buildStockRiskNote(hotStocks) : ''}
    ${etfTable}
    ${buildAdvisoryBlock(hot)}
    ${warmTable}
    ${buildDipWatch(dipWatch)}
    ${buildExitStrategyBlock()}
    ${buildSpreadBlock(spreads)}
    ${recTable}
    ${outcomeTable}
    ${playbookTable}
    ${buildGlossary()}

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

async function sendSessionReport({ newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist = [], playbook = [], macro = null, verdict = null, marketNews = [], spreads = [], dipWatch = [], glance = null, marketOpen = true, deliver = true }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const target = parseFloat(process.env.WEEKLY_TARGET) || 750;
  const ctx = { newCampaigns, exits, regime, weeklyPnL, monthlyPnL, watchlist, playbook, macro, verdict, marketNews, spreads, dipWatch, glance, marketOpen, ts, target };

  const text = buildTextBody(ctx);
  const html = buildHtmlBody(ctx);

  // A closed-market session still regenerates the page (so the Run button
  // always produces something current) but must not mail it — otherwise
  // every off-hours refresh lands in the inbox.
  if (!deliver) {
    console.log('[notify] Report regenerated for the page; email skipped (market closed).');
    return html;
  }

  const realizedPnL = exits.reduce((s, e) => s + (e.pnl || 0), 0);
  const subjectPnL = realizedPnL !== 0 ? ` | P&L ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)}` : '';
  const subjectTag = newCampaigns.length > 0 ? `${newCampaigns.length} new pick(s)` : exits.length > 0 ? `${exits.length} closed` : 'Daily update';
  await send(`[Trading Council] ${subjectTag}${subjectPnL} — ${ts}`, text, html);
  return html;
}

// COLOR/FONT_STACK/td/th/tableWrap are exported so the Government Stakes
// page (govt/report.js) renders in exactly this palette rather than keeping
// a second copy that silently drifts out of step with this one.
module.exports = { sendSessionReport, sendFailureAlert, buildHtmlBody, COLOR, FONT_STACK, td, th, tableWrap };
