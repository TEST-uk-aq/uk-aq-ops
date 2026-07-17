# UK AQ AQI History R2 API Worker

Cloudflare Worker for AQI history reads with stitched sources:

- primary source: R2 History
- fallback/repair source for recent gaps: `obs_aqidb` (`uk_aq_public.uk_aq_timeseries_aqi_hourly`)

Routes:

- `GET /v1/aqi-history`
- alias: `GET /`

Required query params:

- `timeseries_id` (positive integer)
  - aliases accepted: `entity`, `entity_id`

Optional query params:

- `scope` (must be `timeseries`; default `timeseries`)
- `grain` (must be `hourly`; default `hourly`)
- `pollutant` (`pm25`, `pm10`, `no2`)
  - when supplied, the worker returns only rows for that pollutant_code
- `format`
  - default `compact` JSON with `columns` + compact `points` arrays
  - aliases:
    - `json` -> compact JSON
    - `objects` -> row-object JSON
    - `tsv` -> legacy tab-separated text
- time range (one of):
  - `from_utc` + `to_utc` (ISO timestamps)
  - aliases: `start_utc`/`end_utc`, `from`/`to`, `start`/`end`
  - or `days` (lookback window, default `1`)
- `since_utc` (ISO timestamp, exclusive lower bound)
  - alias: `since`
- `row_limit` (`1..20000`)
  - alias: `limit`

Auth:

- requires header: `x-uk-aq-upstream-auth`
- value must match Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`

R2 paths expected:

- day manifest:
  - `${UK_AQ_R2_HISTORY_AQILEVELS_PREFIX}/day_utc=YYYY-MM-DD/manifest.json`
- connector manifest:
  - `${UK_AQ_R2_HISTORY_AQILEVELS_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`
- in v2, the worker resolves timeseries window context from the stable R2
  binding, then `uk_aq_public.uk_aq_timeseries_aqi_hourly`; this narrows scans
  without deriving routing from daily coverage
- the ObsAQIDB fallback query reads the normalized hourly AQI contract directly (`daqi_input_*`, `eaqi_input_*`, `*_calculation_status`, `*_missing_reason`, and source counts) and the worker returns those normalized rows directly
- if the ObsAQIDB context lookup misses while `UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX=true`, the worker returns structured partial JSON instead of scanning every connector manifest for every day
- optional AQI timeseries index (fast-path):
  - `${UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`
  - the worker resolves window timeseries ids from `uk_aq_public.uk_aq_timeseries_aqi_hourly` and narrows parquet file scans using each file's `min_timeseries_id/max_timeseries_id`
  - if the optional index is missing/invalid for a day+connector and `UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX=true`, connector manifest fallback is skipped and the response is marked partial
- AQI parquet reads use `timeseries_id` row-group stats and chunked column reads instead of materializing whole parquet files
- safety budgets cap R2 object reads, parquet files, row groups, parquet chunks, and elapsed scan time; budget stops return partial JSON with diagnostics instead of running until Cloudflare terminates the Worker
- legacy hourly band-cache reads/writes are disabled in this worker; normalized responses are served from fresh R2/ObsAQIDB reads plus the HTTP cache layer

For R2 v2, the data profile remains under
`history/v2/aqilevels/hourly/data` and the required targeted AQI index remains
under `history/_index_v2/aqilevels_hourly_data_timeseries`. This Worker only
changes the read response contract; it does not rewrite parquet, manifests,
indexes or metadata.

Serving rule:

- The request range is split with `INGESTDB_RETENTION_DAYS` into three rolling source zones:
  - retention range (`now - INGESTDB_RETENTION_DAYS` to now): ObsAQIDB only
  - one-day overlap (the day before retention): R2 preferred, ObsAQIDB fills only hours missing from R2
  - historical range (older than the overlap): R2 only
- R2 history is requested only up to the rolling retention start, never for the retention source window.
- ObsAQIDB is queried only when the requested window overlaps the one-day overlap or retention range.
- Overlapping timestamps keep R2 values, so R2 wins in the one-day overlap.
- R2 uses committed day manifests:
  - a UTC day is served only when the day manifest exists.
  - no `_SUCCESS` marker or loose parquet scan fallback is used.
- Cache policy is dynamic by requested end time:
  - windows ending within the last 24 hours use the short live TTL
  - windows ending more than 24 hours ago use the long immutable-history TTL

Required runtime secrets for stitched mode:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

Useful runtime vars:

- `INGESTDB_RETENTION_DAYS` (default `5`)
- `UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS` (default `10000`)
- `UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE` (default `5000`)
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)
- `UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX`
  (default `history/_index_v2/timeseries_binding`)
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX` (v2 TEST value `history/_index_v2/aqilevels_hourly_data_timeseries`)
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED` (default `true`)
- `UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX` (default `true`)
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_FILES_PER_REQUEST` (default `120`)
- `UK_AQ_AQI_HISTORY_R2_MAX_R2_OBJECT_READS_PER_REQUEST` (default `80`)
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_ROW_GROUPS_PER_REQUEST` (default `300`)
- `UK_AQ_AQI_HISTORY_R2_MAX_PARQUET_CHUNKS_PER_REQUEST` (default `600`)
- `UK_AQ_AQI_HISTORY_R2_MAX_SCAN_ELAPSED_MS` (default `12000`)
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)

Response:

- default JSON response uses `wire_format=json`, `data_format=compact`, `columns`, and compact `points` arrays.
- `format=objects` returns row-object JSON; `format=tsv` returns a legacy tab-separated payload.
- R2 v2 responses include `response_contract: "aqi_hour_interval_v2"` at the
  top level and in `meta`. Object rows and compact `columns` include the
  canonical endpoint fields `timestamp_hour_utc` and `period_end_utc`.
- In the additive compatibility release, both endpoint fields equal `n`. The
  legacy `period_start_utc` field is retained as its existing endpoint alias
  until all active consumers use the explicit endpoint. It is corrected to
  `n - 1 hour` only in the later coordinated range-contract release.
- Compact consumers must decode using `columns`; TSV uses the same selected
  columns and exposes the marker in `X-UK-AQ-AQI-Response-Contract`; object
  responses expose the corresponding named fields.
- each row otherwise retains the normalized AQI identity, levels, statuses,
  source and coverage fields.
- includes source and coverage diagnostics (historical/overlap/retention windows, source coverage intervals, history + obs_aqidb counts, `target_connector_id`, `target_station_id`, `timeseries_window_context_lookup_*`, `coverage.timeseries_index`, `coverage.scan_metrics`, `coverage.row_summary`, plus `obs_aqidb_status` and `obs_aqidb_fallback_*` when live fallback is used)
- `coverage.row_summary` includes returned-row counts plus missing/null diagnostics (`parsed_point_count`, `null_daqi_count`, `null_eaqi_count`, `source_counts`, `source_coverage_counts`, `pollutant_counts`, and calculation-status / missing-reason counts)
- includes `response_complete`, `has_gap`, `coverage_state`, and `partial_reasons` plus scan-completeness diagnostics (`coverage.history_scan_complete` and `coverage.history_scan_stopped_reason`) so clients can detect partial history scans.
- includes `cache_scope` of `recent` or `immutable`
- sets `x-ukaq-cache: HIT|MISS`.

`/v1/aqi-history` is the HTTP API route and is not an R2 history-version
identifier. R2 v1 remains untouched by the v2 endpoint contract.

## Deploy (manual)

```bash
cd workers/uk_aq_aqi_history_r2_api_worker
wrangler deploy
```
