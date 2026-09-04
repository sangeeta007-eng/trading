/**
 * govt/report.js — builds report/govt.html, the Government Stakes page.
 *
 * Shares notify.js's palette and table helpers on purpose, so this page and
 * the daily council report look like one site rather than two.
 */
const { COLOR, FONT_STACK, td, tableWrap } = require('../notify');
const { groupByRating } = require('./scan');

// The hub page that lists these tools. Deliberately NOT SITE_BASE_URL:
// that one is where the pages are served from (GitHub Pages) and is fetched
// by CI, whereas this is only ever rendered as a link for a human to click.
// Conflating them once pointed CI at the hub page.
const HOME_URL = process.env.HOME_URL || 'https://igniteshakti.com/tradinglink';

// A deliberate gradient from green through to red, so the rating column
// reads at a glance without having to parse the words.
const RATING_COLOR = {
  'BUY': COLOR.target,
  'BUY ON DIP': COLOR.hot,
  'HOLD': COLOR.advisory,
  'AVOID': COLOR.warm,
  'SELL': COLOR.stop,
  'NO DATA': COLOR.muted,
};

// notify.js's tableWrap is built for email, where tables simply overflow.
// On the web that made the whole PAGE scroll sideways on anything narrower
// than a desktop, dragging the header and prose off-screen with it. Wrapping
// each table in its own scroller keeps the sideways scrolling inside the
// table, where it belongs, and leaves the body fixed.
function scrollable(tableHtml, minWidth) {
  return `<div style="overflow-x:auto; -webkit-overflow-scrolling:touch; margin:24px 0;">
    <div style="min-width:${minWidth}px;">${tableHtml}</div>
  </div>`;
}

// A banner row inside the table marking the start of each verdict group, so
// the buys read as one block rather than as scattered rows the eye has to
// collect. Tinted with the verdict's own colour and stating the count.
function groupHeaderRow(rating, count, colspan) {
  const color = RATING_COLOR[rating] || COLOR.muted;
  return `<tr><td colspan="${colspan}" style="padding:9px 12px; border:1px solid ${COLOR.border}; background:${COLOR.bg}; font-size:13px; font-weight:700; letter-spacing:0.4px; color:${color};">
    ${rating} <span style="font-weight:400; color:${COLOR.muted};">— ${count} ${count === 1 ? 'symbol' : 'symbols'}</span>
  </td></tr>`;
}


// A muted, distinguishable colour per sector for the mix bars. Deliberately
// low-saturation so the bars never compete with the BUY/SELL colours, which
// are what the eye should land on first.
const SECTOR_COLOR = {
  'Technology': '#3b6ea5',
  'Materials': '#8a6d3b',
  'Industrials': '#5b7c5a',
  'Healthcare': '#7d5ba6',
  'Financials': '#2f6f6f',
  'Energy': '#a5643b',
  'Utilities': '#6b7280',
  'Consumer Cyclical': '#a35b7d',
  'Consumer Staples': '#77803b',
  'Communications': '#4a6fa5',
  'Real Estate': '#8a5b5b',
};
const sectorColor = name => SECTOR_COLOR[name] || '#6b6358';

// Compact stacked bar plus the top few sector names. Renders real weights
// only — a symbol with no data says so rather than showing an empty bar,
// which would read as "0%".
function sectorMixCell(d) {
  if (!d || !d.sectors || !d.sectors.length) {
    return td('<span style="font-size:12px;">not available</span>', 'color:' + COLOR.muted + ';');
  }
  const bar = d.sectors.map(x =>
    '<div style="width:' + x.pct.toFixed(1) + '%; background:' + sectorColor(x.name) + '; height:100%; float:left;" title="' + x.name + ' ' + x.pct.toFixed(1) + '%"></div>'
  ).join('');
  const legend = d.sectors.slice(0, 3).map(x =>
    '<span style="white-space:nowrap;"><span style="display:inline-block; width:8px; height:8px; background:' + sectorColor(x.name) + '; border-radius:2px;"></span> ' + x.name + ' <b>' + x.pct.toFixed(0) + '%</b></span>'
  ).join('<br>');
  const more = d.sectors.length > 3 ? '<div style="color:' + COLOR.muted + '; font-size:11px; margin-top:2px;">+' + (d.sectors.length - 3) + ' more</div>' : '';
  return td(
    '<div style="height:7px; width:100%; background:' + COLOR.border + '; border-radius:3px; overflow:hidden; margin-bottom:5px;">' + bar + '</div>' +
    '<div style="font-size:11px; line-height:1.6;">' + legend + '</div>' + more
  );
}

