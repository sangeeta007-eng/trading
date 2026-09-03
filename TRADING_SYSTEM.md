# 4-Agent Options Trading Council — Recommendation Engine

See also: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) (what each calculation
does and why) and [EXIT_STRATEGY.md](EXIT_STRATEGY.md) (exactly what to
enter on your broker to make exits automatic — GTC/OCO/trailing-stop
mechanics).

---

## Overview

A recommendation-only tool. It analyzes real ETF options data, produces exact
trade recommendations (contract, strike, limit, target, stop), and emails/
displays them. **It never places a real order anywhere** — `marketdata.js` is
a read-only market-data wrapper by design, with no account, order, or position
functions in it at all. You trade manually on your own broker (Fidelity/
Robinhood); this tool just tells you what it would do and why.

**Not locked to any one data provider.** `marketdata.js` is the *only* file
in the codebase that knows which provider supplies the data or anything
about that provider's API shape — every agent, `regime.js`, and `bot-core.js`
only ever call its generic functions (`getBars`, `getOptionsChain`,
`getOptionQuotes`, `isTradingOpen`). It's currently backed by Alpaca (free,
no trading account required — see `MARKET_DATA_*` in `.env`), purely as a
data source, never as a broker. Switching providers later means rewriting
the internals of `marketdata.js` alone; nothing else in the project changes.

Sends one report email per session to **igniteshakti@gmail.com**.

---

## The Council

### Agent 1 — Market & Technical Analyst (`council/agent1_analyst.js`)
Scans a 21-symbol liquid ETF universe (`SPY QQQ IWM DIA MDY XLK XLF XLE XLV XLI XLU XLP XLY XLB GLD TLT SLV USO UNG SOXX SMH`).
Computes 9/21 EMA, 14-period RSI, Stochastic %K/%D, and ADX(14) from real daily bars.

| Signal | Rule |
|---|---|
| **CALL** | Price > 21 EMA AND 45 < RSI < 65 AND ADX ≥ 18 |
| **PUT**  | Price < 21 EMA AND 35 < RSI < 55 AND ADX ≥ 18 |
| **NEUTRAL** | Otherwise — no recommendation (includes choppy markets, ADX < 18) |

**Entry model: pullback within an intact trend.** The trend has to be real
(right side of the 21 EMA, ADX ≥ 18, weekly timeframe agreeing), but the
entry is timed to a *pullback toward* that trend line, not a chase after an
extended move. Price more than **8% from the 21 EMA is rejected outright**
as a chase.

Each non-neutral signal gets a 0-100 **conviction score**:

| Component | Weight | What scores high |
|---|---|---|
| Entry quality | 35% | Price *close* to the 21 EMA (at it = 100, 4%+ away = 0) |
| Momentum reset | 25% | RSI near 50 — cooled back to neutral, not pinned at an extreme |
| Trend strength | 25% | ADX(14), scaled to 40 |
| Premium cheapness | 15% | Low IV Rank — but only counted when ≥10 days of real IV history exist, otherwise neutral |

This deliberately **inverts** the earlier formula, which scored *separation
from* the 21 EMA as a positive and maxed out at 3% extended — that rewarded
buying whatever had already run hardest, which is why metals near their
highs kept topping the list.

**Affordability:** contracts costing more than `MAX_PREMIUM_PER_CONTRACT`
(default $1,000, set in `.env`) are excluded from picks so one expensive
contract can't swallow a position slot. The symbol still appears in WARM
with its real cheapest qualifying price — nothing is hidden.

**Seasonality** (`council/seasonality.js`): once a setup survives every other
check, real historical data (10 years of daily bars, via the same `getBars`
call) shows each symbol's actual average return and win rate for the current
calendar month. Informational only — agreement/disagreement with the bias is
noted, never a veto. Needs 5+ complete historical years of real data or it's
skipped, not guessed.

