"""Pure maths on price series: returns, volatility, momentum, drawdown, correlation.

Every function here is pure: same input, same output, no files, no network.
"""

import statistics
import itertools
import math

CORRELATION_WINDOW = 10  # trading days. LOCKED: changing it can lose full unison.
UNISON_START = 0.25  # correlation where the parts start to merge
UNISON_FULL = 0.65  # correlation where every part plays one note
RISK_BASKET = ("AUD", "CAD", "NOK")  # commodity currencies: first to fall in a panic
DRAWDOWN_SCALE = 0.10  # a 10% fall in the risk basket counts as maximum drawdown risk


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


def clamp(value: float, low: float, high: float) -> float:
    """Limit a value to the range low..high.

    Args:
        value: The number to limit.
        low: Smallest allowed result.
        high: Largest allowed result.

    Returns:
        low if value is below it, high if above it, otherwise value.
    """
    return max(low, min(high, value))


def unison(corr: float) -> float:
    """How merged the music is: 0 = separate parts, 1 = one note.

    Args:
        corr: Mean correlation of the 7 currencies.

    Returns:
        0 below UNISON_START, 1 above UNISON_FULL, a straight line between.
    """
    return clamp((corr - UNISON_START) / (UNISON_FULL - UNISON_START), 0.0, 1.0)


def volatility(rets: list[float]) -> float:
    """How much returns jump around: their standard deviation.

    Example: [0.01, -0.01, 0.01, -0.01] is about 0.0115 (moves of ~1% a day).

    Args:
        rets: Daily returns, oldest first.

    Returns:
        The standard deviation of rets.

    Raises:
        ValueError: If there are fewer than 2 returns.
    """
    return statistics.stdev(rets)


def momentum(rets: list[float], days: int) -> float:
    """Total price move over the last `days` days.

    Example: returns [0.01, 0.01] over 2 days -> 0.0201 (+2.01%).

    Args:
        rets: Daily returns, oldest first.
        days: How many of the most recent days to look back over.

    Returns:
        The compounded move, e.g. 0.05 for +5%.

    Raises:
        ValueError: If days is below 1 or there are fewer than `days` returns.
    """
    if days < 1 or len(rets) < days:
        raise ValueError(f"need days >= 1 and at least {days} returns")
    return math.prod(1 + r for r in rets[-days:]) - 1


def drawdown(prices: list[float]) -> float:
    """How far the latest price is below its highest point so far.

    Example: [100, 120, 90] -> -0.25 (90 is 25% below the peak of 120).

    Args:
        prices: Prices (or basket values) in date order, oldest first.

    Returns:
        0.0 at a new high, otherwise a negative fraction like -0.052 for -5.2%.

    Raises:
        ValueError: If prices is empty or contains a non-positive price.
    """
    if not prices or min(prices) <= 0:
        raise ValueError("need at least one price, all positive")
    return prices[-1] / max(prices) - 1


def basket(prices: dict[str, list[float]]) -> list[float]:
    """Value of an equal mix of several currencies, starting at 1.0.

    Each currency is scaled so its first price counts as 1.0, then the
    scaled prices are averaged day by day.

    Example: {"A": [1, 2], "B": [10, 10]} -> [1.0, 1.5]

    Args:
        prices: Currency -> prices, all the same length and dates.

    Returns:
        The basket's value on each day.

    Raises:
        ValueError: If there are no currencies, lengths differ, or a
            currency has no prices or a non-positive first price.
    """
    series = list(prices.values())
    if not series or any(not s or s[0] <= 0 for s in series):
        raise ValueError("need currencies with a positive first price")
    if len({len(s) for s in series}) != 1:
        raise ValueError("all currencies need the same number of days")
    days = len(series[0])
    return [sum(s[day] / s[0] for s in series) / len(series) for day in range(days)]


def divergence(
    havens_stance: float,
    havens_trust: float,
    commodity_stance: float,
    commodity_trust: float,
) -> float:
    """How strongly money is running to safety, from 0 to 1.

    High when the havens analyst is bullish and the commodity analyst is
    bearish at the same time. Each stance is weighted by how much we trust
    it, so a silent analyst counts for less.

    Args:
        havens_stance: Havens analyst's opinion, -1..1.
        havens_trust: How fresh that opinion is, 0..1.
        commodity_stance: Commodity analyst's opinion, -1..1.
        commodity_trust: How fresh that opinion is, 0..1.

    Returns:
        0 when they agree, up to 1 when havens is +1 and commodity is -1.
    """
    gap = havens_stance * havens_trust - commodity_stance * commodity_trust
    return clamp(gap / 2, 0.0, 1.0)


def risk_score(div_score: float, unison_score: float, basket_drawdown: float) -> float:
    """One number for how dangerous the market looks today, from 0 to 1.

    Args:
        div_score: Output of divergence(), 0..1.
        unison_score: Output of unison(), 0..1.
        basket_drawdown: Output of drawdown() on the risk basket, e.g. -0.05.

    Returns:
        0.8 x the worse of divergence and unison, plus 0.2 x the basket's
        fall measured in 10% steps, capped at 1.
    """
    fall = -basket_drawdown / DRAWDOWN_SCALE
    return clamp(0.8 * max(div_score, unison_score) + 0.2 * fall, 0.0, 1.0)


def zscore(values: list[float]) -> float:
    """How unusual the latest value is compared with the whole list.

    Measured in standard deviations from the list's average.
    Example: -2.0 means the latest value is unusually low.

    Args:
        values: Values in date order, oldest first, e.g. the last 20 prices.

    Returns:
        (latest - mean) / standard deviation, or 0.0 if values never change.

    Raises:
        ValueError: If there are fewer than 2 values.
    """
    spread = statistics.stdev(values)
    if spread == 0:
        return 0.0  # nothing ever changes, so nothing is unusual
    return (values[-1] - statistics.mean(values)) / spread
