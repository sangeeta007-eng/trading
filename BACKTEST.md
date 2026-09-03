# Does This Actually Work? — Measured Results

**Short answer: no. As configured, these rules lose money.**

This document exists because the honest answer to "is this the best tool for
making 12–15% on options regularly?" required measuring rather than
asserting. Run `npm run backtest` to reproduce everything below.

---

## The headline numbers

8 years of real daily prices, 21 ETFs, walk-forward with no lookahead
(the decision on any day sees only bars up to that day):

| Metric | Result |
|---|---|
| Trades | **3,145** |
| Win rate | **37.5%** |
| Breakeven win rate needed | **40.0%** |
| **Expectancy** | **−3.3% per trade** |
| Average hold | **2.1 days** |

That 2.1-day average is diagnostic: a 10% stop on an option gets hit by
ordinary daily noise, not by the thesis failing.

## Every configuration tested loses

| Target | Stop | Delta | Hold | Trades | Expectancy |
|---|---|---|---|---|---|
| 15% | 10% | 0.60 | 15d | 3,131 | −3.20% |
| 15% | 20% | 0.60 | 15d | 2,584 | −2.76% |
| 15% | 30% | 0.60 | 15d | 2,237 | −2.35% |
| 15% | 50% | 0.60 | 15d | 1,906 | −1.17% |
| 25% | 10% | 0.60 | 15d | 2,789 | −2.74% |
| 15% | 10% | 0.80 | 15d | 2,747 | −3.14% |
| 15% | 20% | 0.80 | 15d | 2,196 | −2.60% |
| 25% | 25% | 0.80 | 15d | 1,754 | −2.61% |
| 15% | 25% | 0.85 | 30d | 1,855 | −2.40% |
| 25% | 30% | 0.70 | 30d | 1,725 | −1.89% |
| 35% | 35% | 0.60 | 30d | 1,585 | −1.56% |

Widening the stop reduces the bleed but never crosses into profit. Deeper
ITM (less theta) doesn't fix it. Longer holds don't fix it.

---

## The root cause: the signal has negative edge

This is the part that matters, and it's measured on **exact price bars with
no option approximation at all**:

| | Avg 15-day move | Win rate |
|---|---|---|
| After a CALL signal | **+0.50%** | 58.4% |
| **Buying on any random day** | **+1.00%** | 58.7% |
| After a PUT signal | **−1.05%** | 42.4% |

**The buy signals select worse-than-random entries.** Doing nothing but
holding the ETF beat the signal by 0.50 percentage points per 15 days.

So this is not "a good signal ruined by option costs." The entry rules —
pullback-to-the-EMA, Weinstein Stage 2, above the 200-day, ADX floor — do
not, on this universe over this period, identify better-than-average
moments to buy. Option costs (spread, theta, and paying implied vol above
realized vol) then turn a zero-or-negative edge into a reliable loss.

---

## What the simulation approximates

Being explicit, because the conclusion depends on it:

**Exact, not approximated:**
- Every entry signal, evaluated on bars available that day only
- The underlying's actual forward price path
- The signal-edge table above

**Approximated (the option leg only):**
- Historical option prices aren't available from the data provider, so the
  option is priced with Black-Scholes
- Implied vol proxied at 1.15 × trailing realized vol. Real IV usually runs
  *above* realized vol, so if anything this flatters the buyer
- IV held constant through each trade (real IV moves, and a vol collapse
  hurts buyers further — again, flattering)
- Spread modelled at 2% each way. The live engine permits up to 8%, so this
  is generous
- Exits checked at daily closes, so gaps overshoot the target and stop in
  both directions

**Omitted:** the sector relative-strength filter (needs cross-sectional data
at each historical date). The live engine applies it, so live is slightly
stricter than what's tested.

**Sample caveat:** 2018–2026 was predominantly a bull market. That flatters
the long baseline and punishes the PUT signals. A bear-heavy sample would
shift the comparison — but the CALL-vs-baseline gap is measured *within* the
same period, so it isn't a bull-market artifact.

---

## What would have to change

In rough order of how much evidence supports them:

1. **Find a real signal first.** Nothing else matters until the entry rules
   beat the baseline. That means testing candidate rules against this
   harness *before* wiring them into the live engine — which is now
   possible, and wasn't before.

2. **Consider selling premium instead of buying it.** Implied vol exceeds
   subsequently-realized vol roughly 80–85% of the time. That gap is the
   documented structural edge, and this engine is on the wrong side of it.
   Requires margin approval and a different risk model — defined-risk credit
   spreads rather than naked short options.

3. **Widen the stop or drop it.** The 2.1-day average hold proves the stop
   is being triggered by noise. But this only reduces the loss rate; it
   doesn't create edge.

4. **Just hold the ETF.** The baseline of +1.00% per 15 days beat every
   option configuration tested. Unlevered, no theta, no spread.

---

## The rule going forward

**Re-run `npm run backtest` after any change to the entry rules.** The
result is written to `backtest_results.json` and displayed at the top of
every daily report. Shipping a rule change without re-measuring is exactly
how this engine accumulated a year of plausible-looking logic with negative
expectancy.
