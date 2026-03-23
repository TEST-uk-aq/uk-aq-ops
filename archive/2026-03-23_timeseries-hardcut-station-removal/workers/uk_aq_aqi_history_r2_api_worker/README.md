# UK AQ AQI History R2 API Worker

Cloudflare Worker for AQI history reads with stitched sources:

- recent data from `obs_aqidb` (`uk_aq_public.uk_aq_station_aqi_hourly`)
- older data from R2 History

Routes:

- `GET /v1/aqi-history`
- alias: `GET /`

Required query params:

- `station_id` (positive integer)
  - aliases accepted: `entity`, `entity_id`

Optional query params:

- `scope` (must be `station`; default `station`)
- `grain` (must be `hourly`; default `hourly`)
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
- the worker resolves `station_id -> connector_id` from `uk_aq_public.uk_aq_station_connector_lookup` and reads only that connector manifest when available
- AQI parquet reads use `station_id` row-group stats and chunked column reads instead of materializing whole parquet files

Serving rule:

- Recent period uses ObsAQIDB (default last 7 days).
- If the ObsAQIDB read fails, the same recent window falls back to R2 history on a best-effort basis.
- Older period uses committed R2 day manifests:
  - a UTC day is served only when the day manifest exists.
  - no `_SUCCESS` marker or loose parquet scan fallback is used.
- Overlapping timestamps are de-duplicated with ObsAQIDB as source-of-truth.
- Cache policy is dynamic by requested end time:
  - windows ending within the last 24 hours use the short live TTL
  - windows ending more than 24 hours ago use the long immutable-history TTL

Required runtime secrets for stitched mode:

- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

Useful runtime vars:

- `UK_AQ_AQI_HISTORY_SOURCE_OF_TRUTH_HOURS` (default `168`)
- `UK_AQ_AQI_HISTORY_OBSAQIDB_TIMEOUT_MS` (default `10000`)
- `UK_AQ_AQI_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE` (default `5000`)
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)

Response:

- returns hourly points sorted by `period_start_utc` ascending:
  - `{ period_start_utc, daqi_index_level, eaqi_index_level, station_id }`
- includes source and coverage diagnostics (history + obs_aqidb windows/counts, `station_connector_*` lookup diagnostics, plus `obs_aqidb_status` / `r2_recent_fallback_*` when live recent reads fail).
- includes `cache_scope` of `recent` or `immutable`
- sets `x-ukaq-cache: HIT|MISS`.

## Deploy (manual)

```bash
cd workers/uk_aq_aqi_history_r2_api_worker
wrangler deploy
```
