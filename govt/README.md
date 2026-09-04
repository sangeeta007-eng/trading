# Government Stakes page

Tracks the companies the U.S. government has taken an equity position in, the
ETFs that hold them, and a BUY/SELL read on each — published as
`report/govt.html` alongside the daily council report.

```
govt/
  positions.json   the ledger — the only file you hand-edit
  scan.js          trend ratings (same rules as METHODOLOGY.md)
  discover.js      Federal Register watch feed
  options.js       strike/expiry/style per symbol
  report.js        HTML
  run.js           entry point
  candidates.json  generated: the watch feed's "already seen" set
```

## Refreshing it

| Where | How |
|---|---|
| Locally | `npm run govt` |
| Local dashboard | the **Refresh** button on the page (`POST /api/govt/refresh`) |
| Automatically | each weekday council session, plus `govt-stakes.yml` twice daily |
| From any device | **Actions → Government Stakes Page → Run workflow** on GitHub — this is what the page's Refresh button links to when it is being viewed as a published page rather than a local server |

The published page cannot rescan in the browser: doing so would mean shipping
the market-data key to every visitor. So on the static site the Refresh button
loads the newest published build and, if that is already what you are looking
at, says so and points at the workflow. It never pretends to have refreshed.

## Adding a position the government has just announced

Add an object to `positions` in `positions.json`, then `npm run govt`.

```jsonc
{
  "company":   "Example Corp",
  "symbol":    "EXMP",              // must be a real, currently-traded ticker
  "category":  "Critical Minerals",
  "stakeType": "EQUITY",            // EQUITY | WARRANTS | EQUITY_SUBSIDIARY | REVENUE_SHARE
  "agency":    "Defense (Dept. of War)",
  "amount":    "$250M",
  "stake":     "8% + warrants",     // copy the wording from the source; do not compute it
  "announced": "2026-09",
  "addedOn":   "2026-09-04",
  "source":    "https://…",         // required — the page links it on every row
  "note":      "Anything that changes how to read the row.",
  "etfs": [ { "symbol": "REMX", "name": "VanEck Rare Earth/Strategic Metals ETF" } ]
}
```

Two things to get right:

- **`symbol` must actually trade.** The scan fetches 260 daily bars for it. A
  delisted ticker (U.S. Steel, post-merger) returns a short series and shows as
  `NO DATA`. Put non-listed companies in `privatePositions` instead — they
  render in their own table with no rating, which is the honest treatment.
- **`stake` is quoted, not derived.** Everything on the page traces to the
  `source` link.

`stakeType` matters: `REVENUE_SHARE` (NVDA, AMD) is a cut of China revenue, not
ownership, and the page labels it as such. `EQUITY_SUBSIDIARY` (LHX) means the
stake is in a subsidiary rather than the listed parent.

## The watch feed

`discover.js` queries the Federal Register for Defense Production Act Title III
and Section 303 determinations — the statutory machinery these deals run on.

**It is a reading list, not a detector.** No API returns "companies the
government has bought into"; the deals surface in press releases and 8-Ks, in
prose. So nothing from the feed is ever written into `positions.json`
automatically — promoting an entry is a deliberate human edit, because a false
positive would publish a fabricated government stake in a named company on a
public page.

The first version of the queries was too loose and returned swap margin rules
and crypto regulation. They are now narrow, with a second filter on the
document's own title (`TITLE_RELEVANT` / `TITLE_NOISE` in `discover.js`). If
the feed goes quiet for a long stretch, widen it there — and expect noise back.

`candidates.json` holds the seen-set so the **NEW** marker means "since the last
refresh". It is committed by CI for that reason; deleting it makes everything
look new once.

## Ratings

Same ruleset as `METHODOLOGY.md`, deliberately — so the two pages cannot
disagree about the same symbol on the same day. Shares, not options, so no
delta/IV/feasibility inputs.

| Verdict | Meaning |
|---|---|
| BUY | Stage 2, above the 200-day, entry not extended |
| BUY ON DIP | trend qualifies, price stretched — wait for the 20-EMA |
| HOLD | above the 200-day, no tradable trend either way |
| AVOID | below the 200-day but not a confirmed downtrend — no long entry |
| SELL | Stage 4, confirmed downtrend |

`AVOID` and `SELL` are deliberately separate. Collapsing them overstated the
rule: a stock basing 2% under its 200-day is not the same signal as one 20%
below a falling MA.

The size of the government's cheque is **not** an input. A federal stake does
not make a Stage 4 chart a buy, and is not a floor — Washington can be
underwater on these like anyone else.

## Contracts

For every symbol with a tradable verdict, `options.js` produces a concrete
contract — strike, expiry, style, delta, IV, entry/target/stop. Direction is
gated by the same rule as the council: **CALL needs Stage 2, PUT needs Stage
4**; HOLD and AVOID get no contract, and the page says why.

Selection is `council/agent2_structurer.js`, not a second engine. Rows come
back in one of two states:

- **Cleared** (green) — the council engine would recommend this contract.
- **Reference only** (amber) — nothing cleared, so the page shows the closest
  real contract and lists exactly which thresholds it fails.

The reference path exists because on the first run only 2 of 20 symbols
cleared, and 14 of the 18 vetoes were the **risk-budget** limits
(`MAX_PREMIUM_PER_CONTRACT`, `MIN_OPEN_INTEREST`) rather than anything about
the chart. Answering "what strike, what expiry?" with a wall of vetoes fails
the question. A reference contract is never styled to look cleared, and it
carries the veto reason inline.

Those thresholds are **imported** from the structurer, never re-typed here, so
the page always reports the numbers actually being enforced. Reference
selection targets the midpoint of the council's delta band and breaks ties on
open interest — delta alone once picked an INTC strike with 0 OI over a
near-identical one with 7,170.

A full run (29 symbols: price, rate, structure, watch feed) takes ~15s.

## Known limits

- **ETF holdings are curated by hand.** The market-data provider serves prices,
  not fund constituents. Funds add and drop names without notice, so re-check
  at the issuer before acting on the mapping.
- `SITE_BASE_URL` only affects links in the **emailed** report; the published
  pages link to each other relatively and work without it.
- `govt-stakes.yml` pulls the live `index.html` down and republishes it
  unchanged, because a Pages deploy replaces the whole site. If it cannot fetch
  it, the deploy is skipped rather than risk wiping the council report.
