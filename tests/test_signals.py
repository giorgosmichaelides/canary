"""Tests for canary.signals."""

import pytest

from canary.signals import (
    correlation,
    returns,
    mean_correlation,
    clamp,
    unison,
    volatility,
    momentum,
    drawdown,
    basket,
    divergence,
    risk_score,
    zscore,
)


def test_returns_are_fractional_daily_changes() -> None:
    """A rise of 2% then a fall of 2% gives [0.02, -0.02]."""
    assert returns([100.0, 102.0, 99.96]) == pytest.approx([0.02, -0.02])


def test_returns_reject_non_positive_prices() -> None:
    """A zero price is bad data, so it raises."""
    with pytest.raises(ValueError):
        returns([1.0, 0.0])


def test_correlation_same_direction_is_one() -> None:
    """Two series that always move together score 1."""
    assert correlation([1.0, 2.0, 3.0], [2.0, 4.0, 6.0]) == pytest.approx(1.0)


def test_correlation_opposite_direction_is_minus_one() -> None:
    """Two series that always move opposite ways score -1."""
    assert correlation([1.0, 2.0, 3.0], [3.0, 2.0, 1.0]) == pytest.approx(-1.0)


def test_correlation_flat_series_is_zero() -> None:
    """A series that never changes scores 0 instead of crashing."""
    assert correlation([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]) == 0.0


def test_correlation_rejects_different_lengths() -> None:
    """Series of different lengths are a bug, so it raises."""
    with pytest.raises(ValueError):
        correlation([1.0, 2.0], [1.0, 2.0, 3.0])


def test_mean_correlation_averages_every_pair() -> None:
    """Pairs score 1, -1 and -1, so the average is -1/3."""
    up = [1.0, 2.0, 3.0]
    down = [3.0, 2.0, 1.0]
    result = mean_correlation({"a": up, "b": up, "c": down})
    assert result == pytest.approx(-1 / 3)


def test_mean_correlation_needs_two_series() -> None:
    """One series has no pairs, so it raises."""
    with pytest.raises(ValueError):
        mean_correlation({"a": [1.0, 2.0]})


def test_clamp_limits_to_range() -> None:
    """Values outside the range are pulled to the nearest edge."""
    assert clamp(5.0, 0.0, 1.0) == 1.0
    assert clamp(-5.0, 0.0, 1.0) == 0.0
    assert clamp(0.3, 0.0, 1.0) == 0.3


def test_unison_maps_correlation_to_zero_one() -> None:
    """Low correlation is 0, high is 1, halfway is 0.5."""
    assert unison(0.10) == 0.0
    assert unison(0.45) == pytest.approx(0.5)
    assert unison(0.68) == 1.0


def test_volatility_is_zero_for_steady_returns() -> None:
    """Returns that never change have no spread."""
    assert volatility([0.01, 0.01, 0.01]) == 0.0


def test_volatility_grows_with_bigger_moves() -> None:
    """Bigger daily swings mean higher volatility."""
    calm = volatility([0.001, -0.001, 0.001, -0.001])
    wild = volatility([0.03, -0.03, 0.03, -0.03])
    assert wild > calm


def test_volatility_needs_two_returns() -> None:
    """One return has no spread to measure, so it raises."""
    with pytest.raises(ValueError):
        volatility([0.01])


def test_momentum_compounds_recent_days_only() -> None:
    """Only the last 2 days count, and +1% twice is +2.01%."""
    assert momentum([0.50, 0.01, 0.01], days=2) == pytest.approx(0.0201)


def test_momentum_up_then_down_is_slightly_negative() -> None:
    """+10% then -10% leaves you 1% down, not flat."""
    assert momentum([0.10, -0.10], days=2) == pytest.approx(-0.01)


def test_momentum_needs_enough_days() -> None:
    """Asking for more days than we have is a bug, so it raises."""
    with pytest.raises(ValueError):
        momentum([0.01], days=3)


def test_drawdown_measures_fall_from_peak() -> None:
    """90 after a peak of 120 is 25% down."""
    assert drawdown([100.0, 120.0, 90.0]) == pytest.approx(-0.25)


def test_drawdown_is_zero_at_new_high() -> None:
    """At the highest point so far, there is no drawdown."""
    assert drawdown([100.0, 90.0, 130.0]) == 0.0


def test_drawdown_needs_prices() -> None:
    """No prices is a bug, so it raises."""
    with pytest.raises(ValueError):
        drawdown([])


def test_basket_weights_currencies_equally() -> None:
    """A doubling and a flat currency average to +50%."""
    assert basket({"A": [1.0, 2.0], "B": [10.0, 10.0]}) == pytest.approx([1.0, 1.5])


def test_basket_rejects_different_lengths() -> None:
    """Currencies with different numbers of days are a bug."""
    with pytest.raises(ValueError):
        basket({"A": [1.0, 2.0], "B": [1.0]})


def test_basket_rejects_empty_input() -> None:
    """No currencies means no basket."""
    with pytest.raises(ValueError):
        basket({})


def test_divergence_is_max_when_money_runs_to_safety() -> None:
    """Havens fully bullish, commodity fully bearish -> 1."""
    assert divergence(1.0, 1.0, -1.0, 1.0) == pytest.approx(1.0)


def test_divergence_is_zero_when_analysts_agree() -> None:
    """Same stance on both sides means no flight to safety."""
    assert divergence(0.5, 1.0, 0.5, 1.0) == 0.0


def test_divergence_ignores_untrusted_views() -> None:
    """A havens view with zero trust counts for nothing."""
    assert divergence(1.0, 0.0, 0.0, 1.0) == 0.0


def test_risk_score_mixes_signals() -> None:
    """0.8 x 0.5 + 0.2 x (5% fall / 10%) = 0.5."""
    assert risk_score(0.5, 0.2, -0.05) == pytest.approx(0.5)


def test_risk_score_is_capped_at_one() -> None:
    """Full unison plus a 17% fall would be 1.14, so it caps at 1."""
    assert risk_score(1.0, 1.0, -0.17) == 1.0


def test_zscore_flags_an_unusually_high_value() -> None:
    """A jump to 5 after four 1s is well above normal."""
    assert zscore([1.0, 1.0, 1.0, 1.0, 5.0]) > 1.5


def test_zscore_flags_an_unusually_low_value() -> None:
    """A drop to 1 after four 5s is well below normal."""
    assert zscore([5.0, 5.0, 5.0, 5.0, 1.0]) < -1.5


def test_zscore_is_zero_when_nothing_changes() -> None:
    """Flat values must not crash with a divide by zero."""
    assert zscore([2.0, 2.0, 2.0]) == 0.0


def test_zscore_needs_two_values() -> None:
    """One value has no spread, so it raises."""
    with pytest.raises(ValueError):
        zscore([1.0])
