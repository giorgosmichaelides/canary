"""Tests for desk.signals."""

import pytest

from desk.signals import returns
from desk.signals import correlation, returns, mean_correlation


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
