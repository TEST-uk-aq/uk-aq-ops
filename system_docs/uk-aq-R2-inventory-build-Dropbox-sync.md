# UK-AQ R2 Inventory Build and Dropbox Sync

## Purpose

The R2 backup inventory workflow is designed to make Dropbox backup runs faster while preserving an important correctness rule:

> Any existing historical day in R2 may be updated later, so changed old days must still be detected and refreshed in Dropbox.

The fix splits the work into two separate responsibilities:

```text
build_backup_inventory.mjs
  = checks R2 and updates history/_index/backup_inventory_v1.json

sync_history_to_dropbox.mjs
  = compares that inventory against the Dropbox checkpoint and copies changed/missing backup units
```

## Why the first inventory build is slower

On the first run, there is no previous inventory to compare against.

So the builder has to:

```text
1. List all relevant manifest/index files in R2.
2. Read every manifest/index JSON file with rclone cat.
3. Compute a SHA-256 hash of the exact JSON bytes.
4. Build history/_index/backup_inventory_v1.json.
5. Upload the inventory back to R2.
```

This first run is expected to be relatively slow because it must read all existing manifests once.

For UK-AQ history, that can include:

```text
- observations day manifests
- aqilevels day manifests
- core day manifests
- latest index JSON files
- observations_timeseries index manifest units
- aqilevels_timeseries index manifest units
```

## Why the second inventory build is quicker

The second run is faster because the builder can reuse most of the previous inventory.

It does **not** simply check whether an inventory file exists and then stop. It still needs to check R2, because old days can change.

However, instead of re-reading every manifest body, it can use R2 object metadata from `rclone lsjson --hash`.

The steady-state builder process is:

```text
1. Read previous history/_index/backup_inventory_v1.json.
2. List current R2 manifest/index files using rclone lsjson --hash.
3. For each listed object, compare:
   - Size
   - Hashes.md5 / R2 ETag
4. If size + md5 are unchanged:
   - reuse the previous inventory entry
   - do not rclone cat that manifest
5. If the object is new or changed:
   - rclone cat that manifest
   - compute SHA-256 of the exact JSON bytes
   - update that inventory entry
6. Upload the refreshed inventory to R2.
```

So the second and later runs still perform a R2 listing/check, but they avoid thousands of individual manifest reads when most objects are unchanged.

## Why `rclone lsjson --hash` matters

Plain `rclone lsjson` or `rclone lsjson -M` may show size and modtime, but not the R2 ETag/MD5.

For Cloudflare R2, the stronger metadata signal is exposed when using:

```bash
rclone lsjson --hash --hash-type MD5 <r2-path>
```

Example output:

```json
{
  "Size": 4398,
  "ModTime": "2026-03-23T19:02:50.720000000Z",
  "Hashes": {
    "md5": "71350ccf4912edae37da099acd8b0672"
  }
}
```

That `Hashes.md5` value matches the R2 S3 `head-object` ETag for small JSON manifest files.

The builder should therefore prefer:

```text
Size + Hashes.md5
```

for unchanged detection, and only fall back to:

```text
Size + ModTime
```

if the hash is unavailable.

## What the Dropbox sync step does

The Dropbox sync step should no longer read every day manifest directly from R2.

Instead, it should:

```text
1. Read R2 history/_index/backup_inventory_v1.json.
2. Read Dropbox _ops/checkpoints/r2_history_backup_state_v1.json.
3. Compare inventory hashes against checkpoint hashes.
4. Queue only missing or changed backup units.
5. Copy those units from R2 to Dropbox.
6. Update the Dropbox checkpoint after successful copies.
```

So yes: the Dropbox sync step does the backup decision against the inventory.

But the inventory builder has already done the R2-side change detection needed to keep the inventory current.

## Simple mental model

```text
Builder:
  "What does R2 currently contain, and which units changed since the previous inventory?"

Sync:
  "Which of those current R2 units are missing or stale in Dropbox?"
```

## Why this preserves correctness

The old slow behaviour was effectively:

```text
for every old day:
    rclone cat history/v1/.../day_utc=.../manifest.json
    hash the file
    compare with Dropbox checkpoint
```

The new behaviour is:

