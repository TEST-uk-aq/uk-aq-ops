# UK AQ Postcode Lookup R2 API Worker

Cloudflare Worker that serves:

- exact postcode lookup (`/postcode_lookup`)
- postcode autocomplete (`/postcode_suggest`)

Data is read from compact R2 JSON objects:

- exact shards: `v1/shards/<AREA>.json`
- suggest shards: `v1/suggest/<AREA>.json`
- area/town index: `v1/area_town_index.json`
- 1-2 char prefix table (sampled postcodes + hint fallbacks): `v1/postcode_prefix_hints.json`

## Routes

Exact lookup:

- `GET /v1/postcode_lookup`
- alias: `GET /api/postcode_lookup`
- alias: `GET /`

Suggest:

- `GET /v1/postcode_suggest`
- alias: `GET /api/postcode_suggest`

## Auth

This worker is intended for trusted upstream calls, not direct public browser use.

Required header:

- `x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>`

## Exact lookup response

Success example:

```json
{
  "ok": true,
  "postcode": "BS2 1AA",
  "postcode_normalised": "BS21AA",
  "lat": 51.45,
  "lon": -2.58,
  "pcon_code": "E14000001",
  "la_code": "E06000001",
  "area_town_id": 41,
  "area_name": "Emersons Green",
  "post_town": "Bristol",
  "label": "BS2 1AA, Emersons Green, Bristol",
  "source": "ONSPD"
}
```

Errors:

- `400` invalid postcode
- `404` postcode not found
- `503` lookup unavailable
- `401` unauthorized

## Suggest response

Request:

- `GET /v1/postcode_suggest?q=BS2&limit=6`

Behavior:

- `q` length `0`: returns empty list
- `q` length `1` or `2`: returns sampled real postcode rows from `postcode_prefix_hints.json` (no suggest shard read)
- fallback: if sampled rows are missing, returns prefix-count hints from `postcode_prefix_hints.json`
- `q` length `>=3`: reads one suggest shard (`suggest/<AREA>.json`) and filters by prefix
- `limit` default `6`, capped at `10`

Success example:

```json
{
  "ok": true,
  "query": "BS2",
  "query_normalised": "BS2",
  "source": "postcode_suggest_shard",
  "results": [
    {
      "type": "postcode",
      "postcode": "BS2 1AA",
      "postcode_normalised": "BS21AA",
      "area_town_id": 41,
      "area_name": "Emersons Green",
      "post_town": "Bristol",
      "label": "BS2 1AA, Emersons Green, Bristol"
    }
  ]
}
```

## Caching

- success responses: `Cache-Control: public, max-age=86400`
- error responses: `Cache-Control: no-store`
- in-memory LRU cache for exact and suggest shards
- in-memory cached `area_town_index` and `postcode_prefix_hints`

## Runtime config

- R2 binding: `UK_AQ_POSTCODE_LOOKUP_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX` (default `v1`)
- `UK_AQ_EDGE_UPSTREAM_SECRET`

## Deploy

```bash
cd workers/uk_aq_postcode_lookup_r2_api_worker
wrangler deploy
```
