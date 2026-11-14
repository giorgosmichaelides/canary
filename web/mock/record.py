"""Record a replay from canary.sim as browser-ready `view` messages.

Writes web/mock/replay<year>.js, which sets `window.MOCK_REPLAY` to one
`view` message per trading day (same shape as the live contract in
CLAUDE.md). The page plays it when no relay is running, so the card,
sliders and music can be tested without the agents.

Usage (from the repo root):
    python web/mock/record.py            # 2020
    python web/mock/record.py --replay 2024
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from canary.explain import load_reasons, reason  # noqa: E402
from canary.sim import REPLAYS, load_prices, run  # noqa: E402


def record(replay_name: str) -> list[dict[str, Any]]:
    """Run the offline sim and turn each demo day into a `view` message.

    Args:
        replay_name: Key of canary.sim.REPLAYS, e.g. "2020".

    Returns:
        One view message per day from replay.start to replay.end.
    """
    replay = REPLAYS[replay_name]
    dates, prices = load_prices()
    cache = load_reasons()
    out: list[dict[str, Any]] = []
    for day in run(replay, dates, prices):
        if day.date < replay.start:
            continue
        views = [{**v, "ts": 0, "reason": reason(v, day.date, cache)} for v in day.views]
        msg: dict[str, Any] = {
            "type": "view",
            "agent": "mock",
            "ts": 0,
            "date": day.date,
            "covering": [],
            "risk": round(day.risk, 4),
            "unison": round(day.unison, 4),
            "rebound": day.rebound,
            "views": views,
        }
        if day.escalation is not None:
            msg["escalation"] = day.escalation
        out.append(msg)
    return out


def main(argv: list[str] | None = None) -> int:
    """Write the recording to web/mock/replay<name>.js.

    Args:
        argv: Command-line arguments, or None for sys.argv.

    Returns:
        Process exit code.
    """
    parser = argparse.ArgumentParser(description="Record a mock replay for the browser.")
    parser.add_argument("--replay", choices=sorted(REPLAYS), default="2020")
    args = parser.parse_args(argv)
    days = record(args.replay)
    path = Path(__file__).with_name(f"replay{args.replay}.js")
    body = json.dumps(days, separators=(",", ":"))
    path.write_text(
        f"/** Recorded by web/mock/record.py from canary.sim. Do not edit. */\n"
        f"window.MOCK_REPLAY = {body};\n",
        encoding="utf-8",
    )
    cards = sum("escalation" in d for d in days)
    print(f"wrote {path} ({len(days)} days, {cards} card(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
