#!/usr/bin/env python3
"""Create Breathe London identity timeline reports from local Dropbox R2 v2 core snapshots.

The script is read-only. It reconstructs site-level device identity from successive
v2 core snapshots and writes one .xlsx workbook per requested Breathe London site.

Stable logical identity: connector_id + station_ref (SiteCode).
Changing physical identity: station_device_ref (DeviceCode).

Examples:
  python scripts/blondon_identity_timeline.py --site-ref BL0005 --connector nodes
  python scripts/blondon_identity_timeline.py --site-ref CLDP0013 --connector communities
  python scripts/blondon_identity_timeline.py --site-ref BL0062
  python scripts/blondon_identity_timeline.py --input-csv sites.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sys
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence
from xml.sax.saxutils import escape

CORE_PREFIX = Path("history/v2/core")
TARGET_CONNECTOR_IDS = (2, 3)
TARGET_POLLUTANTS = ("pm25", "no2")
EXCEL_MIN_DATE = date(1900, 1, 1)

CONNECTOR_LABELS = {2: "Breathe London Nodes", 3: "Breathe London Communities"}
CONNECTOR_CODES = {2: "blondon_nodes", 3: "blondon_communities"}
CONNECTOR_ALIASES = {
    "2": 2,
    "nodes": 2,
    "node": 2,
    "blondon_nodes": 2,
    "breathe london nodes": 2,
    "3": 3,
    "communities": 3,
    "community": 3,
    "blondon_communities": 3,
    "breathe london communities": 3,
}

TIMELINE_HEADERS = (
    "Date",
    "Network",
    "site_ref",
    "device_ref",
    "PM2.5 timeseries_ref",
    "NO2 timeseries_ref",
)


@dataclass(frozen=True)
class Selector:
    site_ref: str
    connector_id: int | None = None
    source_label: str = "command line"


@dataclass(frozen=True)
class SnapshotState:
    snapshot_day: date
    connector_id: int
    station_id: int
    site_ref: str
    device_ref: str
    first_seen: date | None
    removed_at: date | None


@dataclass
class DeviceInterval:
    connector_id: int
    station_id: int
    site_ref: str
    device_ref: str
    valid_from: date
    valid_to: date | None

    def covers(self, day: date) -> bool:
        return self.valid_from <= day and (self.valid_to is None or day <= self.valid_to)


def clean_text(value: object) -> str:
    return "" if value is None else str(value).strip()


def parse_connector(value: object, label: str = "connector") -> int | None:
    text = clean_text(value).lower()
    if not text:
        return None
    connector_id = CONNECTOR_ALIASES.get(text)
    if connector_id is None:
        allowed = "nodes, communities, 2, 3, blondon_nodes, blondon_communities"
        raise RuntimeError(f"Invalid {label} {value!r}; expected one of: {allowed}")
    return connector_id


def parse_optional_day(raw: object, label: str) -> date | None:
    text = clean_text(raw)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise RuntimeError(f"{label} must be YYYY-MM-DD: {text!r}") from exc


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create Breathe London device-identity timeline .xlsx reports from Dropbox R2 v2 core snapshots."
    )
    parser.add_argument("--site-ref", "--site_ref", dest="site_ref", default="", help="Breathe London SiteCode/station_ref")
    parser.add_argument(
        "--connector",
        default="",
        help="Optional connector: nodes, communities, 2, 3, blondon_nodes, or blondon_communities",
    )
    parser.add_argument("--input-csv", "--input_csv", dest="input_csv", default="", help="CSV with site_ref and optional connector")
    parser.add_argument("--root", default="", help="Local R2_history_backup root; overrides environment-derived Dropbox root")
    parser.add_argument("--output-dir", "--output_dir", dest="output_dir", default=".", help="Directory for generated .xlsx files")
    parser.add_argument("--from-day", "--from_day", dest="from_day", default="", help="Optional inclusive report start YYYY-MM-DD")
    parser.add_argument("--to-day", "--to_day", dest="to_day", default="", help="Optional inclusive report end YYYY-MM-DD")
    args = parser.parse_args(argv)

    direct = bool(clean_text(args.site_ref))
    csv_mode = bool(clean_text(args.input_csv))
    if direct and csv_mode:
        parser.error("Use --site-ref or --input-csv, not both.")
    if not direct and not csv_mode:
        parser.error("Provide --site-ref or --input-csv.")
    try:
        args.connector_id = parse_connector(args.connector, "--connector")
        args.from_day = parse_optional_day(args.from_day, "--from-day")
        args.to_day = parse_optional_day(args.to_day, "--to-day")
    except RuntimeError as exc:
        parser.error(str(exc))
    if args.from_day and args.to_day and args.from_day > args.to_day:
        parser.error("--from-day must be <= --to-day.")
    return args


def resolve_backup_root(override: str) -> Path:
    if clean_text(override):
        return Path(override).expanduser().resolve()
    explicit = clean_text(os.getenv("UK_AQ_R2_HISTORY_DROPBOX_ROOT"))
    if explicit:
        return Path(explicit).expanduser().resolve()
    dropbox_root = clean_text(os.getenv("UK_AQ_DROPBOX_ROOT")) or "CIC-Test"
    history_dir = clean_text(os.getenv("UK_AQ_R2_HISTORY_DROPBOX_DIR")) or "R2_history_backup"
    candidate = Path(dropbox_root).expanduser()
    if candidate.is_absolute():
        if candidate.name in {history_dir, "R2_history_backup"}:
            return candidate.resolve()
        return (candidate / history_dir).resolve()
    return (
        Path.home()
        / "Dropbox"
        / "Apps"
        / "github-uk-air-quality-networks"
        / dropbox_root
        / history_dir
    ).resolve()


def read_manifest(snapshot_dir: Path) -> Mapping[str, object] | None:
    path = snapshot_dir / "manifest.json"
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def table_path(snapshot_dir: Path, manifest: Mapping[str, object], table_name: str) -> Path | None:
    tables = manifest.get("tables")
    if not isinstance(tables, list):
        return None
    for entry in tables:
        if not isinstance(entry, dict) or entry.get("table") != table_name:
            continue
        relative = clean_text(entry.get("relative_path")) or f"table={table_name}/rows.ndjson.gz"
        path = snapshot_dir / relative
        return path if path.is_file() else None
    return None


def discover_core_snapshots(root: Path) -> list[tuple[date, Path, Mapping[str, object]]]:
    core_root = root / CORE_PREFIX
    if not core_root.is_dir():
        raise RuntimeError(f"v2 core directory not found: {core_root}")
    snapshots: list[tuple[date, Path, Mapping[str, object]]] = []
    for child in core_root.iterdir():
        if not child.is_dir() or not child.name.startswith("day_utc="):
            continue
        try:
            day = date.fromisoformat(child.name.split("=", 1)[1])
        except ValueError:
            continue
        manifest = read_manifest(child)
        if manifest and table_path(child, manifest, "stations") is not None:
            snapshots.append((day, child, manifest))
    snapshots.sort(key=lambda item: item[0])
    if not snapshots:
        raise RuntimeError(f"No usable v2 core snapshots containing stations were found under {core_root}")
    return snapshots


def iter_ndjson_gz(path: Path) -> Iterable[dict[str, object]]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid NDJSON at {path}:{line_number}: {exc}") from exc
            if not isinstance(row, dict):
                raise RuntimeError(f"Expected JSON object at {path}:{line_number}")
            yield row


def read_selectors(args: argparse.Namespace) -> list[Selector]:
    if args.input_csv:
        path = Path(args.input_csv).expanduser()
        if not path.is_file():
            raise RuntimeError(f"Input CSV not found: {path}")
        selectors: list[Selector] = []
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise RuntimeError(f"Input CSV has no header row: {path}")
            canonical = {clean_text(name).lower(): name for name in reader.fieldnames if name is not None}
            site_key = canonical.get("site_ref")
            connector_key = canonical.get("connector") or canonical.get("connector_id") or canonical.get("connector_code")
            if not site_key:
                raise RuntimeError("Input CSV must contain a site_ref column.")
            for row_number, row in enumerate(reader, start=2):
                site_ref = clean_text(row.get(site_key))
                if not site_ref:
                    raise RuntimeError(f"Input CSV row {row_number} has no site_ref.")
                connector_id = parse_connector(row.get(connector_key), f"{path}:row {row_number} connector") if connector_key else None
                selectors.append(Selector(site_ref=site_ref, connector_id=connector_id, source_label=f"{path}:row {row_number}"))
        if not selectors:
            raise RuntimeError(f"Input CSV contains no data rows: {path}")
        return selectors
    return [Selector(site_ref=clean_text(args.site_ref), connector_id=args.connector_id)]


def latest_station_matches(
    latest_snapshot: tuple[date, Path, Mapping[str, object]], site_refs: set[str]
) -> dict[str, list[dict[str, object]]]:
    _day, snapshot_dir, manifest = latest_snapshot
    stations_path = table_path(snapshot_dir, manifest, "stations")
    if stations_path is None:
        raise RuntimeError("Latest selected core snapshot has no stations table.")
    wanted = {value.upper() for value in site_refs}
    result: dict[str, list[dict[str, object]]] = {value.upper(): [] for value in site_refs}
    for row in iter_ndjson_gz(stations_path):
        connector_id = int(row.get("connector_id") or 0)
        if connector_id not in TARGET_CONNECTOR_IDS:
            continue
        station_ref = clean_text(row.get("station_ref"))
        key = station_ref.upper()
        if key in wanted:
            result[key].append(row)
    return result


def resolve_selectors(
    selectors: Sequence[Selector], latest_snapshot: tuple[date, Path, Mapping[str, object]]
) -> list[Selector]:
    matches = latest_station_matches(latest_snapshot, {item.site_ref for item in selectors})
    resolved: list[Selector] = []
    seen: set[tuple[int, str]] = set()
    for selector in selectors:
        candidates = matches.get(selector.site_ref.upper(), [])
        if selector.connector_id is not None:
            candidates = [row for row in candidates if int(row.get("connector_id") or 0) == selector.connector_id]
        if not candidates:
            qualifier = f" connector={CONNECTOR_CODES[selector.connector_id]}" if selector.connector_id else ""
            raise RuntimeError(f"No Breathe London station found for site_ref={selector.site_ref}{qualifier} ({selector.source_label}).")
        connector_ids = sorted({int(row.get("connector_id") or 0) for row in candidates})
        if selector.connector_id is None and len(connector_ids) != 1:
            labels = ", ".join(CONNECTOR_CODES.get(value, str(value)) for value in connector_ids)
            raise RuntimeError(
                f"site_ref={selector.site_ref} exists under multiple Breathe London connectors ({labels}); "
                "supply --connector or a connector column in the CSV."
            )
        connector_id = selector.connector_id or connector_ids[0]
        key = (connector_id, selector.site_ref.upper())
        if key in seen:
            continue
        seen.add(key)
        resolved.append(Selector(selector.site_ref, connector_id, selector.source_label))
    return resolved


def row_day(value: object) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def scan_station_history(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]], selectors: Sequence[Selector]
) -> dict[tuple[int, str], list[SnapshotState]]:
    wanted = {(int(item.connector_id), item.site_ref.upper()) for item in selectors if item.connector_id is not None}
    history: dict[tuple[int, str], list[SnapshotState]] = {key: [] for key in wanted}
    last_fingerprint: dict[tuple[int, str], tuple[object, ...]] = {}
    for snapshot_day, snapshot_dir, manifest in snapshots:
        path = table_path(snapshot_dir, manifest, "stations")
        if path is None:
            continue
        found_this_snapshot: set[tuple[int, str]] = set()
        for row in iter_ndjson_gz(path):
            connector_id = int(row.get("connector_id") or 0)
            station_ref = clean_text(row.get("station_ref"))
            key = (connector_id, station_ref.upper())
            if key not in wanted:
                continue
            if key in found_this_snapshot:
                raise RuntimeError(
                    f"Duplicate station rows for connector_id={connector_id} site_ref={station_ref} "
                    f"in core snapshot {snapshot_day}."
                )
            found_this_snapshot.add(key)
            state = SnapshotState(
                snapshot_day=snapshot_day,
                connector_id=connector_id,
                station_id=int(row.get("id")),
                site_ref=station_ref,
                device_ref=clean_text(row.get("station_device_ref")),
                first_seen=row_day(row.get("first_seen_at")),
                removed_at=row_day(row.get("removed_at")),
            )
            fingerprint = (state.station_id, state.device_ref, state.first_seen, state.removed_at)
            if last_fingerprint.get(key) != fingerprint:
                history[key].append(state)
                last_fingerprint[key] = fingerprint
    return history


def build_device_intervals(states: Sequence[SnapshotState]) -> list[DeviceInterval]:
    if not states:
        return []
    intervals: list[DeviceInterval] = []
    current: DeviceInterval | None = None
    for state in states:
        proposed_start = state.first_seen or state.snapshot_day
        if proposed_start < EXCEL_MIN_DATE:
            proposed_start = state.snapshot_day
        same_identity = current is not None and current.station_id == state.station_id and current.device_ref == state.device_ref
        if same_identity:
            if state.removed_at is not None:
                current.valid_to = state.removed_at
            continue
        if current is not None:
            inferred_end = proposed_start - timedelta(days=1)
            if current.valid_to is None or inferred_end < current.valid_to:
                current.valid_to = inferred_end
        current = DeviceInterval(
            connector_id=state.connector_id,
            station_id=state.station_id,
            site_ref=state.site_ref,
            device_ref=state.device_ref,
            valid_from=proposed_start,
            valid_to=state.removed_at,
        )
        intervals.append(current)
    for previous, following in zip(intervals, intervals[1:]):
        if following.valid_from <= previous.valid_from:
            raise RuntimeError(
                f"Non-increasing Breathe London device history for {following.site_ref}: "
                f"{previous.valid_from} then {following.valid_from}."
            )
        if previous.valid_to is None or previous.valid_to >= following.valid_from:
            previous.valid_to = following.valid_from - timedelta(days=1)
    return intervals


def load_latest_timeseries_refs(
    latest_snapshot: tuple[date, Path, Mapping[str, object]], selectors: Sequence[Selector]
) -> tuple[dict[tuple[int, str], int], dict[tuple[int, str], dict[str, str]]]:
    _day, snapshot_dir, manifest = latest_snapshot
    stations_path = table_path(snapshot_dir, manifest, "stations")
    timeseries_path = table_path(snapshot_dir, manifest, "timeseries")
    props_path = table_path(snapshot_dir, manifest, "observed_properties")
    if stations_path is None or timeseries_path is None or props_path is None:
        raise RuntimeError("Latest core snapshot must contain stations, timeseries and observed_properties.")
    wanted = {(int(item.connector_id), item.site_ref.upper()) for item in selectors if item.connector_id is not None}
    station_ids: dict[tuple[int, str], int] = {}
    for row in iter_ndjson_gz(stations_path):
        key = (int(row.get("connector_id") or 0), clean_text(row.get("station_ref")).upper())
        if key in wanted:
            station_ids[key] = int(row.get("id"))
    prop_codes: dict[int, str] = {}
    for row in iter_ndjson_gz(props_path):
        try:
            prop_codes[int(row.get("id"))] = clean_text(row.get("code")).lower()
        except (TypeError, ValueError):
            continue
    id_to_key = {station_id: key for key, station_id in station_ids.items()}
    refs: dict[tuple[int, str], dict[str, str]] = {key: {} for key in wanted}
    counts: dict[tuple[int, str, str], int] = {}
    for row in iter_ndjson_gz(timeseries_path):
        try:
            station_id = int(row.get("station_id"))
            prop_id = int(row.get("observed_property_id"))
        except (TypeError, ValueError):
            continue
        key = id_to_key.get(station_id)
        if key is None:
            continue
        code = prop_codes.get(prop_id, "")
        if code not in TARGET_POLLUTANTS:
            continue
        count_key = (key[0], key[1], code)
        counts[count_key] = counts.get(count_key, 0) + 1
        refs[key][code] = clean_text(row.get("timeseries_ref"))
    duplicates = [item for item, count in counts.items() if count != 1]
    if duplicates:
        details = ", ".join(f"{connector}:{site}:{code}" for connector, site, code in duplicates)
        raise RuntimeError(f"Expected one PM2.5/NO2 timeseries per Breathe London site; ambiguous groups: {details}")
    return station_ids, refs


def choose_range(
    intervals: Sequence[DeviceInterval], latest_snapshot: date, from_day: date | None, to_day: date | None
) -> tuple[date, date]:
    if not intervals:
        raise RuntimeError("No Breathe London device intervals were found.")
    start = from_day or min(item.valid_from for item in intervals)
    if to_day:
        if to_day > latest_snapshot:
            raise RuntimeError(f"--to-day {to_day} is after latest core snapshot {latest_snapshot}.")
        end = to_day
    else:
        end = latest_snapshot if intervals[-1].valid_to is None else max(
            item.valid_to for item in intervals if item.valid_to is not None
        )
    if start < EXCEL_MIN_DATE:
        raise RuntimeError("Report start is before Excel's supported date range.")
    if start > end:
        raise RuntimeError(f"Report start {start} is after report end {end}.")
    return start, end


def month_firsts(start: date, end: date) -> Iterable[date]:
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        if cursor >= start:
            yield cursor
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)


def build_display_days(intervals: Sequence[DeviceInterval], start: date, end: date) -> list[date]:
    days = set(month_firsts(start, end))
    days.update((start, end))
    for item in intervals:
        if start <= item.valid_from <= end:
            days.add(item.valid_from)
        if item.valid_to is not None and start <= item.valid_to <= end:
            days.add(item.valid_to)
    return sorted(days)


def interval_for_day(intervals: Sequence[DeviceInterval], day: date) -> DeviceInterval | None:
    matches = [item for item in intervals if item.covers(day)]
    if len(matches) > 1:
        raise RuntimeError(f"Overlapping Breathe London device intervals on {day}.")
    return matches[0] if matches else None


def build_timeline_rows(
    connector_id: int,
    site_ref: str,
    intervals: Sequence[DeviceInterval],
    days: Sequence[date],
    timeseries_refs: Mapping[str, str],
) -> list[list[object]]:
    rows: list[list[object]] = []
    for day in days:
        interval = interval_for_day(intervals, day)
        rows.append([
            day,
            CONNECTOR_LABELS[connector_id],
            site_ref,
            interval.device_ref if interval else "",
            timeseries_refs.get("pm25", ""),
            timeseries_refs.get("no2", ""),
        ])
    return rows


def sanitise_filename(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", clean_text(value))
    return text.strip("._-") or "unknown"


def excel_serial(day: date) -> int:
    return (day - date(1899, 12, 30)).days


def cell_ref(row: int, col: int) -> str:
    letters = ""
    n = col
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return f"{letters}{row}"


def inline_cell(row: int, col: int, value: object, style: int = 0) -> str:
    ref = cell_ref(row, col)
    text = "" if value is None else str(value)
    preserve = ' xml:space="preserve"' if text != text.strip() else ""
    style_attr = f' s="{style}"' if style else ""
    return f'<c r="{ref}" t="inlineStr"{style_attr}><is><t{preserve}>{escape(text)}</t></is></c>'


def number_cell(row: int, col: int, value: int, style: int = 0) -> str:
    style_attr = f' s="{style}"' if style else ""
    return f'<c r="{cell_ref(row, col)}" t="n"{style_attr}><v>{value}</v></c>'


def build_timeline_sheet(rows: Sequence[Sequence[object]]) -> str:
    widths = (13, 30, 16, 18, 24, 24)
    cols = "".join(
        f'<col min="{idx}" max="{idx}" width="{width}" customWidth="1"/>'
        for idx, width in enumerate(widths, start=1)
    )
    xml_rows = [
        '<row r="1" ht="22" customHeight="1">'
        + "".join(inline_cell(1, idx, name, style=1) for idx, name in enumerate(TIMELINE_HEADERS, start=1))
        + '</row>'
    ]
    previous: Sequence[object] | None = None
    for row_number, values in enumerate(rows, start=2):
        cells = [number_cell(row_number, 1, excel_serial(values[0]), style=2)]
        for col in range(2, len(TIMELINE_HEADERS) + 1):
            value = values[col - 1]
            changed = previous is not None and value != previous[col - 1]
            cells.append(inline_cell(row_number, col, value, style=3 if changed else 0))
        xml_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
        previous = values
    last = max(1, len(rows) + 1)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:F{last}"/>'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f'<cols>{cols}</cols><sheetData>{"".join(xml_rows)}</sheetData>'
        f'<autoFilter ref="A1:F{last}"/>'
        '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '</worksheet>'
    )


def build_info_sheet(info: Sequence[tuple[str, str]]) -> str:
    rows = [
        '<row r="1" ht="24" customHeight="1">'
        + inline_cell(1, 1, "Breathe London Identity Timeline Report", style=1)
        + '</row>'
    ]
    for idx, (label, value) in enumerate(info, start=3):
        rows.append(
            f'<row r="{idx}">'
            + inline_cell(idx, 1, label, style=4)
            + inline_cell(idx, 2, value)
            + '</row>'
        )
    last = max(3, len(info) + 2)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:B{last}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        '<cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="2" width="90" customWidth="1"/></cols>'
        f'<sheetData>{"".join(rows)}</sheetData>'
        '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '</worksheet>'
    )


def styles_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E1F2"/></left><right style="thin"><color rgb="FFD9E1F2"/></right><top style="thin"><color rgb="FFD9E1F2"/></top><bottom style="thin"><color rgb="FFD9E1F2"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>'''


def write_xlsx(path: Path, rows: Sequence[Sequence[object]], info: Sequence[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''
    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''
    workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Timeline" sheetId="1" r:id="rId1"/><sheet name="Report Info" sheetId="2" r:id="rId2"/></sheets>
</workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''
    core_props = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>UK AQ Breathe London identity timeline</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{generated}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{generated}</dcterms:modified>
</cp:coreProperties>'''
    app_props = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>UK AQ</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Timeline</vt:lpstr><vt:lpstr>Report Info</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>'''
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("docProps/core.xml", core_props)
        archive.writestr("docProps/app.xml", app_props)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/styles.xml", styles_xml())
        archive.writestr("xl/worksheets/sheet1.xml", build_timeline_sheet(rows))
        archive.writestr("xl/worksheets/sheet2.xml", build_info_sheet(info))


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = resolve_backup_root(args.root)
    snapshots = discover_core_snapshots(root)
    selectors = resolve_selectors(read_selectors(args), snapshots[-1])
    history = scan_station_history(snapshots, selectors)
    station_ids, timeseries_refs = load_latest_timeseries_refs(snapshots[-1], selectors)
    output_dir = Path(args.output_dir).expanduser().resolve()
    failures = 0
    for selector in selectors:
        assert selector.connector_id is not None
        key = (selector.connector_id, selector.site_ref.upper())
        try:
            intervals = build_device_intervals(history.get(key, []))
            start, end = choose_range(intervals, snapshots[-1][0], args.from_day, args.to_day)
            days = build_display_days(intervals, start, end)
            refs = timeseries_refs.get(key, {})
            rows = build_timeline_rows(selector.connector_id, selector.site_ref, intervals, days, refs)
            logical_key = f"{selector.connector_id}:{selector.site_ref}"
            info = [
                ("Network", CONNECTOR_LABELS[selector.connector_id]),
                ("Connector code", CONNECTOR_CODES[selector.connector_id]),
                ("Connector ID", str(selector.connector_id)),
                ("Logical site key", logical_key),
                ("site_ref / SiteCode", selector.site_ref),
                ("Current station_id", str(station_ids.get(key, ""))),
                ("PM2.5 timeseries_ref", refs.get("pm25", "")),
                ("NO2 timeseries_ref", refs.get("no2", "")),
                ("Device identities found", str(len(intervals))),
                ("Earliest core snapshot", snapshots[0][0].isoformat()),
                ("Latest core snapshot", snapshots[-1][0].isoformat()),
                ("Report start", start.isoformat()),
                ("Report end", end.isoformat()),
                (
                    "Identity evidence",
                    "Device history is reconstructed from successive Dropbox R2 history/v2/core stations snapshots. "
                    "station_ref is the stable source SiteCode; device_ref is stations.station_device_ref (DeviceCode). "
                    "Changes that occurred entirely before the earliest available core snapshot cannot be reconstructed from Dropbox core snapshots alone.",
                ),
                (
                    "InstallationCode note",
                    "Nodes InstallationCode is source installation metadata, not the stable logical site identity. "
                    "It is not currently exported in the v2 core snapshot, so this Dropbox-only report does not invent it.",
                ),
            ]
            filename = (
                f"BLONDON_{CONNECTOR_CODES[selector.connector_id].replace('blondon_', '').upper()}_"
                f"{sanitise_filename(selector.site_ref)}_identity_timeline.xlsx"
            )
            output_path = output_dir / filename
            write_xlsx(output_path, rows, info)
            print(f"Wrote {output_path} (logical_site_key={logical_key}, device_identities={len(intervals)}, rows={len(rows)})")
        except Exception as exc:
            failures += 1
            print(f"ERROR {CONNECTOR_CODES[selector.connector_id]} site_ref={selector.site_ref}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
