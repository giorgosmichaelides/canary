"""Tests for the relay's card dedupe and decision rules."""

from typing import Any

import pytest

from canary.relay import Cards, DecisionError

CARD = {"id": "2020:2020-03-02", "date": "2020-03-02", "action": "Cut commodity by 30%"}


def view(agent: str, card: dict[str, Any] = CARD) -> dict[str, Any]:
    return {"type": "view", "agent": agent, "date": card["date"], "escalation": card}


def test_four_analysts_raising_the_same_card_show_it_once() -> None:
    cards = Cards()
    shown = [
        cards.see(view(a), 0.0, 0.0)
        for a in ("fx", "havens", "commodity", "contrarian")
    ]
    assert sum(event is not None for event in shown) == 1
    assert list(cards.open) == [CARD["id"]]


def test_resent_card_is_not_shown_again_after_a_decision() -> None:
    cards = Cards()
    cards.see(view("fx"), 0.0, 0.0)
    cards.decide({"id": CARD["id"], "verdict": "approve"}, 5.0, 5.0)
    assert cards.see(view("havens"), 6.0, 6.0) is None


def test_restarting_the_replay_lets_the_card_show_again() -> None:
    cards = Cards()
    cards.see(view("fx"), 0.0, 0.0)
    cards.see({"type": "tick", "i": 0, "date": "2020-02-03"}, 1.0, 1.0)
    assert cards.see(view("fx"), 2.0, 2.0) is not None


def test_decision_records_time_to_decide_and_says_when_nothing_is_open() -> None:
    cards = Cards()
    cards.see(view("fx"), 10.0, 1_000.0)
    record, none_open = cards.decide(
        {"id": CARD["id"], "verdict": "veto", "reason": "too late", "by": "Ana"},
        22.34,
        1_012.0,
    )
    assert record["seconds_to_decide"] == 12.3
    assert record["action"] == CARD["action"] and record["market_date"] == CARD["date"]
    assert record["by"] == "Ana"
    assert none_open


def test_veto_needs_a_reason() -> None:
    cards = Cards()
    cards.see(view("fx"), 0.0, 0.0)
    with pytest.raises(DecisionError):
        cards.decide({"id": CARD["id"], "verdict": "veto", "reason": "  "}, 1.0, 1.0)
    assert CARD["id"] in cards.open


def test_unknown_or_already_decided_card_is_refused() -> None:
    cards = Cards()
    with pytest.raises(DecisionError) as unknown:
        cards.decide({"id": "nope", "verdict": "approve"}, 0.0, 0.0)
    assert unknown.value.status == 409
    cards.see(view("fx"), 0.0, 0.0)
    cards.decide({"id": CARD["id"], "verdict": "approve"}, 1.0, 1.0)
    with pytest.raises(DecisionError):
        cards.decide({"id": CARD["id"], "verdict": "approve"}, 2.0, 2.0)


def test_browser_that_connects_late_gets_open_cards() -> None:
    cards = Cards()
    cards.see(view("fx"), 0.0, 123.0)
    assert cards.snapshot() == [{"type": "card", "card": CARD, "opened_at": 123.0}]
