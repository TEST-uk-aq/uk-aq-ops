# Dropbox Backup Incremental Inventory Plan v2

DONT LIKE THIS PLAN - SHOULD BE THAT INTEGRITY REBUILDS INVENTORY FOR DAYS IT CHANGED

## Purpose

The Dropbox backup process should spend less time rebuilding inventory for historic UK AQ data that has not changed.

The backup should still remain safe when historic data is repaired, backfilled, or replaced. This is especially important if historic data is added later, because full history inventory rebuilds could become slow.

This v2 plan changes the responsibility split:

- The normal Dropbox backup rebuilds only a recent rolling window.
- Integrity is responsible for rebuilding inventory for historic days that it changes.
- Manual one-day or multi-day inventory rebuilds remain available.
- Manual full inventory rebuild remains available.

## Core idea

Normal Dropbox backups should not need to understand every reason historic data may have changed.

Instead:

```text
Normal Dropbox backup = rebuild recent inventory + reuse existing historic inventory + sync from current inventory
```

Historic changes should update their own inventory at the point where the change happens.

For integrity:

```text
Integrity changes R2 data for a day
Integrity rebuilds the inventory for that day
Later Dropbox backup reads the updated inventory
Dropbox backup syncs the changed files
```

This keeps the Dropbox backup simpler.

## Goals

1. Make normal scheduled Dropbox backups faster.
2. Avoid full history inventory rebuilds on every scheduled run.
3. Keep recent data safe by rebuilding a rolling recent window every run.
4. Let integrity rebuild inventory for historical days that it changes.
5. Keep manual rebuild for one day or selected days.
6. Keep manual full inventory rebuild.
7. Support future historic data imports without making every Dropbox backup slow.
8. Keep logs clear enough to prove which days were rebuilt and why.

## Non-goals

This plan does not require a full global changed-days tracking system for every writer from day one.

It also does not require the Dropbox backup to read integrity run history and decide which integrity days to rebuild. Under v2, integrity should do that rebuild itself when it changes data.

## Responsibility split

### Dropbox backup responsibility

The scheduled Dropbox backup should:

1. Load the current stored inventory.
2. Rebuild inventory for the recent rolling window.
3. Merge those rebuilt recent entries into the existing inventory.
4. Reuse existing older inventory entries.
5. Sync all files described by the current merged inventory to Dropbox.
6. Support manual explicit rebuild dates.
7. Support manual full inventory rebuild.

It should not need special default logic for integrity days.

### Integrity responsibility

When integrity changes R2 data for one or more days, integrity should:

1. Complete the R2 repair or rewrite successfully.
2. Rebuild inventory for every changed day.
3. Write those updated day inventory entries into the stored inventory.
4. Log the changed days and inventory rebuild result.

The inventory rebuild must happen after the R2 write has completed successfully.

### Manual repair responsibility

If a manual repair script changes historic R2 data outside the integrity process, it should either:

1. Call the same targeted inventory rebuild for the affected day or days, or
2. Leave a clear instruction to run the manual targeted inventory rebuild command.

Manual repair scripts should not need to trigger a Dropbox backup immediately. The next scheduled Dropbox backup should pick up the updated inventory.

## Proposed modes

### 1. Normal scheduled backup

This is the default cron mode.

It should rebuild inventory only for a recent rolling window, for example the last 14 days.

Suggested environment variable:

```bash
BACKUP_REBUILD_RECENT_DAYS=14
```

Expected behaviour:

```text
Load current inventory
Rebuild recent 14 days
Merge rebuilt recent entries into inventory
Run Dropbox sync from the current inventory
```

This mode should not rebuild the whole inventory unless the previous inventory is missing, corrupt, or has an unsupported format version.

### 2. Manual targeted rebuild

This is used when a known historic day or set of days has changed.

Suggested environment variable:

```bash
BACKUP_REBUILD_DATES=2026-06-01,2026-06-02
```

