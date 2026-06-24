#!/usr/bin/env bash
set -euo pipefail

CONNECTOR_ID=""
FROM_DAY=""
TO_DAY=""
POLLUTANT="pm25"
TIMESERIES_ID="218"
OUT_DIR=""
OBS_TIME_COL=""
OBS_VALUE_COL=""
AQI_TIME_COL=""

usage() {
  cat <<'EOF'
Usage:
  scripts/r2_query/query_r2_v2_observs_aqilevels.sh \
    --connector-id 1 \
    --from-day 2026-06-18 \
    --to-day 2026-06-23 \
    [--pollutant pm25|pm10|no2|o3|all] \
    [--timeseries-id 218] \
    [--obs-time-col observed_at_utc] \
    [--obs-value-col value] \
    [--aqi-time-col timestamp_hour_utc] \
    [--out tmp/custom_output_dir]

Required:
  --connector-id    Connector id, e.g. 1
  --from-day        Start day, YYYY-MM-DD
  --to-day          End day, YYYY-MM-DD

Defaults:
  --pollutant       pm25
  --timeseries-id   218

Purpose:
  Copy v2 observations and v2 AQI hourly data from R2, then join them by
  timeseries_id and hour so the output includes the observation value beside
  DAQI/EAQI status columns.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connector-id)
      CONNECTOR_ID="${2:-}"
      shift 2
      ;;
    --from-day)
      FROM_DAY="${2:-}"
      shift 2
      ;;
    --to-day)
      TO_DAY="${2:-}"
      shift 2
      ;;
    --pollutant)
      POLLUTANT="${2:-}"
      shift 2
      ;;
    --timeseries-id)
      TIMESERIES_ID="${2:-}"
      shift 2
      ;;
    --obs-time-col)
      OBS_TIME_COL="${2:-}"
      shift 2
      ;;
    --obs-value-col)
      OBS_VALUE_COL="${2:-}"
      shift 2
      ;;
    --aqi-time-col)
      AQI_TIME_COL="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$CONNECTOR_ID" || -z "$FROM_DAY" || -z "$TO_DAY" ]]; then
  echo "Missing required flags." >&2
  usage >&2
  exit 2
fi

if [[ -z "${CFLARE_R2_BUCKET:-}" ]]; then
  echo "CFLARE_R2_BUCKET is not set." >&2
  exit 2
fi

for cmd in rclone jq duckdb python3 perl awk grep sed find sort wc tr; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

duckdb_clean() {
  TERM=dumb NO_COLOR=1 duckdb "$@" | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g'
}

duckdb_csv() {
  TERM=dumb NO_COLOR=1 duckdb -csv "$@"
}

tsv_box() {
  local tmp_tsv
  tmp_tsv="$(mktemp "${TMPDIR:-/tmp}/r2_joined_table.XXXXXX.tsv")"

  cat > "$tmp_tsv"

  python3 - "$tmp_tsv" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
raw = [line.rstrip("\n") for line in path.read_text(encoding="utf-8", errors="replace").splitlines()]
rows = [line.split("\t") for line in raw if line != ""]

if not rows:
    sys.exit(0)

# DuckDB COPY often writes NULL as an empty field. Make missing values explicit.
rows = [["NULL" if cell == "" else cell for cell in row] for row in rows]

col_count = max(len(row) for row in rows)
for row in rows:
    row.extend(["NULL"] * (col_count - len(row)))

widths = [
    max(len(str(row[i])) for row in rows)
    for i in range(col_count)
]

def border(left: str, mid: str, right: str) -> str:
    return left + mid.join("─" * (width + 2) for width in widths) + right

def row_line(row) -> str:
    return "│ " + " │ ".join(str(row[i]).ljust(widths[i]) for i in range(col_count)) + " │"

print(border("┌", "┬", "┐"))
print(row_line(rows[0]))
print(border("├", "┼", "┤"))
for row in rows[1:]:
    print(row_line(row))
print(border("└", "┴", "┘"))
PY

  local status=$?
  rm -f "$tmp_tsv"
  return "$status"
}


case "$POLLUTANT" in
  pm25|pm10|no2|o3|all) ;;
  *)
    echo "Unsupported pollutant: $POLLUTANT" >&2
    echo "Use pm25, pm10, no2, o3, or all." >&2
    exit 2
    ;;
