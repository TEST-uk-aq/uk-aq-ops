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

- `~/tmp/geo_lookup_v1`

Directory/object structure:

```text
v1/
  manifest.json
  pcon/
    detailed/
      grid_0.05/
        iy1030_ix-3.json
  la/
    detailed/
      grid_0.05/
        iy1030_ix-3.json
  adjacency/
    pcon_<version>.json
    la_<version>.json
```

Notes:

- A feature is included in every tile whose bbox overlaps the feature bbox.
- Tile keys use integer indices (`iy`, `ix`) as canonical identifiers to avoid float rounding drift.
- MultiPolygon assignment uses per-part bbox tiling with tile-key dedupe (reduces shard explosion for disjoint geometries).
- Shard and adjacency JSON are written minified to reduce local tmp usage and R2 object size.
- Adjacency output is approximate (`bbox_overlap_approx`) in the first implementation.

## Build flow

### Offline local files (preferred)

Use local GeoJSON files directly (no Dropbox download step).

```bash
node scripts/geography/build_pcon_la_lookup_shards.mjs \
  --pcon-geojson "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/Geo-Resources/admin/PCON/UK/July_2024/BFC/Data/Westminster_Parliamentary_Constituencies_July_2024_Boundaries_UK_BFC_5018004800687358456.geojson" \
  --la-geojson "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/Geo-Resources/admin/LAD/UK/May_2025/BGC/Data/LAD_MAY_2025_UK_BGC_V2_6173306121795233386.geojson" \
  --output-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-$HOME/tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}" \
  --grid-size "${UK_AQ_GEO_GRID_SIZE_DEGREES:-0.05}" \
  --boundary-detail "${UK_AQ_GEO_BOUNDARY_DETAIL:-detailed}" \
  --pcon-version "${UK_AQ_GEO_PCON_VERSION:-2024}" \
  --la-version "${UK_AQ_GEO_LA_VERSION:-2025}"
```

### Dropbox resolve (optional)

Only use this when you explicitly want to resolve/download source files from Dropbox:

```bash
python3 scripts/geography/resolve_dropbox_geojson.py \
  --dropbox-base "$PCON_GEOJSON_DROPBOX_BASE" \
  --dropbox-path "$PCON_GEOJSON_DROPBOX_PATH" \
  --version "${UK_AQ_GEO_PCON_VERSION:-2024}" \
  --output "$HOME/tmp/pcon.geojson"

python3 scripts/geography/resolve_dropbox_geojson.py \
  --dropbox-base "$LA_GEOJSON_DROPBOX_BASE" \
  --dropbox-path "$LA_GEOJSON_DROPBOX_PATH" \
  --version "${UK_AQ_GEO_LA_VERSION:-latest-configured}" \
  --output "$HOME/tmp/la.geojson"
```

Then run the same build command with those local paths.

### Upload to R2

```bash
node scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs \
  --input-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-$HOME/tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}"
```

5) Validate against existing station PCON/LA values (Layer 1D placeholder):

```bash
python3 scripts/geography/validate_r2_geo_lookup_against_stations.py \
  --limit "${UK_AQ_GEO_VALIDATE_LIMIT:-100}" \
  --output "${UK_AQ_GEO_VALIDATE_OUTPUT:-logs/geo_validate/latest.json}"
```

Optional explicit station list:

```bash
python3 scripts/geography/validate_r2_geo_lookup_against_stations.py \
  --station-ids "123,456,789" \
  --output "${UK_AQ_GEO_VALIDATE_OUTPUT:-logs/geo_validate/latest.json}"
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

Layer 1D validation gate placeholder:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_GEO_VALIDATE_LIMIT` (default `100`)
- `UK_AQ_GEO_VALIDATE_STATION_IDS` (optional CSV)
- `UK_AQ_GEO_VALIDATE_RANDOM_SEED` (optional)
- `UK_AQ_GEO_VALIDATE_OUTPUT` (default `logs/geo_validate/latest.json`)
- plus R2 read credentials:
  - `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CFLARE_R2_ACCESS_KEY_ID`
  - `CLOUDFLARE_R2_SECRET_ACCESS_KEY` / `CFLARE_R2_SECRET_ACCESS_KEY`

Dropbox resolve step:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

## Edge cases and limitations

- Boundary-edge points can require neighbouring tile fallback during ingest lookup.
- Adjacency output is approximate in Layer 1 and intended as future support data.
- Aiven is not part of the active design for this feature.

Layer 1D mismatch interpretation (validation placeholder):

- `*_code_mismatch`: different boundary code selected between stored station value and R2 lookup; review boundary version and edge geometry.
- `*_missing_stored` / `*_missing_r2`: one side has a code and the other does not; check tile fallback and source coverage.
- `*_name_mismatch`: code matched but label differs; usually naming dataset drift rather than spatial mismatch.
- `both_missing`: neither lookup found a polygon for the station coordinate.
