# UK AQ Backfill Cloud Run Worker

Cloud Run worker for UK AQ operational backfill workflows.

Current implementation status (Phase 9, incremental):

- `local_to_aqilevels`: implemented.
- `obs_aqi_to_r2`: implemented (dry-run planning + non-dry R2 export/write path).
- `source_to_r2`: implemented for UK-AIR SOS, Sensor.Community, and OpenAQ source-to-R2 flows (metadata-filtered observations + aqilevels manifests written to R2).
  - Breathe London is also implemented, using the current public `getClarityData` API path as the nearest working equivalent to the planned `/SensorData` historical flow.

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
  - checks requested day window against actual committed day manifests in R2 (both domains):
    - `history/v1/observations/day_utc=YYYY-MM-DD/manifest.json`
    - `history/v1/aqilevels/day_utc=YYYY-MM-DD/manifest.json`
  - exports from `obs_aqidb` into both domains:
    - observations rows -> `history/v1/observations/...`
    - AQI hourly rows -> `history/v1/aqilevels/...`
  - each domain writes connector parquet part files, connector manifests, and a day manifest.
  - behavior:
    - `dry_run=true`: returns a planning summary (`backed_up_days`, `pending_backfill_days`) where "backed up" means both observations + aqilevels day manifests exist.
    - `dry_run=false`: writes pending day manifests and connector payloads to R2.
    - `force_replace=true`: re-exports selected days/connectors and overwrites manifests.
    - transient R2 request failures during upload/verification are retried automatically with bounded backoff before the run is marked failed.
    - run returns `error` when connector/day failures leave pending days.

- `source_to_r2`
  - supports source adapters:
    - Breathe London historical backfill (`/ListSensors` candidate sites + `/getClarityData/<SiteCode>/<Species>/<Start>/<End>/Hourly` direct API fetches).
    - UK-AIR SOS historical backfill (`/timeseries/{timeseries_ref}/getData?timespan=<UTC_DAY>&format=tvp` against the configured SOS base URL).
    - Sensor.Community archive backfill (`https://archive.sensor.community/YYYY-MM-DD/`).
    - OpenAQ AWS archive backfill (`records/csv.gz/locationid=<LOCATION_ID>/year=<YYYY>/month=<MM>/location-<LOCATION_ID>-<YYYYMMDD>.csv.gz`).
  - Breathe London source mapping follows existing connector metadata:
    - `station_ref = Breathe London SiteCode`
    - `timeseries_ref = <SiteCode>:IPM25|INO2`
  - Breathe London fetches are processed day-by-day, site-by-site, sequentially.
  - resolves known station/timeseries bindings from core metadata (R2 core snapshot first, ingest fallback).
  - UK-AIR SOS uses existing connector metadata (`stations`, `timeseries`, `phenomena`, `observed_properties`) to map:
    - `station_ref = existing UK-AIR SOS station_ref`
    - `timeseries_ref = existing UK-AIR SOS upstream timeseries id`
  - Sensor.Community filters by known `station_ref` (`sensor_id`).
  - OpenAQ uses candidate UK `location_id` from existing OpenAQ stations (`station_ref`) and maps source records with:
    - `station_ref = OpenAQ location_id`
    - `timeseries_ref = OpenAQ sensor_id`
  - parses raw observations to canonical `timeseries_id, observed_at, value` rows.
  - derives hourly AQI helper rows and computes DAQI/EAQI index levels in-worker.
  - writes connector parquet parts + connector manifests + day manifests for both:
    - `history/v1/observations/...`
    - `history/v1/aqilevels/...`
  - transient R2 request failures during upload/verification are retried automatically with bounded backoff before a connector/day is marked failed.
  - optional raw source mirrors for replay/dev:
    - `UK_AQ_BACKFILL_BREATHELONDON_RAW_MIRROR_ROOT`
    - `UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT`
    - `UK_AQ_BACKFILL_SCOMM_RAW_MIRROR_ROOT`
    - `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT`
  - SOS mirror note:
    - non-empty upstream payloads are mirrored as per-timeseries JSON files
    - exact empty upstream payloads such as `{"values":[]}` are tracked instead in a per-day `_no_data_timeseries.json` manifest
    - reruns consult that no-data manifest first so known-empty SOS timeseries/day combinations are not requested again
    - legacy empty per-timeseries mirror files can be migrated with:
      - `node scripts/backup_r2/uk_aq_cleanup_sos_empty_mirror_files.mjs --apply`
  - unresolved/unsupported connectors and transient source acquisition outages are returned in `source_acquisition_pending_days`.