// A company sits in one sector; the industry is the more useful half.
function stockSectorCell(d) {
  if (!d || (!d.sector && !d.industry)) {
    return td('<span style="font-size:12px;">not available</span>', 'color:' + COLOR.muted + ';');
  }
  return td(
    '<b style="font-size:12px;">' + (d.industry || d.sector) + '</b>' +
    (d.industry && d.sector ? '<div style="font-size:11px; color:' + COLOR.muted + '; margin-top:2px;">' + d.sector + '</div>' : ''),
    'font-size:12px;'
  );
}

// Full breakdown for the expanded row: every sector, and what the fund
// actually holds at the top.
function sectorDetail(d) {
  if (!d) return '';
  let out = '';
  if (d.sectors && d.sectors.length) {
    out += '<div style="margin-top:6px;"><b style="color:' + COLOR.text + ';">Sector breakdown:</b> ' +
      d.sectors.map(x => x.name + ' <b>' + x.pct.toFixed(1) + '%</b>').join(' · ') + '</div>';
  }
  if (d.holdings && d.holdings.length) {
    out += '<div style="margin-top:6px;"><b style="color:' + COLOR.text + ';">Top holdings:</b> ' +
      d.holdings.slice(0, 10).map(h => (h.symbol || h.name) + ' <b>' + h.pct.toFixed(1) + '%</b>').join(' · ') + '</div>';
  }
  return out;
}

function ratingCell(r) {
  const color = RATING_COLOR[r.rating] || COLOR.muted;
  return td(
    `<b style="color:${color};">${r.rating}</b><div style="font-size:11px; color:${COLOR.muted}; line-height:1.5; margin-top:3px;">${r.score != null ? r.score + '/100' : ''}</div>`
  );
}

