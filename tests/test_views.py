"""Tests for desk.views."""

import math

import pytest

from desk.views import (
    EscalationState,
    View,
    check_escalation,
    contrarian_view,
    conviction,
    escalation,
    normal_moves,
    proposed_cut,
    rebound,
    slice_view,
    stance,
    stress,
    vote,
)

CALM = [0.001, -0.001] * 20  # 40 quiet days: ±0.1% a day


def test_normal_moves_flags_a_big_rise() -> None:
    """Three +1% days after quiet ones is far bigger than normal."""
    assert normal_moves(CALM + [0.01, 0.01, 0.01], days=3) > 3


def test_normal_moves_flags_a_big_fall() -> None:
    """Three -1% days after quiet ones is a big negative number."""
    assert normal_moves(CALM + [-0.01, -0.01, -0.01], days=3) < -3


def test_normal_moves_is_zero_when_nothing_moves() -> None:
    """Flat prices have no 'normal', so the answer is 0 instead of a crash."""
    assert normal_moves([0.0] * 10, days=3) == 0.0


def test_stance_is_neutral_with_no_move() -> None:
    """No move means no opinion, apart from the bias."""
    assert stance(0.0) == 0.0
    assert stance(0.0, bias=0.10) == pytest.approx(0.10)


def test_stance_follows_tanh() -> None:
    """Two normal moves down gives tanh(-1)."""
    assert stance(-2.0) == pytest.approx(math.tanh(-1.0))


def test_stance_never_leaves_range() -> None:
    """A huge move plus a bias still caps at 1."""
    assert stance(100.0, bias=0.10) == 1.0


def test_conviction_scales_with_size_not_direction() -> None:
    """Up or down, 1.5 moves is half sure; 6 moves is fully sure."""
    assert conviction(1.5) == pytest.approx(0.5)
    assert conviction(-6.0) == 1.0


def test_stress_is_low_when_nothing_changes() -> None:
    """Recent days as quiet as usual means almost no stress."""
    assert stress(CALM) == pytest.approx(0.0, abs=0.05)


def test_stress_rises_when_recent_days_get_wild() -> None:
    """Ten ±3% days after quiet ones is a lot of stress."""
    assert stress([0.001, -0.001] * 25 + [0.03, -0.03] * 5) > 0.5


def test_stress_is_zero_when_nothing_moves() -> None:
    """Flat prices can't be stressful, and must not crash."""
    assert stress([0.0] * 10) == 0.0


def wiggle(n: int) -> list[float]:
    """Return n prices that tick up and down by 0.1% around 1.0."""
    return [1.0 + 0.001 * (i % 2) for i in range(n)]


def test_slice_view_is_bullish_after_a_rally() -> None:
    """Three strong up days for EUR and GBP make fx bullish and sure."""
    rally = wiggle(40) + [1.01, 1.02, 1.03]
    view = slice_view("fx", "fx", {"EUR": rally, "GBP": rally})
    assert view["slice"] == "fx"
    assert view["by"] == "fx"
    assert view["stance"] > 0.5
    assert view["conviction"] == 1.0


def test_coverer_uses_its_own_temperament() -> None:
    """Commodity's +0.10 optimism disappears when havens covers its slice."""
    flat = {"AUD": wiggle(41), "CAD": wiggle(41), "NOK": wiggle(41)}
    own = slice_view("commodity", "commodity", flat)
    covered = slice_view("commodity", "havens", flat)
    assert covered["by"] == "havens"
    assert own["stance"] - covered["stance"] == pytest.approx(0.10, abs=0.01)


def test_slice_view_rejects_unknown_analyst() -> None:
    """A typo in an analyst name is a bug, so it raises."""
    with pytest.raises(KeyError):
        slice_view("fx", "nobody", {"EUR": wiggle(10), "GBP": wiggle(10)})


def market(**overrides: list[float]) -> dict[str, list[float]]:
    """All 7 currencies wiggling quietly for 30 days, except any overrides."""
    names = ("EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NOK")
    prices = {name: wiggle(30) for name in names}
    prices.update(overrides)
    return prices


def test_fx_can_cover_the_contrarian() -> None:
    """If the contrarian dies, fx judges all 7 currencies its own way."""
    view = slice_view("contrarian", "fx", market())
    assert view["slice"] == "contrarian"
    assert view["by"] == "fx"


CRASH = wiggle(27) + [0.95, 0.90, 0.85]  # three days of 5% falls
RALLY = wiggle(27) + [1.05, 1.10, 1.15]  # three days of 5% rises


