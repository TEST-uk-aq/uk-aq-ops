#!/usr/bin/env python3
"""
uk_aq_copy_core_to_live.py

Copies uk_aq_core tables (and optionally uk_aq_raw.uk_air_sos_station_refs)
from test ingestdb to live ingestdb using the Supabase PostgREST REST API
over HTTPS. No direct Postgres connection required.

Required env vars:
  SUPABASE_URL                   test ingestdb project URL
  SB_SECRET_KEY                  test ingestdb service role key
  LIVE_INGESTDB_SUPABASE_URL     live ingestdb project URL
  LIVE_INGESTDB_SB_SECRET_KEY    live ingestdb service role key
    (or LIVE_SB_SECRET_KEY as fallback)

Optional env vars (for automatic sequence reset via Management API):
  SUPABASE_ACCESS_TOKEN          personal access token (sbp_...)
  LIVE_SUPABASE_PROJECT_REF      live ingestdb project ref
    (derived from LIVE_INGESTDB_SUPABASE_URL if not set)

Flags:
  --include-station-refs   also copy uk_aq_raw.uk_air_sos_station_refs
  --dry-run                export from test only, do not write to live
  --skip-sequences         skip sequence reset step
  --batch-size N           rows per upsert batch (default 500)
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PAGE_SIZE = 1000

# (postgrest_table, schema, on_conflict_cols, order_col)
# Order matters: FK dependencies must be satisfied before dependent tables.
CORE_TABLES: list[tuple[str, str, str, str]] = [
    ("observed_properties",          "uk_aq_core", "id",                              "id"),
    ("categories",                   "uk_aq_core", "id",                              "id"),
    ("phenomena",                    "uk_aq_core", "id",                              "id"),
    ("offerings",                    "uk_aq_core", "id",                              "id"),
    ("features",                     "uk_aq_core", "id",                              "id"),
    ("procedures",                   "uk_aq_core", "id",                              "id"),
    ("networks",                     "uk_aq_core", "id",                              "id"),
    ("connectors",                   "uk_aq_core", "id",                              "id"),
    ("uk_air_sos_networks",          "uk_aq_core", "network_ref",                     "network_ref"),
    ("uk_air_sos_network_pollutants","uk_aq_core", "network_ref,match_type,match_value","network_ref"),
    ("stations",                     "uk_aq_core", "id",                              "id"),
    ("station_metadata",             "uk_aq_core", "station_id",                      "station_id"),
    ("timeseries",                   "uk_aq_core", "id",                              "id"),
]

STATION_REFS_TABLE = ("uk_air_sos_station_refs", "uk_aq_raw", "station_id", "station_id")

IDENTITY_TABLES = [
    "uk_aq_core.categories",
    "uk_aq_core.phenomena",
    "uk_aq_core.offerings",
    "uk_aq_core.features",
    "uk_aq_core.procedures",
    "uk_aq_core.connectors",
    "uk_aq_core.stations",
    "uk_aq_core.timeseries",
    "uk_aq_core.networks",
]


def _request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None = None,
    retries: int = 3,
) -> Any:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            msg = exc.read().decode(errors="replace")
            if exc.code == 503 and attempt < retries:
                time.sleep(5 * attempt)
                continue
            raise RuntimeError(f"HTTP {exc.code} {method} {url}: {msg}") from exc
        except urllib.error.URLError as exc:
            if attempt == retries:
                raise RuntimeError(f"Network error {method} {url}: {exc.reason}") from exc
            time.sleep(2 ** attempt)


def fetch_all(base_url: str, key: str, schema: str, table: str, order: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        qs = urllib.parse.urlencode({
            "select": "*",
            "order": order,
            "limit": PAGE_SIZE,
            "offset": offset,
        })
        url = f"{base_url.rstrip('/')}/rest/v1/{table}?{qs}"
        page = _request("GET", url, {
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Accept": "application/json",
            "Accept-Profile": schema,
        })
        if not page:
            break
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def upsert_rows(
    base_url: str,
    key: str,
    schema: str,
    table: str,
    rows: list[dict],
    on_conflict: str,
    batch_size: int,
) -> None:
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        url = f"{base_url.rstrip('/')}/rest/v1/{table}?on_conflict={urllib.parse.quote(on_conflict)}"
        _request("POST", url, {
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Content-Type": "application/json",
            "Content-Profile": schema,
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }, body=json.dumps(batch).encode())


def reset_sequences_via_api(access_token: str, project_ref: str) -> bool:
    sql_parts = [
        f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), "
        f"(SELECT COALESCE(max(id), 1) FROM {t})) "
        f"WHERE EXISTS (SELECT 1 FROM {t});"
        for t in IDENTITY_TABLES
    ]
    sql = "\n".join(sql_parts)
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    try:
        _request("POST", url, {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }, body=json.dumps({"query": sql}).encode())
        return True
    except RuntimeError as exc:
        print(f"    Warning: Management API sequence reset failed: {exc}", file=sys.stderr)
        return False


def derive_project_ref(supabase_url: str) -> str:
    host = urllib.parse.urlsplit(supabase_url).hostname or ""
    return host.split(".")[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--include-station-refs", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-sequences", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()

    src_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    src_key = os.environ.get("SB_SECRET_KEY", "")
    dst_url = os.environ.get("LIVE_INGESTDB_SUPABASE_URL", os.environ.get("LIVE_SUPABASE_URL", "")).rstrip("/")
    dst_key = os.environ.get("LIVE_INGESTDB_SB_SECRET_KEY", os.environ.get("LIVE_SB_SECRET_KEY", ""))

    errors = []
    if not src_url:
        errors.append("SUPABASE_URL is not set")
    if not src_key:
        errors.append("SB_SECRET_KEY is not set")
    if not args.dry_run:
        if not dst_url:
            errors.append("LIVE_INGESTDB_SUPABASE_URL (or LIVE_SUPABASE_URL) is not set")
        if not dst_key:
            errors.append("LIVE_INGESTDB_SB_SECRET_KEY (or LIVE_SB_SECRET_KEY) is not set")
    if errors:
        for e in errors:
            print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    tables = list(CORE_TABLES)
    if args.include_station_refs:
        tables.append(STATION_REFS_TABLE)

    # ── Export ────────────────────────────────────────────────────────────────

    print("=== Phase 3.1: Export from test ===")
    print(f"    Source: {src_url}")
    print()

    exported: dict[str, list[dict]] = {}
    for table, schema, on_conflict, order in tables:
        label = f"{schema}.{table}"
        print(f"  Fetching {label:<60}", end="", flush=True)
        rows = fetch_all(src_url, src_key, schema, table, order)
        exported[label] = rows
        print(f" {len(rows)} rows")

    print()
    total = sum(len(v) for v in exported.values())
    print(f"Export complete. {total} rows across {len(tables)} tables.")

    if args.dry_run:
        print("\n[dry-run] Skipping import, sequence reset, and validation.")
        return

    # ── Import ────────────────────────────────────────────────────────────────

    print()
    print("=== Phase 3.2: Import into live ===")
    print(f"    Dest: {dst_url}")
    print()

    for table, schema, on_conflict, order in tables:
        label = f"{schema}.{table}"
        rows = exported[label]
        print(f"  Upserting {label:<58}", end="", flush=True)
        if rows:
            upsert_rows(dst_url, dst_key, schema, table, rows, on_conflict, args.batch_size)
        print(f" {len(rows)} rows done")

    # ── Connectors: ensure poll_enabled = false ───────────────────────────────

    print()
    print("=== Phase 3.3: Set connectors poll_enabled = false ===")
    # PATCH all connectors via PostgREST (id=gte.1 required — PostgREST rejects updates without a WHERE)
    url = f"{dst_url}/rest/v1/connectors?id=gte.1"
    _request("PATCH", url, {
        "Authorization": f"Bearer {dst_key}",
        "apikey": dst_key,
        "Content-Type": "application/json",
        "Content-Profile": "uk_aq_core",
        "Prefer": "return=minimal",
    }, body=json.dumps({"poll_enabled": False}).encode())
    print("    Done.")

    # ── Sequence reset ────────────────────────────────────────────────────────

    if not args.skip_sequences:
        print()
        print("=== Phase 3.4: Reset identity sequences ===")
        access_token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
        live_ref = os.environ.get("LIVE_SUPABASE_PROJECT_REF", derive_project_ref(dst_url))

        if access_token and live_ref:
            print(f"    Using Management API for project {live_ref}...")
            ok = reset_sequences_via_api(access_token, live_ref)
            if ok:
                print("    Done.")
            else:
                _print_sequence_sql()
        else:
            print("    SUPABASE_ACCESS_TOKEN or live project ref not available.")
            _print_sequence_sql()

    # ── Validation ────────────────────────────────────────────────────────────

    print()
    print("=== Phase 3.5: Validation ===")
    print()
    print(f"  {'Table':<45} {'Live rows':>10}  {'Test rows':>10}")
    print(f"  {'-'*45} {'-'*10}  {'-'*10}")

    for table, schema, on_conflict, order in CORE_TABLES:
        label = f"{schema}.{table}"
        live_rows = fetch_all(dst_url, dst_key, schema, table, order)
        test_count = len(exported[label])
        live_count = len(live_rows)
        flag = "" if live_count == test_count else "  ← MISMATCH"
        print(f"  {label:<45} {live_count:>10}  {test_count:>10}{flag}")

    print()
    print("Done. Core DB population complete.")
    print("Next steps:")
    print("  - Phase 4: Copy R2 history")
    print("  - Run schemas/obs_aqi_db/uk_aq_core_mirror_rpcs.sql against live obs_aqidb")


def _print_sequence_sql() -> None:
    print("    Run this SQL manually in the Supabase SQL editor for live ingestdb:")
    print()
    for t in IDENTITY_TABLES:
        print(f"    SELECT setval(pg_get_serial_sequence('{t}', 'id'), (SELECT COALESCE(max(id), 1) FROM {t}));")
    print()


if __name__ == "__main__":
    main()
