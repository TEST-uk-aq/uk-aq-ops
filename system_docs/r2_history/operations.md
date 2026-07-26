# Binding operations

## Normal publication

The core snapshot publisher attempts physical binding reconciliation after its committed snapshot write and verification.

Continuity enrichment additionally reads the validated service-only continuity view. The implementation must keep the physical core snapshot authority and continuity-view authority distinct in diagnostics.

A continuity-view failure must not invent or partially publish a family.

## Manual reconciliation

Operators can inspect or apply reconciliation with the existing commands:

```bash
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --dry-run
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --write-r2
```

The first command remains the default.

The report must include at least:

```text
authoritative physical binding count
schema-version-1 candidate count
multi-member continuity family count
schema-version-2 candidate count
new binding count
changed binding count
unchanged binding count
invalid family count
conflicted timeseries count
stale binding count
planned/written PUT count
verification GET count
```

## Required dry-run review

Before the first TEST write, inspect:

- how many families contain more than one member;
- which existing binding objects would change;
- whether changes are restricted to those families;
- whether any object changes solely because of timestamps, source refresh metadata or property ordering;
- whether the BPLE PM2.5 family contains `285` followed by `212` with the expected validity boundary;
- whether any physical timeseries appears in more than one family;
- whether there are overlaps or contradictory site references.

A broad rewrite of single-member bindings is a defect and must not be applied.

## Write ordering and verification

For each valid affected family:

1. construct the complete deterministic family;
2. construct all member binding proposals;
3. compare every proposed body with the existing ETag/MD5;
4. skip byte-identical objects;
5. write changed objects;
6. GET and verify changed bytes;
7. report any partially published family as an error.

The builder must not delete stale binding objects automatically.

## Backup contract

The active v2 backup inventory category remains:

```text
timeseries_binding_v2
```

Schema-version-2 objects are backed up through the same category and path. Do not add a separate continuity backup tree.

Unchanged bindings must preserve their ETags so the next inventory and Dropbox sync can skip them.

A monthly bridge refresh with unchanged stable mapping must report zero changed bindings.

## TEST deployment order

1. Apply and verify the service-only continuity view.
2. Deploy binding producer/reader support while continuity use remains disabled.
3. Run binding reconciliation dry-run.
4. Inspect proposed family-scoped churn.
5. Apply binding reconciliation to TEST R2.
6. Deploy station-history and website compatibility support.
7. Enable continuity in TEST.
8. Validate a known transition and a normal single-member series.
9. Enable calculated historical AQI and R2 validation.
10. Keep historical identity repair disabled until operational validation succeeds.

## Rollback

Normal rollback disables continuity-aware station history. It does not rewrite physical R2 rows or delete schema-version-2 binding objects.

Readers must support schema versions 1 and 2 before schema-version-2 objects are published.

If an older Worker that cannot parse schema version 2 must be restored, restore a compatible deployment or restore the affected binding objects from the existing backup before routing requests through that Worker.

## Retired metadata cleanup

The retired cumulative metadata tree remains inactive:

```text
history/_index_v2/timeseries
```

Where cleanup is still required, use the existing dry-run and explicit-write procedure:

```bash
node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs --dry-run
node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs --write-r2
rclone delete --dry-run "${UK_AQ_DROPBOX_RCLONE_REMOTE}:${UK_AQ_DROPBOX_ROOT}/R2_history_backup/history/_index_v2/timeseries"
rclone delete "${UK_AQ_DROPBOX_RCLONE_REMOTE}:${UK_AQ_DROPBOX_ROOT}/R2_history_backup/history/_index_v2/timeseries"
```
