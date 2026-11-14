# Canary: design detail

Companion to `CLAUDE.md` (which wins on any conflict). Read the section you are working on.

## 1. Honest claims: lead-time table

Fed H.10 daily rates, computed by `scripts/measure.py`:

The basket is the risk basket (AUD, CAD, NOK, equal weight, from 2019-11-01). Only firings inside the replay window count.

| Rule | Fired | Trading days before 20 Mar low | Basket drawdown then |
|---|---|---|---|
| The Canary card | 2 Mar | 14 | −5.2% |
| 5% drawdown stop | 26 Feb | 17 | −5.3% |
| 7.5% / 10% drawdown stop | 12 Mar | 6 | −10.4% |

Say: 8 trading days ahead of a 7.5–10% stop, 3 days **behind** a tight 5% stop. Cards on 8 Jan and 31 Jan are false alarms. Thresholds were tuned on 2020.

**Out-of-sample:** August 2024 yen carry unwind (`2024-07-01` to `2024-08-30`), same thresholds:

| Rule | Fired | Trading days before 5 Aug low | Basket drawdown then |
|---|---|---|---|
| The Canary card | 22 Aug | 13 **after** | −0.6% |
| 5% / 7.5% / 10% drawdown stop | never | – | – |

The basket only fell 3.2%, so there was no early warning. Say so. (A 31 May 2024 card is before the window, with only 20 days of history.)

## 2. Timing and data

