#!/usr/bin/env bash
# uk_aq_copy_core_to_live.sh
#
# Copies uk_aq_core tables (and optionally uk_aq_raw.uk_air_sos_station_refs)
# from test ingestdb to live ingestdb using psql \copy (CSV) — works through
# the Supabase session pooler without requiring a direct DB connection.
#
# Required env vars:
#   SUPABASE_DB_URL              — test ingestdb (source)
#   LIVE_INGESTDB_SUPABASE_DB_URL  or  LIVE_SUPABASE_DB_URL  — live ingestdb (dest)
#
# Optional flags:
#   --include-station-refs   also copy uk_aq_raw.uk_air_sos_station_refs
#   --dry-run                export only, do not import
#   --skip-sequences         skip identity sequence reset step
#   --help

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

# Tables with identity sequences that need resetting after import
IDENTITY_TABLES=(
  "uk_aq_core.categories"
  "uk_aq_core.phenomena"
  "uk_aq_core.offerings"
  "uk_aq_core.features"
  "uk_aq_core.procedures"
  "uk_aq_core.connectors"
  "uk_aq_core.stations"
  "uk_aq_core.timeseries"
)

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_WORK}"' EXIT

csv_path() {
  local table="$1"
  echo "${TMPDIR_WORK}/${table//\./__}.csv"
}

row_count() {
  local file="$1"
  local lines
  lines="$(wc -l < "${file}")"
  echo $(( lines - 1 ))
}

# ─── Export ───────────────────────────────────────────────────────────────────

echo "=== Phase 3.1: Export from test ==="
echo "    Source: ${SRC_URL%%@*}@..."
echo ""

for table in "${CORE_TABLES[@]}"; do
  file="$(csv_path "${table}")"
  printf "  Exporting %-55s" "${table}..."
  psql "${SRC_URL}" --no-psqlrc -q \
    -c "\copy (SELECT * FROM ${table}) TO STDOUT (FORMAT CSV, HEADER)" \
    > "${file}"
  printf " %d rows\n" "$(row_count "${file}")"
done

if [[ "${INCLUDE_STATION_REFS}" -eq 1 ]]; then
  table="uk_aq_raw.uk_air_sos_station_refs"
  file="$(csv_path "${table}")"
  printf "  Exporting %-55s" "${table}..."
  psql "${SRC_URL}" --no-psqlrc -q \
    -c "\copy (SELECT * FROM ${table}) TO STDOUT (FORMAT CSV, HEADER)" \
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
echo "    Dest: ${DST_URL%%@*}@..."
echo ""

for table in "${CORE_TABLES[@]}"; do
  file="$(csv_path "${table}")"
  printf "  Importing %-55s" "${table}..."
  psql "${DST_URL}" --no-psqlrc -q \
    -c "\copy ${table} FROM STDIN (FORMAT CSV, HEADER)" \
    < "${file}"
  printf " done\n"
done

if [[ "${INCLUDE_STATION_REFS}" -eq 1 ]]; then
  table="uk_aq_raw.uk_air_sos_station_refs"
  file="$(csv_path "${table}")"
  printf "  Importing %-55s" "${table}..."
  psql "${DST_URL}" --no-psqlrc -q \
    -c "\copy ${table} FROM STDIN (FORMAT CSV, HEADER)" \
    < "${file}"
  printf " done\n"
fi

# ─── Connectors: ensure poll_enabled = false ──────────────────────────────────

echo ""
echo "=== Phase 3.3: Set connectors poll_enabled = false ==="
psql "${DST_URL}" --no-psqlrc -q \
  -c "UPDATE uk_aq_core.connectors SET poll_enabled = false;"
echo "    Done."

# ─── Sequence reset ───────────────────────────────────────────────────────────

if [[ "${SKIP_SEQUENCES}" -eq 0 ]]; then
  echo ""
  echo "=== Phase 3.4: Reset identity sequences ==="
  psql "${DST_URL}" --no-psqlrc -q <<'SQL'
SELECT
  pg_get_serial_sequence(t, 'id') AS seq,
  setval(pg_get_serial_sequence(t, 'id'), (SELECT max(id) FROM uk_aq_core.categories)) AS val
FROM (VALUES ('uk_aq_core.categories')) AS v(t)
WHERE EXISTS (SELECT 1 FROM uk_aq_core.categories);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.phenomena', 'id'),
    (SELECT max(id) FROM uk_aq_core.phenomena))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.phenomena);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.offerings', 'id'),
    (SELECT max(id) FROM uk_aq_core.offerings))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.offerings);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.features', 'id'),
    (SELECT max(id) FROM uk_aq_core.features))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.features);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.procedures', 'id'),
    (SELECT max(id) FROM uk_aq_core.procedures))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.procedures);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.connectors', 'id'),
    (SELECT max(id) FROM uk_aq_core.connectors))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.connectors);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.stations', 'id'),
    (SELECT max(id) FROM uk_aq_core.stations))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.stations);

SELECT
  setval(pg_get_serial_sequence('uk_aq_core.timeseries', 'id'),
    (SELECT max(id) FROM uk_aq_core.timeseries))
WHERE EXISTS (SELECT 1 FROM uk_aq_core.timeseries);
SQL
  echo "    Done."
fi

# ─── Validation ───────────────────────────────────────────────────────────────

echo ""
echo "=== Phase 3.5: Validation ==="
echo ""
echo "  Live row counts:"
psql "${DST_URL}" --no-psqlrc -q <<'SQL'
SELECT
  table_name AS "table",
  (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM uk_aq_core.%I', table_name), false, true, ''
  )))[1]::text::int AS "rows"
FROM information_schema.tables
WHERE table_schema = 'uk_aq_core'
  AND table_type = 'BASE TABLE'
  AND table_name IN (
    'categories','observed_properties','phenomena','offerings','features',
    'procedures','uk_aq_networks','uk_air_sos_networks',
    'uk_air_sos_network_pollutants','connectors','stations',
    'station_metadata','station_network_memberships','timeseries'
  )
ORDER BY table_name;
SQL

echo ""
echo "  Connector poll_enabled check (all should be false):"
psql "${DST_URL}" --no-psqlrc -q \
  -c "SELECT connector_code, poll_enabled FROM uk_aq_core.connectors ORDER BY id;"

echo ""
echo "Done. Core DB population complete."
echo "Next steps:"
echo "  - Phase 4: Copy R2 history"
echo "  - Run uk_aq_core_mirror_rpcs.sql against live obs_aqidb to populate mirror tables"
