# 4-Agent Trading Council — Functional Specification

*A plain-language explanation of what this tool does, what it calculates, and why.*

---

## 1. What this tool actually is

It's a **daily options-recommendation generator**, not a trading bot. It looks at real market data for a list of ETFs, decides whether any of them have a genuine setup worth trading (calls or puts), works out the exact contract to use and the exact prices to enter/exit at, and hands you that plan. You then place the trade yourself, manually, on your own brokerage (Fidelity/Robinhood).

It **cannot place a real trade**. That capability was deliberately removed from the code — there is no function anywhere in the project that can submit an order to a broker. The one file that talks to a market-data provider (`marketdata.js`) only ever *reads* prices; it has no account, order, or position functions in it at all.

Everything the tool tells you is grounded in a real, freshly-fetched number — a real price, a real bid/ask, a real historical bar. If it can't get a real number for something, it says so and skips that decision rather than guessing. That rule is applied everywhere, deliberately, to avoid the tool ever inventing a plausible-looking but fake recommendation.

---

## 2. The big picture — what happens in one session

Every time the tool runs (manually, or on the 09:50 / 11:00 / 15:00 ET schedule), it does four things in order:

1. **Check on existing recommendations.** For every pick it made earlier that's still open, it fetches a fresh live quote and checks: has it hit the profit target, hit the stop-loss, or is it about to expire with neither happening? Closes it out accordingly.
2. **Scan the watchlist.** Runs the same technical analysis across ~21 liquid ETFs.
3. **Structure and risk-check any real setups.** For anything showing a genuine signal, finds the actual best option contract and runs it through the risk rules.
4. **Report.** Builds the email/dashboard: what's Hot, what's Warm, what's newly recommended, what closed out, and the exact status of everything still open.

The four "agents" are just four stages of this pipeline, each with one job, modeled loosely on how a real trading desk would divide the work: an analyst who reads the market, a quant who prices the trade, a risk officer who can veto anything, and a strategist who writes it all up.

---

## 3. Agent 1 — Market Analyst

**Job:** decide, per ETF, whether there's a real bullish or bearish setup — or nothing.

**What it looks at** (all computed from real daily price bars, pulled fresh every time):

| Indicator | What it measures, in plain terms |
|---|---|
| **9-day and 21-day EMA** (moving averages) | The recent average price, weighted toward the latest days. Price above the 21-day average = the stock's been trending up recently; below = trending down. |
| **14-day RSI** | A 0–100 momentum score. Above 50 means more up-days than down-days recently; below 50, the opposite. Extreme values (near 0 or 100) usually mean "overbought/oversold" — likely to reverse rather than continue. |
| **Stochastic Oscillator** | Similar idea to RSI — where today's price sits relative to its recent trading range. Shown for context, not used to gate the decision. |
| **ADX (14-day)** | A "is this actually trending, or just noise" score. Low ADX means the price is chopping sideways — even if RSI/EMA look fine, an established trend follower like this tool doesn't want to trade into that, because whipsaws are how you lose money on both a call and a put in the same week. |

**The actual rule:**

- **CALL (bullish)** if: price is above its 21-day average, **and** RSI is between 45–65 (trending up but not overbought), **and** ADX is 18 or higher (genuinely trending, not choppy).
- **PUT (bearish)** if: price is below its 21-day average, **and** RSI is between 35–55 (trending down but not oversold), **and** ADX is 18 or higher.
- **Otherwise: no recommendation.** This is the most common outcome by far — most days, most ETFs don't have a clean setup, and the tool says so rather than forcing a pick.

**Why these specific numbers?** The RSI bands (45–65 for calls, 35–55 for puts) are deliberately *not* the classic "70 overbought / 30 oversold" bands — those flag reversals, which is the opposite of what a trend-following entry wants. The idea here is "already moving, not yet exhausted." ADX ≥ 18 is a commonly used floor for "this is a real trend" in technical analysis — below it, most indicators (including RSI/EMA crossovers) produce a lot of false signals.

