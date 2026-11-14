"""Pure maths on price series: returns, volatility, momentum, drawdown, correlation.

Every function here is pure: same input, same output, no files, no network.
"""

import statistics
import itertools

CORRELATION_WINDOW = 10  # trading days. LOCKED: changing it can lose full unison.


def returns(prices: list[float]) -> list[float]:
    """Daily change of each price, as a fraction of the day before.

    Example: [100, 102] -> [0.02], because 102 is 2% more than 100.

    Args:
        prices: Prices in date order, oldest first.

    Returns:
        One value per day after the first, so one shorter than prices.

    Raises:
        ValueError: If any price is zero or negative.
    """
    if any(price <= 0 for price in prices):
        raise ValueError("prices must be positive")
    return [today / yesterday - 1 for yesterday, today in zip(prices, prices[1:])]


def correlation(a: list[float], b: list[float]) -> float:
    """How much two series move together, from -1 to 1.

    1 means they always move the same way, 0 means unrelated,
    -1 means they always move opposite ways.

    Args:
        a: First series, e.g. one currency's daily returns.
        b: Second series, same length and same dates as a.

    Returns:
        The correlation, or 0.0 if either series never changes.

    Raises:
        ValueError: If the series have different lengths or fewer than 2 values.
    """
    if len(a) != len(b) or len(a) < 2:
        raise ValueError("need two series of equal length, at least 2 values each")
    try:
        return statistics.correlation(a, b)
    except statistics.StatisticsError:
        return 0.0  # a flat series doesn't move, so it can't move with anything


def mean_correlation(series: dict[str, list[float]]) -> float:
    """Average correlation over every pair of series.

    Args:
        series: Name -> returns, all the same length and dates.

    Returns:
        The mean of the pairwise correlations, from -1 to 1.

    Raises:
        ValueError: If there are fewer than 2 series, or lengths differ.
    """
    pairs = list(itertools.combinations(series.values(), 2))
    if not pairs:
        raise ValueError("need at least 2 series")
    return sum(correlation(a, b) for a, b in pairs) / len(pairs)
