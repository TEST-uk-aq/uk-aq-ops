#!/usr/bin/env bash
set -euo pipefail

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    import duckdb
except ModuleNotFoundError:
    print("DuckDB is required. Install it in the active venv with: python3 -m pip install duckdb", file=sys.stderr)
    raise SystemExit(2)

POLLUTANTS = ("pm25", "pm10", "no2", "o3")


def parse_day(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f"Invalid day {value!r}; expected YYYY-MM-DD") from exc


def iter_days(from_day: str, to_day: str) -> list[str]:
    start = parse_day(from_day)
    end = parse_day(to_day)
    if end < start:
        raise SystemExit("--to-day must be on or after --from-day")
    return [(start + dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def existing_root(raw: str | None) -> Path:
    root = raw or os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT") or os.environ.get("R2_HISTORY_DROPBOX_ROOT")
    if not root:
        raise SystemExit(
            "Missing local R2 backup root. Pass --r2-history-root or set "
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT/R2_HISTORY_DROPBOX_ROOT."
        )
    path = Path(root).expanduser().resolve()
    if not path.exists():
        raise SystemExit(f"Local R2 backup root does not exist: {path}")
    return path


def parquet_files(path: Path) -> list[str]:
    if not path.exists():
        return []
    return sorted(str(p) for p in path.glob("*.parquet") if p.is_file())


def parse_manifest(manifest_path: Path, timeseries_id: str, day: str, root: Path) -> dict[str, Any]:
    empty = {
        "manifest": "no",
        "coverage": "",
        "indexed_file_count": "",
        "source_row_count": "",
        "ts_in_range": "no",
        "time_covers_day": "no",
        "referenced_files_exist": "no",
        "has_missing_files": False,
        "is_complete": False,
        "ts_out_of_range": False,
    }
    if not manifest_path.is_file():
        return empty
    
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return empty | {"manifest": "error"}

    result = empty.copy()
    result["manifest"] = "yes"
    result["coverage"] = str(data.get("index_coverage", ""))
    result["indexed_file_count"] = str(data.get("indexed_file_count", ""))
    result["source_row_count"] = str(data.get("source_row_count", ""))
    
    result["is_complete"] = result["coverage"] == "complete"
    
    ts_id = int(timeseries_id) if timeseries_id.isdigit() else -1
    
    # ts_in_range
    ts_in_range = False
    if "min_timeseries_id" in data and "max_timeseries_id" in data:
        if data["min_timeseries_id"] is not None and data["max_timeseries_id"] is not None:
            if data["min_timeseries_id"] <= ts_id <= data["max_timeseries_id"]:
                ts_in_range = True
    
    if not ts_in_range:
        for f in data.get("files", []):
            if "min_timeseries_id" in f and "max_timeseries_id" in f:
                if f["min_timeseries_id"] is not None and f["max_timeseries_id"] is not None:
                    if f["min_timeseries_id"] <= ts_id <= f["max_timeseries_id"]:
                        ts_in_range = True
                        break
    result["ts_in_range"] = "yes" if ts_in_range else "no"
    result["ts_out_of_range"] = not ts_in_range

    # time_covers_day
    day_start = f"{day}T00"
    day_end = f"{day}T23"
    
    time_covers_day = False
    min_ts = data.get("min_timestamp_hour_utc") or data.get("min_observed_at_utc") or ""
    max_ts = data.get("max_timestamp_hour_utc") or data.get("max_observed_at_utc") or ""
    if min_ts and max_ts and str(min_ts)[:13] <= day_start and str(max_ts)[:13] >= day_end:
        time_covers_day = True
        
    if not time_covers_day:
        for f in data.get("files", []):
            min_ts = f.get("min_timestamp_hour_utc") or f.get("min_observed_at_utc") or ""
            max_ts = f.get("max_timestamp_hour_utc") or f.get("max_observed_at_utc") or ""
            if min_ts and max_ts and str(min_ts)[:13] <= day_start and str(max_ts)[:13] >= day_end:
                time_covers_day = True
                break
    result["time_covers_day"] = "yes" if time_covers_day else "no"
    
    # referenced_files_exist
    files_exist = True
    files_list = data.get("files", [])
    for f in files_list:
        key = f.get("key")
        if key:
            if not (root / key).is_file():
                files_exist = False
                break
    
    indexed_file_count_str = str(data.get("indexed_file_count", ""))
    indexed_file_count = int(indexed_file_count_str) if indexed_file_count_str.isdigit() else 0
    
    if not files_list:
        if indexed_file_count > 0:
            result["referenced_files_exist"] = "no"
            result["has_missing_files"] = True
        else:
            result["referenced_files_exist"] = "yes"
            result["has_missing_files"] = False
    else:
        result["referenced_files_exist"] = "yes" if files_exist else "no"
        result["has_missing_files"] = not files_exist
    
    return result


def read_count(con: duckdb.DuckDBPyConnection, files: list[str], where_sql: str, params: list[Any]) -> int | None:
    if not files:
        return 0
    try:
        row = con.execute(
            f"SELECT COUNT(*) FROM read_parquet(?) WHERE {where_sql}",
            [files, *params],
        ).fetchone()
        return int(row[0] or 0)
    except Exception as exc:
        return None


def read_aqi_counts(con: duckdb.DuckDBPyConnection, files: list[str], timeseries_id: str) -> dict[str, Any]:
    empty = {
        "aqi_rows": 0,
        "daqi_level_rows": 0,
        "eaqi_level_rows": 0,
        "daqi_null_rows": 0,
        "eaqi_null_rows": 0,
        "daqi_statuses": "",
        "eaqi_statuses": "",
        "daqi_missing_reasons": "",
        "eaqi_missing_reasons": "",
        "read_error": "",
    }
    if not files:
        return empty
    try:
        row = con.execute(
            """
            WITH rows AS (
              SELECT *
              FROM read_parquet(?)
              WHERE CAST(timeseries_id AS VARCHAR) = ?
            )
            SELECT
              COUNT(*) AS aqi_rows,
              COUNT(daqi_index_level) AS daqi_level_rows,
              COUNT(eaqi_index_level) AS eaqi_level_rows,
              SUM(CASE WHEN daqi_index_level IS NULL THEN 1 ELSE 0 END) AS daqi_null_rows,
              SUM(CASE WHEN eaqi_index_level IS NULL THEN 1 ELSE 0 END) AS eaqi_null_rows,
              COALESCE(string_agg(DISTINCT COALESCE(daqi_calculation_status, '<null>'), ', ' ORDER BY COALESCE(daqi_calculation_status, '<null>')), '') AS daqi_statuses,
              COALESCE(string_agg(DISTINCT COALESCE(eaqi_calculation_status, '<null>'), ', ' ORDER BY COALESCE(eaqi_calculation_status, '<null>')), '') AS eaqi_statuses,
              COALESCE(string_agg(DISTINCT COALESCE(daqi_missing_reason, '<null>'), ', ' ORDER BY COALESCE(daqi_missing_reason, '<null>')), '') AS daqi_missing_reasons,
              COALESCE(string_agg(DISTINCT COALESCE(eaqi_missing_reason, '<null>'), ', ' ORDER BY COALESCE(eaqi_missing_reason, '<null>')), '') AS eaqi_missing_reasons
            FROM rows
            """,
            [files, timeseries_id],
        ).fetchone()
        return dict(zip(list(empty)[:-1], row)) | {"read_error": ""}
    except Exception as exc:
        result = empty.copy()
        result["read_error"] = str(exc).splitlines()[0]
        return result


def local_paths(root: Path, day: str, connector_id: str, pollutant: str) -> dict[str, Path]:
    return {
        "obs": root / "history/v2/observations" / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}",
        "aqi": root / "history/v2/aqilevels/hourly/data" / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}",
        "obs_idx": root / "history/_index_v2/observations_timeseries" / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}",
        "aqi_idx": root / "history/_index_v2/aqilevels_hourly_data_timeseries" / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}",
    }


