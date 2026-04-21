#!/usr/bin/env bash
# uk_aq_copy_core_to_live.sh
#
# Copies uk_aq_core tables (and optionally uk_aq_raw.uk_air_sos_station_refs)
# from test ingestdb to live ingestdb using psql \copy (CSV).
#
# Parses Postgres URLs with Python and passes credentials via PGPASSWORD +
# explicit flags — avoids libpq URL-decoding bugs with special chars (%23 etc).
#
# Required env vars:
#   SUPABASE_DB_URL                          test ingestdb (source)
#   LIVE_INGESTDB_SUPABASE_DB_URL            live ingestdb (dest)
#     or LIVE_SUPABASE_DB_URL                (fallback name)
#
# Optional flags:
#   --include-station-refs   also copy uk_aq_raw.uk_air_sos_station_refs
#   --dry-run                export only, do not import
#   --skip-sequences         skip identity sequence reset step
#   -h, --help

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/uk_aq_copy_core_to_live.sh [options]

Options:
  --include-station-refs   Also copy uk_aq_raw.uk_air_sos_station_refs
  --dry-run                Export from test only; do not write to live
  --skip-sequences         Skip identity sequence reset after import
  -h, --help               Show this help

Required env vars:
  SUPABASE_DB_URL                      Test ingestdb (source)
  LIVE_INGESTDB_SUPABASE_DB_URL        Live ingestdb (dest)
    or LIVE_SUPABASE_DB_URL            (fallback name)
EOF
}

INCLUDE_STATION_REFS=0
DRY_RUN=0
SKIP_SEQUENCES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-station-refs) INCLUDE_STATION_REFS=1; shift ;;
    --dry-run)              DRY_RUN=1; shift ;;
    --skip-sequences)       SKIP_SEQUENCES=1; shift ;;
    -h|--help)              usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

SRC_URL="${SUPABASE_DB_URL:-}"
DST_URL="${LIVE_INGESTDB_SUPABASE_DB_URL:-${LIVE_SUPABASE_DB_URL:-}}"

if [[ -z "${SRC_URL}" ]]; then
  echo "Error: SUPABASE_DB_URL is not set." >&2
  exit 1
fi
if [[ -z "${DST_URL}" ]] && [[ "${DRY_RUN}" -eq 0 ]]; then
  echo "Error: LIVE_INGESTDB_SUPABASE_DB_URL (or LIVE_SUPABASE_DB_URL) is not set." >&2
  exit 1
fi

# Parse a postgres:// URL into shell variables using Python (handles %xx decoding).
# For *.pooler.supabase.com hosts, forces port 6543 (transaction mode pooler)
# regardless of what the URL says — port 5432 (session mode) is unreliable.
# Single-connection psql \copy works correctly in transaction mode.
# Emits: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE as export statements.
parse_pg_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlsplit, unquote

raw = sys.argv[1]
p = urlsplit(raw)
host = p.hostname or ""
port = str(p.port) if p.port else "5432"
# Supabase regional pooler (aws-X-region.pooler.supabase.com): use transaction
# mode port 6543 — session mode (5432) drops connections for psql clients.
if host.endswith(".pooler.supabase.com") and port == "5432":
    port = "6543"
user = unquote(p.username or "")
password = unquote(p.password or "")
database = (p.path or "/postgres").lstrip("/") or "postgres"
print(f"PGHOST={host}")
print(f"PGPORT={port}")
print(f"PGUSER={user}")
print(f"PGPASSWORD={password}")
print(f"PGDATABASE={database}")
PY
}

# Load parsed connection vars into the environment for a given URL.
# Usage: load_conn SRC|DST <url>  — sets globals SRC_* or DST_* vars.
load_conn_src() {
  local parsed
  parsed="$(parse_pg_url "$1")"
  eval "$(echo "${parsed}" | sed 's/^/export SRC_/')"
}
load_conn_dst() {
  local parsed
  parsed="$(parse_pg_url "$1")"
  eval "$(echo "${parsed}" | sed 's/^/export DST_/')"
}

load_conn_src "${SRC_URL}"
if [[ -n "${DST_URL}" ]]; then
  load_conn_dst "${DST_URL}"
fi

# Run psql against the source DB.
psql_src() {
  PGPASSWORD="${SRC_PGPASSWORD}" psql \
    -h "${SRC_PGHOST}" -p "${SRC_PGPORT}" \
    -U "${SRC_PGUSER}" -d "${SRC_PGDATABASE}" \
    --no-psqlrc -q "$@"
}

# Run psql against the destination DB.
psql_dst() {
  PGPASSWORD="${DST_PGPASSWORD}" psql \
    -h "${DST_PGHOST}" -p "${DST_PGPORT}" \
    -U "${DST_PGUSER}" -d "${DST_PGDATABASE}" \
    --no-psqlrc -q "$@"
}

# uk_aq_core tables in FK dependency order
CORE_TABLES=(
  "uk_aq_core.categories"
  "uk_aq_core.observed_properties"
  "uk_aq_core.phenomena"
  "uk_aq_core.offerings"
  "uk_aq_core.features"
  "uk_aq_core.procedures"
  "uk_aq_core.uk_aq_networks"
  "uk_aq_core.uk_air_sos_networks"
  "uk_aq_core.uk_air_sos_network_pollutants"
  "uk_aq_core.connectors"
  "uk_aq_core.stations"
  "uk_aq_core.station_metadata"
  "uk_aq_core.station_network_memberships"
  "uk_aq_core.timeseries"
)

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_WORK}"' EXIT

csv_path() {
  echo "${TMPDIR_WORK}/${1//\./__}.csv"
}

row_count() {
  echo $(( $(wc -l < "$1") - 1 ))
}

# ─── Export ───────────────────────────────────────────────────────────────────

