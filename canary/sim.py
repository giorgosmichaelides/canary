"""Offline replay: run every analyst over a crash, day by day, with no network.

Usage:
    python -m canary.sim --replay 2020
    python -m canary.sim --replay 2024
    python -m canary.sim --replay 2020 --json > web/replay.json

Same data in, same output out, every time. Systems' agents should produce
the same numbers live; scripts/measure.py builds the lead-time table on top
of run(); the --json output lets the browser play a replay without agents.
"""

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from canary.explain import load_reasons, reason

from canary.signals import (
    CORRELATION_WINDOW,
    RISK_BASKET,
    basket,
    divergence,
    drawdown,
    mean_correlation,
    returns,
    risk_score,
    unison,
)
from canary.views import (
    SLICES,
    TEMPERAMENTS,
    ZSCORE_WINDOW,
    Escalation,
    EscalationState,
    View,
    check_escalation,
    contrarian_view,
    escalation,
    rebound,
    slice_view,
)

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "fx_daily.csv"
CURRENCIES = SLICES["contrarian"]  # all 7
MIN_HISTORY = ZSCORE_WINDOW + 1  # prices needed before a day can be judged


@dataclass(frozen=True)
class Replay:
    """One crash we can replay.

    Attributes:
        name: Short name, also the first part of escalation ids.
        history_start: First date of price history loaded for it.
        start: First day played in the demo.
        end: Last day played in the demo.
    """

    name: str
    history_start: str
    start: str
    end: str


REPLAYS: dict[str, Replay] = {
    "2020": Replay("2020", "2019-11-01", "2020-02-03", "2020-04-09"),
    "2024": Replay("2024", "2024-05-01", "2024-07-01", "2024-08-30"),
}


@dataclass(frozen=True)
class Day:
    """Everything Canary concludes on one trading day.

    Attributes:
        date: Market date, "YYYY-MM-DD".
        views: One view per analyst (fx, havens, commodity, contrarian).
        correlation: Mean pairwise correlation of the 7 currencies.
        unison: How merged the music is, 0..1.
        divergence: How strongly money is running to safety, 0..1.
        drawdown: Risk basket's fall from its peak, e.g. -0.052.
        risk: Risk score, 0..1.
        rebound: True on a rebound day.
        escalation: The card, if one fires today, else None.
    """

    date: str
    views: list[View]
    correlation: float
    unison: float
    divergence: float
    drawdown: float
    risk: float
    rebound: bool
    escalation: Escalation | None


def load_prices(path: Path = DATA_FILE) -> tuple[list[str], dict[str, list[float]]]:
    """Read the cached FX prices.

    Args:
        path: CSV with columns date, EUR, GBP, JPY, CHF, AUD, CAD, NOK.

    Returns:
        The dates (oldest first) and currency -> prices on those dates.

    Raises:
        FileNotFoundError: If the file is missing (run scripts/fetch_fx.py).
        ValueError: If a column is missing or a price isn't a number.
    """
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    missing = [c for c in ("date", *CURRENCIES) if rows and c not in rows[0]]
    if not rows or missing:
        raise ValueError(f"{path} is empty or missing columns: {missing}")
    dates = [row["date"] for row in rows]
    prices = {c: [float(row[c]) for row in rows] for c in CURRENCIES}
    return dates, prices


def judge_day(
    replay: Replay,
    date: str,
    prices: dict[str, list[float]],
    state: EscalationState,
) -> tuple[Day, EscalationState]:
    """Run all four analysts and the risk rule on one day.

    Every analyst is alive and fully trusted here; trust and covering are
    Systems' job in the live agents.

    Args:
        replay: Which replay this day belongs to.
        date: The market date being judged.
        prices: Currency -> prices up to and including `date`, oldest first.
        state: Escalation state from the day before.

    Returns:
        The day's results and the escalation state for tomorrow.

    Raises:
        ValueError: If there are fewer than MIN_HISTORY prices.
    """
    if len(prices[CURRENCIES[0]]) < MIN_HISTORY:
        raise ValueError(f"need at least {MIN_HISTORY} days of prices")
    views = [slice_view(name, name, prices) for name in TEMPERAMENTS]
    views.append(contrarian_view("contrarian", prices))
    stances = {view["slice"]: view["stance"] for view in views}

    recent = {c: returns(prices[c][-(CORRELATION_WINDOW + 1) :]) for c in CURRENCIES}
    corr = mean_correlation(recent)
    unison_score = unison(corr)
    div_score = divergence(stances["havens"], 1.0, stances["commodity"], 1.0)
    basket_drawdown = drawdown(basket({c: prices[c] for c in RISK_BASKET}))
    risk = risk_score(div_score, unison_score, basket_drawdown)

    state, fires = check_escalation(state, risk)
    card = escalation(replay.name, date, risk, views) if fires else None
    day = Day(
        date=date,
        views=views,
        correlation=corr,
        unison=unison_score,
        divergence=div_score,
        drawdown=basket_drawdown,
        risk=risk,
        rebound=rebound(prices),
        escalation=card,
    )
    return day, state


