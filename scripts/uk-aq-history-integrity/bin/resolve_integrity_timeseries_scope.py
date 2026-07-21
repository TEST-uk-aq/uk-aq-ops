#!/usr/bin/env python3
"""Resolve the exact active timeseries scope for an Integrity repair.

The Integrity coordinator selects a connector-day and an explicit canonical
pollutant subset.  Complete connector-day source enumeration must still pass
that selected subset to the shared backfill worker so unrelated connector
bindings cannot reach source-specific mapping guards.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


SUPPORTED_POLLUTANTS = frozenset({"pm25", "pm10", "no2", "o3"})


def parse_pollutants(raw: str) -> tuple[str, ...]:
    values = tuple(sorted({value.strip().lower() for value in raw.split(",") if value.strip()}))
    if not values:
        raise ValueError("at least one repair pollutant is required")
    unsupported = sorted(set(values) - SUPPORTED_POLLUTANTS)
    if unsupported:
        raise ValueError(f"unsupported repair pollutants: {','.join(unsupported)}")
    return values


def require_tables(conn: sqlite3.Connection, names: tuple[str, ...]) -> None:
    placeholders = ",".join("?" for _ in names)
    rows = conn.execute(
        f"SELECT name FROM sqlite_master WHERE type='table' AND name IN ({placeholders})",
        names,
    ).fetchall()
    present = {str(row[0]) for row in rows}
    missing = sorted(set(names) - present)
    if missing:
        raise RuntimeError(f"Integrity database is missing required tables: {','.join(missing)}")


def resolve_timeseries_ids(
    conn: sqlite3.Connection,
    *,
    connector_id: int,
    pollutants: tuple[str, ...],
) -> list[int]:
    require_tables(
        conn,
        (
            "core_timeseries_snapshot",
            "core_phenomena_snapshot",
            "core_observed_property_mappings_snapshot",
        ),
    )
    pollutant_placeholders = ",".join("?" for _ in pollutants)
    rows = conn.execute(
        f"""
        WITH property_codes AS (
          SELECT
            connector_id,
            observed_property_id,
            MIN(LOWER(TRIM(observed_property_code))) AS observed_property_code,
            COUNT(DISTINCT LOWER(TRIM(observed_property_code))) AS code_count
          FROM core_observed_property_mappings_snapshot
          WHERE is_active = 1
            AND observed_property_id IS NOT NULL
            AND observed_property_code IS NOT NULL
            AND TRIM(observed_property_code) != ''
          GROUP BY connector_id, observed_property_id
        )
        SELECT DISTINCT t.id
        FROM core_timeseries_snapshot t
        JOIN core_phenomena_snapshot p
          ON p.id = t.phenomenon_id
        JOIN property_codes m
          ON m.connector_id = t.connector_id
         AND m.observed_property_id = p.observed_property_id
        WHERE t.connector_id = ?
          AND t.id IS NOT NULL
          AND t.id > 0
          AND (t.ended_at IS NULL OR TRIM(t.ended_at) = '')
          AND m.code_count = 1
          AND m.observed_property_code IN ({pollutant_placeholders})
        ORDER BY t.id
        """,
        (connector_id, *pollutants),
    ).fetchall()
    return [int(row[0]) for row in rows]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--connector-id", type=int, required=True)
    parser.add_argument("--pollutants", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db_path = Path(args.db_path).expanduser()
    if args.connector_id <= 0:
        raise ValueError("connector-id must be a positive integer")
    if not db_path.is_file():
        raise RuntimeError(f"Integrity database does not exist: {db_path}")
    pollutants = parse_pollutants(args.pollutants)
    with sqlite3.connect(str(db_path)) as conn:
        timeseries_ids = resolve_timeseries_ids(
            conn,
            connector_id=args.connector_id,
            pollutants=pollutants,
        )
    if not timeseries_ids:
        raise RuntimeError(
            "no active timeseries matched the selected Integrity connector and pollutants"
        )
    print(",".join(str(value) for value in timeseries_ids))
    print(
        "resolved Integrity timeseries scope "
        f"connector_id={args.connector_id} pollutants={','.join(pollutants)} "
        f"timeseries_count={len(timeseries_ids)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, sqlite3.Error) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
