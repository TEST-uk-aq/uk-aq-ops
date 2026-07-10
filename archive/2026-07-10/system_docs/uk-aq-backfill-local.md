# UK-AQ Local Backfill

## Purpose

`scripts/uk_aq_backfill_local.sh` is the local/manual wrapper for backfill runs.
It executes `workers/uk_aq_backfill_local/run_job.ts` over the requested UTC day range,
chunking requests into internal windows for pacing and logging.

## Run modes

The runner supports these modes:

- `local_to_aqilevels`
- `obs_aqi_to_r2`
- `source_to_r2`
- `r2_history_obs_to_aqilevels`

## Wrapper behavior

`scripts/uk_aq_backfill_local.sh`:

- validates required env vars:
  - `UK_AQ_BACKFILL_RUN_MODE`
  - `UK_AQ_BACKFILL_DRY_RUN`
  - `UK_AQ_BACKFILL_FORCE_REPLACE`
  - `UK_AQ_BACKFILL_FROM_DAY_UTC`
  - `UK_AQ_BACKFILL_TO_DAY_UTC`
- forces `UK_AQ_BACKFILL_TRIGGER_MODE=manual` for local runs
- resolves runner path from:
  - `UK_AQ_BACKFILL_RUN_JOB_PATH` (optional), otherwise
  - `workers/uk_aq_backfill_local/run_job.ts`
- executes one run per internal date window and writes per-window logs
- rebuilds R2 history index after successful non-dry runs for:
  - `source_to_r2`
  - `obs_aqi_to_r2`
  - `r2_history_obs_to_aqilevels`

## Local wrapper env vars

Primary (preferred) env vars:

- `UK_AQ_BACKFILL_LOCAL_LOG_DIR` (default `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/<UK_AQ_ENV_NAME>/uk-aq-backfill-local-logs`; falls back to `<UK_AQ_DROPBOX_ROOT>`, then `local`)
- `UK_AQ_BACKFILL_LOCAL_STOP_ON_ERROR` (default `true`)
- `UK_AQ_BACKFILL_RUN_INTERVAL_SECONDS` (default `0`)
- `UK_AQ_BACKFILL_MAX_RUNS_PER_MINUTE` (default `0`, disabled)
- `UK_AQ_BACKFILL_MAX_RUNS_PER_HOUR` (default `0`, disabled)
- `UK_AQ_BACKFILL_PAUSE_SECONDS` (legacy alias for run interval)
- `UK_AQ_BACKFILL_OUTPUT_SCOPE` (default `default`)
- `UK_AQ_BACKFILL_REPAIR_MISSING_TIMESERIES_COUNTS` (default `false`)
- `UK_AQ_BACKFILL_INDEX_STRICT_MISSING_TIMESERIES_COUNTS` (default `false`)

## Metadata source rules

Backfill metadata resolution (connector/station/timeseries mappings) now prefers
local Dropbox R2 history backup first, then falls back.

Order:

1. Local Dropbox R2 history backup (`UK_AQ_R2_HISTORY_DROPBOX_ROOT`, or
   `UK_AQ_DROPBOX_ROOT` plus `UK_AQ_R2_HISTORY_DROPBOX_DIR` where supported)
2. Live R2 API (if credentials present)
3. Ingest DB metadata queries (fallback)

When fallback to ingest metadata is used after core-history lookup attempts,
a warning is emitted in structured logs.

## Retention rule and old-day behavior

Backfill uses ingest retention logic for source-of-truth day selection with
`INGEST_RETENTION_DAYS`.

Outside-retention cutoff is:

- `day_utc <= today_utc - (INGEST_RETENTION_DAYS + 1)`

Example: on 2026-05-13 with retention `4`, newest outside-retention day is
2026-05-08.

## `source_to_r2` targeted merge mode

### Why

Integrity-triggered repairs may only target a subset of timeseries IDs for a
connector/day. Full connector/day overwrite can drop unaffected rows.

### Trigger

Targeted merge is used when all are true:

- mode is `source_to_r2`
- `UK_AQ_BACKFILL_SOURCE_TO_R2_TARGETED_MERGE=true` (default)
- `UK_AQ_BACKFILL_TIMESERIES_IDS` or `UK_AQ_BACKFILL_TIMESERIES_ID` is set

### Merge flow

For each `(day_utc, connector_id)`:

1. Fetch source rows for the requested day.
2. If `UK_AQ_BACKFILL_TIMESERIES_IDS` is set, pre-filter OpenAQ location/day
   source fetches to only locations mapped to those requested timeseries IDs.
   For `sos`, pre-filter candidate timeseries bindings to only those
   requested IDs before per-timeseries fetch.
