# UK AQ AQI History R2 API Worker

Repo owner: `uk-aq-ops`
Worker path: `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
Deploy workflow: `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`

## Purpose

Cloudflare Worker for timeseries AQI history reads, stitched from:

- primary source: R2 backups (`history/v1/aqilevels`)
- fallback/repair source for recent gaps: `obs_aqidb` (`uk_aq_public.uk_aq_timeseries_aqi_hourly`)

This is intended for website DAQI/EAQI charts where recent AQI is not yet exported to R2.

## Routes

- `GET /v1/aqi-history`
- alias: `GET /`

## Query model

Required:

- `timeseries_id` (positive integer)
  - aliases accepted: `entity`, `entity_id`

Optional:

- `scope` (must be `timeseries`; default `timeseries`)
- `grain` (must be `hourly`; default `hourly`)
- `format`
  - default `compact` JSON with `columns` + compact `points` arrays
  - `json` is accepted as an alias for compact JSON
  - `objects` returns row-object JSON
  - `tsv` returns the legacy tab-separated payload
- time range:
  - `from_utc` + `to_utc` (ISO timestamps)
  - aliases: `start_utc`/`end_utc`, `from`/`to`, `start`/`end`
  - or `days` lookback (default `1`)
- `since_utc` (ISO timestamp, exclusive lower bound)
  - alias: `since`
- `row_limit` (`1..20000`)
  - alias: `limit`
- `pollutant` (`pm25`, `pm10`, `no2`)
  - when present, the generic `daqi_index_level` / `eaqi_index_level` fields in each point are set from that pollutant only
  - pollutant-specific AQI columns are always returned in each point for explicit client-side mapping

Window split behavior:

- worker reads R2 first across the full requested range.
- `UK_AQ_AQI_HISTORY_SOURCE_OF_TRUTH_HOURS` (default `168`) defines the recent fallback window eligible for ObsAQIDB repairs.
- worker calls ObsAQIDB only when recent R2 coverage appears missing or incomplete.
- overlapping timestamps are de-duplicated by hour, with R2 rows winning.
- if ObsAQIDB fallback fails, R2 results are still returned when available.
- cache TTL is also dynamic by the requested end time:
  - requests ending within the last 24 hours use the short live TTL
  - requests ending more than 24 hours ago use the long immutable-history TTL

## Auth

- Requires header `x-uk-aq-upstream-auth`.
- Header value must equal Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`.

## R2 requirements

- Bucket binding: `UK_AQ_HISTORY_BUCKET`.
- Prefix default: `history/v1/aqilevels`.
- Reads day manifests first, then connector manifests/files under each day.
- For the R2 segment, the worker resolves timeseries window context from `uk_aq_public.uk_aq_timeseries_aqi_hourly` (connector id, station id, and window timeseries ids) and narrows scans accordingly.
- Optional AQI timeseries index fast-path:
  - prefix default: `history/_index/aqilevels_timeseries`
  - index key shape: `day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
  - worker resolves window timeseries ids from `uk_aq_public.uk_aq_timeseries_aqi_hourly` and narrows parquet scans by `min_timeseries_id/max_timeseries_id`.
  - if the resolved window timeseries id list is explicitly empty for the requested window, the worker fast-returns an empty history segment and skips R2 parquet scans to avoid CPU-limit failures.
  - missing/invalid index entries fall back to connector manifest scanning.
- AQI parquet reads use `timeseries_id` row-group stats plus chunked column reads so the worker does not materialize whole parquet files for single-timeseries requests.
- Day-level R2 scans are processed newest-first so when scan budgets are hit, recent overlap near the live split is prioritized over older history.
- Immutable day AQI band objects are cached in R2 under:
  - `history/v1/aqilevels/bands/v1/day_utc=YYYY-MM-DD/connector_id=NN/timeseries_ids=.../pollutant=all|pm25|pm10|no2.json`
  - cache reads are only used for full-day immutable windows
  - writes are queued with `ctx.waitUntil()` after a clean scan of a full-day immutable window completes

## Required GitHub env/secret targets

Variables:

- `UK_AQ_AQI_HISTORY_R2_API_WORKER_NAME` (optional; default `uk-aq-aqi-history-r2-api`)
- `UK_AQ_AQI_HISTORY_R2_API_CLOUDFLARE_ACCOUNT_ID` (or fallback `CLOUDFLARE_ACCOUNT_ID`)

Secrets:

- `UK_AQ_AQI_HISTORY_R2_API_CLOUDFLARE_API_TOKEN` (or fallback `CLOUDFLARE_API_TOKEN`)
- `UK_AQ_EDGE_UPSTREAM_SECRET`
- `OBS_AQIDB_SECRET_KEY`

Variables:

- `OBS_AQIDB_SUPABASE_URL`

## Runtime vars (wrangler defaults)

- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels`
- `UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index`
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX=history/_index/aqilevels_timeseries`
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED=true`
- `UK_AQ_AQI_HISTORY_R2_CACHE_MAX_AGE_SECONDS=300`
- `UK_AQ_AQI_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS=86400`
- `UK_AQ_AQI_HISTORY_SOURCE_OF_TRUTH_HOURS=168` (default)
- `UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS=10000` (default)
- `UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE=5000` (default)
- `UK_AQ_PUBLIC_SCHEMA=uk_aq_public`

