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
- compact immutable-day band cache:
  - `history/v1/aqilevels/bands/v1/day_utc=YYYY-MM-DD/connector_id=NN/timeseries_ids=.../pollutant=all|pm25|pm10|no2.json`
- the worker resolves timeseries window context from `uk_aq_public.uk_aq_timeseries_aqi_hourly` (including `connector_id`, `station_id`, and window `timeseries_ids`) and narrows scans accordingly
- the ObsAQIDB fallback query now reads the normalized hourly AQI contract first (`daqi_input_*`, `eaqi_input_*`, `*_calculation_status`, and source counts) while still retaining legacy compatibility fields for the render path
- if the ObsAQIDB context lookup misses for an R2-only timeseries, the worker still scans R2 directly by timeseries id across day connector manifests instead of returning an empty response
- optional AQI timeseries index (fast-path):
  - `${UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`
  - the worker resolves window timeseries ids from `uk_aq_public.uk_aq_timeseries_aqi_hourly` and narrows parquet file scans using each file's `min_timeseries_id/max_timeseries_id`
  - if the optional index is missing/invalid for a day+connector, it falls back to connector manifest file scanning
- AQI parquet reads use `timeseries_id` row-group stats and chunked column reads instead of materializing whole parquet files

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
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_PREFIX` (default `history/_index/aqilevels_timeseries`)
- `UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED` (default `true`)
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)

Response:

- default JSON response uses `wire_format=json`, `data_format=compact`, `columns`, and compact `points` arrays.
- `format=objects` returns row-object JSON; `format=tsv` returns a legacy tab-separated payload.
- includes source and coverage diagnostics (historical/overlap/retention windows, source coverage intervals, history + obs_aqidb counts, `target_connector_id`, `target_station_id`, `timeseries_window_context_lookup_*`, `coverage.timeseries_index`, `coverage.aqi_band_cache`, plus `obs_aqidb_status` and `obs_aqidb_fallback_*` when live fallback is used).
- includes `response_complete`, `has_gap`, `coverage_state`, and `partial_reasons` plus scan-completeness diagnostics (`coverage.history_scan_complete` and `coverage.history_scan_stopped_reason`) so clients can detect partial history scans.
- includes `cache_scope` of `recent` or `immutable`
- sets `x-ukaq-cache: HIT|MISS`.

## Deploy (manual)

```bash
cd workers/uk_aq_aqi_history_r2_api_worker
wrangler deploy
```
