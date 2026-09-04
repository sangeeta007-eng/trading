/**
 * govt/discover.js — watches for government positions the ledger does not
 * have yet.
 *
 * WHAT THIS HONESTLY IS. There is no API that returns "companies the U.S.
 * government has taken equity in." The deals are announced in press
 * releases, 8-Ks and agency statements, in prose, with no common schema.
 * Anything claiming to detect them automatically is guessing.
 *
 * So this does the part that CAN be done reliably: it queries the Federal
 * Register (free, no key, authoritative, dated) for the statutory machinery
 * these deals actually run on — Defense Production Act Title III and the
 * Section 303 presidential determinations that authorise the money — then
 * filters again on the document's own title. Each surviving hit is written
 * to candidates.json as SOMETHING TO READ, with its source link.
 *
 * It deliberately does NOT write to positions.json. A false positive there
 * would publish a fabricated government stake in a named company on a
 * public page, which is the one failure mode worth engineering against.
 * Promotion is a one-line human decision — see README in this directory.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const FR_API = 'https://www.federalregister.gov/api/v1/documents.json';

// Query terms. These are narrow on purpose. The Federal Register's full-text
// search is loose (a broad phrase matches almost any financial rulemaking),
// and the first cut of this file proved it: five of six "candidates" were
// swap margin requirements, crypto rules and a FAR overhaul. Section 303 of
// the Defense Production Act is the actual statutory mechanism behind these
// investments, so the queries aim at it rather than at the word "equity".
const QUERIES = [
  '"Defense Production Act" Title III',
  '"Presidential Determination" Defense Production Act',
  '"critical minerals" determination',
  '"strategic and critical materials"',
];

// A hit must ALSO look relevant in its own title. Full-text relevance alone
// is not enough — a document can mention the DPA once in a footnote.
const TITLE_RELEVANT = /defense production act|title iii|section 303|critical mineral|rare earth|strategic (and critical )?material|semiconductor|chips|quantum|supply chain|equity (stake|investment)|presidential determination/i;

// Routine administrative paperwork matches the terms above constantly and
// never signals a deal. Excluded so the reading list stays short enough to
// actually read.
const TITLE_NOISE = /information collection|paperwork reduction|privacy act|sunshine act|meeting notice|membership of the|senior executive service/i;

function isRelevant(doc) {
  const t = doc.title || '';
  return TITLE_RELEVANT.test(t) && !TITLE_NOISE.test(t);
}

const CANDIDATES_PATH = path.join(__dirname, 'candidates.json');

function loadCandidates() {
  try { return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8')); }
  catch { return { lastRun: null, seen: [], candidates: [] }; }
}

async function queryFederalRegister(term, sinceDate) {
  const res = await axios.get(FR_API, {
    params: {
      per_page: 20,
      order: 'newest',
      'conditions[term]': term,
      'conditions[publication_date][gte]': sinceDate,
      'fields[]': ['title', 'publication_date', 'html_url', 'document_number', 'type', 'agencies', 'abstract'],
    },
    timeout: 20000,
  });
  return res.data.results || [];
}

/**
 * Returns { newCandidates, allCandidates, checked, error }.
 * Never throws — a dead feed must degrade to "could not check", not take
 * down the whole page. The page says which of the two happened.
 */
async function discover(ledger, { lookbackDays = 120 } = {}) {
  const state = loadCandidates();
  const seen = new Set(state.seen || []);
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];

  // Tickers/companies already tracked, so an already-known deal does not
  // keep reappearing as if it were news.
  const knownWords = new Set([
    ...ledger.positions.map(p => p.company.toLowerCase().split(/\s+/)[0]),
    ...ledger.privatePositions.map(p => p.company.toLowerCase().split(/\s+/)[0]),
  ]);

  const found = new Map();
  let error = null;

  for (const term of QUERIES) {
    try {
      const docs = await queryFederalRegister(term, since);
      for (const d of docs) {
        if (!isRelevant(d)) continue;
        if (found.has(d.document_number)) continue;
        const titleWords = d.title.toLowerCase();
        found.set(d.document_number, {
          documentNumber: d.document_number,
          title: d.title,
          date: d.publication_date,
          url: d.html_url,
          type: d.type,
          // Some documents are co-signed by dozens of agencies (one carried
          // 44), which rendered as a 600px-tall table row. Keep three.
          agencies: (d.agencies || []).map(a => a.name).filter(Boolean).slice(0, 3),
          agencyCount: (d.agencies || []).length,
          matchedTerm: term,
          mentionsTracked: [...knownWords].filter(w => w.length > 3 && titleWords.includes(w)),
          isNew: !seen.has(d.document_number),
        });
      }
    } catch (err) {
      error = err.response?.status ? `Federal Register API returned ${err.response.status}` : err.message;
    }
  }

  const allCandidates = [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
  const newCandidates = allCandidates.filter(c => c.isNew);

  // A failed run must not destroy what the last good one found. Every query
  // erroring returns an empty list, and blindly persisting that would wipe
  // the stored candidates — and CI would then commit the loss. So on a
  // total failure, keep the previous list and only record the error.
  const totalFailure = !!error && allCandidates.length === 0;

  // Persist what we have now seen, so "new" means new since the last
  // refresh rather than new-to-the-lookback-window every single run.
  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify({
    lastRun: new Date().toISOString(),
    lastError: error,
    seen: [...new Set([...(state.seen || []), ...allCandidates.map(c => c.documentNumber)])].slice(-500),
    candidates: totalFailure ? (state.candidates || []) : allCandidates.slice(0, 40),
  }, null, 2));

  // On a total failure, hand the caller the last good list (nothing in it
  // marked NEW, since nothing was confirmed this run) so the page can still
  // show the feed rather than an empty table. `checked: false` tells the
  // page to label it as last-known rather than current.
  if (totalFailure) {
    const stale = (state.candidates || []).map(c => ({ ...c, isNew: false }));
    return { newCandidates: [], allCandidates: stale, checked: false, error };
  }

  return { newCandidates, allCandidates, checked: true, error };
}

module.exports = { discover, loadCandidates };
