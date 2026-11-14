# CLAUDE.md

## Repo

- **Repo:** `canary`
- **Product name on stage:** The Desk
- **Event:** DurHack 2026, 18-hour build, team of 3
- **Pitch:** A trading desk you can hear.

This file is the source of truth. If anything in older notes or starter code disagrees with it, this file wins.

---

## 1. What we are building

The Desk replays the March 2020 FX crash as live music. Four analyst processes each own a slice of FX data, compute a view from deterministic signals and share it peer to peer. Their disagreement is polyphony; as correlation rises the parts converge, and at the peak every part plays one note. When risk crosses a threshold, one approval card appears and a human approves or vetoes.

**Rules that hold the build together**

1. **Numbers decide, Claude explains.** Every stance, risk score, alert and proposed action comes from pure functions in `desk/signals.py` and `desk/views.py`. Claude only writes a one-line reason, attached *after* the view is computed. No model output ever reaches a stance, an alert or an action.
2. **Correlation is harmony.** One number, `unison`, pulls every part toward the same note, melody and rhythm.
3. **No hub, no single point of failure.** Agents broadcast over UDP on localhost. Every analyst computes the risk score itself. The relay only listens, displays and forwards human decisions; killing it changes nothing for the agents.
4. **Nothing at demo time touches the network.** Cached CSV, vendored Tone.js, pre-generated reason lines.

### Prize tracks
| Track | What we must show |
|---|---|
| DurHack theme: **Composition** | Independent parts combined into one data-driven piece |
| **Neptune North** | Independent agents, no hub, survive a kill and a degraded link, reconnect cleanly |
| **SGX FX** (trading storm) | Early warning, a stay-safe action, a rebound moment, on FX data |
| **Accenture** (process redesign with AI) | Escalation on one screen: code decides, AI explains, dissent on record, named human decision, measured time to decide |

---

## 2. Honest claims (say these, nothing stronger)

- The music does **not** predict anything. It makes correlation, which is invisible on a price chart, audible.
- **The FX story:** all currencies are quoted in USD, so correlation near one in March 2020 means *everything sold off against the dollar*, havens included. Pitch line: "In March 2020 there was one trade: buy dollars. This is what that sounds like."
- **Lead time** (Fed H.10 daily rates, computed by `scripts/measure.py`):

| Rule | Fired | Trading days before 20 Mar low | Basket drawdown then |
|---|---|---|---|
| The Desk card | 2 Mar | 14 | −5.2% |
| 5% drawdown stop | 26 Feb | 17 | −5.3% |
| 7.5% / 10% drawdown stop | 12 Mar | 6 | −10.3% |

  Say: 8 trading days ahead of a 7.5–10% stop, 3 days **behind** a tight 5% stop. The cards on 8 Jan and 31 Jan are **false alarms**; call them that. Thresholds were tuned on 2020.
- **Out-of-sample check:** run the August 2024 yen carry-trade unwind (`2024-07-01` to `2024-08-30`) with the **same thresholds, unchanged**. Report whatever it shows, including "no card".
- Lead with the sound of unison, not the lead-time number. Re-run `measure.py` after any code change and update this table if the numbers move.

---

## 3. Architecture

Six OS processes on one laptop share one UDP bus; the browser hangs off a display-only relay.

| Process | Count | Does | Must never |
|---|---|---|---|
| Tape | 1 | Replays one cached trading day per tick (2 s). The price feed and clock. | Know anything about analysts |
| Analyst (`fx`, `havens`, `commodity`, `contrarian`) | 4 | Computes its view each tick, publishes, heartbeats, covers a silent neighbour, computes the risk score and raises escalations | Wait on Claude or on a peer |
| Relay | 1 | Forwards bus messages to the browser (SSE), serves the page, puts Approve/Veto/control on the bus, dedupes escalations, writes the decision log | Hold state the agents need, decide anything |
| Launcher | 1 | Starts the others, restarts an analyst on request, picks the transport | Carry data or views |

The risk "voice" (drone and click) is rendered by the browser from the risk score in the views. There is no separate risk-officer process, so there is nothing to cover.

