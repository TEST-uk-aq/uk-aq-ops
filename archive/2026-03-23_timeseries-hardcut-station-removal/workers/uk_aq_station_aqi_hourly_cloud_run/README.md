# UK AQ Station AQI Hourly Cloud Run

Syncs precomputed station-hour AQI helper rows from ingest DB into Obs AQI DB (hourly upsert + daily/monthly rollup refresh).

Helper rows carry means/sample counts; AQI index levels are computed in the Obs AQI hourly upsert RPC. The worker now supports short and deep reconciliation windows so late-arriving observations can repair recent AQI stripe gaps without changing the normal hourly sync path. Reconciliation modes first rebuild the ingest helper window from raw observations, then page through helper-window RPC reads to avoid the PostgREST 1000-row response cap on table-valued RPC results.

If helper rows reference station IDs that have not yet been mirrored into Obs AQI DB `uk_aq_core`, the worker skips those rows and logs the missing station IDs instead of failing the whole run.

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
  "station_ids": [101, 102]
}
```

## Run Modes

- `sync_hourly`: latest mature hour-end window only
- `reconcile_short`: recent rolling window ending at the same mature hour-end, default `8` hours
- `reconcile_deep`: recent rolling window ending at the same mature hour-end, default `36` hours
- `backfill`: explicit hour-end range using `from_hour_utc` + `to_hour_utc`

## Required Environment

- `SUPABASE_URL` (ingest DB URL)
- `SB_SECRET_KEY` (ingest service key)
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## AQI Settings

- `UK_AQ_AQI_MATURITY_DELAY_HOURS` (default `3`)
- `UK_AQ_AQI_MATURITY_DELAY_BUFFER_MINUTES` (default `10`)
- `UK_AQ_AQI_RUN_MODE` (default `sync_hourly`)
- `UK_AQ_AQI_RECONCILE_SHORT_HOURS` (default `8`)
- `UK_AQ_AQI_RECONCILE_DEEP_HOURS` (default `36`)
- `UK_AQ_AQI_FROM_HOUR_UTC` (backfill)
- `UK_AQ_AQI_TO_HOUR_UTC` (backfill)
- `UK_AQ_AQI_STATION_IDS_CSV` (optional station filter; applies to manual targeted runs, including backfill/reconciliation)

## RPC Names

- `UK_AQ_AQI_HELPER_WINDOW_RPC` (default `uk_aq_rpc_station_aqi_hourly_helper_window`)
- `UK_AQ_AQI_HOURLY_UPSERT_RPC` (default `uk_aq_rpc_station_aqi_hourly_upsert`)
- `UK_AQ_AQI_ROLLUP_REFRESH_RPC` (default `uk_aq_rpc_station_aqi_rollups_refresh`)
- `UK_AQ_AQI_RUN_LOG_RPC` (default `uk_aq_rpc_aqi_compute_run_log`)
- `UK_AQ_AQI_RUN_CLEANUP_RPC` (default `uk_aq_rpc_aqi_compute_runs_cleanup`)
- `UK_AQ_AQI_RUN_LOG_RETENTION_DAYS` (default `7`)

## Retry/Chunk Settings

- `UK_AQ_AQI_RPC_RETRIES` (default `3`)
- `UK_AQ_AQI_HOURLY_UPSERT_CHUNK_SIZE` (default `2000`)

## Reconciliation Behavior

- `sync_hourly` keeps the existing read-only helper-window flow
- `reconcile_short` and `reconcile_deep` first run ingest RPC `uk_aq_rpc_station_aqi_hourly_helper_upsert` for the computed mature window
- after helper refresh, the worker fetches the refreshed helper rows page-by-page and upserts AQI levels in Obs AQI DB
- before hourly upsert, the worker filters out helper rows whose `station_id` is still missing from Obs AQI DB mirrored station metadata and logs skipped IDs/row counts
