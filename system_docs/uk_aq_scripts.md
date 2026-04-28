# UK AQ Scripts Notes

## Postcode lookup scripts

- `scripts/postcodes/build_postcode_lookup_from_onspd.mjs`
  - Reads ONSPD CSV and writes postcode shard JSON files plus `manifest.json`.
  - Shards are grouped by leading postcode area and keyed by normalized postcode.
  - Postcode values are compact arrays: `[lat, lon, pcon_code, la_code]` (no PCON/LA names).

- `scripts/postcodes/upload_postcode_lookup_to_r2.mjs`
  - Uploads shard files and `manifest.json` to R2 using S3-compatible API.
  - Supports postcode-specific env vars and existing `CFLARE_R2_*` conventions.

- `scripts/postcodes/check_postcode_geography_versions.mjs`
  - Compares generated postcode `pcon_code`/`la_code` sets with website PCON/LA geography files.
  - Exits non-zero when postcode lookup includes codes missing from website geometry.

## Geography shard scripts

- `scripts/geography/resolve_dropbox_geojson.py`
  - Resolves a Dropbox GeoJSON file path (latest or version-filtered) and downloads it locally.
  - Supports base-folder scanning and direct-file path overrides.

- `scripts/geography/build_pcon_la_lookup_shards.mjs`
  - Builds PCON/LA grid shard JSON files and `manifest.json` from detailed GeoJSON boundaries.
  - Includes each feature in every overlapping tile by bbox and emits approximate adjacency files.

- `scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs`
  - Uploads generated geography shard JSON files and manifest to R2.
  - Uses S3-compatible upload with geo-specific env vars and existing R2 credential fallbacks.

- `scripts/geography/compare_r2_geo_lookup_with_aiven.py`
  - Runs Layer 1 validation by comparing Aiven/PostGIS PCON/LA lookup with R2 shard lookup for sampled stations.
  - Produces a JSON mismatch report without modifying station rows.
