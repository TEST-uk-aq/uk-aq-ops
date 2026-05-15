# R2 History Dropbox Backup Inventory Plan

Repo: `https://github.com/ChronicChannel-test/uk-aq-ops`  
Target repo path for Claude Code: `/workspaces/uk-aq-ops`

## Goal

Implement the proper fix for slow Dropbox backup runs by adding a compact R2-side backup inventory:

```text
history/_index/backup_inventory_v1.json
```

The Dropbox backup workflow should read this one inventory file, compare its hashes with the Dropbox checkpoint state, and only copy R2 History days/index objects that are new or changed.

This preserves the important rule:

> Any existing historical day in R2 may be updated later, so the backup must still detect changed old days.

But it avoids the current slow behaviour:

> Reading every old day-level `manifest.json` from R2 on every backup run just to decide that most days are unchanged.

## Current problem summary

The current backup script is:

```text
scripts/backup_r2/sync_history_to_dropbox.mjs
```

It already has a checkpoint file in Dropbox:

```text
_ops/checkpoints/r2_history_backup_state_v1.json
```

For day domains such as:

```text
history/v1/observations/day_utc=YYYY-MM-DD/
history/v1/aqilevels/day_utc=YYYY-MM-DD/
history/v1/core/day_utc=YYYY-MM-DD/
```

it lists all committed day folders. For a day that already exists in the checkpoint, it reads the R2 source day manifest with `rclone cat`, hashes it, and compares it with the checkpoint hash.

That keeps correctness, but it becomes slow when there are 1,000+ historic days, because unchanged days still require individual remote manifest reads.

The script also copies/checks the timeseries index trees separately:

```text
history/_index/observations_timeseries/
history/_index/aqilevels_timeseries/
```

The current design should be replaced with inventory-driven planning.

## Desired design

Add a generated R2 inventory file:

```text
history/_index/backup_inventory_v1.json
```

The inventory should contain one compact record per backup unit:

- observations day folder
- aqilevels day folder
- core day folder
- latest index JSON files
- timeseries index manifest units

The Dropbox backup should:

1. Read the Dropbox checkpoint state.
2. Read `history/_index/backup_inventory_v1.json` from R2.
3. Compare inventory hashes with checkpoint hashes locally.
4. Queue only changed/missing units for copying.
5. Copy queued units.
6. Update checkpoint state with the inventory hash/metadata actually copied.
7. Fall back safely if the inventory is missing or invalid.

## Decisions

All decisions below are settled — implementation should follow them as written.

### Approach
1. **Inventory file at `history/_index/backup_inventory_v1.json`** in each R2 bucket.
2. **Old days can change** and must still be detected on later runs (no naive "new days only" mode).
3. **Inventory is the only planning source** for sync. Direct manifest scanning at sync time is removed entirely (see decision 9).
4. **Existing checkpoint state stays compatible** for day entries; new sections are added for index files and index-tree units.
5. **Dedicated builder script** at `scripts/backup_r2/build_backup_inventory.mjs`. Existing helpers move to `scripts/backup_r2/lib/` so builder and sync can share them.