Expected behaviour:

```text
Load current inventory
Rebuild recent window
Rebuild explicitly requested dates
Merge rebuilt entries into inventory
Optionally stop after inventory rebuild, if inventory-only mode is set
Otherwise run Dropbox sync
```

This must work for one day as well as multiple days.

Example one-day inventory-only rebuild:

```bash
BACKUP_REBUILD_DATES=2026-06-13 \
BACKUP_INVENTORY_ONLY=1 \
python3 scripts/dropbox_backup/build_backup_inventory.py
```

The exact script path can be adjusted to match the repo.

### 3. Integrity-triggered targeted rebuild

This is used by the integrity process after it changes R2 data.

Expected behaviour:

```text
Integrity repairs R2 data for 2026-06-13
Integrity calls targeted inventory rebuild for 2026-06-13
Inventory is updated
No Dropbox backup is run immediately
Later cron Dropbox backup reads the updated inventory and syncs the changed day
```

Integrity may call the same underlying inventory function as the manual targeted rebuild, but ideally through a function or script designed for reuse.

Example conceptual call:

```bash
BACKUP_REBUILD_DATES=2026-06-13 \
BACKUP_INVENTORY_ONLY=1 \
python3 scripts/dropbox_backup/build_backup_inventory.py
```

The main rule is that integrity must only rebuild the day inventory after the R2 change has fully succeeded.

### 4. Manual full inventory rebuild

This is the safety mode.

Suggested environment variable:

```bash
BACKUP_FORCE_FULL_INVENTORY=1
```

Expected behaviour:

```text
Ignore existing inventory entries
Scan the full source tree
Write a complete new inventory
Optionally run Dropbox sync
```

Use this when:

- The inventory format changes.
- The existing inventory is missing or corrupt.
- A large historic backfill has been added.
- A major repair touched many dates.
- There is doubt about whether the current inventory is complete.
- Periodic full verification is wanted.

### 5. Inventory-only mode

This mode rebuilds inventory but does not run the Dropbox copy/sync step.

Suggested environment variable:

```bash
BACKUP_INVENTORY_ONLY=1
```

This is useful for integrity and manual repair scripts.

Expected behaviour:

```text
Rebuild and write inventory
Do not sync to Dropbox
Exit successfully
```

The next scheduled Dropbox backup will then use the updated inventory.

## Inventory merge behaviour

When not doing a full rebuild:

1. Load the previous/current inventory.
2. Calculate the days to rebuild:
   - Recent rolling window days.
   - Explicit dates from `BACKUP_REBUILD_DATES`, if supplied.
3. Remove old inventory entries for those dates.
4. Re-scan those dates from R2/source storage.
5. Add the rebuilt entries.
6. Write the merged inventory atomically.
7. Run Dropbox sync unless `BACKUP_INVENTORY_ONLY=1`.

Pseudo-logic:

```text
if BACKUP_FORCE_FULL_INVENTORY=1:
    new_inventory = scan_all_source_data()
else:
    previous_inventory = load_current_inventory()
    rebuild_days = recent_window_days + explicit_rebuild_dates
    kept_entries = previous_inventory entries where day_utc not in rebuild_days
    rebuilt_entries = scan_source_data_for(rebuild_days)
    new_inventory = kept_entries + rebuilt_entries

write_inventory_atomically(new_inventory)

if BACKUP_INVENTORY_ONLY != 1:
    run_dropbox_sync(new_inventory)
```

## How Dropbox picks up integrity changes

Dropbox backup does not need to know that integrity changed a day.

It only needs to read the current inventory.

Example:

```text
Before integrity:
  inventory says day 2026-06-13 has file checksums A, B, C

Integrity repair:
  R2 data for 2026-06-13 changes
  integrity rebuilds inventory for 2026-06-13

After integrity:
  inventory says day 2026-06-13 has file checksums A, B2, C

Next Dropbox backup:
  reads current inventory
  sees changed file/checksum/size for the day
  copies the changed file to Dropbox
```

