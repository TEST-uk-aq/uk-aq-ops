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
  - Builds PCON/LA grid shard JSON files, `by_code/` geometry objects, and `manifest.json` from detailed GeoJSON boundaries.
  - Includes each feature ref in every overlapping tile by bbox, stores full geometry once per code, and emits approximate adjacency files.
  - Accepts mixed boundary CRS inputs; reprojects `EPSG:27700` geometry to `EPSG:4326` during build so WGS84 tile logic stays valid.

- `scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs`
  - Uploads generated geography shard JSON files, `by_code/` geometry objects, and manifest to R2.
  - Defaults to geo bucket `uk-aq-pcon-la-lookup`.
  - Prefers Cloudflare account API-token upload using `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` and `UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN`.
  - Falls back to S3-compatible upload only when API-token mode is not configured.

- `scripts/geography/validate_r2_geo_lookup_against_stations.py`
  - Runs Layer 1 validation by comparing stored station PCON/LA codes with the R2 shard lookup for sampled stations.
  - Use `npm run geo:validate-stations` for the package alias.
  - Produces a JSON confidence report without modifying station rows.

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
  - `UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX` defaults to `true`; set it to `false`
    to skip the final full R2 history index rebuild after a successful run.
  - Full behavior and merge-mode details are documented in:
    - [`uk-aq-backfill-local.md`](uk-aq-backfill-local.md)

## History integrity scripts

See [`uk-aq-r2-history-integrity.md`](uk-aq-r2-history-integrity.md) for the full
system doc.

## R2 history backup scripts

- `scripts/backup_r2/build_backup_inventory.mjs`
  - Walks R2, etag-skips unchanged manifests, writes `history/_index/backup_inventory_v1.json`.
  - The slow scan only fires once (first build) and for changed entries thereafter.
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
  - Reads the inventory, compares hashes to the Dropbox checkpoint, copies only changed/missing units.
  - Retries Dropbox write-rate throttle errors (`too_many_write_operations`) with exponential backoff before failing the run.
  - Fails loudly if the inventory is missing/invalid; no fallback to direct scan.
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`
  - Rebuilds R2 history latest/index manifests for `observations`, `aqilevels`, or both.
  - Supports targeted observations rebuilds via:
    - `--target YYYY-MM-DD:connector_id` (repeatable)
    - `--targets-csv <path>` where CSV includes `day_utc,connector_id`.
  - `--compute-missing-timeseries-counts` can patch missing connector-manifest
    `timeseries_row_counts` from parquet before writing index manifests.
- `scripts/backup_r2/uk_aq_report_missing_timeseries_counts_local.mjs`
  - Scans local Dropbox R2 mirror files for observation `(day_utc, connector_id)`
    units where `timeseries_row_counts` are missing/invalid in connector or
    observations-timeseries index manifests.
  - Outputs CSV/JSON; CSV includes `day_utc,connector_id` so the report can be
    fed into `uk_aq_build_r2_history_index.mjs --targets-csv ...`.
- `scripts/backup_r2/uk_aq_validate_aqi_from_dropbox_observs.mjs`
  - Recomputes AQI history rows from local Dropbox observations parquet and
    compares them to local Dropbox aqilevels parquet by `(day_utc, connector_id)`.
  - `--dry-run` (default) reports mismatches only and does not write to R2.
  - `--write-r2` runs targeted AQI rebuild writes via
    `scripts/uk_aq_backfill_local.sh` in `r2_history_obs_to_aqilevels` mode.
- `scripts/backup_r2/uk_aq_strip_day_timeseries_counts_from_r2.mjs`
  - Scans local Dropbox observations day manifests for top-level
    `timeseries_row_counts` and reports affected days.
  - `--dry-run` (default) reports only.
  - `--write-r2` removes top-level day-manifest `timeseries_row_counts` in R2
    for matching days and rewrites `manifest_hash` deterministically.
- `scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs`
  - Rebuilds one observations or aqilevels R2 day manifest from the connector
    manifests already present under that day.
  - Metadata-only: does not read source DB rows or parquet payloads.
  - `--dry-run` (default) reports the rebuilt manifest summary only.
  - `--write-r2` writes the repaired day manifest; run
    `uk_aq_build_r2_history_index.mjs --domain <domain>` afterwards, without
    `--target`/`--targets-csv`, so latest/index manifests pick up the repaired
    day.
- `scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs`
  - One-off bootstrap utility for the Pub/Sub-based latest snapshot builder.
  - Reads existing latest snapshot objects (`latest_snapshots/v1/...`) plus
    latest core snapshot timeseries mapping (`history/v1/core/day_utc=...`) and
    builds `latest_state.json` for `latest_snapshots_state/v1` (or custom
    `--state-key`).
  - `--write-r2` applies the seed; default is dry-run/report only.
- `scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs`
  - One-off refresh utility for latest snapshot state using Supabase latest RPC.
  - Pulls matrix rows from `uk_aq_latest_rpc` (configurable), dedupes by
    `(connector_id, timeseries_id)` with newest `last_value_at`, and writes
    `latest_state.json` for `latest_snapshots_state/v1` (or custom `--state-key`).
  - `--write-r2` applies the refreshed state; default is dry-run/report only.
- `scripts/backup_r2/lib/`
  - `rclone.mjs` shared rclone wrappers + sha256 + path helpers.
  - `inventory.mjs` schema constants + `loadInventory(...,{strict})` used by both scripts.

See [`uk-aq-r2-history-dropbox-backup.md`](uk-aq-r2-history-dropbox-backup.md) for the full system doc.

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh`
  - Thin shell launcher; loads `<ENV>.env`, runs guardrails, creates state
    dirs, takes a per-environment PID lock, then calls the python entrypoint.
  - Required arg `--env CIC-Test|LIVE`; forwards `--profile`, `--source`,
    `--from-day`, `--to-day`, `--dry-run`, `--check-only`, `--run-backfill`,
    `--max-download-mb`, `--max-runtime-minutes`, `--verbose` to python.
  - Deploys to `/Users/mikehinford/uk-aq-history-integrity/bin/`; in-repo
    location is the source of truth.

