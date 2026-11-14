# CLAUDE.md

**Repo:** `canary` · **On stage:** Canary · **Event:** DurHack 2026, 18-hour build, team of 3 · **Pitch:** A trading desk you can hear.

This file is the source of truth. Long detail (formulas, protocol, demo script, schedule, risks) lives in [`docs/DESIGN.md`](docs/DESIGN.md); read it when you work on that area. If older notes disagree with this file, this file wins.

## Current status

- **Quant: done.** `data/fx_daily.csv` (cached), `canary/signals.py`, `views.py`, `sim.py`, `explain.py`, `scripts/fetch_fx.py`, `scripts/measure.py`, tests in `tests/`. `python -m canary.sim --replay 2020` reproduces the demo (card on 2 Mar, rebounds 3–4 and 25–26 Mar).
- **Systems: done.** `canary/bus.py`, `tape.py`, `agent.py`, `relay.py`, `run.py`; tests in `tests/test_agent.py`, `test_relay.py`. `python -m canary.run` starts everything. With all analysts alive, live risk, unison, stances and rebounds match `canary.sim` exactly, and all four raise the 2 Mar card. Killing fx: havens covers in 2.5 s; revive hands it back. Killing the relay changes nothing for the agents. Browser contract below.
- **Open issue (killing on 24 Feb):** fx or contrarian: card unchanged (2 Mar, 30%). havens (covered by commodity): card on **28 Feb, 50%**. commodity (covered by contrarian): **no card before the low** (risk peaks 0.45 by 6 Mar), because the contrarian reads the crashed commodity slice as bullish, which cancels the divergence. Until the team decides whether covering should use the slice's own temperament for risk, **only kill fx on stage**.
- **Sound and stage:** `web/index.html`, `app.js`, `music.js`, `vendor/tone.js` exist; `score.js` to build.
- Not built: `data/reasons.json` and `scripts/pregenerate_reasons.py` (Claude lines are optional; templates are used without them).

Layout below is the target.

## What we are building

- Canary replays the March 2020 FX crash as live music.
- Four analyst processes each own a slice of FX data, compute a view from deterministic signals and share it peer to peer.
- Their disagreement is polyphony. As correlation rises the parts converge; at the peak every part plays one note.
- When risk crosses a threshold, one approval card appears and a human approves or vetoes.
- Tracks: DurHack Composition, Neptune North (no hub, survives kill/degrade), SGX FX (early warning, stay-safe action, rebound), Accenture (escalation: code decides, AI explains, named human decision).

## The four rules

1. **Numbers decide, Claude explains.** Every stance, risk score, alert and action comes from pure functions in `canary/signals.py` and `canary/views.py`. Claude only writes a one-line reason, attached *after* the view is computed. No model output ever reaches a stance, alert or action.
2. **Correlation is harmony.** One number, `unison`, pulls every part toward the same note, melody and rhythm.
3. **No hub.** Agents broadcast over UDP on localhost. Every analyst computes the risk score itself. The relay only listens, displays and forwards human decisions; killing it changes nothing for the agents.
4. **Nothing at demo time touches the network.** Cached CSV, vendored Tone.js, pre-generated reason lines.

## Honest claims (say these, nothing stronger)

- The music does **not** predict anything. It makes correlation, invisible on a price chart, audible.
- All currencies are quoted in USD, so correlation near one in March 2020 means everything sold off against the dollar, havens included. Pitch: "In March 2020 there was one trade: buy dollars. This is what that sounds like."
- Lead time is only what `scripts/measure.py` prints (table in `docs/DESIGN.md`). Say: ahead of a 7.5–10% stop, **behind** a tight 5% stop. Cards on 8 Jan and 31 Jan are **false alarms**; call them that. Thresholds were tuned on 2020.
- Run 2024-07-01 to 2024-08-30 (yen unwind) with the **same thresholds** and report whatever it shows, including "no card". **Result:** no early warning. The only card is 22 Aug, 13 trading days *after* the 5 Aug low; no stop fired (the commodity basket fell only 3.2%). Say: "Same thresholds on 2024: no early warning. That crash was in the yen, not commodity currencies."
- High unison means "everything moved together against the dollar", not "crash": late August 2024 reaches full unison because the dollar weakened across the board.
- **Other crises, same thresholds** (`python scripts/measure.py`): the band merges in every one (peak correlation 0.79 in 2008, 0.84 in 2022, 0.79 in 2024), but early warning **does not generalise**. 2008: card 8 Aug, between the 5% and 7.5% stops (no lead). 2022: no card at all (risk stayed high all through the dollar rally). Say: "We tried three other crises. You can hear the correlation in all of them; the early warning only worked in 2020, the year we tuned on. That's why we don't claim prediction."
- Lead with the sound of unison, not the lead-time number. Re-run `measure.py` after any code change and update the table if numbers move.

## Architecture

Seven OS processes on one laptop share one UDP bus; the browser hangs off a display-only relay.

