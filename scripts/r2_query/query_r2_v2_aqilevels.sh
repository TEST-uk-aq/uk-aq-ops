#!/usr/bin/env bash
set -euo pipefail

CONNECTOR_ID=""
FROM_DAY=""
TO_DAY=""
POLLUTANT="pm25"
TIMESERIES_ID="218"
OUT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  scripts/r2_query/query_r2_v2_aqilevels.sh \
    --connector-id 1 \
    --from-day 2026-06-18 \
    --to-day 2026-06-23 \
    [--pollutant pm25|pm10|no2|o3|all] \
    [--timeseries-id 218] \
    [--out tmp/custom_output_dir]

Required:
  --connector-id    Connector id, e.g. 1
  --from-day        Start day, YYYY-MM-DD
  --to-day          End day, YYYY-MM-DD

Defaults:
  --pollutant       pm25
  --timeseries-id   218
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

for cmd in rclone jq duckdb python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

duckdb_clean() {
  TERM=dumb NO_COLOR=1 duckdb "$@" | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g'
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
  OUT_DIR="tmp/r2_v2_aqilevels_${FROM_DAY}_to_${TO_DAY}_connector_${CONNECTOR_ID}_${POLLUTANT}_ts_${TIMESERIES_ID}"
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
  DAY_OUT="$OUT_DIR/day_utc=$DAY"
  mkdir -p "$DAY_OUT"

  BASE_REMOTE="uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/aqilevels/hourly/data/day_utc=${DAY}/connector_id=${CONNECTOR_ID}"

  echo "Copying connector manifest for $DAY"
  rclone cat "${BASE_REMOTE}/manifest.json" > "$DAY_OUT/connector_manifest.json" 2>/dev/null || true

  if [[ "$POLLUTANT" == "all" ]]; then
    echo "Copying AQI v2 connector/day: $DAY connector_id=$CONNECTOR_ID all pollutants"
    rclone copy -P "${BASE_REMOTE}/" "$DAY_OUT/" || true
  else
    echo "Copying AQI v2 pollutant/day: $DAY connector_id=$CONNECTOR_ID pollutant=$POLLUTANT"
    mkdir -p "$DAY_OUT/pollutant_code=$POLLUTANT"
    rclone copy -P "${BASE_REMOTE}/pollutant_code=${POLLUTANT}/" "$DAY_OUT/pollutant_code=$POLLUTANT/" || true
  fi
done

echo
echo "=== Pollutant manifest counts, including timeseries_id=$TIMESERIES_ID ==="

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
  done < <(find "$OUT_DIR" -path '*/pollutant_code=*/manifest.json' -type f | sort)
} | column -t

PARQUET_COUNT="$(find "$OUT_DIR" -name '*.parquet' -type f | wc -l | tr -d ' ')"

echo
echo "Parquet files copied: $PARQUET_COUNT"

if [[ "$PARQUET_COUNT" == "0" ]]; then
  echo "No parquet files found under $OUT_DIR"
  exit 0
fi

if [[ "$POLLUTANT" == "all" ]]; then
  PARQUET_GLOB="$OUT_DIR/day_utc=*/pollutant_code=*/*.parquet"
else
  PARQUET_GLOB="$OUT_DIR/day_utc=*/pollutant_code=$POLLUTANT/*.parquet"
fi

echo
echo "=== Parquet schema ==="
duckdb_clean -c "
DESCRIBE SELECT * FROM read_parquet('$PARQUET_GLOB', union_by_name=true, filename=true);
"

TIME_COL=""
for candidate in timestamp_hour_utc observed_at_utc period_start_utc period_start start_utc hour_start_utc datetime_utc timestamp_utc; do
  if TERM=dumb NO_COLOR=1 duckdb -csv -c "DESCRIBE SELECT * FROM read_parquet('$PARQUET_GLOB', union_by_name=true, filename=true);" \
    | awk -F, 'NR > 1 {print $1}' \
    | grep -qx "$candidate"; then
    TIME_COL="$candidate"
    break
  fi
done

if [[ -n "$TIME_COL" ]]; then
  ORDER_EXPR="file_day_utc, \"$TIME_COL\""
  TIME_SUMMARY=", min(\"$TIME_COL\") AS first_time_utc, max(\"$TIME_COL\") AS last_time_utc"
else
  ORDER_EXPR="file_day_utc"
  TIME_SUMMARY=""
  echo "No recognised timestamp column found. Summary will omit first/last time."
fi

echo
echo "=== Summary for timeseries_id=$TIMESERIES_ID ==="
duckdb_clean -c "
SELECT
  regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
  regexp_extract(filename, 'pollutant_code=([^/]+)', 1) AS file_pollutant_code,
  timeseries_id,
  count(*) AS rows
  $TIME_SUMMARY
FROM read_parquet('$PARQUET_GLOB', union_by_name=true, filename=true)
WHERE timeseries_id = $TIMESERIES_ID
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
"

echo
echo "=== Rows for timeseries_id=$TIMESERIES_ID ==="
duckdb_clean -c "
SELECT
  regexp_extract(filename, 'day_utc=([^/]+)', 1) AS file_day_utc,
  timestamp_hour_utc,
  daqi_index_level,
  daqi_calculation_status,
  daqi_missing_reason,
  eaqi_index_level,
  eaqi_calculation_status,
  eaqi_missing_reason
FROM read_parquet('$PARQUET_GLOB', union_by_name=true, filename=true)
WHERE timeseries_id = $TIMESERIES_ID
ORDER BY $ORDER_EXPR;
"