The Dropbox backup is therefore inventory-driven.

## Requirement for integrity accuracy

This v2 design depends on integrity being accurate about which days it has changed.

If integrity rewrites data for a day but fails to rebuild that day’s inventory, the Dropbox backup may not know that the historic day changed.

Integrity should therefore log three separate things:

1. Days checked.
2. Days changed.
3. Days whose inventory was rebuilt successfully.

Example log summary:

```text
Integrity days checked: 12
Integrity days changed: 2
Inventory days rebuilt: 2
Changed days:
  2026-04-12
  2026-05-03
```

If any changed day fails its inventory rebuild, integrity should exit as failed or clearly report that backup inventory is incomplete.

## Safety checks

The implementation should include these checks:

1. If previous inventory is missing, force a full rebuild unless explicitly running a safe bootstrap path.
2. If previous inventory format is unsupported, force a full rebuild.
3. If scanning a rebuild day fails, do not write a partial merged inventory.
4. Write the new inventory to a temporary file first.
5. Rename the temporary file into place only after successful validation.
6. Keep the previous inventory file until the new file is safely written.
7. Log entry counts before and after merge.
8. Log the exact dates rebuilt.
9. Log whether the run was full rebuild, incremental backup, targeted rebuild, or inventory-only.
10. For integrity, fail or warn loudly if R2 changed but inventory rebuild did not complete.

## Suggested environment variables

```bash
BACKUP_REBUILD_RECENT_DAYS=14
BACKUP_REBUILD_DATES=2026-06-01,2026-06-02
BACKUP_FORCE_FULL_INVENTORY=0
BACKUP_INVENTORY_ONLY=0
```

Optional later variables:

```bash
BACKUP_SKIP_RECENT_WINDOW=1
BACKUP_VALIDATE_INVENTORY_AFTER_WRITE=1
BACKUP_KEEP_PREVIOUS_INVENTORY_COPIES=5
```

`BACKUP_SKIP_RECENT_WINDOW=1` could be useful for a pure one-day repair inventory rebuild, but the safer default is to include the recent window unless there is a clear reason not to.

## Logging requirements

Normal backup log should show:

```text
Inventory mode: incremental
Inventory-only: no
Previous inventory entries loaded: 120000
Recent rebuild window days: 14
Explicit rebuild dates: 0
Full rebuild: no
Total rebuild days: 14
Kept previous inventory entries: 117500
Rebuilt inventory entries: 2500
New inventory entries: 120000
Dropbox sync: started
Dropbox sync: completed
```

Manual one-day inventory-only log should show:

```text
Inventory mode: targeted
Inventory-only: yes
Explicit rebuild dates: 1
Rebuild dates:
  2026-06-13
Inventory written: yes
Dropbox sync: skipped
```

Integrity log should show:

```text
Integrity changed days: 2
Inventory rebuild requested for changed days: 2
Inventory rebuild succeeded for changed days: 2
Dropbox sync: not run by integrity
```

Full rebuild log should show:

```text
Inventory mode: full
Full rebuild: yes
Previous inventory reused: no
All source days scanned: yes
Inventory written: yes
Dropbox sync: started or skipped, depending on mode
```

## Recommended implementation phases

### Phase 1: Recent-window incremental inventory

Add support for:

- Loading current inventory.
- Rebuilding only the recent N-day window.
- Merging rebuilt recent entries with older existing entries.
- Atomic inventory writes.
- Full rebuild fallback when no valid inventory exists.

### Phase 2: Manual targeted rebuild

Add support for:

```bash
BACKUP_REBUILD_DATES=YYYY-MM-DD,YYYY-MM-DD
BACKUP_INVENTORY_ONLY=1
```

This allows known historic days to be updated without a full inventory rebuild or immediate Dropbox sync.

### Phase 3: Integrity-triggered rebuild

