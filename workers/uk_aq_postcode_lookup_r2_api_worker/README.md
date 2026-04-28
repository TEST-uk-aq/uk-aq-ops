# UK AQ Postcode Lookup R2 API Worker

Cloudflare Worker that resolves UK postcodes to latitude/longitude plus
PCON/LA geography codes by reading
small shard JSON objects from Cloudflare R2.

This worker is intended to be called by the cache proxy/app backend, not directly
from browsers. Requests must include a valid upstream auth header.

Routes:

- `GET /v1/postcode_lookup`
- alias: `GET /`

Query params:

- `postcode` (required)

Response:

- success:
  - `{ ok: true, postcode, postcode_normalised, lat, lon, pcon_code, la_code, source }`
- invalid postcode:
  - `400` with `{ ok: false, error: "invalid_postcode", ... }`
- postcode not found:
  - `404` with `{ ok: false, error: "postcode_not_found", ... }`
- shard unavailable/missing:
  - `503` with `{ ok: false, error: "postcode_lookup_unavailable", ... }`
- unauthorized:
  - `401` with `{ ok: false, error: "unauthorized", ... }`

Caching:

- successful lookups: `Cache-Control: public, max-age=86400`
- errors: `Cache-Control: no-store`
- shard JSON is cached in-memory using a bounded map (max 32 shards)

Data contract notes:

- Worker returns `pcon_code` and `la_code` when present in shards.
- Worker does not return `pcon_name` or `la_name`.
- Website/UI name labels are resolved separately from local map geometry files.

Required runtime config:

- R2 binding: `UK_AQ_POSTCODE_LOOKUP_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX` (default `v1`)
- `UK_AQ_EDGE_UPSTREAM_SECRET`

Required request header:

- `x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>`

Deploy:

```bash
cd workers/uk_aq_postcode_lookup_r2_api_worker
wrangler deploy
```