3. For `sos`, require a valid AURN flat-file mapping in
   `uk_aq_raw.sos_station_timeseries_site_refs` before source fetch. Each
   candidate timeseries must have exactly one valid row for the requested
   `day_utc`, and each `site_ref + pollutant_code + day_utc` must map to only
   one timeseries. Missing or ambiguous mappings fail loudly and no R2 objects
   are written.
4. Read existing local Dropbox observations + AQI connector manifests/parquet.
5. Split data by target timeseries IDs:
   - preserve non-target rows from local history
   - replace target rows with newly-built source rows
6. Optional chunk-safe staging (when enabled): write merged rows to local stage
   files and defer R2 commit until finalize chunk.
7. Rebuild merged observations parquet + manifest.
8. Rebuild merged AQI parquet + manifest.
9. Upload merged connector outputs to live R2 (replace connector/day objects).
10. Rebuild day-level manifests from connector manifests.

### Chunk-safe targeted staging

Integrity can run targeted `source_to_r2` in chunks. To avoid later chunks
overwriting earlier chunk replacements, chunked calls can use local stage files:

- `UK_AQ_BACKFILL_TARGETED_STAGE_ENABLED=true`
- `UK_AQ_BACKFILL_TARGETED_STAGE_ROOT=<local dir>`
- `UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE=false` for non-final chunks
- `UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE=true` for the final chunk
- `UK_AQ_BACKFILL_TARGETED_STAGE_CLEANUP=true` to remove stage files after
  successful final commit

Behaviour:

1. Non-final chunk merges against stage baseline (if present) else local
   history baseline, writes merged rows back to stage, and **does not commit**
   to R2.
2. Final chunk loads stage baseline, applies final targeted replacement, then
   commits one merged connector/day result to R2.

### No-data tolerance

The `source_to_r2` path has missing-data branches that write the manifest
instead of skipping. These are intentional.

1. **Source genuinely has no data** (OpenAQ S3 returned `found:false` for every candidate location, `locationFilesFound === 0`). Treated as *authoritative-no-data*: writes an empty connector manifest (`file_count: 0`, `source_row_count: 0`, `files: []`) and the corresponding day manifest, instead of skipping. Distinguished from transport errors by the explicit per-location outcome counters (`found / missing / error`); transport errors still propagate and abort the chunk. Logged via `source_to_r2_openaq_empty_manifest_written` and `source_to_r2_openaq_no_data_classification` with `class: "authoritative_no_data" | "transport_error" | "metadata_mismatch"`. The classification is persisted in the ledger checkpoint as `no_data_classification`.

2. **Targeted merge has no local-history baseline** (`loadObsRowsForConnectorDayFromLocalHistory` and/or its AQI counterpart returned null — typical for days the original ingest missed). Treated as *no preservation needed*: continues with `preservedObsRows = []`, writes only the replacement rows for the targeted timeseries as a fresh connector + day manifest. Logged via `source_to_r2_targeted_merge_no_local_history` and recorded in the ledger checkpoint as `targeted_local_history_missing: true`.

3. **Sensor.Community daily archive day is missing/empty** (day index resolves with no source files, including HTTP 404 on `https://archive.sensor.community/YYYY-MM-DD/`). Treated as *authoritative-no-data*: writes an empty connector manifest and day manifest instead of skipping. Logged via `source_to_r2_sensorcommunity_empty_manifest_written` and `source_to_r2_sensorcommunity_no_data_classification`. Metadata-mismatch cases (for example, archive files exist but none match requested station filters) still skip with `no_data_classification: "metadata_mismatch"` and do not write empty manifests.

Metadata-mismatch skips remain skips (no manifest written) — these are configuration errors, not no-data:

- `no_matching_requested_timeseries_ids` — requested IDs don't exist in the connector lookup
- `no_matching_location_ids_after_timeseries_filter` — requested IDs map to no OpenAQ locations
- `sos_flat_file_mapping_guard_failed` — UK-AIR source-to-R2 has
  missing or ambiguous `site_ref + pollutant_code + day_utc` mappings in
  `uk_aq_raw.sos_station_timeseries_site_refs`

Adapters other than OpenAQ and Sensor.Community keep the original
skip-on-no-data behaviour; extend per-adapter as needed.

### UK-AIR observation status

For `sos`, source observations preserve the source status when present
and write it to observation history parquet as nullable `status`. This is where
UK-AIR values such as `Ratified` and `Provisional` are carried through to R2.
Older parquet objects may not have this column; readers treat missing status as
`null`.

