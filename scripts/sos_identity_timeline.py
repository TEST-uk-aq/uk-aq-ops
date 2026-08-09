#!/usr/bin/env python3
"""Create SOS physical-identity timeline reports from the local Dropbox R2 v2 backup.

The authoritative source for this report is the newest complete v2 core snapshot
whose manifest contains table=sos_station_timeseries_site_refs. The script is
read-only with respect to the Dropbox R2 mirror and writes one .xlsx workbook per
requested SOS site.

Examples:
  python scripts/sos_identity_timeline.py --site-ref BPLE
  python scripts/sos_identity_timeline.py --uk-air-ref UKA00574
  python scripts/sos_identity_timeline.py --input-csv sites.csv
  python scripts/sos_identity_timeline.py --site-ref BPLE --from-day 2025-01-01
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
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence
from xml.sax.saxutils import escape

TARGET_POLLUTANTS = ("pm25", "pm10", "no2")
POLLUTANT_LABELS = {"pm25": "PM2.5", "pm10": "PM10", "no2": "NO2"}
BRIDGE_TABLE = "sos_station_timeseries_site_refs"
CORE_PREFIX = Path("history/v2/core")
EXCEL_MIN_DATE = date(1900, 1, 1)

TIMELINE_HEADERS = (
    "Date",
    "site_ref",
    "uk_air_ref",
    "PM2.5 station_ref",
    "PM10 station_ref",
    "NO2 station_ref",
    "PM2.5 timeseries_ref",
    "PM10 timeseries_ref",
    "NO2 timeseries_ref",
)


@dataclass(frozen=True)
class Selector:
    site_ref: str = ""
    uk_air_ref: str = ""
    source_label: str = "command line"


@dataclass(frozen=True)
class Interval:
    site_ref: str
    uk_air_ref: str
    pollutant_code: str
    station_id: int | None
    timeseries_id: int | None
    station_ref: str
    timeseries_ref: str
    valid_from: date
    valid_to: date | None

    def covers(self, day: date) -> bool:
        return self.valid_from <= day and (self.valid_to is None or day <= self.valid_to)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create SOS sensor identity timeline .xlsx reports from Dropbox R2 history/v2 core data."
    )
    parser.add_argument("--site-ref", "--site_ref", dest="site_ref", default="", help="SOS/UK-AIR site_ref, e.g. BPLE")
    parser.add_argument("--uk-air-ref", "--uk_air_ref", dest="uk_air_ref", default="", help="UK-AIR reference, e.g. UKA00574")
    parser.add_argument("--input-csv", "--input_csv", dest="input_csv", default="", help="CSV with site_ref and/or uk_air_ref columns")
    parser.add_argument("--root", default="", help="Local R2_history_backup root; overrides environment-derived Dropbox root")
    parser.add_argument("--output-dir", "--output_dir", dest="output_dir", default=".", help="Directory for generated .xlsx files (default: current directory)")
    parser.add_argument("--from-day", "--from_day", dest="from_day", default="", help="Optional inclusive report start YYYY-MM-DD")
    parser.add_argument("--to-day", "--to_day", dest="to_day", default="", help="Optional inclusive report end YYYY-MM-DD")
    args = parser.parse_args(argv)

    direct = bool(args.site_ref.strip() or args.uk_air_ref.strip())
    csv_mode = bool(args.input_csv.strip())
    if direct and csv_mode:
        parser.error("Use direct --site-ref/--uk-air-ref selectors or --input-csv, not both.")
    if not direct and not csv_mode:
        parser.error("Provide --site-ref, --uk-air-ref, or --input-csv.")

    args.from_day = parse_optional_day(args.from_day, "--from-day")
    args.to_day = parse_optional_day(args.to_day, "--to-day")
    if args.from_day and args.to_day and args.from_day > args.to_day:
        parser.error("--from-day must be <= --to-day.")
    return args


def parse_optional_day(raw: str, flag: str) -> date | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise SystemExit(f"{flag} must be YYYY-MM-DD: {text!r}") from exc


def resolve_backup_root(override: str) -> Path:
    if override.strip():
        return Path(override).expanduser().resolve()

    explicit = os.getenv("UK_AQ_R2_HISTORY_DROPBOX_ROOT", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()

    dropbox_root = os.getenv("UK_AQ_DROPBOX_ROOT", "").strip() or "CIC-Test"
    history_dir = os.getenv("UK_AQ_R2_HISTORY_DROPBOX_DIR", "").strip() or "R2_history_backup"
    candidate = Path(dropbox_root).expanduser()

    if candidate.is_absolute():
        if candidate.name == history_dir or candidate.name == "R2_history_backup":
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


def find_latest_bridge_snapshot(root: Path) -> tuple[date, Path, Path, Mapping[str, object]]:
    core_root = root / CORE_PREFIX
    if not core_root.is_dir():
        raise RuntimeError(f"v2 core directory not found: {core_root}")

    candidates: list[tuple[date, Path]] = []
    for child in core_root.iterdir():
        if not child.is_dir() or not child.name.startswith("day_utc="):
            continue
        raw_day = child.name.split("=", 1)[1]
        try:
            day = date.fromisoformat(raw_day)
        except ValueError:
            continue
        candidates.append((day, child))

    for snapshot_day, snapshot_dir in sorted(candidates, reverse=True):
        manifest_path = snapshot_dir / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        tables = manifest.get("tables")
        if not isinstance(tables, list):
            continue
        entry = next(
            (item for item in tables if isinstance(item, dict) and item.get("table") == BRIDGE_TABLE),
            None,
        )
        if not entry:
            continue
        relative_path = str(entry.get("relative_path") or f"table={BRIDGE_TABLE}/rows.ndjson.gz")
        rows_path = snapshot_dir / relative_path
        if not rows_path.is_file():
            continue
        return snapshot_day, snapshot_dir, rows_path, manifest

    raise RuntimeError(
        f"No complete v2 core snapshot containing {BRIDGE_TABLE!r} was found under {core_root}"
    )


def load_bridge_rows(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
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
            rows.append(row)
    return rows


def read_selectors(args: argparse.Namespace) -> list[Selector]:
    if args.input_csv:
        csv_path = Path(args.input_csv).expanduser()
        if not csv_path.is_file():
            raise RuntimeError(f"Input CSV not found: {csv_path}")
        selectors: list[Selector] = []
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise RuntimeError(f"Input CSV has no header row: {csv_path}")
            canonical = {str(name).strip().lower(): name for name in reader.fieldnames if name is not None}
            site_key = canonical.get("site_ref")
            uk_key = canonical.get("uk_air_ref")
            if not site_key and not uk_key:
                raise RuntimeError("Input CSV must contain site_ref and/or uk_air_ref columns.")
            for row_number, row in enumerate(reader, start=2):
                site_ref = clean_text(row.get(site_key)) if site_key else ""
                uk_air_ref = clean_text(row.get(uk_key)) if uk_key else ""
                if not site_ref and not uk_air_ref:
                    raise RuntimeError(
                        f"Input CSV row {row_number} has neither site_ref nor uk_air_ref."
                    )
                selectors.append(
                    Selector(site_ref=site_ref, uk_air_ref=uk_air_ref, source_label=f"{csv_path}:row {row_number}")
                )
        if not selectors:
            raise RuntimeError(f"Input CSV contains no data rows: {csv_path}")
        return selectors

    return [
        Selector(
            site_ref=clean_text(args.site_ref),
            uk_air_ref=clean_text(args.uk_air_ref),
            source_label="command line",
        )
    ]


def clean_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_row_day(value: object, field_name: str) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise RuntimeError(f"Invalid {field_name}: {value!r}") from exc


def parse_optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resolve_site_intervals(
    bridge_rows: Sequence[Mapping[str, object]], selector: Selector
) -> tuple[str, str, dict[str, list[Interval]]]:
    matches: list[Mapping[str, object]] = []
    for row in bridge_rows:
        if selector.site_ref and clean_text(row.get("site_ref")).upper() != selector.site_ref.upper():
            continue
        if selector.uk_air_ref and clean_text(row.get("uk_air_ref")).upper() != selector.uk_air_ref.upper():
            continue
        matches.append(row)

    if not matches:
        bits = []
        if selector.site_ref:
            bits.append(f"site_ref={selector.site_ref}")
        if selector.uk_air_ref:
            bits.append(f"uk_air_ref={selector.uk_air_ref}")
        raise RuntimeError(f"No SOS bridge rows found for {' '.join(bits)} ({selector.source_label})")

    site_refs = sorted({clean_text(row.get("site_ref")) for row in matches if clean_text(row.get("site_ref"))})
    uk_air_refs = sorted({clean_text(row.get("uk_air_ref")) for row in matches if clean_text(row.get("uk_air_ref"))})
    if len(site_refs) != 1:
        raise RuntimeError(
            f"Selector {selector.source_label} resolves to multiple site_ref values: {site_refs}. Refusing to guess."
        )
    if len(uk_air_refs) != 1:
        raise RuntimeError(
            f"Selector {selector.source_label} resolves to multiple uk_air_ref values: {uk_air_refs}. Refusing to guess."
        )

    resolved_site_ref = site_refs[0]
    resolved_uk_air_ref = uk_air_refs[0]
    intervals: dict[str, list[Interval]] = {code: [] for code in TARGET_POLLUTANTS}
    seen: set[tuple[object, ...]] = set()

    for row in matches:
        pollutant = clean_text(row.get("pollutant_code")).lower()
        if pollutant not in intervals:
            continue
        valid_from = parse_row_day(row.get("valid_from_day_utc"), "valid_from_day_utc")
        if valid_from is None:
            raise RuntimeError(
                f"Missing valid_from_day_utc for {resolved_site_ref} {pollutant} timeseries_id={row.get('timeseries_id')}"
            )
        valid_to = parse_row_day(row.get("valid_to_day_utc"), "valid_to_day_utc")
        if valid_to is not None and valid_from > valid_to:
            raise RuntimeError(
                f"Invalid interval for {resolved_site_ref} {pollutant}: {valid_from} > {valid_to}"
            )
        interval = Interval(
            site_ref=resolved_site_ref,
            uk_air_ref=resolved_uk_air_ref,
            pollutant_code=pollutant,
            station_id=parse_optional_int(row.get("station_id")),
            timeseries_id=parse_optional_int(row.get("timeseries_id")),
            station_ref=clean_text(row.get("station_ref")),
            timeseries_ref=clean_text(row.get("timeseries_ref")),
            valid_from=valid_from,
            valid_to=valid_to,
        )
        identity = (
            interval.pollutant_code,
            interval.station_id,
            interval.timeseries_id,
            interval.station_ref,
            interval.timeseries_ref,
            interval.valid_from,
            interval.valid_to,
        )
        if identity in seen:
            continue
        seen.add(identity)
        intervals[pollutant].append(interval)

    if not any(intervals.values()):
        raise RuntimeError(
            f"SOS bridge rows for {resolved_site_ref}/{resolved_uk_air_ref} contain none of pm25, pm10 or no2."
        )

    for pollutant, items in intervals.items():
        items.sort(key=lambda item: (item.valid_from, item.valid_to or date.max, item.timeseries_id or 0))
        previous: Interval | None = None
        for item in items:
            if previous is not None:
                previous_end = previous.valid_to or date.max
                if item.valid_from <= previous_end:
                    raise RuntimeError(
                        "Overlapping SOS identity intervals detected for "
                        f"{resolved_site_ref} {pollutant}: "
                        f"timeseries_id={previous.timeseries_id} and timeseries_id={item.timeseries_id}. "
                        "Refusing to choose one silently."
                    )
            previous = item

    return resolved_site_ref, resolved_uk_air_ref, intervals


def choose_report_range(
    intervals: Mapping[str, Sequence[Interval]],
    snapshot_day: date,
    from_day: date | None,
    to_day: date | None,
) -> tuple[date, date]:
    all_intervals = [item for items in intervals.values() for item in items]
    if not all_intervals:
        raise RuntimeError("No intervals available to report.")

    if from_day:
        start = from_day
    else:
        credible_starts = [item.valid_from for item in all_intervals if item.valid_from >= EXCEL_MIN_DATE]
        if not credible_starts:
            raise RuntimeError(
                "All relevant SOS intervals have validity starts before 1900-01-01. "
                "Provide --from-day so the report does not invent an Excel-compatible start date."
            )
        start = min(credible_starts)

    if to_day:
        if to_day > snapshot_day:
            raise RuntimeError(
                f"--to-day {to_day.isoformat()} is after the selected core snapshot {snapshot_day.isoformat()}."
            )
        end = to_day
    else:
        if any(item.valid_to is None for item in all_intervals):
            end = snapshot_day
        else:
            end = max(item.valid_to for item in all_intervals if item.valid_to is not None)

    if start < EXCEL_MIN_DATE:
        raise RuntimeError(
            f"Report start {start.isoformat()} is before Excel's supported date range. Use --from-day >= 1900-01-01."
        )
    if end < start:
        raise RuntimeError(f"Resolved report end {end.isoformat()} is before report start {start.isoformat()}.")
    return start, end


def month_starts(start: date, end: date) -> Iterable[date]:
    current = date(start.year, start.month, 1)
    if current < start:
        if current.month == 12:
            current = date(current.year + 1, 1, 1)
        else:
            current = date(current.year, current.month + 1, 1)
    while current <= end:
        yield current
        if current.month == 12:
            current = date(current.year + 1, 1, 1)
        else:
            current = date(current.year, current.month + 1, 1)


def build_display_days(
    intervals: Mapping[str, Sequence[Interval]], start: date, end: date
) -> list[date]:
    days: set[date] = {start}
    days.update(month_starts(start, end))
    for items in intervals.values():
        for item in items:
            if start <= item.valid_from <= end:
                days.add(item.valid_from)
            if item.valid_to is not None and start <= item.valid_to <= end:
                days.add(item.valid_to)
    return sorted(days)


def interval_for_day(items: Sequence[Interval], day: date) -> Interval | None:
    for item in items:
        if item.covers(day):
            return item
    return None


def build_timeline_rows(
    site_ref: str,
    uk_air_ref: str,
    intervals: Mapping[str, Sequence[Interval]],
    display_days: Sequence[date],
) -> list[list[object]]:
    rows: list[list[object]] = []
    for day in display_days:
        states = {code: interval_for_day(intervals.get(code, ()), day) for code in TARGET_POLLUTANTS}
        rows.append(
            [
                day,
                site_ref,
                uk_air_ref,
                states["pm25"].station_ref if states["pm25"] else "",
                states["pm10"].station_ref if states["pm10"] else "",
                states["no2"].station_ref if states["no2"] else "",
                states["pm25"].timeseries_ref if states["pm25"] else "",
                states["pm10"].timeseries_ref if states["pm10"] else "",
                states["no2"].timeseries_ref if states["no2"] else "",
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


def build_timeline_sheet_xml(rows: Sequence[Sequence[object]]) -> str:
    last_row = len(rows) + 1
    widths = (13, 14, 16, 20, 20, 20, 22, 22, 22)
    cols = "".join(
        f'<col min="{idx}" max="{idx}" width="{width}" customWidth="1"/>'
        for idx, width in enumerate(widths, start=1)
    )

    xml_rows: list[str] = []
    header_cells = "".join(
        inline_string_cell(1, idx, header, style=1)
        for idx, header in enumerate(TIMELINE_HEADERS, start=1)
    )
    xml_rows.append(f'<row r="1" ht="22" customHeight="1">{header_cells}</row>')

    previous: Sequence[object] | None = None
    for excel_row, values in enumerate(rows, start=2):
        cells: list[str] = [number_cell(excel_row, 1, excel_serial(values[0]), style=2)]
        for col_index in range(2, 10):
            value = values[col_index - 1]
            changed = previous is not None and value != previous[col_index - 1]
            cells.append(inline_string_cell(excel_row, col_index, value, style=3 if changed else 0))
        xml_rows.append(f'<row r="{excel_row}">{"".join(cells)}</row>')
        previous = values

    dimension = f"A1:I{max(1, last_row)}"
    auto_filter = f'<autoFilter ref="A1:I{last_row}"/>' if rows else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="{dimension}"/>'
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
        + inline_string_cell(1, 1, "SOS Identity Timeline Report", style=1)
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
        '<cols><col min="1" max="1" width="28" customWidth="1"/>'
        '<col min="2" max="2" width="72" customWidth="1"/></cols>'
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


def write_xlsx(output_path: Path, timeline_rows: Sequence[Sequence[object]], info_rows: Sequence[tuple[str, str]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
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
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="18000" windowHeight="10000"/></bookViews>
  <sheets>
    <sheet name="Timeline" sheetId="1" r:id="rId1"/>
    <sheet name="Report Info" sheetId="2" r:id="rId2"/>
  </sheets>
  <calcPr calcId="191029"/>
</workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''
    core_props = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>UK AQ SOS identity timeline</dc:creator>
  <cp:lastModifiedBy>UK AQ SOS identity timeline</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{generated}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{generated}</dcterms:modified>
</cp:coreProperties>'''
    app_props = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>UK AQ</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Timeline</vt:lpstr><vt:lpstr>Report Info</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>'''

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("docProps/core.xml", core_props)
        archive.writestr("docProps/app.xml", app_props)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/styles.xml", styles_xml())
        archive.writestr("xl/worksheets/sheet1.xml", build_timeline_sheet_xml(timeline_rows))
        archive.writestr("xl/worksheets/sheet2.xml", build_info_sheet_xml(info_rows))


def build_info_rows(
    site_ref: str,
    uk_air_ref: str,
    selector: Selector,
    root: Path,
    snapshot_day: date,
    source_rows_path: Path,
    report_start: date,
    report_end: date,
    intervals: Mapping[str, Sequence[Interval]],
    timeline_row_count: int,
) -> list[tuple[str, str]]:
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        relative_source = source_rows_path.relative_to(root)
    except ValueError:
        relative_source = source_rows_path
    selector_text = ", ".join(
        part
        for part in (
            f"site_ref={selector.site_ref}" if selector.site_ref else "",
            f"uk_air_ref={selector.uk_air_ref}" if selector.uk_air_ref else "",
        )
        if part
    )
    rows: list[tuple[str, str]] = [
        ("Network", "SOS / GOV.UK AURN"),
        ("site_ref", site_ref),
        ("uk_air_ref", uk_air_ref),
        ("Requested selector", selector_text),
        ("Selector source", selector.source_label),
        ("Dropbox R2 root", str(root)),
        ("Core snapshot day", snapshot_day.isoformat()),
        ("Source table", BRIDGE_TABLE),
        ("Source file", str(relative_source)),
        ("Report start", report_start.isoformat()),
        ("Report end", report_end.isoformat()),
        ("Timeline rows", str(timeline_row_count)),
        ("Generated UTC", generated),
    ]
    for pollutant in TARGET_POLLUTANTS:
        rows.append((f"{POLLUTANT_LABELS[pollutant]} physical identities", str(len(intervals.get(pollutant, ())))))
    rows.append(("Cell highlighting", "Yellow cells changed from the previous displayed date."))
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    root = resolve_backup_root(args.root)
    if not root.is_dir():
        raise RuntimeError(f"Dropbox R2 backup root not found: {root}")

    snapshot_day, _snapshot_dir, rows_path, manifest = find_latest_bridge_snapshot(root)
    bridge_rows = load_bridge_rows(rows_path)
    selectors = read_selectors(args)
    output_dir = Path(args.output_dir).expanduser().resolve()

    manifest_day = clean_text(manifest.get("day_utc"))
    if manifest_day and manifest_day != snapshot_day.isoformat():
        raise RuntimeError(
            f"Snapshot directory day {snapshot_day.isoformat()} disagrees with manifest day {manifest_day}."
        )

    print(f"Dropbox R2 root: {root}")
    print(f"Using v2 core snapshot: {snapshot_day.isoformat()}")
    print(f"Source: {rows_path}")
    print(f"Loaded bridge rows: {len(bridge_rows)}")

    resolved_outputs: set[Path] = set()
    written = 0
    for selector in selectors:
        site_ref, uk_air_ref, intervals = resolve_site_intervals(bridge_rows, selector)
        report_start, report_end = choose_report_range(
            intervals, snapshot_day, args.from_day, args.to_day
        )
        display_days = build_display_days(intervals, report_start, report_end)
        timeline_rows = build_timeline_rows(
            site_ref, uk_air_ref, intervals, display_days
        )
        filename = (
            f"SOS_{sanitise_filename(site_ref)}_{sanitise_filename(uk_air_ref)}_identity_timeline.xlsx"
        )
        output_path = output_dir / filename
        if output_path in resolved_outputs:
            print(f"Skipping duplicate selector for {site_ref}/{uk_air_ref}: {selector.source_label}")
            continue
        resolved_outputs.add(output_path)

        info_rows = build_info_rows(
            site_ref=site_ref,
            uk_air_ref=uk_air_ref,
            selector=selector,
            root=root,
            snapshot_day=snapshot_day,
            source_rows_path=rows_path,
            report_start=report_start,
            report_end=report_end,
            intervals=intervals,
            timeline_row_count=len(timeline_rows),
        )
        write_xlsx(output_path, timeline_rows, info_rows)
        written += 1
        counts = ", ".join(
            f"{POLLUTANT_LABELS[code]}={len(intervals.get(code, ()))}"
            for code in TARGET_POLLUTANTS
        )
        print(
            f"Wrote {output_path} | {report_start.isoformat()} to {report_end.isoformat()} | "
            f"{len(timeline_rows)} timeline rows | {counts}"
        )

    print(f"Completed: {written} report file(s) written.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
