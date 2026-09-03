# Strategy Research — What Automated Options Systems Actually Do

Prompted by the question: what do the automated ETF-options systems out
there use, and can those data points improve the suggestions here?

Everything below was tested against **this** engine's own universe and the
same 8 years of real bars, using `council/backtest.js`. Findings from the
web were treated as hypotheses to test, not as instructions to adopt.

---

## What the research consensus actually says

The published, statistically-backed rule sets in options are almost
entirely about **selling** premium, not buying it:

- **Close at 50% of max profit, or at 21 DTE, whichever comes first.**
  tastytrade's mechanical-management research across large trade samples
  found this improved risk-adjusted returns versus holding to expiration.
- **Manage the position, don't just pick the entry.** The recurring theme
  across automated-options writeups is that the value is in mechanical
  exits and rolls, not in entry cleverness.
- **The standing warning:** a bot selling puts looks excellent in a
  backtest run over a bull market, and then a sustained correction arrives
  while the signal conditions still read "go." Our own year-by-year results
  below reproduce exactly this.

Sources: [tastytrade 21 DTE / 50% profit rule](https://traderc.com/21-dte-50-percent-profit-exit-options/) ·
[Days to Expiry — the 21 DTE rule](https://www.daystoexpiry.com/blog/the-21-dte-rule-explained-when-and-why-to-close-options-positions-early) ·
[Option Alpha — automating tasty best practices](https://optionalpha.com/videos/tastys-best-practices-iron-condor-automated) ·
[Bookmap — defining bot entry/exit and risk rules](https://bookmap.com/blog/top-trading-algo-bots-automating-your-trading-strategy) ·
[Milofax/options-strategy-bot-trader (MIT)](https://github.com/Milofax/options-strategy-bot-trader)

---

## Head-to-head on our own universe, 8 years

| Strategy | Trades | Win rate | Expectancy / trade |
|---|---|---|---|
| **Buying options** (what this engine does) | 3,145 | 37.5% | **−3.3%** |
| **Selling defined-risk put spreads** | 7,577 | 75.5% | **+1.6%** |

Short spread setup tested: sell the ~0.30-delta put, buy a further-OTM put
5% below it as the cap (defined risk — never naked), 45 DTE at entry, close
at 50% of max profit or at 21 DTE. Return expressed as a percentage of
capital at risk.

### It does not depend on assuming cheap volatility

The obvious objection is that selling only looks good because the sim
assumes implied vol exceeds realized vol. Tested across that assumption:

| IV / realized vol | Win rate | Expectancy |
|---|---|---|
| **1.00** (no vol premium at all) | 76.3% | **+0.96%** |
| 1.05 | 76.0% | +1.32% |
| 1.10 | 75.5% | +1.62% |
| 1.15 | 75.2% | +1.96% |
| 1.20 | 75.0% | +2.36% |

Positive even at 1.00, where the option is priced at exactly the volatility
that subsequently occurred. The edge there comes from positive theta and
the market's upward drift, not from an assumed mispricing.

### The risk is real and it showed up

| Year | Win rate | Expectancy |
|---|---|---|
| 2019 | 80.3% | +1.73% |
| 2020 (COVID crash) | 81.7% | +4.84% |
| 2021 | 78.1% | +3.54% |
| **2022 (bear market)** | **61.0%** | **−5.54%** |
| 2023 | 71.4% | −0.32% |
| 2024 | 81.3% | +5.04% |
| 2025 | 78.5% | +2.55% |
| 2026 YTD | 70.4% | +0.37% |

Average win **+15.3%**, average loss **−40.5%**. This is the short-premium
shape: frequent small gains, occasional large ones against you. 2022 — a
grinding decline rather than a sharp crash — cost 5.5% per trade for a
year. Note that 2020 was *profitable*: a fast crash with a fast recovery
and fat post-crash premiums suits this structure; a slow bleed does not.

The 8-year average already contains that bad year.

---

## What this does not settle

- **Broker permission.** Spreads need a higher options approval level than
  buying calls. This may simply not be available on the account.
- **Assignment.** These are American-style options; early assignment on the
  short leg isn't modelled here at all.
- **Daily closes only.** Intraday spikes through the max-loss point aren't
  captured, so real losses can arrive faster than simulated ones.
- **Black-Scholes pricing throughout.** No historical option quotes exist
  in this data feed, so every option value is modelled, not observed.
- **One universe, one 8-year window**, six of which were broadly bullish.

---

## The honest summary

Buying short-dated ETF options for a repeatable 12–15% does not work here
and did not work in any configuration tested. Selling defined-risk put
spreads on the same ETFs, managed by the published 50%/21-DTE rules, tested
positive across every volatility assumption and in six years out of eight.

That is a materially better-evidenced strategy. It is also a different
activity, with different broker permissions, a different risk shape, and a
year like 2022 in its history. Switching is a decision for the account
holder, not something this tool should quietly adopt.