| Process | Count | Does | Must never |
|---|---|---|---|
| Tape | 1 | Replays one cached trading day per tick (2 s); price feed and clock | Know anything about analysts |
| Analyst (`fx`, `havens`, `commodity`, `contrarian`) | 4 | Computes its view each tick, publishes, heartbeats, covers a silent neighbour, computes risk score, raises escalations | Wait on Claude or on a peer |
| Relay | 1 | Forwards bus messages to browser (SSE), serves page, puts Approve/Veto/control on the bus, dedupes escalations, writes decision log | Hold state agents need, decide anything |
| Launcher | 1 | Starts the others, restarts an analyst on request, picks transport | Carry data or views |

The risk voice (drone and click) is rendered by the browser from the risk score in the views; there is no risk-officer process.

**Transport:** UDP multicast on loopback (`239.77.7.7`, TTL 0); fallback is one localhost port per process, sending to all others. The launcher tests multicast once and passes the choice to children.

**Stack:** Python 3.11+ standard library only for every process. Plain HTML + JS, Tone.js vendored in `web/vendor/`. `anthropic` SDK only in the pre-generation script and optional live mode. `pytest` is dev only. The score view is keyed on **dates, never bars**.

## The `view` message (shared contract)

Messages are small JSON datagrams with a `type`: `tick`, `view`, `hb`, `control`, `decision`, `reason`, `log` (fields in `docs/DESIGN.md`). The `view` is what Systems and Sound both depend on:

```json
{"type":"view","agent":"havens","ts":1794667969.5,"date":"2020-02-25",
 "covering":["fx"],"risk":0.41,"unison":0.18,"rebound":false,
 "views":[{"slice":"havens","by":"havens","about":"havens","ts":1794667969.5,"stance":0.92,"conviction":1.0,"stress":0.4,"reason":"..."},
          {"slice":"fx","by":"havens","about":"fx","ts":1794667969.5,"stance":0.51,"conviction":0.5,"stress":0.2,"reason":"Covering fx. ..."}],
 "escalation": {"id":"2020:2020-03-02","date":"2020-03-02","risk":0.64,
                "rule":"Risk 0.64 ≥ 0.50 for 2 days in a row","action":"Cut commodity by 30%",
                "slice":"commodity","cut":0.3,
                "votes":[{"slice":"fx","by":"fx","vote":"dissent"}, "..."],
                "why":{"divergence":0.67,"unison":0.31,"drawdown":-0.052}}}
```

Field ranges: `stance` −1..1, `conviction` 0..1, `stress` 0..1, `risk` 0..1, `unison` 0..1.
- `about`: which group the stance is about. Same as `slice`, except the contrarian names the group it bets against (needed for votes). From `views.slice_view` / `contrarian_view`.
- `risk`: `null` in the first `view` an analyst sends each day (views go out at once so peers can use them; risk follows 250 ms later in a second `view`). Always use the latest `view` per agent and date.
- `rebound`: true on rebound days (plays the rebound solo). From `views.rebound(prices)`.
- `escalation`: only on the day it fires and until a decision arrives. Built by `views.escalation(...)`; `vote` is `support`, `neutral` or `dissent`; `why` holds the risk inputs so the card can show `risk = 0.8 × max(divergence, unison) + 0.2 × (fall ÷ 10%)`.
- `reason`: from `explain.reason(view, date, cache)`.
**Anyone changing `view` fields must tell the team first**, and update this section in the same commit. Agree the fields in hour 1.

## The browser contract (relay, shared with Sound)

The browser only talks to the relay, at `http://localhost:8000`:

| Method | Path | What |
|---|---|---|
| GET | `/` | `web/` files |
| GET | `/events` | Server-sent events. Every bus message as JSON, plus `card` events. On connect, catch-up: latest `view` and `hb` per analyst, and any open card |
| POST | `/control` | `{"cmd": "kill", "target": "fx"}`. `cmd`: play, pause, restart, kill, degrade, heal, revive. `target`: an analyst, or `"tape"`; revive also takes `"relay"` |
| POST | `/decision` | `{"id": "2020:2020-03-02", "verdict": "approve" \| "veto", "reason": "...", "by": "Judge name"}`. Veto needs a reason (400 otherwise); a card that isn't open gets 409 |

```js
const events = new EventSource("/events");
events.onmessage = (e) => { const m = JSON.parse(e.data); /* switch on m.type */ };
```

- **Show the card on `{"type":"card","card":{...escalation},"opened_at":<unix s>}`**, which comes once per card id. Don't use the `escalation` field in views for this; four analysts repeat it every second until it's decided.
- The relay pauses the tape when a card opens and presses play when the last open card is decided. The browser only ducks the music.
- After a decision a `{"type":"decision", ...record}` message arrives. The record (also appended to `data/decisions.jsonl`) is `{id, verdict, reason, by, action, market_date, decided_at, seconds_to_decide}`.
- `hb` (every 0.5 s per analyst): `{"type":"hb","agent","ts","covering":[...],"isolated":bool}`. Status: no `hb` for 3 s = **down**, `covering` non-empty = **covering**, `isolated` = **isolated**, otherwise **live**.
- `tick`: `{"type":"tick","replay","i","date","prices":{...},"synthetic":bool}`. Show "SYNTHETIC DATA" when `synthetic` is true. `i == 0` means the replay (re)started.
- `log`: `{"type":"log","agent","text"}` for the desk log (agents, tape and launcher all send these).

