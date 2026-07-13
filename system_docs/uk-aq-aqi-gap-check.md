# UK-AQ AQI Gap Check

## Current Status

`scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py` is now a **local-only R2 v2 structural checker**. It no longer supports the old v1/db-dump/profile workflow and does not try to run against live R2.

The script refuses to start unless the environment explicitly sets:

```bash
export UK_AQ_R2_HISTORY_VERSION=v2
```

If `UK_AQ_R2_HISTORY_VERSION` is unset or anything other than `v2`, the script exits non-zero with a v2-only error. This prevents accidental silent defaults to either v1 or v2.

## Purpose

The checker compares the four relevant v2 artefact families in a local Dropbox/R2 backup tree:

1. `history/v2/observations`
2. `history/v2/aqilevels/hourly/data`
3. `history/_index_v2/observations_timeseries`
4. `history/_index_v2/aqilevels_hourly_data_timeseries`

It detects structural gaps and count mismatches between backed-up observation data, backed-up hourly AQI data, and API-facing timeseries indexes. It does **not** recalculate DAQI/EAQI levels.

## Safety Model

The checker is read-only with respect to operational systems:

- does not write to R2
- does not write to Supabase
- does not write to Dropbox/source systems beyond the selected local output directory
- does not repair or backfill anything
- does not shell out to `rclone`

It reads local parquet files using DuckDB and reads local manifest JSON files using the Python standard library.

## Expected Local Paths

Observation data partition:

```text
<root>/history/v2/observations/day_utc=<day>/connector_id=<connector>/pollutant_code=<pollutant>/
```

AQI hourly data partition:

```text
<root>/history/v2/aqilevels/hourly/data/day_utc=<day>/connector_id=<connector>/pollutant_code=<pollutant>/
```

Observation timeseries index manifest:

```text
<root>/history/_index_v2/observations_timeseries/day_utc=<day>/connector_id=<connector>/pollutant_code=<pollutant>/manifest.json
```

AQI hourly timeseries index manifest:

```text
<root>/history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=<day>/connector_id=<connector>/pollutant_code=<pollutant>/manifest.json
```

The `_index_v2` paths are keyed by day, connector, and pollutant only. They are **not** keyed by `timeseries_id=<id>`.

## CLI Examples

Explicit local root:

```bash
UK_AQ_R2_HISTORY_VERSION=v2 \
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --from-day 2026-06-18 \
  --to-day 2026-06-18 \
  --connector-id 1 \
  --pollutant pm25 \
  --timeseries-id 218 \
  --r2-history-root /Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup \
  --out /tmp/uk-aq-aqi-gap-check
```

Root from environment:

```bash
export UK_AQ_R2_HISTORY_VERSION=v2
export UK_AQ_R2_HISTORY_DROPBOX_ROOT=/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --from-day 2026-06-18 \
  --to-day 2026-06-20 \
  --pollutant all \
  --out /tmp/uk-aq-aqi-gap-check
```

`R2_HISTORY_DROPBOX_ROOT` is also accepted as a fallback root environment variable.

## Supported Inputs

- `--from-day YYYY-MM-DD`
- `--to-day YYYY-MM-DD`
- `--connector-id <id>`; optional, connector IDs are discovered when omitted
- `--pollutant pm25|pm10|no2|o3|all`
- `--timeseries-id <id>`; optional, all discovered timeseries are reported when omitted
- `--r2-history-root <local backup root>`; optional if a supported root env var is set
- `--out <output directory>`

## Reports

The output directory contains:

- `summary.tsv`
- `summary.csv`
- `gaps.tsv`
- `gaps.csv`
- `run_summary.json`

Summary columns are intentionally narrow for terminal review:

```text
day_utc connector_id pol timeseries_id obs_rows aqi_rows obs_idx aqi_idx obs_idx_rows aqi_idx_rows status
```

The `obs_idx_rows` and `aqi_idx_rows` fields are per-timeseries index manifest counts when the manifest exposes them. If a manifest only exposes a partition-level `row_count`, `rows`, `count`, or `record_count`, these fields are left blank for per-timeseries summary rows. The checker does not invent per-timeseries index counts from partition-level counts.

## Status Rules

For each selected day, connector, pollutant, and timeseries:

- `missing_aqi_data`: supported-pollutant valid observation UTC hours exist and AQI rows are missing
- `missing_aqi_index`: AQI rows exist and the AQI timeseries index manifest is missing
- `missing_obs_index`: observation rows exist and the observation timeseries index manifest is missing
- `missing_expected_aqi_hours`: one or more supported-pollutant valid observation UTC hours have no AQI row
- `stale_or_partial_aqi_index`: AQI index manifest row count is available and lower than AQI data rows
- `ok`: expected v2 data/index artefacts are present and every expected AQI UTC hour is present; raw observation-row parity is not required

Multiple gap statuses can appear on the same row separated by semicolons.

## Limitations

- The checker does not validate AQI numeric correctness.
- The checker does not require or read `hourly_mean_ugm3` or `rolling24h_mean_ugm3` from v2 AQI parquet files.
- Manifest timeseries-specific counts are used only when they are present in a recognized shape; otherwise manifest row count is left blank.
- This is a structural/reporting tool only; use a separate reviewed repair/backfill process for any fixes.
