# CLAUDE.md

**Repo:** `canary` · **On stage:** Canary · **Event:** DurHack 2026, 18-hour build, team of 3 · **Pitch:** A trading desk you can hear.

This file is the source of truth. Long detail (formulas, protocol, demo script, schedule, risks) lives in [`docs/DESIGN.md`](docs/DESIGN.md); read it when you work on that area. If older notes disagree with this file, this file wins.

## Current status

- **Quant: done.** `data/fx_daily.csv` (cached), `desk/signals.py`, `views.py`, `sim.py`, `explain.py`, `scripts/fetch_fx.py`, `scripts/measure.py`, tests in `tests/`. `python -m desk.sim --replay 2020` reproduces the demo (card on 2 Mar, rebounds 3–4 and 25–26 Mar).
- **Systems:** `desk/bus.py` done; `agent.py`, `tape.py`, `relay.py`, `run.py` to build. Agents should call `views.slice_view` / `contrarian_view`, `signals.*`, `views.check_escalation` / `escalation`, `views.rebound` and `explain.reason`; their numbers must match `desk.sim`.
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

1. **Numbers decide, Claude explains.** Every stance, risk score, alert and action comes from pure functions in `desk/signals.py` and `desk/views.py`. Claude only writes a one-line reason, attached *after* the view is computed. No model output ever reaches a stance, alert or action.
2. **Correlation is harmony.** One number, `unison`, pulls every part toward the same note, melody and rhythm.
3. **No hub.** Agents broadcast over UDP on localhost. Every analyst computes the risk score itself. The relay only listens, displays and forwards human decisions; killing it changes nothing for the agents.
4. **Nothing at demo time touches the network.** Cached CSV, vendored Tone.js, pre-generated reason lines.

## Honest claims (say these, nothing stronger)

- The music does **not** predict anything. It makes correlation, invisible on a price chart, audible.
- All currencies are quoted in USD, so correlation near one in March 2020 means everything sold off against the dollar, havens included. Pitch: "In March 2020 there was one trade: buy dollars. This is what that sounds like."
- Lead time is only what `scripts/measure.py` prints (table in `docs/DESIGN.md`). Say: ahead of a 7.5–10% stop, **behind** a tight 5% stop. Cards on 8 Jan and 31 Jan are **false alarms**; call them that. Thresholds were tuned on 2020.
- Run 2024-07-01 to 2024-08-30 (yen unwind) with the **same thresholds** and report whatever it shows, including "no card". **Result:** no early warning. The only card is 22 Aug, 13 trading days *after* the 5 Aug low; no stop fired (the commodity basket fell only 3.2%). Say: "Same thresholds on 2024: no early warning. That crash was in the yen, not commodity currencies."
- High unison means "everything moved together against the dollar", not "crash": late August 2024 reaches full unison because the dollar weakened across the board.
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
                "rule":"Risk 0.64 >= 0.50 for 2 days in a row","action":"Cut commodity by 30%",
                "slice":"commodity","cut":0.3,
                "votes":[{"slice":"fx","by":"fx","vote":"dissent"}, "..."]}}
```

Field ranges: `stance` −1..1, `conviction` 0..1, `stress` 0..1, `risk` 0..1, `unison` 0..1.
- `about`: which group the stance is about. Same as `slice`, except the contrarian names the group it bets against (needed for votes). From `views.slice_view` / `contrarian_view`.
- `rebound`: true on rebound days (plays the rebound solo). From `views.rebound(prices)`.
- `escalation`: only on the day it fires and until a decision arrives. Built by `views.escalation(...)`; `vote` is `support`, `neutral` or `dissent`.
- `reason`: from `explain.reason(view, date, cache)`.
**Anyone changing `view` fields must tell the team first**, and update this section in the same commit. Agree the fields in hour 1.

## Layout (target)

```
canary/
├── CLAUDE.md  README.md
├── docs/DESIGN.md
├── data/        fx_daily.csv, reasons.json, decisions.jsonl (runtime, gitignored)
├── desk/        signals.py views.py sim.py explain.py   (Quant)
│                bus.py agent.py tape.py relay.py run.py (Systems)
├── scripts/     measure.py pregenerate_reasons.py       (Quant)
├── tests/       pytest: signals, views, takeover ring, dedupe
└── web/         index.html app.js music.js score.js vendor/tone.js  (Sound and stage)
```

## Ownership: each person only edits their own files

| Person | Owns |
|---|---|
| **Quant** | `desk/signals.py`, `views.py`, `sim.py`, `explain.py`, `scripts/*`, `data/*`, Claude lines, honest-claims table, tests for these |
| **Systems** | `desk/bus.py`, `agent.py`, `tape.py`, `relay.py`, `run.py`, trust, takeover, reconnect, dedupe, decision log, tests for these |
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
- Python tooling (dev only, `requirements-dev.txt`): `black` formatting and `mypy` in strict mode (config in `pyproject.toml`). Run `black . && mypy desk tests scripts && pytest` before merging.
- Claude lines use `claude-haiku-5-5`; API key in `.env`, **never committed** (keep `.env` in `.gitignore`).

## Git workflow

- One branch per task (`quant/signals`, `systems/relay`, `sound/score`), branched from `main`.
- Small commits, clear messages. Only touch your own files (see Ownership).
- Merge to `main` at each checkpoint (hours 2, 6, 10, 13, 15, 18). `main` must always run.
- Never commit `.env`, `data/decisions.jsonl` or API keys.

## Commands

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt  # once
python -m desk.run                    # start everything, open http://localhost:8000
python -m desk.sim --replay 2020      # offline replay, prints every day and card
python scripts/measure.py             # lead-time table, 2020 and 2024
python scripts/fetch_fx.py            # re-download data/fx_daily.csv (needs internet; not at demo time)
python scripts/pregenerate_reasons.py # optional, not built yet; needs ANTHROPIC_API_KEY
black . && mypy desk tests scripts && pytest
```
