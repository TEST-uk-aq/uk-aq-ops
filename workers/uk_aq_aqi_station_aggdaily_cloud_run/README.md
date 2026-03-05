# UK AQ Station AQI AggDaily Cloud Run

Computes station-hour DAQI + EAQI rows (pollutant-specific) from ingest observations and writes to AggDaily DB.

## Endpoints

- `GET /` health
- `POST /` run job

`POST /` request body (all optional):

```json
{
  "trigger_mode": "scheduler",
  "run_mode": "fast",
  "from_hour_utc": "2026-03-01T00:00:00Z",
  "to_hour_utc": "2026-03-01T23:00:00Z",
  "station_ids": [101, 102]
}
```

## Run Modes

- `fast`: latest mature hour only
- `reconcile_short`: mature lookback window (default 36h)
- `reconcile_deep`: deep mature lookback window (default 14d)
- `backfill`: explicit hour range using `from_hour_utc` + `to_hour_utc`

## Required Environment

- `SUPABASE_URL` (ingest DB URL)
- `SB_SECRET_KEY` (ingest service key)
- `AGGDAILY_SUPABASE_URL`
- `AGGDAILY_SECRET_KEY`

## AQI Settings

- `UK_AQ_AQI_MATURITY_DELAY_HOURS` (default `3`)
- `UK_AQ_AQI_SHORT_LOOKBACK_HOURS` (default `36`)
- `UK_AQ_AQI_DEEP_LOOKBACK_DAYS` (default `14`)
- `UK_AQ_AQI_RUN_MODE` (default `fast`)
- `UK_AQ_AQI_FROM_HOUR_UTC` (backfill)
- `UK_AQ_AQI_TO_HOUR_UTC` (backfill)
- `UK_AQ_AQI_STATION_IDS_CSV` (optional station filter)

## RPC Names

- `UK_AQ_AQI_SOURCE_RPC` (default `uk_aq_rpc_station_aqi_hourly_source`)
- `UK_AQ_AQI_BREAKPOINTS_RPC` (default `uk_aq_rpc_aqi_breakpoints_active`)
- `UK_AQ_AQI_HOURLY_UPSERT_RPC` (default `uk_aq_rpc_station_aqi_hourly_upsert`)
- `UK_AQ_AQI_ROLLUP_REFRESH_RPC` (default `uk_aq_rpc_station_aqi_rollups_refresh`)
- `UK_AQ_AQI_RUN_LOG_RPC` (default `uk_aq_rpc_aqi_compute_run_log`)
- `UK_AQ_AQI_RUN_CLEANUP_RPC` (default `uk_aq_rpc_aqi_compute_runs_cleanup`)
- `UK_AQ_AQI_RUN_LOG_RETENTION_DAYS` (default `7`)

## Retry/Chunk Settings

- `UK_AQ_AQI_RPC_RETRIES` (default `3`)
- `UK_AQ_AQI_SOURCE_PAGE_SIZE` (default `1000`)
- `UK_AQ_AQI_HOURLY_UPSERT_CHUNK_SIZE` (default `2000`)
