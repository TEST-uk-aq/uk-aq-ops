# R2 v2 hierarchical observations backup migration

## Purpose

This runbook introduces the contract-backed hierarchical observations inventory and matching Dropbox checkpoint shards for TEST.

It does not remove the existing flat inventory or flat Dropbox checkpoint. Those files remain migration and rollback inputs until the new path has completed real TEST inventory and backup runs successfully.

The implementation applies first to:

```text
history/v2/observations
```

Existing backup coverage for AQI, AQI debug, core and index trees continues through the existing inventory and sync scripts during migration.

## New inventory paths

```text
history/_index_v2/backup_inventory_v2/root.json
history/_index_v2/backup_inventory_v2/observations/year=YYYY/month=MM.json
history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json
```

The root follows the authoritative observations aggregate hierarchy:

```text
history/v2/observations/_manifests/manifest.json
  -> year manifests
    -> month manifests
      -> existing day manifests
```

The monthly inventory shard records both:

- the authoritative day `manifest_hash` from the aggregate hierarchy;
- the physical SHA-256 of the day manifest file, used to adopt the existing flat Dropbox checkpoint without recopying already verified days.

## New Dropbox state paths

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
_ops/checkpoints/r2_history_backup_state_v2/observations/year=YYYY/month=MM.json
_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json
```

Monthly state shards record individual completed day identities and only advance `processed_source_month_hash` after every required day in the month is complete.

Year and observations-root processed hashes advance bottom-up. The Dropbox root is written after dirty monthly shards.

## Initial TEST inventory build

Run from the TEST Ops repository after sourcing the TEST environment:

```bash
mkdir -p tmp logs

node scripts/backup_r2/build_hierarchical_backup_inventory_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --full-scan \
  --report-out "tmp/r2_hierarchical_inventory_v2_report.json" \
  2>&1 | tee "logs/r2_hierarchical_inventory_v2.log"
```

`--full-scan` independently enumerates every committed observation day manifest and verifies that it agrees with the root, year and month hierarchy.

The first successful run creates the monthly inventory shards and writes the inventory root last.

## Initial Dropbox migration dry run

```bash
node scripts/backup_r2/sync_hierarchical_observations_to_dropbox_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --dest-root "uk_aq_dropbox:CIC-Test/R2_history_backup" \
  --dry-run \
  --report-out "tmp/r2_hierarchical_dropbox_v2_dry_run.json" \
  2>&1 | tee "logs/r2_hierarchical_dropbox_v2_dry_run.log"
```

The migration reads the existing flat checkpoint:

```text
_ops/checkpoints/r2_history_backup_state_v2.json
```

Matching legacy day-manifest file hashes are adopted into monthly state shards. A correct migration should therefore plan few or no historical day-folder copies.

## Initial real Dropbox migration

After reviewing the dry-run report:

```bash
node scripts/backup_r2/sync_hierarchical_observations_to_dropbox_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --dest-root "uk_aq_dropbox:CIC-Test/R2_history_backup" \
  --report-out "tmp/r2_hierarchical_dropbox_v2_report.json" \
  2>&1 | tee "logs/r2_hierarchical_dropbox_v2.log"
```

The sync:

1. adopts matching existing day state;
2. copies only changed or missing observation day folders;
3. verifies the copied destination day manifest identity;
4. retains manifest-guided stale Parquet pruning;
5. copies month, year and root aggregate manifests after their children are complete;
6. writes monthly state shards before the small Dropbox state root;
7. copies changed observations run manifests.

## Subsequent normal inventory runs

Do not use `--full-scan` for normal daily operation:

```bash
node scripts/backup_r2/build_hierarchical_backup_inventory_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --report-out "tmp/r2_hierarchical_inventory_v2_report.json"
```

When the observations-root content hash is unchanged, historical years and months are not traversed. When it changes, only changed years and months are opened.

## Existing non-observation backup during migration

Continue using the existing flat inventory and sync for AQI, AQI debug, core and existing index coverage. Exclude the observations day domain after the hierarchical observations path has been accepted on TEST.

Do not switch the scheduled workflow until:

- the full-scan inventory agrees with the source hierarchy;
- the dry run adopts the existing checkpoint without mass recopy;
- a real TEST sync succeeds;
- a second unchanged inventory and sync run is fast and copies no observation days;
- Dropbox contains the root, year and month aggregate manifests;
- the old flat inventory and checkpoint remain available for rollback.

## Rollback

The new implementation is additive.

To roll back, stop invoking the hierarchical builder and sync and return to:

```text
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
```

Do not delete the old flat inventory or checkpoint during TEST migration.
