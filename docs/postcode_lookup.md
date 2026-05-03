# UK Postcode Lookup (R2 Exact + Suggest Shards)

## Data source

- Source dataset: **ONS Postcode Directory (ONSPD)** CSV
- Current source version: **ONSPD_MAY_2025**
- ONSPD is used because it covers the full UK, including Northern Ireland.
- Build excludes terminated postcodes where `DOTERM` is populated.

## Why split exact vs suggest

- Exact lookup and autocomplete have different access patterns.
- Exact lookup needs lat/lon and geography codes.
- Suggest lookup needs compact prefix search rows.
- Worker reads one small shard per request instead of loading a giant dataset.

## R2 object layout

Using prefix `v1`:

- `v1/manifest.json`
- `v1/area_town_index.json`
- `v1/postcode_prefix_hints.json`
- `v1/shards/<AREA>.json` (exact)
- `v1/suggest/<AREA>.json` (autocomplete)

## Exact shard format

Each exact shard stores postcode key -> compact value:

- `[lat, lon, pcon_code, la_code, area_town_id]`

Exact rows intentionally do **not** store:

- `area_name`
- `post_town`

## Suggest shard format

Each suggest shard stores rows in compact array form:

- columns: `n`, `p`, `at`, `pc`, `la`
- row: `[postcode_normalised, postcode_display, area_town_id, pcon_code, la_code]`

Suggest rows intentionally do **not** store:

- lat/lon
- area/town strings

## Area/Town index

`area_town_index.json` stores de-duplicated strings:

- `area_town_id -> [area_name, post_town]`

This avoids repeating area/town text across ~2.7 million postcode rows.

## Area and post town derivation

Area and post town are ONSPD-derived, not Royal Mail PAF post town values.

Current logic:

- England/Wales area: `BUASD24 -> BUA24 -> PARISH -> OSWARD -> OSLAUA`
- Scotland area: `OSWARD -> OSLAUA`
- NI area: `OSWARD -> OSLAUA`
- post_town fallback: `TTWA -> BUA24 -> OSLAUA -> OSCTY`

Pseudo/missing codes are ignored.

## Build

```bash
cd CIC-test-uk-aq-ops

npm run postcode:build -- \
  --input "/Users/mikehinford/Dropbox/Projects/CIC Website/Resources - Main - CIC Web/Postcode lookup/ONSPD_MAY_2025/Data/ONSPD_MAY_2025_UK.csv" \
  --output "tmp/postcode_lookup_v1" \
  --prefix "v1"
```

Optional:

- `--onspd-root "/path/to/ONSPD_MAY_2025"`
- build clears the output directory first.

## Upload

```bash
cd CIC-test-uk-aq-ops

npm run postcode:upload -- \
  --input-dir "tmp/postcode_lookup_v1"
```

Default upload behavior:

- clears existing objects under the target prefix (for example `v1/`) before uploading
- automatic cache purge is currently disabled in the upload script (manual purge in Cloudflare is used)
- use `--skip-clear-prefix` only if you explicitly want to preserve existing keys
- use `--skip-cache-purge` only when you intentionally want to keep existing cached suggest responses

Optional cache purge overrides:

- `--cache-purge-origin https://cic-test.chronicillnesschannel.co.uk` (repeatable)
- `--cache-zone-id <cloudflare-zone-id>`
- `--cache-purge-path /api/aq/postcode_suggest` (repeatable)

## API endpoints

Underlying worker routes:

- exact: `GET /v1/postcode_lookup?postcode=BS2%201AA`
- suggest: `GET /v1/postcode_suggest?q=BS2`

Website-facing proxy route can expose these under `/api/aq/...` as needed.

## Exact lookup response example

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

## Suggest behavior

- `q` length `0`: returns empty
- `q` length `1` or `2`: returns sampled real postcode rows from `postcode_prefix_hints.json` (`postcode_samples_1` / `postcode_samples_2`) without reading suggest shards
- no count-based hint rows are returned
- `q` length `>=3`: reads one `suggest/<AREA>.json` shard and filters rows
- `limit` default `6`, capped at `10`

## Caching

Worker-side in-memory caches:

- exact shards
- suggest shards
- `area_town_index.json`
- `postcode_prefix_hints.json`

Response caching:

- success: `Cache-Control: public, max-age=86400`
- errors: `Cache-Control: no-store`