## Cache proxy integration

Cache proxy route `/api/aq/aqi-history` should target this worker via:

- GitHub variable `UK_AQ_AQI_HISTORY_R2_API_URL=https://<worker-host>/v1/aqi-history`

Do not point `UK_AQ_AQI_HISTORY_R2_API_URL` back to `/api/aq/aqi-history` (would recurse).

## Response diagnostics

Coverage metadata includes fallback status for the recent window:

- `coverage.obs_aqidb_status`: `not_requested`, `fallback_live`, or `fallback_error`
- `coverage.obs_aqidb_error`: fallback read error message when present
- `coverage.target_connector_id`: resolved connector id for the requested timeseries window context when lookup succeeds
- `coverage.target_station_id`: resolved station id for the requested timeseries window context (metadata only; parquet filtering is timeseries-based)
- `coverage.timeseries_window_context_lookup_source_path`: PostgREST source used for timeseries window context lookup
- `coverage.timeseries_window_context_lookup_error`: lookup error when window-context resolution fails and index filtering falls back to minimal timeseries-only context
- `coverage.timeseries_window_context_lookup_cache_hit`: whether the in-worker window-context cache served the lookup
- `coverage.target_timeseries_id_count`: number of timeseries ids used for AQI index filtering
- `coverage.history_scan_complete` / `coverage.history_scan_stopped_reason`: whether the main R2 history scan completed without budget cut-off
- `coverage.timeseries_index`: AQI index diagnostics for the main history segment (`enabled`, `prefix`, `hit_count`, `miss_count`, `skipped_days_by_file_range`, `skipped_files_by_pollutant`, and warnings)
- `coverage.aqi_band_cache`: band-cache diagnostics (`enabled`, `prefix`, `eligible_day_count`, `hit_count`, `miss_count`, `write_count`, `skipped_day_count`)
- `coverage.obs_aqidb_fallback_used`: whether ObsAQIDB fallback rows were merged
- `coverage.obs_aqidb_fallback_reason`: currently `r2_recent_missing_or_incomplete` when fallback path runs
- `coverage.obs_aqidb_fallback_recent_r2_point_count`: R2 hourly point count in the recent fallback window
- `coverage.obs_aqidb_fallback_error`: fallback error when ObsAQIDB fallback fails but R2 data was still returned
- top-level `response_complete`: `true` when required R2 scans were not cut short by scan budgets
- top-level `cache_scope`: `recent` or `immutable`
- top-level `wire_format`: `json` for JSON responses, `tsv` for legacy text
- top-level `data_format`: `compact` or `objects` when JSON is returned

## Point payload

Default `format=compact` JSON returns `columns` plus compact `points[]` arrays. `format=objects` returns row objects.

Each row object includes:

- `period_start_utc`
- `timeseries_id`
- `station_id`
- generic AQI fields:
  - `daqi_index_level`
  - `eaqi_index_level`
- pollutant-specific AQI fields:
  - `daqi_no2_index_level`
  - `daqi_pm25_rolling24h_index_level`
  - `daqi_pm10_rolling24h_index_level`
  - `eaqi_no2_index_level`
- `eaqi_pm25_index_level`
- `eaqi_pm10_index_level`

When `pollutant` is omitted, the generic pair remains the max-across-supported-pollutants summary for backward compatibility. New chart clients should read the pollutant-specific fields directly.

Implementation note:

- R2 parquet reads are now based on normalized AQI rows (`pollutant_code`, `daqi_index_level`, `eaqi_index_level`).
- Pollutant-specific response fields remain available and are derived/aggregated at read time for compatibility.
