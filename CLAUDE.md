# CLAUDE.md

## Repo

**Name:** `canary`
**Product name on stage:** The Desk
**Event:** DurHack 2026, 18-hour build. Team of up to 4.
**One-line pitch:** A trading desk you can hear.

---

## 1. The brief

The Desk replays a real market crash (default: the COVID crash, Jan–Jun 2020) as live music in the browser. A team of AI "analysts" each covers one slice of the market and plays its own instrument, in its own key and style.

- In calm markets the parts are independent, so you hear a lively mix.
- As risk builds they drift together, speed up and darken.
- At the crash, every part lands on the same note.

**The one idea judges must leave with:** when every part plays the same note, that is what "all correlations go to one" sounds like. It is the sound of diversification failing. Correlation is invisible on a price chart; here you can hear it.

**Do not claim the music predicts the market.** The music and the chart come from the same data. The claim is that correlation becomes perceptible.

**Responsible-AI line:** code makes every decision (signals, risk level, suggested action). The LLM only writes a one-line explanation and the end-of-replay incident report. A human approves or vetoes every action. The AI cannot trade, change thresholds or approve.

### Prize tracks this targets
| Track | What we must show |
|---|---|
| DurHack theme: **Composition** | Many independent musical parts combined into one data-driven piece |
| **Neptune North** (resilient distributed actors) | Independent analysts, no central coordinator, survive a killed analyst and a comms cut |
| **Accenture** (redesign an accepted process with AI) | Risk escalation rebuilt: hear early → code decides → AI explains → human approves → logged → AI incident report |
| **SGX FX** (trading market storm) | Early warning, a stay-safe action with visible impact, a spot-the-rebound moment |

---

## 2. Data and signals (offline, Python)

### Inputs
Daily closes, committed as CSV in `data/raw/`:
- **2020 replay:** 2 Jan – 30 Jun 2020
- **2022 replay (proof thresholds generalise):** 3 Jan – 31 Oct 2022
- Tickers: `XLK, XLE, XLF, XLV, TLT, GLD, SPY`
- Optional: if SGX's provided FX data is in `data/raw/sgx/`, USDJPY may replace Healthcare as a voice.

### Signals per trading day
| Signal | Definition |
|---|---|
| `returns[t]` | Daily log return per ticker |
| `vol` | 20-day realised vol of SPY, annualised |
| `drawdown` | SPY drawdown from running peak (negative number) |
| `rho` | **EWMA** average pairwise correlation, **half-life 5 trading days**, over the **equity sectors only** (XLK, XLE, XLF, XLV). Safe havens are excluded. Do not use a plain 20-day window: it lags and peaks after the 23 Mar 2020 low. |
| `safeHavenCorr` | EWMA correlation of the safe-haven basket (mean of TLT, GLD returns) with SPY. Used for the "even safe havens gave up" moment (mid-March 2020 dash for cash). Verify it on the data before relying on it. |
| `rebound` | True once SPY is +10% off the trough and `rho` has fallen 3 days in a row |
| `equity.hold`, `equity.hedged` | Two equity curves for a hypothetical equal-weight sector portfolio: no action vs. "cut gross exposure 30%" applied from the first High-risk day |

Thresholds live in one config dict in `signals.py` and are **identical for every crash**. Tune on 2020, run 2022 unchanged. If 2022 only reaches "High", that is a fine, honest result.

### Output contract: `web/public/data/signals_<year>.json`
```json
{
  "meta": { "crash": "2020", "start": "2020-01-02", "end": "2020-06-30",
            "voices": ["tech", "energy", "financials", "healthcare", "havens"] },
  "days": [
    { "date": "2020-02-24",
      "close":   { "SPY": 322.4, "XLK": 93.1 },
      "returns": { "tech": -0.034, "energy": -0.041, "financials": -0.037, "healthcare": -0.029, "havens": 0.011 },
      "vol": 0.31, "drawdown": -0.035, "rho": 0.78, "safeHavenCorr": -0.4,
      "rebound": false,
      "equity": { "hold": 0.97, "hedged": 0.98 } }
  ]
}
```
`explanations.json`: map of `"<year>:<date>:<rule>" → "one sentence"`, generated offline by `explain.py`.

**Day one:** hand the web team a small hand-written `signals_fake.json` with the same shape so nobody is blocked.

---

## 3. Sound design

### The band (max 5 voices)
| Analyst id | Slice | Instrument / style | Own key & mode |
|---|---|---|---|
| `tech` | XLK | Jazz piano, swung chords | F Lydian |
| `energy` | XLE | Overdriven rock riff | E Mixolydian |
| `financials` | XLF | Walking bass | B♭ Dorian |
| `healthcare` | XLV | Ambient pad | A major |
| `havens` | TLT + GLD | Bells / plucked arpeggio | D major pentatonic. The counter-voice: louder as equities fall |

