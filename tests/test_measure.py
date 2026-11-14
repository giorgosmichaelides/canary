"""Tests for scripts/measure.py, on the real data."""

from canary.sim import REPLAYS, load_prices, run
from scripts.measure import Row, format_row, lead_times


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
