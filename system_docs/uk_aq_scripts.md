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
  - `UK_AQ_BACKFILL_REPAIR_MISSING_TIMESERIES_COUNTS` defaults to `false`; set
    it to `true` to make the final index step run a targeted v2 AQI repair with
    `--compute-missing-timeseries-counts` for the requested day window. The
    targeted v2 index update also refreshes `history/_index_v2/timeseries`
    metadata from the updated timeseries index manifests.
  - `UK_AQ_BACKFILL_INDEX_STRICT_MISSING_TIMESERIES_COUNTS` defaults to
    `false`; set it to `true` to fail the final index step when non-empty v2
    AQI manifests still lack usable `timeseries_row_counts`.
  - When `UK_AQ_R2_HISTORY_VERSION` is set to `v1` or `v2`, the wrapper passes
    it explicitly to the normal final index rebuild as `--history-version`.
  - Full behavior and merge-mode details are documented in:
    - [`uk-aq-backfill-local.md`](uk-aq-backfill-local.md)

- `scripts/AQI-levels-refactor-June-2026/local_aqilevels_rebuild_from_dropbox.mjs`
  - Rebuilds normalized hourly AQI history from local Dropbox R2 observation
    backup files into a non-Dropbox local work directory.
  - Reads D-1 and D observations for each target day so DAQI PM rolling 24-hour
    inputs have previous-day context.
  - Can upload generated AQI parquet/manifests to TEST R2 only under
    `history/v1/aqilevels/hourly`.
  - Requires typed confirmation `REBUILD TEST AQI LOCAL` for upload mode.
  - Intentionally does not run R2 index rebuild, backup inventory rebuild,
    Dropbox sync, Supabase historical backfill, or ObsAQIDB rollups.

- `scripts/AQI-levels-refactor-June-2026/rebuild_aqilevels_from_r2_dropbox_local_TEST.sh`
  - Shell wrapper for the local AQI historical rebuild script.
  - Defaults to the local Dropbox TEST backup as source and
    `~/uk-aq-work/aqilevels-rebuild` as generated output work root.
  - Supports `--dry-run`, `--local-only`, and `--upload`; upload mode targets
    `uk_aq_r2_test:uk-aq-history-cic-test`.

## Cloud Run workers

- `workers/uk_aq_who_2021_daily_cloud_run/run_service.ts`
  - Scheduled Cloud Run service for WHO 2021 derived status rows.
  - `GET /` and `GET /health` return a lightweight health response.
  - `POST /` and `POST /run` run one bounded daily/backfill/dry-run calculation.
  - Uses service-role RPCs in Obs AQI DB:
    - `uk_aq_public.uk_aq_rpc_who_2021_daily_status_refresh`
    - `uk_aq_public.uk_aq_rpc_who_2021_readiness_check`
    - `uk_aq_public.uk_aq_rpc_who_2021_summary_refresh`
    - `uk_aq_public.uk_aq_rpc_who_2021_processing_run_log`
  - Current scope writes `uk_aq_ops.who_2021_daily_status`,
    `uk_aq_ops.who_2021_rolling_year_status`, and last-complete-year rows in
    `uk_aq_ops.who_2021_calendar_year_status`. R2 summary JSON publication is
    opt-in; parquet R2 writes remain a later Phase 4b worker task.
  - Scheduled daily runs use a readiness gate before latest-summary refresh:
    the final hour-ending source timestamp must have enough per-pollutant
    eligible-timeseries coverage, otherwise the run logs a deferred no-op.
  - Daily windows use hour-ending source semantics: `(day 00:00, next day
    00:00]`, equivalent to `01:00` through next-day `00:00` UTC/GMT for GOV.UK
    AURN.

## History integrity scripts

See [`uk-aq-r2-history-integrity.md`](uk-aq-r2-history-integrity.md) for the full
system doc.

## R2 history backup scripts

