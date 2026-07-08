#!/usr/bin/env python3
"""Probe official UK-AIR historical AURN download routes.

This is a manual network smoke test, not a normal unit test. It checks whether
UK-AIR's pre-formatted automatic monitoring CSV files expose historical rows
for one or more site/year/day combinations, and optionally verifies that the
Atom annual feed is reachable.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


UK_AIR_BASE_URL = "https://uk-air.defra.gov.uk"
FLAT_FILES_URL = f"{UK_AIR_BASE_URL}/data/flat_files"
ATOM_AUTO_URL_TEMPLATE = f"{UK_AIR_BASE_URL}/data/atom-dls/auto/{{year}}/atom.en.xml"
USER_AGENT = "uk-aq-history-integrity-probe/1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Probe UK-AIR pre-formatted historical AURN CSV files for a target "
            "day. This calls uk-air.defra.gov.uk."
        )
    )
    parser.add_argument(
        "--site-id",
        action="append",
        dest="site_ids",
        required=True,
        help=(
            "UK-AIR site code to test, for example BDMA, WEYB, EA8. Repeat for "
            "multiple sites."
        ),
    )
    parser.add_argument("--year", type=int, default=2025)
    parser.add_argument("--day", default="2025-12-01", help="Target UTC day.")
    parser.add_argument(
        "--out-dir",
        default="/Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/tmp/uk_air_aurn_probe",
        help="Directory for downloaded HTML/CSV/Atom probe files.",
    )
    parser.add_argument(
        "--csv-limit",
        type=int,
        default=3,
        help="Maximum candidate CSV files to download per site.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=45,
    )
    parser.add_argument(
        "--skip-atom",
        action="store_true",
        help="Skip the annual Atom feed reachability probe.",
    )
    return parser.parse_args()


def http_get(url: str, timeout_seconds: int) -> tuple[bytes, dict[str, str]]:
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Accept": "text/html,text/csv,application/xml,text/xml,*/*",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        headers = {key.lower(): value for key, value in resp.headers.items()}
        return resp.read(), headers


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_") or "value"


def date_needles(day: str) -> list[str]:
    parsed = dt.date.fromisoformat(day)
    return [
        parsed.isoformat(),
        parsed.strftime("%d/%m/%Y"),
        parsed.strftime("%d-%m-%Y"),
        parsed.strftime("%Y/%m/%d"),
    ]


def extract_hrefs(html_text: str) -> list[str]:
    hrefs: list[str] = []
    for match in re.finditer(r"""href\s*=\s*["']([^"']+)["']""", html_text, re.I):
        hrefs.append(html.unescape(match.group(1)))
    return hrefs


def resolve_url(href: str, current_url: str) -> str:
    return urllib.parse.urljoin(current_url, href)


def candidate_csv_urls(html_text: str, page_url: str, year: int) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for href in extract_hrefs(html_text):
        url = resolve_url(href, page_url)
        lowered = url.lower()
        if "csv" not in lowered:
            continue
        if str(year) not in lowered:
            continue
        if url in seen:
            continue
        seen.add(url)
        urls.append(url)
    return urls


def find_matching_lines(text: str, needles: list[str], limit: int = 8) -> list[str]:
    matches: list[str] = []
    for line in text.splitlines():
        if any(needle in line for needle in needles):
            matches.append(line[:500])
            if len(matches) >= limit:
                break
    return matches


def probe_flat_files_site(
    *,
    site_id: str,
    year: int,
    day: str,
    out_dir: Path,
    csv_limit: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    page_url = f"{FLAT_FILES_URL}?site_id={urllib.parse.quote(site_id)}"
    site_out_dir = out_dir / safe_name(site_id)
    site_out_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "site_id": site_id,
        "page_url": page_url,
        "status": "unknown",
        "candidate_csv_count": 0,
        "downloaded_csv_count": 0,
        "target_day_found": False,
        "csv_results": [],
    }

    try:
        page_bytes, page_headers = http_get(page_url, timeout_seconds)
    except Exception as exc:
        result["status"] = "flat_files_page_error"
        result["error"] = describe_exception(exc)
        return result

    html_path = site_out_dir / f"{safe_name(site_id)}_flat_files.html"
    html_path.write_bytes(page_bytes)
    result["page_path"] = str(html_path)
    result["page_content_type"] = page_headers.get("content-type")

    page_text = page_bytes.decode("utf-8", errors="replace")
    urls = candidate_csv_urls(page_text, page_url, year)
    result["candidate_csv_count"] = len(urls)
    result["candidate_csv_urls"] = urls[:20]

    if not urls:
        result["status"] = "no_candidate_csv_urls"
        return result

    needles = date_needles(day)
    for index, csv_url in enumerate(urls[: max(csv_limit, 0)]):
        csv_result: dict[str, Any] = {
            "url": csv_url,
            "target_day_found": False,
            "matching_lines": [],
        }
        try:
            csv_bytes, csv_headers = http_get(csv_url, timeout_seconds)
        except Exception as exc:
            csv_result["status"] = "csv_download_error"
            csv_result["error"] = describe_exception(exc)
            result["csv_results"].append(csv_result)
            continue

        suffix = ".csv"
        parsed_path = urllib.parse.urlparse(csv_url).path
        parsed_name = Path(parsed_path).name
        if parsed_name:
            suffix = "".join(Path(parsed_name).suffixes) or suffix
        csv_path = site_out_dir / f"{safe_name(site_id)}_{year}_{index:02d}{suffix}"
        csv_path.write_bytes(csv_bytes)

        csv_text = csv_bytes.decode("utf-8", errors="replace")
        matching_lines = find_matching_lines(csv_text, needles)
        csv_result.update(
            {
                "status": "ok",
                "path": str(csv_path),
                "content_type": csv_headers.get("content-type"),
                "byte_count": len(csv_bytes),
                "line_count": csv_text.count("\n") + (1 if csv_text else 0),
                "target_day_found": bool(matching_lines),
                "matching_lines": matching_lines,
            }
        )
        result["downloaded_csv_count"] += 1
        if matching_lines:
            result["target_day_found"] = True
        result["csv_results"].append(csv_result)

    result["status"] = "ok"
    return result


def probe_atom(year: int, out_dir: Path, timeout_seconds: int) -> dict[str, Any]:
    url = ATOM_AUTO_URL_TEMPLATE.format(year=year)
    result: dict[str, Any] = {
        "url": url,
        "status": "unknown",
    }
    try:
        atom_bytes, atom_headers = http_get(url, timeout_seconds)
    except Exception as exc:
        result["status"] = "atom_error"
        result["error"] = describe_exception(exc)
        return result

    atom_path = out_dir / f"uk_air_auto_{year}.atom.xml"
    atom_path.write_bytes(atom_bytes)
    atom_text = atom_bytes.decode("utf-8", errors="replace")
    hrefs = extract_hrefs(atom_text)
    result.update(
        {
            "status": "ok",
            "path": str(atom_path),
            "content_type": atom_headers.get("content-type"),
            "byte_count": len(atom_bytes),
            "href_count": len(hrefs),
            "hrefs_sample": hrefs[:20],
        }
    )
    return result


def describe_exception(exc: Exception) -> dict[str, Any]:
    info: dict[str, Any] = {
        "type": type(exc).__name__,
        "message": str(exc),
    }
    if isinstance(exc, urllib.error.HTTPError):
        info["status_code"] = exc.code
        info["reason"] = exc.reason
    return info


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "probe": "uk_air_aurn_historical_routes",
        "year": args.year,
        "day": args.day,
        "out_dir": str(out_dir),
        "flat_files": [],
    }

    for site_id in args.site_ids:
        summary["flat_files"].append(
            probe_flat_files_site(
                site_id=site_id.strip(),
                year=args.year,
                day=args.day,
                out_dir=out_dir,
                csv_limit=args.csv_limit,
                timeout_seconds=args.timeout_seconds,
            )
        )

    if not args.skip_atom:
        summary["atom"] = probe_atom(args.year, out_dir, args.timeout_seconds)

    print(json.dumps(summary, indent=2, sort_keys=True))

    any_day_found = any(
        bool(site.get("target_day_found")) for site in summary["flat_files"]
    )
    return 0 if any_day_found else 2


if __name__ == "__main__":
    sys.exit(main())
