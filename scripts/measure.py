"""Lead-time table: how early the Canary card fires compared with stop-loss rules.

Usage:
    python scripts/measure.py

For each replay it finds the low of the risk basket (AUD, CAD, NOK) inside the
replay window, then reports when each rule first fired in that window, how
many trading days before the low that was, and how far the basket had already
fallen. Cards that are not the measured one are listed as false alarms.
"""

import sys
from dataclasses import dataclass
from pathlib import Path

# Let `python scripts/measure.py` import the desk package from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from desk.sim import DATA_FILE, REPLAYS, Day, Replay, load_prices, run  # noqa: E402

STOPS = (0.05, 0.075, 0.10)  # stop-loss rules: sell after a 5%, 7.5% or 10% fall


@dataclass(frozen=True)
class Row:
    """One line of the lead-time table.

    Attributes:
        rule: Name of the rule, e.g. "Canary card" or "5% drawdown stop".
        fired: Date it first fired in the replay window, or None.
        days_before_low: Trading days from firing to the low (negative if it
            fired after the low), or None if it never fired.
        drawdown_then: Basket drawdown on the day it fired, or None.
    """

    rule: str
    fired: str | None
    days_before_low: int | None
    drawdown_then: float | None


def low_day(replay: Replay, days: list[Day]) -> Day:
    """The day the risk basket was furthest below its peak, inside the window.

    Args:
        replay: The replay that was run.
        days: Output of sim.run().

    Returns:
        The day with the lowest drawdown (the earliest one if tied).

    Raises:
        ValueError: If no day falls inside the replay window.
    """
    window = [day for day in days if day.date >= replay.start]
    if not window:
        raise ValueError(f"no days inside the {replay.name} replay window")
    return min(window, key=lambda day: day.drawdown)


def make_row(rule: str, fired: Day | None, days: list[Day], low: Day) -> Row:
    """Turn the day a rule fired into a table row.

    Args:
        rule: Name of the rule.
        fired: The day it first fired, or None if it never did.
        days: Output of sim.run(), used to count trading days.
        low: The low day.

    Returns:
        The row.
    """
    if fired is None:
        return Row(rule, None, None, None)
    gap = days.index(low) - days.index(fired)
    return Row(rule, fired.date, gap, fired.drawdown)


def lead_times(replay: Replay, days: list[Day]) -> tuple[Day, list[Row], list[Day]]:
    """Compare the Canary card with simple stop-loss rules.

    Only firings inside the replay window count, for every rule alike.

    Args:
        replay: The replay that was run.
        days: Output of sim.run().

    Returns:
        The low day, the table rows (card first, then each stop), and the
        days with any other cards (false alarms).

    Raises:
        ValueError: If no day falls inside the replay window.
    """
    low = low_day(replay, days)
    window = [day for day in days if day.date >= replay.start]
    card = next((day for day in window if day.escalation is not None), None)
    rows = [make_row("Canary card", card, days, low)]
    for stop in STOPS:
        hit = next((day for day in window if day.drawdown <= -stop), None)
        rows.append(make_row(f"{stop:.1%} drawdown stop", hit, days, low))
    others = [day for day in days if day.escalation is not None and day is not card]
    return low, rows, others


def format_row(row: Row) -> str:
    """One markdown table line.

    Args:
        row: The row.

    Returns:
        e.g. "| Canary card | 2020-03-02 | 14 | -5.2% |"
    """
    if row.fired is None or row.days_before_low is None or row.drawdown_then is None:
        return f"| {row.rule} | never | - | - |"
    if row.days_before_low >= 0:
        timing = str(row.days_before_low)
    else:
        timing = f"{-row.days_before_low} AFTER"
    return f"| {row.rule} | {row.fired} | {timing} | {row.drawdown_then:+.1%} |"


def report(replay: Replay, days: list[Day]) -> str:
    """The lead-time table for one replay, as markdown.

    Args:
        replay: The replay that was run.
        days: Output of sim.run().

    Returns:
        A heading, the table, and the list of false alarms.
    """
    low, rows, others = lead_times(replay, days)
    lines = [
        f"## {replay.name}: {replay.start} to {replay.end}",
        "",
        f"Risk basket low: {low.date} ({low.drawdown:+.1%})",
        "",
        "| Rule | Fired | Trading days before low | Basket drawdown then |",
        "|---|---|---|---|",
        *(format_row(row) for row in rows),
        "",
        "Other cards (false alarms): "
        + (", ".join(day.date for day in others) or "none"),
    ]
    return "\n".join(lines)


def main() -> int:
    """Print the lead-time table for every replay.

    Returns:
        Exit code: 0 on success, 1 if the data file can't be read.
    """
    try:
        dates, prices = load_prices()
    except (OSError, ValueError) as e:
        print(f"Could not read {DATA_FILE}: {e}", file=sys.stderr)
        return 1
    reports = [report(r, run(r, dates, prices)) for r in REPLAYS.values()]
    print("\n\n".join(reports))
    return 0


if __name__ == "__main__":
    sys.exit(main())