function pct(v, { bold = false } = {}) {
  if (v == null) return td('—', `color:${COLOR.muted};`);
  const color = v >= 0 ? COLOR.target : COLOR.stop;
  return td(`${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, `color:${color}; ${bold ? 'font-weight:700;' : ''}`);
}

function money(v) {
  return v == null ? '—' : '$' + v.toFixed(2);
}

function stageCell(m) {
  const color = m.stage === 2 ? COLOR.target : m.stage === 4 ? COLOR.stop : COLOR.muted;
  return td(`<span style="color:${color}; font-weight:600;">${m.stageLabel || '—'}</span>`, 'font-size:13px;');
}

// ── Contract detail ─────────────────────────────────────────────────────────
//
// Two visually distinct states, because they mean very different things:
//   CLEARED   — the council engine would actually recommend this contract
//   REFERENCE — nothing cleared; this is what the chain looks like, with the
//               exact thresholds it fails spelled out
// A reference contract is never styled to look cleared.
function contractBlock(c) {
  if (!c) return '';

  if (c.skipped) {
    return `<div style="margin-top:8px; color:${COLOR.muted};">${c.reason}</div>`;
  }

  if (c.cleared) {
    const dirWord = c.optType === 'call' ? 'CALL' : 'PUT';
    const style = c.contract && c.contract.style ? c.contract.style : 'american';
    return `<div style="margin-top:8px; padding:10px 12px; background:#eef6ee; border:1px solid #cfe3cf; border-radius:5px; line-height:1.7;">
      <b style="color:${COLOR.target};">✓ Contract clears the council filters</b><br>
      <b style="color:${COLOR.text};">${c.symbol} $${c.strike} ${dirWord}</b> · ${style} style · expires <b>${c.expiration}</b> (${c.dte} DTE) · Δ${Math.abs(c.delta).toFixed(2)} · IV ${(c.iv * 100).toFixed(0)}%
      <br>Entry limit <b>$${c.entryLimit.toFixed(2)}</b> · target <b style="color:${COLOR.target};">$${c.targetLimit.toFixed(2)}</b> (+${(c.targetPct * 100).toFixed(0)}%) · premium stop <b style="color:${COLOR.stop};">$${c.stopLimit.toFixed(2)}</b>
      <br>Primary exit: <b style="color:${COLOR.stop};">close the trade if ${c.symbol} trades below $${c.stopUnderlying.toFixed(2)}</b> (${(c.stopUnderlyingPct * 100).toFixed(1)}% under spot) — the stop is on the stock, not the option.
      <br><span style="color:${COLOR.muted};">Costs $${(c.entryLimit * 100).toFixed(0)} per contract; the whole premium is the true worst case. Open interest ${c.openInterest}.</span>
    </div>`;
  }

  const r = c.reference;
  if (!r) {
    return `<div style="margin-top:8px; color:${COLOR.muted};">No ${c.bias ? c.bias.toLowerCase() : ''} contract: ${c.reason}</div>`;
  }

  return `<div style="margin-top:8px; padding:10px 12px; background:${COLOR.warmBg}; border:1px solid ${COLOR.warmBorder}; border-radius:5px; line-height:1.7;">
    <b style="color:${COLOR.warm};">Reference contract only — NOT a cleared recommendation</b><br>
    <b style="color:${COLOR.text};">$${r.strike} ${r.optType === 'call' ? 'CALL' : 'PUT'}</b> · ${r.style || 'american'} style · expires <b>${r.expiration}</b> (${r.dte} DTE) · Δ${Math.abs(r.delta).toFixed(2)}${r.iv ? ` · IV ${(r.iv * 100).toFixed(0)}%` : ''}
    <br>${r.bid != null ? `Bid $${r.bid.toFixed(2)} / ask $${r.ask.toFixed(2)} · ` : ''}about <b>$${r.costPerContract.toFixed(0)}</b> per contract · open interest ${r.openInterest}
    ${r.fails.length ? `<br><b style="color:${COLOR.warm};">Fails:</b> ${r.fails.join('; ')}.` : ''}
    <br><span style="color:${COLOR.muted};">Shown so the strike and expiry are visible, not because the engine endorses it. The council vetoed this symbol: ${c.reason}</span>
  </div>`;
}

// ── Companies ───────────────────────────────────────────────────────────────

function buildCompanyRows(scan, ledger, contracts, sectors) {
  const bySymbol = Object.fromEntries(ledger.positions.map(p => [p.symbol, p]));

  // Ledger order is the order deals were announced, which is not how anyone
  // reads a table of verdicts. Group by rating instead: all the buys, then
  // avoids, then sells. Symbols the scan could not price have no rating, so
  // they are appended at the end rather than silently dropped.
  const rated = scan.companies.filter(m => m && !m.error && m.rating);
  const groups = groupByRating(rated);
  const unrated = ledger.positions.filter(p => !rated.some(m => m.symbol === p.symbol));

  let i = 0;
  const renderRow = (m) => {
    const p = bySymbol[m.symbol];
    const bg = i++ % 2 === 0 ? COLOR.card : COLOR.zebra;
    const revShare = p.stakeType === 'REVENUE_SHARE';
    return `<tr style="background:${bg};">
      ${td(`<b>${p.symbol}</b><div style="font-size:11px; color:${COLOR.muted}; margin-top:3px;">${p.category}</div>`)}
      ${td(`${p.company}${revShare ? `<div style="font-size:11px; color:${COLOR.warm}; margin-top:3px;">revenue share, not ownership</div>` : ''}`, 'font-size:13px;')}
      ${td(`<b>${p.stake}</b><div style="font-size:11px; color:${COLOR.muted}; margin-top:3px;">${p.agency} · ${p.amount} · ${p.announced}</div>`, 'font-size:13px;')}
      ${stockSectorCell(sectors.get(p.symbol))}
      ${td(money(m.price))}
      ${pct(m.ret1m)}
      ${pct(m.ret3m)}
      ${stageCell(m)}
      ${ratingCell(m)}
      ${td(`<a href="${p.source}" style="color:${COLOR.advisory}; font-size:12px;">source</a>`)}
    </tr>
    <tr style="background:${bg};"><td colspan="10" style="padding:0 12px 12px 12px; border:1px solid ${COLOR.border}; border-top:none; font-size:12px; color:${COLOR.muted}; line-height:1.6;">
      <b style="color:${COLOR.text};">Why ${m.rating}:</b> ${m.why} <span style="color:${COLOR.muted};">(${m.reasons.join('; ')})</span>
      ${p.note ? `<div style="margin-top:6px;"><b style="color:${COLOR.text};">Note:</b> ${p.note}</div>` : ''}
      <div style="margin-top:6px;"><b style="color:${COLOR.text};">ETFs holding it:</b> ${p.etfs.map(e => `${e.symbol} <span style="color:${COLOR.muted};">(${e.name})</span>`).join(' · ')}</div>
      ${contractBlock(contracts.get(p.symbol))}
    </td></tr>`;
  };

  const body = groups.map(g =>
    groupHeaderRow(g.rating, g.rows.length, 10) + g.rows.map(renderRow).join('')
  ).join('');

  const missing = unrated.map(p => {
    const bg = i++ % 2 === 0 ? COLOR.card : COLOR.zebra;
    return `<tr style="background:${bg};">${td(`<b>${p.symbol}</b>`)}${td(p.company, 'font-size:13px;')}${td(p.stake, 'font-size:13px;')}${td('—')}${td('no price data', `color:${COLOR.muted};`)}${td('—')}${td('—')}${td('—')}${td('—')}${td('—')}</tr>`;
  }).join('');

  return body + (missing ? groupHeaderRow('NO DATA', unrated.length, 10) + missing : '');
}

// ── ETFs ────────────────────────────────────────────────────────────────────

function buildEtfRows(scan, contracts, sectors) {
  // Same grouping as the companies table — alphabetical order told you
  // nothing about what to do with any of them.
  let i = 0;
  const renderRow = (m) => {
    const bg = i++ % 2 === 0 ? COLOR.card : COLOR.zebra;
    return `<tr style="background:${bg};">
      ${td(`<b>${m.symbol}</b>`)}
      ${td(m.name || '—', 'font-size:13px;')}
      ${td(m.holds.join(', '), `font-size:12px; color:${COLOR.hot}; font-weight:600;`)}
      ${sectorMixCell(sectors.get(m.symbol))}
      ${td(money(m.price))}
      ${pct(m.ret1m)}
      ${pct(m.ret3m)}
      ${pct(m.ret6m)}
      ${stageCell(m)}
      ${ratingCell(m)}
    </tr>
    <tr style="background:${bg};"><td colspan="10" style="padding:0 12px 12px 12px; border:1px solid ${COLOR.border}; border-top:none; font-size:12px; color:${COLOR.muted}; line-height:1.6;">
      <b style="color:${COLOR.text};">Why ${m.rating}:</b> ${m.why} <span style="color:${COLOR.muted};">(${m.reasons.join('; ')})</span>
      ${sectorDetail(sectors.get(m.symbol))}
      ${contractBlock(contracts.get(m.symbol))}
    </td></tr>`;
  };

  return groupByRating(scan.etfs.filter(m => m.rating))
    .map(g => groupHeaderRow(g.rating, g.rows.length, 10) + g.rows.map(renderRow).join(''))
    .join('');
}

// ── Discovery ───────────────────────────────────────────────────────────────

function clamp(str, n) {
  return str.length <= n ? str : str.slice(0, n - 1).trimEnd() + '…';
}

// One filing was co-signed by 44 agencies and rendered as a 600px-tall row.
function agencyLabel(c) {
  const shown = c.agencies || [];
  if (!shown.length) return '—';
  const extra = (c.agencyCount || shown.length) - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra} more` : '');
}

