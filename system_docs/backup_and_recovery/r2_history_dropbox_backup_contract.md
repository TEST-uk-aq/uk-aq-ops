# R2 v2 history Dropbox backup

## Authority and scope

This document defines the authoritative backup inventory, Dropbox checkpoint and incremental-copy contract for R2 v2 history.

The Phase B observations backup is mandatory. Optimisation must preserve complete observation backup coverage and must not disable, skip or reduce required observation history data.

The active Dropbox backup scope is deliberately limited to:

```text
history/v2/observations
history/v2/_ops/observations/runs
history/_index_v2/timeseries_binding
```

This means the Dropbox history backup must cover:

- committed v2 observation day folders, including their manifests and Parquet objects;
- the v2 observations month, year and root aggregate manifest hierarchy;
- v2 observation run manifests;
- v2 timeseries-binding JSON objects.

The following are explicitly out of scope for this Dropbox history backup and must not be copied, inventoried or checkpointed by the active backup implementation:

```text
history/v2/aqilevels
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
history/v2/core
```

Derived AQI levels and AQI debug history are no longer part of the Dropbox backup requirement. R2 core snapshots are also outside this Dropbox backup requirement. This decision is specific to the Dropbox history backup and does not delete those R2 objects or redefine their separate runtime contracts.

The only `_index_v2` data objects in active Dropbox backup scope are the physical timeseries-binding objects required to preserve observation timeseries identity. Other historical index trees are not part of this backup unless a later contract explicitly adds them.

The observations source hierarchy is defined in:

- [`../r2_history/observations_manifest_hierarchy_contract.md`](../r2_history/observations_manifest_hierarchy_contract.md).

The observations run-level mutation exclusion contract is defined in:

- [`../r2_history/observations_run_exclusion_contract.md`](../r2_history/observations_run_exclusion_contract.md).

## Direct replacement rule

The hierarchical backup is a direct replacement for the previous flat inventory and checkpoint implementation.

There must be one active production inventory builder and one active production Dropbox sync:

```text
scripts/backup_r2/build_backup_inventory.mjs
scripts/backup_r2/sync_history_to_dropbox.mjs
```

Development filenames such as:

```text
build_hierarchical_backup_inventory_v2.mjs
sync_hierarchical_observations_to_dropbox_v2.mjs
```

must not remain as a second active backup path after cutover. Their hierarchical implementation is promoted into the established production filenames and obsolete duplicate entry points are removed.

The active GitHub workflow must invoke only the hierarchical implementation. It must not run the old flat backup alongside the hierarchical backup, split domains between the two implementations, or maintain a temporary hybrid operational mode.

The pre-change active implementation must be archived under `archive/` according to `AGENTS.md` before substantial replacement work. Archive paths are rollback/reference only and must never be called by active workflows or scripts.

## Source and destination roles

R2 is the source of the history backup.

Dropbox is the independent backup destination.

The R2 backup inventory describes the current source objects and their stable source identities. The Dropbox backup state records which source identities have been copied and verified successfully.

The Dropbox state is not a second source inventory and must not be used to author or repair R2.

## Previous flat files

The previous v2 process used:

```text
R2 inventory:
history/_index_v2/backup_inventory_v2.json

Dropbox state:
_ops/checkpoints/r2_history_backup_state_v2.json
```

These flat files are not the final operational layout.

They may be read during first-run adoption so the replacement can recognise existing verified Dropbox data without recopying it merely because checkpoint representation changed.

They must not be rewritten by the hierarchical implementation.

After a valid hierarchical Dropbox root and required state shards exist, normal backup runs must use the hierarchical inventory and state only. They must not depend on the flat inventory or flat state as a parallel or fallback backup path.

## Hierarchical R2 backup inventory

The active inventory root is:

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

Observation run manifests use a small stable global inventory shard, for example:

```text
history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json
```

Small global units must not force unchanged observation month shards or binding range shards to be rewritten.

## Inventory root contents

The inventory root records at least:

- inventory schema version;
- backup version;
- observations source-root content hash;
- each observation year source hash;
- each observation month source hash and inventory shard path;
- the timeseries-binding inventory root identity;
- each timeseries-binding range source hash and inventory shard path, directly or through the binding root;
- observation run-manifest shard identity;
- stable source-derived generation evidence where required.

