"""Tests for desk.explain."""

from pathlib import Path

import pytest

from desk.explain import load_reasons, reason, reason_key, template_reason
from desk.sim import REPLAYS, load_prices, run
from desk.views import View


def make_view(
    slice_name: str,
    stance: float,
    by: str = "",
    about: str = "",
    conviction: float = 0.9,
    stress: float = 0.0,
) -> View:
    """A view with sensible defaults for testing reasons."""
    return {
        "slice": slice_name,
        "by": by or slice_name,
        "about": about or slice_name,
        "stance": stance,
        "conviction": conviction,
        "stress": stress,
    }


def test_reason_key_is_by_slice_date() -> None:
    """The key format matches docs/DESIGN.md section 6."""
    view = make_view("fx", 0.5, by="havens")
    assert reason_key(view, "2020-02-25") == "havens|fx|2020-02-25"


def test_template_describes_the_numbers() -> None:
    """A strongly bullish havens view says so, with its number."""
    text = template_reason(make_view("havens", 0.93))
    assert text == "On the yen and franc: bullish (+0.93), high conviction."


def test_template_mentions_covering() -> None:
    """A coverer's line starts by saying whose slice it is covering."""
    text = template_reason(make_view("fx", 0.31, by="havens", conviction=0.1))
    assert text.startswith("Covering fx. ")
    assert "leaning up" in text and "low conviction" in text


def test_template_for_contrarian_names_its_target() -> None:
    """The contrarian says which group it is betting on."""
    text = template_reason(make_view("contrarian", -0.93, about="havens"))
    assert text.startswith("Contrarian bet on the yen and franc: bearish")


def test_template_flags_high_stress() -> None:
    """Very wild markets get a mention."""
    text = template_reason(make_view("fx", -0.8, stress=0.7))
    assert "markets unusually wild" in text


def test_cached_line_wins_over_template() -> None:
    """If Claude wrote a line for this view, use it."""
    view = make_view("havens", 0.93)
    cache = {"havens|havens|2020-03-02": "Money is running to the yen and franc."}
    assert reason(view, "2020-03-02", cache) == "Money is running to the yen and franc."
    assert reason(view, "2020-03-03", cache).startswith("On the yen and franc")


def test_missing_reasons_file_means_empty_cache(tmp_path: Path) -> None:
    """No file yet is normal, so templates are used."""
    assert load_reasons(tmp_path / "reasons.json") == {}


def test_broken_reasons_file_raises(tmp_path: Path) -> None:
    """A corrupt file must be noticed, not silently ignored."""
    path = tmp_path / "reasons.json"
    path.write_text("{not json")
    with pytest.raises(ValueError):
        load_reasons(path)


def test_reasons_file_must_hold_strings(tmp_path: Path) -> None:
    """Numbers instead of sentences are rejected."""
    path = tmp_path / "reasons.json"
    path.write_text('{"fx|fx|2020-03-02": 3}')
    with pytest.raises(ValueError):
        load_reasons(path)


def test_every_2020_template_is_short() -> None:
    """The card has room for one sentence of at most 22 words."""
    dates, prices = load_prices()
    for day in run(REPLAYS["2020"], dates, prices):
        for view in day.views:
            assert len(template_reason(view).split()) <= 22