### Signal → music mapping
| Signal | What you hear |
|---|---|
| `rho` | How far each voice's scale is pulled toward one shared root. ρ < 0.3: own keys. 0.3–0.7: scales blend, chords collide. ρ > 0.85: unison on one low note (D2) |
| `vol` | Tempo 84 → 150 BPM and note density |
| `drawdown` | Darkness: mode major → minor → Phrygian, low-pass filter closes, drone rises |
| Voice's own return | That voice's loudness and melodic contour (up/down) |
| `safeHavenCorr` > 0 during crash | Bells briefly join the unison ("even the safe havens gave up") |
| `rebound` | Voices split apart; strongest-recovering analyst gets a solo |

### Rules that keep it musical
- One master clock and bar grid on `Tone.Transport`.
- Interpolate all parameters smoothly between days. No per-day jumps.
- The warning sound is a distinct two-tone alert outside the music.
- Every voice can be soloed and muted on screen.
- `Voice` interface: `setScalePull(rho)`, `setTempo(bpm)`, `setDarkness(dd)`, `setIntensity(ret)`, `mute()`, `solo()`.

---

## 4. Architecture

```
[Offline]  data/fetch.py → data/raw/*.csv
           data/signals.py → signals_2020.json, signals_2022.json
           data/explain.py (LLM) → explanations.json
                         ↓
[Browser]  Replay clock (main thread, ~0.6–1 s per trading day, adjustable)
                         ↓  tick(dayIndex)
           Analyst Web Workers (one per voice, own slice only)
              ↔ BroadcastChannel "desk-peers": heartbeats + latest return
                         ↓  per-bar musical intent
           Main thread: Tone.js sound engine, desk UI
           Risk engine (pure functions) → escalation card → Approve/Veto → audit log
           End of replay → incident report (LLM, cached fallback)
```

### Message contracts
- main → worker: `{type: "init", id, slice, days}`, `{type: "tick", dayIndex}`, `{type: "comms", enabled}`
- worker → main: `{type: "intent", id, bar, notes, contour, intensity, scalePull, covering: string[], status}`
- worker ↔ worker (BroadcastChannel): `{type: "heartbeat", id, t, lastReturn, covering}` every ~250 ms

### Distributed behaviour (Neptune North; must be real, not faked)
- **No central coordinator.** There is no supervisor that assigns work. The main thread only renders and plays sound.
- **Kill:** the UI terminates a worker. Survivors notice a missed heartbeat (> 1 s). Every survivor applies the same deterministic rule: the live peer most correlated with the dead slice covers it (tie-break: lowest id). The coverer plays a quieter "cover" line in its own instrument. Revive = respawn worker; it rejoins on the next bar.
- **Partition vs death:** if a worker stops hearing *all* peers at once, it assumes a comms failure, not deaths, and does not take over slices.
- **Cut comms:** toggles BroadcastChannel traffic off. Each analyst keeps playing its own slice on the shared clock, but its view of its peers goes stale. Each worker computes its own scale pull from the peer returns it has heard, with confidence decaying over time, so the band audibly loses harmonic agreement while keeping time. Restore comms → they merge and re-converge within a bar or two.
- **Workers never touch audio.** They post per-bar intent; the main thread schedules notes.

### Risk engine (`risk.ts`, pure, unit-tested)
- Input: one day of signals + previous state. Output: `{level, ruleFired, suggestedAction}`.
- Levels: `Calm → Elevated → High → Crash`, with hysteresis (enter after 2 consecutive days over threshold, exit after 3 days below 0.9× threshold).
- Actions from a fixed playbook only: `"Cut gross exposure 30%"`, `"Add TLT hedge"`, `"Hold, re-check in 2 days"`.

### Escalation flow (Accenture)
1. **Hear it:** convergence audible while still Elevated.
2. **Code decides:** risk engine crosses a threshold, picks a playbook action. Card label: *Decided by code*.
3. **AI explains:** cached one-liner shown immediately. Card label: *Explained by AI*.
4. **Human decides:** replay pauses, music ducks. Approve or Veto (+ optional reason). **No timeout, no auto-approve.**
5. **Logged:** decision, who, when, numbers at the time. Shown on screen.
6. **Impact:** show `equity.hold` vs `equity.hedged` curves after the decision.
7. **Incident report:** at the end, the LLM writes a short post-mortem from the audit log (cached fallback).

---

## 5. Screen

- Big **"Start the desk"** button (browsers block audio until a click).
- Desk view: one tile per analyst (name, instrument, status light: live / covering / down / isolated, its line moving).
- Large ρ meter. Small synced SPY price chart in a corner as proof.
- Controls: replay speed, crash selector (2020 / 2022), Kill analyst (button + keyboard shortcut), Cut comms toggle, solo/mute per voice.
- Escalation card, audit log, equity curves, incident report.
- Footer: *Historical replay of a hypothetical portfolio, for demonstration only.*

---

## 6. Milestones (18 hours, priority order)

Each milestone must end in a working, demoable state.