No wall-clock-only field may cause an unchanged inventory root or shard to change bytes.

## Observation inventory traversal

For observations, the inventory builder follows the authoritative source hierarchy:

```text
observations root
    -> changed year
        -> changed month
            -> changed day manifests
```

The builder compares stable parent content identities before opening children.

If the observations-root source identity is unchanged, no observation year, month or day traversal is required.

If the root changed, unchanged years are skipped. Within changed years, unchanged months are skipped. Only changed months require rebuilding the complete corresponding monthly inventory shard.

A changed month shard contains the complete current inventory state for that month, not only items changed in the current run.

The builder may use R2 metadata as a fast first comparison. It reads and hashes an object when metadata or parent identity indicates that it may have changed or when running an explicit full scan.

## Timeseries-binding inventory traversal

Physical binding objects remain at:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

The backup inventory groups those objects into stable 1,000-ID ranges without moving or renaming the physical binding objects.

Each range records the complete current set of binding identities in that range and a stable `source_range_hash`.

The binding inventory root records the current ranges and one stable `source_root_hash` derived from those range identities.

A normal inventory run may reuse a binding object's prior SHA-256 when current R2 metadata proves the object is unchanged. A changed binding must affect only its fixed range and the necessary parent root identities.

## Independent full-scan mode

The hierarchy is an optimisation, not the only verification method.

The inventory builder must retain an explicit full-scan mode that independently:

- enumerates all committed observation day manifests;
- rebuilds or compares every observation month shard;
- reads and hashes every current timeseries-binding object;
- validates the resulting inventory roots.

Normal hierarchical mode must fail clearly rather than silently trust malformed or contradictory parent manifests.

## Dropbox state layout

The active Dropbox checkpoint root is:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
```

Observation monthly state shards are:

```text
_ops/checkpoints/r2_history_backup_state_v2/observations/year=YYYY/month=MM.json
```

Timeseries-binding state shards mirror the fixed inventory ranges:

```text
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=000000-000999.json
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=001000-001999.json
...
```

Observation run-manifest state uses a small stable global shard, for example:

```text
_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json
```

No AQI-level, AQI-debug or core state shard belongs in the active hierarchical Dropbox checkpoint tree.

## Source and state hashes

For each observation month, R2 records the current source month hash in the inventory root.

Dropbox records the source month hash it has completely processed as:

```text
processed_source_month_hash
```

Matching hashes mean every required item represented by that source month version has been copied successfully.

For each timeseries-binding range, the Dropbox range state records:

```text
processed_source_range_hash
```

That hash may advance only when every binding required by the current R2 range has a matching successfully copied identity in the range state.

The Dropbox root records fully processed source hashes for observation years, the observations root and the timeseries-binding root as appropriate.

A separate hash of a Dropbox state shard itself may be recorded in the Dropbox root for checkpoint integrity. That state-shard hash is a Dropbox concern and need not be written back to R2.

## Observation monthly state contents

An observation monthly state shard records at least:

- year and month;
- each day manifest hash successfully processed;
- copy completion evidence for each day;
- the fully processed R2 source month hash;
- checkpoint schema version.

The state must be sufficient to resume a partial month without recopying days whose current manifest identities already match.

## Timeseries-binding range state contents

A binding range state shard records at least:

- range start and end;
- fixed range size;
- each successfully copied `timeseries_id` and source file hash;
- copy completion evidence for each binding;
- `processed_source_range_hash`;
- checkpoint schema version.

The range state must be sufficient to resume a partial range without recopying bindings whose current source hashes already match.

## Observation copy planning

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

After a changed day copy, manifest-guided stale Parquet pruning remains required so Dropbox removes superseded Parquet files no longer referenced by the copied manifests.

## Timeseries-binding copy planning

For bindings:

```text
binding root hash matches
    -> skip all binding ranges

root differs, range hash matches
    -> skip range

range differs, binding hash matches
    -> skip binding

binding differs or is missing
    -> copy that binding JSON file
