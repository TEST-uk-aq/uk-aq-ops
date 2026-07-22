#!/usr/bin/env python3
"""Local operator interface for Integrity-owned UK-AIR source-label decisions."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
from pathlib import Path


SUPPORTED = {"pm25", "pm10", "no2", "o3"}


def normalise_label(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def default_db_path(env_name: str) -> Path:
    state_dir = os.environ.get("UK_AQ_HISTORY_INTEGRITY_STATE_DIR", "").strip()
    if state_dir:
        return Path(state_dir) / "uk_aq_history_integrity.sqlite"
    local_root = Path(os.environ.get("UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT", "").strip() or (Path.home() / "uk-aq-history-integrity"))
    return local_root / "state" / env_name / "uk_aq_history_integrity.sqlite"


def print_row(row: sqlite3.Row | None) -> None:
    if row is None:
        print("not found")
        return
    print(json.dumps(dict(row), indent=2, sort_keys=True))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=["CIC-Test", "LIVE"], default="CIC-Test")
    parser.add_argument("--db-path", type=Path, default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    list_cmd = sub.add_parser("list")
    list_cmd.add_argument("--status", choices=["mapped", "ignore", "review"], default=None)
    show_cmd = sub.add_parser("show")
    show_cmd.add_argument("--label", required=True)
    set_cmd = sub.add_parser("set")
    set_cmd.add_argument("--label", required=True)
    set_cmd.add_argument("--status", required=True, choices=["mapped", "ignore", "review"])
    set_cmd.add_argument("--pollutant-code", choices=sorted(SUPPORTED), default=None)
    set_cmd.add_argument("--expected-uom", default=None)
    set_cmd.add_argument("--notes", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = args.db_path or default_db_path(args.env)
    print(f"Integrity SQLite DB: {db_path}")
    if not db_path.is_file():
        raise SystemExit(f"Integrity SQLite DB not found: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if args.command == "list":
            sql = "SELECT normalised_source_label,status,pollutant_code,expected_uom,last_seen_at_utc,review_notes FROM uk_air_csv_source_labels WHERE connector_id=1"
            params: tuple[object, ...] = ()
            if args.status:
                sql += " AND status=?"
                params = (args.status,)
            for row in conn.execute(sql + " ORDER BY normalised_source_label", params):
                print(json.dumps(dict(row), sort_keys=True))
            return 0
        key = normalise_label(args.label)
        row = conn.execute(
            "SELECT * FROM uk_air_csv_source_labels WHERE connector_id=1 AND normalised_source_label=?", (key,),
        ).fetchone()
        if args.command == "show":
            print_row(row)
            return 0 if row is not None else 1
        if row is None:
            raise SystemExit("label has not been discovered by Integrity; run the SOS scan before setting a decision")
        existing_status = str(row["status"] or "")
        existing_code = str(row["pollutant_code"] or "").strip() or None
        existing_uom = str(row["expected_uom"] or "").strip() or None
        pollutant_code = args.pollutant_code or (existing_code if args.status == "mapped" and existing_status == "mapped" else None)
        expected_uom = str(args.expected_uom or "").strip() or (existing_uom if args.status == "mapped" and existing_status == "mapped" else None)
        if args.status == "mapped" and not pollutant_code:
            raise SystemExit("mapped requires --pollutant-code pm25|pm10|no2|o3")
        if args.status == "mapped" and not expected_uom:
            raise SystemExit("mapped requires a non-empty --expected-uom")
        if args.status != "mapped" and args.pollutant_code:
            raise SystemExit("ignore and review do not accept --pollutant-code")
        if args.status != "mapped" and args.expected_uom:
            raise SystemExit("ignore and review do not accept --expected-uom")
        print("before:")
        print_row(row)
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        conn.execute(
            """UPDATE uk_air_csv_source_labels
               SET status=?, pollutant_code=?, expected_uom=?, reviewed_at_utc=?, review_notes=?
               WHERE connector_id=1 AND normalised_source_label=?""",
            (args.status, pollutant_code if args.status == "mapped" else None,
             expected_uom if args.status == "mapped" else None, now, args.notes, key),
        )
        conn.commit()
        print("after:")
        print_row(conn.execute(
            "SELECT * FROM uk_air_csv_source_labels WHERE connector_id=1 AND normalised_source_label=?", (key,),
        ).fetchone())
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
