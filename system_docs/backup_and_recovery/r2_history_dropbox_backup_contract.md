# R2 v2 history Dropbox backup

## Authority and scope

This document defines the authoritative backup inventory, Dropbox checkpoint and incremental-copy contract for R2 v2 history.

The Phase B observations backup remains mandatory. Optimisation must preserve complete backup coverage and must not disable, skip or reduce required history data.

The new hierarchical optimisation applies first to:

```text
history/v2/observations
```

Existing backup coverage for AQI history, AQI debug, core, indexes, run manifests and other currently backed-up v2 objects remains unchanged until a separate contract deliberately retires or changes it.

The observations source hierarchy is defined in:

- [`../r2_history/observations_manifest_hierarchy_contract.md`](../r2_history/observations_manifest_hierarchy_contract.md).

## Source and destination roles

R2 is the source of the history backup.

Dropbox is the independent backup destination.

The R2 backup inventory describes the current source objects and source identities. The Dropbox backup state records which source identities have been copied and verified successfully.

The Dropbox state is not a second source inventory and must not be used to author or repair R2.

## Current behaviour being replaced

The existing v2 process uses:

```text
R2 inventory:
history/_index_v2/backup_inventory_v2.json

Dropbox state:
_ops/checkpoints/r2_history_backup_state_v2.json
```

The current sync compares day and file-unit hashes and uses `rclone copy` for changed day folders. Rclone checks individual files and transfers only changed or missing files.

The existing single Dropbox state file must no longer be uploaded after every copied unit. The existing single inventory and state files are migration inputs, not the final scalable layout.

## Hierarchical R2 backup inventory

The new inventory is rooted at:

```text
history/_index_v2/backup_inventory_v2/root.json
```

Observation date-based inventory shards are stored as:

```text
history/_index_v2/backup_inventory_v2/observations/year=YYYY/month=MM.json
```

Timeseries-binding inventory shards are stored as fixed ID ranges:

```text
history/_index_v2/backup_inventory_v2/timeseries_binding/root.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=000000-000999.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json
...
```

The fixed binding range size is 1,000 timeseries IDs. Range boundaries must remain stable after deployment unless a separately documented migration changes them.

Small non-date and non-binding inventory sections may remain in `root.json` or a separately referenced stable global shard. They must not force unchanged monthly observation shards or binding ranges to be rewritten.

## Inventory root contents

The inventory root records at least:

- inventory schema version;
- backup version;
- observations source-root content hash;
- each observation year source hash;
- each observation month source hash and shard path;
- each timeseries-binding range source hash and shard path;
- identities for any small global shards;
- stable source-derived generation evidence where required.

No wall-clock-only field may cause an unchanged inventory root or shard to change bytes.

## Inventory builder traversal

For observations, the inventory builder follows the source hierarchy:

```text
observations root
    -> changed year
        -> changed month
            -> changed day manifests
```

The builder first compares the current R2 metadata or stable content identity for the observations-root manifest with the previous inventory root.

If the observations-root source identity is unchanged, it performs no observation month or day traversal.

If the root changed, it compares year identities. It opens only changed years. Within a changed year it compares month identities and opens only changed months. Within a changed month it compares the day-manifest identities and updates only the affected monthly inventory shard.

A changed month shard contains the complete current inventory state for that month, not only the items changed in the current run.

The builder must continue using R2 metadata as the fast first comparison. It reads and hashes an object only when metadata or parent identity indicates that the object may have changed or when running an explicit audit.

## Independent full-scan mode

The hierarchy is an optimisation, not the only recovery method.

The inventory builder must retain an explicit full-scan mode that independently enumerates all committed day manifests and rebuilds or compares every observation month shard.

The full-scan mode is used for:

- initial migration;
- recovery from a missing or invalid aggregate hierarchy;
- periodic drift audit;
- explicit operator verification.

Normal hierarchical mode must fail clearly rather than silently trust malformed or contradictory parent manifests.

## Dropbox state layout