**Transport.** UDP multicast on loopback (group `239.77.7.7`, TTL 0). Fallback: each process binds its own localhost port and sends to every other port. The launcher tests multicast once at startup and passes the choice to children. Both are peer to peer.

**Timing.** Replay `2020-02-03` to `2020-04-09`, 48 trading days × 2 s ≈ 96 s. One tick = one bar only at 116 bpm; at slower tempos bars are longer than ticks. **The score view is keyed on dates, never on bars.**

**Stack.** Python 3.11+ standard library only for every process (no installs to break at the venue). Plain HTML + JS in the browser, Tone.js vendored in `web/vendor/`. `anthropic` SDK only in the offline pre-generation script and optional live mode. `pytest` for tests (dev only).

---

## 4. Data

`data/fx_daily.csv`: `date,EUR,GBP,JPY,CHF,AUD,CAD,NOK`, every value in **US dollars per unit** so down always means weaker against the dollar. Source: Fed H.10. Covers 2019-11-01 to 2020-04-30 and 2024-05-01 to 2024-08-30 (enough history for 60-day windows).

If SGX's provided data covers any of these currencies, cross-check one series against it and mention it in the pitch.

If the file is missing, generate a clearly labelled synthetic tape so the demo still runs, and show "SYNTHETIC DATA" on screen.

Slices: `fx` = EUR, GBP · `havens` = JPY, CHF · `commodity` = AUD, CAD, NOK · `contrarian` = all groups.

---

## 5. Signals and views (pure functions)

Each view is three numbers. Same day in, same numbers out.

| Field | Range | Formula |
|---|---|---|
| `stance` | −1..1 | `tanh(momentum / (normal_vol × √days) / 2) + temperament_bias` |
| `conviction` | 0..1 | `abs(momentum in normal moves) / 3`, clamped |
| `stress` | 0..1 | `(recent_vol / vol_60d − 1) / 2.5`, clamped |

Temperament = momentum window: `fx` 3 days (nervous), `havens` 8 days (calm), `commodity` 6 days with +0.10 bias.

**Contrarian:** 20-day z-score per group; take the most stretched; `stance = −tanh(z / 1.5)`. `rebound = true` when the risk basket had z ≤ −1.8 in the last week and its 3-day bounce ≥ one normal move.

**Risk score (computed by every analyst from its own book):**
- `correlation` = mean pairwise correlation of the 7 currencies' daily returns, 10-day window
- `unison` = clamp((correlation − 0.25) / (0.65 − 0.25), 0, 1)
- `divergence` = clamp((havens_stance × trust_havens − commodity_stance × trust_commodity) / 2, 0, 1)
- `risk` = 0.8 × max(divergence, unison) + 0.2 × (risk_basket_drawdown / 10%)

**Lock the correlation window in hours 0–2 and do not touch it after.** Correlation peaks at 0.68 against a 0.65 saturation point, so the headroom is thin; any later change can lose full unison.

**Escalation:** raise when `risk ≥ 0.50` for 2 consecutive days; re-arm only after `risk < 0.30`. Action rule: cut the slice with the lowest stance by 30%, or 50% if `risk ≥ 0.75`. Votes on a risk-on axis (havens flipped): > +0.15 dissent, < −0.15 support, else neutral.

**Every analyst** evaluates this rule and, when it fires, includes `escalation` with `id = "<replay>:<date>"` in its view. The relay shows one card per id. If any analyst is alive, the card appears.

---

## 6. Agent protocol

Small JSON datagrams with a `type`. Agents never reply to each other; they only broadcast. **Agree the `view` fields in hour 1 and do not change them without telling the team.**

| type | Sender | Key fields |
|---|---|---|
| `tick` | tape | `i, date, prices` |
| `view` | analyst | `agent, ts, date, views[], covering[], risk, unison, escalation?` |
| `hb` | analyst | `agent, ts, covering[]` (every 0.5 s, independent of the tape) |
| `control` | relay | `cmd` (play, pause, restart, kill, degrade, heal, revive), `target` |
| `decision` | relay | `id, verdict, reason, seconds_to_decide` |
| `reason` | analyst | `by, slice, date, text` (late line from a live Claude call) |
| `log` | any | `agent, text` |

