"""Tests for the tape's crisis switching."""

from typing import Any, cast

from canary.bus import Bus
from canary.sim import REPLAYS
from canary.tape import Tape


class _SentBus:
    """Collects sent messages instead of using the network."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, msg: dict[str, Any]) -> None:
        self.sent.append(msg)


def test_restart_with_a_replay_switches_crisis() -> None:
    """After {"cmd": "restart", "replay": "2008"} the next tick is 2008's first day."""
    tape = Tape(cast(Bus, _SentBus()), REPLAYS["2020"], paused=True)
    tape.position = 10
    tape.handle({"type": "control", "cmd": "restart", "replay": "2008"})
    assert tape.replay.name == "2008" and tape.position == 0 and tape.playing
    first = tape.tick_message(0)
    assert first["replay"] == "2008" and first["date"] == REPLAYS["2008"].start


def test_restart_with_unknown_replay_keeps_the_current_one() -> None:
    """A bad name just restarts the current crisis."""
    tape = Tape(cast(Bus, _SentBus()), REPLAYS["2020"], paused=True)
    tape.handle({"type": "control", "cmd": "restart", "replay": "1929"})
    assert tape.replay.name == "2020" and tape.position == 0
