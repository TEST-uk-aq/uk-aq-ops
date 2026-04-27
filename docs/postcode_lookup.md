# UK Postcode Lookup (R2 Shards + Worker API)

## Data source

- Source dataset: **ONS Postcode Directory (ONSPD)** CSV.
- ONSPD is preferred because it covers the full UK, including Northern Ireland.
- OS Code-Point Open on its own is not sufficient for this use case because it does not cover Northern Ireland.

## Why shard files in R2

- The Worker does not load one giant postcode CSV/object into memory.
- Local build step pre-generates small shard JSON files by postcode area (for example `SW.json`, `EC.json`, `BT.json`).
- Lookup reads only one shard from R2 per request.

## Build shard files locally

```bash
cd CIC-test-uk-aq-ops

node scripts/postcodes/build_postcode_lookup_from_onspd.mjs \
  --input "/path/to/ONSPD.csv" \
  --output "tmp/postcode_lookup_v1" \
  --prefix "v1"
```

Equivalent npm script:

```bash
npm run postcode:build -- \
  --input "/path/to/ONSPD.csv" \
  --output "tmp/postcode_lookup_v1" \
  --prefix "v1"
```

Output:

- `tmp/postcode_lookup_v1/manifest.json`
- `tmp/postcode_lookup_v1/<AREA>.json` shard files

## Upload shard files to R2

```bash
cd CIC-test-uk-aq-ops

export CLOUDFLARE_ACCOUNT_ID="<cloudflare-account-id>"
export CLOUDFLARE_R2_ACCESS_KEY_ID="<r2-access-key-id>"
export CLOUDFLARE_R2_SECRET_ACCESS_KEY="<r2-secret-access-key>"
export UK_AQ_POSTCODE_R2_BUCKET="<bucket-name>"
export UK_AQ_POSTCODE_R2_PREFIX="v1"

node scripts/postcodes/upload_postcode_lookup_to_r2.mjs \
  --input-dir "tmp/postcode_lookup_v1"
```

Notes:

- Script also accepts existing repo conventions (`CFLARE_R2_*`, `R2_*`).
- Upload summary prints bucket, prefix, shard count, postcode count, and uploaded bytes.

## API endpoint

Website-facing route (cache proxy):

- `GET /api/aq/postcode_lookup?postcode=SW1A%201AA`

Underlying R2 Worker route:

- `GET /v1/postcode_lookup?postcode=SW1A%201AA`

Successful response:

```json
{
  "ok": true,
  "postcode": "SW1A 1AA",
  "postcode_normalised": "SW1A1AA",
  "lat": 51.501009,
  "lon": -0.141588,
  "source": "ONSPD"
}
```

Error responses:

- `400` invalid postcode -> `invalid_postcode`
- `404` postcode missing from shard -> `postcode_not_found`
- `503` shard/object unavailable -> `postcode_lookup_unavailable`

Cache headers:

- success: `Cache-Control: public, max-age=86400`
- error: `Cache-Control: no-store`

## Required variables

For upload script:

- `CLOUDFLARE_ACCOUNT_ID` (or `CFLARE_R2_ENDPOINT`)
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `UK_AQ_POSTCODE_R2_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX` (default `v1`)

For postcode R2 Worker runtime:

- R2 binding: `UK_AQ_POSTCODE_LOOKUP_BUCKET`
- `UK_AQ_POSTCODE_R2_PREFIX`

For cache proxy route passthrough:

- `UK_AQ_POSTCODE_LOOKUP_R2_API_URL` (for example `https://<worker-host>/v1/postcode_lookup`)

## Future website integration note

- `hex_map.html` can call `/api/aq/postcode_lookup?postcode=<user-input>`.
- Frontend should pass user-entered postcode as-is; server performs normalization.
