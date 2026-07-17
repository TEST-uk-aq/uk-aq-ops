# uk_aq Latest Snapshot R2 API Worker

Serves latest snapshot JSON objects from R2 using stable URL/query keys for cache-proxy upstream use.

The public worker is hard-cut to the `latest_snapshots/v2` object contract. It
does not read or fall back to v1 objects. Responses identify the contract with
`X-UK-AQ-Snapshot-Contract: v2`.

## Endpoints

- `GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all`
- Supported windows: `3h`, `6h`, `1d`, `7d`, `all`
- `GET /v1/manifest`
- `GET /v1/health`

Accepted route aliases:

- `/` behaves like `/v1/latest-snapshot`
- `scope=all` is accepted as alias for `network_group=all`

## Snapshot source

Every accepted latest-snapshot request reads the pollutant's physical
`window=all.json` object. `window=all` is returned directly. The Worker derives
public `3h`, `6h`, `1d`, and `7d` responses by filtering `last_value_at` at the
start of the current UTC minute, preserving row order and recalculating the
window, count, and cursors. Finite response ETags include the source ETag,
requested window, and effective UTC minute. Old finite objects and v1 objects
are never fallbacks.

## Security

All read endpoints require upstream auth header:

- `x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>`

This is intended to be called by `uk_aq_cache_proxy` (not directly by browsers).

## Required env vars/secrets

- `UK_AQ_EDGE_UPSTREAM_SECRET` (secret)
- R2 bucket binding: `UK_AQ_HISTORY_BUCKET`

## Optional vars

- `UK_AQ_LATEST_SNAPSHOT_R2_PREFIX` (required value/default `latest_snapshots/v2`)
- `UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY` (default `${prefix}/manifest.json`)
- `UK_AQ_LATEST_SNAPSHOT_R2_CACHE_MAX_AGE_SECONDS` (default `60`)

The worker fails closed with `invalid_v2_snapshot_config` if either path is
configured outside the canonical v2 prefix/manifest.
