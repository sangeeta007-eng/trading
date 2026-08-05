# Exit Strategy — Set It and Walk Away

This explains exactly what to enter on your broker (Fidelity/Robinhood or
similar) so a HOT recommendation's exit is fully automatic once you've
placed the entry — no daily monitoring required. This tool never places
these orders for you; it only tells you what to enter. You place them
yourself, once, marked **GTC (Good-Til-Cancelled)**.

This is order-mechanics information, not personalized investment advice —
the mechanics below are neutral; your risk tolerance decides which trail %
or which version you use.

---

## The two orders for every HOT pick

Every HOT row in the report already shows an exact **Target** price and
**Stop** price for that specific contract (computed from that symbol's real
ATR — see [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) for how). After you buy,
place both of these, both **GTC**:

### 1. Stop-Loss — protects the downside from day one

```
SELL TO CLOSE
Order type: STOP (or STOP-LIMIT)
Price:      the Stop price shown in the report
Duration:   GTC
```

If the trade fails, this fires automatically and caps the loss. You never
have to watch for it.

### 2. Take-Profit — two ways to run it

**Simple (matches the report exactly):**

```
SELL TO CLOSE
Order type: LIMIT
Price:      the Target price shown in the report
Duration:   GTC
```

Fires automatically once the option's bid reaches your limit price. You get
exactly the report's computed target, no more, no less.

**Let-it-run (trailing stop) — for capturing more if momentum continues:**

```
SELL TO CLOSE
Order type: TRAILING STOP (or TRAILING STOP-LIMIT)
Trail:      a % below the highest price the option reaches (see table below)
Duration:   GTC
```

Instead of selling at a fixed target, this order's stop price automatically
rises as the option's price rises, always staying the trail % behind the
peak. If the price keeps climbing past the original target, you keep
riding it — the order only fires once the price pulls back by the trail %
from wherever it peaked. This is the mechanism for "let a winner run
further, but never give back too much of the gain."

**Important:** verify your specific broker actually supports trailing-stop
orders on *options* contracts (not just stocks) before relying on this —
support varies by broker and account type. If unavailable, use the simple
version above, or place a standing reminder to check the position and
manually tighten your stop once it's shown a solid gain.

### Combining them: OCO

Most brokers let you place the stop-loss and take-profit (or trailing stop)
together as a single **OCO (One-Cancels-Other)** bracket — whichever fires
first automatically cancels the other, so you never end up short or holding
two conflicting resting orders. Look for "OCO" or "bracket order" in your
broker's option order ticket. If your broker doesn't support OCO for
options, place the stop-loss first (it protects you) and treat the
take-profit as a second resting order you cancel manually if the stop
fires first.

---

## Choosing a trailing-stop trail %

This is the real tradeoff, and it's yours to decide — not something this
tool can pick for you, because it depends on how much day-to-day noise
you're willing to tolerate versus how early you want gains locked in.

A **tighter trail** (e.g. 4%) locks in a meaningful profit floor sooner,
but options routinely move 5-15%+ in a single day just from bid/ask spread,
theta, or a small IV shift — unrelated to your actual thesis breaking down.
A trail that tight risks getting stopped out on ordinary noise before the
real move even happens.

A **looser trail** (e.g. 12-15%) rides out that noise better, but the
profit-floor guarantee only kicks in once the position has moved much
further in your favor.

The table below shows, for a range of trail percentages, how far the
option's price needs to have peaked (as a % gain over your entry) before
that trailing stop *guarantees* you won't sell for less than a **+10%**
gain, if it then pulls back:

| Trail % | Peak gain needed for the floor to reach +10% |
|---------|-----------------------------------------------|
| 4%      | ~14.6% |
| 6%      | ~17.0% |
| 8%      | ~19.6% |
| 10%     | ~22.2% |
| 12%     | ~25.0% |
| 15%     | ~29.4% |

(Math: once the peak price is `P`, the trailing stop sits at `P × (1 -
trail%)`. Solving `P × (1 - trail%) ≥ entry × 1.10` for the required peak
gain gives the numbers above. This is real arithmetic, not a
back-tested claim about what any specific trade will actually do.)

Read the table as: if you use an 8% trail, the position has to have shown
about a 19.6% gain at some point before the trailing stop is guaranteed to
protect at least +10%. Before that point, the trailing stop is still
active and still trailing — it just hasn't climbed high enough yet to
promise a +10% floor specifically.

A reasonable starting point for near-the-money options in the 25-45 DTE
window this tool trades: **8-10% trail**, tightened toward 4-6% only if
you're comfortable with more frequent early exits in exchange for locking
in gains sooner.

---

## HOT vs. WARM

- **HOT** — actionable now. Exact contract, entry, target, and stop are in
  the report. Place the entry, then immediately place the exit orders
  above.
- **WARM** — a real setup exists (conviction ≥ 50) but isn't actionable
  this session (see the "Why Not Yet" reason in its row — regime gate, IV
  Rank veto, correlation cap, etc.). **No orders to place yet** — nothing
  to enter, nothing to exit, until it upgrades to HOT in a later session.

---

## Why the target/stop aren't flat percentages

Target and stop are computed per symbol from that symbol's real ATR(14) —
a sleepy utility ETF and a volatile semiconductor ETF don't move the same
amount day to day, so a flat 12%/10% for both would be arbitrary. The
computed target is clamped to a 15-35% band and the stop to an 8-20% band
so a single trade's max loss stays consistent with the 10-15% position
sizing and 5% weekly-drawdown limit elsewhere in the system. See
[FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) for the full calculation.

Always use the exact $ prices from the current session's report — don't
reuse a number from a previous day, even for the same symbol.