esac

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="tmp/r2_v2_observs_aqilevels_${FROM_DAY}_to_${TO_DAY}_connector_${CONNECTOR_ID}_${POLLUTANT}_ts_${TIMESERIES_ID}"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "Output directory: $OUT_DIR"
echo "Connector:        $CONNECTOR_ID"
echo "Days:             $FROM_DAY to $TO_DAY"
echo "Pollutant:        $POLLUTANT"
echo "Timeseries ID:    $TIMESERIES_ID"
echo

DAYS=()
while IFS= read -r DAY; do
  DAYS+=("$DAY")
done < <(
  python3 - "$FROM_DAY" "$TO_DAY" <<'PY'
import datetime as dt
import sys

start = dt.date.fromisoformat(sys.argv[1])
end = dt.date.fromisoformat(sys.argv[2])

if end < start:
    raise SystemExit("to-day is before from-day")

day = start
while day <= end:
    print(day.isoformat())
    day += dt.timedelta(days=1)
PY
)

for DAY in "${DAYS[@]}"; do
  OBS_DAY_OUT="$OUT_DIR/observations/day_utc=$DAY"
  AQI_DAY_OUT="$OUT_DIR/aqilevels/day_utc=$DAY"
  mkdir -p "$OBS_DAY_OUT" "$AQI_DAY_OUT"

  OBS_BASE_REMOTE="uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/observations/day_utc=${DAY}/connector_id=${CONNECTOR_ID}"
  AQI_BASE_REMOTE="uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/data/day_utc=${DAY}/connector_id=${CONNECTOR_ID}"

  echo "Copying connector manifests for $DAY"
  rclone cat "${OBS_BASE_REMOTE}/manifest.json" > "$OBS_DAY_OUT/connector_manifest.json" 2>/dev/null || true
  rclone cat "${AQI_BASE_REMOTE}/manifest.json" > "$AQI_DAY_OUT/connector_manifest.json" 2>/dev/null || true

  if [[ "$POLLUTANT" == "all" ]]; then
    echo "Copying v2 observations: $DAY connector_id=$CONNECTOR_ID all pollutants"
    rclone copy -P "${OBS_BASE_REMOTE}/" "$OBS_DAY_OUT/" || true

    echo "Copying v2 AQI hourly:   $DAY connector_id=$CONNECTOR_ID all pollutants"
    rclone copy -P "${AQI_BASE_REMOTE}/" "$AQI_DAY_OUT/" || true
  else
    echo "Copying v2 observations: $DAY connector_id=$CONNECTOR_ID pollutant=$POLLUTANT"
    mkdir -p "$OBS_DAY_OUT/pollutant_code=$POLLUTANT"
    rclone copy -P "${OBS_BASE_REMOTE}/pollutant_code=${POLLUTANT}/" "$OBS_DAY_OUT/pollutant_code=$POLLUTANT/" || true

    echo "Copying v2 AQI hourly:   $DAY connector_id=$CONNECTOR_ID pollutant=$POLLUTANT"
    mkdir -p "$AQI_DAY_OUT/pollutant_code=$POLLUTANT"
    rclone copy -P "${AQI_BASE_REMOTE}/pollutant_code=${POLLUTANT}/" "$AQI_DAY_OUT/pollutant_code=$POLLUTANT/" || true
  fi
done

