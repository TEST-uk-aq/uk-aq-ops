# UK AQ R2 History Dropbox Backup

This document describes the daily incremental backup from Cloudflare R2 History to Dropbox.

For the canonical R2 object tree and manifest/index payload shapes, see `system_docs/uk-aq-r2-history-layout.md`.

## Purpose

- Mirror committed R2 History day folders (and the derived index files used by the history fast paths) into Dropbox.
- Detect any old R2 day whose manifest has been rewritten and re-copy it — the system never assumes old days are immutable.
- Avoid reading every old day's manifest on every backup run. Steady-state runs are near-instant.

## Architecture

The backup is a **two-step pipeline** built around an R2-side inventory file.
It runs in exactly one layout mode per run: `v1` or `v2`.

Version selection:

1. `UK_AQ_R2_HISTORY_BACKUP_VERSION` if set.
2. Otherwise `UK_AQ_R2_HISTORY_WRITE_VERSION` if set.
3. Otherwise `v1`.

This lets the daily backup normally follow the active writer layout while still
allowing the backup to be pinned to v1 during mixed transition or backfill
windows.

1. **Builder** (`scripts/backup_r2/build_backup_inventory.mjs`) walks R2, decides which manifests have changed since the previous inventory (via `rclone lsjson` etag/size compare), reads only those, and writes a single deterministic JSON inventory back to R2.
2. **Sync** (`scripts/backup_r2/sync_history_to_dropbox.mjs`) reads that one inventory file, compares each entry's hash to the Dropbox-side checkpoint, and copies only the entries whose hashes differ.

The sync never scans R2 manifests directly. If the inventory is missing or invalid the sync fails loudly with an actionable message — there is no fallback to a slow direct scan. Recovery is to re-run the builder.

```
       ┌───────────────────┐                ┌──────────────────┐
       │  build_backup_    │  rclone        │  R2:             │
       │  inventory.mjs    ├───lsjson/cat──▶│  history/_index/ │
       │                   │                │   backup_inv...  │
       └─────────┬─────────┘                └────────┬─────────┘
                 │                                   │
                 ▼                                   ▼
       ┌───────────────────┐                ┌──────────────────┐
       │  sync_history_    │  rclone        │  Dropbox:        │
       │  to_dropbox.mjs   ├───copy────────▶│  R2_history_     │
       │                   │                │   backup/...     │
       └───────────────────┘                └──────────────────┘
                 ▲
                 │ reads inventory
                 └── reads/writes checkpoint at
                     _ops/checkpoints/r2_history_backup_state_v1.json
                     or r2_history_backup_state_v2.json
```

## Inventory file

Location:

- v1 R2: `history/_index/backup_inventory_v1.json`
- v2 R2: `history/_index_v2/backup_inventory_v2.json`
- One per bucket — CIC-Test and LIVE are separate.

Shape (abbreviated):

```json
{
  "version": 1,
  "kind": "uk_aq_r2_history_backup_inventory",
  "backup_version": "v1",
  "generated_at": "2026-05-15T12:00:00.000Z",
  "source": {
    "index_prefix": "history/_index",
    "index_v2_prefix": "history/_index_v2",
    "domain_prefixes": {...}
  },
  "domains": {
    "observations": {
      "days": {
        "2026-05-10": {
          "unit_type": "day_folder",
          "relative_path": "history/v1/observations/day_utc=2026-05-10",
          "manifest_relative_path": "history/v1/observations/day_utc=2026-05-10/manifest.json",
          "manifest_hash": "<sha256 of manifest bytes>",
          "manifest_size": 12345,
          "r2_md5": "<R2 object MD5 etag>",
          "r2_modtime": "...",
          "file_count": 1,
          "total_bytes": 79927,
          "source_row_count": 17151
        }
      }
    },
    "aqilevels": { "days": {...} },
    "aqilevels_debug": { "days": {...} },
    "core": { "days": {...} }
  },
  "index_files": {
    "observations_latest": { "unit_type": "file", "relative_path": "...", "hash": "...", "size": N, "r2_md5": "...", "r2_modtime": "..." },
    "aqilevels_latest": {...},
    "observations_timeseries_latest": {...},
    "aqilevels_timeseries_latest": {...},
    "observations_timeseries_v2_latest": {...},
    "aqilevels_hourly_data_timeseries_v2_latest": {...}
  },
  "index_tree_units": {
    "observations_timeseries": {
      "units": {
        "day_utc=2026-05-10/connector_id=6/manifest.json": { "unit_type": "file", "relative_path": "...", "hash": "...", ... }
      }
    },
    "aqilevels_timeseries": { "units": {...} },
    "observations_timeseries_v2": {
      "units": {
        "day_utc=2026-05-10/connector_id=6/pollutant_code=pm25/manifest.json": { "unit_type": "file", "relative_path": "...", "hash": "...", ... }
      }
    },
    "aqilevels_hourly_data_timeseries_v2": { "units": {...} }
  },
  "summary": {
    "domain_day_count": {...},
    "domain_object_count": {...},
    "domain_total_bytes": {...},
    "index_file_count": 4,
    "index_file_bytes": 12345,
    "index_tree_unit_count": {...},
    "index_tree_unit_bytes": {...}
  }
}
```

