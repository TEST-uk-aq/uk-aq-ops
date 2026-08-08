# UK AQ WHO 2021 daily batch

This directory owns the direct GitHub Actions batch for private WHO 2021
derived status in Obs AQI DB. It does not start an HTTP server.

The batch:

- recalculates yesterday and the day before yesterday on every normal daily run;
- uses Obs AQI DB first for each daily target and validated R2 v2
  observations as the exact-day fallback;
- selects historical backfill sources from actual storage authority: validated
  R2 when a target day manifest exists, or Obs AQI DB when that top-level
  manifest is absent;
- selects the following `00:00` boundary independently, including mixed
  validated-R2/Obs-AQI-DB crossover days;
- preserves the 18-valid-hour daily rule and 274-valid-day period rule;
- refreshes rolling-year and last-complete-year status through the existing
  service-role RPCs;
- writes parquet before JSON, and dated JSON before the latest JSON pointer;
- compares stable logical hashes with existing R2 objects and skips unchanged
  writes;
- writes a bounded local report for every normal outcome and failure where
  technically possible;
- uploads that report through the Dropbox API under
  `${UK_AQ_DROPBOX_ROOT}/who_2021/`.

## Entrypoints

- `main.ts`: direct WHO calculation and publication batch.
- `upload_report.ts`: uploads the completed bounded report to Dropbox.
- `who_2021_daily_core.ts`: date, readiness, RPC payload and stable JSON logic.
- `who_2021_parquet.ts`: Arrow/parquet conversion.
- `r2_objects.ts`: signed R2 comparison and conditional PUT.
- `r2_observations.ts`: signed R2 manifest/parquet validation and hour-ending
  daily aggregation.
- `report.ts`: bounded report construction and atomic local write.

The GitHub workflow is `.github/workflows/uk_aq_who_2021_daily.yml`.
Cloudflare Scheduler is the only schedule authority.

## Run modes

- `daily`: always targets yesterday and the day before yesterday.
- `backfill`: requires `UK_AQ_WHO_2021_START_DAY_UTC` and
  `UK_AQ_WHO_2021_END_DAY_UTC`, resolves validated R2 and Obs AQI DB authority
  per day, commits one day at a time, and rejects ranges longer than 31
  inclusive days.
- `dry_run`: calculates RPC counts without database upserts or R2 writes.

For hour-ending GOV.UK AURN data, a `day_utc` window is
`(day 00:00, next day 00:00]`.
When R2 is authoritative, its partition for `day` contributes only `01:00`
through `23:00`; the following `00:00` boundary comes from validated R2 when
the `day + 1` top-level manifest exists, or from Obs AQI DB when that initial
manifest is absent. Any R2 partition whose top-level manifest exists must pass
the existing v2 day/connector/pollutant manifest and parquet checks.

## Required runtime configuration

Database:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

R2 for backfill, daily fallback, JSON publication, or parquet publication:

- `CFLARE_R2_ENDPOINT`
- `CFLARE_R2_BUCKET`
- `CFLARE_R2_REGION` (default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID`
- `CFLARE_R2_SECRET_ACCESS_KEY`

Dropbox report upload:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_DROPBOX_ROOT`

WHO defaults:

- `UK_AQ_WHO_2021_SOURCE_NETWORK_CODE=gov_uk_aurn`
- `UK_AQ_WHO_2021_CONNECTOR_ID=1`
- `UK_AQ_WHO_2021_POLLUTANT_CODES=pm25,pm10,no2`
- `UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY=18`
- `UK_AQ_WHO_2021_MIN_VALID_DAYS=274`
- `UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO=0.9`
- `UK_AQ_WHO_2021_READINESS_GATE_ENABLED=true`
- `UK_AQ_WHO_2021_SUMMARY_REFRESH_ENABLED=true`
- `UK_AQ_WHO_2021_DAILY_LOOKBACK_DAYS=2`
- `UK_AQ_WHO_2021_CHUNK_DAYS=31`
- `UK_AQ_WHO_2021_R2_BACKFILL_MAX_DAYS=31`
- `UK_AQ_WHO_2021_RPC_RETRIES=3`
- `UK_AQ_WHO_2021_R2_PUBLISH_ENABLED=false` (set `true` for publication)
- `UK_AQ_WHO_2021_PARQUET_R2_WRITE_ENABLED=false` (set `true` for archive writes)

`refresh_summaries` uses a mode-aware workflow default: `true` for `daily`,
`false` for `backfill` and `dry_run`. Backfill JSON and derived parquet
publication remain off unless explicitly enabled.

The diagnostic Supabase egress caller label is
`uk_aq_who_2021_daily_github_actions`.

## Outputs

Local report:

```text
tmp/uk_aq_who_2021_daily_report.json
```

Public JSON:

```text
history/v2/who_2021/summaries/as_of_day_utc=YYYY-MM-DD/who_2021_summary.json
history/v2/who_2021/latest_who_2021.json
```

Derived parquet uses the existing `history/v2/who_2021/` daily, rolling-year
and calendar-year partition paths returned by
`uk_aq_rpc_who_2021_r2_parquet_rows`.

## Local structural command

```bash
deno check \
  workers/uk_aq_who_2021_daily/main.ts \
  workers/uk_aq_who_2021_daily/upload_report.ts
```

Do not use a local run as a substitute for the required real TEST workflow
operation.