function buildDiscoveryBlock(disc) {
  // A feed outage must not read as "no new deals" — those look identical on
  // screen and mean opposite things. Say which one happened, and still show
  // the last known filings underneath rather than an empty table.
  const staleBanner = disc.checked ? '' : `<div style="margin:24px 0 -8px 0; padding:14px 16px; background:${COLOR.warmBg}; border:1px solid ${COLOR.warmBorder}; border-radius:6px; font-size:14px; line-height:1.7; color:${COLOR.text};">
      <b style="color:${COLOR.warm};">Could not check for new positions this run.</b>
      The Federal Register feed did not answer${disc.error ? ` (${disc.error})` : ''}. Anything listed below is the last known state, not a confirmed "nothing new" — and nothing is marked NEW, because nothing was verified this run.
    </div>`;

  if (!disc.allCandidates.length) {
    return staleBanner || `<div style="margin:24px 0; padding:14px 16px; background:${COLOR.advisoryBg}; border:1px solid ${COLOR.advisoryBorder}; border-radius:6px; font-size:14px; line-height:1.7; color:${COLOR.advisory};">
      Watch feed checked — no Defense Production Act filings in the last 120 days matched. That is a quiet feed, not proof no deal was announced; these are usually revealed in press releases first.
    </div>`;
  }

  const rows = disc.allCandidates.slice(0, 12).map((c, i) => {
    const bg = c.isNew ? COLOR.hotBg : (i % 2 === 0 ? COLOR.card : COLOR.zebra);
    return `<tr style="background:${bg};">
      ${td(c.isNew ? `<b style="color:${COLOR.hot};">NEW</b>` : '', 'width:50px;')}
      ${td(c.date)}
      ${td(`<a href="${c.url}" style="color:${COLOR.text};">${clamp(c.title, 130)}</a><div style="font-size:11px; color:${COLOR.muted}; margin-top:3px;">${c.type || ''}</div>`, 'font-size:13px;')}
      ${td(agencyLabel(c), `font-size:12px; color:${COLOR.muted};`)}
    </tr>`;
  }).join('');

  const table = scrollable(tableWrap(
    `🆕 Watch feed — Federal Register, last 120 days${disc.newCandidates.length ? ` (${disc.newCandidates.length} new since last refresh)` : ''}`,
    COLOR.hot, COLOR.hot,
    ['', 'Published', 'Document', 'Agency'],
    rows,
    'No matching filings in the window.'
  ), 640);

  return staleBanner + table + `
    <div style="margin:-10px 0 24px 0; padding:14px 16px; background:${COLOR.advisoryBg}; border:1px solid ${COLOR.advisoryBorder}; border-radius:6px; font-size:13px; line-height:1.7; color:${COLOR.advisory};">
      <b>What this feed is, precisely.</b> There is no API that returns "companies the government has bought into" — these deals are announced in press releases and 8-Ks, in prose, with no schema. So this watches the Federal Register (authoritative and dated) for the rulemaking and notices that travel alongside the programme, and lists anything mentioning an equity, warrant or investment structure.
      <br><br>
      It is a <b>reading list, not a detector</b>. A filing here does not mean a new company was added, and a quiet feed does not prove none was. Nothing from it is ever written into the tracked list automatically: a wrong entry would put a fabricated government stake in a named company on a public page, so promoting one is a deliberate human decision. Cross-check against the trackers linked at the bottom.
    </div>`;
}

