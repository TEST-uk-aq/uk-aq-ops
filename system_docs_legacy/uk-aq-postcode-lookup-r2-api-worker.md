# UK AQ Postcode Lookup R2 API Worker

Worker path: `workers/uk_aq_postcode_lookup_r2_api_worker/worker.mjs`
Deploy workflow: `.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml`

## Purpose

- Resolve UK postcode queries to lat/lon plus PCON/LA codes for website map/search usage.
- Read only one postcode-area shard from R2 per request.
- Avoid loading a full UK postcode dataset into Worker memory.
- Restrict direct access so only trusted app/proxy calls are accepted.

## Routes

- `GET /v1/postcode_lookup`
- alias: `GET /`

Query:

- `postcode` (required)

## Response contract

Success (`200`):

- `ok: true`
- `postcode` (formatted with space)
- `postcode_normalised` (uppercase, no spaces)
- `lat`
- `lon`
- `pcon_code` (nullable)
- `la_code` (nullable)
- `source` (`ONSPD`)

Not returned:

- `pcon_name`
- `la_name`

Error cases:

- `400`: `invalid_postcode`
- `404`: `postcode_not_found`
- `503`: `postcode_lookup_unavailable`
- `401`: `unauthorized` (missing/invalid upstream auth header)

## Caching

- successful responses: `Cache-Control: public, max-age=86400`
- error responses: `Cache-Control: no-store`
- shard-level in-memory cache is bounded (max 32 shards)

## Required runtime config

- R2 binding: `UK_AQ_POSTCODE_LOOKUP_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX` (default `v1`)
- `UK_AQ_EDGE_UPSTREAM_SECRET`

Required request header:

- `x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>`

## Deployment variables/secrets

Variables:

- `UK_AQ_POSTCODE_R2_CLOUDFLARE_ACCOUNT_ID` (optional; falls back to `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`)
- `UK_AQ_POSTCODE_R2_BUCKET` (optional; falls back to `CFLARE_R2_BUCKET`)
- `UK_AQ_POSTCODE_LOOKUP_R2_API_WORKER_NAME` (optional)
- `UK_AQ_POSTCODE_R2_PREFIX` (optional, default `v1`)

Secrets:

- `UK_AQ_POSTCODE_R2_CLOUDFLARE_API_TOKEN` (optional; falls back to `UK_AQ_R2_CLOUDFLARE_API_TOKEN`)
- `UK_AQ_EDGE_UPSTREAM_SECRET` (required; same upstream auth secret used by cache proxy)

## Notes

- Build/upload pipeline lives under `scripts/postcodes/`.
- Shard build source currently used: `ONSPD_MAY_2025_UK.csv`.
- Exact shard row format is compact: `[lat, lon, pcon_code, la_code, area_town_id]`.
- Suggest shard and prefix sample row format is compact: `[postcode_normalised, postcode_display, area_town_id, pcon_code, la_code]`.
- Compatibility gate script:
  - `npm run postcode:check-geography -- --postcode-dir ... --pcon-geojson ... --la-geojson ...`
- Browser/frontend should call cache proxy route `/api/aq/postcode_lookup` rather than calling this worker directly.
- Cache proxy should target this worker URL via:
  - `UK_AQ_POSTCODE_LOOKUP_R2_API_URL=https://<worker-host>/v1/postcode_lookup`