echo "=== Phase 3.1: Export from test ==="
echo "    Source: ${SRC_PGUSER}@${SRC_PGHOST}:${SRC_PGPORT}/${SRC_PGDATABASE}"
echo ""

for table in "${CORE_TABLES[@]}"; do
  file="$(csv_path "${table}")"
  printf "  Exporting %-55s" "${table}..."
  psql_src -c "\copy (SELECT * FROM ${table}) TO STDOUT (FORMAT CSV, HEADER)" \
    > "${file}"
  printf " %d rows\n" "$(row_count "${file}")"
done

if [[ "${INCLUDE_STATION_REFS}" -eq 1 ]]; then
  file="$(csv_path "uk_aq_raw.uk_air_sos_station_refs")"
  printf "  Exporting %-55s" "uk_aq_raw.uk_air_sos_station_refs..."
  psql_src -c "\copy (SELECT * FROM uk_aq_raw.uk_air_sos_station_refs) TO STDOUT (FORMAT CSV, HEADER)" \
    > "${file}"
  printf " %d rows\n" "$(row_count "${file}")"
fi

echo ""
echo "Export complete. Files in: ${TMPDIR_WORK}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo ""
  echo "[dry-run] Skipping import, sequence reset, and validation."
  exit 0
fi

# ─── Import ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Phase 3.2: Import into live ==="
echo "    Dest: ${DST_PGUSER}@${DST_PGHOST}:${DST_PGPORT}/${DST_PGDATABASE}"
echo ""

for table in "${CORE_TABLES[@]}"; do
  file="$(csv_path "${table}")"
  printf "  Importing %-55s" "${table}..."
  psql_dst -c "\copy ${table} FROM STDIN (FORMAT CSV, HEADER)" < "${file}"
  printf " done\n"
done

if [[ "${INCLUDE_STATION_REFS}" -eq 1 ]]; then
  file="$(csv_path "uk_aq_raw.uk_air_sos_station_refs")"
  printf "  Importing %-55s" "uk_aq_raw.uk_air_sos_station_refs..."
  psql_dst -c "\copy uk_aq_raw.uk_air_sos_station_refs FROM STDIN (FORMAT CSV, HEADER)" < "${file}"
  printf " done\n"
fi

# ─── Connectors: ensure poll_enabled = false ──────────────────────────────────

echo ""
echo "=== Phase 3.3: Set connectors poll_enabled = false ==="
psql_dst -c "UPDATE uk_aq_core.connectors SET poll_enabled = false;"
echo "    Done."

# ─── Sequence reset ───────────────────────────────────────────────────────────

if [[ "${SKIP_SEQUENCES}" -eq 0 ]]; then
  echo ""
  echo "=== Phase 3.4: Reset identity sequences ==="
  psql_dst <<'SQL'
SELECT setval(pg_get_serial_sequence('uk_aq_core.categories',   'id'), max(id)) FROM uk_aq_core.categories   WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.phenomena',    'id'), max(id)) FROM uk_aq_core.phenomena    WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.offerings',    'id'), max(id)) FROM uk_aq_core.offerings    WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.features',     'id'), max(id)) FROM uk_aq_core.features     WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.procedures',   'id'), max(id)) FROM uk_aq_core.procedures   WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.connectors',   'id'), max(id)) FROM uk_aq_core.connectors   WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.stations',     'id'), max(id)) FROM uk_aq_core.stations     WHERE id IS NOT NULL;
SELECT setval(pg_get_serial_sequence('uk_aq_core.timeseries',   'id'), max(id)) FROM uk_aq_core.timeseries   WHERE id IS NOT NULL;
SQL
  echo "    Done."
fi

# ─── Validation ───────────────────────────────────────────────────────────────

echo ""
echo "=== Phase 3.5: Validation ==="
echo ""
echo "  Live row counts:"
psql_dst <<'SQL'
SELECT 'categories'                  AS "table", count(*) FROM uk_aq_core.categories
UNION ALL SELECT 'observed_properties',           count(*) FROM uk_aq_core.observed_properties
UNION ALL SELECT 'phenomena',                     count(*) FROM uk_aq_core.phenomena
UNION ALL SELECT 'offerings',                     count(*) FROM uk_aq_core.offerings
UNION ALL SELECT 'features',                      count(*) FROM uk_aq_core.features
UNION ALL SELECT 'procedures',                    count(*) FROM uk_aq_core.procedures
UNION ALL SELECT 'uk_aq_networks',                count(*) FROM uk_aq_core.uk_aq_networks
UNION ALL SELECT 'uk_air_sos_networks',           count(*) FROM uk_aq_core.uk_air_sos_networks
UNION ALL SELECT 'uk_air_sos_network_pollutants', count(*) FROM uk_aq_core.uk_air_sos_network_pollutants
UNION ALL SELECT 'connectors',                    count(*) FROM uk_aq_core.connectors
UNION ALL SELECT 'stations',                      count(*) FROM uk_aq_core.stations
UNION ALL SELECT 'station_metadata',              count(*) FROM uk_aq_core.station_metadata
UNION ALL SELECT 'station_network_memberships',   count(*) FROM uk_aq_core.station_network_memberships
UNION ALL SELECT 'timeseries',                    count(*) FROM uk_aq_core.timeseries
ORDER BY 1;
SQL

echo ""
echo "  Connector poll_enabled check (all should be false):"
psql_dst -c "SELECT connector_code, poll_enabled FROM uk_aq_core.connectors ORDER BY id;"

echo ""
echo "Done. Core DB population complete."
echo "Next steps:"
echo "  - Phase 4: Copy R2 history"
echo "  - Run schemas/obs_aqi_db/uk_aq_core_mirror_rpcs.sql against live obs_aqidb"
