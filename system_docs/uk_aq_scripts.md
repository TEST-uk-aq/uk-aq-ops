# UK AQ Scripts Notes

## Postcode lookup scripts

- `scripts/postcodes/build_postcode_lookup_from_onspd.mjs`
  - Reads ONSPD CSV and writes postcode shard JSON files plus `manifest.json`.
  - Shards are grouped by leading postcode area and keyed by normalized postcode.
  - Postcode values are compact arrays: `[lat, lon, pcon_code, la_code]` (no PCON/LA names).

- `scripts/postcodes/upload_postcode_lookup_to_r2.mjs`
  - Uploads shard files and `manifest.json` to R2 using S3-compatible API.
  - Supports postcode-specific env vars and existing `CFLARE_R2_*` conventions.
  - Clears existing prefix keys before upload by default.
  - Automatic cache purge is currently disabled; purge is handled manually in Cloudflare when needed.

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

## Backfill scripts

- `scripts/uk_aq_backfill_local_monthly.sh`
  - Runs local backfill month-by-month (`local_to_aqilevels`, `obs_aqi_to_r2`, `source_to_r2`, `r2_history_obs_to_aqilevels`).
  - Always forces `UK_AQ_BACKFILL_TRIGGER_MODE=manual` for local runs.
  - Resolves the backfill runner from:
    - `UK_AQ_BACKFILL_RUN_JOB_PATH` (optional override), else
    - `workers/uk_aq_backfill_cloud_run/run_job.ts`.
  - Archive paths are treated as retired and are not valid runner paths for active runs.
  - Supports local run throttling:
    - `UK_AQ_BACKFILL_MONTH_MAX_RUNS_PER_MINUTE` (default `0`, disabled)
    - `UK_AQ_BACKFILL_MONTH_MAX_RUNS_PER_HOUR` (default `0`, disabled)
  - Existing spacing control still applies via `UK_AQ_BACKFILL_MONTH_RUN_INTERVAL_SECONDS`.