// ── Private / not-listed positions ──────────────────────────────────────────

function buildPrivateRows(ledger) {
  return ledger.privatePositions.map((p, i) => `<tr style="background:${i % 2 === 0 ? COLOR.card : COLOR.zebra};">
      ${td(`<b>${p.company}</b>`, 'font-size:13px;')}
      ${td(p.category, 'font-size:13px;')}
      ${td(p.agency, 'font-size:13px;')}
      ${td(p.amount, 'font-size:13px;')}
      ${td(p.stake, `font-size:12px; color:${COLOR.muted};`)}
      ${td(p.announced, 'font-size:13px;')}
    </tr>`).join('');
}

// ── Summary banner ──────────────────────────────────────────────────────────

function buildSummary(scan) {
  const all = [...scan.companies, ...scan.etfs];
  const count = r => all.filter(x => x.rating === r).length;
  const cell = (n, label, color) => `<div style="display:inline-block; min-width:92px; margin:0 4px 8px 4px; text-align:center;">
      <div style="font-size:26px; font-weight:700; color:${color}; line-height:1.3;">${n}</div>
      <div style="font-size:12px; color:${COLOR.muted}; line-height:1.5;">${label}</div>
    </div>`;

  return `<div style="margin:20px 0; padding:16px; background:${COLOR.card}; border:1px solid ${COLOR.border}; border-radius:6px; text-align:center;">
    ${cell(count('BUY'), 'BUY', COLOR.target)}
    ${cell(count('BUY ON DIP'), 'BUY ON DIP', COLOR.hot)}
    ${cell(count('HOLD'), 'HOLD', COLOR.advisory)}
    ${cell(count('AVOID'), 'AVOID', COLOR.warm)}
    ${cell(count('SELL'), 'SELL', COLOR.stop)}
    <div style="font-size:12px; color:${COLOR.muted}; margin-top:12px; line-height:1.6;">${scan.companies.length} companies · ${scan.etfs.length} ETFs · rated on the trend, not on the size of the government's cheque</div>
  </div>`;
}

// ── Method + limits ─────────────────────────────────────────────────────────

function buildMethodBlock() {
  return `<div style="margin:24px 0; padding:16px 18px; background:${COLOR.advisoryBg}; border:1px solid ${COLOR.advisoryBorder}; border-radius:6px; font-size:14px; line-height:1.8; color:${COLOR.text};">
    <div style="font-weight:700; margin-bottom:8px;">How BUY / SELL is decided here</div>
    Same ruleset as the daily council page — deliberately, so the two halves of this site cannot disagree about the same symbol on the same day. Nothing about the government stake feeds the rating; a big federal cheque does not make a Stage 4 chart a buy.
    <ul style="margin:10px 0 0 0; padding-left:20px;">
      <li style="margin-bottom:6px;"><b>Weinstein stage</b> (30-week / 150-day MA and its slope) — the quality filter. Stage 4 is an automatic SELL.</li>
      <li style="margin-bottom:6px;"><b>The 200-day</b> — a hard gate. Below it, nothing can be rated BUY.</li>
      <li style="margin-bottom:6px;"><b>ADX(14)</b> scored against Raschke's 30 bar — most names sit below it, and are scored down rather than the bar being quietly lowered.</li>
      <li style="margin-bottom:6px;"><b>Distance from the 20-EMA</b> — entry quality. An extended Stage 2 name gets BUY ON DIP, not BUY.</li>
      <li><b>RSI(14)</b> — penalises stretched prices.</li>
    </ul>
    <div style="margin-top:10px;"><b>The five verdicts.</b> <b style="color:${COLOR.target};">BUY</b> = Stage 2, above the 200-day, entry not extended. <b style="color:${COLOR.hot};">BUY ON DIP</b> = the trend qualifies but price is stretched, so wait for a pullback. <b style="color:${COLOR.advisory};">HOLD</b> = above the 200-day with no tradable trend either way. <b style="color:${COLOR.warm};">AVOID</b> = under the 200-day but not in a confirmed downtrend — no long entry, which is not the same as a sell. <b style="color:${COLOR.stop};">SELL</b> = Stage 4, a confirmed downtrend.</div>
    <div style="margin-top:12px; padding-top:12px; border-top:1px solid ${COLOR.advisoryBorder};">
      <b>What this page does not know.</b> It has no position sizing, no stop, and no view on your account — those live on the council page. It cannot see ETF holdings: the company-to-fund mapping is curated by hand from issuer material and <b>should be re-checked at the issuer before you act on it</b>, because funds add and drop names without notice. And a government stake is not a floor — Washington can be underwater on these exactly as anyone else can.
    </div>
  </div>`;
}

