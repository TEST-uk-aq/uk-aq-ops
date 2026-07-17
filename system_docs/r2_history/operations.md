# Binding operations

The core snapshot publisher attempts reconciliation after its committed snapshot
write/verification. Operators can separately inspect or apply reconciliation:

```bash
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --dry-run
node scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs --write-r2
```

The first command is the default and reports authoritative, candidate, written,
changed, unchanged, invalid and stale counts. The active v2 backup inventory
includes only `timeseries_binding_v2`; it does not plan or copy the retired
cumulative metadata tree.

After successful TEST chart, prune and backup validation, inspect then delete
the retired R2 tree with:

```bash
node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs --dry-run
node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs --write-r2
rclone delete --dry-run "${UK_AQ_DROPBOX_RCLONE_REMOTE}:${UK_AQ_DROPBOX_ROOT}/R2_history_backup/history/_index_v2/timeseries"
rclone delete "${UK_AQ_DROPBOX_RCLONE_REMOTE}:${UK_AQ_DROPBOX_ROOT}/R2_history_backup/history/_index_v2/timeseries"
```
