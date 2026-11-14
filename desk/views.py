"""Each analyst's opinion of its slice, and the escalation rule.

Pure functions: same prices in, same view out.
"""

import math
from dataclasses import dataclass
from typing import Literal, TypedDict

from desk.signals import (
    RISK_BASKET,
    basket,
    clamp,
    momentum,
    returns,
    volatility,
    zscore,
)

NORMAL_VOL_WINDOW = 60  # days of history that define a "normal" daily move
RECENT_VOL_WINDOW = 10  # days that count as "recent" when measuring stress
ZSCORE_WINDOW = 20  # days the contrarian compares today's price with
REBOUND_LOW = -1.8  # how oversold (z-score) the risk basket must have been
REBOUND_LOOKBACK = 5  # ...at some point in the last week (5 trading days)
REBOUND_BOUNCE_DAYS = 3  # days the bounce off the low is measured over

# Escalation rule (docs/DESIGN.md section 4). Tuned on 2020; do not change.
RAISE_AT = 0.50  # risk at or above this...
RAISE_DAYS = 2  # ...for this many days in a row raises a card
REARM_BELOW = 0.30  # after a card, risk must drop below this before another
BIG_CUT_AT = 0.75  # risk at or above this proposes the bigger cut
CUT = 0.30  # normal proposal: cut the weakest slice by 30%
BIG_CUT = 0.50  # bigger proposal: cut it by 50%
VOTE_THRESHOLD = 0.15  # risk-on stance beyond +-0.15 counts as a vote

# Which currencies each analyst watches.
SLICES: dict[str, tuple[str, ...]] = {
    "fx": ("EUR", "GBP"),
    "havens": ("JPY", "CHF"),
    "commodity": ("AUD", "CAD", "NOK"),
    "contrarian": ("EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NOK"),
}

# The groups the contrarian scans for the one that has gone furthest.
CONTRARIAN_GROUPS = ("fx", "havens", "commodity")


@dataclass(frozen=True)
class Temperament:
    """How an analyst thinks.

    Attributes:
        days: How many recent days it looks at when judging a move.
        bias: Its built-in lean: positive is optimistic.
    """

    days: int
    bias: float


TEMPERAMENTS: dict[str, Temperament] = {
    "fx": Temperament(days=3, bias=0.0),  # nervous
    "havens": Temperament(days=8, bias=0.0),  # calm
    "commodity": Temperament(days=6, bias=0.10),  # optimist
}


def normal_moves(rets: list[float], days: int) -> float:
    """How big the last `days` days' move is, compared with a normal move.

    Example: 2.0 means it moved twice as far as usual over that many days;
    -3.0 means an unusually big fall.

    Args:
        rets: Daily returns, oldest first. The last 60 define "normal".
        days: How many recent days the move is measured over.

    Returns:
        The move in units of a normal move, or 0.0 if prices never moved.

    Raises:
        ValueError: If there are fewer than 2 returns or fewer than `days`.
    """
    normal_vol = volatility(rets[-NORMAL_VOL_WINDOW:])
    if normal_vol == 0:
        return 0.0  # nothing ever moves, so no move is unusual
    return momentum(rets, days) / (normal_vol * math.sqrt(days))


def stance(moves: float, bias: float = 0.0) -> float:
    """The analyst's opinion, from -1 (expects falls) to 1 (expects rises).

    Args:
        moves: Output of normal_moves().
        bias: The analyst's built-in lean, e.g. +0.10 for an optimist.

    Returns:
        tanh(moves / 2) + bias, kept inside -1..1.
    """
    return clamp(math.tanh(moves / 2) + bias, -1.0, 1.0)


def conviction(moves: float) -> float:
    """How sure the analyst is, from 0 (no idea) to 1 (certain).

    Args:
        moves: Output of normal_moves().

    Returns:
        abs(moves) / 3, kept inside 0..1. Three normal moves or more is 1.
    """
    return clamp(abs(moves) / 3, 0.0, 1.0)


def stress(rets: list[float]) -> float:
    """How much wilder the market is now than normal, from 0 (calm) to 1 (panic).

    Compares volatility over the last 10 days with the last 60.

    Args:
        rets: Daily returns, oldest first.

    Returns:
        (recent_vol / normal_vol - 1) / 2.5, kept inside 0..1.

    Raises:
        ValueError: If there are fewer than 2 returns.
    """
    normal_vol = volatility(rets[-NORMAL_VOL_WINDOW:])
    if normal_vol == 0:
        return 0.0  # nothing ever moves, so nothing is stressful
    recent_vol = volatility(rets[-RECENT_VOL_WINDOW:])
    return clamp((recent_vol / normal_vol - 1) / 2.5, 0.0, 1.0)


