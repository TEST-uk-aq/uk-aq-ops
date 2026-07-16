# Populate Empty Live R2 From Dropbox Backup

This note describes the safe bootstrap path for populating a new live R2 history bucket from the Dropbox history backup.

## When This Is Safe

Use this only when the live history area is empty or disposable, and the live core metadata is being loaded from the same source dataset as the backup.

The key requirement is ID preservation:

- `connector_id`
- `station_id`
- `timeseries_id`

The restored history files contain numeric IDs, so the live core tables must preserve the same IDs as the source environment.

## Important Constraints

- Do not treat this as a generic merge tool.
- `restore_history_from_dropbox.mjs` uses `rclone copy`, not `sync`.
- Existing extra objects in the destination R2 area are not deleted.
- If the live database already has independently created core rows with different IDs, the restored history will not line up correctly.

## Recommended Bootstrap Order

1. Populate the live core DB tables from the source/test dataset, preserving IDs (`populate-live-core-db-from-test.md`).
2. Populate `history/v1/core` in live R2.
3. Restore `history/v1/observations` and `history/v1/aqilevels/hourly` from Dropbox into the live R2 bucket.
4. Rebuild the live `history/_index` manifests.
5. Validate a few days/connectors before exposing the live history endpoints.

## Why `history/v1/core` Matters

There are two ways to populate the R2 core snapshot:

1. Preferred: run `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs` against the live DB after the core tables are loaded.
2. Alternative: restore the `core` domain from Dropbox.

The preferred option is to generate a fresh live core snapshot from the live DB, because it guarantees that `history/v1/core` matches the actual live database contents.

Restoring the `core` domain from Dropbox is acceptable only if the live DB is an exact PK-preserving clone of the source/test metadata.

## Why The `_index` Files Must Be Rebuilt

The Dropbox backup includes the derived index files:

- `history/_index/observations_latest.json`
- `history/_index/aqilevels_latest.json`
- `history/_index/observations_timeseries_latest.json`

The restore script does not restore those files. That is good for cross-environment use, because the derived index payload includes environment-specific metadata such as the R2 bucket name.

Do not try to reuse test `_index` files in live.

After restoring the history day folders, rebuild the live index files with:

- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`

## Suggested Procedure

### 1. Load Live Core Metadata

Populate the live `uk_aq_core` tables from the source/test dataset while preserving IDs.

See also:

- `populate-live-core-db-from-test.md`

This is the hard requirement for the restored history to remain meaningful.

### 2. Write The Live R2 Core Snapshot

Preferred:

```bash
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --report-out ./tmp/uk_aq_core_snapshot_to_r2_live_report.json
```

If you intentionally want to restore the `core` domain from Dropbox instead, include `--domain core` in the restore step below.

### 3. Dry-Run The Restore First

Run a dry-run first, ideally for one known day:

```bash
node scripts/backup_r2/restore_history_from_dropbox.mjs \
  --source-root "uk_aq_dropbox:<live-dropbox-backup-root>" \
  --dest-root "uk_aq_r2:<live-r2-bucket>" \
  --domain observations \
  --domain aqilevels \
  --day-utc YYYY-MM-DD \
  --dry-run \
  --report-out ./tmp/r2_history_restore_from_dropbox_dry_run.json
```

If you want to restore the R2 core snapshot from Dropbox rather than generate it from the live DB, add:

- `--domain core`

### 4. Run The Actual Restore

```bash
node scripts/backup_r2/restore_history_from_dropbox.mjs \
  --source-root "uk_aq_dropbox:<live-dropbox-backup-root>" \
  --dest-root "uk_aq_r2:<live-r2-bucket>" \
  --domain observations \
  --domain aqilevels \
  --report-out ./tmp/r2_history_restore_from_dropbox_live_report.json
```

If restoring `core` from Dropbox too:

```bash
node scripts/backup_r2/restore_history_from_dropbox.mjs \
  --source-root "uk_aq_dropbox:<live-dropbox-backup-root>" \
  --dest-root "uk_aq_r2:<live-r2-bucket>" \
  --domain observations \
  --domain aqilevels \
  --domain core \
  --report-out ./tmp/r2_history_restore_from_dropbox_live_report.json
```

## 5. Rebuild The Live Index Files

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --domain both
```

This writes the live:

- `history/_index/observations_latest.json`
- `history/_index/aqilevels_latest.json`
- `history/_index/observations_timeseries_latest.json`
- `history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`

## Validation Checklist

After the restore:

- Confirm the destination R2 bucket contains day manifests under:
  - `history/v1/observations/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/manifest.json`
- Confirm the index rebuild wrote:
  - `history/_index/observations_latest.json`
  - `history/_index/aqilevels_latest.json`
  - `history/_index/observations_timeseries_latest.json`
  - `history/_index/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
- Confirm the live core DB still has the expected source/test IDs.
- Spot-check a few known `timeseries_id` and `station_id` queries against the live history readers.

## Practical Notes

- The Dropbox restore source must preserve the exact mirrored folder structure from the backup:
  - `history/v1/observations/...`
  - `history/v1/aqilevels/hourly/...`
  - `history/v1/core/...`
- Prefix env vars must match the actual backup layout:
  - `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX`
  - `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX`
  - `UK_AQ_R2_HISTORY_CORE_PREFIX`
- If the live R2 area is not empty, `rclone copy` can leave stale extra objects behind.
- If the live core metadata diverges later, do not reuse this procedure as a normal ongoing sync mechanism.

## Short Version

For a new live bootstrap, the clean path is:

1. Import live core DB metadata from the source/test dataset with IDs preserved.
2. Generate `history/v1/core` from the live DB.
3. Restore `observations` and `aqilevels` from Dropbox.
4. Rebuild `history/_index`.

That is the complete recovery/bootstrap sequence for an empty live R2 history area.