def discover_pollutants(root: Path, days: list[str], connector_id: str) -> list[str]:
    found: set[str] = set()
    family_roots = [
        root / "history/v2/observations",
        root / "history/v2/aqilevels/hourly/data",
        root / "history/_index_v2/observations_timeseries",
        root / "history/_index_v2/aqilevels_hourly_data_timeseries",
    ]
    for day in days:
        for family in family_roots:
            base = family / f"day_utc={day}" / f"connector_id={connector_id}"
            if not base.exists():
                continue
            for child in base.glob("pollutant_code=*"):
                if child.is_dir():
                    found.add(child.name.split("=", 1)[1])
    return sorted(found, key=lambda p: POLLUTANTS.index(p) if p in POLLUTANTS else 999)


def tsv_value(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\t", " ").replace("\n", " ")


def print_table(rows: list[dict[str, Any]], columns: list[str]) -> None:
    print("\t".join(columns))
    for row in rows:
        print("\t".join(tsv_value(row.get(col, "")) for col in columns))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Local Dropbox/R2-backup v2 observation, AQI, and API-facing index check. Does not contact live R2.",
    )
    parser.add_argument("--connector-id", required=True)
    parser.add_argument("--from-day", required=True)
    parser.add_argument("--to-day", required=True)
    parser.add_argument("--pollutant", default="pm25", choices=(*POLLUTANTS, "all"))
    parser.add_argument("--timeseries-id", default="218")
    parser.add_argument("--r2-history-root")
    parser.add_argument("--out", help="Optional local output directory for CSV reports. No source data is copied here.")
    args = parser.parse_args()

    root = existing_root(args.r2_history_root)
    days = iter_days(args.from_day, args.to_day)
    pollutants = discover_pollutants(root, days, args.connector_id) if args.pollutant == "all" else [args.pollutant]

    print("WARNING: local Dropbox/R2 backup mode only. This script does not contact live R2 and downloads nothing.", file=sys.stderr)
    print(f"WARNING: results are only valid if this local backup is fully up to date: {root}", file=sys.stderr)

    if not pollutants:
        print("No pollutant partitions discovered for the selected connector/date range.", file=sys.stderr)
        return 1

    con = duckdb.connect()
    rows: list[dict[str, Any]] = []

    for day in days:
        for pol in pollutants:
            paths = local_paths(root, day, args.connector_id, pol)
            obs_files = parquet_files(paths["obs"])
            aqi_files = parquet_files(paths["aqi"])

            obs_rows = read_count(con, obs_files, "CAST(timeseries_id AS VARCHAR) = ?", [args.timeseries_id])
            aqi_counts = read_aqi_counts(con, aqi_files, args.timeseries_id)
            aqi_rows = int(aqi_counts["aqi_rows"] or 0)

            obs_man = parse_manifest(paths["obs_idx"] / "manifest.json", args.timeseries_id, day, root)
            aqi_man = parse_manifest(paths["aqi_idx"] / "manifest.json", args.timeseries_id, day, root)

            statuses: list[str] = []
            if obs_rows is None:
                statuses.append("obs_read_error")
            if aqi_counts.get("read_error"):
                statuses.append("aqi_read_error")
            if (obs_rows or 0) > 0 and aqi_rows == 0:
                statuses.append("missing_aqi_data")
            if (obs_rows or 0) > aqi_rows and aqi_rows > 0:
                statuses.append("stale_or_partial_aqi_data")

            # Obs Index Status
            if (obs_rows or 0) > 0:
                if obs_man["manifest"] == "error":
                    statuses.append("obs_index_manifest_parse_error")
                elif obs_man["manifest"] != "yes":
                    statuses.append("missing_obs_index_manifest")
                else:
                    if not obs_man["is_complete"]:
                        statuses.append("incomplete_obs_index_coverage")
                    if obs_man["ts_out_of_range"]:
                        statuses.append("obs_index_timeseries_not_in_range")
                    if obs_man["time_covers_day"] == "no":
                        statuses.append("obs_index_time_not_covering_day")
                    if obs_man["has_missing_files"]:
                        statuses.append("obs_index_referenced_file_missing")

            # AQI Index Status
            if aqi_rows > 0:
                if aqi_man["manifest"] == "error":
                    statuses.append("aqi_index_manifest_parse_error")
                elif aqi_man["manifest"] != "yes":
                    statuses.append("missing_aqi_index_manifest")
                else:
                    if not aqi_man["is_complete"]:
                        statuses.append("incomplete_aqi_index_coverage")
                    if aqi_man["ts_out_of_range"]:
                        statuses.append("aqi_index_timeseries_not_in_range")
                    if aqi_man["time_covers_day"] == "no":
                        statuses.append("aqi_index_time_not_covering_day")
                    if aqi_man["has_missing_files"]:
                        statuses.append("aqi_index_referenced_file_missing")

            if aqi_rows > 0 and int(aqi_counts["daqi_level_rows"] or 0) < aqi_rows:
                statuses.append("partial_daqi_levels")
            if aqi_rows > 0 and int(aqi_counts["eaqi_level_rows"] or 0) < aqi_rows:
                statuses.append("partial_eaqi_levels")

            if not statuses:
                statuses.append("ok")

            rows.append({
                "day_utc": day,
                "pol": pol,
                "timeseries_id": args.timeseries_id,
                "obs_files": len(obs_files),
                "aqi_files": len(aqi_files),
                "obs_rows": "read_error" if obs_rows is None else obs_rows,
                "aqi_rows": aqi_rows,
                "daqi_level_rows": aqi_counts["daqi_level_rows"],
                "eaqi_level_rows": aqi_counts["eaqi_level_rows"],
                "daqi_null_rows": aqi_counts["daqi_null_rows"],
                "eaqi_null_rows": aqi_counts["eaqi_null_rows"],
                "obs_idx_manifest": obs_man["manifest"],
                "aqi_idx_manifest": aqi_man["manifest"],
                "obs_idx_coverage": obs_man["coverage"],
                "aqi_idx_coverage": aqi_man["coverage"],
                "obs_idx_indexed_file_count": obs_man["indexed_file_count"],
                "aqi_idx_indexed_file_count": aqi_man["indexed_file_count"],
                "obs_idx_source_row_count": obs_man["source_row_count"],
                "aqi_idx_source_row_count": aqi_man["source_row_count"],
                "obs_idx_ts_in_range": obs_man["ts_in_range"],
                "aqi_idx_ts_in_range": aqi_man["ts_in_range"],
                "obs_idx_time_covers_day": obs_man["time_covers_day"],
                "aqi_idx_time_covers_day": aqi_man["time_covers_day"],
                "obs_idx_referenced_files_exist": obs_man["referenced_files_exist"],
                "aqi_idx_referenced_files_exist": aqi_man["referenced_files_exist"],
                "daqi_statuses": aqi_counts["daqi_statuses"],
                "eaqi_statuses": aqi_counts["eaqi_statuses"],
                "daqi_missing_reasons": aqi_counts["daqi_missing_reasons"],
                "eaqi_missing_reasons": aqi_counts["eaqi_missing_reasons"],
                "status": ";".join(statuses),
            })

    columns = [
        "day_utc", "pol", "timeseries_id",
        "obs_files", "aqi_files", "obs_rows", "aqi_rows",
        "daqi_level_rows", "eaqi_level_rows", "daqi_null_rows", "eaqi_null_rows",
        "obs_idx_manifest", "aqi_idx_manifest",
        "obs_idx_coverage", "aqi_idx_coverage",
        "obs_idx_indexed_file_count", "aqi_idx_indexed_file_count",
        "obs_idx_source_row_count", "aqi_idx_source_row_count",
        "obs_idx_ts_in_range", "aqi_idx_ts_in_range",
        "obs_idx_time_covers_day", "aqi_idx_time_covers_day",
        "obs_idx_referenced_files_exist", "aqi_idx_referenced_files_exist",
        "daqi_statuses", "eaqi_statuses", "daqi_missing_reasons", "eaqi_missing_reasons", "status",
    ]

    print()
    print(f"=== Local Dropbox v2 data and API-facing index check for timeseries_id={args.timeseries_id} ===")
    print_table(rows, columns)

    summary_path_str = "None (no --out provided)"
    if args.out:
        out = Path(args.out).expanduser().resolve()
        out.mkdir(parents=True, exist_ok=True)
        summary_path = out / "local_v2_observs_aqilevels_indexes.csv"
        with summary_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({col: "" if row.get(col) is None else row.get(col, "") for col in columns})
        summary_path_str = str(summary_path)

    non_ok_rows = sum(1 for r in rows if r["status"] != "ok")
    
    print()
    print("=== Summary ===")
    print(f"Output CSV: {summary_path_str}")
    print(f"Total rows: {len(rows)}")
    print(f"Non-OK rows: {non_ok_rows}")

    return 0


raise SystemExit(main())
PY