Hashes are SHA-256 of the exact JSON bytes as read from R2 — the same hash format the Dropbox checkpoint already records, so no migration was needed. The `r2_md5` + `r2_modtime` + size fields are kept so the next builder run can do its etag-skip comparison without re-reading every manifest.

The JSON is written with deterministic key ordering (alphabetical at every level).

### Etag-skip mechanism

For every R2 file the builder considers, it extracts `Size` and `Hashes.md5` from `rclone lsjson` and compares against the previous inventory entry's stored values. If they match, the entry is reused verbatim — the manifest is not re-read.

> **Important:** rclone only exposes the R2 ETag/MD5 in `Hashes.md5` when called with `--hash --hash-type MD5`. Plain `rclone lsjson` (or `lsjson -M`) **omits** the hash — the field is silently absent and skip decisions degrade to Size + ModTime. The lsjson wrappers in `scripts/backup_r2/lib/rclone.mjs` (`rcloneLsjsonRecursive`, `rcloneLsjsonFile`) include these flags by default. Don't strip them.
>
> Verified behaviour:
> - `rclone lsjson <object>` → no hash field
> - `rclone lsjson --hash --hash-type MD5 <object>` → `"Hashes": { "md5": "71350ccf…" }` (matches AWS S3 `head-object` ETag)

If MD5 is still missing after that (e.g. multipart-style composite etag, or a future backend regression), the builder falls back to `Size + ModTime` for the skip decision and reports the count under `md5_missing_count` + `metadata_warnings`. Modtime reflects upload time so it does change on rewrites, but is weaker than a real MD5.

The first build is unavoidably slow (full scan of every manifest). Steady-state runs are near-instant — **provided the upstream index rebuilder keeps tree-unit manifests byte-stable when underlying data hasn't changed.** See the next section.

### Upstream coordination — index rebuilder idempotency

The R2 history index rebuilder ([workers/shared/uk_aq_r2_history_index.mjs](../workers/shared/uk_aq_r2_history_index.mjs)) is invoked by `uk_aq_prune_daily` (Cloud Run, 02:00 UTC daily) after every successful Phase B run. It rewrites:
- per-`(day, connector)` tree-unit manifests under `history/_index/{observations,aqilevels}_timeseries/day_utc=…/connector_id=…/manifest.json`
- the four aggregate root index files: `history/_index/{observations,aqilevels}.json` and `history/_index/{observations,aqilevels}_timeseries_latest.json`
- when v2 indexes are explicitly built, per-`(day, connector, pollutant)` tree-unit manifests under `history/_index_v2/{observations_timeseries,aqilevels_hourly_data_timeseries}/day_utc=…/connector_id=…/pollutant_code=…/manifest.json`
- when present, the two v2 latest files: `history/_index_v2/observations_timeseries_latest.json` and `history/_index_v2/aqilevels_hourly_data_timeseries_latest.json`