```text
builder:
    use rclone lsjson --hash to cheaply detect unchanged R2 objects
    only rclone cat changed/new manifests
    maintain backup_inventory_v1.json

sync:
    compare backup_inventory_v1.json with the Dropbox checkpoint
    copy only changed/missing units
```

Changed old days are still detected because their manifest/index hash in the inventory changes, and the sync step sees that the inventory hash no longer matches the Dropbox checkpoint hash.

## Expected performance pattern

### First run

```text
Inventory builder: slower
Dropbox sync: inventory-driven
```

The builder must read all existing manifest/index JSON files once.

### Second and later runs

```text
Inventory builder: much quicker
Dropbox sync: much quicker
```

Most unchanged manifest/index files are skipped by comparing size + MD5/ETag from the R2 listing against the previous inventory.

Only new or changed files are re-read and re-hashed.

## Recommended reporting fields

The builder report should include enough telemetry to prove the optimisation is working:

```json
{
  "metadata_strategy": "size_md5",
  "md5_available_count": 0,
  "md5_missing_count": 0,
  "reuse_by_md5_size": 0,
  "reuse_by_size_modtime": 0,
  "manifests_listed": 0,
  "manifests_reread": 0,
  "etag_skip_hits": 0,
  "etag_skip_rate": 0,
  "first_build": false,
  "metadata_warnings": []
}
```

The sync report should show that the inventory path was used:

```json
{
  "inventory_used": true,
  "inventory_generated_at": "2026-05-15T12:00:00.000Z",
  "inventory_hash": "sha256hex...",
  "copied_days": {},
  "skipped_unchanged": {},
  "changed_existing_days": {},
  "new_days": {},
  "index_files_copied": 0,
  "index_tree_units_copied": 0
}
```

## Key point

The second inventory build is quicker because it does not re-read every old manifest.

It still checks R2, but it does so through a cheap metadata listing:

```text
same size + same MD5/ETag = previous SHA-256 inventory entry is still valid
```

Only changed or new objects need to be opened, hashed, and written into the refreshed inventory.





Builder (31 min) — slower than I predicted
The builder report shows perfect etag-skip:


r2_md5_available_count: 4982     ← every entry got MD5 ✓
reuse_by_r2_md5_size: 4982       ← every entry reused via strong path ✓
manifests_reread: 0              ← nothing re-cat'd ✓
metadata_warnings: []            ← --hash working correctly in GH ✓
So the speedup we expected from etag-skip did happen. But the builder still took 31 min because of the elapsed_ms.days: 1349876 line — 22 minutes just doing rclone lsjson --recursive on the observations + aqilevels + core day prefixes.

The reason: lsjson --recursive enumerates every object under those prefixes, including the parquet parts inside each day_utc=*/connector_id=*/ — thousands of files we then filter out in code with the DAY_MANIFEST_PATTERN regex. We only care about the day-level manifest.json (depth 2), but rclone is listing everything deeper.

Cheap fix when you're rested: add --max-depth 2 to rcloneLsjsonRecursive when scanning day folders (it's depth 2: day_utc=*/manifest.json), and --max-depth 3 when scanning timeseries trees (day_utc=*/connector_id=*/manifest.json). Should chop builder time from 31 min to a few minutes. Not urgent.

Sync (~61 min) — first-run cost from empty new checkpoint sections
This is the real surprise. The new checkpoint has two new sections: index_files and index_tree_units. Your existing Dropbox checkpoint (from the old sync) only had domains.<name>.days[...]. So on this first run:

The day comparisons all matched (same hash format as before) → ~0 day copies
But all 4 index files + 3922 timeseries tree units were absent from the new checkpoint sections → every single one got queued for rclone copyto
Each copyto does HEAD-source + HEAD-dest + hash compare (the --check-first flag) and skips the transfer when both sides match
Even skipped copytos take ~1 sec round-trip (TLS setup, two HEADs)
3926 × ~1 sec ≈ 65 min ≈ what you saw
This is one-time. Tomorrow's run will see every one of those 3926 units in the checkpoint with matching hashes → it skips them entirely without invoking rclone at all. Expected sync time tomorrow: seconds.