**Replay** `2020-02-03` to `2020-04-09`: **48 trading days** × 2 s ≈ 96 s. (Counting check: 49 weekdays in that range, minus Presidents' Day 17 Feb, which has no H.10 data; Good Friday 10 Apr is outside the range. `data/fx_daily.csv` has 48 rows in the range.) One tick = one bar only at 116 bpm; at slower tempos bars are longer than ticks. The score view is keyed on dates, never bars.

**Data:** `data/fx_daily.csv`: `date,EUR,GBP,JPY,CHF,AUD,CAD,NOK`, every value in US dollars per unit, so down always means weaker against the dollar. Source Fed H.10. Covers 2019-11-01 to 2020-04-30 and 2024-05-01 to 2024-08-30 (enough for 60-day windows). If SGX's data covers any of these, cross-check one series and mention it in the pitch. If the file is missing, generate a clearly labelled synthetic tape and show "SYNTHETIC DATA" on screen.

Slices: `fx` = EUR, GBP · `havens` = JPY, CHF · `commodity` = AUD, CAD, NOK · `contrarian` = all groups.

## 3. Signals and views (pure functions; same day in, same numbers out)

| Field | Range | Formula |
|---|---|---|
| `stance` | −1..1 | `tanh(momentum / (normal_vol × √days) / 2) + temperament_bias` |
| `conviction` | 0..1 | `abs(momentum in normal moves) / 3`, clamped |
| `stress` | 0..1 | `(recent_vol / vol_60d − 1) / 2.5`, clamped |

Temperament = momentum window: `fx` 3 days (nervous), `havens` 8 days (calm), `commodity` 6 days with +0.10 bias.

**Contrarian:** 20-day z-score per group; take the most stretched; `stance = −tanh(z / 1.5)`. `rebound = true` when the risk basket had z ≤ −1.8 in the last week and its 3-day bounce ≥ one normal move.

**Risk score (every analyst, from its own book):**
- `correlation` = mean pairwise correlation of the 7 currencies' daily returns, 10-day window
- `unison` = clamp((correlation − 0.25) / (0.65 − 0.25), 0, 1)
- `divergence` = clamp((havens_stance × trust_havens − commodity_stance × trust_commodity) / 2, 0, 1)
- `risk` = 0.8 × max(divergence, unison) + 0.2 × (risk_basket_drawdown / 10%)

**Lock the correlation window in hours 0–2 and do not touch it.** Locked at 10 days (`signals.CORRELATION_WINDOW`). Correlation reaches 0.68 on 18 Mar against a 0.65 saturation point (and 0.68–0.70 again on 30 Mar and 6–8 Apr, so the band merges again near the end); any later change can lose full unison.

**As implemented** (`canary/signals.py`, `canary/views.py`):
- `normal_vol` = std dev of the slice basket's daily returns over the last 60 days (fewer at the start of the data); `recent_vol` = last 10 days.
- Each slice is judged on its equal-weight basket. The contrarian's own slice is all 7 currencies; it scans fx, havens and commodity baskets for the largest |z| and reports that group in `about`.
- `risk_basket_drawdown` is the AUD/CAD/NOK basket's fall from its peak since the start of the data. `risk` is capped at 1.
- Rebound: the risk basket's 20-day z-score was ≤ −1.8 on any of the last 5 trading days, and its 3-day move is ≥ +1 normal move. Fires 3–4 Mar and 25–26 Mar 2020.
- A day can be judged once there are 21 prices of history.

## 4. Escalation

Raise when `risk ≥ 0.50` for 2 consecutive days; re-arm only after `risk < 0.30`. Action: cut the slice with the lowest stance by 30%, or 50% if `risk ≥ 0.75`. Votes on a risk-on axis (havens flipped): > +0.15 dissent, < −0.15 support, else neutral.

As implemented: only fx, havens and commodity can be cut (the contrarian's slice is not a holding); ties go to the alphabetically first slice so every analyst proposes the same action. The havens flip uses each view's `about`, so a contrarian betting against havens counts as risk-on. 2 Mar 2020: "Cut commodity by 30%", fx and contrarian dissent, havens and commodity support.

Every analyst evaluates this rule and, when it fires, includes `escalation` with `id = "<replay>:<date>"` in its view. The relay shows one card per id, so if any analyst is alive the card appears.

**Decision record** (JSON lines, appended by relay and broadcast): `{id, verdict, reason, action, market_date, decided_at, seconds_to_decide}`.

## 5. Agent protocol

Agents never reply to each other; they only broadcast.

| type | Sender | Key fields |
|---|---|---|
| `tick` | tape | `i, date, prices` |
| `view` | analyst | `agent, ts, date, views[], covering[], risk, unison, escalation?` |
| `hb` | analyst | `agent, ts, covering[]` (every 0.5 s, independent of tape) |
| `control` | relay | `cmd` (play, pause, restart, kill, degrade, heal, revive), `target` |
| `decision` | relay | `id, verdict, reason, seconds_to_decide` |
| `reason` | analyst | `by, slice, date, text` (late line from a live Claude call) |
| `log` | any | `agent, text` |

Each analyst waits 250 ms after a tick before computing risk, so peer views are in its book. Open escalations are repeated in every view until a `decision` arrives, so a reloaded browser still gets the card.

**Trust and fade.** Per slice-view freshness, not per author: 1.0 for the first second after the newest view of that slice, then halves every 0.8 s. A coverer's fresh view gets full trust. Trust weights stances in the risk calculation and drives reverb.

**Takeover.** 3.0 s without a heartbeat = gone. Ring: `fx → havens → commodity → contrarian → fx`. A gone analyst's slice is covered by the next live one in the ring; every agent computes this from its own heartbeat table, so no election. The coverer uses its own temperament and publishes with `by` = itself. Start-up grace 4 s.

**Partition vs death.** If an analyst hears no peers at all, it assumes its own link is down and does not take over.

**Reconnect.** One newest view per slice, replaced only by a newer `ts`. When the owner's heartbeat returns, the coverer drops the slice. The browser brings the part back on the next bar line.

**Kill vs degrade.** Kill exits with no goodbye. Degrade drops 75% of the agent's own packets. Rehearse degrade only when risk is far from 0.30 and 0.50.

## 6. Claude writes footnotes only

The view is final before Claude is asked; the lookup never blocks the music.
1. Look up `by|slice|date` in `data/reasons.json` (pre-generated).
2. If missing and live mode is on, queue a call on a background thread; broadcast a `reason` message when it returns.
3. Meanwhile, and on any failure, use a template sentence from the same numbers.

Model `claude-haiku-5-5`, short timeout, no retries. System prompt: persona plus: the view is already decided; never change or contradict the stance; never invent numbers or give advice; one sentence, at most 22 words. User message: the view's numbers as JSON. Pre-generation is ~430 calls. Use `claude-sonnet-5-5` only if voices read flat. Key in `.env`.

## 7. Screen

- **Start audio** button before anything plays.
- **Score:** scrolling canvas, one staff per analyst, one note per opinion per day. Height = stance, opacity = conviction, colour = author, ring = covered by a neighbour. Risk staff is a bar. Dashed lines for escalation and decision. Click a note: date, author, numbers, reason.
- **Side panel:** meters for correlation, risk (0.50 marked), tempo; per analyst status (live / covering / down / isolated), trust bar, Kill / Degrade / Revive; decision log; desk log. Keys `K` kill fx, `R` revive fx.
- **Card:** proposed action in large type; rule and numbers (*Decided by code*); each analyst's one-liner with support / neutral / dissent chip (*Explained by AI*); reason field; Approve / Veto (veto needs a reason); open-for timer. Replay pauses and music ducks until a decision. No auto-approve.
- **Footer:** "Historical replay of a hypothetical portfolio, for demonstration only."

## 8. Done-when per person

| Person | Done when |
|---|---|
| Quant | `sim.py` prints the same card and lead-time table twice, identically, for 2020 and 2024 |
| Systems | Killing `fx` → neighbour covers within 4 s; killing the relay changes nothing in agent logs; killing any one analyst still produces the card |
| Sound and stage | The unison slider takes the band from four rhythms and registers to one note with no other input |

Sound can build against a recorded file of `view` messages before agents exist (Systems records one in hour 2).

## 9. Hour-by-hour

| Hours | Quant | Systems | Sound and stage | Checkpoint |
|---|---|---|---|---|
| 0–2 | Cache CSV (2020 + 2024), **lock correlation window** | One process sends a view, another prints it | Confirm the existing `web/` page in a browser; button makes sound; agree `view` fields | One view crosses the bus |
| 2–6 | Vol, drawdown, momentum, correlation; `fx` view | Tape, agent loop, relay with SSE; record a view file | One analyst's line from views | One analyst audible in the browser |
| 6–10 | All four analysts, risk in every analyst, unison | Four analysts, heartbeats, newest-view-wins book | All four lines, unison mapping, drone, tempo | **MVP: polyphony collapses to unison on the replay** |
| 10–13 | Escalation rule, votes, `measure.py` both windows | Decision message and log, dedupe by id, play/pause/restart | Sting, card, score view | A judge can approve a card |
| 13–15 | Pre-generate Claude lines, template fallback | Kill, takeover, reconnect, partition rule, degrade | Fade to reverb, cover voicing, rebound solo | Kill demo works 3 times in a row |
| 15–18 | Freeze numbers, update claims table | Freeze; one-command start | Record backup video, rehearse twice | No new features |

At hours 6 and 10, stop and run everything together even if parts are unfinished.

## 10. Demo script (96 s)

| Replay date | ~Seconds | What happens | What you say |
|---|---|---|---|
| 3–21 Feb | 0–28 | Correlation 0.1–0.25; four rhythms, four registers | "Each analyst plays its own market. This is what diversification sounds like." |
| ~24–25 Feb | 30–32 | **Press K.** Fx fades into reverb, pad picks up the bass line; parts still distinct | "We just killed an analyst. Nobody told the others." |
| 27–28 Feb | 34–38 | Havens bid, commodity FX sold; drone grows | "Money is moving to safety." |
| 2 Mar | 38 | Sting, card: cut commodity FX 30%. Fx and contrarian dissent | Hand the mouse to a judge: "Approve or veto." Press R to revive fx while they read |
| 3–4 Mar | 40–44 | Contrarian tries a solo after the Fed cut and is wrong | Optional: "It's allowed to be wrong, and you can hear it was." |
| 10–18 Mar | 50–62 | Correlation to 0.68; everything slows and lands on one note | "In March 2020 there was one trade: buy dollars. This is what that sounds like." |
| 25–27 Mar | 72–78 | Rebound solo over the unison | "And this is the opportunity." |
| End | 96 | Lead-time table and the 2024 result | "Fourteen trading days before the low, eight ahead of a 10% stop, three behind a 5% one. Same thresholds on the 2024 yen unwind." |

Before judging: kill the relay once on purpose and show agent logs still ticking. Show degrade separately in Q&A. Record the backup video from this exact run at hour 15.

## 11. Cut list and risks

**Cut in order:** live Claude mode → click-for-reason on the score → fading staleness (keep plain kill) → contrarian solo → 2024 replay. **Never cut:** correlation-to-unison mapping, the approval card, the kill demo.

| Risk | Guard |
|---|---|
| Venue Wi-Fi | Everything cached and vendored |
| Loopback multicast blocked | Port-per-process fallback chosen at startup |
| Claude slow or key missing | Cached lines, then templates; music never waits |
| Browser blocks audio | Start audio button |
| Unison doesn't reach 1.0 | Window locked early; manual slider to check mapping |
| Lead-time claim challenged | Full table incl. 5% stop, January false alarms, 2024 |
| Takeover inaudible | Kill only while parts are distinct (before ~5 Mar) |
| Demo machine dies | Backup video at hour 15 |
