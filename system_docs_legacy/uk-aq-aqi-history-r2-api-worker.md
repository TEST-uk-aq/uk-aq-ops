# UK AQ AQI History R2 API Worker

Repo owner: `uk-aq-ops`
Worker path: `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
Deploy workflow: `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`

## Purpose

Cloudflare Worker for timeseries AQI history reads, stitched from:

- primary source for `read_version=v2`: R2 v2 AQI history (`history/v2/aqilevels/hourly/data`) for the full requested range
- fill source for `read_version=v2`: `obs_aqidb` (`uk_aq_public.uk_aq_timeseries_aqi_hourly`) only for hourly rows missing from R2, or when R2 is unavailable
- legacy `read_version=v1` source split: R2 v1 history plus ObsAQIDB recent/overlap fallback

This is intended for website DAQI/EAQI charts and station snapshot v2. V2 requests are R2-first so complete backed-up AQI day parquet and `_index_v2` manifests are not masked by shorter ObsAQIDB retention.

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
- `pollutant` (`pm25`, `pm10`, `no2`) — required
  - the worker returns only rows for the requested pollutant_code; omitted or invalid pollutants return HTTP 400 to avoid broad all-pollutant reads
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
  - limits only returned `points`; expected-hour completeness is calculated before row limiting and reported with `row_limit_applied`, `row_limit`, `pre_limit_row_count`, and `returned_row_count` metadata

Source strategy:

- `read_version=v2` requests read R2 v2 AQI history first for the full requested range.
- V2 R2 reads use data files under `history/v2/aqilevels/hourly/data` and manifest-based indexes under `history/_index_v2/aqilevels_hourly_data_timeseries`.
- V2 timeseries index keys are pollutant partitioned: `day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=P/manifest.json`. The worker reads the manifest and uses `files[].key` to locate the real AQI data parquet files; `_index_v2` itself is not scanned for parquet files.
- ObsAQIDB remains available for v2, but only as a fill source when R2 expected-hour coverage is incomplete or R2 is unavailable. The worker does not query ObsAQIDB when R2 already covers the expected hours. Fill queries use the smallest contiguous missing-hour window currently implemented, and overlapping row keys (`period_start_utc` + `timeseries_id` + `pollutant_code`) are de-duplicated with R2 rows winning.
- V2 responses report source metadata such as `r2_first`, `r2_first_with_obs_aqidb_fill`, or `obs_aqidb_fill_only_r2_unavailable`.
- `read_version=v1` keeps the legacy rolling split with `INGESTDB_RETENTION_DAYS`:
  - retention range (`now - INGESTDB_RETENTION_DAYS` to now): ObsAQIDB only
  - one-day overlap (the day before retention): R2 preferred, ObsAQIDB fills only hours missing from R2
  - historical range (older than the overlap): R2 only
- if ObsAQIDB fallback fails, v2 still returns available R2 rows with partial metadata; v1 keeps existing historical-slice fallback behavior.
- cache TTL is also dynamic by the requested end time:
  - requests ending within the last 24 hours use the short live TTL
  - requests ending more than 24 hours ago use the long immutable-history TTL

## Auth

- Requires header `x-uk-aq-upstream-auth`.
- Header value must equal Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`.

## R2 requirements