**Conviction score (0–100):** even when a setup passes the CALL/PUT test, some setups are stronger than others. This score blends three things:
- How centered RSI is in its ideal zone (55 for calls, 45 for puts) — the closer to dead-center, the higher the score.
- How far price has separated from its 21-day average — more separation = more conviction the move is real (capped so an *overextended* move doesn't score infinitely high).
- How strong the ADX trend reading is.

This score is used later to (a) decide which setups get processed first when there's more than one, and (b) scale how much money a recommendation gets sized at.

---

## 4. Agent 2 — Option Structurer

**Job:** for a symbol Agent 1 flagged, find the *actual* option contract to use and calculate the *exact* entry, target, and stop prices.

**Step 1 — narrow the option chain.** Pulls every real listed option contract for that ETF and keeps only ones that satisfy:
- **21–45 days to expiration.** Long enough that daily time-decay isn't crushing the position, short enough that capital isn't tied up for months on a short-term technical signal.
- **Delta between 0.50 and 0.65.** Delta roughly means "how much the option's price moves per $1 the stock moves" — 0.50–0.65 is solidly in-the-money-ish, meaning the option behaves a lot like owning the stock itself (high win-rate style), without paying for a deep-in-the-money contract that's mostly just tied-up capital.
- **Open interest > 1,000** (a real number of contracts already outstanding — evidence people actually trade this strike) **and bid/ask spread < $0.08** (tight enough that you're not losing a big chunk of the trade just to the market's buy/sell gap). If the exchange's volume data isn't reporting properly that day (a known real data gap), it falls back to open-interest alone rather than pretending volume is fine.

If nothing clears these bars, the tool says "no contract met these requirements" and moves on — it will not loosen the numbers to force a pick.

**Step 2 — pick the best match.** Among everything that qualifies, it picks the contract whose delta is closest to the middle of the 0.50–0.65 band (i.e., 0.575).

**Step 3 — the pricing math**, using the real live bid and ask for that specific contract:

```
Entry price   = the real live Ask                    — what you'd actually pay on a marketable order

Underlying ATR(14) = that symbol's own average true daily range over the last 14 trading days
                      (real, computed from real bars — not a guess, not the same for every symbol)

Target % = clamp(1.8 × ATR × Delta ÷ Entry, between 15% and 35%)
Stop  % = clamp(1.0 × ATR × Delta ÷ Entry, between  8% and 20%)

Target price  = Entry × (1 + Target %), rounded up to the nearest tick
Stop price    = Entry × (1 − Stop %),  rounded down to the nearest tick
```

("Tick" = the smallest allowed price increment — $0.01 for options under $3, $0.05 above that, matching how exchanges actually quote them.)

**Why ATR instead of one flat number for every symbol?** A sleepy utility ETF and a volatile semiconductor ETF don't move the same amount day to day — a flat target/stop treats them as if they did. ATR(14) is each symbol's own real, measured average daily range, so the exit distance scales with how much that specific ETF actually tends to move. Translating ATR into a premium-dollar move uses delta as the connector (first-order approximation: a $1 move in the underlying moves the option's premium by roughly delta dollars).

**Why the 15–35% / 8–20% clamp?** Raw `ATR × delta` can swing to extremes — a cheap, high-delta contract can imply a stop north of 40% of premium, which is a bigger single-trade loss than the position-sizing and weekly-drawdown limits below were built to tolerate. The clamp keeps the ATR-informed target/stop inside a band consistent with those limits, while still letting a genuinely quiet symbol get a tighter exit than a genuinely volatile one — real volatility still moves the number, it just can't run away with it. When a value gets clamped, the report says so explicitly rather than presenting a formula result that isn't actually what was used.

**Expected-move sanity check.** Options pricing itself implies an expected move for the underlying by expiration (`spot × IV × √time` — the standard ~1-standard-deviation move). Before a contract is even considered, the tool checks: would the underlying need to move *further* than that (specifically, more than 1.8 × ATR) than the option market itself expects as likely? If so, that contract is skipped — the target would be a low-probability stretch, and the tool won't recommend a target the market's own pricing is already flagging as unlikely. This is comparing two independent volatility readings — ATR is realized/historical, the expected move is implied/forward-looking.

**Rough probability of finishing in the money.** Delta (0.50–0.65, already selected for) has a well-known secondary meaning in options theory: it's a rough approximation of the probability the option finishes in-the-money by expiration. The report surfaces this directly (e.g., "~56% probability ITM") using a number already being computed — not a new "AI confidence score." A real, backtested win-rate isn't shown until there's a statistically meaningful number of closed recommendations to calculate one honestly; showing a precise-looking percentage before that would be fake precision.

Entry deliberately uses the **ask**, not the bid/ask midpoint — the midpoint is a fair-value estimate, but a real buy order fills at the ask. Pricing entry at mid would quietly assume a better fill than you'd actually get.

---

## 5. Agent 3 — Risk & Portfolio Guardian

**Job:** the last checkpoint. Everything above can be a great-looking setup and still get vetoed here. This is the only agent with veto power, and it runs a chain of checks — any one failing stops the recommendation.

Since there's no live broker account to check, "capital" is a number *you* configure (`TOTAL_BUDGET` in the settings file) — set it to match your real account size, and every sizing calculation below is a percentage of that number.

**The checks, in order:**

1. **A major economic event in the next 24 hours?** ETFs don't have one earnings date the way a single stock does, but FOMC rate decisions, CPI, and jobs reports (NFP) move all of them the same way — sharply, in both price and implied volatility, right at the release. `calendar.js` holds real, verified 2026 dates for these (pulled from the Fed's and BLS's own published schedules — needs a manual refresh once a year, since there's no live feed for dates that are announced a year in advance anyway). Within 24 hours of one of these, the tool holds off entirely rather than open a new position into a coin-flip.
2. **Market regime.** A separate module estimates current market volatility (a VIX-like proxy, computed from real SPY/VXX price data) and classifies conditions as Risk-On / Risk-Off / Extreme:
   - *Extreme volatility* → no recommendations at all this session.
   - *Risk-Off* → position sizes are cut in half, and no more than 2 new recommendations per session.
   - Either regime can also outright disallow bullish-only or bearish-only picks if conditions call for it.
3. **Is the option price reasonable, or already run up?** Two checks here:
   - **IV Rank** — how expensive this option's implied volatility is *right now* relative to its own recent history (0 = cheapest it's been, 100 = priciest). Above 70, the recommendation is vetoed — you'd be overpaying for the option regardless of how good the technical setup looks. (This check is skipped, not defaulted to "fine," until there's at least 10 days of real recorded history for that symbol — a half-informed guess isn't allowed to either pass or fail something.)
   - **IV vs. realized volatility ratio** — compares what the option market is pricing in (implied vol) against how much the stock has *actually* been moving (realized vol, computed from real price history). A ratio above 2.0 usually means the market is pricing in some specific event risk that this tool has no way to evaluate — so it steps aside rather than trade into an unknown.