def test_contrarian_buys_after_a_crash() -> None:
    """Commodity currencies crashed, so the contrarian expects a bounce."""
    view = contrarian_view("contrarian", market(AUD=CRASH, CAD=CRASH, NOK=CRASH))
    assert view["by"] == "contrarian"
    assert view["stance"] > 0.5


def test_contrarian_sells_after_a_rally() -> None:
    """EUR and GBP shot up, so the contrarian expects them to fall back."""
    view = contrarian_view("contrarian", market(EUR=RALLY, GBP=RALLY))
    assert view["stance"] < -0.5


def test_contrarian_covering_only_looks_at_that_slice() -> None:
    """Covering havens, it ignores the commodity crash entirely."""
    calm = contrarian_view("havens", market())
    crash = contrarian_view("havens", market(AUD=CRASH, CAD=CRASH, NOK=CRASH))
    assert crash["slice"] == "havens"
    assert crash["stance"] == calm["stance"]


def test_contrarian_says_which_group_it_is_about() -> None:
    """After a commodity crash, the contrarian's stance is about commodity."""
    view = contrarian_view("contrarian", market(AUD=CRASH, CAD=CRASH, NOK=CRASH))
    assert view["about"] == "commodity"


BOUNCE = CRASH + [0.88, 0.91, 0.94]  # crash, then three strong up days


def test_rebound_after_crash_and_bounce() -> None:
    """Commodity crashed this week and is now bouncing hard."""
    assert rebound(market(AUD=BOUNCE, CAD=BOUNCE, NOK=BOUNCE))


def test_no_rebound_while_still_falling() -> None:
    """A crash with no bounce yet is not a rebound."""
    assert not rebound(market(AUD=CRASH, CAD=CRASH, NOK=CRASH))


def test_no_rebound_in_a_calm_market() -> None:
    """Nothing crashed, so there is nothing to rebound from."""
    assert not rebound(market())


def make_view(slice_name: str, stance_value: float, about: str = "") -> View:
    """A view with just the fields the escalation code reads."""
    return {
        "slice": slice_name,
        "by": slice_name,
        "about": about or slice_name,
        "stance": stance_value,
        "conviction": 0.5,
        "stress": 0.0,
    }


def run_rule(risks: list[float]) -> list[bool]:
    """Feed a sequence of daily risks through the rule; return fire days."""
    state = EscalationState()
    fired = []
    for risk in risks:
        state, fires = check_escalation(state, risk)
        fired.append(fires)
    return fired


def test_card_needs_two_days_above_threshold() -> None:
    """One high day is not enough; the second one in a row fires."""
    assert run_rule([0.6, 0.2, 0.6, 0.6]) == [False, False, False, True]


def test_no_second_card_until_risk_calms_down() -> None:
    """Risk staying high, or dipping only to 0.4, must not fire again."""
    assert run_rule([0.6, 0.6, 0.6, 0.4, 0.6, 0.6]) == [False, True] + [False] * 4


def test_card_rearms_after_risk_drops_below_030() -> None:
    """Dropping below 0.30 re-arms the rule, so a new card can fire."""
    assert run_rule([0.6, 0.6, 0.2, 0.6, 0.6]) == [False, True, False, False, True]


def test_vote_flips_havens() -> None:
    """Bullish on havens means expecting trouble, so it supports a cut."""
    assert vote(make_view("havens", 0.9)) == "support"
    assert vote(make_view("fx", 0.9)) == "dissent"
    assert vote(make_view("fx", 0.1)) == "neutral"


def test_contrarian_betting_against_havens_dissents() -> None:
    """Bearish on havens is a risk-on view, so it dissents."""
    assert vote(make_view("contrarian", -0.9, about="havens")) == "dissent"


def test_proposed_cut_picks_the_weakest_holding() -> None:
    """Commodity has the lowest stance; the contrarian slice is never cut."""
    views = [
        make_view("fx", 0.5),
        make_view("commodity", -0.4),
        make_view("contrarian", -0.9),
    ]
    assert proposed_cut(views, risk=0.6) == ("commodity", 0.30)
    assert proposed_cut(views, risk=0.8) == ("commodity", 0.50)


def test_proposed_cut_needs_a_holding() -> None:
    """With only the contrarian's view there is nothing to cut."""
    with pytest.raises(ValueError):
        proposed_cut([make_view("contrarian", 0.0)], risk=0.6)


def test_escalation_builds_the_card() -> None:
    """The card has a stable id, a readable action and one vote per view."""
    views = [make_view("fx", 0.5), make_view("commodity", -0.4)]
    card = escalation("2020", "2020-03-02", 0.64, views)
    assert card["id"] == "2020:2020-03-02"
    assert card["action"] == "Cut commodity by 30%"
    assert [v["vote"] for v in card["votes"]] == ["dissent", "support"]
