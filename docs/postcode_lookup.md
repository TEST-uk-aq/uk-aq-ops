# UK Postcode Lookup (R2 Shards + Worker API)

## Data source

- Source dataset: **ONS Postcode Directory (ONSPD)** CSV.
- Current source version in use: **ONSPD_MAY_2025**.
- ONSPD is preferred because it covers the full UK, including Northern Ireland.

## Why shard files in R2

- The Worker does not load one giant postcode CSV/object into memory.
- Local build pre-generates small shard JSON files by postcode area (for example `SW.json`, `EC.json`, `BT.json`).
- Lookup reads only one shard from R2 per request.

## Data stored per postcode

- Stored values are compact arrays:
  - `[lat, lon, pcon_code, la_code]`
- `pcon_code` and `la_code` may be `null` when source row codes are missing.
- `pcon_name` and `la_name` are intentionally **not** stored in R2.

Reason:

- Website map names are resolved from local PCON HexJSON / LA GeoJSON files in the website repo.
- Postcode lookup stays compact and code-only.

## Build shard files locally

```bash
cd CIC-test-uk-aq-ops

npm run postcode:build -- \
  --input "/Users/mikehinford/Dropbox/Projects/CIC Website/Resources - Main - CIC Web/Postcode lookup/ONSPD_MAY_2025/Data/ONSPD_MAY_2025_UK.csv" \
  --output "tmp/postcode_lookup_v1" \
  --prefix "postcode_lookup/v1"
```

Output:

- `tmp/postcode_lookup_v1/manifest.json`
- `tmp/postcode_lookup_v1/<AREA>.json` shard files

Manifest includes:

- detected source fields (postcode/lat/lon/pcon/la)
- `missing_pcon_code_count`
- `missing_la_code_count`
- `geography_codes` metadata (`contains_names: false`)

## Check postcode vs website geography compatibility

```bash
cd CIC-test-uk-aq-ops

npm run postcode:check-geography -- \
  --postcode-dir "tmp/postcode_lookup_v1" \
  --pcon-geojson "/path/to/website/pcon.geojson-or-hexjson" \
  --la-geojson "/path/to/website/la.geojson-or-hexjson"
```

Behavior:

- Fails (exit non-zero) if any postcode lookup `pcon_code`/`la_code` is missing from website geography files.
- Warns (does not fail) if website geography includes extra codes not present in postcode lookup output.

## Upload shard files to R2

```bash
cd CIC-test-uk-aq-ops

npm run postcode:upload -- \
  --input-dir "tmp/postcode_lookup_v1"
```

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
  "pcon_code": "E14001530",
  "la_code": "E09000033",
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
