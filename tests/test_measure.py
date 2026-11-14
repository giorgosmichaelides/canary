"""Tests for scripts/measure.py, on the real data."""

from canary.sim import REPLAYS, load_prices, run
from scripts.measure import Row, describe_other_card, format_row, lead_times


def test_2020_lead_times_match_the_honest_claims() -> None:
    """Card 2 Mar (14 days before the 20 Mar low), 5% stop 26 Feb, 10% 12 Mar."""
    dates, prices = load_prices()
    replay = REPLAYS["2020"]
    low, rows, others = lead_times(replay, run(replay, dates, prices))
    assert low.date == "2020-03-20"
    fired = {row.rule: (row.fired, row.days_before_low) for row in rows}
    assert fired["Canary card"] == ("2020-03-02", 14)
    assert fired["5.0% drawdown stop"] == ("2020-02-26", 17)
    assert fired["7.5% drawdown stop"] == ("2020-03-12", 6)
    assert fired["10.0% drawdown stop"] == ("2020-03-12", 6)
    assert [day.date for day in others] == ["2020-01-08", "2020-01-31"]


def test_format_row_marks_late_and_missing_rules() -> None:
    """A rule after the low says AFTER; a rule that never fired says never."""
    late = Row("Canary card", "2024-08-22", -13, 0.0)
    assert "13 AFTER" in format_row(late)
    assert "never" in format_row(Row("5.0% drawdown stop", None, None, None))


def test_out_of_sample_results_stay_honest() -> None:
    """2008: card 8 Aug, between the 5% and 7.5% stops. 2022: no card at all."""
    dates, prices = load_prices()
    for name, card in (("2008", "2008-08-08"), ("2022", None)):
        replay = REPLAYS[name]
        _, rows, _ = lead_times(replay, run(replay, dates, prices))
        assert rows[0].rule == "Canary card"
        assert rows[0].fired == card


def test_early_cards_are_labelled_warm_up() -> None:
    """Cards with under 40 days of history say so; 2020's January ones don't."""
    dates, prices = load_prices()
    labels = {}
    for name in ("2020", "2022"):
        replay = REPLAYS[name]
        days = run(replay, dates, prices)
        _, _, others = lead_times(replay, days)
        labels[name] = [describe_other_card(day, days) for day in others]
    assert labels["2020"] == ["2020-01-08", "2020-01-31"]
    assert labels["2022"] == ["2022-06-02 (warm-up)"]
