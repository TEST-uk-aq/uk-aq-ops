# R2 v2 history Dropbox backup

## Authority and scope

This document defines the authoritative backup inventory, Dropbox checkpoint and incremental-copy contract for R2 v2 history.

The Phase B observations backup is mandatory. Optimisation must preserve complete observation backup coverage and must not disable, skip or reduce required observation history data.

The active Dropbox backup scope is deliberately limited to:

```text
history/v2/observations
history/v2/_ops/observations/runs
history/_index_v2/timeseries_binding
history/v2/core
```

This means the Dropbox history backup must cover:

- committed v2 observation day folders, including their manifests and Parquet objects;
- the v2 observations month, year and root aggregate manifest hierarchy;
- v2 observation run manifests;
- v2 timeseries-binding JSON objects;
- v2 core history objects under `history/v2/core`.

The following are explicitly out of scope for this Dropbox history backup and must not be copied, inventoried or checkpointed by the active backup implementation:

```text
history/v2/aqilevels
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

Derived AQI levels and AQI debug history are no longer part of the Dropbox backup requirement.

R2 core history remains part of the Dropbox backup requirement. Core does not require observation month sharding or timeseries-ID range sharding. It may remain represented as a compact non-range inventory/state section or one stable dedicated core shard, provided core changes do not force unchanged observation month shards or timeseries-binding range shards to be rewritten.

Core pruning is intentionally deferred. The active backup must continue preserving core coverage, but this contract does not yet authorise deletion of stale Dropbox core objects. A later contract update must define the authoritative core pruning rule before the backup implementation deletes destination core objects.

The only `_index_v2` data objects in active Dropbox backup scope are the physical timeseries-binding objects required to preserve observation timeseries identity. Other historical index trees are not part of this backup unless a later contract explicitly adds them.

The observations source hierarchy is defined in:

- [`../r2_history/observations_manifest_hierarchy_contract.md`](../r2_history/observations_manifest_hierarchy_contract.md).

The observations run-level mutation exclusion contract is defined in:

- [`../r2_history/observations_run_exclusion_contract.md`](../r2_history/observations_run_exclusion_contract.md).

The authoritative physical timeseries-binding and binding source-manifest hierarchy is defined in:

- [`../r2_history/contract.md`](../r2_history/contract.md).

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

Authoritative source hierarchies such as the observations aggregate manifests and timeseries-binding `_manifests` tree belong to the R2 source data contract. The backup inventory consumes those source hierarchies; it does not author or repair them during a normal backup inventory run.

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

Timeseries-binding backup inventory shards are stored as fixed ID ranges:

```text
history/_index_v2/backup_inventory_v2/timeseries_binding/root.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=000000-000999.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json
...
```

Those backup inventory shards are derived from the authoritative binding source hierarchy:

```text
history/_index_v2/timeseries_binding/_manifests/root.json
history/_index_v2/timeseries_binding/_manifests/range=000000-000999.json
history/_index_v2/timeseries_binding/_manifests/range=001000-001999.json
...
```

The fixed binding range size is 1,000 timeseries IDs in both source and backup hierarchies. Range boundaries must remain stable after deployment unless a separately documented migration changes them.

Observation run manifests use a small stable global inventory shard, for example:

```text
history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json
```

Core does not use timeseries-ID ranges. Its current backup inventory may remain a compact non-range section of the root or one stable dedicated core shard. Core inventory identity must be source-derived and byte-stable when the underlying core backup objects have not changed.

Small global or core units must not force unchanged observation month shards or binding range shards to be rewritten.

## Inventory root contents

The inventory root records at least:

- inventory schema version;
- backup version;
- observations source-root content hash;
- each observation year source hash;
- each observation month source hash and inventory shard path;
- the authoritative timeseries-binding source-manifest root identity;
- the timeseries-binding backup inventory root identity;
- each timeseries-binding range source hash and backup inventory shard path, directly or through the binding root;
- observation run-manifest shard identity;
- current core backup identity and any core shard path when a separate core shard is used;
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

Normal backup inventory traversal must use the authoritative binding source hierarchy, not a full listing of the physical binding prefix.

The normal path is:

```text
read binding source root
    -> source_root_hash matches previous backup inventory source identity
        -> reuse complete previous binding backup inventory root/ranges
        -> do not list physical bindings
        -> do not read range manifests

source root changed
    -> compare source range hashes with previous backup range identities
        -> unchanged range hash
            -> reuse previous backup range shard without opening physical bindings
        -> changed/new range hash
            -> read authoritative source range manifest
            -> rebuild/write only that backup inventory range shard