// ── Page ────────────────────────────────────────────────────────────────────


// ── Quick view ──────────────────────────────────────────────────────────────
//
// One table, everything in it, no prose. The detailed tables below carry the
// reasoning, the stake terms, the contracts and the holdings; this exists so
// the whole picture is legible in a single glance before any of that.
// Sections for ETFs and STOCKS, and within each, the verdict groups in the
// same order used everywhere else on the page.

// Top two sectors as plain text. The stacked bar belongs in the detailed
// table — at a glance, two names and two numbers read faster than a graphic.
function quickSectors(d) {
  if (!d) return '<span style="color:' + COLOR.muted + ';">—</span>';
  if (d.type === 'STOCK') {
    return d.industry || d.sector || '<span style="color:' + COLOR.muted + ';">—</span>';
  }
  if (!d.sectors || !d.sectors.length) return '<span style="color:' + COLOR.muted + ';">—</span>';
  return d.sectors.slice(0, 2)
    .map(x => x.name + ' <b>' + x.pct.toFixed(0) + '%</b>')
    .join('<span style="color:' + COLOR.muted + ';"> · </span>');
}

function quickSectionRow(title, count) {
  return '<tr><td colspan="6" style="padding:10px 12px; border:1px solid ' + COLOR.border + '; background:' + COLOR.headerBg + '; color:' + COLOR.headerText + '; font-size:13px; font-weight:700; letter-spacing:0.5px;">' +
    title + ' <span style="font-weight:400; color:#c9c3b8;">— ' + count + '</span></td></tr>';
}

function buildQuickRows(rows, sectors, nameFor) {
  let i = 0;
  return groupByRating(rows).map(g =>
    groupHeaderRow(g.rating, g.rows.length, 6) +
    g.rows.map(m => {
      const bg = i++ % 2 === 0 ? COLOR.card : COLOR.zebra;
      return '<tr style="background:' + bg + ';">' +
        td('<b>' + m.symbol + '</b>') +
        td(nameFor(m), 'font-size:12px;') +
        td(quickSectors(sectors.get(m.symbol)), 'font-size:12px;') +
        td(money(m.price)) +
        pct(m.ret1m) +
        td('<b style="color:' + (RATING_COLOR[m.rating] || COLOR.muted) + ';">' + m.rating + '</b>') +
      '</tr>';
    }).join('')
  ).join('');
}

function buildQuickView(scan, ledger, sectors) {
  const companyName = Object.fromEntries(ledger.positions.map(p => [p.symbol, p.company]));
  const etfRated = scan.etfs.filter(m => m.rating);
  const stockRated = scan.companies.filter(m => m && !m.error && m.rating);

  const body =
    quickSectionRow('🗂 ETFs', etfRated.length + ' funds') +
    buildQuickRows(etfRated, sectors, m => m.name || '') +
    quickSectionRow('🏢 STOCKS', stockRated.length + ' companies') +
    buildQuickRows(stockRated, sectors, m => companyName[m.symbol] || '');

  return scrollable(tableWrap(
    '⚡ Quick view — everything at a glance',
    COLOR.text, COLOR.headerBg,
    ['Symbol', 'Name', 'Sectors held', 'Price', '1M', 'Verdict'],
    body,
    'Nothing scanned.'
  ), 760);
}