4. **Too many open positions already?** Hard cap of 3 active recommendations at a time. (Counted from the tool's own tracking, since there's no broker account to check against.)
5. **Too much correlated exposure?** This is the "don't accidentally place the same bet three times" check. It adds up the *signed* delta across everything currently active (positive for calls, negative for puts) and won't let a new pick push that total beyond ±1.3. Three bullish picks on three different ETFs sounds diversified, but SPY/QQQ/IWM-type ETFs mostly move together — this check catches that and stops the portfolio from becoming one large leveraged bet dressed up as three small ones.
6. **Has the account (hypothetically) lost too much this week?** If simulated weekly P&L has dropped 5% or more, no new recommendations until the following week. A basic circuit breaker against "revenge trading" into a losing streak.

**If everything passes, position sizing:**

```
Allocation % = 10% + (5% × conviction / 100)      — floats between 10-15% of capital
Allocation $ = capital × Allocation % × regime sizing modifier
Quantity     = floor(Allocation $ / (entry price × 100))
```

So a low-conviction pick (say conviction 30) gets sized near the 10% floor; a high-conviction pick (conviction 90+) gets sized near the 15% ceiling. "Conviction" at this stage blends Agent 1's technical score with how favorably-priced the option currently is (cheap IV = bonus, rich IV = penalty) — so the sizing reflects both "is the signal strong" and "are we not overpaying for it."

---

## 6. Agent 4 — Chief Strategist

**Job:** write up the full reasoning in plain language, and log the outcome.

If the recommendation was **vetoed** anywhere in the chain, it logs a short "no trade" record with the reason (see §9 for the exact reason codes), and that's it.

