#!/usr/bin/env python3
"""
Download the current-year UK-AIR pre-formatted CSV for one site and extract
the last 7 days of PM2.5 rows.

Example:
  python ukair_prefmt_pm25_last_week.py --site-id BRIS
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import re
import sys
from urllib.parse import urljoin

import pandas as pd
import requests
from bs4 import BeautifulSoup

BASE = "https://uk-air.defra.gov.uk"
FLAT_FILES_URL = BASE + "/data/flat_files"


def get_flat_files_page(site_id: str) -> str:
    r = requests.get(FLAT_FILES_URL, params={"site_id": site_id}, timeout=60)
    r.raise_for_status()
    return r.text


def find_current_year_all_pollutants_csv(page_html: str, site_id: str, year: int) -> str:
    """
    Find the link for:
      All Hourly Pollutant Data for site <site> (Column Format) <year> (CSV)

    The UK-AIR flat-files page lists year links for the 'All Hourly Pollutant Data'
    section. We scrape the first matching anchor near that section.
    """
    soup = BeautifulSoup(page_html, "html.parser")

    # Look for any anchor whose text contains the year.
    # Then prefer hrefs that look like CSV-ish downloads.
    year_text = str(year)

    candidates: list[str] = []
    for a in soup.find_all("a", href=True):
        text = " ".join(a.get_text(" ", strip=True).split())
        href = a["href"]

        if year_text not in text:
            continue

        # The flat_files page contains many year links.
        # These CSV download links usually sit under the automatic data headings.
        # We bias toward hrefs that look like downloadable files.
        if any(token in href.lower() for token in [".csv", "csv", "flat", "download", "data"]):
            candidates.append(urljoin(BASE, href))

    if not candidates:
        # fallback: any anchor with the target year
        for a in soup.find_all("a", href=True):
            text = " ".join(a.get_text(" ", strip=True).split())
            if year_text in text:
                candidates.append(urljoin(BASE, a["href"]))

    if not candidates:
        raise RuntimeError(
            f"Could not find a download link for site_id={site_id}, year={year} "
            f"on {FLAT_FILES_URL}?site_id={site_id}"
        )

    # Try candidates until one looks like CSV content.
    session = requests.Session()
    for url in candidates:
        try:
            r = session.get(url, timeout=60)
            r.raise_for_status()
            content_type = r.headers.get("content-type", "").lower()
            # Many servers send text/plain or text/csv or octet-stream.
            if "csv" in content_type or "text" in content_type or "octet-stream" in content_type:
                # Good enough for a test script.
                return url
        except requests.RequestException:
            continue

    # If none of the probe downloads worked, just return the first candidate.
    return candidates[0]


def download_csv_text(csv_url: str) -> str:
    r = requests.get(csv_url, timeout=120)
    r.raise_for_status()
    return r.text


def parse_csv_flexibly(csv_text: str) -> pd.DataFrame:
    """
    UK-AIR pre-formatted files can vary a bit. This tries a couple of parsers.
    """
    for sep in [",", ";", "\t"]:
        try:
            df = pd.read_csv(io.StringIO(csv_text), sep=sep)
            if len(df.columns) >= 2:
                return df
        except Exception:
            pass
    raise RuntimeError("Could not parse the downloaded CSV with common delimiters.")


def find_datetime_column(df: pd.DataFrame) -> str:
    candidates = [c for c in df.columns if re.search(r"(date|time)", str(c), re.I)]
    if not candidates:
        raise RuntimeError(f"Could not find a date/time column. Columns: {list(df.columns)}")
    return candidates[0]


def find_pm25_column(df: pd.DataFrame) -> str:
    """
    Try to find a PM2.5 value column in the all-pollutants CSV.
    """
    patterns = [
        r"pm\s*2\.?5",
        r"pm_?2_?5",
        r"pm25",
    ]
    for col in df.columns:
        col_s = str(col).strip().lower()
        if any(re.search(p, col_s, re.I) for p in patterns):
            return col
    raise RuntimeError(f"Could not find a PM2.5 column. Columns: {list(df.columns)}")


def filter_last_n_days_pm25(df: pd.DataFrame, days: int) -> pd.DataFrame:
    dt_col = find_datetime_column(df)
    pm25_col = find_pm25_column(df)

    out = df[[dt_col, pm25_col]].copy()
    out[dt_col] = pd.to_datetime(out[dt_col], errors="coerce", utc=True)
    out[pm25_col] = pd.to_numeric(out[pm25_col], errors="coerce")
    out = out.dropna(subset=[dt_col])

    cutoff = pd.Timestamp.utcnow() - pd.Timedelta(days=days)
    out = out[out[dt_col] >= cutoff].sort_values(dt_col).reset_index(drop=True)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-id", required=True, help="UK-AIR site id, e.g. BRIS, WEYB, NOTT")
    parser.add_argument("--days", type=int, default=7, help="Look back this many days (default 7)")
    parser.add_argument(
        "--out",
        default=None,
        help="Optional output CSV path. Defaults to <site>_pm25_last_<days>d.csv",
    )
    args = parser.parse_args()

    year = dt.datetime.now(dt.timezone.utc).year

    print(f"Fetching flat-files page for site_id={args.site_id}")
    page_html = get_flat_files_page(args.site_id)

    print(f"Finding current-year all-pollutants CSV for {year}")
    csv_url = find_current_year_all_pollutants_csv(page_html, args.site_id, year)
    print(f"Downloading: {csv_url}")

    csv_text = download_csv_text(csv_url)
    df = parse_csv_flexibly(csv_text)
    pm25 = filter_last_n_days_pm25(df, args.days)

    out_path = args.out or f"{args.site_id}_pm25_last_{args.days}d.csv"
    pm25.to_csv(out_path, index=False)

    print(f"Saved {len(pm25)} rows to {out_path}")
    if not pm25.empty:
        print(pm25.head(10).to_string(index=False))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())