"""Download daily exchange rates from FRED into data/fx_daily.csv."""

from pathlib import Path
import urllib.error
import urllib.request
import csv
import io

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}&coed={end}"
TIMEOUT_SECONDS = 30  # give up after 30s instead of hanging
DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "fx_daily.csv"

# column -> (FRED id, flip?). Flip turns "X per dollar" into "dollars per X".
SERIES: dict[str, tuple[str, bool]] = {
    "EUR": ("DEXUSEU", False),
    "GBP": ("DEXUSUK", False),
    "JPY": ("DEXJPUS", True),
    "CHF": ("DEXSZUS", True),
    "AUD": ("DEXUSAL", False),
    "CAD": ("DEXCAUS", True),
    "NOK": ("DEXNOUS", True),
}

# Date ranges: the 2020 crash (tuned on), 2008, 2022 and 2024 (tested on), and now.
WINDOWS: list[tuple[str, str]] = [
    ("2008-05-01", "2008-12-31"),
    ("2019-11-01", "2020-04-30"),
    ("2022-05-02", "2022-11-30"),
    ("2024-05-01", "2024-08-30"),
    ("2026-04-01", "2026-11-13"),  # "now": the latest months, for the demo's last word
]


def download(fred_id: str, start: str, end: str) -> str:
    """Download one exchange-rate series as CSV text.

    Args:
        fred_id: FRED's name for the series, e.g. "DEXUSEU" (dollars per euro).
        start: First date, "YYYY-MM-DD".
        end: Last date, "YYYY-MM-DD".

    Returns:
        The raw CSV text.

    Raises:
        RuntimeError: If FRED can't be reached or returns an error.
    """
    url = URL.format(id=fred_id, start=start, end=end)
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            data: bytes = response.read()
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"Could not download {fred_id}: {e}") from e
    return data.decode()


def parse(text: str) -> dict[str, float]:
    """Turn FRED's CSV text into {date: value}, skipping days with no value.

    Args:
        text: CSV text from download().

    Returns:
        A dict mapping "YYYY-MM-DD" to that day's rate.

    Raises:
        ValueError: If a row isn't a date followed by a number.
    """
    rows = csv.reader(io.StringIO(text))
    next(rows)  # skip the header line
    values: dict[str, float] = {}

    for date, value in rows:
        if value in ("", "."):
            continue  # holiday: no rate published
        values[date] = float(value)

    return values


def fetch_currency(fred_id: str, flip: bool) -> dict[str, float]:
    """Download one currency over every window, in dollars per unit.

    Args:
        fred_id: FRED's name for the series.
        flip: True if FRED quotes it as "units per dollar".

    Returns:
        A dict mapping "YYYY-MM-DD" to dollars per one unit of the currency.

    Raises:
        RuntimeError: If a download fails.
    """
    values: dict[str, float] = {}

    for start, end in WINDOWS:
        values.update(parse(download(fred_id, start, end)))

    if flip:
        values = {date: 1 / value for date, value in values.items()}

    return values


def main() -> None:
    """Download every currency and write the CSV.

    Only days where all 7 currencies have a price are kept.

    Raises:
        RuntimeError: If a download fails.
    """
    prices = {
        name: fetch_currency(fred_id, flip) for name, (fred_id, flip) in SERIES.items()
    }

    # Keep only the dates that every currency has.
    common: set[str] = set(prices["EUR"])
    for currency_prices in prices.values():
        common &= set(currency_prices)
    dates = sorted(common)

    DATA_FILE.parent.mkdir(exist_ok=True)
    with DATA_FILE.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["date", *SERIES])
        for date in dates:
            writer.writerow([date, *(f"{prices[name][date]:.8g}" for name in SERIES)])

    print(f"Wrote {len(dates)} days to {DATA_FILE}")


if __name__ == "__main__":
    main()
