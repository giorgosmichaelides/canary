# Canary: Q&A cheat sheet

Every number here comes from `python scripts/measure.py` or `python -m canary.sim`. Re-run them if code changes.

## The claim, in one breath

Canary replays the March 2020 currency crash as music. Four analysts each watch a slice of the FX market and play their own part. When the currencies start moving together (correlation), the parts merge, and at the peak everyone plays one note. **We don't predict anything. We make correlation, which you can't see on a price chart, audible.**

Pitch line: *"In March 2020 there was one trade: buy dollars. This is what that sounds like."*

Who it's for: anyone who watches markets. You can hear Canary while you look at something else, so a trader can leave it running in the background and notice when everything starts moving together. People who can't see the screen can follow it too.

If asked whether it's accessible: partly. The music and the blind test work without sight, but the card and the chart haven't been checked with a screen reader yet.

Blind test: press B to black out the screen while the music plays. The judges guess calm or crash, then the screen shows the date and the unison. It counts as a crash when unison or risk is 0.5 or more.

## How it works (5 steps)

1. **Data:** daily exchange rates for 7 currencies from the US Federal Reserve (H.10), all in US dollars, cached in `data/fx_daily.csv`. No internet at demo time.
2. **Four analysts:** fx (euro, pound), havens (yen, Swiss franc), commodity (Australian and Canadian dollars, Norwegian krone), contrarian (bets against whatever moved most). Each is a separate process.
3. **Each analyst's view** is three numbers: **stance** (−1 falling … +1 rising), **conviction** (0–1, how sure), **stress** (0–1, how wild).
4. **Unison** (0–1) comes from correlation and drives the music: 0 = four separate parts, 1 = one note.
5. **Risk** (0–1) decides the card. Code proposes an action, AI writes one line per analyst, a named human approves or vetoes, and the decision is logged.

## The numbers behind it

| Thing | How it's computed |
|---|---|
| Correlation | Average correlation of all 21 currency pairs' daily returns over the last **10 days** |
| Unison | 0 below correlation 0.25, 1 above 0.65, a straight line between |
| Stance | `tanh(move in "normal moves" / 2)` + personality bias (commodity +0.10) |
| "Normal move" | The slice's typical daily move over 60 days, scaled by √days |
| Personalities | fx looks back 3 days (nervous), havens 8 (calm), commodity 6 (optimist) |
| Contrarian | 20-day z-score of each group; bets against the most stretched: `−tanh(z / 1.5)` |
| Risk | `0.8 × max(divergence, unison) + 0.2 × (commodity basket fall / 10%)`, capped at 1 |
| Divergence | Havens bullish while commodity bearish ("money running to safety") |
| Card | Risk ≥ 0.50 two days in a row; no new card until risk < 0.30 |
| Action | Cut the weakest slice by 30% (50% if risk ≥ 0.75) |
| Votes | Each analyst's stance on a "risk-on" scale (havens flipped): > +0.15 dissent, < −0.15 support |
| Rebound | Commodity basket was very oversold this week (z ≤ −1.8) and bounced ≥ 1 normal move in 3 days |

## Results (same thresholds everywhere, tuned on 2020)

| Crisis | Band merges? (peak correlation) | Card | vs stop-loss rules |
|---|---|---|---|
| **2020** COVID | yes (0.68 on 18 Mar) | **2 Mar**, 14 trading days before the 20 Mar low, basket −5.2% | 8 days **ahead** of a 7.5–10% stop, 3 days **behind** a 5% stop |
| **2008** Lehman | yes (0.79) | 8 Aug, 54 days before the low | **no lead**: fires between the 5% and 7.5% stops |
| **2022** dollar spike | yes (0.84) | **never** (risk stayed high all year) | stops fired, card didn't |
| **2024** yen unwind | yes (0.79) | 22 Aug, **13 days after** the low | basket only fell 3.2%; no stop fired |

False alarms in 2020: **8 Jan and 31 Jan**. Say so.

**What approving the card does (2020, shown in the chart's third panel):** on an equal-thirds portfolio (fx, havens, commodity), cutting commodity by 30% on 2 Mar leaves you at **93.8 instead of 92.5** at the 20 Mar low (−6.2% instead of −7.5%) and **97.5 vs 97.0** on 9 Apr. A real but modest cushion; say "modest".

**The honest summary:** the merging generalises across every crisis we tried; the early warning only worked in 2020, the year we tuned on. That's why we don't claim prediction.

**Right now (Jul–Nov 2026, the `now` replay):** the band reaches full unison in late July and August (correlation 0.80), and cards fire on 28 Sep ("Cut commodity by 50%", risk 0.85) and 15 Oct. Frame it as "this is what the market sounds like right now", never as a forecast.

## Likely questions

**"Does it predict crashes?"** No. Same data drives the chart and the music. It makes correlation audible. Early warning only worked in the year we tuned on, and we show the years it didn't.

**"Isn't this overfitted to 2020?"** The thresholds were tuned on 2020, yes. We then ran 2008, 2022 and 2024 with the same thresholds, unchanged, and report the misses.

**"Why currencies, not stocks?"** Everything is priced in dollars, so high correlation means "everyone is buying dollars". It's one clean story, and the Fed publishes free daily data.

**"Why does unison hit 1 in 2024 without a crash?"** High unison means "everything moved together against the dollar". In August 2024 the dollar weakened across the board. Unison is correlation, not danger.

**"What does the AI actually do?"** It writes one sentence per analyst, after the numbers are final. It never changes a stance, a risk score or an action. Without an API key, the same lines come from templates.

**"Why 10 days for correlation?"** Short enough to react within a couple of weeks, long enough not to be noise. We fixed it early and never changed it after seeing results.

**"What happens if an analyst dies?"** Its neighbour in the ring notices the missing heartbeat within 3 seconds and covers its slice with its own personality, which is why you hear the bass line move to the pad. There's no central coordinator; killing the relay doesn't stop the analysts.

**"What's the 'basket'?"** An equal mix of the Australian dollar, Canadian dollar and Norwegian krone, the currencies that fall first in a panic.

**"Would you trade on this?"** No. It's a historical replay of a hypothetical portfolio, for demonstration only.

## Commands

```bash
python -m canary.run                       # everything, opens http://localhost:8000
python -m canary.sim --replay 2020         # every day and card, offline
python scripts/measure.py                  # the results table above
```
