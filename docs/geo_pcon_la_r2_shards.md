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
  by_code/
    pcon/
      2024/
        S14000065.json
    la/
      2025/
        E06000054.json
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

- A feature ref is included in every tile whose bbox overlaps the feature bbox.
- Full geometry is stored once under `by_code/`; tile shards contain `code`, `name`, `bbox`, and `geometry_ref`.
- Tile keys use integer indices (`iy`, `ix`) as canonical identifiers to avoid float rounding drift.
- MultiPolygon assignment uses per-part bbox tiling with tile-key dedupe (reduces shard explosion for disjoint geometries).
- Shard, by-code geometry, and adjacency JSON are written minified to reduce local tmp usage and R2 object size.
- The builder accepts mixed boundary CRS inputs and normalizes output to `EPSG:4326`; `EPSG:27700` GeoJSON is reprojected in-process during build.
- Adjacency output is approximate (`bbox_overlap_approx`) in the first implementation.

## Build flow

### Offline local files (preferred)

Use local GeoJSON files directly (no Dropbox download step).

The current UK files are mixed:

- PCON input is already `EPSG:4326`
- LA input is `EPSG:27700`

The builder handles that automatically and still writes WGS84 shard geometry/bboxes.

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

Upload notes:

- The uploader defaults to the geo bucket `uk-aq-pcon-la-lookup`.
- Preferred auth mode is Cloudflare account API token using:
  - `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`
  - `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`
- S3-compatible R2 access keys are used only when API-token mode is not available.

5) Validate against existing station PCON/LA values:

```bash
UK_AQ_GEO_VALIDATE_LIMIT=100 \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/latest.json \
npm run geo:validate-stations
```

Seeded random sample:

```bash
UK_AQ_GEO_VALIDATE_LIMIT=100 \
UK_AQ_GEO_VALIDATE_RANDOM_SEED=42 \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/latest.json \
npm run geo:validate-stations
```

Optional explicit station list:

```bash
UK_AQ_GEO_VALIDATE_STATION_IDS="123,456,789" \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/station_ids.json \
npm run geo:validate-stations
```

Validation notes:

- Normal validation samples only stations that already have both stored `pcon_code` and `la_code` values.
- Explicit `--station-ids` / `UK_AQ_GEO_VALIDATE_STATION_IDS` takes priority over random sampling.
- This is a confidence gate, not a perfect oracle: stored station `pcon_code` / `la_code` values may come from a different boundary vintage than the newly built R2 shards.
- Treat code mismatches as the primary signal.
- Treat name mismatches as secondary diagnostics only; they often indicate version drift or naming-style differences rather than a bad shard.

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

Validation:

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`
- `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`
- `UK_AQ_GEO_R2_BUCKET` (default `uk-aq-pcon-la-lookup`)
- `UK_AQ_GEO_R2_PREFIX` (default `v1`)
- `UK_AQ_GEO_GRID_SIZE_DEGREES` (default `0.05`)
- `UK_AQ_GEO_BOUNDARY_DETAIL` (default `detailed`)
- `UK_AQ_GEO_VALIDATE_LIMIT` (default `100`)
- `UK_AQ_GEO_VALIDATE_RANDOM_SEED` (optional)
- `UK_AQ_GEO_VALIDATE_STATION_IDS` (optional CSV)
- `UK_AQ_GEO_VALIDATE_OUTPUT` (default `logs/geo_validate/latest.json`)

Dropbox resolve step:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

## Edge cases and limitations

- Boundary-edge points can require neighbouring tile fallback during ingest lookup.
- Adjacency output is approximate in Layer 1 and intended as future support data.
- Aiven is not part of the active design for this feature.

Validation mismatch interpretation:

- `pcon_code_mismatch` / `la_code_mismatch`: the R2 shard selected a different code from the stored station value; review boundary version and edge geometry first.
- `pcon_no_r2_match` / `la_no_r2_match`: the lookup could not find a polygon for that layer; check tile coverage, shard completeness, and boundary-edge handling.
- `invalid_coordinates`: the stored station geometry could not be decoded or was outside lon/lat bounds.
- `lookup_error`: the validator could not read the shard or geometry object from R2.
- `possible_boundary_edge`: the match came from a neighbouring tile; this can be correct for points near the edge of a polygon.
- `possible_boundary_version_difference`: code values differ but the stored and R2 names match after normalization; this usually means a boundary-vintage or naming-dataset difference rather than a broken lookup.
