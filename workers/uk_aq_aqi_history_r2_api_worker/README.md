# UK AQ AQI History R2 API Worker

Cloudflare Worker for historical AQI reads from R2 History.

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

Serving rule:

- a UTC day is served only when the day manifest exists (committed history rule).
- no `_SUCCESS` marker or loose parquet scan fallback is used.

Response:

- returns hourly points sorted by `period_start_utc` ascending:
  - `{ period_start_utc, daqi_index_level, eaqi_index_level, station_id }`
- includes coverage diagnostics (`missing_day_manifest_keys`, etc.).
- sets `x-ukaq-cache: HIT|MISS`.

## Deploy (manual)

```bash
cd workers/uk_aq_aqi_history_r2_api_worker
wrangler deploy
```