If it was **approved**, it produces the full report — the technical reasoning from Agent 1, the exact contract math from Agent 2, the risk sign-off from Agent 3, and a manual trade instruction block (buy X contracts of exactly this option, at this limit price, with these target/stop prices to place yourself). It then logs the recommendation as **active** in the tracking database, using the calculated entry price as the assumed fill.

---

## 7. Hot vs. Warm — how that gets decided

This isn't a separate analysis — it's just a read of what already happened in steps 3–5:

- **🔥 Hot** = the recommendation made it all the way through Agent 3 with no veto. It's genuinely actionable right now.
- **🌤️ Warm** = Agent 1 found a real setup (conviction ≥ 50) but it got stopped somewhere downstream — usually a liquidity gate in Agent 2, or a portfolio-capacity/regime limit in Agent 3. The report tells you exactly which gate stopped it and why, so "Warm" always comes with a real reason, not just "not now."
- Anything below conviction 50 with no setup, or a straightforward NEUTRAL from Agent 1, doesn't show up in either list — it's just a pass.

---

## 8. Tracking outcomes without a real account

Since the tool can't see what you actually did on your broker, it tracks a **hypothetical** version of each recommendation: "if you'd taken this trade exactly as recommended, what would have happened by now?"

Every session, for each still-open recommendation, it fetches a fresh real quote and checks:

- **Live bid ≥ target price** → marked a win, as if you sold at target.
- **Live bid ≤ stop price** → marked a loss, as if you sold at the stop.
- **Within 5 days of expiration with neither hit** → marked "expired," priced at the last known real quote — not assumed to be a win or loss, just closed out before theta decay could erase the position.
- **No live quote available that session** → left exactly as it was. The tool will never guess a close just because it doesn't have fresh data.

The weekly/monthly P&L shown in every report is built entirely from these hypothetical outcomes. It is explicitly *not* your real account's performance — it's "how this system's picks would have performed if followed exactly."

---

## 9. Why a recommendation gets rejected — the two reason codes

Every rejected recommendation is tagged with exactly one of two reasons, so you always know *why*, not just *that*:

- **`DATA_INSUFFICIENT`** — something needed couldn't be found or confirmed with real data (no contract cleared the filters, a live quote wasn't available, not enough price history exists yet). Never guessed around.
- **`RISK_BOUNDS_EXCEEDED`** — the setup and the data were fine, but a risk rule said no (regime, IV pricing, position cap, correlation cap, drawdown freeze).

---

## 10. The auto-learning loop

Every 10 *closed* recommendations (wins + losses, not counting "expired" or rejected ones), the tool runs a mechanical post-mortem — pure arithmetic over its own trade history, not a judgment call:

- If the win rate over those last 10 was below 60%, it tightens the delta filter (from 0.50–0.65 up to 0.60–0.70) — favoring higher-probability, more in-the-money contracts going forward.
- If trades that *didn't* hit target were, on average, held more than 5 days, it tightens the DTE window (from 21–45 down to 30–45) to reduce how much time-decay eats into a stalled position.

These adjustments are **bounded** — delta can never drift outside 0.45–0.80, DTE never outside 14–60 days — and every change (or decision *not* to change anything) is logged with the exact stats that drove it. You can reset back to the original defaults at any time.

There's deliberately no backtest validating these adjustments before they apply — the free market-data tier doesn't expose enough historical options pricing to backtest honestly, and the tool would rather be transparent about that limit than pretend to have tested something it hasn't.

---

## 11. The one rule that governs everything

If a real number isn't available — a quote, a price history, enough IV samples — the tool **does not estimate one**. It either skips that specific check (if skipping is the safe direction, like the IV Rank veto) or declines to make the recommendation at all (`DATA_INSUFFICIENT`). Every calculation in this document is either pulled directly from a live API response or is deterministic arithmetic on numbers that were. There is no step anywhere in the pipeline where a number is invented, assumed, or interpolated from a hunch.

---

## 12. What it deliberately does *not* do

- Does not place, modify, or cancel any real order, anywhere, ever.
- Does not read or touch a real brokerage account or balance.
- Does not know or care what you actually did with a past recommendation.
- Does not claim the hypothetical P&L is your real performance.
- Is not locked to any specific data provider — see `marketdata.js`, the one file that knows where the numbers come from.