Tomorrow's run prediction
Phase	First run (today)	Steady state (tomorrow)
Builder	31 min	31 min (lsjson cost stays; optionally trim with --max-depth)
Sync	61 min	< 1 minute (everything in checkpoint, no rclone copyto needed)
Total	92 min	~31 min
If you add --max-depth to the builder later, total drops to maybe 5-10 min. Without that optimization, steady state is ~31 min, which is fine for a daily 4:35 UTC cron — well under the 120-min workflow timeout.

Daily task health
Looking at the workflow steps: ✅ Build inventory completed → 🔄 Sync completed → ⏳ Upload artifacts → ⏳ Report daily task health (final). If it gets to the final health-report step and reports success, today counts as a healthy day in daily_task_runs. Worth verifying when you look tomorrow.

Sleep well. The chart-gap diagnosis can wait.


Files changed
File	Change
scripts/backup_r2/lib/rclone.mjs	rcloneLsjsonRecursive accepts maxDepth option; when > 0, passes --max-depth N to rclone. Default 0 = no cap (unchanged behavior for any other caller).
scripts/backup_r2/build_backup_inventory.mjs	scanDayDomain passes maxDepth: 2; scanIndexTree passes maxDepth: 3.
Why those depths
Scan target	Path pattern	Depth
Day manifests	<domain>/day_utc=*/manifest.json	2
Tree units	<tree>/day_utc=*/connector_id=*/manifest.json	3
Day-level scan was the slowest by far (22 min of the 31 min builder time) because history/v1/observations/ etc contain per-connector subfolders with parquet parts that rclone was enumerating for nothing — we were filtering them all out in code anyway. --max-depth 2 cuts the LIST to the day-manifest level only.

Tree scan was already faster (8 min for 3922 entries because no parquet sibling noise) but --max-depth 3 makes its intent explicit and forecloses any future deeper junk.

Predicted next-run timings
Phase	Today (no depth cap)	Tomorrow (with cap + populated checkpoint)
Builder	31 min	~5 min (day scan drops from 22 min to ~3 min; tree scan ~3 min; index files unchanged)
Sync	~61 min (first-run from empty new checkpoint)	< 1 minute (everything in checkpoint, nothing to copy)
Total	~92 min	~5-6 min
That'll comfortably fit the daily cron window and the 120-min timeout with margin.

About the timeout you're seeing now
You're correct that this run timing out is OK. Three reasons:

Sync writes the checkpoint after each successful unit copy. Whatever it managed to copy before getting killed is recorded.
Next workflow run picks up where it stopped. All copied units skip, only the un-finished ones get attempted.
One or two runs to converge. Even worst case, by the day after tomorrow it'll be fully steady-state.
The report_daily_task_health step has if: always() so it'll still record this run's status (cancelled = failed) before the runner exits. So you'll see a "failed" entry in daily_task_runs for today — that's just a side effect of the migration cost; tomorrow's run should record ok.

Sleep well — the chart-gap diagnostic is the only thing left in queue, and that's a 30-second DevTools check whenever you get back to it.


Day scan went from 22 min → 2.4 min (9× speedup as expected). Index trees barely budged (8.2 min vs 8.4 min) because they don't have sibling noise — only the manifests we want — so --max-depth had nothing to filter out there.

Breakdown:

Phase	Before	After	Note
Day scan	22.5 min	2.4 min	--max-depth 2 stripped parquet enumeration ✓
Index files	4.4 sec	4.2 sec	Unchanged (was already cheap)
Tree scan	8.4 min	8.2 min	Not max-depth-limited; ~2000 connector subprefixes × LIST round-trips dominates
Total	31 min	10.7 min	
Tree scan being the new bottleneck is inherent to S3-style listing across thousands of subprefixes — each connector folder is its own LIST call. Could potentially be optimized further by using a single non-recursive lsjson + parsing keys ourselves, but it's small enough to not bother right now.

Sync prediction
Yesterday's sync ran for ~60 min before being killed. At ~1 sec per rclone copyto, that's roughly 3600 units. You had 4 + 3922 = 3926 units to copy, so it likely got almost all of them done. Today's sync should:

Skip the ~3600 units already in the checkpoint → instant
Re-attempt the remaining ~300-ish that didn't finish → ~5 min
New: nothing (no R2 changes overnight, just steady-state daily delta)
So I'd expect 5-15 minutes for sync today. Tomorrow it'll be seconds.

Total today: builder 10 min + sync ~10 min = ~20 min. Well inside the 120-min budget.
