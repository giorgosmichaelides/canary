"""Download daily exchange rates from FRED into data/fx_daily.csv."""

import urllib.error
import urllib.request
import csv
import io

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}&coed={end}"
TIMEOUT_SECONDS = 30  # give up after 30s instead of hanging

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

# Two date ranges: the 2020 crash, and the 2024 yen crash (our test case).
WINDOWS: list[tuple[str, str]] = [
    ("2019-11-01", "2020-04-30"),
    ("2024-05-01", "2024-08-30"),
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


if __name__ == "__main__":
    jpy = fetch_currency("DEXJPUS", flip=True)
    print(len(jpy), jpy["2020-03-02"])
