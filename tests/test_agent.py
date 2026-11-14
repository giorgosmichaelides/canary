"""Tests for the analyst's pure parts: trust, the takeover ring, who is alive, and risk."""

import time

import pytest

from desk.agent import (
    GONE_AFTER,
    RING,
    STARTUP_GRACE,
    alive_analysts,
    coverer,
    day_risk,
    form_view,
    history,
    slices_to_cover,
    trust,
)
from desk.sim import REPLAYS, load_prices, run

ALL = set(RING)


def test_trust_is_full_for_a_second_then_halves_every_point_eight() -> None:
    assert trust(0.0) == 1.0
    assert trust(1.0) == 1.0
    assert trust(1.8) == pytest.approx(0.5)
    assert trust(2.6) == pytest.approx(0.25)


def test_everyone_alive_plays_their_own_slice() -> None:
    for name in RING:
        assert coverer(name, ALL) == name
        assert slices_to_cover(name, ALL) == []


def test_next_live_analyst_in_the_ring_covers() -> None:
    assert coverer("fx", ALL - {"fx"}) == "havens"
    assert slices_to_cover("havens", ALL - {"fx"}) == ["fx"]
    assert coverer("contrarian", ALL - {"contrarian"}) == "fx"


def test_ring_skips_more_than_one_dead_neighbour() -> None:
    alive = {"commodity", "contrarian"}
    assert coverer("fx", alive) == "commodity"
    assert coverer("havens", alive) == "commodity"
    assert slices_to_cover("commodity", alive) == ["fx", "havens"]
    assert slices_to_cover("contrarian", alive) == []


def test_every_agent_reaches_the_same_answer() -> None:
    alive = ALL - {"havens"}
    owners = {
        s: [a for a in alive if s in slices_to_cover(a, alive) or s == a] for s in RING
    }
    assert all(len(who) == 1 for who in owners.values())


def test_nobody_is_gone_during_start_up_grace() -> None:
    alive, isolated = alive_analysts("fx", {}, now=STARTUP_GRACE - 0.1, started=0.0)
    assert alive == ALL and not isolated


def test_silent_peer_is_gone_after_three_seconds() -> None:
    now = 100.0
    heard = {
        "havens": now - 0.5,
        "commodity": now - 0.5,
        "contrarian": now - GONE_AFTER - 0.1,
    }
    alive, isolated = alive_analysts("fx", heard, now, started=0.0)
    assert alive == {"fx", "havens", "commodity"} and not isolated


def test_hearing_nobody_means_my_link_is_down_so_cover_nothing() -> None:
    alive, isolated = alive_analysts("fx", {}, now=100.0, started=0.0)
    assert isolated
    assert slices_to_cover("fx", alive) == []


@pytest.mark.parametrize("replay_name", ["2020", "2024"])
def test_live_risk_matches_sim_when_everyone_is_fresh(replay_name: str) -> None:
    replay = REPLAYS[replay_name]
    dates, prices = load_prices()
    for day in run(replay, dates, prices)[-10:]:
        upto = history(dates, prices, replay, day.date)
        assert upto is not None
        now = time.time()
        book = {name: {**form_view(name, name, upto), "ts": now} for name in RING}
        assert day_risk(book, upto, now) == pytest.approx(day.risk)
