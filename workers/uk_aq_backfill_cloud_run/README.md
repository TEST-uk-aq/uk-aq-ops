# UK AQ Backfill Cloud Run Worker

Cloud Run worker for UK AQ operational backfill workflows.

Current implementation status (Phase 9, incremental):

- `local_to_aqilevels`: implemented.
- `obs_aqi_to_r2`: implemented as plan/check mode (dry-run planning + no-op success when days are already backed up).
- `source_to_all`: partially implemented (executes local retained days via `local_to_aqilevels`, reports non-local days as pending source acquisition).

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
  - processes newest selected UTC day first, then older days.
  - source priority per day/connector:
    - ingest DB for likely in-retention days.
    - obs_aqidb for older local days.
    - optional R2 fallback only when explicitly enabled.
  - default skip when checkpoint is already complete.
  - `force_replace=true` bypasses checkpoint skip.
  - writes Obs AQI hourly + rollups via AQI RPCs.

- `obs_aqi_to_r2`
  - checks requested day window against committed backup evidence.
  - uses:
    - `uk_aq_public.uk_aq_rpc_r2_history_window` (history min/max),
    - `uk_aq_ops.prune_day_gates` completion fields (`history_done`, `history_manifest_key`, `history_completed_at`).
  - behavior:
    - `dry_run=true`: returns a planning summary (`backed_up_days`, `pending_backfill_days`).
    - `dry_run=false` and all days already backed up: returns `ok`.
    - `dry_run=false` and pending days exist: throws by default.
    - if `UK_AQ_BACKFILL_ALLOW_STUB_MODES=true`, pending-day non-dry runs return `stubbed` (no writes executed).

- `source_to_all`
  - computes rolling local retention window.
  - runs `local_to_aqilevels` for retained UTC days inside that window.
  - returns `source_acquisition_pending_days` for non-local days (external acquisition/write path still pending).
  - non-dry runs with pending non-local days return `stubbed`.

## Runtime Status Values

- `ok`: run completed for requested scope.
- `dry_run`: planning mode, no writes.
- `stubbed`: run completed with intentionally unimplemented write path.
- `error`: run failed.

## Required Environment

For `local_to_aqilevels` and `source_to_all` local-write path:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

For `obs_aqi_to_r2` planning:

- `SUPABASE_URL`
- `SB_SECRET_KEY`

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
- `UK_AQ_BACKFILL_ALLOW_STUB_MODES` (default `false`)

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

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_backfill_ops_obs_aqi.sql` (canonical)

The same ledger tables are included in:

- `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`

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
    "run_mode": "source_to_all",
    "dry_run": true,
    "from_day_utc": "2026-02-01",
    "to_day_utc": "2026-02-05",
    "connector_ids": [4]
  }'
```
