# UK AQ Observs History R2 API Worker

Cloudflare Worker for historical observations reads from R2 History.

Routes:

- `GET /v1/observations`
- alias: `GET /`

Required query params:

- `timeseries_id` (positive integer)
- `connector_id` (positive integer)
- `start_utc` (ISO timestamp, inclusive)
- `end_utc` (ISO timestamp, exclusive)

Optional query params:

- `since_utc` (ISO timestamp, exclusive lower bound)
- `limit` (`1..20000`)

Auth:

- requires header: `x-uk-aq-upstream-auth`
- value must match Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`

R2 paths expected:

- day manifest:
  - `${UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX}/day_utc=YYYY-MM-DD/manifest.json`
- connector manifest:
  - `${UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`

Serving rule:

- a UTC day is served only when the day manifest exists (committed history rule).
- no `_SUCCESS` marker or loose parquet scan fallback is used.

Response:

- returns `{ observed_at, value }` rows sorted by `observed_at` ascending.
- includes coverage diagnostics (`missing_day_manifest_keys`, etc.).
- sets `x-ukaq-cache: HIT|MISS`.

## Deploy (manual)

```bash
cd workers/uk_aq_observs_history_r2_api_worker
wrangler deploy
```