## Runtime Status Values

- `ok`: run completed for requested scope.
- `dry_run`: planning mode, no writes.
- `stubbed`: run completed with pending source acquisition or another intentionally incomplete path.
- `error`: run failed.

## Required Environment

For `local_to_aqilevels`:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

For `obs_aqi_to_r2` and `source_to_r2` R2 export/write:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `CFLARE_R2_ENDPOINT` (or `R2_ENDPOINT`)
- `CFLARE_R2_REGION` (or `R2_REGION`, default `auto`)
- bucket via one of:
  - `CFLARE_R2_BUCKET` / `R2_BUCKET`
  - or deploy mapping `R2_BUCKET_PROD|R2_BUCKET_STAGE|R2_BUCKET_DEV` with `UK_AQ_DEPLOY_ENV`
- `CFLARE_R2_ACCESS_KEY_ID` (or `R2_ACCESS_KEY_ID`)
- `CFLARE_R2_SECRET_ACCESS_KEY` (or `R2_SECRET_ACCESS_KEY`)

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
- `UK_AQ_BACKFILL_OBS_R2_PAGE_SIZE` (default `20000`)
- `UK_AQ_BACKFILL_OBS_R2_MAX_PAGES` (default `50000`; safety ceiling for obs/aqi history export pagination)
- `UK_AQ_BACKFILL_R2_CORE_LOOKBACK_DAYS` (default `45`)
- `UK_AQ_BACKFILL_R2_CORE_SNAPSHOT_MAX_BYTES` (default `250000000`)

UK-AIR SOS source adapter:

