#!/usr/bin/env bash
set -euo pipefail

DAY_UTC="${1:-2025-01-01}"
CONNECTOR_ID="${UK_AQ_WHO_2021_CONNECTOR_ID:-1}"
OUT_DIR="${2:-tmp/who_2021_diagnostic_${DAY_UTC}}"

python3 - "$DAY_UTC" >/dev/null <<'PY'
import datetime as dt, sys
try:
    dt.date.fromisoformat(sys.argv[1])
except ValueError as exc:
    raise SystemExit(f"Invalid UTC day: {sys.argv[1]}") from exc
PY

NEXT_DAY="$(python3 - "$DAY_UTC" <<'PY'
import datetime as dt, sys
print((dt.date.fromisoformat(sys.argv[1]) + dt.timedelta(days=1)).isoformat())
PY
)"

: "${CFLARE_R2_ENDPOINT:?CFLARE_R2_ENDPOINT is required}"
: "${CFLARE_R2_BUCKET:?CFLARE_R2_BUCKET is required}"
: "${CFLARE_R2_ACCESS_KEY_ID:?CFLARE_R2_ACCESS_KEY_ID is required}"
: "${CFLARE_R2_SECRET_ACCESS_KEY:?CFLARE_R2_SECRET_ACCESS_KEY is required}"

mkdir -p "$OUT_DIR"
CSV_PATH="$OUT_DIR/who_prepared_timeseries_${DAY_UTC}.csv"
SQL_PATH="$OUT_DIR/who_obs_aqidb_diagnostic_${DAY_UTC}.sql"
ENDPOINT="${CFLARE_R2_ENDPOINT#https://}"
ENDPOINT="${ENDPOINT#http://}"
ENDPOINT="${ENDPOINT%/}"
REGION="${CFLARE_R2_REGION:-auto}"

paths=()
for day in "$DAY_UTC" "$NEXT_DAY"; do
  for pollutant in pm25 pm10 no2; do
    paths+=("'s3://${CFLARE_R2_BUCKET}/history/v2/observations/day_utc=${day}/connector_id=${CONNECTOR_ID}/pollutant_code=${pollutant}/*.parquet'")
  done
done
IFS=,
R2_PATHS="${paths[*]}"
unset IFS

echo "Extracting the exact WHO source window: (${DAY_UTC} 00:00, ${NEXT_DAY} 00:00] UTC"

duckdb -c "
INSTALL httpfs;
LOAD httpfs;

CREATE OR REPLACE TEMPORARY SECRET r2_who_diag (
  TYPE s3,
  KEY_ID '${CFLARE_R2_ACCESS_KEY_ID}',
  SECRET '${CFLARE_R2_SECRET_ACCESS_KEY}',
  REGION '${REGION}',
  ENDPOINT '${ENDPOINT}',
  URL_STYLE 'path',
  USE_SSL true
);

COPY (
  WITH source_rows AS (
    SELECT
      CAST(timeseries_id AS INTEGER) AS timeseries_id,
      CAST(connector_id AS INTEGER) AS r2_connector_id,
      CAST(station_id AS BIGINT) AS r2_station_id,
      LOWER(CAST(pollutant_code AS VARCHAR)) AS r2_pollutant_code,
      CAST(observed_at_utc AS TIMESTAMPTZ) AS observed_at_utc
    FROM read_parquet(
      [${R2_PATHS}],
      hive_partitioning = true,
      union_by_name = true
    )
    WHERE CAST(connector_id AS INTEGER) = ${CONNECTOR_ID}
      AND LOWER(CAST(pollutant_code AS VARCHAR)) IN ('pm25', 'pm10', 'no2')
      AND CAST(observed_at_utc AS TIMESTAMPTZ) > TIMESTAMPTZ '${DAY_UTC} 00:00:00+00'
      AND CAST(observed_at_utc AS TIMESTAMPTZ) <= TIMESTAMPTZ '${NEXT_DAY} 00:00:00+00'
  )
  SELECT
    timeseries_id,
    MIN(r2_connector_id) AS r2_connector_id,
    MIN(r2_station_id) AS r2_station_id,
    MIN(r2_pollutant_code) AS r2_pollutant_code,
    MIN(observed_at_utc) AS first_observed_at_utc,
    MAX(observed_at_utc) AS last_observed_at_utc,
    COUNT(*) AS source_row_count,
    COUNT(DISTINCT r2_station_id) AS distinct_station_count,
    COUNT(DISTINCT r2_pollutant_code) AS distinct_pollutant_count
  FROM source_rows
  GROUP BY timeseries_id
  ORDER BY timeseries_id
) TO '${CSV_PATH}' (HEADER, DELIMITER ',');
"

python3 - "$CSV_PATH" "$SQL_PATH" "$DAY_UTC" "$NEXT_DAY" "$CONNECTOR_ID" <<'PY'
import csv
import datetime as dt
import pathlib
import sys

csv_path = pathlib.Path(sys.argv[1])
sql_path = pathlib.Path(sys.argv[2])
day = sys.argv[3]
next_day = sys.argv[4]
connector_id = int(sys.argv[5])

def sql_text(value):
    if value is None or value == "":
        return "null"
    return "'" + value.replace("'", "''") + "'"

def sql_int(value):
    if value is None or value == "":
        return "null"
    return str(int(value))

with csv_path.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