| # | Milestone | Done when | Hours |
|---|---|---|---|
| M0 | Setup | Repo, Vite app, Tone.js plays a note after a click, CSVs downloaded and committed | 0–1 |
| M1 | One voice from real data | Tech piano changes with real XLK returns from `signals_2020.json` | 1–4 |
| M2 | Full replay | All 5 voices on one clock through Jan–Jun 2020; tempo and darkness follow vol and drawdown; tiles + ρ meter | 4–8 |
| M3 | Merge to one note | Scales converge with ρ, unison at the crash; alert + escalation card + approve/veto + audit log | 8–12 |
| M4 | Resilience | Workers + peer heartbeats; kill one → peer covers; cut comms → band drifts apart and re-merges | 12–14 |
| M5 | Proof and polish | 2022 replay with same thresholds, equity curves, incident report, rebound solo, price chart | 14–16 |
| M6 | Rehearse | Demo script run 5+ times, backup screen recording with audio | 16–18 |

**Cut order if behind:** live LLM call (cache only) → price chart → rebound solo → 2022 replay. **Never cut M1–M4.**

**Extras, only after M6:** spatial headphone mix (each analyst panned), "blindfold mode" (judge guesses market state by ear), another crash (2008).

---

## 7. The 90-second demo

| Time | On screen | Heard | Presenter says |
|---|---|---|---|
| 0:00–0:15 | Five tiles green, ρ low (start mid-Jan 2020) | Five parts, own keys | "A trading desk you can hear. Five AI analysts, each covering part of the market, each playing its own part." |
| 0:15–0:35 | ρ climbing, tiles amber | Parts drift together, tempo up, darker | "Late February. The parts are starting to agree. That's correlation rising, and you can't see it on a price chart." |
| 0:35–0:50 | Alert, card, replay paused | Music ducks | "Code flagged high risk and picked an action. The AI only explains. A human decides." Judge clicks Approve. |
| 0:50–1:05 | ρ maxed, tiles red | One note | "March 2020. One note. That's what 'all correlations go to one' sounds like." |
| 1:05–1:15 | Kill an analyst, then cut comms | Voice stops, peer covers; band drifts, then re-merges | "No supervisor. They noticed, covered, and kept playing without talking." |
| 1:15–1:30 | Tiles green, ρ falling, equity curves | Voices split, rebound solo | "April. The rebound. Same thresholds work on 2022. That's The Desk." |

---

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Audio blocked until click | "Start the desk" button |
| Venue Wi-Fi fails | All data and explanations precomputed and committed |
| LLM slow or down | Cached text always shown first |
| Sounds like noise | Shared bar grid, max 5 voices, smooth interpolation, test with an outsider |
| Convergence off cue | Thresholds tuned on real data; replay speed control |
| Kill demo glitches | Rehearse; keyboard shortcut as well as button |
| "It's a gimmick" | Synced price chart, 2022 run with same thresholds, blindfold mode in Q&A |
| Poor venue PA | Test early; small speaker; backup recording |

---

## 9. Stack

### Offline (Python)
- Python 3.11+, pandas, numpy, yfinance, pytest
- Anthropic Python SDK (`anthropic`) for `explain.py`. Key in `.env`, never committed.

### Web
- TypeScript (strict) + Vite, plain TS (React only if the screen owner prefers)
- Tone.js (all audio, scheduled on `Tone.Transport`)
- Web Workers + BroadcastChannel
- uPlot for price chart and equity curves
- Vitest for `risk.ts` and the coverage rule
- npm

### Layout
```
canary/
├── data/
│   ├── raw/                 # CSVs (committed)
│   ├── fetch.py
│   ├── signals.py           # thresholds config lives here
│   ├── explain.py
│   └── tests/
└── web/
    ├── public/data/         # signals_*.json, explanations.json
    └── src/
        ├── main.ts          # start button, replay clock
        ├── workers/analyst.ts
        ├── peers.ts         # heartbeats, coverage rule, partition detection
        ├── risk.ts
        ├── sound/           # Voice interface + one file per instrument
        ├── ui/              # tiles, ρ meter, card, audit log, charts
        └── report.ts        # incident report
```

---

## 10. Code standards

- Python: Google-style docstrings (Args / Returns / Raises) on every module and function; full type hints.
- TypeScript: TSDoc on every exported function, class, interface and type.
- `risk.ts` and the coverage rule are pure functions with unit tests.
- Keep the app runnable at the end of every milestone. Commit small, commit often.

## 11. Commands

```bash
# data
cd data && python -m venv .venv && source .venv/bin/activate
pip install pandas numpy yfinance anthropic pytest
python fetch.py && python signals.py && python explain.py
pytest

# web
cd web && npm install
npm run dev
npx vitest
```

## 12. Open decisions

- Swap Healthcare for USDJPY if SGX data is available.
- Who presses Approve on stage: a real judge (preferred) or a teammate.
