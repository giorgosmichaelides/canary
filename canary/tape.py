"""The tape: replays one cached trading day every 2 seconds.

It is the price feed and the clock. Every tick looks like:
    {"type": "tick", "replay": "2020", "i": 0, "date": "2020-02-03",
     "prices": {"EUR": 1.10, ...}, "synthetic": false}

It knows nothing about the analysts. It only listens for control messages:
play, pause and restart.

Usage:
    python -m canary.tape
    python -m canary.tape --replay 2024 --paused --transport ports
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import random
import time

from typing import Any

from canary.bus import Bus, make_bus
from canary.sim import CURRENCIES, REPLAYS, Replay, load_prices

TICK_SECONDS = 2.0


def synthetic_prices(replay: Replay) -> tuple[list[str], dict[str, list[float]]]:
    """Make up a clearly fake price history so the demo still runs without the CSV.

    Calm random walks with a shared sell-off two thirds of the way through, so
    correlation still climbs and the music still converges. Same seed, same
    numbers every time.

    Args:
        replay: Which window to cover.

    Returns:
        The weekdays from ``replay.history_start`` to ``replay.end`` and
        currency -> prices on those days.
    """
    rng = random.Random(2020)
    day = dt.date.fromisoformat(replay.history_start)
    end = dt.date.fromisoformat(replay.end)
    dates: list[str] = []
    while day <= end:
        if day.weekday() < 5:
            dates.append(day.isoformat())
        day += dt.timedelta(days=1)

    crash = int(len(dates) * 0.75)
    prices = {c: [1.0] for c in CURRENCIES}
    for i in range(1, len(dates)):
        panic = math.exp(-(((i - crash) / 6) ** 2))
        common = rng.gauss(-0.004 * panic, 0.002 + 0.01 * panic)
        for c in CURRENCIES:
            own = rng.gauss(0, 0.004 * (1 - panic))
            prices[c].append(prices[c][-1] * (1 + common + own))
    return dates, prices


def load_tape(replay: Replay) -> tuple[list[str], dict[str, list[float]], bool]:
    """Load the real prices, or fall back to synthetic ones if the file is missing.

    Args:
        replay: Which window to load.

    Returns:
        Dates, currency -> prices, and True if the data is synthetic.
    """
    try:
        dates, prices = load_prices()
        return dates, prices, False
    except FileNotFoundError:
        dates, prices = synthetic_prices(replay)
        return dates, prices, True


def replay_days(dates: list[str], replay: Replay) -> list[int]:
    """Find the rows to play.

    Args:
        dates: Every date in the price history, oldest first.
        replay: The window to play.

    Returns:
        Row indexes of the days from ``replay.start`` to ``replay.end``.
    """
    return [i for i, d in enumerate(dates) if replay.start <= d <= replay.end]


class Tape:
    """Sends one tick per trading day and obeys play, pause and restart.

    Attributes:
        playing: Whether ticks are going out.
        position: How many days of the replay have been sent.
    """

    def __init__(
        self,
        bus: Bus,
        replay: Replay,
        interval: float = TICK_SECONDS,
        paused: bool = False,
    ) -> None:
        """Load the prices and get ready to play.

        Args:
            bus: A bus from ``canary.bus.make_bus``.
            replay: Which crash to replay.
            interval: Seconds between ticks.
            paused: Start paused and wait for a play command.
        """
        self.bus = bus
        self.replay = replay
        self.interval = interval
        self.base_interval = interval  # seconds per day at normal speed
        self.speed_changed = False
        self.dates, self.prices, self.synthetic = load_tape(replay)
        self.days = replay_days(self.dates, replay)
        self.playing = not paused
        self.position = 0

    def tick_message(self, i: int) -> dict[str, Any]:
        """Build the tick for one day of the replay.

        Args:
            i: Position in the replay, 0 for the first day.

        Returns:
            The tick message.
        """
        row = self.days[i]
        return {
            "type": "tick",
            "replay": self.replay.name,
            "i": i,
            "date": self.dates[row],
            "prices": {c: self.prices[c][row] for c in CURRENCIES},
            "synthetic": self.synthetic,
        }

    def log(self, text: str) -> None:
        """Put a line in the desk log and print it.

        Args:
            text: What happened.
        """
        print(f"tape: {text}", flush=True)
        self.bus.send({"type": "log", "agent": "tape", "text": text})

    def handle(self, msg: dict[str, Any]) -> None:
        """React to a control message; ignore everything else.

        Args:
            msg: Any message from the bus.
        """
        if msg.get("type") != "control" or msg.get("target") not in (
            None,
            "tape",
            "all",
        ):
            return
        cmd = msg.get("cmd")
        if cmd == "play" and self.position >= len(self.days):
            # Play after the end starts the replay again instead of doing nothing.
            self.position = 0
            self.playing = True
            self.log(f"restart {self.replay.name}: {len(self.days)} days")
        elif cmd == "play" and not self.playing:
            self.playing = True
            self.log("play")
        elif cmd == "pause" and self.playing:
            self.playing = False
            self.log("pause")
        elif cmd == "restart":
            name = msg.get("replay")
            if isinstance(name, str) and name in REPLAYS and name != self.replay.name:
                self.replay = REPLAYS[name]
                self.dates, self.prices, self.synthetic = load_tape(self.replay)
                self.days = replay_days(self.dates, self.replay)
            self.position = 0
            self.playing = True
            self.log(f"restart {self.replay.name}: {len(self.days)} days")
        elif cmd == "speed":
            speed = msg.get("speed")
            if isinstance(speed, (int, float)) and not isinstance(speed, bool):
                if 0.25 <= speed <= 8.0:
                    self.interval = self.base_interval / float(speed)
                    self.speed_changed = True
                    self.log(f"speed x{speed:g}")

    def end_message(self) -> dict[str, Any]:
        """The message sent once after the last day, so the page can say the replay ended.

        Returns:
            {"type": "end", "agent": "tape", "replay", "days", "last_date"}.
        """
        return {
            "type": "end",
            "agent": "tape",
            "replay": self.replay.name,
            "days": len(self.days),
            "last_date": self.dates[self.days[-1]] if self.days else None,
        }

    def run(self) -> None:
        """Send ticks on time while listening for controls. Runs until Ctrl-C."""
        if self.synthetic:
            self.log("SYNTHETIC DATA: data/fx_daily.csv not found")
        self.log(
            f"replay {self.replay.name}: {len(self.days)} days, {'playing' if self.playing else 'paused'}"
        )

        next_tick = time.monotonic()
        while True:
            wait = next_tick - time.monotonic() if self.playing else 0.5
            if wait > 0:
                msg = self.bus.recv(timeout=wait)
                if msg is not None:
                    self.handle(msg)
                if self.speed_changed:
                    # Don't wait out a long old interval after speeding up.
                    self.speed_changed = False
                    next_tick = min(next_tick, time.monotonic() + self.interval)
                continue

            if self.position < len(self.days):
                tick = self.tick_message(self.position)
                self.bus.send(tick)
                print(f"tick {tick['i']:>2} {tick['date']}", flush=True)
                self.position += 1
                if self.position == len(self.days):
                    self.log("replay finished")
                    self.playing = False
                    self.bus.send(self.end_message())

            # Step from the planned time so ticks don't drift, but after a pause
            # start fresh instead of firing a burst of ticks to catch up.
            next_tick += self.interval
            if next_tick < time.monotonic():
                next_tick = time.monotonic() + self.interval


def main() -> None:
    """Start the tape from the command line."""
    parser = argparse.ArgumentParser(prog="python -m canary.tape")
    parser.add_argument("--replay", choices=sorted(REPLAYS), default="2020")
    parser.add_argument(
        "--transport", choices=["multicast", "ports"], default="multicast"
    )
    parser.add_argument(
        "--interval", type=float, default=TICK_SECONDS, help="seconds per trading day"
    )
    parser.add_argument(
        "--paused", action="store_true", help="wait for a play command before ticking"
    )
    args = parser.parse_args()

    bus = make_bus(args.transport, "tape")
    try:
        Tape(bus, REPLAYS[args.replay], args.interval, args.paused).run()
    except KeyboardInterrupt:
        pass
    finally:
        bus.close()


if __name__ == "__main__":
    main()