The new Dropbox checkpoint root is:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
```

Observation monthly state shards are:

```text
_ops/checkpoints/r2_history_backup_state_v2/observations/year=YYYY/month=MM.json
```

Timeseries-binding state shards mirror the fixed R2 ranges:

```text
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=000000-000999.json
...
```

Other currently backed-up domains and small units may use separate stable shards or retain a compatibility section during migration. They must not cause every observation month shard to be rewritten.

## Source and state hashes

For each observation month, R2 records the current source month hash in the inventory root.

Dropbox records the source month hash it has completely processed:

```text
processed_source_month_hash
```

Matching hashes mean that every required item represented by that source month version has been copied successfully.

The Dropbox root similarly records fully processed source hashes for years, the observations root and timeseries-binding ranges.

A separate hash of a Dropbox state shard itself may be recorded in the Dropbox root for checkpoint integrity. That state-shard hash is a Dropbox concern and need not be written back to R2.

## Monthly state contents

An observation monthly state shard records at least:

- year and month;
- each day manifest hash successfully processed;
- copy completion evidence for each day;
- the fully processed R2 source month hash;
- checkpoint schema version.

The shard may also contain the month-addressed observation index and connector-manifest units currently tracked by the backup, provided their identities are stable and belong unambiguously to that month.

## Copy planning

The Dropbox sync compares R2 inventory hashes with Dropbox state hashes.

For observations:

```text
year hash matches
    -> skip year

year differs, month hash matches
    -> skip month

month differs, day hash matches
    -> skip day

day differs
    -> run rclone for that day folder
```

For a changed day, the sync runs rclone against the complete day prefix:

```text
history/v2/observations/day_utc=YYYY-MM-DD/
```

Rclone compares individual files. Unchanged connector, pollutant, manifest and Parquet files are skipped. Only changed or missing files are transferred.

After the copy, manifest-guided stale Parquet pruning remains required so Dropbox removes superseded Parquet files no longer referenced by the copied manifests.

## Failure and completion ordering

A monthly state shard may record individual day successes as they occur.

It must not advance `processed_source_month_hash` to the new R2 month hash until every changed or missing unit required for that month succeeds.

Example:

```text
14 July copied
15 July copied
19 July failed
```

The state may retain the successful 14 and 15 July day hashes, but the month processed hash remains old.

On the next run, the month still differs. The sync opens the month shard, skips the already matching days and retries 19 July.

Year and observations-root processed hashes advance only after all changed child months and years beneath them are complete.

State shards are written before their parent root. The small Dropbox root is updated last.

## Batched checkpoint writes

The sync must not upload the complete checkpoint after every copied item.

Checkpoint updates are accumulated and flushed:

- after a bounded batch of successful units;
- after a bounded elapsed interval;
- at phase boundaries;
- before a controlled failure exit when dirty state can be saved safely;
- at successful completion.

The implementation may configure the batch size and interval, but neither may be unbounded. A normal run must not lose a large amount of completed work when interrupted.

Once monthly shards are active, only dirty shards and the small root are written. Unchanged historical shards are untouched.

## Inventory and state migration

Migration from the single files must be restartable and non-destructive.

The migration must:

1. load and validate the existing v2 inventory and Dropbox state;
2. create monthly observation shards and binding-range shards;
3. create the new roots last;
4. compare counts and identities between old and new layouts;
5. retain the old files as compatibility or rollback inputs until TEST operation proves the new layout;
6. switch normal readers only after the new roots and shards are complete.

The migration must not force R2 data objects or Dropbox history data to be recopied merely because the checkpoint representation changed. Existing verified hashes should be adopted into the new shards where structurally valid.

## Interaction with observation writers

Prune Daily and Integrity do not edit the backup inventory or Dropbox state while writing R2 observations.

They maintain the authoritative observation manifests, including the month, year and observations-root hierarchy.

The inventory builder later discovers the committed hierarchy independently and updates its own inventory shards. This preserves separation between data writing and backup discovery.

## Timeseries-binding ranges

Timeseries bindings are not date-addressed and therefore use fixed ID ranges rather than month shards.

The binding inventory root records each range hash. The inventory builder opens and rebuilds only changed ranges. The Dropbox state records the fully processed source hash for each range.

A stable unchanged binding range must not change merely because another range changed or because the backup ran again.

## Audit evidence

Each backup report records at least:

- inventory mode, hierarchical or full scan;
- source root hash;
- years and months inspected;
- years and months skipped by matching hash;
- changed days sent to rclone;
- individual files transferred where rclone reporting provides them;
- stale Parquet files removed;
- dirty state shards written;
- checkpoint flush count;
- incomplete month, year or root hashes;
- binding ranges inspected, skipped and copied;
- migration or compatibility mode when applicable.

## Structural validation policy

Before deployment, validate only that:

- unchanged source hierarchy produces unchanged inventory root and shards;
- a one-day change affects only its month shard and ancestor root entries;
- a binding change affects only its fixed range and ancestor root entry;
- a partial month copy does not advance the processed month hash;
- successful individual day progress survives a restart;
- batching prevents per-unit whole-checkpoint uploads;
- migration preserves existing verified day and file-unit identities.

Functional acceptance occurs through real TEST inventory and Dropbox backup runs after deployment.
