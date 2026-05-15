# UK AQ R2 History Dropbox Backup

This document describes the daily incremental backup from Cloudflare R2 History to Dropbox.

For the canonical R2 object tree and manifest/index payload shapes, see `system_docs/uk-aq-r2-history-layout.md`.

## Purpose

- Mirror committed R2 History day folders (and the derived index files used by the history fast paths) into Dropbox.
- Detect any old R2 day whose manifest has been rewritten and re-copy it — the system never assumes old days are immutable.
- Avoid reading every old day's manifest on every backup run. Steady-state runs are near-instant.

## Architecture

The backup is a **two-step pipeline** built around an R2-side inventory file.

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
```

## Inventory file

Location:

- R2: `history/_index/backup_inventory_v1.json` (one per bucket — CIC-Test and LIVE are separate)

Shape (abbreviated):

```json
{
  "version": 1,
  "kind": "uk_aq_r2_history_backup_inventory",
  "generated_at": "2026-05-15T12:00:00.000Z",
  "source": { "index_prefix": "history/_index", "domain_prefixes": {...} },
  "domains": {
    "observations": {
      "days": {
        "2026-05-10": {
          "unit_type": "day_folder",
          "relative_path": "history/v1/observations/day_utc=2026-05-10",
          "manifest_relative_path": "history/v1/observations/day_utc=2026-05-10/manifest.json",
          "manifest_hash": "<sha256 of manifest bytes>",
          "manifest_size": 12345,
          "r2_etag": "<R2 MD5 etag>",
          "r2_modtime": "...",
          "file_count": 1,
          "total_bytes": 79927,
          "source_row_count": 17151
        }
      }
    },
    "aqilevels": { "days": {...} },
    "core": { "days": {...} }
  },
  "index_files": {
    "observations_latest": { "unit_type": "file", "relative_path": "...", "hash": "...", "size": N, "r2_etag": "...", "r2_modtime": "..." },
    "aqilevels_latest": {...},
    "observations_timeseries_latest": {...},
    "aqilevels_timeseries_latest": {...}
  },
  "index_tree_units": {
    "observations_timeseries": {
      "units": {
        "day_utc=2026-05-10/connector_id=6/manifest.json": { "unit_type": "file", "relative_path": "...", "hash": "...", ... }
      }
    },
    "aqilevels_timeseries": { "units": {...} }
  },
  "summary": { "domain_day_count": {...}, "index_file_count": 4, "index_tree_unit_count": {...} }
}
```

Hashes are SHA-256 of the exact JSON bytes as read from R2 — the same hash format the Dropbox checkpoint already records, so no migration was needed. The `r2_etag` + `r2_modtime` + size fields are kept so the next builder run can do its etag-skip comparison without re-reading every manifest.

The JSON is written with deterministic key ordering (alphabetical at every level).

### Etag-skip mechanism

For every R2 file the builder considers, it extracts `Size` and `Hashes.MD5` from `rclone lsjson` and compares against the previous inventory entry's stored values. If they match, the entry is reused verbatim — the manifest is not re-read.

R2 normally exposes a real MD5 etag for single-part uploads, which is the strong case. If MD5 is missing (rclone backend quirk or multipart-style etag on a large file), the builder falls back to `Size + ModTime` and reports it under `metadata_warnings`. Modtime in R2 reflects upload time so it does change on rewrites, but it is weaker than MD5.

The first build is unavoidably slow (full scan of every manifest). Steady-state runs are near-instant.

## Layout

Dropbox root (example):

- `CIC-Test/R2_history_backup`

Mirrored domain paths:

- `history/v1/observations/day_utc=YYYY-MM-DD/...`
- `history/v1/aqilevels/day_utc=YYYY-MM-DD/...`
- `history/v1/core/day_utc=YYYY-MM-DD/...`

Mirrored derived index files:

- `history/_index/observations_latest.json`
- `history/_index/aqilevels_latest.json`
- `history/_index/observations_timeseries_latest.json`
- `history/_index/aqilevels_timeseries_latest.json`
- `history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
- `history/_index/aqilevels_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`

Checkpoint path (default):

- `_ops/checkpoints/r2_history_backup_state_v1.json`

Final checkpoint object location example:

- `CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v1.json`

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

Builds or updates `history/_index/backup_inventory_v1.json`.

CLI:

```text
--source-root <rclone-source-root>   required (e.g. uk_aq_r2:uk-aq-history-cic-test)
--inventory-rel-path <path>          default history/_index/backup_inventory_v1.json
--domain <name>                      observations | aqilevels | core (repeatable; default all)
--index-prefix <prefix>              default history/_index
--rclone-bin <name>                  default rclone
--report-out <file>                  write JSON report to file
--dry-run                            build/validate only; do not upload
--full-rebuild                       ignore previous inventory; re-read every manifest
```

Behaviour:

1. Loads the previous inventory from R2 (skipped on `--full-rebuild` or first run; any unreadable previous inventory is silently treated as "no previous").
2. For each selected domain, `rclone lsjson --recursive` enumerates every `day_utc=*/manifest.json`. For each: if etag+size matches the previous inventory entry, reuse verbatim; otherwise `rclone cat` it, SHA-256 the bytes, extract `file_count`/`total_bytes`/`source_row_count`.
3. Same etag-skip pattern for the four `*_latest.json` index files.
4. Same etag-skip pattern for per-`(day, connector)` manifests under `history/_index/observations_timeseries/` and `history/_index/aqilevels_timeseries/`.
5. Writes deterministic JSON, uploads via `rclone copyto` from a temp file unless `--dry-run`.
6. Defensive guard: the inventory's own path is excluded from all scans so it can never include itself.

