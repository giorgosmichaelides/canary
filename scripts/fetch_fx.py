"""Download daily exchange rates from FRED into data/fx_daily.csv."""

import urllib.error
import urllib.request

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd={start}&coed={end}"
TIMEOUT_SECONDS = 30  # give up after 30s instead of hanging


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


if __name__ == "__main__":
    print(download("DEXUSEU", "2020-03-01", "2020-03-10"))