### Builder behaviour
6. **Builder uses `rclone lsjson` etag/size to skip unchanged manifests.** First inventory build is slow (full read of every manifest). Subsequent builds compare R2 LIST output (etag + size) against the previous inventory and only re-read manifests whose etag/size changed. This is what makes the overall design faster than today — without etag-skip the cost just shifts from sync to builder.
7. **Hash source: SHA-256 of the exact JSON bytes** as read from R2 (not the manifest's internal `manifest_hash` field). Matches what `sync_history_to_dropbox.mjs:395` already records in the checkpoint, so no migration needed.
8. **Single writer.** Only the backup workflow writes the inventory. Other writers (prune-daily, backfill) do not touch it. No locking required.
9. **No gzip.** Inventory is plain JSON (~5 MB at 1000+ days). Gzipping saves ~500 ms per run but adds content-type/naming/decompression complexity. Revisit if the inventory crosses ~10 MB.

### Workflow timing
10. **Builder + sync run in the same job, sequentially.** Anything written between the two steps is missed that run and picked up next run. Acceptable race window.
11. **Per-environment.** CIC-Test and LIVE each have their own inventory file in their respective R2 buckets, with separate workflows in separate repos and Cloudflare accounts.

### Sync behaviour
12. **Sync requires the inventory.** No auto-fallback to direct scanning. If the inventory is missing or invalid, sync fails loudly with a clear message ("inventory not found at <path>; re-run build_backup_inventory.mjs"). Recovery is one command.
13. **Optional `--no-inventory` debug flag** — builds a fresh inventory in memory without writing to R2, useful when iterating on builder logic. No production fallback semantics.
14. **No deletion propagation.** R2 days are not removed in normal operation; if one is, the corresponding Dropbox copy is left in place.

### Testing scope
15. **Minimal tests.** 3–4 cases covering: unchanged-day-skipped, changed-old-day-copied, new-day-copied, missing-inventory-fails-loudly. Defer broader test scaffolding until the design has settled in CIC-Test.

## Proposed inventory schema

Use a stable JSON schema. Keep it compact but explicit.

Example:

```json
{
  "version": 1,
  "kind": "uk_aq_r2_history_backup_inventory",
  "generated_at": "2026-05-15T12:00:00.000Z",
  "source": {
    "index_prefix": "history/_index",
    "domain_prefixes": {
      "observations": "history/v1/observations",
      "aqilevels": "history/v1/aqilevels",
      "core": "history/v1/core"
    }
  },
  "domains": {
    "observations": {
      "days": {
        "2026-05-10": {
          "unit_type": "day_folder",
          "relative_path": "history/v1/observations/day_utc=2026-05-10",
          "manifest_relative_path": "history/v1/observations/day_utc=2026-05-10/manifest.json",
          "manifest_hash": "sha256hex...",
          "manifest_size": 1234,
          "file_count": 12,
          "total_bytes": 3456789
        }
      }
    },
    "aqilevels": {
      "days": {}
    },
    "core": {
      "days": {}
    }
  },
  "index_files": {
    "observations_latest": {
      "unit_type": "file",
      "relative_path": "history/_index/observations_latest.json",
      "hash": "sha256hex...",
      "size": 1234
    },
    "aqilevels_latest": {
      "unit_type": "file",
      "relative_path": "history/_index/aqilevels_latest.json",
      "hash": "sha256hex...",
      "size": 1234
    },
    "observations_timeseries_latest": {
      "unit_type": "file",
      "relative_path": "history/_index/observations_timeseries_latest.json",
      "hash": "sha256hex...",
      "size": 1234
    },
    "aqilevels_timeseries_latest": {
      "unit_type": "file",
      "relative_path": "history/_index/aqilevels_timeseries_latest.json",
      "hash": "sha256hex...",
      "size": 1234
    }
  },
  "index_tree_units": {
    "observations_timeseries": {
      "units": {
        "day_utc=2026-05-10/connector_id=6/manifest.json": {
          "unit_type": "file",
          "relative_path": "history/_index/observations_timeseries/day_utc=2026-05-10/connector_id=6/manifest.json",
          "hash": "sha256hex...",
          "size": 1234
        }
      }
    },
    "aqilevels_timeseries": {
      "units": {}
    }
  },
  "summary": {
    "domain_day_count": {
      "observations": 0,
      "aqilevels": 0,
      "core": 0
    },
    "index_file_count": 4,
    "index_tree_unit_count": {
      "observations_timeseries": 0,
      "aqilevels_timeseries": 0
    }
  }
}
```

### Notes on hashes

- Use SHA-256 hex of the exact manifest/index JSON bytes as read from R2.
- For day folders, the backup unit hash should be the day-level `manifest.json` hash.
- For index files, the backup unit hash should be the index JSON file hash.
- For index tree units, use the per-unit `manifest.json` hash if the tree contains manifest files.
- Do not hash whole folders by listing every data object unless there is no manifest available.

## Checkpoint state changes

Preserve existing checkpoint compatibility.

Current day checkpoint entries look roughly like:

```json
{
  "manifest_key": "history/v1/observations/day_utc=2026-05-10/manifest.json",
  "copied_at": "2026-05-15T12:00:00.000Z",
  "manifest_hash": "sha256hex..."
}
```

Keep that shape for day entries.

Add or extend sections for:

```json
{
  "index_files": {},
  "index_tree_units": {}
}
```

Suggested checkpoint entry shape:

```json
{
  "relative_path": "history/_index/observations_latest.json",
  "copied_at": "2026-05-15T12:00:00.000Z",
  "hash": "sha256hex...",
  "size": 1234
}
```

## Implementation plan

### Phase 1 — Add inventory builder

Create:

```text
scripts/backup_r2/build_backup_inventory.mjs
```

CLI:

```bash
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root uk_aq_r2:uk-aq-history-cic-test \
  --inventory-rel-path history/_index/backup_inventory_v1.json \
  --report-out artifacts/r2-backup-inventory-report.json
```

Required flags:

```text
--source-root
```

Optional flags:

```text
--inventory-rel-path default history/_index/backup_inventory_v1.json
--domain observations|aqilevels|core repeatable
--index-prefix default history/_index
--rclone-bin default rclone
--report-out optional
--dry-run build/validate/report only, do not upload inventory
--full-rebuild ignore previous inventory; re-read every manifest from R2
```

Builder behaviour:

1. Read the previous inventory from R2 (if present) into memory as the etag/size baseline.
2. For each selected domain, run `rclone lsjson` to enumerate day manifests and capture their etag + size from R2 LIST output.
3. For each manifest, compare etag+size against the previous inventory:
   - Match → reuse the previous inventory entry verbatim (no re-read).
   - Differ or new → `rclone cat` the manifest, hash the bytes, extract useful metadata (file count, total bytes, connector count, row count, etc.).
4. `--full-rebuild` skips step 1 and forces re-read of every manifest.
5. Repeat the etag-skip pattern for latest index files.
6. Repeat for timeseries index tree manifest files (per-connector-day units).
7. Write deterministic JSON with stable key ordering.
8. Upload to `history/_index/backup_inventory_v1.json` unless `--dry-run`.
9. Emit a report with counts, etag-skip hit-rate, and per-phase timings.

The first build is unavoidably slow (full scan of every manifest). All subsequent builds should be near-instant for unchanged manifests and only pay the read cost for changed/new ones — this is what makes the overall design faster than today's sync.

### Phase 2 — Update Dropbox backup sync to use inventory

Modify:

```text
scripts/backup_r2/sync_history_to_dropbox.mjs
```

**Remove** the existing direct-manifest-scan planning code paths entirely (lines that `rclone cat` each day's manifest, hash it, and compare against the checkpoint). Sync becomes pure inventory-driven.

Add flag:

```text
--inventory-rel-path history/_index/backup_inventory_v1.json
--no-inventory                debug only — builds a fresh inventory in memory
                              without writing to R2; no production fallback
                              semantics
```

Move shared helpers (rclone wrappers, hash function, checkpoint I/O) to `scripts/backup_r2/lib/` so both builder and sync can use them.

Planning behaviour:

1. Read the R2 inventory. If missing, invalid JSON, or schema-version mismatch: **fail loudly** with a clear message ("inventory not found at <path>; re-run build_backup_inventory.mjs") and exit non-zero.
2. Use inventory as the sole source of truth.
3. Compare inventory day hashes against checkpoint day hashes. Queue only missing/changed days.
4. Compare inventory latest index file hashes against checkpoint index file hashes. Queue only missing/changed.
5. Compare inventory timeseries index tree unit hashes against checkpoint unit hashes. Queue only missing/changed.
6. Copy queued units.
7. Update checkpoint entries (day, index_files, index_tree_units) from inventory metadata after successful copy.
8. Preserve compatibility with existing checkpoint files that only have day entries (new index_files / index_tree_units sections are added on first run).
9. **Do not delete from Dropbox** when a day disappears from R2 (decision 14).

No fallback to direct scan. If the workflow's builder step failed, the sync step fails too — they share a job. Recovery is re-running the builder.

### Phase 3 — Stop blindly copying timeseries index trees

Replace the current whole-tree index copy behaviour with inventory-driven file copy.

Current problematic units:

```text
history/_index/observations_timeseries/
history/_index/aqilevels_timeseries/
```

New behaviour:

- The inventory lists per-manifest units under those trees.
- The backup compares each unit hash with checkpoint state.
- Only changed/missing index-tree manifests are copied.

If there are non-manifest files inside those trees that are required, Claude Code should include them in the inventory as file units too.

### Phase 4 — Add workflow step

Find the GitHub Actions workflow that runs the Dropbox backup.

Add a step before the Dropbox sync:

```bash
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "$SOURCE_ROOT" \
  --inventory-rel-path history/_index/backup_inventory_v1.json \
  --report-out artifacts/r2-backup-inventory-report.json
```

Then run sync normally, now inventory-driven:

```bash
node scripts/backup_r2/sync_history_to_dropbox.mjs \
  --source-root "$SOURCE_ROOT" \
  --dest-root "$DEST_ROOT" \
  --inventory-rel-path history/_index/backup_inventory_v1.json \
  --report-out artifacts/r2-history-dropbox-backup-report.json
```

Make sure both reports are uploaded as workflow artifacts.

### Phase 5 — Add timings and useful logs

Both scripts should report timings for:

```text
load checkpoint
load/build inventory
list manifests
read/hash manifests
plan days
copy days
plan/copy latest index files
plan/copy index tree units
write checkpoint
```

Sync report fields:

```text
inventory_used (always true after this change)
inventory_generated_at
inventory_hash
listed_days  per domain
candidate_days  per domain
copied_days  per domain
skipped_unchanged  per domain
changed_existing_days  per domain
new_days  per domain
index_files_copied
index_tree_units_copied
elapsed_ms per phase
```

Builder report fields (additional):

```text
first_build  true if no previous inventory existed
manifests_listed  total
manifests_reread  changed/new manifests re-read from R2
etag_skip_hits  manifests reused from previous inventory
etag_skip_rate  manifests_reread / manifests_listed
elapsed_ms per phase
```

### Phase 6 — Tests (minimal)

Add only the must-have planning-correctness tests. Defer broader scaffolding until the design has settled in CIC-Test.

1. **Unchanged day skipped** — inventory hash matches checkpoint, day not queued.
2. **Changed old day copied** — inventory hash differs from checkpoint, day queued, checkpoint updated post-copy.
3. **New day copied** — day absent from checkpoint, queued, checkpoint entry created.
4. **Missing inventory fails loudly** — sync exits non-zero with an actionable error message.

## Acceptance criteria

1. A run with 1,000+ historical days no longer reads 1,000+ old day manifests during the Dropbox backup *sync* step (sync reads only the inventory file).
2. The *builder* only re-reads manifests whose R2 etag/size has changed since the previous inventory. Etag-skip hit-rate is reported.
3. When an old day's manifest hash changes in the inventory, sync copies that old day again and updates its checkpoint entry.
4. When old days are unchanged, sync skips them based on inventory-vs-checkpoint hash comparison alone.
5. Timeseries index trees are no longer recopied wholesale; only changed/missing per-unit manifests are queued.
6. The backup report shows `inventory_used: true` for every successful run (fallback path no longer exists).
7. If the inventory is missing or invalid, sync exits non-zero with an actionable message; no silent slow-path execution.
8. Existing checkpoint files (with only `day` entries) continue to work; new sections are populated on first inventory-driven run.

## Claude Code prompt

```text
You are working in the repo at /workspaces/uk-aq-ops.

Task: implement the R2 History Dropbox backup speed fix using a dedicated R2 backup inventory file. All design decisions are settled — see the Decisions section of this plan and follow them as written.

Context:
- Current slow script: scripts/backup_r2/sync_history_to_dropbox.mjs
- Current Dropbox checkpoint state: _ops/checkpoints/r2_history_backup_state_v1.json
- R2 History domains:
  - history/v1/observations/day_utc=YYYY-MM-DD/
  - history/v1/aqilevels/day_utc=YYYY-MM-DD/
  - history/v1/core/day_utc=YYYY-MM-DD/
- Existing index area:
  - history/_index/observations_latest.json
  - history/_index/aqilevels_latest.json
  - history/_index/observations_timeseries_latest.json
  - history/_index/aqilevels_timeseries_latest.json
  - history/_index/observations_timeseries/...
  - history/_index/aqilevels_timeseries/...

Problem:
The current sync reads each old day manifest from R2 and compares its SHA-256 with the Dropbox checkpoint hash. That detects old-day rewrites but makes daily backup runs slow because 1,000+ unchanged days require individual remote reads. The script also handles timeseries index trees too coarsely.

Required design (all locked):
- Add R2 inventory at history/_index/backup_inventory_v1.json (one per bucket).
- Builder uses rclone lsjson etag+size to skip unchanged manifests. Only changed/new manifests are re-read.
- Inventory stores SHA-256 of exact JSON bytes (matches current checkpoint hash format — no migration).
- Sync is pure inventory-driven. No auto-fallback to direct scanning. Direct-scan code is removed.
- Builder + sync run sequentially in the same workflow job.
- Plain JSON inventory (no gzip).
- Single writer (the backup workflow).
- No deletion propagation when R2 days disappear.
- Minimal tests: 3-4 planning-correctness cases plus the missing-inventory failure case.

Important correctness rule:
Any old R2 History day may be updated later. Changed old days must still be detected and refreshed in Dropbox — that's what the inventory hash comparison provides.

Implement the following:

1. Move shared helpers to scripts/backup_r2/lib/ (rclone wrappers, sha256, checkpoint I/O). Both builder and sync import from here.

2. Add scripts/backup_r2/build_backup_inventory.mjs.

   CLI flags:
   - --source-root <rclone-source-root>   required
   - --inventory-rel-path                  default history/_index/backup_inventory_v1.json
   - --domain observations|aqilevels|core  repeatable; default all three
   - --index-prefix                        default history/_index
   - --rclone-bin                          default rclone
   - --report-out                          optional
   - --dry-run                             build/validate only; do not upload
   - --full-rebuild                        ignore previous inventory; re-read every manifest

   Behaviour:
   a. Read previous inventory from R2 (skip if --full-rebuild or first run).
   b. For each domain, rclone lsjson the day folders to get etag+size for every manifest.
   c. For each manifest: if etag+size match the previous inventory entry, reuse it verbatim. Otherwise rclone cat the manifest, SHA-256 the exact bytes, and extract metadata (file_count, total_bytes, etc).
   d. Same etag-skip pattern for the four latest index files and for per-unit manifests under history/_index/observations_timeseries/ and history/_index/aqilevels_timeseries/.
   e. Write deterministic JSON (stable key ordering).
   f. Upload to --inventory-rel-path unless --dry-run.
   g. Emit a report including: domain day counts, etag-skip hit-rate, per-phase elapsed_ms.

3. Modify scripts/backup_r2/sync_history_to_dropbox.mjs:

   - Remove the existing direct-manifest-scan planning code (the rclone-cat-each-manifest loop).
   - Add --inventory-rel-path (default history/_index/backup_inventory_v1.json).
   - Add --no-inventory as a debug-only flag: builds a fresh inventory in memory without writing to R2. Not a production fallback.

   Planning behaviour:
   a. Read inventory from R2. If missing, invalid JSON, or wrong schema version: exit non-zero with an actionable error message and instruction to re-run build_backup_inventory.mjs.
   b. Compare inventory day hashes against checkpoint day hashes. Queue only missing/changed.
   c. Compare inventory latest index file hashes against checkpoint index_files entries. Queue only missing/changed.
   d. Compare inventory index tree unit hashes against checkpoint index_tree_units entries. Queue only missing/changed.
   e. Copy queued units (rclone copy).
   f. Update checkpoint entries from inventory metadata after each successful copy.
   g. Preserve compatibility with existing checkpoints that only have day entries — populate new index_files / index_tree_units sections on first inventory-driven run.
   h. Do not delete from Dropbox when a day disappears from R2.

4. Update the GitHub Actions workflow .github/workflows/uk_aq_r2_history_dropbox_backup.yml:

   - Add a step before the existing sync step:

     node scripts/backup_r2/build_backup_inventory.mjs \
       --source-root "$SOURCE_ROOT" \
       --inventory-rel-path history/_index/backup_inventory_v1.json \
       --report-out artifacts/r2-backup-inventory-report.json

   - Modify the sync step to use the inventory:

     node scripts/backup_r2/sync_history_to_dropbox.mjs \
       --source-root "$SOURCE_ROOT" \
       --dest-root "$DEST_ROOT" \
       --inventory-rel-path history/_index/backup_inventory_v1.json \
       --report-out artifacts/r2-history-dropbox-backup-report.json

   - Preserve existing env/secret names (CFLARE_R2_*, DROPBOX_*, etc).
   - Upload both reports as workflow artifacts.

5. Reporting. Both scripts should include in their JSON report:
   - inventory_used (sync only — always true after this change)
   - inventory_generated_at
   - inventory_hash
   - listed_days / candidate_days / copied_days / skipped_unchanged / changed_existing_days / new_days per domain
   - index_files_copied / index_tree_units_copied
   - elapsed_ms per major phase
   - For the builder: etag_skip_hits / manifests_reread / first_build (bool)

6. Tests (minimal — defer broader scaffolding until validated in CIC-Test):
   - unchanged day not queued
   - changed old day queued and checkpoint updated
   - new day queued and checkpoint created
   - missing inventory causes sync to exit non-zero with the actionable error

7. Documentation. Add one short doc under system_docs/ explaining what backup_inventory_v1.json is, where it lives, and how to recover if it's broken (one-liner: re-run the builder).

Acceptance criteria:
- Sync no longer reads any day manifest from R2 during planning. Only reads the inventory file.
- Builder's etag-skip hit-rate is high on steady-state runs (most manifests reused from previous inventory).
- Changed old days are still detected because their inventory hash differs from the checkpoint hash.
- Timeseries index trees use per-unit comparison; no whole-tree wholesale copies.
- Missing/invalid inventory fails sync loudly with an actionable error.
- Existing checkpoint files continue to work without manual migration.
- Tests pass.

Please inspect the repo before editing. The shared lib at scripts/backup_r2/lib/ should be small and focused. Do not introduce unnecessary abstractions.
```
