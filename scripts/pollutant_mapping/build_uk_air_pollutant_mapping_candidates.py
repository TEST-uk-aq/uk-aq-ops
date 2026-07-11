#!/usr/bin/env python3
"""
Scan cached UK-AIR annual CSV files, extract distinct pollutant headings, and
create a CSV of candidate rows for uk_aq_core.observed_property_mappings.

The script only fills observed_property_code when it can make a conservative
match. Unmatched headings are left blank for manual completion.

Default source root:
  /Users/mikehinford/uk-aq-history-integrity/state/CIC-Test/source-cache/sos

Expected layout:
  site_ref=<SITE_REF>/year=<YYYY>/<SITE_REF>_<YYYY>.csv
or any nested CSV files beneath the root.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable


DEFAULT_ROOT = Path(
    "/Users/mikehinford/uk-aq-history-integrity/state/"
    "CIC-Test/source-cache/sos"
)

# Conservative mappings to known UK AQ observed_property_code values.
# Add or edit aliases here after checking uk_aq_core.observed_properties.
EXACT_ALIASES: dict[str, str] = {
    "nitric oxide": "no",
    "nitrogen dioxide": "no2",
    "nitrogen oxides as nitrogen dioxide": "nox_as_no2",
    "ozone": "o3",
    "sulphur dioxide": "so2",
    "sulfur dioxide": "so2",
    "carbon monoxide": "co",
    "pm10 particulate matter hourly measured": "pm10",
    "pm2 5 particulate matter hourly measured": "pm25",
    "benzene": "c6h6",
    "toluene": "c6h5ch3",
    "1 3 butadiene": "ch2chchch2",
    "ethane": "c2h6",
    "ethene": "h2cch2",
    "ethylbenzene": "c6h5c2h5",
    "ethyne": "hcch",
    "n heptane": "c7h16",
    "n hexane": "c6h14",
    "n octane": "c8h18",
    "propane": "h3cch2ch3",
    "propene": "ch2chch3",
    "1 2 4 trimethylbenzene": "124c6h3ch33",
    "1 2 3 trimethylbenzene": "123c6h3ch33",
    "1 3 5 trimethylbenzene": "135c6h3ch33",
    "m p xylene": "mpc6h4ch32",
    "o xylene": "oc6h4ch32",
}

AQI_ELIGIBLE_CODES = {"pm25", "pm10", "no2"}

# Headings intentionally ignored by the current UK AQ mapping model.
IGNORED_ALIASES = {
    "volatile pm10",
    "non volatile pm10",
    "volatile pm2 5",
    "non volatile pm2 5",
}


def normalise_label(value: str) -> str:
    """Normalise only for candidate matching, never for the stored source_label."""
    value = html.unescape(value or "")
    value = re.sub(r"<\s*/?\s*sub\s*>", "", value, flags=re.IGNORECASE)
    value = value.replace("&nbsp;", " ")
    value = value.casefold()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalise_uom(value: str) -> str:
    value = (value or "").strip()
    aliases = {
        "ugm-3": "ug/m3",
        "µgm-3": "ug/m3",
        "μgm-3": "ug/m3",
        "mgm-3": "mg/m3",
    }
    return aliases.get(value.casefold(), value)


def parse_args() -> argparse.Namespace:
    timestamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    parser = argparse.ArgumentParser(
        description=(
            "Extract UK-AIR CSV pollutant headings and create candidate "
            "observed_property_mappings rows."
        )
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help=f"Root containing cached CSV files. Default: {DEFAULT_ROOT}",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(f"uk_air_pollutant_mapping_candidates_{timestamp}.csv"),
        help="Output CSV path.",
    )
    parser.add_argument(
        "--connector-id",
        type=int,
        default=1,
        help="Connector id written to output. Default: 1",
    )
    parser.add_argument(
        "--observed-properties-csv",
        type=Path,
        help=(
            "Optional reference CSV exported from uk_aq_core.observed_properties. "
            "Expected columns include code and one or more of label, notation, name."
        ),
    )
    return parser.parse_args()


def find_header_index(rows: list[list[str]]) -> int | None:
    for index, row in enumerate(rows[:30]):
        if len(row) < 2:
            continue
        if row[0].strip().casefold() == "date" and row[1].strip().casefold() == "time":
            return index
    return None


def iter_pollutant_triplets(header: list[str]) -> Iterable[tuple[int, str]]:
    """
    UK-AIR files use repeating triplets:
      pollutant value, status, unit
    beginning after Date and Time.
    """
    for value_index in range(2, len(header), 3):
        source_label = header[value_index].strip()
        if source_label:
            yield value_index, source_label


def load_reference_aliases(path: Path | None) -> dict[str, set[str]]:
    """
    Return normalised alias -> possible observed_property_code values.

    Ambiguous aliases remain as multiple codes and are not auto-selected.
    """
    aliases: dict[str, set[str]] = defaultdict(set)
    if path is None:
        return aliases
    if not path.is_file():
        raise FileNotFoundError(f"Observed properties CSV not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "code" not in reader.fieldnames:
            raise ValueError("--observed-properties-csv must contain a 'code' column")

        candidate_columns = [
            column
            for column in ("code", "label", "notation", "name", "display_name", "description")
            if column in reader.fieldnames
        ]
        for row in reader:
            code = (row.get("code") or "").strip()
            if not code:
                continue
            for column in candidate_columns:
                alias = normalise_label(row.get(column) or "")
                if alias:
                    aliases[alias].add(code)
    return aliases


def choose_code(
    source_label: str,
    reference_aliases: dict[str, set[str]],
) -> tuple[str, str]:
    normalised = normalise_label(source_label)

    if normalised in IGNORED_ALIASES:
        return "", "built_in_ignored"

    built_in = EXACT_ALIASES.get(normalised)
    if built_in:
        return built_in, "built_in_exact"

    reference_codes = reference_aliases.get(normalised, set())
    if len(reference_codes) == 1:
        return next(iter(reference_codes)), "observed_properties_exact"
    if len(reference_codes) > 1:
        return "", "ambiguous_reference_match"

    return "", "unmatched"


def read_csv_file(
    path: Path,
    aggregate: dict[str, dict[str, object]],
) -> None:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        rows = list(csv.reader(handle))

    header_index = find_header_index(rows)
    if header_index is None:
        return

    header = rows[header_index]
    site_match = re.search(r"site_ref=([^/]+)", str(path))
    site_ref = site_match.group(1) if site_match else ""

    for value_index, source_label in iter_pollutant_triplets(header):
        item = aggregate.setdefault(
            source_label,
            {
                "files": set(),
                "sites": set(),
                "units": Counter(),
                "nonempty_values": 0,
                "sample_file": str(path),
            },
        )
        item["files"].add(str(path))
        if site_ref:
            item["sites"].add(site_ref)

        for row in rows[header_index + 1 :]:
            if not row or value_index >= len(row):
                continue

            value = row[value_index].strip()
            unit = row[value_index + 2].strip() if value_index + 2 < len(row) else ""

            if value:
                item["nonempty_values"] += 1
            if unit:
                item["units"][unit] += 1


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    out = args.out.expanduser()

    if not root.is_dir():
        print(f"Source root does not exist: {root}", file=sys.stderr)
        return 2

    csv_files = sorted(root.glob("site_ref=*/*.csv"))
    if not csv_files:
        csv_files = sorted(root.rglob("*.csv"))

    if not csv_files:
        print(f"No CSV files found beneath: {root}", file=sys.stderr)
        return 2

    try:
        reference_aliases = load_reference_aliases(args.observed_properties_csv)
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    aggregate: dict[str, dict[str, object]] = {}
    unreadable = 0

    for path in csv_files:
        try:
            read_csv_file(path, aggregate)
        except (OSError, csv.Error) as exc:
            unreadable += 1
            print(f"Warning: could not read {path}: {exc}", file=sys.stderr)

    out.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "connector_id",
        "source_label",
        "notation",
        "pollutant_label",
        "source_uom",
        "observed_property_code",
        "mapping_kind",
        "is_aqi_eligible",
        "is_active",
        "confidence",
        "notes",
        "match_method",
        "detected_units",
        "site_count",
        "file_count",
        "nonempty_value_count",
        "sample_file",
    ]

    output_rows: list[dict[str, object]] = []
    matched = 0
    ignored = 0

    for source_label in sorted(aggregate, key=lambda value: value.casefold()):
        item = aggregate[source_label]
        code, match_method = choose_code(source_label, reference_aliases)
        units: Counter[str] = item["units"]

        if match_method == "built_in_ignored":
            mapping_kind = "ignored"
            ignored += 1
        else:
            mapping_kind = "raw_observed_property"
            if code:
                matched += 1

        unique_units = sorted(units)
        suggested_uom = normalise_uom(unique_units[0]) if len(unique_units) == 1 else ""

        output_rows.append(
            {
                "connector_id": args.connector_id,
                "source_label": source_label,
                "notation": "",
                "pollutant_label": source_label,
                "source_uom": suggested_uom,
                "observed_property_code": code,
                "mapping_kind": mapping_kind,
                "is_aqi_eligible": "true" if code in AQI_ELIGIBLE_CODES else "false",
                "is_active": "true",
                "confidence": "explicit" if code else "inferred",
                "notes": (
                    "Generated from cached UK-AIR annual CSV headings; "
                    "review before loading."
                ),
                "match_method": match_method,
                "detected_units": "; ".join(
                    f"{unit} ({count})" for unit, count in units.most_common()
                ),
                "site_count": len(item["sites"]),
                "file_count": len(item["files"]),
                "nonempty_value_count": item["nonempty_values"],
                "sample_file": item["sample_file"],
            }
        )

    with out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(output_rows)

    unmatched = len(output_rows) - matched - ignored
    print(f"CSV files scanned: {len(csv_files)}")
    print(f"Unreadable files: {unreadable}")
    print(f"Distinct source labels: {len(output_rows)}")
    print(f"Matched canonical codes: {matched}")
    print(f"Marked ignored: {ignored}")
    print(f"Unmatched/ambiguous: {unmatched}")
    print(f"Output: {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
