# Canary

**A trading desk you can hear.** Built at DurHack 2026.

Canary replays the March 2020 currency crash as live music. Four analyst processes each watch a slice of the FX market and play their own part. When the currencies start moving together, the parts merge, and at the peak every part plays one note. That is what "all correlations go to one" sounds like.

It's meant for anyone who watches markets. Correlation doesn't show on a price chart, and nobody can watch a chart all day. Leave Canary running in the background and you'll hear when everything starts moving together, even if you can't see the screen.

When risk crosses a threshold, code recommends an action, each analyst gives a one-line reason for its view, and a named human accepts or dismisses it.

> Historical replay of a hypothetical portfolio, for demonstration only. The music does not predict anything; it makes correlation, which you can't see on a price chart, audible.

## Run it

Python 3.11+ only, no installs needed to run.

```bash
python -m canary.run            # starts everything and opens http://localhost:8000
python -m canary.run --interval 0.5   # faster, for a quick look
```

Click **Start the desk**. The replay plays one trading day every 2 seconds; when the recommendation card appears on 2 March, enter your name and accept or dismiss it. Press B to black out the screen and guess calm or crash by ear, K to kill the fx analyst and R to revive it.

Offline tools:

```bash
python -m canary.sim --replay 2020   # every day and card, no network
python scripts/measure.py            # early-warning results for 2008, 2020, 2022, 2024
```

## How it's built

| Part | What it does |
|---|---|
| `canary/signals.py`, `canary/views.py` | Pure maths: correlation, volatility, each analyst's view, the risk score and the escalation rule |
| `canary/agent.py` | One process per analyst; they talk peer to peer over UDP, cover for a dead neighbour, and each computes risk itself |
| `canary/tape.py`, `canary/relay.py`, `canary/run.py` | The price clock, the browser bridge (server-sent events), and the one-command launcher |
| `web/` | The music (Tone.js), the score view, the recommendation card and the price vs correlation chart |
| `data/fx_daily.csv` | Federal Reserve H.10 daily exchange rates, cached so the demo needs no internet |

More detail: [`docs/DESIGN.md`](docs/DESIGN.md) (formulas, protocol, results) and [`docs/QA.md`](docs/QA.md) (numbers and likely questions).

## Develop

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
black . && mypy canary tests scripts && pytest
```