print_manifest_counts() {
  local label="$1"
  local root="$2"

  echo
  echo "=== $label manifest counts, including timeseries_id=$TIMESERIES_ID ==="

  {
    printf "day_utc\tpollutant\trow_count\tsource_row_count\tfile_count\tts_%s_rows\n" "$TIMESERIES_ID"

    while IFS= read -r MANIFEST; do
      DAY="$(echo "$MANIFEST" | sed -n 's#.*day_utc=\([0-9-]*\).*#\1#p')"
      POL="$(echo "$MANIFEST" | sed -n 's#.*pollutant_code=\([^/]*\).*#\1#p')"

      jq -r --arg day "$DAY" --arg pol "$POL" --arg ts "$TIMESERIES_ID" '
        def ts_count($ts):
          if (.timeseries_row_counts? and .timeseries_row_counts[$ts] != null) then
            .timeseries_row_counts[$ts]
          else
            ([.files[]? | .timeseries_row_counts?[$ts] // empty] | add)
          end;

        [
          $day,
          $pol,
          (.row_count // ""),
          (.source_row_count // ""),
          (.file_count // ""),
          (ts_count($ts) // "")
        ] | @tsv
      ' "$MANIFEST"
    done < <(find "$root" -path '*/pollutant_code=*/manifest.json' -type f | sort)
  } | column -t
}

print_manifest_counts "Observations" "$OUT_DIR/observations"
print_manifest_counts "AQI hourly" "$OUT_DIR/aqilevels"

OBS_PARQUET_COUNT="$(find "$OUT_DIR/observations" -name '*.parquet' -type f | wc -l | tr -d ' ')"
AQI_PARQUET_COUNT="$(find "$OUT_DIR/aqilevels" -name '*.parquet' -type f | wc -l | tr -d ' ')"

echo
echo "Observation parquet files copied: $OBS_PARQUET_COUNT"
echo "AQI parquet files copied:         $AQI_PARQUET_COUNT"

if [[ "$OBS_PARQUET_COUNT" == "0" && "$AQI_PARQUET_COUNT" == "0" ]]; then
  echo "No observation or AQI parquet files found under $OUT_DIR"
  exit 0
fi

if [[ "$POLLUTANT" == "all" ]]; then
  OBS_PARQUET_GLOB="$OUT_DIR/observations/day_utc=*/pollutant_code=*/*.parquet"
  AQI_PARQUET_GLOB="$OUT_DIR/aqilevels/day_utc=*/pollutant_code=*/*.parquet"
else
  OBS_PARQUET_GLOB="$OUT_DIR/observations/day_utc=*/pollutant_code=$POLLUTANT/*.parquet"
  AQI_PARQUET_GLOB="$OUT_DIR/aqilevels/day_utc=*/pollutant_code=$POLLUTANT/*.parquet"
fi

column_exists() {
  local glob="$1"
  local col="$2"
  duckdb_csv -c "DESCRIBE SELECT * FROM read_parquet('$glob', union_by_name=true, filename=true);" \
    | awk -F, 'NR > 1 {gsub(/"/, "", $1); print $1}' \
    | grep -qx "$col"
}

detect_column() {
  local glob="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if column_exists "$glob" "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ "$OBS_PARQUET_COUNT" != "0" ]]; then
  echo
  echo "=== Observation parquet schema ==="
  duckdb_clean -c "
DESCRIBE SELECT * FROM read_parquet('$OBS_PARQUET_GLOB', union_by_name=true, filename=true);
"

  if [[ -z "$OBS_TIME_COL" ]]; then
    OBS_TIME_COL="$(detect_column "$OBS_PARQUET_GLOB" \
      observed_at_utc timestamp_hour_utc timestamp_utc period_start_utc period_start start_utc hour_start_utc datetime_utc || true)"
  fi

  if [[ -z "$OBS_VALUE_COL" ]]; then
    OBS_VALUE_COL="$(detect_column "$OBS_PARQUET_GLOB" \
      value observed_value measurement_value measured_value value_ugm3 value_ug_m3 value_ugm_3 concentration concentration_ugm3 observation_value pollutant_value || true)"
  fi

  if [[ -z "$OBS_TIME_COL" ]]; then
    echo "Could not detect observation timestamp column. Re-run with --obs-time-col <column>." >&2
    exit 3
  fi

  if [[ -z "$OBS_VALUE_COL" ]]; then
    echo "Could not detect observation value column. Re-run with --obs-value-col <column>." >&2
    exit 3
  fi

  echo "Detected observation timestamp column: $OBS_TIME_COL"
  echo "Detected observation value column:     $OBS_VALUE_COL"
fi

if [[ "$AQI_PARQUET_COUNT" != "0" ]]; then
  echo
  echo "=== AQI parquet schema ==="
  duckdb_clean -c "
DESCRIBE SELECT * FROM read_parquet('$AQI_PARQUET_GLOB', union_by_name=true, filename=true);
"

  if [[ -z "$AQI_TIME_COL" ]]; then
    AQI_TIME_COL="$(detect_column "$AQI_PARQUET_GLOB" \
      timestamp_hour_utc observed_at_utc period_start_utc period_start start_utc hour_start_utc datetime_utc timestamp_utc || true)"
  fi

  if [[ -z "$AQI_TIME_COL" ]]; then
    echo "Could not detect AQI timestamp column. Re-run with --aqi-time-col <column>." >&2
    exit 3
  fi

  echo "Detected AQI timestamp column:         $AQI_TIME_COL"
fi

echo
echo "=== Summary for timeseries_id=$TIMESERIES_ID ==="

if [[ "$OBS_PARQUET_COUNT" != "0" && "$AQI_PARQUET_COUNT" != "0" ]]; then
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  WITH obs AS (
    SELECT
      regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
      regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS file_pollutant_code,
      timeseries_id,
      CAST(\"$OBS_TIME_COL\" AS TIMESTAMP) AS hour_utc
    FROM read_parquet('$OBS_PARQUET_GLOB', union_by_name=true, filename=true)
    WHERE timeseries_id = $TIMESERIES_ID
  ),
  aqi AS (
    SELECT
      regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
      regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS file_pollutant_code,
      timeseries_id,
      CAST(\"$AQI_TIME_COL\" AS TIMESTAMP) AS hour_utc
    FROM read_parquet('$AQI_PARQUET_GLOB', union_by_name=true, filename=true)
    WHERE timeseries_id = $TIMESERIES_ID
  ),
  obs_summary AS (
    SELECT
      file_day_utc,
      file_pollutant_code,
      timeseries_id,
      count(*) AS observation_rows,
      min(hour_utc) AS first_observation_utc,
      max(hour_utc) AS last_observation_utc
    FROM obs
    GROUP BY 1, 2, 3
  ),
  aqi_summary AS (
    SELECT
      file_day_utc,
      file_pollutant_code,
      timeseries_id,
      count(*) AS aqi_rows,
      min(hour_utc) AS first_aqi_utc,
      max(hour_utc) AS last_aqi_utc
    FROM aqi
    GROUP BY 1, 2, 3
  )
  SELECT
    COALESCE(obs_summary.file_day_utc, aqi_summary.file_day_utc) AS file_day_utc,
    COALESCE(obs_summary.file_pollutant_code, aqi_summary.file_pollutant_code) AS file_pollutant_code,
    COALESCE(obs_summary.timeseries_id, aqi_summary.timeseries_id) AS timeseries_id,
    obs_summary.observation_rows,
    aqi_summary.aqi_rows,
    obs_summary.first_observation_utc,
    obs_summary.last_observation_utc,
    aqi_summary.first_aqi_utc,
    aqi_summary.last_aqi_utc
  FROM obs_summary
  FULL OUTER JOIN aqi_summary
    ON obs_summary.file_day_utc = aqi_summary.file_day_utc
   AND obs_summary.file_pollutant_code = aqi_summary.file_pollutant_code
   AND obs_summary.timeseries_id = aqi_summary.timeseries_id
  ORDER BY file_day_utc, file_pollutant_code, timeseries_id
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box

elif [[ "$OBS_PARQUET_COUNT" != "0" ]]; then
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  SELECT
    regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
    regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS file_pollutant_code,
    timeseries_id,
    count(*) AS observation_rows,
    NULL::INTEGER AS aqi_rows,
    min(CAST(\"$OBS_TIME_COL\" AS TIMESTAMP)) AS first_observation_utc,
    max(CAST(\"$OBS_TIME_COL\" AS TIMESTAMP)) AS last_observation_utc,
    NULL::TIMESTAMP AS first_aqi_utc,
    NULL::TIMESTAMP AS last_aqi_utc
  FROM read_parquet('$OBS_PARQUET_GLOB', union_by_name=true, filename=true)
  WHERE timeseries_id = $TIMESERIES_ID
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box

else
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  SELECT
    regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
    regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS file_pollutant_code,
    timeseries_id,
    NULL::INTEGER AS observation_rows,
    count(*) AS aqi_rows,
    NULL::TIMESTAMP AS first_observation_utc,
    NULL::TIMESTAMP AS last_observation_utc,
    min(CAST(\"$AQI_TIME_COL\" AS TIMESTAMP)) AS first_aqi_utc,
    max(CAST(\"$AQI_TIME_COL\" AS TIMESTAMP)) AS last_aqi_utc
  FROM read_parquet('$AQI_PARQUET_GLOB', union_by_name=true, filename=true)
  WHERE timeseries_id = $TIMESERIES_ID
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box
fi

echo
echo "=== Joined observations and AQI rows for timeseries_id=$TIMESERIES_ID ==="

if [[ "$OBS_PARQUET_COUNT" != "0" && "$AQI_PARQUET_COUNT" != "0" ]]; then
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  WITH obs AS (
    SELECT
      regexp_extract(filename, 'day_utc=([^/]+)', 1) AS obs_day_utc,
      timeseries_id,
      CAST(\"$OBS_TIME_COL\" AS TIMESTAMP) AS hour_utc,
      TRY_CAST(\"$OBS_VALUE_COL\" AS DOUBLE) AS observed_value
    FROM read_parquet('$OBS_PARQUET_GLOB', union_by_name=true, filename=true)
    WHERE timeseries_id = $TIMESERIES_ID
  ),
  aqi AS (
    SELECT
      regexp_extract(filename, 'day_utc=([^/]+)', 1) AS aqi_day_utc,
      timeseries_id,
      CAST(\"$AQI_TIME_COL\" AS TIMESTAMP) AS hour_utc,
      daqi_index_level,
      daqi_calculation_status,
      daqi_missing_reason,
      eaqi_index_level,
      eaqi_calculation_status,
      eaqi_missing_reason
    FROM read_parquet('$AQI_PARQUET_GLOB', union_by_name=true, filename=true)
    WHERE timeseries_id = $TIMESERIES_ID
  )
  SELECT
    COALESCE(aqi.aqi_day_utc, obs.obs_day_utc) AS file_day_utc,
    COALESCE(aqi.hour_utc, obs.hour_utc) AS timestamp_hour_utc,
    obs.observed_value,
    aqi.daqi_index_level,
    aqi.daqi_calculation_status,
    aqi.daqi_missing_reason,
    aqi.eaqi_index_level,
    aqi.eaqi_calculation_status,
    aqi.eaqi_missing_reason
  FROM obs
  FULL OUTER JOIN aqi
    ON obs.timeseries_id = aqi.timeseries_id
   AND obs.hour_utc = aqi.hour_utc
  ORDER BY file_day_utc, timestamp_hour_utc
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box

elif [[ "$OBS_PARQUET_COUNT" != "0" ]]; then
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  SELECT
    regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
    CAST(\"$OBS_TIME_COL\" AS TIMESTAMP) AS timestamp_hour_utc,
    TRY_CAST(\"$OBS_VALUE_COL\" AS DOUBLE) AS observed_value,
    NULL::INTEGER AS daqi_index_level,
    NULL::VARCHAR AS daqi_calculation_status,
    NULL::VARCHAR AS daqi_missing_reason,
    NULL::INTEGER AS eaqi_index_level,
    NULL::VARCHAR AS eaqi_calculation_status,
    NULL::VARCHAR AS eaqi_missing_reason
  FROM read_parquet('$OBS_PARQUET_GLOB', union_by_name=true, filename=true)
  WHERE timeseries_id = $TIMESERIES_ID
  ORDER BY file_day_utc, timestamp_hour_utc
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box

else
  TERM=dumb NO_COLOR=1 duckdb -c "
COPY (
  SELECT
    regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
    CAST(\"$AQI_TIME_COL\" AS TIMESTAMP) AS timestamp_hour_utc,
    NULL::DOUBLE AS observed_value,
    daqi_index_level,
    daqi_calculation_status,
    daqi_missing_reason,
    eaqi_index_level,
    eaqi_calculation_status,
    eaqi_missing_reason
  FROM read_parquet('$AQI_PARQUET_GLOB', union_by_name=true, filename=true)
  WHERE timeseries_id = $TIMESERIES_ID
  ORDER BY file_day_utc, timestamp_hour_utc
) TO STDOUT (HEADER, DELIMITER '\t');
" | tsv_box
fi
