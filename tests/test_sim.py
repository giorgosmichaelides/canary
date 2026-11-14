"""Tests for canary.sim, including the real 2020 replay."""

import json
from pathlib import Path

import pytest

from canary.sim import REPLAYS, load_prices, report, run, to_json


def test_load_prices_reads_the_csv(tmp_path: Path) -> None:
    """A small valid file loads into dates and per-currency prices."""
    path = tmp_path / "fx.csv"
    path.write_text(
        "date,EUR,GBP,JPY,CHF,AUD,CAD,NOK\n"
        "2020-01-02,1.1,1.3,0.009,1.0,0.7,0.77,0.11\n"
        "2020-01-03,1.2,1.3,0.009,1.0,0.7,0.77,0.11\n"
    )
    dates, prices = load_prices(path)
    assert dates == ["2020-01-02", "2020-01-03"]
    assert prices["EUR"] == [1.1, 1.2]


def test_load_prices_rejects_missing_columns(tmp_path: Path) -> None:
    """A file without NOK is unusable, so it raises."""
    path = tmp_path / "fx.csv"
    path.write_text("date,EUR\n2020-01-02,1.1\n")
    with pytest.raises(ValueError):
        load_prices(path)


def test_load_prices_missing_file_raises(tmp_path: Path) -> None:
    """No file is a clear FileNotFoundError, not a silent empty replay."""
    with pytest.raises(FileNotFoundError):
        load_prices(tmp_path / "nope.csv")


def test_2020_replay_matches_the_demo() -> None:
    """Real data: 48 replay days, false alarms 8 and 31 Jan, card on 2 Mar."""
    dates, prices = load_prices()
    replay = REPLAYS["2020"]
    days = run(replay, dates, prices)
    window = [d for d in days if d.date >= replay.start]
    cards = [d.escalation for d in days if d.escalation is not None]
    assert len(window) == 48
    assert [c["date"] for c in cards] == ["2020-01-08", "2020-01-31", "2020-03-02"]
    demo_card = cards[-1]
    assert demo_card["action"] == "Cut commodity by 30%"
    dissenters = {v["by"] for v in demo_card["votes"] if v["vote"] == "dissent"}
    assert dissenters == {"fx", "contrarian"}


def test_replay_is_identical_every_time() -> None:
    """Same data in, same printout out (CLAUDE.md's 'done when' for Quant)."""
    dates, prices = load_prices()
    for replay in REPLAYS.values():
        first = report(replay, run(replay, dates, prices))
        second = report(replay, run(replay, dates, prices))
        assert first == second


def test_json_replay_has_the_window_and_events() -> None:
    """--json output: 48 days, card on 2 Mar with votes, rebound on 25 Mar."""
    dates, prices = load_prices()
    replay = REPLAYS["2020"]
    data = json.loads(to_json(replay, run(replay, dates, prices), cache={}))
    days = {day["date"]: day for day in data["days"]}
    assert len(data["days"]) == 48
    assert days["2020-03-02"]["escalation"]["action"] == "Cut commodity by 30%"
    assert days["2020-03-25"]["rebound"] is True
    assert days["2020-02-03"]["escalation"] is None
    assert all(view["reason"] for view in days["2020-03-02"]["views"])
    assert [c["date"] for c in data["cards_before_replay"]] == [
        "2020-01-08",
        "2020-01-31",
    ]


def test_json_replay_is_identical_every_time() -> None:
    """Same data, byte-identical JSON."""
    dates, prices = load_prices()
    replay = REPLAYS["2020"]
    first = to_json(replay, run(replay, dates, prices), cache={})
    second = to_json(replay, run(replay, dates, prices), cache={})
    assert first == second
