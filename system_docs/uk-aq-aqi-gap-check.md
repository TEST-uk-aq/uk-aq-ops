# UK-AQ AQI Gap Check

## Purpose

`uk-aq-aqi-gap-check.py` is a local-only reporting tool that checks for **missing hourly AQI rows**.

It compares:

1. expected AQI row presence derived from local observation history
2. actual AQI hourly row presence from local AQI history backups

It is designed for the local MBPro workflow alongside the existing history-integrity tooling.

## What It Checks

The checker reports only **missing logical AQI rows** where backed-up observations imply an AQI row should exist.

It always checks both standards:

- `DAQI`
- `EAQI`

Metric basis is automatic and fixed:

- `DAQI NO2` uses `hourly_mean`
- `DAQI PM2.5` uses `rolling_24h_mean`
- `DAQI PM10` uses `rolling_24h_mean`
- `EAQI NO2` uses `hourly_mean`
- `EAQI PM2.5` uses `hourly_mean`
- `EAQI PM10` uses `hourly_mean`

Rolling 24-hour PM checks match the current AQI schema rules:

- rolling window = current hour plus previous 23 hours
- at least 18 valid hourly means required
- warm-up observation hours are loaded before the requested start day
- only target-day hours are reported

## What It Does Not Check

The tool does **not**:

- validate whether stored AQI values are numerically correct
- validate daily AQI rollups
- repair anything
- backfill anything
- mutate R2, Dropbox, Supabase, dumps, or source data

## Source Modes

Supported source modes:

- `r2-dropbox`
- `db-dump`

### `r2-dropbox`

Uses the local Dropbox R2 history backup.

Expected rows are built from local observations parquet.
Actual rows are read from local aqilevels parquet.

If local R2 files are Dropbox placeholders / online-only files, the checker records warnings and does not treat those files as readable evidence.

### `db-dump`

Uses the latest usable local `obs_aqidb` dump snapshot.

Expected rows are built from dump observation partitions:

- `uk_aq_observs.observations_YYYYMMDD`

Actual rows are checked against dump AQI hourly rows:

- `uk_aq_aqilevels.timeseries_aqi_hourly`

## Profiles

Supported profiles:

- `daily`
- `weekly`
- `monthly`
- `obsaqidb`

The first three reuse the same window meanings as `uk-aq-history-integrity.py`:

- `daily` = last 21 days through the current integrity end-back boundary
- `weekly` = last 120 days through the current integrity end-back boundary
- `monthly` = last 730 days through the current integrity end-back boundary

Default source selection:

- `daily` -> `r2-dropbox`
- `weekly` -> `r2-dropbox`
- `monthly` -> `r2-dropbox`
- `obsaqidb` -> `db-dump`

### `obsaqidb`

`obsaqidb` is intended for the local dashboard workflow where the website prefers R2 when R2 exists.

Default behaviour:

1. read candidate observation days from the latest local `obs_aqidb` dump
2. exclude `today`
3. exclude days that already have a readable local R2 AQI day manifest
4. run the gap check for the remaining days only

Override:

- `--include-r2-days`

This forces `obsaqidb` to include days that already appear present in the local R2 AQI backup.

## CLI

Examples:

```bash
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile daily
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile weekly
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile monthly
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile obsaqidb
```

Explicit range examples:

```bash
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --from-day 2026-05-01 \
  --to-day 2026-05-07 \
  --source r2-dropbox

python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --from-day 2026-05-01 \
  --to-day 2026-05-07 \
  --source db-dump
```

Useful flags:

- `--verbose`
- `--limit-missing N`
- `--output-dir DIR`
- `--include-r2-days`
- `--env-file /path/to/CIC-Test.env`

## Environment and State Model

The checker reuses the same history-integrity local state model:

- local SQLite DB = `UK_AQ_HISTORY_INTEGRITY_DB_PATH`
- local writable state dirs outside Dropbox
- logs via `UK_AQ_AQI_GAP_LOG_DIR` and reports via `UK_AQ_AQI_GAP_REPORT_DIR`
- post-run SQLite copy sync via `UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH`

By convention the Dropbox-backed log and report directories live under:

- `.../uk-aq-history-integrity/aqi_gap_check/logs`
- `.../uk-aq-history-integrity/aqi_gap_check/reports`

Like the main integrity runner, the checker writes to the local working SQLite DB first and then copies the final DB file to the repo/Dropbox copy after the run.

## SQLite Tables

The checker adds namespaced tables inside the existing integrity SQLite DB:

- `aqi_gap_check_standard_versions`
- `aqi_gap_check_breakpoints`
- `aqi_gap_check_rule_mirror_state`
- `aqi_gap_check_runs`
- `aqi_gap_check_day_summary`
- `aqi_gap_check_day_connector_summary`
- `aqi_gap_check_source_files`
- `aqi_gap_check_report_files`

It also reuses the existing core snapshot tables, especially:

- `core_connectors_snapshot`
- `core_timeseries_snapshot`
- `core_phenomena_snapshot`

## Reports

Full JSON reports are written under:

- `$UK_AQ_AQI_GAP_REPORT_DIR/`

A markdown summary file is also written alongside the JSON report.

JSON report includes:

- source mode
- profile
- selected day list
- expected / actual / missing counts
- missing-by-day summaries
- missing-by-day-connector summaries
- missing-by-standard summaries
- missing-by-pollutant summaries
- warnings
- inspected source files
- rule mirror metadata
- full missing row list

Each missing row includes:

- `day_utc`
- `timestamp_hour_utc`
- `timeseries_id`
- `station_id`
- `connector_id`
- `pollutant_code`
- `standard_code`
- `averaging_code`
- `expected_metric_value`
- `expected_index_level`
- `expected_index_band`
- `reason=missing_aqilevel_row`

## Cron Examples

Daily local R2 check:

```bash
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile daily
```

Daily local Obs AQI DB backlog check:

```bash
python3 scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py --env CIC-Test --profile obsaqidb
```

## SQLite Query Examples

Latest runs:

```sql
SELECT
  id,
  started_at_utc,
  finished_at_utc,
  profile,
  source_mode,
  from_day_utc,
  to_day_utc,
  selected_day_count,
  expected_row_count,
  actual_row_count,
  missing_row_count,
  warning_count,
  status,
  report_json_path
FROM aqi_gap_check_runs
ORDER BY id DESC
LIMIT 20;
```

Latest missing counts by day:

```sql
SELECT
  day_utc,
  expected_row_count,
  actual_row_count,
  missing_row_count,
  missing_daqi_count,
  missing_eaqi_count
FROM aqi_gap_check_day_summary
WHERE run_id = ?
ORDER BY day_utc;
```

Latest missing counts by connector with connector metadata:

```sql
SELECT
  s.day_utc,
  s.connector_id,
  c.connector_code,
  c.display_name,
  s.expected_row_count,
  s.actual_row_count,
  s.missing_row_count
FROM aqi_gap_check_day_connector_summary s
LEFT JOIN core_connectors_snapshot c
  ON c.id = s.connector_id
WHERE s.run_id = ?
ORDER BY s.day_utc, s.missing_row_count DESC, s.connector_id;
```

## Validation Notes

Manual validation that should be re-run after meaningful changes:

- `db-dump` single-day explicit range where AQI is expected complete
- `db-dump` `obsaqidb` profile over latest local dump snapshot
- `r2-dropbox` explicit range with real offline parquet files
- placeholder-file warning path for local R2 when Dropbox files are online-only

Current checker behaviour intentionally treats unreadable placeholder files as warnings, not as valid local evidence.