values = []
for row in rows:
    values.append(
        "(" + ", ".join([
            sql_int(row["timeseries_id"]),
            sql_int(row["r2_connector_id"]),
            sql_int(row["r2_station_id"]),
            sql_text(row["r2_pollutant_code"]),
            sql_text(row["first_observed_at_utc"]) + "::timestamptz",
            sql_text(row["last_observed_at_utc"]) + "::timestamptz",
            sql_int(row["source_row_count"]),
            sql_int(row["distinct_station_count"]),
            sql_int(row["distinct_pollutant_count"]),
        ]) + ")"
    )

sql = f"""-- Generated from LIVE R2 WHO source data.
-- WHO day window: ({day} 00:00, {next_day} 00:00] UTC
-- Expected prepared row count from the failed run: 537.
-- Run this in the LIVE Obs AQIDB SQL editor. It is read-only apart from a temporary table.

begin;

create temporary table tmp_who_r2_prepared (
  timeseries_id integer primary key,
  r2_connector_id integer,
  r2_station_id bigint,
  r2_pollutant_code text,
  first_observed_at_utc timestamptz,
  last_observed_at_utc timestamptz,
  source_row_count bigint,
  distinct_station_count bigint,
  distinct_pollutant_count bigint
) on commit drop;

insert into tmp_who_r2_prepared values
{',\n'.join(values)};

-- 1. Confirm that the extracted set matches the worker report.
select
  count(*) as extracted_prepared_timeseries,
  min(first_observed_at_utc) as earliest_observation,
  max(last_observed_at_utc) as latest_observation
from tmp_who_r2_prepared;

create temporary table tmp_who_classified on commit drop as
select
  r2.timeseries_id,
  r2.r2_connector_id,
  r2.r2_station_id,
  r2.r2_pollutant_code,
  r2.first_observed_at_utc,
  r2.last_observed_at_utc,
  r2.source_row_count,
  r2.distinct_station_count,
  r2.distinct_pollutant_count,
  ts.id as core_timeseries_id,
  ts.connector_id as core_connector_id,
  ts.station_id as core_station_id,
  ts.phenomenon_id,
  p.connector_id as phenomenon_connector_id,
  lower(op.code) as core_pollutant_code,
  ts.first_value_at,
  ts.ended_at,
  case
    when ts.id is null then 'missing_timeseries'
    when ts.connector_id <> {connector_id} then 'connector_mismatch'
    when ts.station_id is null then 'station_id_null'
    when p.id is null then 'missing_phenomenon'
    when p.connector_id <> ts.connector_id then 'phenomenon_connector_mismatch'
    when op.id is null then 'missing_observed_property'
    when lower(op.code) not in ('pm25', 'pm10', 'no2') then 'pollutant_not_requested'
    when ts.first_value_at is null then 'first_value_at_null'
    when ts.first_value_at > timestamptz '{next_day} 00:00:00+00' then 'first_value_at_after_day_end'
    when ts.ended_at is not null
      and ts.ended_at < timestamptz '{day} 00:00:00+00'
      then 'ended_before_day_start'
    else 'eligible'
  end as rpc_eligibility,
  nullif(concat_ws(', ',
    case when r2.r2_connector_id <> ts.connector_id then 'r2_connector_differs_from_core' end,
    case when r2.r2_station_id is distinct from ts.station_id then 'r2_station_differs_from_core' end,
    case when r2.r2_pollutant_code is distinct from lower(op.code) then 'r2_pollutant_differs_from_core' end,
    case when r2.distinct_station_count <> 1 then 'multiple_r2_stations_for_id' end,
    case when r2.distinct_pollutant_count <> 1 then 'multiple_r2_pollutants_for_id' end
  ), '') as mapping_warning
from tmp_who_r2_prepared r2
left join uk_aq_core.timeseries ts
  on ts.id = r2.timeseries_id
left join uk_aq_core.phenomena p
  on p.id = ts.phenomenon_id
 and p.connector_id = ts.connector_id
left join uk_aq_core.observed_properties op
  on op.id = p.observed_property_id;

-- 2. This should show exactly which broad RPC condition failed.
select
  rpc_eligibility,
  count(*) as timeseries_count
from tmp_who_classified
group by rpc_eligibility
order by
  case when rpc_eligibility = 'eligible' then 1 else 0 end,
  rpc_eligibility;

-- 3. Full rejected rows, with current metadata.
select *
from tmp_who_classified
where rpc_eligibility <> 'eligible'
order by rpc_eligibility, timeseries_id;

-- 4. Mapping inconsistencies that would not necessarily trigger the current RPC error,
-- but could silently apply the wrong station or pollutant identity.
select *
from tmp_who_classified
where mapping_warning is not null
order by timeseries_id;

-- 5. Boundary-only IDs. These are present at the D+1 midnight boundary but have
-- no earlier observation in the WHO day window. They are the main scope-mismatch suspects.
select *
from tmp_who_classified
where first_observed_at_utc = timestamptz '{next_day} 00:00:00+00'
order by timeseries_id;

rollback;
"""

sql_path.write_text(sql, encoding="utf-8")
print(f"Prepared IDs: {len(rows)}")
print(f"CSV: {csv_path}")
print(f"SQL: {sql_path}")
PY

echo
echo "Run the generated SQL in the LIVE Obs AQIDB SQL editor:"
echo "  ${SQL_PATH}"