- `scripts/backup_r2/build_backup_inventory.mjs`
  - Walks R2, etag-skips unchanged manifests, writes the selected backup inventory (`history/_index/backup_inventory_v1.json` or `history/_index_v2/backup_inventory_v2.json`).
  - The slow scan only fires once (first build) and for changed entries thereafter.
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
  - Reads the selected inventory, compares hashes to the matching Dropbox checkpoint (`r2_history_backup_state_v1.json` or `r2_history_backup_state_v2.json`), copies only changed/missing units.
  - Uses `rclone copy` for changed day/domain folders, then prunes obsolete destination-only `.parquet` files inside inventory-listed units by comparing actual Dropbox Parquet files to the current manifest-referenced file set.
  - Defaults to inventory-wide pruning with `--prune-scope all`; `--prune-scope changed` limits pruning to units copied in the current run.
  - In v2 mode, stores prune/audit status in Dropbox at `_ops/checkpoints/r2_history_backup_prune_state_v2.json` so later runs can skip units already proven clean for the same inventory `manifest_hash`; `--force-prune-recheck` ignores that optimization for a deliberate re-audit.
  - Retries Dropbox write-rate throttle errors (`too_many_write_operations`) with exponential backoff before failing the run.
  - Separately retries transient Dropbox destination `rclone cat` and `rclone lsjson` failures up to five attempts with bounded exponential backoff. Exhausted units remain untrusted; inventory-wide prune records them, continues auditing later units, and fails the run after the audit.
  - Fails loudly if the inventory is missing/invalid; no fallback to direct scan.
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`
  - Rebuilds R2 history latest/index manifests for `observations`, `aqilevels`, or both.
  - For `--history-version v2`, full rebuilds also write direct timeseries metadata objects at `history/_index_v2/timeseries/timeseries_id=<id>.json` so historical readers can resolve connector context without Supabase when callers omit `connector_id`.
    Those metadata objects are derived from actual v2 data pollutant partitions and their matching timeseries index manifests, not from a full connector-by-pollutant expected grid.
  - For `--history-version v2`, latest descriptors also emit
    `day_summaries[].connectors[].row_count` from actual v2 pollutant manifest
    row counts. The Ops dashboard R2 connector row-count charts depend on this
    contract; after deploying index-builder changes, rebuild with
    `node scripts/backup_r2/uk_aq_build_r2_history_index.mjs --history-version v2 --domain both`.
  - Supports targeted observations rebuilds via:
    - `--target YYYY-MM-DD:connector_id` (repeatable)
    - `--targets-csv <path>` where CSV includes `day_utc,connector_id`.
  - `--compute-missing-timeseries-counts` can patch missing source-manifest
    `timeseries_row_counts` from parquet before writing index manifests. For
    v2 AQI hourly data this repairs non-empty pollutant manifests where the map
    is missing.
  - `--strict-missing-timeseries-counts` fails v2 AQI index builds if a
    non-empty pollutant manifest lacks usable `timeseries_row_counts`; without
    strict mode the condition is reported in warnings instead of silently
    indexing `null`.
- `scripts/backup_r2/uk_aq_report_missing_timeseries_counts_local.mjs`
  - Scans local Dropbox R2 mirror files for observation `(day_utc, connector_id)`
    units where `timeseries_row_counts` are missing/invalid in connector or
    observations-timeseries index manifests.
  - Outputs CSV/JSON; CSV includes `day_utc,connector_id` so the report can be
    fed into `uk_aq_build_r2_history_index.mjs --targets-csv ...`.
- `scripts/backup_r2/uk_aq_validate_aqi_from_dropbox_observs.mjs`
  - Recomputes AQI history rows from local Dropbox observations parquet and
    compares them to local Dropbox aqilevels parquet by `(day_utc, connector_id)`.
  - Supports `--history-version v1|v2`; v1 uses the configured v1 prefixes
    exactly, while v2 reads `history/v2/observations` and
    `history/v2/aqilevels/hourly/data` unless overridden by env.
  - `--dry-run` (default) reports mismatches only and does not write to R2.
  - `--write-r2` runs targeted AQI rebuild writes via
    `scripts/uk_aq_backfill_local.sh` in `r2_history_obs_to_aqilevels` mode
    with the selected `UK_AQ_R2_HISTORY_WRITE_VERSION`.
- `scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs`
  - Builds R2 `history/v2/observations` from the local Dropbox
    `history/v1/observations` mirror plus the local core snapshot metadata.
  - Writes only to R2 in `--write-r2` mode; it never writes generated parquet
    back into the Dropbox mirror.
  - Default mode is `--dry-run`, which reports planned v2 object keys, row
    counts, missing metadata rows, and byte counts.
  - Existing v2 day manifests are not overwritten unless `--replace` is set, so
    connector-filtered smoke runs do not shrink an already-built day manifest.
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
  - v2 AQI-only repairs are connector-scoped when `--connector-id` is set; the
    backfill worker rebuilds the requested connector/day AQI partitions without
    requiring unrelated connectors on that day to have AQI manifests.
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
  - Verifies flag gating, canonical query normalization (`timeseries_id`, `connector_id`, `pollutant`, `window`, `since`, `start_utc`, `end_utc`, `format`, `v`), and cache-buster stripping behavior.