### Sync — `scripts/backup_r2/sync_history_to_dropbox.mjs`

Mirrors only the entries whose inventory hash differs from the Dropbox checkpoint hash.

CLI:

```text
--source-root <root>           required
--dest-root <root>             required
--inventory-rel-path <path>    default history/_index/backup_inventory_v1.json
--state-rel-path <path>        default _ops/checkpoints/r2_history_backup_state_v1.json
--domain <name>                observations | aqilevels | core (repeatable; default all)
--max-days-per-run <N>         safety throttle on day copies; 0 = unlimited
--rclone-bin <name>            default rclone
--report-out <file>            write JSON report to file
--dry-run                      plan only; no copies, no checkpoint writes
```

Behaviour:

1. Loads the inventory via strict reader. Missing / empty / invalid JSON / wrong kind / wrong version → exit non-zero with an actionable error ending in "re-run scripts/backup_r2/build_backup_inventory.mjs --source-root <root> to regenerate it."
2. Loads the Dropbox checkpoint (creates an empty one if absent; accepts old shapes without the new index sections).
3. **Plan days** per domain: for each day in inventory, compare `manifest_hash` against checkpoint's stored hash. Mismatch → queue. Apply `--max-days-per-run` per domain.
4. **Plan index files**: same hash compare for each of the four `*_latest.json` files.
5. **Plan index tree units**: same hash compare for each per-`(day, connector)` manifest.
6. **Copy** queued units (`rclone copy` for day folders, `rclone copyto` for single files). On each successful copy, update the checkpoint section and rewrite the checkpoint.
7. **No deletion propagation**: units in the checkpoint but absent from the inventory are ignored; nothing is removed from Dropbox.

### Shared library — `scripts/backup_r2/lib/`

- `lib/rclone.mjs` — rclone wrappers (`runRclone`, `rcloneCatMaybe`, `rcloneCat`, `rcloneLsjsonRecursive`, `rcloneLsjsonFile`, `uploadFromTempFile`), `sha256Hex`, `joinTargetPath`, `normalizePrefix`. Single source of truth for shell invocation shape and not-found detection.
- `lib/inventory.mjs` — schema constants (`INVENTORY_SCHEMA_VERSION`, `INVENTORY_KIND`, `DOMAIN_NAMES`, `INDEX_FILE_KEYS`, `INDEX_TREE_KEYS`, `DEFAULT_INVENTORY_REL_PATH`) and `loadInventory(rcloneBin, sourceRoot, relPath, { strict })`. `strict: true` is used by sync (fails loudly); `strict: false` is used by the builder when reading the previous inventory.

## Workflow

GitHub workflow:

- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`

Restore workflow (manual):

- `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml`

Intended schedule:

- `04:35 UTC` daily via external Cloudflare Worker scheduler (`workflow_dispatch`).
- Previous GitHub cron: `35 4 * * *` (UTC).

Core snapshot workflow (R2 write):

- `.github/workflows/uk_aq_r2_core_snapshot.yml`
- intended schedule: `04:15 UTC` daily via external Cloudflare Worker scheduler
- previous GitHub cron: `15 4 * * *` (UTC)
- script: `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- output per day:
  - `history/v1/core/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/core/day_utc=YYYY-MM-DD/checksums.sha256`
  - `history/v1/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz`

> **Workflow update pending.** The workflow still invokes only `sync_history_to_dropbox.mjs`. Until a builder step is added (a separate scheduled task), the sync step will fail with the "inventory not found" error unless the inventory has been built recently by hand. Plan: add a `node scripts/backup_r2/build_backup_inventory.mjs --source-root ...` step immediately before the sync step, sharing the same job and rclone config.

Workflow dispatch inputs:

- `dry_run` — passes `--dry-run` to the sync (still triggers the build step).
- `max_days_per_run` — overrides the `UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN` cap.

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
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` (default `history/v1/aqilevels`)
- `UK_AQ_R2_HISTORY_CORE_PREFIX` (default `history/v1/core`)
- `UK_AQ_R2_HISTORY_INDEX_PREFIX` (default `history/_index`)
- `UK_AQ_DROPBOX_ROOT` (default `CIC-Test`)
- `UK_AQ_R2_HISTORY_DROPBOX_DIR` (default `R2_history_backup`)
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH` (default `_ops/checkpoints/r2_history_backup_state_v1.json`)
- `UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH` (optional override; default `history/_index/backup_inventory_v1.json`)
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
| `manifests_reread` | Manifests that needed a fresh `rclone cat` (etag-skip miss) |
| `etag_skip_hits` | Manifests reused verbatim from the previous inventory |
| `etag_skip_rate` | `1 - manifests_reread/manifests_listed` |
| `etag_metadata_available` | `true` only when every entry had a real MD5 etag |
| `metadata_source_counts` | Breakdown: `etag_md5`, `modtime_fallback`, `size_only`, `missing` |
| `metadata_warnings` | Human-readable warnings if any non-MD5 fallbacks happened |
| `index_files_listed/reread/skipped/missing` | Same as manifests, for the four `*_latest.json` files |
| `index_tree_units_listed/reread/skipped` | Same as manifests, for per-`(day, connector)` tree units |
| `elapsed_ms.{days,index_files,index_trees,total}` | Per-phase timings |
| `summary.domain_day_count` | Total days per domain currently in inventory |

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
  - Include `history/v1/aqilevels`.
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