## Layout (target)

```
canary/
├── CLAUDE.md  README.md
├── docs/DESIGN.md
├── data/        fx_daily.csv, reasons.json, decisions.jsonl (runtime, gitignored)
├── canary/        signals.py views.py sim.py explain.py   (Quant)
│                bus.py agent.py tape.py relay.py run.py (Systems)
├── scripts/     measure.py pregenerate_reasons.py       (Quant)
├── tests/       pytest: signals, views, takeover ring, dedupe
└── web/         index.html app.js music.js score.js vendor/tone.js  (Sound and stage)
```

## Ownership: each person only edits their own files

| Person | Owns |
|---|---|
| **Quant** | `canary/signals.py`, `views.py`, `sim.py`, `explain.py`, `scripts/*`, `data/*`, Claude lines, honest-claims table, tests for these |
| **Systems** | `canary/bus.py`, `agent.py`, `tape.py`, `relay.py`, `run.py`, trust, takeover, reconnect, dedupe, decision log, tests for these |
| **Sound and stage** | `web/*`, pitch, backup video |

Need a change in someone else's file? Ask them (or open a small PR for them to approve). Shared files (`CLAUDE.md`, `docs/DESIGN.md`, `README.md`): tell the team in chat before editing.

## Music (all voices, one scale)

All voices share **one scale: D minor pentatonic** (D F G A C = semitones 0 3 5 7 10 from D). There is no per-analyst key; variety comes from rhythm and register.

| Analyst | Style | Register root | Own rhythm |
|---|---|---|---|
| `fx` | Jazz walking bass, swung | D2 | Quarters, eighth pickups |
| `havens` | Ambient pad | D4 | One long chord per bar |
| `commodity` | Rock root-and-fifth, distorted | D3 | Driving eighths |
| `contrarian` | Syncopated pluck | D5 | Off-beats only |
| risk (browser) | Drone and click | low D | Click each beat |

Sequencer runs every sixteenth and reads the latest state. **Convergence formula:**
```
degree = round(pattern_degree × (1 − unison))
pitch  = D(register) + 12 × floor(degree / 5) + scale[degree mod 5]
step uses own rhythm if unison < threshold[analyst][step], else four on the floor
```
Per-step thresholds make parts lock gradually; at unison 1 every part plays D on the beat, in octaves.

| Input | Sound |
|---|---|
| stance | Contour up when bullish, down when bearish |
| conviction | Velocity (and note opacity on the score) |
| unison | Melody and rhythm convergence; swing 0.45 → 0 |
| risk | Drone gain, click level, tempo 116 → 70 bpm |
| trust | Dry gain down, reverb send up |
| `by` ≠ slice | Played by the coverer's instrument |
| escalation | Cluster sting (C, D♭, F♯, G) over low D |
| approve / veto | D major chord / tritone |
| rebound | 16th-note pentatonic climb, two octaves up, ignores unison |
| analyst returns | Silent until the next bar line |

One instrument per **analyst**, not per slice; that is what makes a takeover audible. Build a manual unison slider on day one to tune by ear without agents.

## Code standards

- Python: Google-style docstrings (Args / Returns / Raises) on every module, class and function; type hints throughout. Write them as you go.
- JS: JSDoc on every function.
- `signals.py` and `views.py` are pure and covered by pytest, as are the takeover ring and escalation dedupe.
- Python tooling (dev only, `requirements-dev.txt`): `black` formatting and `mypy` in strict mode (config in `pyproject.toml`). Run `black . && mypy canary tests scripts && pytest` before merging.
- Claude lines use `claude-haiku-5-5`; API key in `.env`, **never committed** (keep `.env` in `.gitignore`).

## Git workflow

- One branch per task (`quant/signals`, `systems/relay`, `sound/score`), branched from `main`.
- Small commits, clear messages. Only touch your own files (see Ownership).
- Merge to `main` at each checkpoint (hours 2, 6, 10, 13, 15, 18). `main` must always run.
- Never commit `.env`, `data/decisions.jsonl` or API keys.

## Commands

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt  # once; python3 must be 3.11+ (on a Mac with 3.9, use python3.13)
python -m canary.run                    # start everything, open http://localhost:8000
python -m canary.run --paused           # demo: replay waits for play (after Start audio)
python -m canary.run --interval 0.5 --no-browser   # fast run for testing
python -m canary.bus check              # does multicast work on this machine?
python -m canary.sim --replay 2020      # offline replay, prints every day and card
python scripts/measure.py             # lead-time table, 2020 and 2024
python scripts/fetch_fx.py            # re-download data/fx_daily.csv (needs internet; not at demo time)
python scripts/pregenerate_reasons.py # optional, not built yet; needs ANTHROPIC_API_KEY
black . && mypy canary tests scripts && pytest
```
