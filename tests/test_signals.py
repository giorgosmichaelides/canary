"""Tests for desk.signals."""

import pytest

from desk.signals import returns


def test_returns_are_fractional_daily_changes() -> None:
    """A rise of 2% then a fall of 2% gives [0.02, -0.02]."""
    assert returns([100.0, 102.0, 99.96]) == pytest.approx([0.02, -0.02])


def test_returns_reject_non_positive_prices() -> None:
    """A zero price is bad data, so it raises."""
    with pytest.raises(ValueError):
        returns([1.0, 0.0])
