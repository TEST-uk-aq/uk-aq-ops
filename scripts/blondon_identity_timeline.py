#!/usr/bin/env python3
"""Create connector-agnostic Breathe London identity timeline reports from Dropbox R2 v2 core snapshots.

The script is read-only. A requested reference is searched across both Breathe London
connectors and across explicit Nodes source-lineage metadata. Matching source sites are
resolved as one family and written to a single .xlsx workbook.

Authoritative lookup evidence:
  * stations.station_ref for connector 2 (Nodes) and connector 3 (Communities)
  * station_initial_metadata.attributes.SiteCode
  * station_initial_metadata.attributes.InstallationCode
  * source_history[].SiteCode
  * source_history[].InstallationCode
  * future explicit stations.match_id values prefixed blondon_installation:

DeviceCode, station names and coordinates are never used to establish family membership.

Examples:
  python scripts/blondon_identity_timeline.py --site-ref BL0005
  python scripts/blondon_identity_timeline.py --site-ref CLDP0014
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
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence
from xml.sax.saxutils import escape

CORE_PREFIX = Path("history/v2/core")
TARGET_CONNECTOR_IDS = (2, 3)
TARGET_POLLUTANTS = ("pm25", "no2")
EXCEL_MIN_DATE = date(1900, 1, 1)
INSTALLATION_MATCH_PREFIX = "blondon_installation:"

CONNECTOR_LABELS = {2: "Breathe London Nodes", 3: "Breathe London Communities"}
CONNECTOR_CODES = {2: "blondon_nodes", 3: "blondon_communities"}

TIMELINE_HEADERS = (
    "Date",
    "Network",
    "connector_id",
    "site_ref",
    "station_id",
    "device_ref",
    "PM2.5 timeseries_ref",
    "NO2 timeseries_ref",
)

FAMILY_HEADERS = (
    "Network",
    "connector_id",
    "site_ref",
    "station_id",
    "current device_ref",
    "lookup aliases",
    "InstallationCode refs",
    "source-history SiteCode refs",
)


@dataclass(frozen=True)
class Selector:
    site_ref: str
    source_label: str = "command line"


@dataclass(frozen=True)
class StationKey:
    connector_id: int
    site_ref: str

    @property
    def normalised_ref(self) -> str:
        return self.site_ref.upper()


@dataclass(frozen=True)
class StationRecord:
    key: StationKey
    station_id: int
    device_ref: str
    first_seen: date | None
    removed_at: date | None
    match_id: str


@dataclass(frozen=True)
class SnapshotState:
    snapshot_day: date
    key: StationKey
    station_id: int
    device_ref: str
    first_seen: date | None
    removed_at: date | None


@dataclass
class DeviceInterval:
    key: StationKey
    station_id: int
    device_ref: str
    valid_from: date
    valid_to: date | None

    def covers(self, day: date) -> bool:
        return self.valid_from <= day and (self.valid_to is None or day <= self.valid_to)


@dataclass
class FamilyEvidence:
    aliases: set[str]
    installation_refs: set[str]
    source_site_refs: set[str]


def clean_text(value: object) -> str:
    return "" if value is None else str(value).strip()


def normalise_ref(value: object) -> str:
    return clean_text(value).upper()


def parse_optional_day(raw: object, label: str) -> date | None:
    text = clean_text(raw)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise RuntimeError(f"{label} must be YYYY-MM-DD: {text!r}") from exc


def row_day(value: object) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create connector-agnostic Breathe London identity timeline .xlsx reports "
            "from Dropbox R2 history/v2 core data."
        )
    )
    parser.add_argument(
        "--site-ref",
        "--site_ref",
        dest="site_ref",
        default="",
        help="Any Breathe London site/source reference, e.g. BL0005 or CLDP0014",
    )
    parser.add_argument(
        "--input-csv",
        "--input_csv",
        dest="input_csv",
        default="",
        help="CSV containing a site_ref column",
    )
    parser.add_argument(
        "--root",
        default="",
        help="Local R2_history_backup root; overrides environment-derived Dropbox root",
    )
    parser.add_argument(
        "--output-dir",
        "--output_dir",
        dest="output_dir",
        default=".",
        help="Directory for generated .xlsx files",
    )
    parser.add_argument(
        "--from-day",
        "--from_day",
        dest="from_day",
        default="",
        help="Optional inclusive report start YYYY-MM-DD",
    )
    parser.add_argument(
        "--to-day",
        "--to_day",
        dest="to_day",
        default="",
        help="Optional inclusive report end YYYY-MM-DD",
    )
    args = parser.parse_args(argv)

    direct = bool(clean_text(args.site_ref))
    csv_mode = bool(clean_text(args.input_csv))
    if direct and csv_mode:
        parser.error("Use --site-ref or --input-csv, not both.")
    if not direct and not csv_mode:
        parser.error("Provide --site-ref or --input-csv.")
    try:
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


def latest_snapshot_with_table(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]], table_name: str
) -> tuple[date, Path, Mapping[str, object]] | None:
    for snapshot in reversed(snapshots):
        _day, snapshot_dir, manifest = snapshot
        if table_path(snapshot_dir, manifest, table_name) is not None:
            return snapshot
    return None


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
            if not site_key:
                raise RuntimeError("Input CSV must contain a site_ref column.")
            for row_number, row in enumerate(reader, start=2):
                site_ref = clean_text(row.get(site_key))
                if not site_ref:
                    raise RuntimeError(f"Input CSV row {row_number} has no site_ref.")
                selectors.append(Selector(site_ref=site_ref, source_label=f"{path}:row {row_number}"))
        if not selectors:
            raise RuntimeError(f"Input CSV contains no data rows: {path}")
        return selectors
    return [Selector(site_ref=clean_text(args.site_ref))]


def build_station_catalog(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]]
) -> tuple[dict[StationKey, StationRecord], dict[int, StationKey]]:
    catalog: dict[StationKey, StationRecord] = {}
    by_id: dict[int, StationKey] = {}

    for snapshot_day, snapshot_dir, manifest in snapshots:
        path = table_path(snapshot_dir, manifest, "stations")
        if path is None:
            continue
        seen_this_snapshot: set[StationKey] = set()
        for row in iter_ndjson_gz(path):
            connector_id = int(row.get("connector_id") or 0)
            if connector_id not in TARGET_CONNECTOR_IDS:
                continue
            site_ref = clean_text(row.get("station_ref"))
            if not site_ref:
                continue
            key = StationKey(connector_id, site_ref)
            if key in seen_this_snapshot:
                raise RuntimeError(
                    f"Duplicate station rows for connector_id={connector_id} site_ref={site_ref} "
                    f"in core snapshot {snapshot_day}."
                )
            seen_this_snapshot.add(key)
            station_id = int(row.get("id"))
            catalog[key] = StationRecord(
                key=key,
                station_id=station_id,
                device_ref=clean_text(row.get("station_device_ref")),
                first_seen=row_day(row.get("first_seen_at")),
                removed_at=row_day(row.get("removed_at")),
                match_id=clean_text(row.get("match_id")),
            )
            existing_key = by_id.get(station_id)
            if existing_key is not None and existing_key != key:
                raise RuntimeError(
                    f"station_id={station_id} resolves to multiple Breathe London station refs: "
                    f"{existing_key} and {key}."
                )
            by_id[station_id] = key

    if not catalog:
        raise RuntimeError("No Breathe London stations were found in the v2 core snapshots.")
    return catalog, by_id


def extract_metadata_refs(attributes: Mapping[str, object]) -> tuple[set[str], set[str]]:
    site_refs: set[str] = set()
    installation_refs: set[str] = set()

    site_code = clean_text(attributes.get("SiteCode"))
    if site_code:
        site_refs.add(site_code)
    installation = clean_text(attributes.get("InstallationCode"))
    if installation:
        installation_refs.add(installation)

    source_history = attributes.get("source_history")
    if isinstance(source_history, list):
        for entry in source_history:
            if not isinstance(entry, dict):
                continue
            site_code = clean_text(entry.get("SiteCode"))
            if site_code:
                site_refs.add(site_code)
            installation = clean_text(entry.get("InstallationCode"))
            if installation:
                installation_refs.add(installation)

    return site_refs, installation_refs


def build_family_index(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]],
    catalog: Mapping[StationKey, StationRecord],
    station_key_by_id: Mapping[int, StationKey],
) -> tuple[
    dict[str, set[StationKey]],
    dict[StationKey, set[StationKey]],
    dict[StationKey, FamilyEvidence],
    date | None,
]:
    lookup: dict[str, set[StationKey]] = defaultdict(set)
    graph: dict[StationKey, set[StationKey]] = defaultdict(set)
    evidence: dict[StationKey, FamilyEvidence] = {
        key: FamilyEvidence(aliases={key.site_ref}, installation_refs=set(), source_site_refs=set())
        for key in catalog
    }

    communities_by_ref: dict[str, list[StationKey]] = defaultdict(list)
    for key, record in catalog.items():
        lookup[key.normalised_ref].add(key)
        if key.connector_id == 3:
            communities_by_ref[key.normalised_ref].append(key)

        match_id = record.match_id
        if match_id.lower().startswith(INSTALLATION_MATCH_PREFIX):
            alias = match_id[len(INSTALLATION_MATCH_PREFIX):].strip()
            if alias:
                lookup[normalise_ref(alias)].add(key)
                evidence[key].aliases.add(alias)

    metadata_snapshot = latest_snapshot_with_table(snapshots, "station_initial_metadata")
    metadata_day: date | None = None
    if metadata_snapshot is not None:
        metadata_day, snapshot_dir, manifest = metadata_snapshot
        metadata_path = table_path(snapshot_dir, manifest, "station_initial_metadata")
        if metadata_path is None:
            raise RuntimeError("Selected station_initial_metadata snapshot has no readable table file.")
        for row in iter_ndjson_gz(metadata_path):
            station_id = int(row.get("station_id") or 0)
            owner = station_key_by_id.get(station_id)
            if owner is None or owner.connector_id not in TARGET_CONNECTOR_IDS:
                continue
            attributes = row.get("attributes")
            if not isinstance(attributes, dict):
                continue

            source_site_refs, installation_refs = extract_metadata_refs(attributes)
            for ref in source_site_refs:
                lookup[normalise_ref(ref)].add(owner)
                evidence[owner].aliases.add(ref)
                evidence[owner].source_site_refs.add(ref)

            if owner.connector_id != 2:
                continue

            for ref in installation_refs:
                lookup[normalise_ref(ref)].add(owner)
                evidence[owner].aliases.add(ref)
                evidence[owner].installation_refs.add(ref)

                matched_communities = communities_by_ref.get(normalise_ref(ref), [])
                for community_key in matched_communities:
                    graph[owner].add(community_key)
                    graph[community_key].add(owner)
                    evidence[community_key].aliases.add(ref)

    # If an explicit future blondon_installation match_id appears on more than one
    # Breathe London station, treat that shared key as authoritative graph evidence.
    match_groups: dict[str, list[StationKey]] = defaultdict(list)
    for key, record in catalog.items():
        match_id = record.match_id.strip()
        if match_id.lower().startswith(INSTALLATION_MATCH_PREFIX):
            match_groups[match_id.lower()].append(key)
    for members in match_groups.values():
        if len(members) < 2:
            continue
        for left in members:
            for right in members:
                if left != right:
                    graph[left].add(right)

    return lookup, graph, evidence, metadata_day


def resolve_family(
    selector: Selector,
    lookup: Mapping[str, set[StationKey]],
    graph: Mapping[StationKey, set[StationKey]],
) -> list[StationKey]:
    query = normalise_ref(selector.site_ref)
    seeds = set(lookup.get(query, set()))
    if not seeds:
        raise RuntimeError(
            f"No Breathe London site/source reference found for {selector.site_ref!r} ({selector.source_label})."
        )

    visited: set[StationKey] = set()
    queue: deque[StationKey] = deque(sorted(seeds, key=lambda item: (item.connector_id, item.site_ref)))
    while queue:
        key = queue.popleft()
        if key in visited:
            continue
        visited.add(key)
        for neighbour in graph.get(key, set()):
            if neighbour not in visited:
                queue.append(neighbour)

    return sorted(visited, key=lambda item: (item.connector_id, item.site_ref))


def scan_station_history(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]], family: Sequence[StationKey]
) -> dict[StationKey, list[SnapshotState]]:
    wanted = set(family)
    history: dict[StationKey, list[SnapshotState]] = {key: [] for key in family}
    last_fingerprint: dict[StationKey, tuple[object, ...]] = {}

    for snapshot_day, snapshot_dir, manifest in snapshots:
        path = table_path(snapshot_dir, manifest, "stations")
        if path is None:
            continue
        found_this_snapshot: set[StationKey] = set()
        for row in iter_ndjson_gz(path):
            connector_id = int(row.get("connector_id") or 0)
            if connector_id not in TARGET_CONNECTOR_IDS:
                continue
            site_ref = clean_text(row.get("station_ref"))
            key = StationKey(connector_id, site_ref)
            if key not in wanted:
                continue
            if key in found_this_snapshot:
                raise RuntimeError(
                    f"Duplicate station rows for connector_id={connector_id} site_ref={site_ref} "
                    f"in core snapshot {snapshot_day}."
                )
            found_this_snapshot.add(key)
            state = SnapshotState(
                snapshot_day=snapshot_day,
                key=key,
                station_id=int(row.get("id")),
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

        same_identity = (
            current is not None
            and current.station_id == state.station_id
            and current.device_ref == state.device_ref
        )
        if same_identity:
            if state.removed_at is not None:
                current.valid_to = state.removed_at
            continue

        if current is not None:
            inferred_end = proposed_start - timedelta(days=1)
            if current.valid_to is None or inferred_end < current.valid_to:
                current.valid_to = inferred_end

        current = DeviceInterval(
            key=state.key,
            station_id=state.station_id,
            device_ref=state.device_ref,
            valid_from=proposed_start,
            valid_to=state.removed_at,
        )
        intervals.append(current)

    return intervals


def load_timeseries_refs(
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]],
    family: Sequence[StationKey],
    catalog: Mapping[StationKey, StationRecord],
) -> dict[StationKey, dict[str, str]]:
    station_ids = {catalog[key].station_id for key in family if key in catalog}
    result: dict[StationKey, dict[str, str]] = {key: {} for key in family}
    if not station_ids:
        return result

    snapshot = latest_snapshot_with_table(snapshots, "timeseries")
    properties_snapshot = latest_snapshot_with_table(snapshots, "observed_properties")
    if snapshot is None or properties_snapshot is None:
        return result

    _property_day, prop_dir, prop_manifest = properties_snapshot
    prop_path = table_path(prop_dir, prop_manifest, "observed_properties")
    if prop_path is None:
        return result
    property_codes: dict[int, str] = {}
    for row in iter_ndjson_gz(prop_path):
        try:
            property_id = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        property_codes[property_id] = clean_text(row.get("code")).lower()

    station_key_by_id = {catalog[key].station_id: key for key in family if key in catalog}
    _day, snapshot_dir, manifest = snapshot
    ts_path = table_path(snapshot_dir, manifest, "timeseries")
    if ts_path is None:
        return result

    for row in iter_ndjson_gz(ts_path):
        try:
            station_id = int(row.get("station_id"))
        except (TypeError, ValueError):
            continue
        key = station_key_by_id.get(station_id)
        if key is None:
            continue
        try:
            observed_property_id = int(row.get("observed_property_id"))
        except (TypeError, ValueError):
            continue
        pollutant = property_codes.get(observed_property_id, "")
        if pollutant not in TARGET_POLLUTANTS:
            continue
        timeseries_ref = clean_text(row.get("timeseries_ref"))
        if timeseries_ref:
            result[key][pollutant] = timeseries_ref

    return result


def choose_report_range(
    intervals: Mapping[StationKey, Sequence[DeviceInterval]],
    snapshot_day: date,
    from_day: date | None,
    to_day: date | None,
) -> tuple[date, date]:
    all_intervals = [item for items in intervals.values() for item in items]
    if not all_intervals:
        raise RuntimeError("No station history intervals were found for the resolved family.")

    start = from_day or min(item.valid_from for item in all_intervals)
    end = to_day or snapshot_day
    if end > snapshot_day:
        raise RuntimeError(f"--to-day {end} is after the latest core snapshot {snapshot_day}.")
    if start > end:
        raise RuntimeError(f"Report start {start} is after report end {end}.")
    return start, end


def first_of_next_month(day: date) -> date:
    if day.month == 12:
        return date(day.year + 1, 1, 1)
    return date(day.year, day.month + 1, 1)


def build_display_days(
    start: date,
    end: date,
    intervals: Mapping[StationKey, Sequence[DeviceInterval]],
) -> list[date]:
    days: set[date] = {start, end}
    cursor = date(start.year, start.month, 1)
    if cursor < start:
        cursor = first_of_next_month(cursor)
    while cursor <= end:
        days.add(cursor)
        cursor = first_of_next_month(cursor)

    for items in intervals.values():
        for interval in items:
            if start <= interval.valid_from <= end:
                days.add(interval.valid_from)
                if interval.valid_from > start:
                    days.add(interval.valid_from - timedelta(days=1))
            if interval.valid_to is not None and start <= interval.valid_to <= end:
                days.add(interval.valid_to)
                if interval.valid_to < end:
                    days.add(interval.valid_to + timedelta(days=1))

    return sorted(day for day in days if start <= day <= end)


def interval_for_day(items: Sequence[DeviceInterval], day: date) -> DeviceInterval | None:
    candidates = [item for item in items if item.covers(day)]
    if len(candidates) > 1:
        identities = ", ".join(f"{item.station_id}/{item.device_ref}" for item in candidates)
        raise RuntimeError(f"Overlapping device intervals at {day}: {identities}")
    return candidates[0] if candidates else None


def build_timeline_rows(
    family: Sequence[StationKey],
    intervals: Mapping[StationKey, Sequence[DeviceInterval]],
    timeseries_refs: Mapping[StationKey, Mapping[str, str]],
    display_days: Sequence[date],
) -> list[list[object]]:
    rows: list[list[object]] = []
    for day in display_days:
        for key in family:
            interval = interval_for_day(intervals.get(key, ()), day)
            if interval is None:
                continue
            refs = timeseries_refs.get(key, {})
            rows.append(
                [
                    day,
                    CONNECTOR_LABELS.get(key.connector_id, str(key.connector_id)),
                    key.connector_id,
                    key.site_ref,
                    interval.station_id,
                    interval.device_ref,
                    refs.get("pm25", ""),
                    refs.get("no2", ""),
                ]
            )
    return rows


def build_family_rows(
    family: Sequence[StationKey],
    catalog: Mapping[StationKey, StationRecord],
    evidence: Mapping[StationKey, FamilyEvidence],
) -> list[list[object]]:
    rows: list[list[object]] = []
    for key in family:
        record = catalog[key]
        item = evidence.get(key, FamilyEvidence({key.site_ref}, set(), set()))
        rows.append(
            [
                CONNECTOR_LABELS.get(key.connector_id, str(key.connector_id)),
                key.connector_id,
                key.site_ref,
                record.station_id,
                record.device_ref,
                ", ".join(sorted(item.aliases, key=str.upper)),
                ", ".join(sorted(item.installation_refs, key=str.upper)),
                ", ".join(sorted(item.source_site_refs, key=str.upper)),
            ]
        )
    return rows


def sanitise_filename(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return text.strip("._-") or "unknown"


def excel_serial(day: date) -> int:
    return (day - date(1899, 12, 30)).days


def cell_ref(row: int, col: int) -> str:
    letters = ""
    n = col
    while n:
        n, remainder = divmod(n - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row}"


def xml_text(value: object) -> str:
    return escape("" if value is None else str(value))


def inline_string_cell(row: int, col: int, value: object, style: int = 0) -> str:
    ref = cell_ref(row, col)
    text = "" if value is None else str(value)
    preserve = ' xml:space="preserve"' if text != text.strip() else ""
    style_attr = f' s="{style}"' if style else ""
    return f'<c r="{ref}" t="inlineStr"{style_attr}><is><t{preserve}>{xml_text(text)}</t></is></c>'


def number_cell(row: int, col: int, value: int | float, style: int = 0) -> str:
    ref = cell_ref(row, col)
    style_attr = f' s="{style}"' if style else ""
    return f'<c r="{ref}" t="n"{style_attr}><v>{value}</v></c>'


def build_table_sheet_xml(
    headers: Sequence[str],
    rows: Sequence[Sequence[object]],
    widths: Sequence[int],
    date_column: int | None = None,
    highlight_changes: bool = False,
) -> str:
    last_row = len(rows) + 1
    last_col = len(headers)
    cols = "".join(
        f'<col min="{idx}" max="{idx}" width="{width}" customWidth="1"/>'
        for idx, width in enumerate(widths, start=1)
    )
    xml_rows: list[str] = []
    header_cells = "".join(
        inline_string_cell(1, idx, header, style=1)
        for idx, header in enumerate(headers, start=1)
    )
    xml_rows.append(f'<row r="1" ht="22" customHeight="1">{header_cells}</row>')

    previous_by_identity: dict[tuple[object, ...], Sequence[object]] = {}
    for excel_row, values in enumerate(rows, start=2):
        cells: list[str] = []
        identity = tuple(values[1:4]) if len(values) >= 4 else tuple()
        previous = previous_by_identity.get(identity)
        for col_index, value in enumerate(values, start=1):
            changed = (
                highlight_changes
                and previous is not None
                and col_index > 1
                and value != previous[col_index - 1]
            )
            style = 3 if changed else 0
            if date_column == col_index and isinstance(value, date):
                cells.append(number_cell(excel_row, col_index, excel_serial(value), style=2))
            elif isinstance(value, int):
                cells.append(number_cell(excel_row, col_index, value, style=style))
            else:
                cells.append(inline_string_cell(excel_row, col_index, value, style=style))
        xml_rows.append(f'<row r="{excel_row}">{"".join(cells)}</row>')
        if identity:
            previous_by_identity[identity] = values

    end_ref = cell_ref(max(1, last_row), last_col)
    auto_filter = f'<autoFilter ref="A1:{end_ref}"/>' if rows else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{end_ref}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
        '</sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f'<cols>{cols}</cols>'
        f'<sheetData>{"".join(xml_rows)}</sheetData>'
        f'{auto_filter}'
        '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '</worksheet>'
    )


def build_info_sheet_xml(info_rows: Sequence[tuple[str, str]]) -> str:
    xml_rows: list[str] = []
    xml_rows.append(
        '<row r="1" ht="24" customHeight="1">'
        + inline_string_cell(1, 1, "Breathe London Identity Timeline Report", style=1)
        + '</row>'
    )
    for row_index, (label, value) in enumerate(info_rows, start=3):
        xml_rows.append(
            f'<row r="{row_index}">'
            + inline_string_cell(row_index, 1, label, style=4)
            + inline_string_cell(row_index, 2, value)
            + '</row>'
        )
    last = max(3, len(info_rows) + 2)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:B{last}"/>'
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        '<cols><col min="1" max="1" width="32" customWidth="1"/>'
        '<col min="2" max="2" width="90" customWidth="1"/></cols>'
        f'<sheetData>{"".join(xml_rows)}</sheetData>'
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
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
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
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>'''


def write_xlsx(
    output_path: Path,
    timeline_rows: Sequence[Sequence[object]],
    family_rows: Sequence[Sequence[object]],
    info_rows: Sequence[tuple[str, str]],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="18000" windowHeight="10000"/></bookViews>
  <sheets>
    <sheet name="Timeline" sheetId="1" r:id="rId1"/>
    <sheet name="Family" sheetId="2" r:id="rId2"/>
    <sheet name="Report Info" sheetId="3" r:id="rId3"/>
  </sheets>
  <calcPr calcId="191029"/>
</workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''
    core_props = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>UK AQ Breathe London identity timeline</dc:creator>
  <cp:lastModifiedBy>UK AQ Breathe London identity timeline</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{generated}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{generated}</dcterms:modified>
</cp:coreProperties>'''
    app_props = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>UK AQ</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>Timeline</vt:lpstr><vt:lpstr>Family</vt:lpstr><vt:lpstr>Report Info</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>'''

    timeline_xml = build_table_sheet_xml(
        TIMELINE_HEADERS,
        timeline_rows,
        widths=(13, 28, 13, 16, 14, 18, 24, 24),
        date_column=1,
        highlight_changes=True,
    )
    family_xml = build_table_sheet_xml(
        FAMILY_HEADERS,
        family_rows,
        widths=(28, 13, 16, 14, 18, 42, 42, 42),
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("docProps/core.xml", core_props)
        archive.writestr("docProps/app.xml", app_props)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/styles.xml", styles_xml())
        archive.writestr("xl/worksheets/sheet1.xml", timeline_xml)
        archive.writestr("xl/worksheets/sheet2.xml", family_xml)
        archive.writestr("xl/worksheets/sheet3.xml", build_info_sheet_xml(info_rows))


def generate_report(
    selector: Selector,
    root: Path,
    output_dir: Path,
    snapshots: Sequence[tuple[date, Path, Mapping[str, object]]],
    catalog: Mapping[StationKey, StationRecord],
    lookup: Mapping[str, set[StationKey]],
    graph: Mapping[StationKey, set[StationKey]],
    evidence: Mapping[StationKey, FamilyEvidence],
    metadata_day: date | None,
    from_day: date | None,
    to_day: date | None,
) -> Path:
    family = resolve_family(selector, lookup, graph)
    station_history = scan_station_history(snapshots, family)
    intervals = {key: build_device_intervals(station_history.get(key, ())) for key in family}
    latest_day = snapshots[-1][0]
    start, end = choose_report_range(intervals, latest_day, from_day, to_day)
    display_days = build_display_days(start, end, intervals)
    timeseries_refs = load_timeseries_refs(snapshots, family, catalog)
    timeline_rows = build_timeline_rows(family, intervals, timeseries_refs, display_days)
    family_rows = build_family_rows(family, catalog, evidence)

    family_description = ", ".join(
        f"{CONNECTOR_CODES.get(key.connector_id, key.connector_id)}:{key.site_ref}"
        for key in family
    )
    info_rows = [
        ("Requested reference", selector.site_ref),
        ("Resolved family members", family_description),
        ("Family member count", str(len(family))),
        ("Latest core snapshot", latest_day.isoformat()),
        (
            "station_initial_metadata snapshot",
            metadata_day.isoformat() if metadata_day else "not available; cross-connector lineage may be incomplete",
        ),
        ("Report start", start.isoformat()),
        ("Report end", end.isoformat()),
        ("Dropbox R2 root", str(root)),
        (
            "Lookup contract",
            "station_ref + explicit SiteCode/InstallationCode source metadata; DeviceCode/name/coordinates excluded",
        ),
    ]

    output_path = output_dir / f"BreatheLondon_{sanitise_filename(selector.site_ref)}_identity_timeline.xlsx"
    write_xlsx(output_path, timeline_rows, family_rows, info_rows)
    return output_path


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    root = resolve_backup_root(args.root)
    output_dir = Path(args.output_dir).expanduser().resolve()
    snapshots = discover_core_snapshots(root)
    selectors = read_selectors(args)
    catalog, station_key_by_id = build_station_catalog(snapshots)
    lookup, graph, evidence, metadata_day = build_family_index(
        snapshots,
        catalog,
        station_key_by_id,
    )

    generated: list[Path] = []
    for selector in selectors:
        generated.append(
            generate_report(
                selector,
                root,
                output_dir,
                snapshots,
                catalog,
                lookup,
                graph,
                evidence,
                metadata_day,
                args.from_day,
                args.to_day,
            )
        )

    for path in generated:
        print(path)
    if metadata_day is None:
        print(
            "WARNING: no v2 core snapshot containing station_initial_metadata was found; "
            "direct station_ref lookup worked, but cross-connector lineage discovery may be incomplete.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