- Bucket binding: `UK_AQ_HISTORY_BUCKET`.
- Prefix default: `history/v1/aqilevels/hourly`.
- Reads day manifests first, then connector manifests/files under each day.
- For the R2 segment, the worker resolves timeseries window context from `uk_aq_public.uk_aq_timeseries_aqi_hourly` (connector id, station id, and window timeseries ids) and narrows scans accordingly.
- If that ObsAQIDB lookup misses for an R2-only timeseries, the worker still scans R2 directly by timeseries id across day connector manifests instead of returning an empty response.
- Optional AQI timeseries index fast-path:
  - prefix default: `history/_index/aqilevels_timeseries`
  - index key shape: `day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
  - worker resolves window timeseries ids from `uk_aq_public.uk_aq_timeseries_aqi_hourly` and narrows parquet scans by `min_timeseries_id/max_timeseries_id`.
  - if the resolved window timeseries id list is explicitly empty for the requested window, the worker fast-returns an empty history segment and skips R2 parquet scans to avoid CPU-limit failures.
  - missing/invalid index entries do not fall back to connector manifest scanning when `UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX=true`.
  - if the connector context cannot be resolved while the index is required, the worker returns structured partial JSON with `response_complete=false` and `partial_reasons` instead of scanning every connector manifest for every day.
- AQI parquet reads use `timeseries_id` row-group stats plus chunked column reads so the worker does not materialize whole parquet files for single-timeseries requests.
- Day-level R2 scans are processed newest-first so when scan budgets are hit, recent overlap near the live split is prioritized over older history.
- The normal indexed path reads the per-day connector index directly when `connector_id` is known; it does not read the day manifest first.
- Safety budgets stop a request before Cloudflare kills the Worker. Budget stops return HTTP 200 partial JSON with diagnostics rather than Cloudflare HTML:
  - max parquet files
  - max R2 object reads
  - max parquet row groups
  - max parquet chunks
  - max scan elapsed milliseconds
- Legacy hourly AQI band-cache objects under `history/v1/aqilevels/hourly/bands/v1/...` are no longer read or written by this worker; the live API serves normalized rows directly from R2 plus the ObsAQIDB retention fallback.

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

- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly`
- `UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index`
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX=history/_index/aqilevels_timeseries`
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED=true`
- `UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX=true`
- `UK_AQ_AQI_HISTORY_R2_CACHE_MAX_AGE_SECONDS=300`
- `UK_AQ_AQI_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS=86400`
- `UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=true` (default; set `false` only when proxy-owned public AQI caching is being validated)
- `UK_AQ_AQI_MUTABLE_HOURS=120` (default; bounded `1`-`720`)
- `INGESTDB_RETENTION_DAYS=5` (default)
- `UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS=10000` (default)
- `UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE=5000` (default)
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_FILES_PER_REQUEST=120`
- `UK_AQ_AQI_HISTORY_R2_MAX_R2_OBJECT_READS_PER_REQUEST=80`
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_ROW_GROUPS_PER_REQUEST=300`
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_CHUNKS_PER_REQUEST=600`
- `UK_AQ_AQI_HISTORY_R2_MAX_SCAN_ELAPSED_MS=12000`
- `UK_AQ_PUBLIC_SCHEMA=uk_aq_public`

## Cache proxy integration

Cache proxy route `/api/aq/aqi-history` should target this worker via:

- GitHub variable `UK_AQ_AQI_HISTORY_R2_API_URL=https://<worker-host>/v1/aqi-history`

Do not point `UK_AQ_AQI_HISTORY_R2_API_URL` back to `/api/aq/aqi-history` (would recurse).

## Response diagnostics

Coverage metadata includes fallback status for the recent window:

