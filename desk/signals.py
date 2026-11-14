"""Pure maths on price series: returns, volatility, momentum, drawdown, correlation.

Every function here is pure: same input, same output, no files, no network.
"""


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