```

A normal hierarchical inventory run must therefore perform **zero complete physical binding-prefix listings** when the authoritative source hierarchy is valid. It must not list all `timeseries_id=<id>.json` objects merely to prove that unchanged source range hashes are unchanged.

A changed source range manifest already contains the complete current physical binding identities for that fixed range. The backup builder may copy those stable identities into its own range representation without re-reading the physical binding JSON files.

The binding backup inventory root records the current ranges and one stable `source_root_hash` corresponding to the authoritative binding source root. A changed binding must affect only its fixed source range, corresponding backup range and necessary parent roots.

If the authoritative binding source root or a referenced range manifest is missing, malformed or contradictory, normal hierarchical mode must fail clearly. It must not silently fall back to a 6,000+ object physical listing. Recovery is an explicit binding source-hierarchy bootstrap/rebuild or full-scan verification operation.

## Core inventory traversal

Core remains a backed-up domain but is not large enough to require binding-style range partitioning.

The inventory builder must retain the current source identities needed to determine which core objects are unchanged, changed or missing in Dropbox. It may reuse previous verified hashes when current R2 metadata proves an object is unchanged.

A core change must update only the compact core inventory representation and the necessary parent root identity. It must not rewrite observation month inventory shards or timeseries-binding range inventory shards.

## Independent full-scan mode

The hierarchy is an optimisation, not the only verification method.

The inventory builder must retain an explicit full-scan mode that independently:

- enumerates all committed observation day manifests;
- rebuilds or compares every observation month shard;
- enumerates every physical timeseries-binding object;
- reads and hashes every current physical timeseries-binding object;
- independently rebuilds the expected binding source range/root identities and compares them with the authoritative binding source hierarchy;
- enumerates and verifies the current in-scope core backup objects;
- validates the resulting backup inventory roots.

A dedicated binding source-hierarchy bootstrap/rebuild operation may perform the same expensive physical binding enumeration without running the complete backup full scan.

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

Core may use a compact `core` section in the small root or one stable dedicated core state shard. It must not be split into timeseries-ID ranges and it must not cause observation month or binding range state shards to be rewritten.

No AQI-level or AQI-debug state shard belongs in the active hierarchical Dropbox checkpoint tree.

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

Core state must retain enough stable source identity to distinguish a completely processed current core inventory from a partial or older one. If a compact core source hash is used, its processed hash must advance only after every required current core unit has copied successfully.

The Dropbox root records fully processed source hashes for observation years, the observations root, the timeseries-binding root and core as appropriate.

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

## Core state contents

Core state records the successfully copied current identities for in-scope core objects and enough completion evidence to resume after interruption without recopying unchanged core objects.

Core state may remain compact because core does not require range sharding. Its representation must nevertheless be deterministic and must not trigger unrelated observation or binding checkpoint rewrites.

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

## Forced observation prune recheck

The active backup must retain a `force_prune_recheck` operator input for an explicit observation-only destination integrity sweep.

A forced prune recheck is independent of normal hierarchical copy planning. When `force_prune_recheck=true`, the sync must inspect current observation days represented by the authoritative hierarchical inventory even when the year, month and day source hashes already match Dropbox state.

For each audited observation day, the sync compares the authoritative current observation manifests with the actual Parquet files present in the corresponding Dropbox day prefix and removes stale destination Parquet files that are no longer referenced by those manifests.

The forced sweep must not recopy an otherwise unchanged observation day merely to perform the prune audit, and it must not invalidate or advance observation processed hashes solely because an audit ran. Normal changed-day copy-and-prune behaviour remains unchanged.

The forced sweep is observations-only. It must not prune, recopy or reinterpret timeseries-binding, observation run-manifest or core objects. In particular, `force_prune_recheck` does not authorise core pruning; core pruning remains deferred under this contract.

A forced prune sweep failure must make the workflow/report unsuccessful and identify the affected observation day, but successfully completed backup copy state from earlier phases remains valid.

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

## Core copy planning

Core remains incremental and inventory-driven.

For core:

```text
current core identity matches processed core state
    -> skip core copy work

core identity differs
    -> compare current core units with recorded Dropbox state

core unit matches
    -> skip unit

core unit differs or is missing
    -> copy that core unit