- `coverage.obs_aqidb_status`: `not_requested`, `fallback_live`, or `fallback_error`
- `coverage.obs_aqidb_error`: fallback read error message when present
- `coverage.ingest_retention_days`: retention days used for the recent merge window
- `coverage.overlap_start_utc` / `coverage.retention_start_utc`: rolling split boundaries used for the request
- `coverage.source_coverage`: interval-level source diagnostics for historical, overlap, and retention zones
- `coverage.historical_window_*`, `coverage.overlap_window_*`, `coverage.retention_window_*`: request windows after source splitting
- `coverage.r2_window_*`: R2 request window; for `read_version=v2` this spans the full requested range, while v1 ends at or before `retention_start_utc`
- `coverage.obs_aqidb_window_*`: for `read_version=v2`, the missing-hour fill window when R2-only coverage is incomplete; it is null/not requested when R2 coverage is complete. For v1, this is the live AQI window used for overlap fill plus retention rows
- `coverage.overlap_r2_point_count`, `coverage.overlap_obs_aqidb_candidate_row_count`, `coverage.overlap_obs_aqidb_fill_row_count`, `coverage.retention_obs_aqidb_row_count`: source merge counts
- `coverage.target_connector_id`: resolved connector id for the requested timeseries window context when lookup succeeds
- `coverage.target_station_id`: resolved station id for the requested timeseries window context (metadata only; parquet filtering is timeseries-based)
- `coverage.timeseries_window_context_lookup_source_path`: PostgREST source used for timeseries window context lookup
- `coverage.timeseries_window_context_lookup_error`: lookup error when window-context resolution fails and index filtering falls back to minimal timeseries-only context
- `coverage.timeseries_window_context_lookup_cache_hit`: whether the in-worker window-context cache served the lookup
- `coverage.target_timeseries_id_count`: number of timeseries ids used for AQI index filtering
- `coverage.history_scan_complete` / `coverage.history_scan_stopped_reason`: whether the main R2 history scan completed without budget cut-off
- `coverage.timeseries_index`: AQI index diagnostics for the main history segment (`enabled`, `prefix`, `hit_count`, `miss_count`, `skipped_days_by_file_range`, `skipped_files_by_pollutant`, and warnings)
- `coverage.scan_metrics`: request safety counters and limits (`r2_object_reads`, `r2_list_operations`, `parquet_row_groups_scanned`, `parquet_chunks_scanned`, decoded row counts, and `stopped_reason`)
- `coverage.row_summary`: returned-row diagnostics (`parsed_point_count`, `null_daqi_count`, `null_eaqi_count`, `source_counts`, `source_coverage_counts`, `pollutant_counts`, and calculation-status / missing-reason counts)
- `coverage.resolved_connector_id`: connector id discovered from R2 when ObsAQIDB context lookup misses
- `coverage.obs_aqidb_fallback_used`: whether ObsAQIDB fallback rows were merged
- `coverage.obs_aqidb_fallback_reason`: `overlap_missing_hour_fill_and_retention` when the deterministic ObsAQIDB merge window is queried
- `coverage.obs_aqidb_fallback_recent_r2_point_count`: R2 hourly point count in the recent fallback window
- `coverage.obs_aqidb_fallback_error`: fallback error when ObsAQIDB fallback fails but R2 data was still returned
- top-level `source_of_truth_days` / `source_of_truth_hours`: derived from `INGESTDB_RETENTION_DAYS`
- `coverage.r2_expected_hour_coverage`: R2-only expected-hour coverage for the requested timeseries/pollutant. The v2 `source_coverage` `full_range` entry is based on this R2-only summary.
- `coverage.merged_expected_hour_coverage` and `meta.expected_hour_coverage`: expected-hour coverage after R2 rows plus ObsAQIDB fill rows have been merged.
- top-level `response_complete`: `true` only when required scans/fill sources completed and merged expected hourly AQI coverage is complete for the requested timeseries/pollutant
- `expected_hour_count`, `present_expected_hour_count`, `missing_expected_hour_count`, and `missing_expected_hours`: expected-hour coverage diagnostics from `from_utc/start_utc` inclusive to `to_utc/end_utc` exclusive, respecting `since` as an exclusive incremental lower bound
- top-level `has_gap`, `coverage_state`, and `partial_reasons`: client-facing gap diagnostics; missing expected rows add `missing_expected_aqi_hours` and make `coverage_state=partial`
- top-level `cache_scope`: `recent` or `immutable`
- top-level `wire_format`: `json` for JSON responses, `tsv` for legacy text
- top-level `data_format`: `compact` or `objects` when JSON is returned
- partial responses set `X-UK-AQ-Response-Complete: false` and `Cache-Control: no-store`, and are not written to the Worker cache

## Point payload

Default `format=compact` JSON returns `columns` plus compact `points[]` arrays. `format=objects` returns row objects.

Each row object includes:

- `period_start_utc`
- `connector_id`
- `station_id`
- `timeseries_id`
- `pollutant_code`
- `daqi_index_level`
- `eaqi_index_level`
- `daqi_input_value_ugm3`
- `daqi_input_averaging_code`
- `eaqi_input_value_ugm3`
- `eaqi_input_averaging_code`
- `daqi_calculation_status`
- `eaqi_calculation_status`
- `source`
- `source_coverage`

The response returns one row per hour for the required `pollutant`. Omitted pollutants are rejected with HTTP 400; the worker does not serve all-pollutant AQI history responses.

`source` is `r2` or `obs_aqidb`. In v2, `source_coverage` is `r2_first_full_range` or `obs_aqidb_fill`; in v1 it remains `historical`, `overlap`, or `retention`.

Implementation note:

- R2 parquet reads are based on normalized AQI rows (`pollutant_code`, `timestamp_hour_utc`, `daqi_input_*`, `eaqi_input_*`, `*_calculation_status`, and the row-level AQI index fields).
- The live response path no longer depends on the old wide pollutant-specific AQI fields.
