# UK AQ Backfill Cloud Run Worker

Cloud Run worker for UK AQ operational backfill workflows.

Phase 1 implementation status:

- `local_to_aqilevels`: implemented
- `obs_aqi_to_r2`: wired stub (not yet implemented)
- `source_to_all`: wired stub (not yet implemented)

## Endpoints

- `GET /` health
- `POST /` run job
- `POST /run` run job (alias)

## Request Body

All fields are optional unless noted.

```json
{
  "trigger_mode": "manual",
  "run_mode": "local_to_aqilevels",
  "dry_run": true,
  "force_replace": false,
  "from_day_utc": "2026-02-01",
  "to_day_utc": "2026-02-10",
  "connector_ids": [4, 7],
  "enable_r2_fallback": false
}
```

## Run Modes

- `local_to_aqilevels`
  - phase 1 implemented
  - processes newest selected UTC day first, then older days
  - uses source priority per day/connector:
    - ingest DB for likely in-retention days
    - observs DB for older local days
    - R2 only when explicit fallback is enabled
  - default skip if checkpoint is already complete
  - `force_replace=true` bypasses skip
  - writes Obs AQI hourly + rollups via existing AQI RPCs

- `obs_aqi_to_r2`
  - phase 1 stub only

- `source_to_all`
  - phase 1 stub only
  - retention helper is active and classifies observs-write eligible/skipped days

## Required Environment

For `local_to_aqilevels`:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Optional Environment

Core:

- `UK_AQ_BACKFILL_RUN_MODE` (default `local_to_aqilevels`)
- `UK_AQ_BACKFILL_TRIGGER_MODE` (default `manual`)
- `UK_AQ_BACKFILL_DRY_RUN` (default `false`)
- `UK_AQ_BACKFILL_FORCE_REPLACE` (default `false`)
- `UK_AQ_BACKFILL_FROM_DAY_UTC` (default yesterday UTC)
- `UK_AQ_BACKFILL_TO_DAY_UTC` (default `from_day_utc`)
- `UK_AQ_BACKFILL_CONNECTOR_IDS` (optional filter)
- `UK_AQ_BACKFILL_ENABLE_R2_FALLBACK` (default `false`)

Retention / iteration:

- `UK_AQ_BACKFILL_INGEST_RETENTION_DAYS` (default `7`)
- `UK_AQ_BACKFILL_OBS_AQI_LOCAL_RETENTION_DAYS` (default `31`)
- `UK_AQ_BACKFILL_LOCAL_TIMEZONE` (default `Europe/London`)
- `UK_AQ_BACKFILL_STATION_ID_PAGE_SIZE` (default `1000`)
- `UK_AQ_BACKFILL_HOURLY_UPSERT_CHUNK_SIZE` (default `2000`)
- `UK_AQ_BACKFILL_RPC_RETRIES` (default `3`)

Source RPC paging:

- `UK_AQ_BACKFILL_SOURCE_RPC_PAGE_SIZE` (default `1000`)
- `UK_AQ_BACKFILL_SOURCE_RPC_MAX_PAGES` (default `200`)

RPC names:

- `UK_AQ_BACKFILL_HOURLY_FINGERPRINT_RPC` (default `uk_aq_rpc_observations_hourly_fingerprint`)
- `UK_AQ_BACKFILL_SOURCE_RPC` (default `uk_aq_rpc_station_aqi_hourly_source`)
- `UK_AQ_BACKFILL_AQILEVELS_HOURLY_UPSERT_RPC` (default `uk_aq_rpc_station_aqi_hourly_upsert`)
- `UK_AQ_BACKFILL_AQILEVELS_ROLLUP_REFRESH_RPC` (default `uk_aq_rpc_station_aqi_rollups_refresh`)

Ledger:

- `UK_AQ_BACKFILL_LEDGER_ENABLED` (default `true`)
- `UK_AQ_BACKFILL_DRY_RUN_WRITE_LEDGER` (default `false`)
- `UK_AQ_BACKFILL_OPS_SCHEMA` (default `uk_aq_ops`)

## Ledger Tables (Obs AQI)

If you want persistent skip/checkpoint behavior across runs, apply:

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/aqilevels_db/uk_aq_backfill_ops_obs_aqi.sql` (canonical)

The same ledger tables are included in:

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/aqilevels_db/uk_aq_aqilevels_schema.sql`

Tables:

- `uk_aq_ops.backfill_runs`
- `uk_aq_ops.backfill_run_days`
- `uk_aq_ops.backfill_checkpoints`
- `uk_aq_ops.backfill_errors`

## Manual Invocation Example

```bash
curl -X POST "https://<cloud-run-url>/run" \
  -H "content-type: application/json" \
  -d '{
    "trigger_mode": "manual",
    "run_mode": "local_to_aqilevels",
    "dry_run": true,
    "from_day_utc": "2026-02-01",
    "to_day_utc": "2026-02-05",
    "connector_ids": [4]
  }'
```