```json
{"type":"view","agent":"havens","ts":1794667969.5,"date":"2020-02-25",
 "covering":["fx"],"risk":0.41,"unison":0.18,
 "views":[{"slice":"havens","by":"havens","ts":1794667969.5,"stance":0.92,"conviction":1.0,"stress":0.4,"reason":"..."},
          {"slice":"fx","by":"havens","ts":1794667969.5,"stance":0.51,"conviction":0.5,"stress":0.2,"reason":"Covering FX. ..."}]}
```

Each analyst waits 250 ms after a tick before computing risk, so the day's peer views are in its book. Open escalations are repeated in every view until a `decision` arrives, so a reloaded browser still gets the card.

**Trust and fade.** Trust is per **slice view freshness**, not per author: 1.0 for the first second after the newest view of that slice, then halves every 0.8 s. A coverer's fresh view of a slice gets full trust. Trust weights stances in the risk calculation (real, not only cosmetic) and drives reverb in the sound.

**Takeover.** After 3.0 s without a heartbeat a peer is gone. Fixed ring: `fx → havens → commodity → contrarian → fx`. A gone analyst's slice is covered by the next live one in the ring. Every agent computes this alone from its own heartbeat table and they agree without an election. The coverer reads the slice with its own temperament and publishes with `by` = itself. Start-up grace 4 s.

**Partition vs death.** If an analyst hears *no* peers at all, it assumes its own link is down and does not take over slices.

**Reconnect.** One newest view per slice, replaced only by a newer `ts`. When the owner's heartbeat returns, the coverer drops the slice and the owner's view wins. The browser brings the part back on the next bar line.

**Kill vs degrade.** Kill exits with no goodbye. Degrade drops 75% of the agent's own packets (fade without death). Rehearse degrade only when risk is far from 0.30 and 0.50 so it cannot move the card.

---

## 7. Claude writes footnotes only

The view is final before Claude is asked anything; the lookup never blocks the music.

1. Look up `by|slice|date` in `data/reasons.json` (pre-generated before the demo).
2. If missing and live mode is on, queue a call on a background thread; broadcast a `reason` message when it returns.
3. Meanwhile, and on any failure, use a template sentence built from the same numbers.

Model: `claude-haiku-5-5`, short timeout, no retries. System prompt: the analyst's persona plus four rules: the view is already decided; never change or contradict the stance; never invent numbers or give advice; one sentence, at most 22 words. User message: the view's numbers as JSON. Pre-generation is ~430 calls (four slices plus covering lines, over 2020 and the 2024 window). Use `claude-sonnet-5-5` only if the voices read flat. API key in `.env`, never committed.

---

## 8. Music

All voices share **one scale: D minor pentatonic** (D F G A C, semitones 0 3 5 7 10 from D). There is no per-analyst key. Variety comes from rhythm and register, not key.

| Analyst | Style | Register (root) | Own rhythm |
|---|---|---|---|
| `fx` | Jazz walking bass, swung | D2 | Quarters with eighth pickups |
| `havens` | Ambient pad | D4 | One long chord per bar |
| `commodity` | Rock root-and-fifth, distorted | D3 | Driving eighths |
| `contrarian` | Syncopated pluck | D5 | Off-beats only |
| risk (browser) | Drone and click | D (low) | Click on each beat |

Sequencer runs every sixteenth and reads the latest state:
```
degree = round(pattern_degree × (1 − unison))
pitch  = D(register) + 12 × floor(degree / 5) + scale[degree mod 5]
step uses own rhythm if unison < threshold[analyst][step], else four on the floor
```
Per-step thresholds make parts lock together gradually. At unison 1 every part plays D on the beat, in octaves.

| Input | Sound |
|---|---|
| stance | Contour up when bullish, down when bearish |
| conviction | Velocity (and note opacity on the score) |
| unison | Melody and rhythm convergence on the shared scale; swing 0.45 → 0 |
| risk | Drone gain, click level, tempo 116 → 70 bpm |
| trust | Dry gain down, reverb send up |
| `by` ≠ slice | Played by the coverer's instrument (bass line on the pad) |
| escalation | Cluster sting (C, D♭, F♯, G) over low D |
| approve / veto | D major chord / tritone |
| rebound | Sixteenth-note pentatonic climb, two octaves up, ignores unison |
| analyst returns | Silent until the next bar line |

