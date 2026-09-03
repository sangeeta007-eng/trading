# The Methodology This Engine Runs On

Three practitioners, each doing a **different job**. They're layered, not
stacked as three versions of the same signal — which is how a real system
gets assembled.

These are faithful implementations of publicly documented principles,
simplified to what real OHLCV and options-chain data can support. **None of
these people are affiliated with this tool or endorse it**, and a simplified
version of a method is not the method. Treat this as the engine's stated
ruleset, not as anyone's track record.

---

## 1. Stan Weinstein — Stage Analysis
*"Is this thing even in a tradable trend?"* — the quality filter.

From *Secrets for Profiting in Bull and Bear Markets*. Every asset sits in
one of four stages around its **30-week moving average**:

| Stage | Condition | Action |
|---|---|---|
| 1 — Basing | Price flat, MA flat | No trade |
| **2 — Advancing** | **Price above a rising MA** | **Calls only here** |
| 3 — Topping | Price above, MA flattened | No trade |
| **4 — Declining** | **Price below a falling MA** | **Puts only here** |

Implemented as a 150-day SMA (≈30 weeks) plus its slope over the last month.
A hard gate: a CALL requires Stage 2, a PUT requires Stage 4.

**This is what now rejects gold and silver calls.** Both are Stage 4 —
below a falling 30-week MA. Under Weinstein's rules they aren't call
candidates regardless of how good the daily chart looks.

---

## 2. Linda Raschke — the ADX Pullback
*"When exactly do I enter?"* — the entry timing.

From *Street Smarts*, often called the "Holy Grail" setup. Requires:

1. **ADX ≥ 30** — a genuinely strong trend, not merely a trending one
2. Price **pulls back to the 20-period EMA**
3. Enter as the trend **resumes**

This is why the engine buys dips rather than chasing. Entry quality carries
the single largest weight in the conviction score.

**Honest note:** ADX ≥ 30 is Raschke's real threshold and most ETFs rarely
reach it — on a typical day nothing in the universe qualifies. Rather than
quietly lowering his bar, the engine scores against it (ADX 30 = full marks)
and **states in the report where a pick falls short**, e.g. *"ADX 19.9 —
below Raschke's 30 bar, conviction scored down accordingly."*

---

## 3. Paul Tudor Jones — Risk Discipline
*"How do I not blow up?"* — the risk layer.

- **The 200-day moving average is the line in the sand.** "Nothing good
  happens below the 200-day." Longs above it, shorts below it. Hard gate.
- **Asymmetric reward:risk on every trade.** Never risk more than the
  potential gain.
- **The stop is defined before entry**, never moved against you.

---

## How the target and stop are set

The goal is **12–15% on the premium**, taken quickly and repeatedly.

| | Value | Why |
|---|---|---|
| Target | 12–15% | ATR decides where *inside* the band each symbol lands — volatile underlying → nearer 15%, quiet one → nearer 12% |
| Stop | 8–10% | Keeps reward:risk ≥ 1.2:1 |
| Expiry | 30–60 DTE | A 21-DTE contract held three weeks **expires in your hand** |
| Hold | ~15 trading days | ≈3 weeks |

**The win-rate math, stated plainly:**

| Target / Stop | Breakeven win rate |
|---|---|
| 12% / 20% (old stop) | **63%** |
| 12% / 10% | **45%** |
| 15% / 10% | **40%** |

That's why the stop tightened alongside the target. **The cost is real:**
option premiums routinely swing 5–15% on ordinary noise, so a 10% stop gets
hit more often than a 20% one. Fewer big losses, more small ones.

## The feasibility check

Before any pick is shown, the engine computes whether the target is
physically reachable in the window:

```
underlying move needed = (premium × target%) ÷ delta
market's implied move  = spot × IV × √(15 ÷ 252)
```

Today's XLF pick needs a **0.65% move** in XLF against a **3.47% implied
move** over three weeks — comfortably achievable. Both numbers are real;
this is a feasibility test, not a forecast.

---

## The daily call

Every session ends with a plain verdict, derived from what the scan found:

- **GOOD DAY TO BUY** — healthy breadth, no imminent macro event, picks cleared
- **SELECTIVE** — under 15% of the universe in a tradable stage; thin participation
- **WAIT IF YOU CAN** — picks cleared, but FOMC/CPI/NFP lands within 24h, so premiums are inflated and will crush after
- **SIT OUT** — nothing cleared, or an extreme-volatility regime

It never suppresses anything. Every qualifying pick is listed underneath it.

---

## What this engine deliberately does *not* claim

1. **No backtest.** These rules are defensible in theory; they are not
   proven profitable on this universe. That remains the largest gap between
   this and any real desk.
2. **Institutions are mostly net *sellers* of premium.** IV exceeds realized
   vol roughly 80–85% of the time, and harvesting that gap is the structural
   edge. This tool only *buys* — the harder side, needing direction,
   magnitude, and timing all correct while theta bleeds daily.
3. **It knows nothing about your account.** No holdings, no positions, no
   balance. Sizing is against a configured `TOTAL_BUDGET` figure only.
4. **Nobody can time a bottom.** "Buy it low, when you know it's going up"
   isn't a method anyone has. What's implemented is a pullback *within an
   already-established trend* — a better entry price on a move already
   underway.
