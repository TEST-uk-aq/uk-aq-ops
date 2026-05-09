# uk_aq Latest Snapshot R2 API Worker

Serves latest snapshot JSON objects from R2 using stable URL/query keys for cache-proxy upstream use.

## Endpoints

- `GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all`
- `GET /v1/manifest`
- `GET /v1/health`

Accepted route aliases:

- `/` behaves like `/v1/latest-snapshot`
- `scope=all` is accepted as alias for `network_group=all`

## Security

All read endpoints require upstream auth header:

- `x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>`

This is intended to be called by `uk_aq_cache_proxy` (not directly by browsers).

## Required env vars/secrets

- `UK_AQ_EDGE_UPSTREAM_SECRET` (secret)
- R2 bucket binding: `UK_AQ_HISTORY_BUCKET`

## Optional vars

- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (default `latest_snapshots/v1`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${prefix}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_R2_CACHE_MAX_AGE_SECONDS` (default `60`)