The UK-AIR flat-file mapping guard needs ingest DB access because it reads
`uk_aq_raw.sos_station_timeseries_site_refs` through PostgREST. Local/manual
backfill environments therefore need the `SUPABASE_URL` and `SB_SECRET_KEY`
values available before running UK-AIR historical source-to-R2, or the
`INGESTDB_SUPABASE_URL` / `INGESTDB_SECRET_KEY` fallbacks if those are the
names provided in the environment file.

## AQI handling / output scope

`UK_AQ_BACKFILL_OUTPUT_SCOPE` controls which outputs are allowed:

- `default`
  - Existing behavior.
  - `source_to_r2` writes observations and AQI history outputs.
  - `r2_history_obs_to_aqilevels` rebuilds AQI history outputs.
- `observations_only` (valid only with `source_to_r2`)
  - Writes observation history outputs only.
  - Does not build/export/write AQI history parquet/manifests.
  - Skip guard only checks observation rows (`obsHistoryRows.length`).
  - Observation connector manifests always include `timeseries_row_counts`
    aggregated from written parquet parts, so downstream `_index` rebuild has
    per-timeseries counts for cross-check parity.
- `aqilevels_only` (valid only with `r2_history_obs_to_aqilevels`)
  - Rebuilds AQI history outputs only from committed R2 observation history.
  - For R2 history v2 with `UK_AQ_BACKFILL_CONNECTOR_IDS` set, rebuilds only
    the requested connector/day AQI partitions and does not require unrelated
    observation connectors for that day to already have AQI connector manifests.
    v1 keeps the full-day connector-manifest guard.
  - Writes normalized hourly AQI parquet under `history/v1/aqilevels/hourly/...`
    using `history_schema_name=aqilevels_hourly`,
    `history_schema_version=1`, `grain=hourly`, and
    `writer_version=parquet-wasm-zstd-v1`.
  - AQI rows include the normalized `daqi_input_*` and `eaqi_input_*`
    fields plus compatibility mean/index fields used by older diagnostics.

Invalid run-mode/output-scope combinations fail before any R2 mutation.

## Local AQI historical rebuild from Dropbox backup

For the AQI Levels v1 historical hard rebuild, use the dedicated local rebuild
script instead of the general `uk_aq_backfill_local.sh` wrapper:

```text
scripts/AQI-levels-refactor-June-2026/local_aqilevels_rebuild_from_dropbox.mjs
scripts/AQI-levels-refactor-June-2026/rebuild_aqilevels_from_r2_dropbox_local_TEST.sh
```

This path reads committed observation parquet from the local Dropbox R2 backup,
computes normalized hourly AQI rows locally, writes generated AQI parquet and
manifests under a non-Dropbox work directory, and can upload those generated
files to TEST R2 only.

Default paths:

- source root: `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup`
- work root: `~/uk-aq-work/aqilevels-rebuild`
- TEST R2 target: `uk_aq_r2_test:uk-aq-history-cic-test`
- AQI prefix: `history/v1/aqilevels/hourly`

The local rebuild reads both D-1 and D observations for each target day so PM2.5
and PM10 DAQI rolling 24-hour inputs can be computed without reading
Supabase/ObsAQIDB historical rows.

Safety rules:

- generated AQI work is refused if the work root is inside Dropbox
- generated AQI work is refused if it would be written inside the source backup
- upload mode requires typed confirmation: `REBUILD TEST AQI LOCAL`
- upload mode refuses R2 targets whose name includes `live`
- index rebuild, backup inventory rebuild, and Dropbox sync are skipped
  intentionally and must be run manually after TEST R2 verification
- no Supabase historical backfill or ObsAQIDB rollup is run by this path

Command examples:

```bash
./scripts/AQI-levels-refactor-June-2026/rebuild_aqilevels_from_r2_dropbox_local_TEST.sh \
  --from-day 2025-01-30 \
  --to-day 2025-01-30 \
  --connector-ids 3 \
  --local-only

UK_AQ_LOCAL_AQI_CONFIRMATION="REBUILD TEST AQI LOCAL" \
./scripts/AQI-levels-refactor-June-2026/rebuild_aqilevels_from_r2_dropbox_local_TEST.sh \
  --from-day 2025-01-01 \
  --to-day 2026-06-07 \
  --upload
```

Reports are written under:

```text
~/uk-aq-work/aqilevels-rebuild/reports/local_aqilevels_rebuild_TEST_<timestamp>.json
```

## Manual index-count repair flags

`timeseries_row_counts` is the per-timeseries row-count map for a manifest
partition. For v2 AQI hourly pollutant manifests it counts AQI hourly rows by
`timeseries_id`, for example `{ "123": 24, "124": 18 }`.