This is a different "build" from the **inventory build** that runs inside the Dropbox backup workflow itself — the index rebuild produces R2 objects; the inventory build observes them. They share no code path. If you're confused which one is misbehaving, look at the output path: `_index/*` or `_index_v2/*` = index rebuild; `backup_inventory_v1.json` or `backup_inventory_v2.json` = inventory build.

Three properties of the rebuilder make our daily backup fast:

1. **Data-driven `generated_at` on tree units.** Tree-unit manifest payloads use the source connector manifest's `backed_up_at_utc` for `generated_at`, not wall-clock. When the source data didn't change, the payload bytes are identical run-to-run, so R2's MD5 etag stays stable and our `lsjson --hash` skip works.
2. **Data-driven `generated_at` on root index files.** The four aggregate `*.json` and `*_timeseries_latest.json` files derive `generated_at` from `max(daySummaries[*].backed_up_at_utc)` (or, for the timeseries-latest files, from `max(connector_indexes[*].backed_up_at_utc)` across all day summaries). Same byte-stability property — these files don't churn just because the rebuilder ran. Caller-supplied `generatedAt` is the fallback only when no source has any timestamp.
3. **Idempotent PUTs.** Every PUT in the rebuilder goes through `r2PutObjectIfChanged`: HEAD the existing object, MD5-compare against the new body, **skip the PUT entirely** when bytes match. Saves R2 PUT operations upstream and guarantees that nothing changes downstream when content didn't actually change. Rebuilder result objects include `put_skipped: true/false` per unit for observability.

Together these mean **only the days that genuinely received new data churn each cycle** — typically ~4 tree units (one per connector for "yesterday's" day), not ~4000. The backup builder re-cats only those few; the sync copytos only those few.

If you ever see tree units re-read en masse despite no source-data change, run `rclone cat <tree_unit_manifest> | jq '.generated_at, .backed_up_at_utc'` on a known-stable (day, connector). Both fields should match (both data-driven from the source). If `generated_at` is a recent wall-clock and `backed_up_at_utc` is older, the deployed `uk_aq_prune_daily` Cloud Run service is running pre-data-driven code — see the deploy gotcha below.

### Deploy gotcha — shared module paths in CI

`uk_aq_prune_daily` imports `rebuildR2HistoryIndexes` from `workers/shared/uk_aq_r2_history_index.mjs` (and several other shared modules). The deploy workflow at [`.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`](../.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml) only redeploys when files in its `paths:` filter change. **Shared modules must be listed explicitly** — otherwise a change to the shared library lands on `main` but Cloud Run keeps running the old code.

Same pattern applies to every deploy workflow that builds a worker importing from `workers/shared/`:
- `uk_aq_db_r2_metrics_api_worker_deploy.yml` (also imports `uk_aq_r2_history_index.mjs`)
- `uk_aq_db_size_logger_cloud_run_deploy.yml`
- `uk_aq_observs_partition_maintenance_cloud_run_deploy.yml`
- `uk_aq_postcode_lookup_r2_api_worker_deploy.yml`
- `uk_aq_supabase_db_dump_backup_service_deploy.yml`

If you add a new worker that imports from `workers/shared/`, add each imported file to that worker's deploy `paths:` filter. Don't use a wildcard (`workers/shared/**`) — it causes spurious deploys when unrelated shared modules change.

## Layout

Dropbox root (example):

- `CIC-Test/R2_history_backup`

Mirrored v1 domain paths:

- `history/v1/observations/day_utc=YYYY-MM-DD/...`
- `history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/...`
- `history/v1/core/day_utc=YYYY-MM-DD/...`

Mirrored v2 domain paths:

- `history/v2/observations/day_utc=YYYY-MM-DD/...`
- `history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/...`
- `history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/...`
- `history/v2/core/day_utc=YYYY-MM-DD/...`

Operational Phase B run manifests are written outside the Dropbox backup domains. With `UK_AQ_R2_HISTORY_WRITE_VERSION=v2`, prune Phase B writes run manifests under `history/v2/_ops/observations/runs/run_id=<run_id>/run_manifest.json`. Dropbox run-manifest backup is intentionally not included here and is a separate follow-up.

Mirrored v1 derived index files:

- `history/_index/observations_latest.json`
- `history/_index/aqilevels_latest.json`
- `history/_index/observations_timeseries_latest.json`
- `history/_index/aqilevels_timeseries_latest.json`
- `history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
- `history/_index/aqilevels_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`

Mirrored v2 derived index files:

- `history/_index_v2/observations_timeseries_latest.json`
- `history/_index_v2/aqilevels_hourly_data_timeseries_latest.json`
- `history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
- `history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

Checkpoint paths:

- `_ops/checkpoints/r2_history_backup_state_v1.json`
- `_ops/checkpoints/r2_history_backup_state_v2.json`

Final checkpoint object location examples:

- `CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v1.json`
- `CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2.json`

The inventory itself lives in R2 only and is **not** mirrored into Dropbox (control metadata, not a backup unit).

## Checkpoint shape

The checkpoint records, per backup unit, what was last successfully copied to Dropbox. Old checkpoints (day entries only) continue to work; the new sections are populated on the first inventory-driven run.

```json
{
  "version": 1,
  "created_at": "...",
  "updated_at": "...",
  "domains": {
    "observations": {
      "days": { "2026-05-10": { "manifest_key": "...", "copied_at": "...", "manifest_hash": "..." } },
      "last_successful_day_utc": "2026-05-10",
      "last_successful_copy_at": "..."
    },
    "aqilevels": {...},
    "core": {...}
  },
  "index_files": {
    "observations_latest": { "relative_path": "...", "copied_at": "...", "hash": "...", "size": N }
  },
  "index_tree_units": {
    "observations_timeseries": {
      "units": {
        "day_utc=2026-05-10/connector_id=6/manifest.json": { "relative_path": "...", "copied_at": "...", "hash": "...", "size": N }
      }
    },
    "aqilevels_timeseries": { "units": {...} }
  }
}
```

The checkpoint is rewritten after each successful unit copy so a job interrupted mid-run resumes correctly.

## Scripts

### Builder — `scripts/backup_r2/build_backup_inventory.mjs`

Builds or updates the selected inventory:

- v1: `history/_index/backup_inventory_v1.json`
- v2: `history/_index_v2/backup_inventory_v2.json`

CLI:

```text
--source-root <rclone-source-root>   required (e.g. uk_aq_r2:uk-aq-history-cic-test)
--backup-version <v1|v2>             optional override
--inventory-rel-path <path>          optional override; default is version-specific
--domain <name>                      observations | aqilevels | aqilevels_debug | core
--index-prefix <prefix>              default history/_index
--index-v2-prefix <prefix>           default history/_index_v2
--rclone-bin <name>                  default rclone
--report-out <file>                  write JSON report to file
--dry-run                            build/validate only; do not upload
--full-rebuild                       ignore previous inventory; re-read every manifest
--show-version                       print resolved backup config and exit
```

Behaviour:

1. Loads the previous inventory from R2 (skipped on `--full-rebuild` or first run; any unreadable previous inventory is silently treated as "no previous").
2. For each selected domain, `rclone lsjson --recursive` enumerates every `day_utc=*/manifest.json`. For each: if etag+size matches the previous inventory entry, reuse verbatim; otherwise `rclone cat` it, SHA-256 the bytes, extract `file_count`/`total_bytes`/`source_row_count`.
3. In v1 mode, scans v1 `*_latest.json` index files and v1 per-`(day, connector)` index manifests only.
4. In v2 mode, scans `_index_v2/*_latest.json` files and v2 per-`(day, connector, pollutant)` index manifests only.
5. Writes deterministic JSON, uploads via `rclone copyto` from a temp file unless `--dry-run`.
6. Defensive guard: the inventory's own path is excluded from all scans so it can never include itself.
7. In v2 mode, reports any selected v2 domain with zero day manifests under `backup_warnings` and `missing_domain_prefixes`; it does not silently fall back to v1 core.

### Sync — `scripts/backup_r2/sync_history_to_dropbox.mjs`

Mirrors only the entries whose inventory hash differs from the Dropbox checkpoint hash.

CLI:

```text
--source-root <root>           required
--dest-root <root>             required
--backup-version <v1|v2>       optional override
--inventory-rel-path <path>    optional override; default is version-specific
--state-rel-path <path>        optional override; default is version-specific
--domain <name>                observations | aqilevels | aqilevels_debug | core
--max-days-per-run <N>         safety throttle on day copies; 0 = unlimited
--rclone-bin <name>            default rclone
--report-out <file>            write JSON report to file
--dry-run                      plan only; no copies, no checkpoint writes
--show-version                 print resolved backup config and exit
```

Behaviour:

1. Loads the inventory via strict reader. Missing / empty / invalid JSON / wrong kind / wrong version → exit non-zero with an actionable error ending in "re-run scripts/backup_r2/build_backup_inventory.mjs --source-root <root> to regenerate it."
2. Loads the Dropbox checkpoint (creates an empty one if absent; accepts old shapes without the new index sections).
3. **Plan days** per domain: for each day in inventory, compare `manifest_hash` against checkpoint's stored hash. Mismatch → queue. Apply `--max-days-per-run` per domain.
4. **Plan index files**: same hash compare for the selected version's index latest files.
5. **Plan index tree units**: same hash compare for the selected version's index tree manifests.
6. **Copy** queued units (`rclone copy` for day folders, `rclone copyto` for single files). Dropbox `too_many_write_operations` responses are retried with exponential backoff before the unit is treated as failed. On each successful copy, update the checkpoint section and rewrite the checkpoint.
7. **No deletion propagation**: units in the checkpoint but absent from the inventory are ignored; nothing is removed from Dropbox.

### Shared library — `scripts/backup_r2/lib/`

- `lib/rclone.mjs` — rclone wrappers (`runRclone`, `runRcloneWithRetry`, `rcloneCatMaybe`, `rcloneCat`, `rcloneLsjsonRecursive`, `rcloneLsjsonFile`, `uploadFromTempFile`), `sha256Hex`, `joinTargetPath`, `normalizePrefix`. Single source of truth for shell invocation shape and not-found detection.
- `lib/inventory.mjs` — schema constants, version selectors, version-specific default inventory/checkpoint paths, and `loadInventory(rcloneBin, sourceRoot, relPath, { strict })`. `strict: true` is used by sync (fails loudly); `strict: false` is used by the builder when reading the previous inventory.

## Workflows

Daily backup (build inventory + sync):

- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`
- Runs the builder step (writes/refreshes the inventory) followed by the sync step in the same job, sharing the rclone config.
- Intended schedule: `04:35 UTC` daily via external Cloudflare Worker scheduler (`workflow_dispatch`). Previous GitHub cron: `35 4 * * *`.
- `timeout-minutes: 120`.
- Workflow dispatch inputs:
  - `dry_run` — passes `--dry-run` to the sync (the builder still runs and writes the inventory; the inventory is small idempotent control metadata, and the sync's dry-run plan needs a fresh inventory to be accurate).
  - `max_days_per_run` — overrides the `UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN` cap on the sync's day-folder copies.

Initial build (manual, build-only):

- `.github/workflows/uk_aq_r2_initial_build_inventory.yml`
- Manual `workflow_dispatch` only — no cron.
- Runs **only** the builder step (no sync, no Dropbox config).
- `timeout-minutes: 240` to comfortably cover a cold first-build on a large bucket (e.g. LIVE bootstrap).
- Workflow dispatch inputs:
  - `full_rebuild` — passes `--full-rebuild` to ignore the previous inventory and re-read every manifest.
- Use this for the LIVE bootstrap (run it once, then rely on the daily workflow), or as a recovery tool if the inventory ever goes missing/invalid.
- Shares the same concurrency group as the daily backup so the two can't race.

Restore workflow (manual):

- `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml`

Core snapshot workflow (R2 write):

- `.github/workflows/uk_aq_r2_core_snapshot.yml`
- intended schedule: `04:15 UTC` daily via external Cloudflare Worker scheduler
- previous GitHub cron: `15 4 * * *` (UTC)
- script: `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- output per day:
  - `history/v1/core/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/core/day_utc=YYYY-MM-DD/checksums.sha256`
  - `history/v1/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz`

## Required GitHub values

Secrets:

- `CFLARE_R2_ACCESS_KEY_ID`
- `CFLARE_R2_SECRET_ACCESS_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Variables:

- `CFLARE_R2_ENDPOINT`
- `CFLARE_R2_BUCKET`
- `CFLARE_R2_REGION` (default `auto`)
- `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` (default `history/v1/observations`)
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels/hourly`)
- `UK_AQ_R2_HISTORY_CORE_PREFIX` (default `history/v1/core`)
- `UK_AQ_R2_HISTORY_WRITE_VERSION` (default `v1`)
- `UK_AQ_R2_HISTORY_BACKUP_VERSION` (optional override; blank follows write version)
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX` (default `history/v2/observations`)
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX` (default `history/v2/aqilevels/hourly/data`)
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX` (default `history/v2/aqilevels/hourly/debug`)
- `UK_AQ_R2_HISTORY_V2_CORE_PREFIX` (default `history/v2/core`)
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)
- `UK_AQ_R2_HISTORY_INDEX_V2_PREFIX` (default `history/_index_v2`)
- `UK_AQ_DROPBOX_ROOT` (default `CIC-Test`)
- `UK_AQ_R2_HISTORY_DROPBOX_DIR` (default `R2_history_backup`)
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH` (optional override; default is version-specific)
- `UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH` (optional override; default is version-specific)
- `UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN` (default `0` = unlimited)

Effective backup root:

- `{UK_AQ_DROPBOX_ROOT}/{UK_AQ_R2_HISTORY_DROPBOX_DIR}`

Dropbox app-folder note:

- For sandbox/app-folder tokens, keep `UK_AQ_DROPBOX_ROOT` without a leading slash.
- Example: `CIC-Test` (not `/CIC-Test`).

## Local runs

Build the inventory:

```bash
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --report-out ./tmp/r2_backup_inventory_report.json
```

Show which backup version and default paths will be selected from env:

```bash
node scripts/backup_r2/build_backup_inventory.mjs --show-version
node scripts/backup_r2/sync_history_to_dropbox.mjs --show-version
```

Build the CIC-Test v2 inventory:

```bash
UK_AQ_R2_HISTORY_BACKUP_VERSION=v2 \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --report-out ./tmp/r2_backup_inventory_v2_report.json
```

Sync CIC-Test v2 to Dropbox:

```bash
UK_AQ_R2_HISTORY_BACKUP_VERSION=v2 \
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --dest-root "uk_aq_dropbox:CIC-Test/R2_history_backup" \
  --report-out ./tmp/r2_history_dropbox_backup_v2_report.json
```

Verify the v2 active backup inventory exists:

```bash
rclone lsjson "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index_v2/backup_inventory_v2.json"
rclone lsjson "uk_aq_dropbox:CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2.json"
```

Verify the v1 backup still exists:

```bash
rclone lsjson "uk_aq_r2:${CFLARE_R2_BUCKET}/history/_index/backup_inventory_v1.json"
rclone lsjson "uk_aq_dropbox:CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v1.json"
```

Report total v2 Dropbox storage size:

```bash
rclone size "uk_aq_dropbox:CIC-Test/R2_history_backup/history/v2"
rclone size "uk_aq_dropbox:CIC-Test/R2_history_backup/history/_index_v2"
```

Then sync to Dropbox:

```bash
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --dest-root "uk_aq_dropbox:CIC-Test/R2_history_backup" \
  --report-out ./tmp/r2_history_dropbox_backup_report.json
```

Dry-run variants pass `--dry-run` to either or both. The builder's `--dry-run` validates the scan but does not upload the inventory; the sync's `--dry-run` plans copies (and runs `rclone --dry-run`) but does not update the checkpoint.

Force a full rebuild of the inventory (ignore the previous one, re-read every manifest):

```bash
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2:${CFLARE_R2_BUCKET}" \
  --full-rebuild
```

## Operational behaviour

### `max_days_per_run`

Per-domain safety throttle applied to the *day-folder* copy queue. Index files and timeseries-tree units are not throttled — they're small and few.

- `1` = copy at most one day per domain (`observations`, `aqilevels`, `core`) per run.
- `0` = unlimited.

Practical effect:

- Running with `max_days_per_run=1` repeatedly will only copy a day when there's a queue. If everything is already in Dropbox, `copied_days=0`.

Recommended rollout:

1. First validation run: `dry_run=true`, `max_days_per_run=3`.
2. First write run: `dry_run=false`, `max_days_per_run=1`.
3. Catch-up runs: `dry_run=false`, `max_days_per_run=7` or `14` if runtime is comfortably below the timeout.
4. Steady-state daily: `dry_run=false`, `max_days_per_run=0`.

### Report fields — builder

Builder writes a JSON report to `--report-out` (also echoed to stdout).

| Field | Meaning |
|---|---|
| `first_build` | `true` if there was no previous inventory in R2 |
| `full_rebuild` | `true` if `--full-rebuild` forced a re-read |
| `inventory_hash` | SHA-256 of the deterministic JSON inventory just written |
| `inventory_size` | Bytes |
| `manifests_listed` | Day manifests R2 LIST returned |
| `manifests_reread` | Day manifests that needed a fresh `rclone cat` (skip miss) |
| `manifest_reuse_rate` | `1 - manifests_reread / manifests_listed` (day-manifest skip-hit rate; null if listed=0) |
| `reread_new_or_changed` | Total re-reads (across all categories) where the previous inventory entry didn't exist or its signal didn't match. Zero when `--full-rebuild` is set. |
| `reread_full_rebuild` | Total re-reads (across all categories) forced by the `--full-rebuild` flag. Zero when the flag is not set. |
| `index_files_listed/reread/skipped/missing` | Per-category counters for the four `*_latest.json` files |
| `index_tree_units_listed/reread/skipped` | Per-category counters for per-`(day, connector)` tree units |
| `r2_md5_available_count` | LSJSON entries (across all categories) whose `Hashes.md5` was present — the strong-signal skip path |
| `r2_md5_missing_count` | LSJSON entries with no `Hashes.md5` — those entries fall back to Size + ModTime for skip decisions |
| `r2_md5_metadata_available` | `true` iff every entry had MD5 (i.e. `r2_md5_missing_count == 0`) |
| `reuse_by_r2_md5_size` | Skip-hits (across all categories) decided by Size + MD5 match (the strong path) |
| `reuse_by_size_modtime` | Skip-hits decided by Size + ModTime fallback (only when MD5 was missing on either side) |
| `metadata_warnings` | Human-readable warnings — non-empty if `r2_md5_missing_count > 0` |
| `elapsed_ms.{days,index_files,index_trees,total}` | Per-phase timings |
| `summary.domain_day_count` | Total days per domain currently in inventory |

> Total reuse hits across all categories = `reuse_by_r2_md5_size + reuse_by_size_modtime`. There's no separate aggregate counter — sum the two if you need it.

### Report fields — sync

| Field | Meaning |
|---|---|
| `inventory_used` | Always `true` (the legacy direct-scan path was removed) |
| `inventory_generated_at` | From the inventory file |
| `domains.<name>` | `{ listed_days, candidate_days, copied_days, skipped_unchanged, skipped_by_limit, copied_day_list }` |
| `index_files.<key>` | `{ relative_path, copied }` for each index file queued this run |
| `index_tree_units.<treeKey>.copied_units` | List of tree unit keys copied this run |
| `totals` | Aggregated counts including `index_files_copied`, `index_tree_units_copied` |
| `state_existed` | `true` if a checkpoint already existed in Dropbox |

### Interpreting a "no new copy" run

After the first inventory-driven run, steady-state daily runs should look like:

- `inventory_used: true`
- `totals.copied_days: 0`
- `totals.skipped_unchanged ≈ totals.listed_days` (all days match the checkpoint)
- `totals.index_files_copied: 0`
- `totals.index_tree_units_copied: 0`

If a day was rewritten in R2 between runs, you'll see `copied_days >= 1` and the corresponding `manifest_hash` updated in the checkpoint.

## Recovery / failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Sync exits with "inventory not found at ..." | No inventory in R2 yet, or path mismatch | Run the builder, or check `--inventory-rel-path` |
| Sync exits with "inventory is empty (zero bytes)" | A previous upload left a 0-byte placeholder | Run the builder; it overwrites with a fresh upload |
| Sync exits with "inventory has unexpected kind=..." | Wrong file at the inventory path | Move/delete that file, then re-run the builder |
| Sync exits with "inventory has version=..." | Schema bump | Re-run builder (matching version is `1`) |
| Builder report `metadata_warnings` non-empty | rclone/R2 didn't expose MD5 etag for some entries | Etag-skip degraded to ModTime fallback; investigate rclone backend version |
| Builder re-reads thousands of tree units daily despite no source-data change | Upstream `uk_aq_r2_history_index.mjs` deployed without A.3/B idempotency (data-driven `generated_at` + `r2PutObjectIfChanged`) | Re-deploy `uk_aq_prune_daily` Cloud Run with the current shared module; confirm rebuilder result objects include `put_skipped` |
| Sync copies thousands of tree units daily despite no source-data change | Same upstream cause as above (tree-unit bytes changing daily ⇒ checkpoint hash always differs from inventory hash) | Same fix as above |

## Restore (Dropbox → R2 History)

Script:

- `scripts/backup_r2/restore_history_from_dropbox.mjs`

Workflow dispatch inputs:

- `dry_run`:
  - `true` = validate/list/copy-plan only.
  - `false` = write to R2.
- `day_utc`:
  - Optional `YYYY-MM-DD`.
  - If set, restore only that day folder under selected domains.
  - If blank, restore selected full domain prefixes.
- `restore_observations`:
  - Include `history/v1/observations`.
- `restore_aqilevels`:
  - Include `history/v1/aqilevels/hourly`.
- `restore_core`:
  - Include `history/v1/core`.

Recommended first restore run:

1. `dry_run=true`.
2. Set the required domain flags.
3. Set `day_utc` if you want a targeted restore first.

## Outside-retention row-count compare

Script:

- `scripts/backup_r2/uk_aq_history_counts_compare.mjs`

Purpose:

- Compare per-day/per-connector row counts for `observs` and `aqilevels` outside retention windows.
- Sources: ingestdb (`observs`), obs_aqidb (`observs` + `aqilevels`), live R2 history manifests, local Dropbox backup manifests.

Retention cutoffs used (from env):

- `OBS_AQIDB_OBSERVS_RETENTION_DAYS`
- `OBS_AQIDB_AQILEVELS_RETENTION_DAYS`

Run (JSON):

```bash
node scripts/backup_r2/uk_aq_history_counts_compare.mjs --format json
```

Run all complete days (not just outside retention):

```bash
node scripts/backup_r2/uk_aq_history_counts_compare.mjs \
  --format json \
  --scope all-complete
```

Run (CSV, mismatches only):

```bash
node scripts/backup_r2/uk_aq_history_counts_compare.mjs \
  --format csv \
  --only-mismatch \
  --out ./logs/history-counts-mismatch.csv
```

## Sensor.Community exact archive reconciliation

Script:

- `scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs`

Purpose:

- Compare Sensor.Community daily archive CSV rows to local `history/v1/observations` parquet rows exactly, not just by daily totals.
- Uses the local R2 core `timeseries` snapshot to map archive rows into the same logical `timeseries_ref` keys used by history.
- Compares row multisets on `timeseries_ref`, `observed_at`, `value`.
- Reports exact match / not exact match, missing rows, unexpected rows, mismatch samples, per-pollutant counts.

Important caveat:

- Reconciles against local observations history parquet under the Dropbox backup root, not directly against live Obs AQI DB rows.
- Exact comparison is only as complete as the core snapshot bindings used for the day.

Run a whole-day check:

```bash
node scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs \
  --day 2026-02-16
```

Run JSON output and save it:

```bash
node scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs \
  --day 2026-02-16 \
  --format json \
  --out ./logs/scomm-reconcile-2026-02-16.json
```

Run a single-station check:

```bash
node scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs \
  --day 2026-02-16 \
  --station-ref 33987
```