One instrument per **analyst**, not per slice; that is what makes a takeover audible. Build a manual unison slider on day one to tune by ear without agents.

---

## 9. Screen

- **Start audio** button before anything plays.
- **Score:** scrolling canvas, one staff per analyst, one note per opinion per day (keyed on date). Height = stance, opacity = conviction, colour = author, ring = covered by a neighbour. Risk staff is a bar. Dashed lines for escalation and decision. Click a note → date, author, numbers, one-line reason.
- **Side panel:** meters for correlation, risk (0.50 marked) and tempo; one row per analyst with status (live / covering / down / isolated), trust bar, Kill / Degrade / Revive; decision log; desk log. Keys: `K` kill fx, `R` revive fx.
- **Card:** proposed action in large type; rule that fired with its numbers (label: *Decided by code*); each analyst's one-liner with support / neutral / dissent chip (label: *Explained by AI*); reason field; Approve / Veto (veto requires a reason); open-for timer. Replay pauses and music ducks until a decision. No auto-approve.
- **Footer:** "Historical replay of a hypothetical portfolio, for demonstration only."

**Decision record** (JSON lines, appended by the relay and broadcast):
```
{id, verdict, reason, action, market_date, decided_at, seconds_to_decide}
```

---

## 10. Layout

```
canary/
├── CLAUDE.md
├── data/
│   ├── fx_daily.csv
│   ├── reasons.json
│   └── decisions.jsonl          # written at runtime, gitignored
├── desk/
│   ├── signals.py               # pure: vol, momentum, drawdown, correlation, risk
│   ├── views.py                 # pure: stance/conviction/stress, temperaments, contrarian, escalation rule
│   ├── sim.py                   # offline replay, no network
│   ├── explain.py               # cache → live call → template
│   ├── bus.py                   # multicast + port-per-process fallback
│   ├── agent.py                 # analyst loop, heartbeats, trust, takeover, reconnect
│   ├── tape.py
│   ├── relay.py                 # SSE, static files, controls, decision log, escalation dedupe
│   └── run.py                   # launcher
├── scripts/
│   ├── measure.py               # lead-time table (2020 and 2024)
│   └── pregenerate_reasons.py
├── tests/                       # pytest: signals, views, takeover ring, dedupe
└── web/
    ├── index.html
    ├── app.js                   # SSE, state, card, controls
    ├── music.js
    ├── score.js
    └── vendor/tone.js
```

**Starter code** exists (formerly `the-desk/`). The Python side ran: signals, offline replay, lead-time script, agents with kill and takeover. It still has a separate risk-officer process; fold that logic into every analyst (section 5). The browser side was written but **never opened in a browser**: open it in hour 0 before building on it. Shipped reason lines are templates.

---

## 11. Three-person split

| Person | Owns | Done when |
|---|---|---|
| **Quant** | `signals`, `views`, `sim`, `explain`, `scripts/*`, data, Claude lines, the honest-claims table | `sim.py` prints the same card and lead-time table twice, identically, for 2020 and 2024 |
| **Systems** | `bus`, `agent`, `tape`, `relay`, `run`, trust, takeover, reconnect, dedupe, decision log | Killing `fx` → neighbour covers within 4 s; killing the relay changes nothing in agent logs; killing any one analyst still produces the card |
| **Sound and stage** | `music.js`, `score.js`, `app.js`, `index.html`, pitch, backup video | The unison slider takes the band from four rhythms and registers to one note with no other input |

The `view` message is the contract. Sound can build against a recorded file of view messages before agents exist (Systems records one in hour 2).

## 12. Hour-by-hour