```

A core change must not cause observation days, observation run manifests or timeseries-binding files to be recopied.

## Core pruning is deferred

The replacement described by this contract does not implement core pruning.

Until a later contract defines safe core retention and deletion rules:

- existing core Dropbox backup coverage must be preserved;
- changed or missing core units may be copied according to the current inventory;
- the active backup must not delete destination core objects merely because they are absent from the latest core inventory;
- no generic stale-file pruning rule may be applied to core by analogy with observation Parquet pruning.

This deferred pruning work must be treated separately from the current hierarchical direct replacement.

## Observation run manifests

Observation run manifests remain in active backup scope because they are operational evidence for the backed-up observation history.

The sync compares the stable run-manifest inventory shard with its Dropbox state shard and copies only changed or missing run-manifest JSON files.

Run-manifest state changes must not force observation month, binding range or core state shards to be rewritten unnecessarily.

## Failure and completion ordering

A monthly observation state shard may record individual day successes as they occur.

It must not advance `processed_source_month_hash` until every changed or missing day required for that month succeeds.

A binding range state shard may record individual binding successes as they occur.

It must not advance `processed_source_range_hash` until every current binding required for that range succeeds.

Core state may record individual unit successes as they occur, but any aggregate processed core identity must not advance until every required changed or missing core unit succeeds.

Year, observations-root, binding-root and core processed identities advance only after all required child state is complete.

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

The implementation may configure different bounded batch sizes for observation days and timeseries-binding files when their unit sizes and run characteristics differ. Core is compact and may normally flush at its phase boundary, but it must not reintroduce repeated whole-root uploads after individual units.

Once sharded state is active, only dirty shards and the small parent root are written. Unchanged historical shards are untouched.

## First-run state adoption and cutover

Cutover is a direct replacement, not a hybrid operating period.

Before substantial code replacement, archive the current active implementation according to `AGENTS.md`.

The first hierarchical run may read the previous flat v2 inventory and Dropbox state solely to adopt existing verified source identities into the new state representation, including valid existing core identities.

Adoption must be restartable and non-destructive. It must not force R2 data objects or Dropbox history data to be recopied merely because checkpoint representation changed.

The cutover sequence is:

1. deploy the hierarchical implementation under the established active production filenames;
2. read and validate the hierarchical R2 inventory;
3. where hierarchical Dropbox state is missing, adopt structurally matching identities from the previous flat state;
4. write required child state shards or compact core state;
5. write the hierarchical Dropbox root last;
6. from that point, use only the hierarchical inventory and state for normal backup operation.

The active workflow must never run both the flat and hierarchical syncs for different domains or in parallel.

The old flat implementation survives only in the repository archive and Git history for rollback/reference. The old flat remote state may remain untouched as historical evidence but is not an active checkpoint after successful hierarchical cutover.

## Interaction with observation and binding writers

Prune Daily and Integrity do not edit the backup inventory or Dropbox state while writing R2 observations.

They maintain the authoritative observation manifests, including month, year and observations-root hierarchy according to the observations hierarchy contract.

Timeseries-binding reconciliation maintains the authoritative binding physical objects and source range/root manifests according to the stable binding contract. It does not edit the Dropbox backup inventory or Dropbox state.

The inventory builder later consumes those committed source hierarchies independently and updates its own backup inventory shards. This preserves separation between data writing and backup discovery.

The Dropbox backup is a read-only R2 consumer. It does not require the observations mutation lease merely to copy already committed R2 objects.

## Audit evidence

Each backup report records at least:

- inventory mode, hierarchical or full scan;
- observations source root hash;
- years and months inspected;
- years and months skipped by matching hash;
- changed observation days sent to rclone;
- stale observation Parquet files removed;
- whether forced observation prune recheck was requested;
- observation days audited by a forced prune recheck, stale files removed and any failed day audits;
- authoritative timeseries-binding source-manifest root key and source root hash;
- whether the complete physical binding listing was skipped;
- binding source ranges inspected and skipped by matching hash;
- binding backup inventory range shards changed/written;
- binding files copied;
- observation run manifests copied;
- core units listed, skipped and copied;
- core source/processed identity where used;
- dirty state shards written;
- checkpoint flush count;
- incomplete month, year, observations-root, binding-range, binding-root or core identities;
- first-run legacy adoption mode when applicable.

The report must make it possible to distinguish source changes, copied units, forced prune-only work and checkpoint-only writes without reading the state shards manually.

## Structural validation policy

Before deployment, perform only the smallest checks required to establish structural viability of the changed code and configuration.

At minimum the implementation structure must preserve these invariants:

- unchanged source hierarchy produces unchanged inventory root and shards;
- a one-day observation change affects only its month shard and necessary ancestor identities;
- an unchanged authoritative binding source-root hash causes zero complete physical binding-prefix listings in normal inventory mode;
- a binding change affects only its fixed source range, matching backup range and necessary ancestor identities;
- unchanged binding source ranges are not opened or rewritten merely because another range changed;
- a missing or contradictory binding source hierarchy fails normal inventory clearly instead of falling back to a complete physical listing;
- explicit binding bootstrap/full-scan remains capable of enumerating and hashing every physical binding independently;
- retained stale physical binding objects remain represented by the authoritative binding source hierarchy until explicitly removed under a separate contract;
- a core change does not force observation month or binding-range rewrites;
- a partial observation month does not advance its processed month hash;
- a partial binding range does not advance its processed range hash;
- incomplete core copy work does not advance a current aggregate core processed identity;
- successful flushed unit progress survives restart;
- batching prevents per-unit whole-checkpoint uploads;
- first-run adoption preserves structurally valid existing verified identities without recopying data;
- `force_prune_recheck` can audit hash-matching observation days without recopying them or changing processed source hashes solely because of the audit;
- `force_prune_recheck` does not prune timeseries bindings, run manifests or core;
- the active workflow contains no AQI-level or AQI-debug backup path;
- the active workflow retains core backup coverage without implementing core pruning;
- the active workflow invokes one hierarchical builder and one hierarchical sync only.

Functional acceptance occurs through real TEST inventory and Dropbox backup operation after deployment. Broad pre-deployment test suites are not required by this contract.