def run(replay: Replay, dates: list[str], prices: dict[str, list[float]]) -> list[Day]:
    """Judge every day from the first one with enough history to replay.end.

    Days before replay.start are included (marked by their date), so false
    alarms before the demo window are visible too.

    Args:
        replay: Which replay to run.
        dates: All dates in the data file, oldest first.
        prices: Currency -> prices on those dates.

    Returns:
        One Day per judged trading day, oldest first.
    """
    keep = [i for i, d in enumerate(dates) if replay.history_start <= d <= replay.end]
    days: list[Day] = []
    state = EscalationState()
    for n, i in enumerate(keep, start=1):
        if n < MIN_HISTORY:
            continue
        upto = {c: [prices[c][j] for j in keep[:n]] for c in CURRENCIES}
        day, state = judge_day(replay, dates[i], upto, state)
        days.append(day)
    return days


def format_day(day: Day) -> str:
    """One line of the replay printout.

    Args:
        day: The day to show.

    Returns:
        Date, correlation, unison, risk, the four stances, and any events.
    """
    stances = "  ".join(f"{view['stance']:+.2f}" for view in day.views)
    events = []
    if day.rebound:
        events.append("REBOUND")
    if day.escalation is not None:
        events.append(f"CARD: {day.escalation['action']}")
    return (
        f"{day.date}  {day.correlation:5.2f}  {day.unison:4.2f}  {day.risk:4.2f}"
        f"  {day.drawdown:+6.1%}  {stances}  {' | '.join(events)}"
    ).rstrip()


def format_card(card: Escalation) -> str:
    """Describe a card and its votes in one line.

    Args:
        card: The escalation.

    Returns:
        e.g. "2020-03-02  Cut commodity by 30%  risk 0.64  fx=dissent, ..."
    """
    votes = ", ".join(f"{v['by']}={v['vote']}" for v in card["votes"])
    return f"{card['date']}  {card['action']}  risk {card['risk']:.2f}  {votes}"


def report(replay: Replay, days: list[Day]) -> str:
    """The full printout for one replay.

    Args:
        replay: The replay that was run.
        days: Output of run().

    Returns:
        A table of the replay window, then every card (before and during it).
    """
    window = [d for d in days if d.date >= replay.start]
    header = "date         corr  uni  risk  basket    fx    hav   com   con  events"
    lines = [
        f"Replay {replay.name}: {replay.start} to {replay.end}"
        f" ({len(window)} trading days)",
        "",
        header,
        *(format_day(d) for d in window),
        "",
        "Cards:",
    ]
    for day in days:
        if day.escalation is not None:
            note = "" if day.date >= replay.start else "  (before the replay)"
            lines.append(f"  {format_card(day.escalation)}{note}")
    if not any(d.escalation for d in days):
        lines.append("  none")
    return "\n".join(lines)


def round_floats(value: Any) -> Any:
    """Round every float inside nested dicts and lists to 4 decimals.

    Args:
        value: A JSON-like value.

    Returns:
        The same structure with floats rounded, so the file stays small.
    """
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {key: round_floats(item) for key, item in value.items()}
    if isinstance(value, list):
        return [round_floats(item) for item in value]
    return value


def day_json(day: Day, cache: dict[str, str]) -> dict[str, Any]:
    """One day as a JSON-ready dict, with a reason line on every view.

    Args:
        day: The day.
        cache: Cached reason lines (see explain.load_reasons).

    Returns:
        date, correlation, unison, risk, drawdown, rebound, views, escalation.
    """
    return {
        "date": day.date,
        "correlation": day.correlation,
        "unison": day.unison,
        "risk": day.risk,
        "drawdown": day.drawdown,
        "rebound": day.rebound,
        "views": [
            {**view, "reason": reason(view, day.date, cache)} for view in day.views
        ],
        "escalation": day.escalation,
    }


def to_json(replay: Replay, days: list[Day], cache: dict[str, str]) -> str:
    """The replay as JSON, for the browser's replay mode.

    Shape: {"replay", "start", "end", "days": [...], "cards_before_replay": [...]}.
    `days` holds only the replay window, oldest first; each `views` entry has
    the same fields as in the live `view` message (minus `ts`). Cards that
    fired before the window (false alarms) are listed separately.

    Args:
        replay: The replay that was run.
        days: Output of run().
        cache: Cached reason lines (see explain.load_reasons).

    Returns:
        Indented JSON text; identical every time for the same data.
    """
    window = [day for day in days if day.date >= replay.start]
    earlier = [d.escalation for d in days if d.date < replay.start and d.escalation]
    data = {
        "replay": replay.name,
        "start": replay.start,
        "end": replay.end,
        "days": [day_json(day, cache) for day in window],
        "cards_before_replay": earlier,
    }
    return json.dumps(round_floats(data), indent=1)


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point.

    Args:
        argv: Arguments (defaults to the real command line).

    Returns:
        Exit code: 0 on success, 1 if the data or reasons file can't be read.
    """
    parser = argparse.ArgumentParser(description="Replay a crash offline.")
    parser.add_argument("--replay", choices=sorted(REPLAYS), default="2020")
    parser.add_argument(
        "--json", action="store_true", help="print JSON for web/replay.json"
    )
    args = parser.parse_args(argv)
    try:
        dates, prices = load_prices()
        cache = load_reasons()
    except (OSError, ValueError) as e:
        print(f"Could not read the data: {e}", file=sys.stderr)
        return 1
    replay = REPLAYS[args.replay]
    days = run(replay, dates, prices)
    print(to_json(replay, days, cache) if args.json else report(replay, days))
    return 0


if __name__ == "__main__":
    sys.exit(main())