function buildGovtPage({ ledger, scan, disc, contracts = new Map(), sectors = new Map(), marketOpen, ts }) {
  const generatedIso = new Date().toISOString();

  const companyTable = scrollable(tableWrap(
    '🏛 Companies the government has a position in',
    COLOR.hot, COLOR.hot,
    ['Symbol', 'Company', 'The stake', 'Sector', 'Price', '1M', '3M', 'Stage', 'Rating', ''],
    buildCompanyRows(scan, ledger, contracts, sectors),
    'No positions in the ledger.'
  ), 1120);

  const etfTable = scrollable(tableWrap(
    '🗂 ETFs holding those companies',
    COLOR.hot, COLOR.hot,
    ['Symbol', 'Fund', 'Tracked names inside', 'Sector mix', 'Price', '1M', '3M', '6M', 'Stage', 'Rating'],
    buildEtfRows(scan, contracts, sectors),
    'No ETFs mapped.'
  ), 1080);

  const privateTable = scrollable(tableWrap(
    '🔒 Positions you cannot buy directly (private companies)',
    COLOR.advisory, COLOR.headerBg,
    ['Company', 'Category', 'Agency', 'Amount', 'Stake', 'Announced'],
    buildPrivateRows(ledger),
    'None recorded.'
  ), 760);

  const failedNote = scan.failed.length
    ? `<div style="margin:16px 0; padding:12px 14px; background:${COLOR.warmBg}; border:1px solid ${COLOR.warmBorder}; border-radius:6px; font-size:13px; color:${COLOR.text}; line-height:1.6;">
        <b style="color:${COLOR.warm};">No data this run for:</b> ${scan.failed.map(f => f.symbol).join(', ')} — these are shown as blank rather than carried over from an earlier run.
      </div>` : '';

  const marketBanner = marketOpen
    ? `<div style="padding:10px 14px; background:#eef6ee; border:1px solid #cfe3cf; border-radius:6px; font-size:13px; color:${COLOR.target}; line-height:1.6;">● Market open — prices below are live.</div>`
    : `<div style="padding:10px 14px; background:${COLOR.warmBg}; border:1px solid ${COLOR.warmBorder}; border-radius:6px; font-size:13px; color:${COLOR.warm}; line-height:1.6;">● Market closed — every price below is the last close, not a live quote.</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Government Stakes — Ignite Shakti</title></head>
<body style="margin:0; padding:0; background:${COLOR.bg};">
<div style="max-width:1000px; margin:0 auto; padding:24px; font-family:${FONT_STACK}; color:${COLOR.text}; letter-spacing:0.15px;">

  <div style="background:${COLOR.headerBg}; color:${COLOR.headerText}; padding:20px 24px; border-radius:8px 8px 0 0;">
    <div style="font-size:19px; font-weight:700; line-height:1.4;">🏛 Government Stakes — where Washington is putting money</div>
    <div id="report-ts" data-generated="${generatedIso}" data-ts-label="${ts} ET" style="font-size:13px; color:#c9c3b8; margin-top:6px;">Refreshed: ${ts} ET</div>
    <div style="font-size:13px; margin-top:8px; line-height:1.8;">
      <a href="./index.html" style="color:#c9c3b8;">← Daily council recommendations</a>
      &nbsp;·&nbsp;
      <a href="${HOME_URL}" style="color:#c9c3b8;">Ignite Shakti trading home</a>
    </div>
  </div>

  <div style="background:${COLOR.card}; padding:20px 24px; border:1px solid ${COLOR.border}; border-top:none;">

    <div style="text-align:center; margin-bottom:16px;">
      <button id="refresh-btn" onclick="refreshGovt()" style="display:inline-block; background:${COLOR.hot}; color:#fff; font-weight:700; font-size:14px; border:none; cursor:pointer; padding:12px 22px; border-radius:6px; font-family:${FONT_STACK};">↻ Refresh</button>
      <div id="refresh-status" style="font-size:12px; color:${COLOR.muted}; margin-top:6px; line-height:1.7; max-width:620px; margin-left:auto; margin-right:auto;">Re-prices every company and ETF below, re-runs every rating, and checks the Federal Register for new positions.</div>
    </div>
    <script>
      // Refresh has to work from any device, not only from the machine
      // running the local server. Two environments, two honest behaviours:
      //
      //   1. Local server (npm run web) — POST /api/govt/refresh actually
      //      re-runs the scan against live market data.
      //   2. Published static site — there is no server to run a scan, and
      //      the market-data key must never be shipped to the browser. So
      //      the button fetches the newest PUBLISHED build and loads it if
      //      it is fresher than what is on screen. If it is not fresher, it
      //      says so plainly and offers the one control that does force a
      //      real rebuild from anywhere: the scheduled job on GitHub.
      //
      // What it never does is pretend. A button that appears to rescan but
      // silently shows stale prices is worse than one that says it cannot.
      var ACTIONS_URL = 'https://github.com/sangeeta007-eng/trading/actions';

      function setStatus(html, color) {
        var el = document.getElementById('refresh-status');
        el.innerHTML = html;
        el.style.color = color || '${COLOR.muted}';
      }

      function resetBtn() {
        var btn = document.getElementById('refresh-btn');
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '↻ Refresh';
      }

      async function refreshGovt() {
        var btn = document.getElementById('refresh-btn');
        btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = 'Refreshing…';
        setStatus('Checking…');

        // 1. Local server path — a genuine rescan.
        try {
          var res = await fetch('/api/govt/refresh', { method: 'POST' });
          if (res.ok) { setStatus('Rescanned — reloading.'); location.reload(); return; }
        } catch (e) { /* no local server: this is the published site */ }

        // 2. Published site — is there a newer build than the one on screen?
        try {
          var mine = document.getElementById('report-ts').getAttribute('data-generated');
          var r = await fetch(location.pathname + '?cb=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var text = await r.text();
          // Anchored on the id: 'data-generated' also appears inside this
          // very script, so an unanchored match would begin reading the
          // regex literal if the script were ever moved above the header.
          var m = text.match(/id=\"report-ts\" data-generated=\"([^\"]+)\"/);
          if (m && m[1] !== mine) {
            setStatus('A newer build is published — loading it.');
            location.reload();
            return;
          }
          var ageMin = Math.round((Date.now() - new Date(mine)) / 60000);
          var age = ageMin < 60 ? ageMin + ' minutes' : Math.round(ageMin / 60) + ' hours';
          setStatus(
            'This is already the newest published build (' + age + ' old). ' +
            'The scan cannot run in your browser — it needs the market-data key, which is deliberately never shipped to this page. ' +
            'It re-runs automatically on a schedule; to force one now from any device, ' +
            '<a href="' + ACTIONS_URL + '" target="_blank" rel="noopener" style="color:${COLOR.hot}; font-weight:700;">run the job on GitHub</a> and reload here in a couple of minutes.'
          );
        } catch (err) {
          setStatus('Could not check for a newer build: ' + err.message, '${COLOR.stop}');
        }
        resetBtn();
      }
    </script>

    ${marketBanner}
    ${buildSummary(scan)}
    ${failedNote}
    ${buildQuickView(scan, ledger, sectors)}

    <div style="margin:32px 0 8px 0; padding-top:18px; border-top:2px solid ${COLOR.border};">
      <div style="font-size:17px; font-weight:700; color:${COLOR.text};">Full detail</div>
      <div style="font-size:13px; color:${COLOR.muted}; line-height:1.6; margin-top:4px;">Everything above, with the reasoning behind each verdict, the stake terms, the contract, the sector breakdown and what each fund holds.</div>
    </div>

    ${companyTable}
    ${etfTable}
    ${buildDiscoveryBlock(disc)}
    ${privateTable}
    ${buildMethodBlock()}

    <div style="margin-top:20px; padding-top:14px; border-top:1px solid ${COLOR.border}; font-size:12px; color:${COLOR.muted}; line-height:1.7;">
      <b>Cross-check the ledger against:</b> ${ledger.trackers.map(t => `<a href="${t.url}" style="color:${COLOR.advisory};">${t.name}</a>`).join(' · ')}
      <div style="margin-top:10px;">Every stake figure on this page is copied from the linked source, not estimated. Ratings are mechanical output from price data — not advice, not a recommendation, and not a view on your circumstances. You place your own trades.</div>
      <div style="margin-top:8px;">— <a href="${HOME_URL}" style="color:${COLOR.advisory};">Ignite Shakti</a> · Government Stakes 🏛</div>
    </div>
  </div>
</div>
<script>
(function() {
  var el = document.getElementById('report-ts');
  if (!el) return;
  var generated = new Date(el.getAttribute('data-generated'));
  var ageMin = (new Date() - generated) / 60000;
  var sameDay = new Date().toDateString() === generated.toDateString();
  if (ageMin > 90 || !sameDay) {
    var h = Math.floor(ageMin / 60), m = Math.round(ageMin % 60);
    el.textContent = '⚠ These prices are from ' + el.getAttribute('data-ts-label') + ' (' + (h > 0 ? h + 'h ' : '') + m + 'm ago) — press Refresh for current ones.';
    el.style.color = '#fca5a5';
    el.style.fontWeight = '700';
  }
})();
</script>
</body></html>`;
}

module.exports = { buildGovtPage };
