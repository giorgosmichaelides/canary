"""One-line reasons for each view: a cached line if there is one, else a template.

The view is final before a reason is attached; nothing here can change a
stance, a risk score or an action. Reasons are lookups and string formatting,
so they never make the music wait.

Cache: data/reasons.json maps "by|slice|date" to a sentence. It is optional;
without it every reason comes from template_reason().
"""

import json
from pathlib import Path

from canary.views import View

REASONS_FILE = Path(__file__).resolve().parent.parent / "data" / "reasons.json"

# What each slice is, in words a judge understands.
SLICE_NAMES: dict[str, str] = {
    "fx": "the euro and pound",
    "havens": "the yen and franc",
    "commodity": "commodity currencies",
    "contrarian": "all seven currencies",
}


def reason_key(view: View, date: str) -> str:
    """The cache key for a view's reason.

    Args:
        view: The view.
        date: Market date, "YYYY-MM-DD".

    Returns:
        "by|slice|date", e.g. "havens|fx|2020-02-25".
    """
    return f"{view['by']}|{view['slice']}|{date}"


def load_reasons(path: Path = REASONS_FILE) -> dict[str, str]:
    """Read cached reason lines.

    A missing file is normal (no lines generated yet), so it gives an empty
    cache. A broken file raises, so it is noticed at start-up, not mid-demo.

    Args:
        path: JSON file mapping "by|slice|date" to a sentence.

    Returns:
        The cache, or {} if the file does not exist.

    Raises:
        ValueError: If the file is not a JSON object of strings.
    """
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(data, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in data.items()
    ):
        raise ValueError(f"{path} must map strings to strings")
    return data


def mood(stance: float) -> str:
    """Describe a stance in a word or two.

    Args:
        stance: -1..1.

    Returns:
        "bullish", "leaning up", "neutral", "leaning down" or "bearish".
    """
    if stance >= 0.5:
        return "bullish"
    if stance >= 0.15:
        return "leaning up"
    if stance > -0.15:
        return "neutral"
    if stance > -0.5:
        return "leaning down"
    return "bearish"


def sureness(conviction: float) -> str:
    """Describe a conviction in a word.

    Args:
        conviction: 0..1.

    Returns:
        "high", "some" or "low".
    """
    if conviction >= 2 / 3:
        return "high"
    if conviction >= 1 / 3:
        return "some"
    return "low"


def template_reason(view: View) -> str:
    """Write a one-line reason from the view's own numbers.

    Examples:
        "On the yen and franc: bullish (+0.93), high conviction."
        "Covering fx. On the euro and pound: leaning up (+0.31), low conviction."
        "Contrarian bet on the yen and franc: bearish (-0.93), high conviction."

    Args:
        view: The finished view.

    Returns:
        One sentence, at most 22 words.

    Raises:
        KeyError: If the view's slice or about is unknown.
    """
    prefix = f"Covering {view['slice']}. " if view["by"] != view["slice"] else ""
    if view["by"] == "contrarian":
        subject = f"Contrarian bet on {SLICE_NAMES[view['about']]}"
    else:
        subject = f"On {SLICE_NAMES[view['about']]}"
    stress = ", markets unusually wild" if view["stress"] >= 0.5 else ""
    return (
        f"{prefix}{subject}: {mood(view['stance'])} ({view['stance']:+.2f}),"
        f" {sureness(view['conviction'])} conviction{stress}."
    )


def reason(view: View, date: str, cache: dict[str, str]) -> str:
    """The reason line to show for a view: cached if available, else a template.

    Args:
        view: The finished view.
        date: Market date, "YYYY-MM-DD".
        cache: Output of load_reasons().

    Returns:
        One sentence.

    Raises:
        KeyError: If there is no cached line and the view's slice is unknown.
    """
    return cache.get(reason_key(view, date)) or template_reason(view)