| Hours | Quant | Systems | Sound and stage | Checkpoint |
|---|---|---|---|---|
| 0–2 | Cache CSV (2020 + 2024), vendor Tone.js, **lock correlation window** | One process sends a view, another prints it | Open the starter page in a browser; button makes sound; agree `view` fields | One view crosses the bus |
| 2–6 | Vol, drawdown, momentum, correlation; `fx` view | Tape, agent loop, relay with SSE; record a view file | One analyst's line from views | One analyst audible in the browser |
| 6–10 | All four analysts, risk score in every analyst, unison | Four analysts, heartbeats, newest-view-wins book | All four lines, unison mapping, drone, tempo | **MVP: polyphony collapses to unison on the replay** |
| 10–13 | Escalation rule, votes, `measure.py` for both windows | Decision message and log, dedupe by id, play/pause/restart | Sting, card, score view | A judge can approve a card |
| 13–15 | Pre-generate Claude lines, template fallback | Kill, takeover, reconnect, partition rule, degrade | Fade to reverb, cover voicing, rebound solo | Kill demo works 3 times in a row |
| 15–18 | Freeze numbers, update section 2 | Freeze; one-command start | Record backup video, rehearse twice | No new features |

At hours 6 and 10, stop and run everything together even if parts are unfinished.

---

## 13. Demo script (96 s)

| Replay date | ~Seconds | What happens | What you say |
|---|---|---|---|
| 3–21 Feb | 0–28 | Correlation 0.1–0.25; four rhythms, four registers | "Each analyst plays its own market. This is what diversification sounds like." |
| ~24–25 Feb | 30–32 | **Press K.** Fx fades into reverb, then the pad picks up the bass line. Parts are still distinct, so the takeover is audible. | "We just killed an analyst. Nobody told the others." |
| 27–28 Feb | 34–38 | Havens bid, commodity FX sold; drone grows | "Money is moving to safety." |
| 2 Mar | 38 | Sting, card: cut commodity FX 30%. Fx and contrarian dissent. | Hand the mouse to a judge: "Approve or veto." Press R to revive fx while they read. |
| 3–4 Mar | 40–44 | Contrarian tries a solo after the Fed cut and is wrong | Optional: "It's allowed to be wrong, and you can hear it was." |
| 10–18 Mar | 50–62 | Correlation to 0.68; everything slows and lands on one note | "In March 2020 there was one trade: buy dollars. This is what that sounds like." |
| 25–27 Mar | 72–78 | Rebound solo over the unison | "And this is the opportunity." |
| End | 96 | Lead-time table and the 2024 result | "Fourteen trading days before the low, eight ahead of a 10% stop, three behind a 5% one. Same thresholds on the 2024 yen unwind." |

Before judging: kill the relay once on purpose and show the agent logs still ticking. Show degrade separately in Q&A, not during the replay. Record the backup video from this exact run at hour 15.

---

## 14. Cut list and risks

**Cut in this order:** live Claude mode (cache + templates only) → click-for-reason on the score → fading staleness (keep a plain kill) → contrarian solo → 2024 replay. **Never cut:** correlation-to-unison mapping, the approval card, the kill demo.

| Risk | Guard |
|---|---|
| Venue Wi-Fi | Everything cached and vendored |
| Loopback multicast blocked | Port-per-process fallback chosen at startup |
| Claude slow or key missing | Cached lines, then templates; music never waits |
| Browser blocks audio | Start audio button |
| Unison doesn't reach 1.0 | Correlation window locked early; manual slider to check the mapping |
| Lead-time claim challenged | Full table including the 5% stop, January false alarms and 2024 |
| Takeover inaudible | Kill only while parts are distinct (before ~5 Mar) |
| Demo machine dies | Backup video at hour 15 |

---

## 15. Code standards

- Python: Google-style docstrings (Args / Returns / Raises) on every module, class and function; type hints throughout. Write them as you go, not at hour 17.
- JS: JSDoc on every function.
- `signals.py` and `views.py` are pure and covered by pytest, as are the takeover ring and escalation dedupe.
- `main` stays runnable. Commit small, merge at each checkpoint.

## 16. Commands

```bash
python -m desk.run                    # start everything, open http://localhost:8000
python -m desk.sim --replay 2020      # offline replay, prints cards
python scripts/measure.py             # lead-time table, 2020 and 2024
python scripts/pregenerate_reasons.py # needs ANTHROPIC_API_KEY
pytest
```
