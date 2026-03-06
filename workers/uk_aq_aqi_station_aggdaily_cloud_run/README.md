# UK AQ Station AQI AggDaily Cloud Run

Syncs precomputed station-hour AQI helper rows from ingest DB into AggDaily DB (hourly upsert + daily/monthly rollup refresh).

Helper rows carry means/sample counts; AQI index levels are computed in the AggDaily hourly upsert RPC.

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
- `backfill`: explicit hour-end range using `from_hour_utc` + `to_hour_utc`

## Required Environment

- `SUPABASE_URL` (ingest DB URL)
- `SB_SECRET_KEY` (ingest service key)
- `AGGDAILY_SUPABASE_URL`
- `AGGDAILY_SECRET_KEY`

## AQI Settings

- `UK_AQ_AQI_MATURITY_DELAY_HOURS` (default `3`)
- `UK_AQ_AQI_MATURITY_DELAY_BUFFER_MINUTES` (default `10`)
- `UK_AQ_AQI_RUN_MODE` (default `sync_hourly`)
- `UK_AQ_AQI_FROM_HOUR_UTC` (backfill)
- `UK_AQ_AQI_TO_HOUR_UTC` (backfill)
- `UK_AQ_AQI_STATION_IDS_CSV` (optional station filter)

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
