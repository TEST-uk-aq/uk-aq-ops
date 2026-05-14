# UK AQ Scripts Notes

## Postcode lookup scripts

- `scripts/postcodes/build_postcode_lookup_from_onspd.mjs`
  - Reads ONSPD CSV and writes postcode shard JSON files plus `manifest.json`.
  - Shards are grouped by leading postcode area and keyed by normalized postcode.
  - Exact postcode values are compact arrays: `[lat, lon, pcon_code, la_code, area_town_id]` (no PCON/LA names).
  - Suggest rows and prefix samples are compact arrays: `[postcode_normalised, postcode_display, area_town_id, pcon_code, la_code]`.

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

- `scripts/uk_aq_backfill_local.sh`
  - Runs local backfill (`local_to_aqilevels`, `obs_aqi_to_r2`, `source_to_r2`, `r2_history_obs_to_aqilevels`).
  - Always forces `UK_AQ_BACKFILL_TRIGGER_MODE=manual` for local runs.
  - Supports `UK_AQ_BACKFILL_OUTPUT_SCOPE`:
    - `default` (existing behavior)
    - `observations_only` (valid with `source_to_r2` only)
    - `aqilevels_only` (valid with `r2_history_obs_to_aqilevels` only)
  - Resolves the backfill runner from:
    - `UK_AQ_BACKFILL_RUN_JOB_PATH` (optional override), else
    - `workers/uk_aq_backfill_local/run_job.ts`.
  - Archive paths are treated as retired and are not valid runner paths for active runs.
  - Supports local run throttling:
    - `UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE` (default `0`, disabled)
    - `UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR` (default `0`, disabled)
  - Existing spacing control still applies via `UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS`.
  - Full behavior and merge-mode details are documented in:
    - [`uk-aq-backfill-local.md`](uk-aq-backfill-local.md)

## History integrity scripts

See [`uk-aq-history-integrity.md`](uk-aq-history-integrity.md) for the full
system doc.

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh`
  - Thin shell launcher; loads `<ENV>.env`, runs guardrails, creates state
    dirs, takes a per-environment PID lock, then calls the python entrypoint.
  - Required arg `--env CIC-Test|LIVE`; forwards `--profile`, `--source`,
    `--from-day`, `--to-day`, `--dry-run`, `--check-only`, `--run-backfill`,
    `--max-download-mb`, `--max-runtime-minutes`, `--verbose` to python.
  - Deploys to `/Users/mikehinford/uk-aq-history-integrity/bin/`; in-repo
    location is the source of truth.

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
  - Python entrypoint. Phase 1: env/path guardrails, SQLite schema
    (`integrity_runs`, `source_file_state`, `source_file_events`,
    `core_snapshot_imports`), run row, JSON+MD summary report under
    `state/<ENV>/reports/`.
  - Phase 2: imports the latest core snapshot from
    `UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT` (verifying `manifest.json` and
    per-table SHA-256), populates `core_connectors_snapshot`,
    `core_stations_snapshot`, `core_timeseries_snapshot`,
    `core_phenomena_snapshot`, and rebuilds
    `source_station_timeseries_lookup` for `openaq` and
    `sensorcommunity`. Reuses on unchanged manifest hash;
    `--force-snapshot-import` overrides; `--skip-snapshot-import` for
    debug; `--dry-run` reports without writing.
  - Phase 3: OpenAQ adapter — HEADs `https://openaq-data-archive.s3.amazonaws.com`
    (overridable via `UK_AQ_HISTORY_INTEGRITY_OPENAQ_BASE_URL`) for every
    `(location, day)` from the lookup × `[--from-day, --to-day]`. Downloads only
    on metadata change, hashes both compressed and uncompressed, moves changed
    files into `state/<ENV>/source-cache/openaq/...`, and writes
    `first_seen`/`first_seen_missing`/`disappeared`/`reappeared`/`changed`
    events. `--max-download-mb` and `--max-runtime-minutes` enforce
    cooperative limits (run ends with `status=stopped_limit`).
    `--run-backfill` invokes `UK_AQ_BACKFILL_WRAPPER` (Phase 4):
    sources `UK_AQ_BACKFILL_ENV_FILE`, sets
    `RUN_MODE=source_to_r2 / DRY_RUN=false / FORCE_REPLACE=true /
    TIMESERIES_IDS=<csv> / FROM=TO=<day>`, runs via `bash` with a
    30-min safety timeout. Changed files are **batched per day** —
    one wrapper call per day with the union of affected timeseries
    IDs. Records `backfill_triggered / backfill_timeseries_ids /
    backfill_status` on each event row, full stdout/stderr to
    `state/<ENV>/logs/backfill/<run_compact>/day_<YYYY-MM-DD>.log`,
    and `backfills_triggered / backfills_ok / backfills_failed` on
    the run row. Failed backfills bump `errors_count`.
  - Phase 5: Sensor.Community adapter — fetches the daily archive
    index `https://archive.sensor.community/<YYYY-MM-DD>/`
    (overridable via `UK_AQ_HISTORY_INTEGRITY_SENSOR_COMMUNITY_BASE_URL`),
    parses HTML for `sensor_id -> filename`, then HEAD/download/hash
    each matched file. Plain CSV (no gzip).
    `state/<ENV>/source-cache/sensorcommunity/<YYYY-MM-DD>/<filename>.csv`.
    Backfills are batched per day at the end of the SC scan, identical
    to the OpenAQ flow. `--max-download-mb` / `--max-runtime-minutes`
    span both adapters via a shared `LimitTracker`.

- `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
  - Integrity-specific wrapper around `UK_AQ_BACKFILL_WRAPPER`.
  - Requires `--env CIC-Test|LIVE`, `--from-day`, `--to-day`, and exactly one mode:
    - `--observs-only` with required `--timeseries-ids` (optional `--connector-id`)
    - `--aqi-only` with required `--connector-id`
  - Loads `<ROOT>/env/<ENV>.env` and then sources `UK_AQ_BACKFILL_ENV_FILE`.
  - Enforces strict mode/output scope mapping:
    - `observs-only` -> `UK_AQ_BACKFILL_RUN_MODE=source_to_r2` + `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only`
    - `aqi-only` -> `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels` + `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`

## Cache proxy checks

- `scripts/uk_aq_cache_proxy/check_timeseries_v2_skeleton.mjs`
  - Lightweight normalization checks for `/api/aq/timeseries?v=2` skeleton behavior.
  - Verifies flag gating, canonical query normalization (`timeseries_id`, `window`, `since`, `start_utc`, `end_utc`, `format`, `v`), and cache-buster stripping behavior.