- `scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py`
  - Local-only AQI gap checker for missing hourly AQI rows.
  - Compares expected AQI row presence from local observations against actual local AQI hourly history.
  - Supports `r2-dropbox` and `db-dump` source modes plus `daily`, `weekly`, `monthly`, and `obsaqidb` profiles.
  - Writes JSON + markdown reports under `UK_AQ_AQI_GAP_REPORT_DIR/` and stores run summaries in the shared history-integrity SQLite DB. In the deployed env examples, this resolves to `.../uk-aq-history-integrity/aqi_gap_check/reports/`, with logs under the sibling `.../aqi_gap_check/logs/` directory.

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
    `source_station_timeseries_lookup` for `openaq`,
    `sensorcommunity`, and `uk_air_sos`. Reuses on unchanged manifest hash;
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
  - Phase 7.2 helper: `build_uk_air_sos_canonical_snapshot(...)` builds
    deterministic station/day canonical NDJSON snapshots for `uk_air_sos`
    (`station_ref`, `timeseries_id`, `timeseries_ref`, `observed_at_utc`,
    `value`), returning explicit statuses:
    `ok`, `no_data`, `not_found`, `temporary_error`, `permanent_error`.
    It does not write R2/Supabase and does not trigger backfill.
  - Phase 7.3: `check_uk_air_sos(...)` now runs station/day SOS source checks
    (via source key `uk_air_sos`) and writes:
    `source_file_state`, `source_file_events`, and
    `source_file_timeseries_counts` for successful checks. Source unit is
    `uk_air_sos:station_ref=<station_ref>:day_utc=<YYYY-MM-DD>`. Snapshot
    cache retention is controlled by
    `UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=none|changed|all` (default
    `changed`). First-seen entries are baseline-only (no direct backfill);
    temporary/permanent source errors do not replace prior good baseline
    hashes/counts.
  - Phase 7.4: observation-repair candidate selection now includes
    `uk_air_sos` in cross-check connector filters, and merges cross-check
    discrepancies with SOS source-change candidates (`changed`/`reappeared`)
    before deduping by `(connector_id, day_utc, timeseries_id)`. Observation
    repair continues to run with `observations_only`, and successful observation
    repair queues AQI rebuilds at `(connector_id, day_utc)` granularity.
  - Phase 7.5: SOS outcomes are explicitly tracked/reportable as
    `ok`/`no_data`/`not_found`/`temporary_error`/`permanent_error`.
    Temporary/permanent failures do not overwrite prior good baselines and do
    not create repair candidates. Optional 404 suppression can be enabled with
    `UK_AQ_HISTORY_INTEGRITY_UK_AIR_SOS_NOT_FOUND_COOLDOWN_MINUTES` to avoid
    repeated station/day not-found re-fetches during the cooldown window.
  - Phase 7.6 docs completion: SOS model and operations are now documented in
    `system_docs/uk-aq-r2-history-integrity.md`, including naming rules
    (`sensorcommunity`, `uk_air_sos`), source/evidence/repair/AQI unit
    boundaries, snapshot-cache path contract, `KEEP_API_SNAPSHOTS` controls,
    and SOS-specific check-only/dry-run/manual run command examples.
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
  - Forces `UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false` so integrity repairs do
    not trigger a full-history index rebuild.
  - After a successful non-dry-run repair, runs one targeted R2 history index update
    for the affected day range and connector/domain.

## GCP Secret Manager scripts

- `scripts/gcp/uk_aq_secret_upsert_if_changed.sh`
  - Upserts one secret from stdin with dry-run as default.
  - Compares proposed value against the latest enabled secret version without printing values.
  - Creates a new version only when changed.
  - In apply mode, destroys older active versions and verifies exactly one active version remains.
  - Detects Cloud Run numeric secret-version pins and can update them to `latest` before cleanup.

- `scripts/gcp/uk_aq_cleanup_secret_versions.sh`
  - Project-wide cleanup utility (dry-run by default) to keep one active version per secret.
  - Lists active versions/states per secret, selects a keep version, and plans/executes destroys.
  - Checks Cloud Run secret references first; by default it skips secrets with numeric-version pins unless `--fix-cloud-run-pins 1` is provided.
  - In apply mode, verifies each processed secret ends with exactly one active version.

## Cache proxy checks

- `scripts/uk_aq_cache_proxy/check_timeseries_v2_skeleton.mjs`
  - Lightweight normalization checks for `/api/aq/timeseries?v=2` skeleton behavior.
  - Verifies flag gating, canonical query normalization (`timeseries_id`, `window`, `since`, `start_utc`, `end_utc`, `format`, `v`), and cache-buster stripping behavior.
