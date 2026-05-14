# UK-AQ Local Backfill

## Purpose

`scripts/uk_aq_backfill_local.sh` is the local/manual wrapper for backfill runs.
It executes `workers/uk_aq_backfill_local/run_job.ts` over the requested UTC day range,
chunking requests into internal windows for pacing and logging.

## Run modes

The runner supports these modes:

- `local_to_aqilevels`
- `obs_aqi_to_r2`
- `source_to_r2`
- `r2_history_obs_to_aqilevels`

## Wrapper behavior

`scripts/uk_aq_backfill_local.sh`:

- validates required env vars:
  - `UK_AQ_BACKFILL_RUN_MODE`
  - `UK_AQ_BACKFILL_DRY_RUN`
  - `UK_AQ_BACKFILL_FORCE_REPLACE`
  - `UK_AQ_BACKFILL_FROM_DAY_UTC`
  - `UK_AQ_BACKFILL_TO_DAY_UTC`
- forces `UK_AQ_BACKFILL_TRIGGER_MODE=manual` for local runs
- resolves runner path from:
  - `UK_AQ_BACKFILL_RUN_JOB_PATH` (optional), otherwise
  - `workers/uk_aq_backfill_local/run_job.ts`
- executes one run per internal date window and writes per-window logs
- rebuilds R2 history index after successful non-dry runs for:
  - `source_to_r2`
  - `obs_aqi_to_r2`
  - `r2_history_obs_to_aqilevels`

## Local wrapper env vars

Primary (preferred) env vars:

- `UK_AQ_BACKFILL_LOCAL_LOG_DIR` (default `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/<UK_AQ_DROPBOX_ROOT>/uk-aq-backfill-local-logs`, falling back to `.../CIC-Test/...` when `UK_AQ_DROPBOX_ROOT` is unset)
- `UK_AQ_BACKFILL_LOCAL_STOP_ON_ERROR` (default `true`)
- `UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS` (default `0`)
- `UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE` (default `0`, disabled)
- `UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR` (default `0`, disabled)
- `UK_AQ_BACKFILL_PAUSE_SECONDS` (legacy alias for run interval)

## Metadata source rules

Backfill metadata resolution (connector/station/timeseries mappings) now prefers
local Dropbox R2 history backup first, then falls back.

Order:

1. Local Dropbox R2 history backup (`UK_AQ_R2_HISTORY_DROPBOX_ROOT`)
2. Live R2 API (if credentials present)
3. Ingest DB metadata queries (fallback)

When fallback to ingest metadata is used after core-history lookup attempts,
a warning is emitted in structured logs.

## Retention rule and old-day behavior

Backfill uses ingest retention logic for source-of-truth day selection with
`INGEST_RETENTION_DAYS`.

Outside-retention cutoff is:

- `day_utc <= today_utc - (INGEST_RETENTION_DAYS + 1)`

Example: on 2026-05-13 with retention `4`, newest outside-retention day is
2026-05-08.

## `source_to_r2` targeted merge mode

### Why

Integrity-triggered repairs may only target a subset of timeseries IDs for a
connector/day. Full connector/day overwrite can drop unaffected rows.

### Trigger

Targeted merge is used when all are true:

- mode is `source_to_r2`
- `UK_AQ_BACKFILL_SOURCE_TO_R2_TARGETED_MERGE=true` (default)
- `UK_AQ_BACKFILL_TIMESERIES_IDS` or `UK_AQ_BACKFILL_TIMESERIES_ID` is set

### Merge flow

For each `(day_utc, connector_id)`:

1. Fetch source rows for the requested day.
2. If `UK_AQ_BACKFILL_TIMESERIES_IDS` is set, pre-filter OpenAQ location/day
   source fetches to only locations mapped to those requested timeseries IDs.
3. Read existing local Dropbox observations + AQI connector manifests/parquet.
4. Split data by target timeseries IDs:
   - preserve non-target rows from local history
   - replace target rows with newly-built source rows
5. Rebuild merged observations parquet + manifest.
6. Rebuild merged AQI parquet + manifest.
7. Upload merged connector outputs to live R2 (replace connector/day objects).
8. Rebuild day-level manifests from connector manifests.

If local Dropbox baseline manifests are missing for targeted merge,
backfill fails that connector/day to avoid destructive partial rewrite.

## AQI handling

In `source_to_r2`, AQI outputs are always rebuilt alongside observations for
successful connector/day writes.

For targeted merge mode:

- non-target AQI rows are preserved from local backup
- target AQI rows are recomputed from replacement observation rows

## Key env vars for integrity-triggered runs

Integrity uses wrapper + env file and sets:

- `UK_AQ_BACKFILL_RUN_MODE=source_to_r2`
- `UK_AQ_BACKFILL_FORCE_REPLACE=true`
- `UK_AQ_BACKFILL_FROM_DAY_UTC=<day>`
- `UK_AQ_BACKFILL_TO_DAY_UTC=<day>`
- `UK_AQ_BACKFILL_TIMESERIES_IDS=<csv>`

Recommended supporting vars in the backfill env file:

- `UK_AQ_R2_HISTORY_DROPBOX_ROOT=<absolute local Dropbox backup root>`
- `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT=<absolute local OpenAQ cache root>`
- `CFLARE_R2_*` / `R2_*` credentials for live write

For `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT`, backfill can reuse either local
cache layout:

- `day_utc=YYYY-MM-DD/location-<location_id>-YYYYMMDD.csv.gz`
- `locationid=<location_id>/year=YYYY/month=MM/location-<location_id>-YYYYMMDD.csv.gz`

## Outputs

- connector/day parquet + connector manifests under:
  - `history/v1/observations/...`
  - `history/v1/aqilevels/...`
- day manifests:
  - `history/v1/observations/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/aqilevels/day_utc=YYYY-MM-DD/manifest.json`
- local logs under `UK_AQ_BACKFILL_LOCAL_LOG_DIR`
- optional ledger rows (when enabled)