**Macro backdrop** (`fred.js`): real Fed funds rate and the 10Y-2Y Treasury
yield curve spread, pulled from FRED (the St. Louis Fed's free public API).
Informational only, shown in every report — not yet a sizing/veto input.
Needs a free `FRED_API_KEY` in `.env`; without one, the report shows the
section as "not configured" rather than a guessed number.

### Agent 2 — Option Structurer (`council/agent2_structurer.js`)
Filters the real option chain and prices off live bid/ask — never a stale close price.

- **DTE:** 21–45 days (mutable — see Learning Loop)
- **Delta:** 0.50–0.65 (mutable)
- **Liquidity:** OI > 1,000, Volume > 500 (relaxes to OI-only if the data provider's volume feed reports 0 across the board — a known data gap), spread < $0.08
- **Entry** = real live Ask (slippage-adjusted — not the bid/ask midpoint, since a real order fills at the ask)
- **Target/Stop:** ATR(14)-based, not flat. `Target % = clamp(1.8 × ATR × Delta ÷ Entry, 15-35%)`, `Stop % = clamp(1.0 × ATR × Delta ÷ Entry, 8-20%)` — sized to that symbol's own real daily range instead of one number for every ETF, clamped to stay consistent with the 10-15% position sizing and 5% weekly-drawdown limit below. Rounded to tick ($0.01 under $3, else $0.05).
- **Expected-move filter:** skipped if `1.8 × ATR` required underlying move exceeds the option market's own implied expected move (`spot × IV × √T`) — comparing realized vol (ATR) against implied vol.

### Agent 3 — Risk & Portfolio Guardian (`council/agent3_risk.js`)
Absolute veto power. Since there's no live broker account, sizing runs
against a **configurable capital figure** — set `TOTAL_BUDGET` in `.env` to
match your real account size.

- **Regime gate:** VIX-proxy regime (`regime.js`) halts all new recommendations in extreme volatility, halves sizing and caps recommendations/session in risk-off.
- **IV pricing gates:** vetoes if IV Rank > 70 (premium too rich) or implied vol is 2x+ trailing realized vol (event-risk premium). Both skipped — not defaulted — until there's a real ≥10-sample IV history.
- **Net directional exposure cap:** sums signed delta (+call/−put) across active recommendations; vetoes if a new one would push the net beyond ±1.3 — a correlation proxy, since 3 same-direction ETF picks aren't 3 diversified bets.
- **Conviction-scaled sizing:** allocation floats within a 10-15% band of configured capital, scaled by conviction + IV favorability.
- **Max active recommendations:** 3 — counted from our own tracked recommendations (no live account to check).
- **Weekly drawdown freeze:** ≥ 5% *hypothetical* weekly loss halts new recommendations.
- **Vetoes:** `DATA_INSUFFICIENT` (missing/illiquid data) or `RISK_BOUNDS_EXCEEDED`

### Agent 4 — Chief Strategist & Learning Engine (`council/agent4_strategist.js`, `council/learning.js`)
Renders the full trade thesis with manual trade instructions, and archives
every proposal (recommended or rejected) to `council/council.db` (SQLite,
`trade_history` table). **No order is placed anywhere.**

**Outcome tracking (`council/sync.js`):** since there's no account to poll,
every session compares each active recommendation's contract against a real
live quote:
- live bid ≥ target → `CLOSED_WIN` (hypothetical — assumes you sold at target)
- live bid ≤ stop → `CLOSED_LOSS` (hypothetical — assumes you sold at stop)
- within 5 days of expiration with neither hit → `EXPIRED`, recorded at the last known live price
- no live quote available → left `ACTIVE`, never guessed

All P&L shown is **hypothetical** — it assumes you took the trade at the
recommended entry and are still holding it. It is not your real account's
P&L; this tool has no visibility into what you actually did on your broker.

**Auto-learning:** every 10 closed trades, `council/learning.js` runs a
deterministic post-mortem against `trade_history`:
- Win rate < 60% over the last 10 → delta filter tightens to 0.60–0.70
- Avg holding time > 5 days on trades below a +12% profit floor (a fixed heuristic bar, independent of each trade's own ATR-derived target) → DTE tightens to 30–45

Changes are bounded (delta ∈ [0.45, 0.80], DTE ∈ [14, 60]), logged to
`learning_log` with the triggering stats, and reversible via
`learning.revertToBaseline()`.

---

## Anti-Hallucination Guardrails

- Every price, strike, Greek, and quote comes from a live *market-data*
  call — never guessed or estimated.
- All target/stop/sizing math is deterministic arithmetic in plain JS, not text generation.
- Missing or illiquid data does not get a fallback guess — it produces a `DATA_INSUFFICIENT` veto and no recommendation.
- Outcome tracking never guesses a fill or exit price — a recommendation with no live quote stays `ACTIVE`, unresolved, rather than being assigned a fabricated outcome.

---

## Files

| File | Purpose |
|---|---|
| `bot.js` | Scheduled runner (`npm start`) — 09:50/11:00/15:00 ET weekdays |
| `bot-core.js` | Integration layer — drives the council, builds the report |
| `server.js` | Web dashboard (`npm run web`) — read-only, no order controls |
| `council/run.js` | Council orchestrator — `node council/run.js` |
| `council/agent1_analyst.js` | Market & Technical Analyst |
| `council/agent2_structurer.js` | Option Structurer |
| `council/agent3_risk.js` | Risk & Portfolio Guardian |
| `council/agent4_strategist.js` | Chief Strategist — report + recommendation logging |
| `council/sync.js` | Virtual outcome tracker (real quotes vs. target/stop/expiry) |
| `council/learning.js` | Auto-tuning post-mortem (every 10 closed trades) |
| `council/playbook.js` | Exact entry/exit detail for every active recommendation |
| `council/db.js` | SQLite persistence (`council/council.db`) |
| `council/indicators.js` | RSI, Stochastic, EMA, ADX |
| `marketdata.js` | **Read-only** market data wrapper (bars, chains, quotes) — no account/order functions exist in this file |
| `notify.js` | Email formatting and sending |
| `analytics.js` | Hypothetical weekly/monthly P&L tracking (JSON) |
| `.env` | API keys (market data only), `TOTAL_BUDGET` (your real account size), email credentials |

---

## How to Run

```bash
cd "C:\app\Trading YT"
npm start        # scheduled runner — one immediate session, then 3x/day
npm run council   # one-off run, prints the report, no scheduling
npm run web       # dashboard at http://localhost:3000
```

Set `TOTAL_BUDGET` in `.env` to your real account size before relying on the
sizing recommendations — it defaults to $25,000 otherwise.