- `UK_AQ_BACKFILL_UK_AIR_SOS_SOURCE_ENABLED` (default `true`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_CONNECTOR_CODE` (default `uk_air_sos`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_CONNECTOR_ID_FALLBACK` (default `1`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_BASE_URL` (default `https://uk-air.defra.gov.uk/sos-ukair/api/v1`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_INCLUDE_MET_FIELDS` (default `true`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_TIMEOUT_MS` (default `60000`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_FETCH_RETRIES` (default `3`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_RETRY_BASE_MS` (default `1500`)
- `UK_AQ_BACKFILL_UK_AIR_SOS_FETCH_CONCURRENCY` (default `5`)
- `UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT` (optional local replay mirror for SOS JSON payloads)
  - non-empty payloads are written as per-timeseries JSON files
  - exact empty payloads like `{"values":[]}` are recorded in `day_utc=YYYY-MM-DD/_no_data_timeseries.json`

Sensor.Community source adapter:

- `UK_AQ_BACKFILL_SCOMM_SOURCE_ENABLED` (default `true`)
- `UK_AQ_BACKFILL_SCOMM_CONNECTOR_CODE` (default `sensorcommunity`)
- `UK_AQ_BACKFILL_SCOMM_ARCHIVE_BASE_URL` (default `https://archive.sensor.community`)
- `UK_AQ_BACKFILL_SCOMM_INCLUDE_MET_FIELDS` (default `true`)
- `UK_AQ_BACKFILL_SCOMM_ARCHIVE_TIMEOUT_MS` (default `120000`)
- `UK_AQ_BACKFILL_SCOMM_ARCHIVE_FETCH_RETRIES` (default `3`)
- `UK_AQ_BACKFILL_SCOMM_ARCHIVE_RETRY_BASE_MS` (default `1500`)
- `UK_AQ_BACKFILL_SCOMM_RAW_MIRROR_ROOT` (optional local mirror root; downloaded source CSV files are reused/written under `day_utc=YYYY-MM-DD/`)

OpenAQ source adapter:

- `UK_AQ_BACKFILL_OPENAQ_SOURCE_ENABLED` (default `true`)
- `UK_AQ_BACKFILL_OPENAQ_CONNECTOR_CODE` (default `openaq`)
- `UK_AQ_BACKFILL_OPENAQ_CONNECTOR_ID_FALLBACK` (optional numeric fallback connector id)
- `UK_AQ_BACKFILL_OPENAQ_ARCHIVE_BASE_URL` (default `https://openaq-data-archive.s3.amazonaws.com`)
- `UK_AQ_BACKFILL_OPENAQ_INCLUDE_MET_FIELDS` (default `true`)
- `UK_AQ_BACKFILL_OPENAQ_ARCHIVE_TIMEOUT_MS` (default `120000`)
- `UK_AQ_BACKFILL_OPENAQ_ARCHIVE_FETCH_RETRIES` (default `3`)
- `UK_AQ_BACKFILL_OPENAQ_ARCHIVE_RETRY_BASE_MS` (default `1500`)
- `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT` (optional local mirror root for OpenAQ `.csv.gz` replay; only used when running `run_job.ts` locally)

Breathe London source adapter:

- `UK_AQ_BACKFILL_BREATHELONDON_SOURCE_ENABLED` (default `true`)
- `UK_AQ_BACKFILL_BREATHELONDON_CONNECTOR_CODE` (default `breathelondon`)
- `UK_AQ_BACKFILL_BREATHELONDON_CONNECTOR_ID_FALLBACK` (default `3`)
- `UK_AQ_BACKFILL_BREATHELONDON_BASE_URL` (default `https://api.breathelondon-communities.org/api`)
- `BREATHELONDON_API_KEY` (required when Breathe London source backfill is enabled)
- `UK_AQ_BACKFILL_BREATHELONDON_TIMEOUT_MS` (default `60000`)
- `UK_AQ_BACKFILL_BREATHELONDON_FETCH_RETRIES` (default `3`)
- `UK_AQ_BACKFILL_BREATHELONDON_RETRY_BASE_MS` (default `1500`)
- `UK_AQ_BACKFILL_BREATHELONDON_RAW_MIRROR_ROOT` (optional local replay mirror; per-request JSON responses are reused/written under `day_utc=YYYY-MM-DD/`)

RPC names:

- `UK_AQ_BACKFILL_HOURLY_FINGERPRINT_RPC` (default `uk_aq_rpc_observations_hourly_fingerprint`)
- `UK_AQ_BACKFILL_SOURCE_RPC` (default `uk_aq_rpc_station_aqi_hourly_source`)
- `UK_AQ_BACKFILL_AQILEVELS_HOURLY_UPSERT_RPC` (default `uk_aq_rpc_station_aqi_hourly_upsert`)
- `UK_AQ_BACKFILL_AQILEVELS_ROLLUP_REFRESH_RPC` (default `uk_aq_rpc_station_aqi_rollups_refresh`)
- `UK_AQ_BACKFILL_OBS_R2_SOURCE_RPC` (default `uk_aq_rpc_observs_history_day_rows`; falls back to direct `uk_aq_observs.observations` table query when missing)
- `UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC` (default `uk_aq_rpc_aqilevels_history_day_rows`)
- `UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC` (default `uk_aq_rpc_aqilevels_history_day_connector_counts`)

Fallback note:

- if `UK_AQ_BACKFILL_OBS_R2_SOURCE_RPC` is unavailable, expose `uk_aq_observs` in PostgREST for table fallback.
- `UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC` and `UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC` are required for AQI-domain export (apply schema RPC migration in `CIC-test-uk-aq-schema`).
- `obs_aqi_to_r2` export pagination continues until an empty page is returned (cursor-based); it does not stop early when a page is smaller than the requested page size.

R2 history prefixes:

- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels`)
- `UK_AQ_R2_HISTORY_CORE_PREFIX` (default `history/v1/core`)

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
    "run_mode": "source_to_r2",
    "dry_run": true,
    "from_day_utc": "2026-02-11",
    "to_day_utc": "2026-02-15",
    "connector_ids": [7]
  }'
```
