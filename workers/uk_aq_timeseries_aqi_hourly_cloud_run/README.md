# UK AQ Timeseries AQI Hourly Cloud Run

Syncs precomputed timeseries-hour AQI helper rows from ingest DB into Obs AQI DB (hourly upsert + daily/monthly rollup refresh).

Helper rows carry the normalized DAQI/EAQI inputs, counts, statuses, and index levels that the downstream worker upserts directly. The worker now supports short and deep reconciliation windows so late-arriving observations can repair recent AQI stripe gaps without changing the normal hourly sync path. Reconciliation modes first rebuild the ingest helper window from raw observations, then page through helper-window RPC reads to avoid the PostgREST 1000-row response cap on table-valued RPC results.

## Endpoints

- `GET /` health
- `POST /` run job

`POST /` request body (all optional):

```json
{
  "trigger_mode": "scheduler",
  "run_mode": "sync_hourly",
  "from_hour_utc": "2026-03-01T00:00:00Z",
  "to_hour_utc": "2026-03-01T23:00:00Z",
  "timeseries_ids": [10101, 10102]
}
```

## Run Modes

- `sync_hourly`: latest mature hour-end window only
- `reconcile_short`: recent rolling window ending at the same mature hour-end, default `8` hours
- `reconcile_deep`: recent rolling window ending at the same mature hour-end, default `24` hours
- `reconcile_deep_rolling`: six-hour historical window from 24 hours ago through 18 hours ago
- `backfill`: explicit hour-end range using `from_hour_utc` + `to_hour_utc`

## Required Environment

- `SUPABASE_URL` (ingest DB URL)
- `SB_SECRET_KEY` (ingest service key)
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_DROPBOX_ROOT` (workflow default `/CIC-Test`)

## AQI Settings

- `UK_AQ_AQI_MATURITY_DELAY_HOURS` (default `3`)
- `UK_AQ_AQI_MATURITY_DELAY_BUFFER_MINUTES` (default `10`)
- `UK_AQ_AQI_RUN_MODE` (default `sync_hourly`)
- `UK_AQ_AQI_RECONCILE_SHORT_HOURS` (default `8`)
- `UK_AQ_AQI_RECONCILE_DEEP_HOURS` (default `24`)
- `UK_AQ_AQI_RECONCILE_DEEP_REFRESH_CHUNK_HOURS` (default `6`, capped at the deep window)
- `UK_AQ_AQI_RECONCILE_DEEP_ROLLING_LAG_HOURS` (default `24`)
- `UK_AQ_AQI_RECONCILE_DEEP_ROLLING_WINDOW_HOURS` (default `6`)
- `UK_AQ_AQI_RECONCILE_DEEP_ROLLING_UPSERT_BATCH_SIZE` (default and maximum `100`)
- `UK_AQ_AQI_STATION_FK_CHECK_SCHEMA` (default `uk_aq_public`)
- `UK_AQ_AQI_STATION_FK_CHECK_VIEW` (default `stations_fk_check`)
- `UK_AQ_AQI_FROM_HOUR_UTC` (backfill)
- `UK_AQ_AQI_TO_HOUR_UTC` (backfill)
- `UK_AQ_AQI_TIMESERIES_IDS_CSV` (optional timeseries filter; applies to manual targeted runs, including backfill/reconciliation)

## RPC Names

- `UK_AQ_AQI_HELPER_WINDOW_RPC` (default `uk_aq_rpc_timeseries_aqi_hourly_helper_window`)
- `UK_AQ_AQI_HOURLY_UPSERT_RPC` (default `uk_aq_rpc_timeseries_aqi_hourly_upsert`)
- `UK_AQ_AQI_ROLLUP_REFRESH_RPC` (default `uk_aq_rpc_timeseries_aqi_rollups_refresh`)
- `UK_AQ_AQI_RUN_LOG_RPC` (default `uk_aq_rpc_aqi_compute_run_log`)
- `UK_AQ_AQI_RUN_CLEANUP_RPC` (default `uk_aq_rpc_aqi_compute_runs_cleanup`)
- `UK_AQ_AQI_RUN_LOG_RETENTION_DAYS` (default `7`)

## Retry/Chunk Settings

- `UK_AQ_AQI_RPC_RETRIES` (default `3`)
- `UK_AQ_AQI_HOURLY_UPSERT_CHUNK_SIZE` (default `2000`)

## Reconciliation Behavior

- `sync_hourly` keeps the existing read-only helper-window flow
- `reconcile_short`, `reconcile_deep`, and `reconcile_deep_rolling` first run ingest RPC `uk_aq_rpc_timeseries_aqi_hourly_helper_upsert` for the computed mature window
- after helper refresh, the worker fetches the refreshed helper rows page-by-page and upserts AQI levels in Obs AQI DB

Deep reconciliation refreshes the helper window sequentially in bounded
exclusive-start/inclusive-end chunks. This avoids the observed
`canceling statement due to statement timeout` failure from one large helper
upsert while leaving hourly sync and short reconciliation unchanged. Chunk
metrics are summed, with maximum changed lag retained, before normal helper
paging, station-FK validation, AQI upsert, and rollups continue.

If deep reconcile still times out, lower
`UK_AQ_AQI_RECONCILE_DEEP_REFRESH_CHUNK_HOURS`. If it is stable but too slow,
increase the value cautiously; it cannot exceed the configured deep window.
Do not increase the Postgres statement timeout as the first fix.

## Missing station FK handling

`timeseries_aqi_hourly.station_id` references the mirrored
`uk_aq_core.stations(id)` table in Obs AQI DB. Before each hourly upsert page,
the worker checks all non-null candidate station IDs against that parent table.
Rows whose parent station is missing are skipped; valid rows continue through
the hourly upsert and daily/monthly rollups.

The REST preflight queries Obs AQI DB—not ingest DB—through the ID-only
`uk_aq_public.stations_fk_check` view. The underlying `uk_aq_core` schema is
intentionally not exposed through Obs AQI DB PostgREST. If the view has not
been applied, the worker fails with a station-FK preflight error before hourly
upsert work begins.

The worker emits a structured `missing_station_fk` error entry to stderr/Cloud
Logging and uploads the same structured record to
`/CIC-Test/error_log/YYYY-MM-DD/uk_aq_error_cloud_run_timeseries_aqi_hourly_*.json`
using the established Dropbox error-log convention. It includes the offending
IDs, run/trigger modes, UTC window, skipped-row count, and a sample capped at 20 rows.
Dropbox upload failure is logged as a warning and does not block valid
AQI rows. The final JSON summary also
contains `missing_station_fk_count`, `missing_station_fk_ids`,
`skipped_missing_station_fk_rows`, and
`continued_after_missing_station_fk`.

If the FK error still reaches the upsert despite preflight, the worker logs
`missing_station_fk_unhandled_by_preflight` and fails normally. Other database
errors are never swallowed. Operationally, refresh or repair the mirrored
stations table and rerun the affected hourly or reconciliation window.

Dropbox error uploads use `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`,
`DROPBOX_REFRESH_TOKEN`, and `UK_AQ_DROPBOX_ROOT`.