Missing `timeseries_row_counts` on a non-empty v2 AQI source manifest is a
manifest integrity problem, not evidence that AQI data is absent. The R2 history
index rebuilder warns by default and includes the affected manifest key, day,
connector, pollutant, and row count in its JSON summary. Strict mode turns the
same condition into a failed index build:

- `node scripts/backup_r2/uk_aq_build_r2_history_index.mjs --history-version v2 --targeted --domain aqilevels --from-day <day> --to-day <day> --connector-id <id> --strict-missing-timeseries-counts`

The explicit repair switch reads the referenced parquet files, computes the
missing map, patches the source manifest with a new `manifest_hash`, and builds
the index from the patched manifest:

- `node scripts/backup_r2/uk_aq_build_r2_history_index.mjs --history-version v2 --targeted --domain aqilevels --from-day <day> --to-day <day> --connector-id <id> --compute-missing-timeseries-counts`

For local backfill runs, set
`UK_AQ_BACKFILL_REPAIR_MISSING_TIMESERIES_COUNTS=true` to have the final index
step run the targeted v2 AQI repair over the requested date window. If
`UK_AQ_BACKFILL_CONNECTOR_IDS` contains exactly one integer, the wrapper also
passes `--connector-id`; otherwise it stays date-targeted. Set
`UK_AQ_BACKFILL_INDEX_STRICT_MISSING_TIMESERIES_COUNTS=true` to pass the strict
guard through the wrapper. The targeted v2 repair refreshes the v2
`history/_index_v2/timeseries` metadata index after rewriting the AQI
timeseries indexes; the metadata refresh is derived from existing v2 timeseries
index manifests and does not read parquet.

When repair is not enabled, the wrapper keeps the normal full index rebuild
path. If `UK_AQ_R2_HISTORY_VERSION` is set to `v1` or `v2`, the wrapper passes
that value to `uk_aq_build_r2_history_index.mjs --history-version` explicitly.

These switches are optional and not enabled by default.

## Key env vars for integrity-triggered runs

Integrity uses wrapper + env file and sets:

- `UK_AQ_BACKFILL_RUN_MODE=source_to_r2`
- `UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only`
- `UK_AQ_BACKFILL_FORCE_REPLACE=true`
- `UK_AQ_BACKFILL_FROM_DAY_UTC=<day>`
- `UK_AQ_BACKFILL_TO_DAY_UTC=<day>`
- `UK_AQ_BACKFILL_TIMESERIES_IDS=<csv>`

AQI rebuild pass uses:

- `UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels`
- `UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only`
- `UK_AQ_BACKFILL_FORCE_REPLACE=true`
- `UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>`
- `UK_AQ_BACKFILL_FROM_DAY_UTC=<day>`
- `UK_AQ_BACKFILL_TO_DAY_UTC=<day>`

When the integrity wrapper runs this AQI pass for history v2, the worker allows
the connector-scoped write and the wrapper follows with a targeted v2 AQI
timeseries index update plus v2 timeseries metadata refresh.

Recommended supporting vars in the backfill env file:

- `UK_AQ_DROPBOX_ROOT=<env root, e.g. CIC-Test>` and
  `UK_AQ_R2_HISTORY_DROPBOX_DIR=<relative backup dir, default R2_history_backup>`;
  explicit `UK_AQ_R2_HISTORY_DROPBOX_ROOT=<absolute local Dropbox backup root>`
  is still supported.
- `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT=<absolute local OpenAQ cache root>`
- `UK_AQ_BACKFILL_SOS_INTEGRITY_SNAPSHOT_ROOT=<absolute local integrity source-cache root>/sos`
- `CFLARE_R2_*` / `R2_*` credentials for live write

For `UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT`, backfill can reuse either local
cache layout:

- `day_utc=YYYY-MM-DD/location-<location_id>-YYYYMMDD.csv.gz`
- `locationid=<location_id>/year=YYYY/month=MM/location-<location_id>-YYYYMMDD.csv.gz`

For `UK_AQ_BACKFILL_SOS_INTEGRITY_SNAPSHOT_ROOT`, `source_to_r2` can reuse
same-run integrity SOS snapshots at:

- `station_ref=<urlencoded_station_ref>/day_utc=YYYY-MM-DD/snapshot.ndjson`

## Outputs

- connector/day parquet + connector manifests under:
  - `history/v1/observations/...`
  - `history/v1/aqilevels/hourly/...`
- day manifests:
  - `history/v1/observations/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/manifest.json`
- local logs under `UK_AQ_BACKFILL_LOCAL_LOG_DIR`
- optional ledger rows (when enabled)