class View(TypedDict):
    """One analyst's opinion of one slice, as sent in the `view` message.

    Systems adds `ts`, and explain.py adds `reason`, before it is sent.

    Attributes:
        slice: Which slice this view is for, e.g. "havens".
        by: Which analyst formed it (differs from slice when covering).
        about: Which group the stance is about. Same as slice, except for
            the contrarian, which names the group it is betting against.
        stance: -1 (expects falls) to 1 (expects rises).
        conviction: 0 (no idea) to 1 (certain).
        stress: 0 (calm) to 1 (panic).
    """

    slice: str
    by: str
    about: str
    stance: float
    conviction: float
    stress: float


def slice_basket(slice_name: str, prices: dict[str, list[float]]) -> list[float]:
    """The basket value of one slice's currencies on each day.

    Args:
        slice_name: Which slice, e.g. "havens".
        prices: Currency -> prices, oldest first.

    Returns:
        The equal-weight basket of that slice's currencies, starting at 1.0.

    Raises:
        KeyError: If slice_name or a currency is unknown.
        ValueError: If the prices are unusable (see signals.basket).
    """
    return basket({currency: prices[currency] for currency in SLICES[slice_name]})


def slice_view(slice_name: str, by: str, prices: dict[str, list[float]]) -> View:
    """Form one analyst's view of one slice, from prices up to today.

    The analyst `by` always uses its own temperament, even when it is
    covering someone else's slice.

    Args:
        slice_name: Which slice to judge, e.g. "havens" or "contrarian".
        by: Which analyst is judging it.
        prices: Currency -> prices up to and including today, oldest first.

    Returns:
        The view for that slice.

    Raises:
        KeyError: If slice_name, by or a currency is unknown.
        ValueError: If there are too few prices.
    """
    temperament = TEMPERAMENTS[by]
    rets = returns(slice_basket(slice_name, prices))
    moves = normal_moves(rets, temperament.days)
    return {
        "slice": slice_name,
        "by": by,
        "about": slice_name,
        "stance": stance(moves, temperament.bias),
        "conviction": conviction(moves),
        "stress": stress(rets),
    }


def contrarian_view(slice_name: str, prices: dict[str, list[float]]) -> View:
    """The contrarian's view: bet against whatever has gone furthest.

    On its own slice it scans fx, havens and commodity and picks the most
    stretched one. When covering another analyst it only looks at that slice.

    Args:
        slice_name: "contrarian" for its own slice, or the slice it covers.
        prices: Currency -> prices up to and including today, oldest first.

    Returns:
        The view. Stance is -tanh(z / 1.5), so an unusually big fall
        (very negative z) gives a bullish stance. `about` names the group.

    Raises:
        KeyError: If slice_name or a currency is unknown.
        ValueError: If there are too few prices.
    """
    groups = CONTRARIAN_GROUPS if slice_name == "contrarian" else (slice_name,)
    zscores = {
        group: zscore(slice_basket(group, prices)[-ZSCORE_WINDOW:]) for group in groups
    }
    target = max(groups, key=lambda group: abs(zscores[group]))
    z = zscores[target]
    rets = returns(slice_basket(slice_name, prices))
    return {
        "slice": slice_name,
        "by": "contrarian",
        "about": target,
        "stance": -math.tanh(z / 1.5),
        "conviction": conviction(z),
        "stress": stress(rets),
    }


def rebound(prices: dict[str, list[float]]) -> bool:
    """Whether the market is bouncing back after a crash.

    True when the risk basket (AUD, CAD, NOK) was badly oversold at some point
    in the last week AND its last 3 days rose by at least one normal move.
    The music plays a rising solo while this is true.

    Args:
        prices: Currency -> prices up to and including today, oldest first.

    Returns:
        True on a rebound day, otherwise False.

    Raises:
        KeyError: If a risk-basket currency is missing.
        ValueError: If there are too few prices.
    """
    risk = basket({currency: prices[currency] for currency in RISK_BASKET})
    recent_zscores = [
        zscore(risk[: len(risk) - days_ago][-ZSCORE_WINDOW:])
        for days_ago in range(REBOUND_LOOKBACK)
    ]
    bounce = normal_moves(returns(risk), REBOUND_BOUNCE_DAYS)
    return min(recent_zscores) <= REBOUND_LOW and bounce >= 1.0


