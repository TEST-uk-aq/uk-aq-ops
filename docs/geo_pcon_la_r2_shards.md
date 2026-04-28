# UK AQ PCON/LA R2 Shards

## Purpose

This setup replaces direct Aiven/PostGIS runtime dependency for station geography enrichment by building compact R2 lookup shards for:

- `lat/lon -> pcon`
- `lat/lon -> la`

The daily enrichment job remains in ingest and reads only required shard files from R2.

This is not a public API.

## Data source

Layer 1 uses Dropbox-hosted boundary GeoJSON files.

Expected source env vars:

- `PCON_GEOJSON_DROPBOX_BASE`
- `PCON_GEOJSON_DROPBOX_PATH` (optional direct file override)
- `LA_GEOJSON_DROPBOX_BASE`
- `LA_GEOJSON_DROPBOX_PATH` (optional direct file override)

## Output layout

Default local output directory:

- `tmp/geo_lookup_v1`

Directory/object structure:

```text
v1/
  manifest.json
  pcon/
    detailed/
      grid_0.05/
        <lat_min>_<lon_min>.json
  la/
    detailed/
      grid_0.05/
        <lat_min>_<lon_min>.json
  adjacency/
    pcon_<version>.json
    la_<version>.json
```

Notes:

- A feature is included in every tile whose bbox overlaps the feature bbox.
- Adjacency output is approximate (`bbox_overlap_approx`) in the first implementation.

## Build flow

1) Resolve PCON file from Dropbox:

```bash
python3 scripts/geography/resolve_dropbox_geojson.py \
  --dropbox-base "$PCON_GEOJSON_DROPBOX_BASE" \
  --dropbox-path "$PCON_GEOJSON_DROPBOX_PATH" \
  --version "${UK_AQ_GEO_PCON_VERSION:-2024}" \
  --output "tmp/pcon.geojson"
```

2) Resolve LA file from Dropbox:

```bash
python3 scripts/geography/resolve_dropbox_geojson.py \
  --dropbox-base "$LA_GEOJSON_DROPBOX_BASE" \
  --dropbox-path "$LA_GEOJSON_DROPBOX_PATH" \
  --version "${UK_AQ_GEO_LA_VERSION:-latest-configured}" \
  --output "tmp/la.geojson"
```

3) Build shard files:

```bash
node scripts/geography/build_pcon_la_lookup_shards.mjs \
  --pcon-geojson "tmp/pcon.geojson" \
  --la-geojson "tmp/la.geojson" \
  --output-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}" \
  --grid-size "${UK_AQ_GEO_GRID_SIZE_DEGREES:-0.05}" \
  --boundary-detail "${UK_AQ_GEO_BOUNDARY_DETAIL:-detailed}" \
  --pcon-version "${UK_AQ_GEO_PCON_VERSION:-2024}" \
  --la-version "${UK_AQ_GEO_LA_VERSION:-latest-configured}"
```

4) Upload to R2:

```bash
node scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs \
  --input-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}"
```

5) Compare Aiven vs R2 lookup (Layer 1D gate):

```bash
python3 scripts/geography/compare_r2_geo_lookup_with_aiven.py \
  --limit "${UK_AQ_GEO_COMPARE_LIMIT:-100}" \
  --output "${UK_AQ_GEO_COMPARE_OUTPUT:-logs/geo_compare/latest.json}"
```

Optional explicit station list:

```bash
python3 scripts/geography/compare_r2_geo_lookup_with_aiven.py \
  --station-ids "123,456,789" \
  --output "${UK_AQ_GEO_COMPARE_OUTPUT:-logs/geo_compare/latest.json}"
```

## Required env vars

Build-time:

- `UK_AQ_GEO_PCON_GEOJSON_PATH` (or `--pcon-geojson`)
- `UK_AQ_GEO_LA_GEOJSON_PATH` (or `--la-geojson`)
- `UK_AQ_GEO_SHARD_OUTPUT_DIR` (optional)
- `UK_AQ_GEO_GRID_SIZE_DEGREES` (optional)
- `UK_AQ_GEO_BOUNDARY_DETAIL` (optional)
- `UK_AQ_GEO_PCON_VERSION` (optional)
- `UK_AQ_GEO_LA_VERSION` (optional)

Upload-time:

- `UK_AQ_GEO_R2_BUCKET` (default `uk-aq-pcon-la-lookup`)
- `UK_AQ_GEO_R2_PREFIX` (default `v1`)
- `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY` / `CFLARE_R2_SECRET_ACCESS_KEY`
- optional endpoint/account override vars:
  - `UK_AQ_GEO_R2_ENDPOINT`
  - `UK_AQ_GEO_R2_CLOUDFLARE_ACCOUNT_ID`

Layer 1D compare gate:

- `PCON_AIVEN_PG_DSN`
- `UK_AQ_GEO_COMPARE_LIMIT` (default `100`)
- `UK_AQ_GEO_COMPARE_STATION_IDS` (optional CSV)
- `UK_AQ_GEO_COMPARE_INCLUDE_ALREADY_ENRICHED` (default `false`)
- `UK_AQ_GEO_COMPARE_OUTPUT` (default `logs/geo_compare/latest.json`)
- plus R2 read credentials used by upload script fallback:
  - `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CFLARE_R2_ACCESS_KEY_ID`
  - `CLOUDFLARE_R2_SECRET_ACCESS_KEY` / `CFLARE_R2_SECRET_ACCESS_KEY`

Dropbox resolve step:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

## Edge cases and limitations

- Boundary-edge points can require neighbouring tile fallback during ingest lookup.
- If source versions differ from Aiven boundary vintages, comparison mismatches may be valid.
- Adjacency output is approximate in Layer 1 and intended as future support data.

Layer 1D mismatch interpretation:

- `*_code_mismatch`: different boundary code selected between Aiven and R2; review boundary version and edge geometry.
- `*_missing_in_aiven` / `*_missing_in_r2`: one side found a polygon and the other did not; check tile fallback and source coverage.
- `*_name_mismatch`: code matched but label differs; usually naming dataset drift rather than spatial mismatch.
- `both_missing`: neither lookup found a polygon for the station coordinate.