```

A changed range must not cause unchanged ranges or unchanged binding files within the changed range to be recopied.

## Observation run manifests

Observation run manifests remain in active backup scope because they are operational evidence for the backed-up observation history.

The sync compares the stable run-manifest inventory shard with its Dropbox state shard and copies only changed or missing run-manifest JSON files.

Run-manifest state changes must not force observation month or binding range state shards to be rewritten.

## Failure and completion ordering

A monthly observation state shard may record individual day successes as they occur.

It must not advance `processed_source_month_hash` until every changed or missing day required for that month succeeds.

A binding range state shard may record individual binding successes as they occur.

It must not advance `processed_source_range_hash` until every current binding required for that range succeeds.

Year, observations-root and binding-root processed hashes advance only after all required child state is complete.

State shards are written before their parent root. The small Dropbox root is updated last.

On failure, already flushed successful unit identities may be retained safely, but incomplete parent processed hashes must not advance.

## Batched checkpoint writes

The sync must not upload a complete checkpoint after every copied item.

Checkpoint updates are accumulated and flushed:

- after a bounded batch of successful units;
- after a bounded elapsed interval;
- at phase boundaries;
- before a controlled failure exit when dirty state can be saved safely;
- at successful completion.

The implementation may configure different bounded batch sizes for observation days and timeseries-binding files when their unit sizes and run characteristics differ.

Once sharded state is active, only dirty shards and the small parent root are written. Unchanged historical shards are untouched.

## First-run state adoption and cutover

Cutover is a direct replacement, not a hybrid operating period.

Before substantial code replacement, archive the current active implementation according to `AGENTS.md`.

The first hierarchical run may read the previous flat v2 inventory and Dropbox state solely to adopt existing verified source identities into the new shards.

Adoption must be restartable and non-destructive. It must not force R2 data objects or Dropbox history data to be recopied merely because checkpoint representation changed.

The cutover sequence is:

1. deploy the hierarchical implementation under the established active production filenames;
2. read and validate the hierarchical R2 inventory;
3. where hierarchical Dropbox state is missing, adopt structurally matching identities from the previous flat state;
4. write required child state shards;
5. write the hierarchical Dropbox root last;
6. from that point, use only the hierarchical inventory and state for normal backup operation.

The active workflow must never run both the flat and hierarchical syncs for different domains or in parallel.

The old flat implementation survives only in the repository archive and Git history for rollback/reference. The old flat remote state may remain untouched as historical evidence but is not an active checkpoint after successful hierarchical cutover.

## Interaction with observation writers

Prune Daily and Integrity do not edit the backup inventory or Dropbox state while writing R2 observations.

They maintain the authoritative observation manifests, including month, year and observations-root hierarchy according to the observations hierarchy contract.

The inventory builder later discovers committed hierarchy state independently and updates its own backup inventory shards. This preserves separation between data writing and backup discovery.

The Dropbox backup is a read-only R2 consumer. It does not require the observations mutation lease merely to copy already committed R2 objects.

## Audit evidence

Each backup report records at least:

- inventory mode, hierarchical or full scan;
- observations source root hash;
- years and months inspected;
- years and months skipped by matching hash;
- changed observation days sent to rclone;
- stale Parquet files removed;
- timeseries-binding source root hash;
- binding ranges inspected and skipped;
- binding files copied;
- observation run manifests copied;
- dirty state shards written;
- checkpoint flush count;
- incomplete month, year, observations-root, binding-range or binding-root hashes;
- first-run legacy adoption mode when applicable.

The report must make it possible to distinguish source changes, copied units and checkpoint-only writes without reading the large state shards manually.

## Structural validation policy

Before deployment, perform only the smallest checks required to establish structural viability of the changed code and configuration.

At minimum the implementation structure must preserve these invariants:

- unchanged source hierarchy produces unchanged inventory root and shards;
- a one-day observation change affects only its month shard and necessary ancestor identities;
- a binding change affects only its fixed range and necessary ancestor identities;
- a partial observation month does not advance its processed month hash;
- a partial binding range does not advance its processed range hash;
- successful flushed unit progress survives restart;
- batching prevents per-unit whole-checkpoint uploads;
- first-run adoption preserves structurally valid existing verified identities without recopying data;
- the active workflow contains no AQI-level, AQI-debug or core backup path;
- the active workflow invokes one hierarchical builder and one hierarchical sync only.

Functional acceptance occurs through real TEST inventory and Dropbox backup operation after deployment. Broad pre-deployment test suites are not required by this contract.