Update integrity so that when it changes R2 data for a day, it calls the targeted inventory rebuild for that day.

Rules:

- Only rebuild inventory after successful R2 write.
- Rebuild every changed day.
- Fail or report loudly if any changed day inventory rebuild fails.
- Do not run Dropbox backup from integrity by default.

### Phase 4: Manual full rebuild

Add or confirm support for:

```bash
BACKUP_FORCE_FULL_INVENTORY=1
```

This should be easy to run manually after major historic backfills or if the inventory is suspect.

### Phase 5: Optional assurance checks

Later, add optional checks such as:

- Periodic full rebuild comparison.
- Random historic day verification.
- Inventory checksum summary.
- Report of days present in R2 but missing from inventory.
- Report of inventory entries whose R2 source files no longer exist.

## Recommended default behaviour

For scheduled cron Dropbox backup:

```bash
BACKUP_REBUILD_RECENT_DAYS=14
BACKUP_FORCE_FULL_INVENTORY=0
BACKUP_INVENTORY_ONLY=0
```

For integrity after changing one day:

```bash
BACKUP_REBUILD_DATES=2026-06-13
BACKUP_INVENTORY_ONLY=1
```

For manual repair of selected days:

```bash
BACKUP_REBUILD_DATES=2026-04-12,2026-04-13
BACKUP_INVENTORY_ONLY=1
```

For full manual rebuild:

```bash
BACKUP_FORCE_FULL_INVENTORY=1
```

For full manual rebuild without immediate Dropbox sync:

```bash
BACKUP_FORCE_FULL_INVENTORY=1
BACKUP_INVENTORY_ONLY=1
```

## Historic data scenario

If historic data is added later, this plan gives three safe options.

### Option A: Full rebuild after large historic import

Use when many dates are added or changed.

```bash
BACKUP_FORCE_FULL_INVENTORY=1
BACKUP_INVENTORY_ONLY=1
```

Then let the next cron Dropbox backup sync from the updated inventory, or run sync immediately if wanted.

### Option B: Targeted rebuild after limited historic import

Use when only a few dates are added or changed.

```bash
BACKUP_REBUILD_DATES=2024-01-01,2024-01-02,2024-01-03
BACKUP_INVENTORY_ONLY=1
```

### Option C: Integrity-managed rebuild

Use when integrity is the process that validates and writes the historic data.

```text
Integrity imports or repairs historic day
Integrity rebuilds inventory for that changed day
Cron Dropbox backup picks it up later
```

## Why v2 is cleaner than the first plan

The first plan made the Dropbox backup responsible for rebuilding recent days, integrity days, and explicit dates.

This v2 plan keeps Dropbox focused on scheduled backup behaviour:

```text
Dropbox backup: rebuild recent days and sync current inventory
Integrity: rebuild inventory for days it changes
Manual repair: rebuild inventory for days it changes
```

That keeps the responsibility close to the process that actually changed the data.

It also avoids making the Dropbox backup depend on reading and interpreting integrity history correctly.

## Main risk

The main risk is that integrity or a repair script changes historic R2 data but does not rebuild inventory for the changed day.

Mitigation:

- Make the targeted inventory rebuild easy to call.
- Make integrity log changed days separately from checked days.
- Fail loudly if changed days do not get inventory rebuilt.
- Keep manual targeted rebuild available.
- Keep manual full rebuild available.
- Periodically run a full rebuild or verification if confidence is needed.

## Summary

The v2 approach is:

1. Normal Dropbox cron backup rebuilds recent days only.
2. Older inventory entries are reused by default.
3. Integrity rebuilds inventory for any historic days it changes.
4. Manual one-day or selected-day rebuild remains available.
5. Manual full rebuild remains available.
6. Dropbox backup syncs from the current inventory, so it will pick up historic changes once their inventory entries have been updated.

This should make normal backups faster while still supporting historic data imports, integrity repairs, manual fixes, and full safety rebuilds.
