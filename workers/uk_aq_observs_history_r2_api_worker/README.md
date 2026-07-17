# UK AQ Observs History R2 API Worker

Cloudflare Worker for historical observations reads from R2 History.

Routes:

- `GET /v1/observations`
- `GET /v1/timeseries-binding?timeseries_id=<id>` (stable v2 identity/routing)
- alias: `GET /`

Required query params:

- `timeseries_id` (positive integer)
- `connector_id` (positive integer)
- `start_utc` (ISO timestamp, inclusive)
- `end_utc` (ISO timestamp, exclusive)

Optional query params:

- `since_utc` (ISO timestamp, exclusive lower bound)
- `limit` (`1..20000`)
- `pollutant` (`pm25`, `pm10`, or `no2`; required only when
  `UK_AQ_R2_HISTORY_VERSION=v2`)

Auth:

- requires header: `x-uk-aq-upstream-auth`
- value must match Worker secret `UK_AQ_EDGE_UPSTREAM_SECRET`

R2 paths expected in v1 mode:

- day manifest:
  - `${UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX}/day_utc=YYYY-MM-DD/manifest.json`
- connector manifest:
  - `${UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`
- optional timeseries index (fast-path):
  - `${UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/manifest.json`

Serving rule:

- a UTC day is served only when the day manifest exists (committed history rule).
- no `_SUCCESS` marker or loose parquet scan fallback is used.
- when the optional timeseries index exists, file selection is narrowed by:
  - `min_timeseries_id/max_timeseries_id`
  - and, when present in index file metadata, `min_observed_at/max_observed_at` overlap with the requested time window (`start_utc`/`end_utc`/`since_utc`)
- if the optional timeseries index is missing/invalid for a day+connector, including an empty or otherwise unusable index manifest, the worker falls back to connector manifest file scanning.
- parquet object keys are de-duplicated before scanning so index and connector-manifest paths do not decode the same object more than once.

V2 serving rule:

- enabled only when `UK_AQ_R2_HISTORY_VERSION=v2`.
- requires the request `pollutant` query parameter so the Worker can read the
  pollutant-split partition directly.
- reads the per-pollutant timeseries index at
  `${UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/pollutant_code=<pollutant>/manifest.json`.
- reads only parquet keys under
  `${UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX}/day_utc=YYYY-MM-DD/connector_id=NN/pollutant_code=<pollutant>/`.
- does not infer or scan other pollutant partitions when the v2 index is
  missing; it returns a structured partial response with coverage diagnostics.

Response:

- returns `{ observed_at, value }` rows sorted by `observed_at` ascending.
- includes `cache_scope` (`recent` or `immutable`) for cache policy visibility.
- includes `read_version`, `index_version`, `pollutant`, `history_index_prefix`,
  and `timeseries_index_prefix` for read-path visibility.
- includes top-level `response_complete`, `has_gap`, `coverage_state`, and `partial_reasons`.
- includes coverage diagnostics (`missing_day_manifest_keys`, etc.).
- includes `coverage.timeseries_index` diagnostics for index hit/miss/fallback visibility, including `skipped_files_by_time_range`.
- includes v2 read counters in `coverage`: `r2_object_reads`,
  `parquet_bytes_read`, `parquet_row_groups_scanned`,
  `parquet_chunks_scanned`, and `parquet_matched_rows`.
- marks responses partial when required day manifests, connector manifests, parquet objects, row-limit capacity, or uncertain timeseries-index skips/warnings prevent the worker from proving full coverage.
- sets `x-ukaq-cache: HIT|MISS` and safe cache diagnostics including cache
  eligibility and cache generation.

Cache behavior:

- cache key is canonicalized to `/v1/observations` with normalized query params:
  - `timeseries_id`, `connector_id`, hidden read version, optional `pollutant`,
    `start_utc`, `end_utc`, optional `since_utc`, optional `limit`, and the
    code-owned cache generation (`2`).
- equivalent request forms (including `/` alias or non-canonical timestamp text that resolves to the same ISO value) share the same cache entry.
- only complete, gap-free observation responses with no top-level or coverage
  partial reasons may enter Cache API. Partial responses retain valid rows but
  return `Cache-Control: no-store` and remain retryable.
- recent window cache TTL uses `UK_AQ_OBSERVS_HISTORY_R2_CACHE_MAX_AGE_SECONDS` (default `300`).
- immutable window cache TTL uses `UK_AQ_OBSERVS_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS` (default `86400`), applied when `end_utc` is older than 24 hours.

Optional env:

- `UK_AQ_R2_HISTORY_VERSION` (required `v1|v2`, canonical active selector. Note: old `UK_AQ_R2_HISTORY_READ_VERSION` is deprecated and rejected by active runtime guards.)
- `UK_AQ_OBSERVS_HISTORY_R2_CACHE_MAX_AGE_SECONDS` (default `300`, clamp `30..604800`)
- `UK_AQ_OBSERVS_HISTORY_R2_IMMUTABLE_CACHE_MAX_AGE_SECONDS` (default `86400`, clamp `30..604800`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX` (default `history/v2/observations`)
- `UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_ENABLED` (`true|false`, default `true`)
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)
- `UK_AQ_R2_HISTORY_INDEX_V2_PREFIX` (default `history/_index_v2`)
- `UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_PREFIX`
  (default `${UK_AQ_R2_HISTORY_INDEX_PREFIX}/observations_timeseries`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX`
  (legacy alias fallback for shared index prefix wiring)
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX`
  (default `${UK_AQ_R2_HISTORY_INDEX_V2_PREFIX}/observations_timeseries`)
- `UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX`
  (default `${UK_AQ_R2_HISTORY_INDEX_V2_PREFIX}/timeseries_binding`)

## Deploy (manual)

```bash
cd workers/uk_aq_observs_history_r2_api_worker
wrangler deploy
```