VoteKind = Literal["support", "neutral", "dissent"]


class Vote(TypedDict):
    """One analyst's reaction to a proposed action, shown as a chip on the card.

    Attributes:
        slice: Which slice the opinion is for.
        by: Which analyst holds it.
        vote: "support", "neutral" or "dissent".
    """

    slice: str
    by: str
    vote: VoteKind


class Escalation(TypedDict):
    """The approval card: what the code decided and how each analyst voted.

    Attributes:
        id: "<replay>:<date>", e.g. "2020:2020-03-02". One card per id.
        date: Market date the card fired on.
        risk: Risk score that day.
        rule: The rule that fired, in words, for the card.
        action: The proposed action, in words, e.g. "Cut commodity by 30%".
        slice: The slice to cut.
        cut: How much to cut it by, e.g. 0.3.
        votes: One vote per view.
    """

    id: str
    date: str
    risk: float
    rule: str
    action: str
    slice: str
    cut: float
    votes: list[Vote]


@dataclass(frozen=True)
class EscalationState:
    """What the escalation rule remembers from one day to the next.

    Attributes:
        days_above: Days in a row with risk at or above RAISE_AT.
        armed: False after a card fires, until risk drops below REARM_BELOW.
    """

    days_above: int = 0
    armed: bool = True


def check_escalation(
    state: EscalationState, risk: float
) -> tuple[EscalationState, bool]:
    """Apply one day's risk to the escalation rule.

    A card fires when risk is at or above 0.50 for 2 days in a row. After
    that, no new card until risk has dropped below 0.30 (re-armed).

    Args:
        state: Yesterday's state (EscalationState() on the first day).
        risk: Today's risk score.

    Returns:
        Today's state, and True if a card fires today.
    """
    days_above = state.days_above + 1 if risk >= RAISE_AT else 0
    fires = state.armed and days_above >= RAISE_DAYS
    armed = (state.armed and not fires) or risk < REARM_BELOW
    return EscalationState(days_above=days_above, armed=armed), fires


def vote(view: View) -> VoteKind:
    """How an analyst reacts to a proposal to cut risk.

    Stances are put on one "risk-on" axis first: bullish on havens means
    expecting trouble, so a havens stance is flipped. Then an analyst who is
    clearly risk-on dissents, one who is clearly risk-off supports.

    Args:
        view: The analyst's view.

    Returns:
        "dissent" above +0.15, "support" below -0.15, otherwise "neutral".
    """
    risk_on = -view["stance"] if view["about"] == "havens" else view["stance"]
    if risk_on > VOTE_THRESHOLD:
        return "dissent"
    if risk_on < -VOTE_THRESHOLD:
        return "support"
    return "neutral"


def proposed_cut(views: list[View], risk: float) -> tuple[str, float]:
    """Pick which slice to cut, and by how much.

    The slice with the lowest stance is cut (ties go to the alphabetically
    first slice, so every analyst picks the same one). The contrarian's own
    slice is not a holding, so it is never cut.

    Args:
        views: Every view in the analyst's book.
        risk: Today's risk score.

    Returns:
        The slice name and the cut, e.g. ("commodity", 0.3).

    Raises:
        ValueError: If there are no fx, havens or commodity views.
    """
    holdings = [view for view in views if view["slice"] in CONTRARIAN_GROUPS]
    if not holdings:
        raise ValueError("no fx, havens or commodity view to cut")
    weakest = min(holdings, key=lambda view: (view["stance"], view["slice"]))
    return weakest["slice"], BIG_CUT if risk >= BIG_CUT_AT else CUT


def escalation(replay: str, date: str, risk: float, views: list[View]) -> Escalation:
    """Build the approval card for a day the escalation rule fired.

    Args:
        replay: Which replay this is, e.g. "2020".
        date: Market date, "YYYY-MM-DD".
        risk: Today's risk score.
        views: Every view in the analyst's book.

    Returns:
        The escalation to include in the view message.

    Raises:
        ValueError: If there are no fx, havens or commodity views.
    """
    slice_name, cut = proposed_cut(views, risk)
    return {
        "id": f"{replay}:{date}",
        "date": date,
        "risk": risk,
        "rule": f"Risk {risk:.2f} >= {RAISE_AT:.2f} for {RAISE_DAYS} days in a row",
        "action": f"Cut {slice_name} by {cut:.0%}",
        "slice": slice_name,
        "cut": cut,
        "votes": [
            {"slice": view["slice"], "by": view["by"], "vote": vote(view)}
            for view in views
        ],
    }
