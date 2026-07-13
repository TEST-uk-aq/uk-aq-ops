#!/usr/bin/env python3
"""R2 v2-only AQI structural gap checker for local UK-AQ history backups.

This checker reads a local Dropbox/R2 backup tree only. It compares v2
observation parquet rows, v2 hourly AQI parquet rows, and the two API-facing
v2 timeseries index manifests. It does not recalculate AQI values and it never
writes to R2, Supabase, Dropbox, or source systems.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

POLLUTANTS = ("pm25", "pm10", "no2", "o3")
AQI_SUPPORTED_POLLUTANTS = frozenset({"pm25", "pm10", "no2"})
SUMMARY_COLUMNS = (
    "day_utc",
    "connector_id",
    "pol",
    "timeseries_id",
    "obs_rows",
    "aqi_rows",
    "obs_idx",
    "aqi_idx",
    "obs_idx_rows",
    "aqi_idx_rows",
    "status",
)
V2_ONLY_ERROR = (
    "uk-aq-aqi-gap-check.py is now R2 v2-only. "
    "Set UK_AQ_R2_HISTORY_VERSION=v2 to run it."
)


def require_v2_history_version() -> None:
    if os.environ.get("UK_AQ_R2_HISTORY_VERSION") != "v2":
        raise SystemExit(V2_ONLY_ERROR, 2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check local R2 history v2 AQI structural gaps.",
    )
    parser.add_argument("--from-day", required=True, help="First UTC day, YYYY-MM-DD")
    parser.add_argument("--to-day", required=True, help="Last UTC day, YYYY-MM-DD")
    parser.add_argument("--connector-id", help="Connector ID to check. Omit to discover connectors.")
    parser.add_argument(
        "--pollutant",
        default="all",
        choices=(*POLLUTANTS, "all"),
        help="Pollutant to check, or all discovered pollutants.",
    )
    parser.add_argument("--timeseries-id", help="Optional timeseries ID filter.")
    parser.add_argument("--r2-history-root", help="Local Dropbox/R2 history backup root.")
    parser.add_argument("--out", required=True, help="Output directory for reports.")
    return parser.parse_args()


def resolve_output_dir(env: dict[str, str] | os._Environ[str], args: argparse.Namespace) -> Path:
    raw = (
        getattr(args, "output_dir", None)
        or getattr(args, "out", None)
        or env.get("UK_AQ_AQI_GAP_REPORT_DIR")
        or "aqi_gap_check/reports"
    )
    return Path(str(raw)).expanduser()


def resolve_r2_history_root(cli_root: str | None) -> Path:
    root = cli_root or os.environ.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT") or os.environ.get("R2_HISTORY_DROPBOX_ROOT")
    if not root:
        raise SystemExit(
            "Missing local R2 history root. Pass --r2-history-root or set "
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT/R2_HISTORY_DROPBOX_ROOT.",
            2,
        )
    path = Path(root).expanduser().resolve()
    if not path.exists():
        raise SystemExit(f"Local R2 history root does not exist: {path}", 2)
    return path


def parse_day(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f"Invalid day {value!r}; expected YYYY-MM-DD.", 2) from exc


def iter_days(from_day: str, to_day: str) -> list[str]:
    start = parse_day(from_day)
    end = parse_day(to_day)
    if end < start:
        raise SystemExit("--to-day must be on or after --from-day.", 2)
    days: list[str] = []
    current = start
    while current <= end:
        days.append(current.isoformat())
        current += dt.timedelta(days=1)
    return days


def data_partition(root: Path, domain: str, day: str, connector_id: str, pollutant: str) -> Path:
    if domain == "observations":
        base = root / "history" / "v2" / "observations"
    elif domain == "aqilevels_hourly_data":
        base = root / "history" / "v2" / "aqilevels" / "hourly" / "data"
    else:
        raise ValueError(f"unknown data domain: {domain}")
    return base / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}"


def index_manifest(root: Path, domain: str, day: str, connector_id: str, pollutant: str) -> Path:
    if domain == "observations_timeseries":
        base = root / "history" / "_index_v2" / "observations_timeseries"
    elif domain == "aqilevels_hourly_data_timeseries":
        base = root / "history" / "_index_v2" / "aqilevels_hourly_data_timeseries"
    else:
        raise ValueError(f"unknown index domain: {domain}")
    return base / f"day_utc={day}" / f"connector_id={connector_id}" / f"pollutant_code={pollutant}" / "manifest.json"


def discover_v2_partitions(root: Path, day: str, connector_id: str | None, pollutant: str) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    bases = (
        root / "history" / "v2" / "observations" / f"day_utc={day}",
        root / "history" / "v2" / "aqilevels" / "hourly" / "data" / f"day_utc={day}",
        root / "history" / "_index_v2" / "observations_timeseries" / f"day_utc={day}",
        root / "history" / "_index_v2" / "aqilevels_hourly_data_timeseries" / f"day_utc={day}",
    )
    wanted_pols = set(POLLUTANTS if pollutant == "all" else (pollutant,))
    for base in bases:
        if not base.exists():
            continue
        connector_dirs = [base / f"connector_id={connector_id}"] if connector_id else base.glob("connector_id=*")
        for cdir in connector_dirs:
            if not cdir.is_dir() or not cdir.name.startswith("connector_id="):
                continue
            cid = cdir.name.split("=", 1)[1]
            for pdir in cdir.glob("pollutant_code=*"):
                pol = pdir.name.split("=", 1)[1]
                if pol in wanted_pols:
                    pairs.add((cid, pol))
    if connector_id and pollutant != "all":
        pairs.add((connector_id, pollutant))
    return pairs


def parquet_files(partition: Path) -> list[Path]:
    if not partition.is_dir():
        return []
    return sorted(p for p in partition.glob("*.parquet") if p.is_file())


def read_parquet_counts(files: list[Path], timeseries_id: str | None) -> dict[str, int]:
    if not files:
        return {}
    if importlib.util.find_spec("duckdb") is None:
        raise SystemExit("DuckDB is required to read parquet files. Install the duckdb Python package.", 2)
    import duckdb

    query_files = [str(p) for p in files]
    con = duckdb.connect(database=":memory:")
    try:
        where = ""
        params: list[Any] = [query_files]
        if timeseries_id is not None:
            where = " WHERE CAST(timeseries_id AS VARCHAR) = ?"
            params.append(str(timeseries_id))
        rows = con.execute(
            f"SELECT CAST(timeseries_id AS VARCHAR) AS timeseries_id, COUNT(*) AS row_count "
            f"FROM read_parquet(?) {where} GROUP BY 1 ORDER BY 1",
            params,
        ).fetchall()
        return {str(tsid): int(count) for tsid, count in rows}
    finally:
        con.close()


def read_parquet_hour_keys(
    files: list[Path],
    timeseries_id: str | None,
    *,
    source_observations: bool,
) -> dict[str, set[int]]:
    """Read v2 UTC-hour identities, not raw source-row counts.

    The authoritative v2 writer filters source observations to finite,
    non-negative values and groups the supported pollutant rows by UTC hour.
    Its hourly AQI output has one row per resulting timeseries/hour identity.
    """
    if not files:
        return {}
    if importlib.util.find_spec("duckdb") is None:
        raise SystemExit("DuckDB is required to read parquet files. Install the duckdb Python package.", 2)
    import duckdb

    con = duckdb.connect(database=":memory:")
    try:
        query_files = [str(path) for path in files]
        described = con.execute(
            "DESCRIBE SELECT * FROM read_parquet(?, union_by_name=true)",
            [query_files],
        ).fetchall()
        columns = {str(row[0]) for row in described}
        timestamp_column = "observed_at_utc" if source_observations else "timestamp_hour_utc"
        if timestamp_column not in columns or "timeseries_id" not in columns:
            return {}
        where = (
            "timeseries_id IS NOT NULL "
            f"AND TRY_CAST({timestamp_column} AS TIMESTAMPTZ) IS NOT NULL"
        )
        params: list[Any] = [query_files]
        if source_observations:
            if "value" not in columns:
                return {}
            where += (
                " AND TRY_CAST(value AS DOUBLE) IS NOT NULL"
                " AND isfinite(TRY_CAST(value AS DOUBLE))"
                " AND TRY_CAST(value AS DOUBLE) >= 0"
            )
        if timeseries_id is not None:
            where += " AND CAST(timeseries_id AS VARCHAR) = ?"
            params.append(str(timeseries_id))
        rows = con.execute(
            "SELECT CAST(timeseries_id AS VARCHAR), "
            f"CAST(FLOOR(epoch(TRY_CAST({timestamp_column} AS TIMESTAMPTZ)) / 3600) AS BIGINT) "
            "FROM read_parquet(?, union_by_name=true) "
            f"WHERE {where} GROUP BY 1, 2 ORDER BY 1, 2",
            params,
        ).fetchall()
        result: dict[str, set[int]] = {}
        for tsid, hour_key in rows:
            result.setdefault(str(tsid), set()).add(int(hour_key))
        return result
    finally:
        con.close()


def read_manifest(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else None


def manifest_partition_row_count(manifest: dict[str, Any] | None) -> int | None:
    """Return a whole-partition row count when the manifest exposes one."""
    if not manifest:
        return None
    for key in ("row_count", "rows", "count", "record_count"):
        value = manifest.get(key)
        if isinstance(value, int):
            return int(value)
    return None


def manifest_timeseries_row_count(manifest: dict[str, Any] | None, timeseries_id: str) -> int | None:
    """Return an explicit per-timeseries row count, never a partition count."""
    if not manifest:
        return None
    for key in ("timeseries", "timeseries_counts", "timeseries_row_counts", "rows_by_timeseries_id"):
        value = manifest.get(key)
        if isinstance(value, dict):
            item = value.get(str(timeseries_id))
            if item is None and str(timeseries_id).isdigit():
                item = value.get(int(timeseries_id))
            if isinstance(item, dict):
                for count_key in ("row_count", "rows", "count"):
                    if isinstance(item.get(count_key), int):
                        return int(item[count_key])
            elif isinstance(item, int):
                return int(item)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict) and str(item.get("timeseries_id")) == str(timeseries_id):
                    for count_key in ("row_count", "rows", "count"):
                        if isinstance(item.get(count_key), int):
                            return int(item[count_key])
    return None


def status_for(
    obs_rows: int,
    aqi_rows: int,
    expected_hour_keys: set[int],
    actual_hour_keys: set[int],
    pollutant: str,
    obs_idx: bool,
    aqi_idx: bool,
    aqi_idx_rows: int | None,
) -> str:
    statuses: list[str] = []
    expected_aqi_hours = expected_hour_keys if pollutant in AQI_SUPPORTED_POLLUTANTS else set()
    if expected_aqi_hours and not actual_hour_keys:
        statuses.append("missing_aqi_data")
    if aqi_rows > 0 and not aqi_idx:
        statuses.append("missing_aqi_index")
    if obs_rows > 0 and not obs_idx:
        statuses.append("missing_obs_index")
    if expected_aqi_hours - actual_hour_keys:
        statuses.append("missing_expected_aqi_hours")
    if aqi_rows > 0 and aqi_idx_rows is not None and aqi_idx_rows < aqi_rows:
        statuses.append("stale_or_partial_aqi_index")
    return ";".join(statuses) if statuses else "ok"


def build_summary_rows(root: Path, days: list[str], connector_id: str | None, pollutant: str, timeseries_id: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for day in days:
        for cid, pol in sorted(discover_v2_partitions(root, day, connector_id, pollutant)):
            obs_counts = read_parquet_counts(parquet_files(data_partition(root, "observations", day, cid, pol)), timeseries_id)
            aqi_counts = read_parquet_counts(parquet_files(data_partition(root, "aqilevels_hourly_data", day, cid, pol)), timeseries_id)
            obs_hour_keys = read_parquet_hour_keys(
                parquet_files(data_partition(root, "observations", day, cid, pol)),
                timeseries_id,
                source_observations=True,
            )
            aqi_hour_keys = read_parquet_hour_keys(
                parquet_files(data_partition(root, "aqilevels_hourly_data", day, cid, pol)),
                timeseries_id,
                source_observations=False,
            )
            obs_manifest = read_manifest(index_manifest(root, "observations_timeseries", day, cid, pol))
            aqi_manifest = read_manifest(index_manifest(root, "aqilevels_hourly_data_timeseries", day, cid, pol))
            tsids = sorted(set(obs_counts) | set(aqi_counts) | set(obs_hour_keys) | set(aqi_hour_keys), key=lambda value: (not value.isdigit(), value))
            if timeseries_id is not None and not tsids:
                tsids = [str(timeseries_id)]
            for tsid in tsids:
                obs_rows = obs_counts.get(tsid, 0)
                aqi_rows = aqi_counts.get(tsid, 0)
                obs_idx_rows = manifest_timeseries_row_count(obs_manifest, tsid)
                aqi_idx_rows = manifest_timeseries_row_count(aqi_manifest, tsid)
                rows.append({
                    "day_utc": day,
                    "connector_id": cid,
                    "pol": pol,
                    "timeseries_id": tsid,
                    "obs_rows": obs_rows,
                    "aqi_rows": aqi_rows,
                    "obs_idx": "yes" if obs_manifest is not None else "no",
                    "aqi_idx": "yes" if aqi_manifest is not None else "no",
                    "obs_idx_rows": "" if obs_idx_rows is None else obs_idx_rows,
                    "aqi_idx_rows": "" if aqi_idx_rows is None else aqi_idx_rows,
                    "status": status_for(
                        obs_rows,
                        aqi_rows,
                        obs_hour_keys.get(tsid, set()),
                        aqi_hour_keys.get(tsid, set()),
                        pol,
                        obs_manifest is not None,
                        aqi_manifest is not None,
                        aqi_idx_rows,
                    ),
                })
    return rows


def write_table(path: Path, rows: list[dict[str, Any]], delimiter: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SUMMARY_COLUMNS, delimiter=delimiter)
        writer.writeheader()
        writer.writerows(rows)


def write_reports(
    out_dir: Path,
    rows: list[dict[str, Any]] | str,
    args: argparse.Namespace | dict[str, Any],
    root: Path | None = None,
):
    out_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(rows, str) and isinstance(args, dict) and root is None:
        stem = rows
        report = args
        json_path = out_dir / f"{stem}.json"
        md_path = out_dir / f"{stem}.md"
        payload = json.dumps(report, indent=2, sort_keys=True)
        json_path.write_text(payload + "\n", encoding="utf-8")
        md_path.write_text(f"# {stem}\n\n```json\n{payload}\n```\n", encoding="utf-8")
        return json_path, md_path
    if root is None or not isinstance(args, argparse.Namespace):
        raise TypeError("write_reports expected (out_dir, rows, args, root) for summary reports")
    gap_rows = [row for row in rows if row["status"] != "ok"]
    write_table(out_dir / "summary.tsv", rows, "\t")
    write_table(out_dir / "summary.csv", rows, ",")
    write_table(out_dir / "gaps.tsv", gap_rows, "\t")
    write_table(out_dir / "gaps.csv", gap_rows, ",")
    status_counts: dict[str, int] = defaultdict(int)
    for row in rows:
        for status in str(row["status"]).split(";"):
            status_counts[status] += 1
    run_summary = {
        "script": "uk-aq-aqi-gap-check.py",
        "history_version": "v2",
        "r2_history_root": str(root),
        "from_day": args.from_day,
        "to_day": args.to_day,
        "connector_id": args.connector_id,
        "pollutant": args.pollutant,
        "timeseries_id": args.timeseries_id,
        "summary_row_count": len(rows),
        "gap_row_count": len(gap_rows),
        "status_counts": dict(sorted(status_counts.items())),
        "output_files": ["summary.tsv", "summary.csv", "gaps.tsv", "gaps.csv", "run_summary.json"],
    }
    with (out_dir / "run_summary.json").open("w", encoding="utf-8") as handle:
        json.dump(run_summary, handle, indent=2, sort_keys=True)
        handle.write("\n")


def print_summary(rows: list[dict[str, Any]], out_dir: Path) -> None:
    print(f"Wrote {len(rows)} summary rows to {out_dir}")
    print("\t".join(SUMMARY_COLUMNS))
    for row in rows[:25]:
        print("\t".join(str(row[column]) for column in SUMMARY_COLUMNS))
    if len(rows) > 25:
        print(f"... {len(rows) - 25} more rows in summary.tsv")


def main() -> int:
    try:
        require_v2_history_version()
        args = parse_args()
        root = resolve_r2_history_root(args.r2_history_root)
        days = iter_days(args.from_day, args.to_day)
        rows = build_summary_rows(root, days, args.connector_id, args.pollutant, args.timeseries_id)
        out_dir = resolve_output_dir(os.environ, args).resolve()
        write_reports(out_dir, rows, args, root)
        print_summary(rows, out_dir)
        return 0
    except SystemExit as exc:
        if isinstance(exc.code, tuple):
            message, code = exc.code
            print(message, file=sys.stderr)
            return int(code)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
