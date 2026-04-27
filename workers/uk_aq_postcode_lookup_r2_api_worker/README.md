# UK AQ Postcode Lookup R2 API Worker

Cloudflare Worker that resolves UK postcodes to latitude/longitude by reading
small shard JSON objects from Cloudflare R2.

Routes:

- `GET /v1/postcode_lookup`
- alias: `GET /`

Query params:

- `postcode` (required)

Response:

- success:
  - `{ ok: true, postcode, postcode_normalised, lat, lon, source }`
- invalid postcode:
  - `400` with `{ ok: false, error: "invalid_postcode", ... }`
- postcode not found:
  - `404` with `{ ok: false, error: "postcode_not_found", ... }`
- shard unavailable/missing:
  - `503` with `{ ok: false, error: "postcode_lookup_unavailable", ... }`

Caching:

- successful lookups: `Cache-Control: public, max-age=86400`
- errors: `Cache-Control: no-store`
- shard JSON is cached in-memory using a bounded map (max 32 shards)

Required runtime config:

- R2 binding: `UK_AQ_POSTCODE_LOOKUP_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX` (default `v1`)

Deploy:

```bash
cd workers/uk_aq_postcode_lookup_r2_api_worker
wrangler deploy
```
