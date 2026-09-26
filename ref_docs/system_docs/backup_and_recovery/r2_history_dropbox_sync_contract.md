# R2 history Dropbox sync and checkpoint contract

## Authority and relationship

This contract owns the **Dropbox-side hierarchical checkpoint, copy, prune and completion behaviour** for the R2 history backup.

Read [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md) first for shared scope, source/destination authority, direct-replacement rules and restore boundaries. Read [`r2_history_backup_inventory_contract.md`](r2_history_backup_inventory_contract.md) when changing the R2 inventory produced for this sync.

The observation-history index-v3 amendment in [`r2_history_index_v3_backup_amendment.md`](r2_history_index_v3_backup_amendment.md) is the narrower authority for the compact latest-timeseries unit across v2/v3 index cut-over.

The packed `timeseries_binding` representation in [`r2_history_timeseries_binding_pack_backup_contract.md`](r2_history_timeseries_binding_pack_backup_contract.md) is the narrower authority for current TEST binding backup. Phase 1 through Phase 5 are accepted on TEST, and scheduled/default TEST binding authority is now `pack`. Manual `individual` remains a bounded rollback option; LIVE adoption is separate.

Implementation owner:

```text
scripts/backup_r2/sync_history_to_dropbox.mjs
```

## Dropbox state layout

The active checkpoint root is:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
```

Observation state shards are monthly:

```text
_ops/checkpoints/r2_history_backup_state_v2/observations/year=YYYY/month=MM.json
```

In `individual` binding mode, timeseries-binding state shards mirror the fixed 1,000-ID inventory ranges:

```text
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=000000-000999.json
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=001000-001999.json
...
```

In `pack` binding mode, which is now the scheduled/default TEST mode, completion evidence is separate and uses:

```text
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding_packs/range=000000-000999.json
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding_packs/range=001000-001999.json
...
```

The top-level root records the selected binding representation using distinct `timeseries_binding` and `timeseries_binding_packs` identities. Completion evidence for one representation MUST NOT be reinterpreted as completion evidence for the other.

Observation run manifests use one small stable global state shard, for example:

```text
_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json
```

The authority-selected compact latest-timeseries unit MAY be represented directly in the small state root or in one stable global state shard. Its state MUST record at least exact source path, SHA-256, byte size and successful completion evidence.

Core MAY use a compact root section or one stable dedicated state shard. Core MUST NOT be split into timeseries-ID ranges and a core change MUST NOT rewrite observation-month or binding-range state shards.

No AQI-level or AQI-debug state shard belongs in the active checkpoint tree.

## Source and processed identities

For observations, Dropbox records the source month identity it has completely processed as `processed_source_month_hash`.

For each individual binding range, Dropbox records `processed_source_range_hash` under the legacy `timeseries_binding` state.

For packed bindings, Dropbox records the authoritative source-range identity plus exact pack identity, including pack SHA-256, size and member count, under the distinct `timeseries_binding_packs` state defined by the pack contract.

The compact latest-timeseries processed identity MUST advance only after copy and source/destination SHA-256 verification have succeeded.

Core state MUST retain enough stable source identity to distinguish complete current processing from partial or older processing.

The root records fully processed parent identities for observations, the selected binding representation, the compact latest-timeseries unit, and core as appropriate.

A hash of a Dropbox state shard MAY be stored in the Dropbox root for checkpoint integrity. That state-shard hash is Dropbox state and need not be written back to R2.

## Observation monthly state

Each observation month shard MUST record at least:

- year and month;
- day manifest identities successfully processed;
- copy-completion evidence per day;
- the fully processed R2 source month hash;
- checkpoint schema version.

The state MUST permit restart of a partial month without recopying days whose current source identities already match successfully completed state.

## Individual timeseries-binding range state

In `individual` mode, each range shard MUST record at least:

- range start/end and fixed range size;
- successfully copied `timeseries_id` values and source file hashes;
- copy-completion evidence;
- `processed_source_range_hash`;
- checkpoint schema version.

The state MUST permit restart of a partial range without recopying bindings whose current source hashes already match successfully completed state.

## Packed timeseries-binding range state

In `pack` mode, the separate `timeseries_binding_packs` state MUST follow the packed-binding contract. Each occupied range records the authoritative source-range hash and exact current pack identity, and the top-level pack state records the current binding source-root and pack-root identities.

A verified individual range MUST NOT satisfy a packed range, and a verified packed range MUST NOT satisfy an individual range.

Pack state is complete only when the current pack generation has been physically verified at the Dropbox destination according to the pack contract. If the destination pack root is missing or mismatched, prior checkpoint evidence alone is insufficient and the current child pack identities MUST be re-established before the pack root is published.

## Compact latest-timeseries copy

The source path is selected by persistent observation-history index authority under the v3 backup amendment.

Copy planning is:

```text
selected source path + SHA-256 already processed successfully
    -> skip copy

selected source differs or destination is missing
    -> copy JSON
    -> verify source and destination SHA-256
    -> record successful exact source identity
```

The existing verified JSON-copy mechanism or an equivalent copy-and-verify path MUST be used.

If copy or verification fails:

- previous successful processed identity remains intact;
- the run is incomplete;
- current-complete parent state MUST NOT advance.

A backup cannot be complete for the current inventory until the authority-selected compact unit has been copied and verified.

### Derived observation-timeseries trees remain excluded

The normal Dropbox sync MUST NOT recursively enumerate or bulk-copy either derived tree:

```text
history/_index_v2/observations_timeseries/
history/_index_v3/observations_timeseries/
```

The authority-selected compact latest-timeseries object is the only observation-timeseries index object required by this sync contract. Derived v3 scoped/exact index objects remain rebuildable data and are not copied merely to support SOS-light.

## Observation copy planning

The sync compares inventory identities with processed Dropbox state:

```text
year hash matches
    -> skip year

year differs, month hash matches
    -> skip month

month differs, day hash matches
    -> skip day

day differs
    -> rclone complete day prefix
```

A changed day is copied from:

```text
history/v2/observations/day_utc=YYYY-MM-DD/
```

Rclone compares individual files so unchanged connector/pollutant/manifest/Parquet files are skipped and only changed or missing files transfer.

After a changed-day copy, manifest-guided stale Parquet pruning remains required so Dropbox removes superseded Parquet files no longer referenced by current copied manifests.

### Observation Parquet copy modes

The observation day-copy path MUST support:

```text
--observation-parquet-copy-mode full
--observation-parquet-copy-mode reuse_matching
```

If the option is absent, the effective mode MUST be `full`.

The GitHub workflow MUST expose the equivalent dispatch input:

```text
observation_parquet_copy_mode
```

with the same accepted values and default `full`. Scheduled or manual calls that omit the input therefore retain today's complete-day rclone behaviour.

#### `full`

`full` retains the existing changed-day copy behaviour. A changed day is supplied to the normal complete-prefix rclone copy path and rclone decides which individual files transfer according to its ordinary cross-remote comparison behaviour.

The backup MUST NOT assume that byte-identical R2 and Dropbox Parquet files will be skipped in this mode. R2 and Dropbox do not provide one common native checksum suitable for this canonical SHA-256 decision, and SOS-light complete-day republication can give byte-identical R2 objects new remote modification metadata.

#### `reuse_matching`

`reuse_matching` MAY avoid retransferring an observation Parquet body only when the backup can prove that the already accepted Dropbox body represents exactly the same canonical object identity as the current R2 source.

For one Parquet key to be reusable, all of the following MUST be true:

- the current authoritative R2 pollutant manifest references the key;
- the current manifest supplies a valid canonical byte size and SHA-256 for that key;
- the preceding accepted Dropbox baseline contains an authenticated prior manifest/reference for the same key;
- the prior accepted reference has the same byte size and the same canonical SHA-256;
- the preceding Dropbox day/checkpoint evidence that authenticated that reference is still the accepted predecessor state for this backup;
- the destination file still exists at the expected path and has the expected byte size;
- no contradictory manifest, stale-object or generation evidence exists.

A missing file, missing prior authority, size mismatch, SHA-256 mismatch, ambiguous reference, unsupported manifest form or any other inability to prove exact reuse MUST fail closed to **copying that Parquet body normally**, not to accepting an unverified skip.

The optimisation MUST compare canonical identities from the authoritative manifests/checkpoint evidence. It MUST NOT use modification time, ETag equality, filename alone, size alone, `--size-only`, or a cross-remote rclone checksum fallback as proof of canonical equality.

The existing Dropbox Parquet body is allowed to retain its older Dropbox modification time when it is reused. The current R2 object's newer remote `Last-Modified` timestamp is transport metadata and is not part of canonical observation identity.

The canonical post-Integrity publication state remains observable through the newly copied canonical metadata, including as applicable `backed_up_at_utc`, `writer_git_sha`, changed manifest hashes and the changed parent/root identities. These fields do not purport to preserve the literal R2 `Last-Modified` timestamp.

When the Parquet body identity is unchanged, a restore from Dropbox remains exact because the destination contains the same key and the same authenticated bytes referenced by the new manifests. Reusing those bytes is therefore a transfer optimisation, not a stale-data exception.

For a changed day in `reuse_matching` mode:

1. identify reusable Parquet bodies from the preceding accepted Dropbox baseline using the rules above;
2. copy any new or changed Parquet bodies;
3. copy the current canonical pollutant/connector/day metadata required by the normal day copy;
4. run the existing manifest-guided stale-Parquet pruning;
5. verify the destination current day manifest against the source inventory identity;
6. only then mark the new day identity processed and allow month/year/root checkpoint advancement.

The normal backup completion rule remains unchanged: Dropbox checkpoint/root state represents the **current R2 source root**, even when some physical Parquet bodies were reused from the preceding accepted Dropbox baseline.

The serial monthly SOS-light wrapper SHOULD explicitly request `reuse_matching` for the post-month backup that refreshes Dropbox before the next month begins. Other callers remain `full` when they omit the mode.

## Forced observation prune recheck

The active sync MUST retain the operator input `force_prune_recheck` for an explicit observation-only destination-integrity sweep.

When true, the sync audits current observation days represented by the authoritative hierarchical inventory even when source and processed year/month/day hashes match.

For each audited day it compares current observation manifests with actual Dropbox Parquet files and removes stale destination Parquet objects not referenced by those manifests.

A forced prune recheck:

- MUST NOT recopy an otherwise unchanged day merely to audit it;
- MUST NOT advance or invalidate processed source hashes solely because the audit ran;
- applies to observations only;
- MUST NOT prune/reinterpret bindings, run manifests, compact latest-timeseries or core;
- MUST make the workflow/report unsuccessful if an audited day fails, identifying that day;
- MAY retain previously completed valid copy state from earlier phases.

## Timeseries-binding copy planning

In `individual` mode, retained for bounded rollback/manual use, binding copy planning remains:

```text
binding root hash matches
    -> skip all ranges

root differs, range hash matches
    -> skip range

range differs, binding hash matches
    -> skip binding

binding differs or destination is missing
    -> copy that binding JSON
```

A changed range MUST NOT cause unchanged ranges or unchanged bindings within the changed range to be recopied.

In `pack` mode, now the normal scheduled/default TEST binding payload planner, the individual planner above is not active. The pack contract owns range/pack planning:

```text
current pack source root and verified destination pack root match
    -> skip pack transfer work

root differs but a range's source and pack identities match current verified state
    -> skip that range

range differs or current destination pack is absent/mismatched
    -> copy and verify only that current pack
```

Pack mode MUST NOT silently fall back to individual binding copying. `--timeseries-binding-packs-only` remains a bounded proving option and is not part of the normal full scheduled backup.

## Core copy planning

Core remains incremental and inventory-driven:

```text
current core identity matches processed state
    -> skip core copy work

core identity differs
    -> compare individual current core units with state

unit matches
    -> skip unit

unit differs or destination is missing
    -> copy unit
```

A core change MUST NOT cause observation days, observation run manifests, compact latest-timeseries or binding files to be recopied.

## Core pruning is deferred

Until a later active contract defines safe core retention/deletion:

- existing core Dropbox backup coverage MUST be preserved;
- changed or missing core units MAY be copied;
- destination core objects MUST NOT be deleted merely because they are absent from the latest inventory;
- generic stale-file pruning MUST NOT be applied to core by analogy with observation Parquet pruning.

## Observation run manifests

Observation run manifests remain mandatory backup evidence.

The sync compares the stable run-manifest inventory unit with Dropbox state and copies only changed or missing run-manifest JSON files.

A run-manifest state change MUST NOT force observation-month, binding-range, compact latest-timeseries or core state rewrites.

## Failure and completion ordering

A monthly observation shard MAY record individual day successes as they occur, but MUST NOT advance `processed_source_month_hash` until all required current day work succeeds.

An individual binding range shard MAY record individual binding successes, but MUST NOT advance `processed_source_range_hash` until every current required binding succeeds.

A packed binding range/root MUST advance only under the child-before-root verification and completion rules in the packed-binding contract. Incomplete packed child work MUST NOT publish a current pack parent/root identity.

The compact latest-timeseries processed identity MUST NOT advance until copy and SHA-256 verification succeed.

Core MAY record unit successes incrementally, but any aggregate processed core identity MUST NOT advance until all required changed/missing core work succeeds.

Parent identities advance only after their required child work is complete.

State shards MUST be written before their parent root. The small Dropbox root is written last.

On failure, already flushed successful unit identities MAY be retained, but incomplete parent processed identities MUST NOT advance.

## Batched checkpoint writes

The sync MUST NOT upload a complete checkpoint after every copied unit.

Dirty state is accumulated and flushed at bounded points such as:

- after a bounded batch of successful units;
- after a bounded elapsed interval;
- at phase boundaries;
- before controlled failure exit when dirty state can be saved safely;
- at successful completion.

Only dirty shards and the small parent root are written. Unchanged historical shards remain untouched.

## Fresh start

There is no flat-state adoption phase.

If current hierarchical Dropbox state does not exist, the sync starts from the current hierarchical R2 inventory and empty current hierarchical state.

Existing matching Dropbox data MAY be skipped only when the normal destination/hash verification mechanism proves the current source identity. Obsolete flat inventory/checkpoint files are not authority.

For pack mode, prior pack checkpoint evidence is previous evidence only when the current destination root cannot authenticate the same generation. The pack contract's destination re-verification rule applies before current root completion.

## Interaction with R2 writers

The backup sync is a read-only R2 consumer.

Prune Daily and Integrity own observation/source-manifest mutation; timeseries-binding reconciliation owns binding objects/source manifests; observation index finalisation owns the compact latest-timeseries object.

The backup MUST NOT author or repair those R2 products as part of copy processing and does not require the observation mutation lease merely to copy already committed objects.

The pack publisher is a backup derivative publisher and may write only its own pack namespace before inventory/sync consumes the resulting verified pack generation. It does not alter binding source authority.

## Sync audit evidence

Each backup report MUST expose enough evidence to explain copy/prune/checkpoint behaviour, including as applicable:

- selected observation Parquet copy mode and whether it was explicit or defaulted;
- changed observation days selected for backup;
- observation Parquet bodies reused because key + byte size + canonical SHA-256 matched the preceding accepted Dropbox baseline;
- total bytes whose transfer was avoided by exact Parquet reuse;
- observation Parquet bodies copied because they were new, changed or not safely reusable;
- total observation Parquet bytes actually copied where available;
- any reuse candidates that fell back to normal copy because proof was incomplete or contradictory;
- stale observation Parquet files removed;
- whether forced prune recheck was requested;
- days audited by forced prune recheck, removals and failures;
- selected binding backup mode;
- individual binding files copied when `individual` is selected;
- pack ranges total/skipped/copied and pack bytes copied when `pack` is selected;
- whether individual binding payload copying was skipped in `pack` mode;
- observation run manifests copied;
- compact latest-timeseries source path, SHA-256, byte size and skipped/copied/verified status;
- compact latest-timeseries processed identity;
- core units skipped/copied and processed identity where used;
- dirty state shards written;
- checkpoint flush count;
- incomplete observation/binding/compact/core parent identities.

Legacy-adoption reporting MUST NOT be reintroduced.

## TEST pack-mode evidence

On 04/09/2026 the normal TEST Dropbox destination was completed in full `pack` mode and published a valid top-level hierarchical state root containing `timeseries_binding_packs` plus the normal non-binding backup domains.

A manually dispatched GitHub-hosted normal backup then selected `pack` against the normal TEST destination and completed successfully through the ordinary workflow/task-health path. The unchanged binding generation reused all 143 packs, rebuilt 0, copied 0 packs and 0 pack bytes, while observations/core/run manifests/latest-timeseries were also already current or skipped as appropriate.

That successful GitHub-hosted run recorded a fresh normal `ops.r2_history_dropbox_backup` task-health result, which then allowed the ordinary Integrity Dropbox freshness gate to pass without `--allow-stale-dropbox`.

Phase 4 then proved that this exact normal TEST packed generation is recoverable. A dry-run authenticated all 143 ranges and 6,265 members and reconstructed the authoritative source-root hash with no destination writes. The real isolated TEST restore wrote and readback-verified all 6,265 individual binding objects, rebuilt and readback-verified all 143 source range manifests, reproduced the authoritative source-root hash and published/readback-verified the source root last. During the real operation the source root remained absent after all 6,265 member objects were present while only 64/143 range manifests had been published.

The runtime-consumer audit confirmed that request-time consumers continue to use individual R2 binding paths and do not consume the pack namespace.

Phase 5 was then operationally accepted through GitHub Actions run `33923153503`. The normal scheduler/external dispatch supplied no binding-mode override, so the workflow resolved its default to `pack`. The run used the full backup path (`timeseries_binding_packs_only = false`), reused all 143 current packs, rebuilt and copied 0 unchanged packs, kept observations/core/run manifests/latest-timeseries complete and successfully completed the normal task-health lifecycle. This establishes `pack` as the scheduled/default TEST binding transport authority.

Manual `individual` remains available for bounded rollback during the observation period. Its checkpoint evidence remains distinct and MUST NOT be substituted for current packed completion evidence.

## Structural validation

Before deployment, use only the smallest checks needed to establish structural viability of sync changes.

The implementation MUST preserve the relevant properties below:

- omitting observation Parquet copy mode resolves to `full`;
- explicit `full` preserves the current changed-day copy behaviour;
- `reuse_matching` reuses a Parquet body only when the current and preceding accepted canonical key + byte size + SHA-256 identities agree and destination presence/size is consistent;
- uncertain or contradictory reuse evidence falls back to normal copy rather than accepting a skip;
- reused Parquet may retain an older Dropbox modification time without changing canonical backup correctness;
- current manifests/day identities and the final checkpoint/root still advance to the current R2 source state after successful `reuse_matching`;
- stale-Parquet pruning still executes for changed days under both observation Parquet copy modes;
- unchanged compact latest-timeseries content is not recopied;
- compact processed state advances only after source/destination SHA-256 verification;
- previous state for one compact-summary generation cannot satisfy another generation under the v3 amendment;
- the normal backup does not recursively inventory or copy derived observation-timeseries trees;
- a core change does not trigger observation/binding copies;
- partial observation months do not advance processed month hash;
- partial individual binding ranges do not advance processed range hash;
- pack mode uses separate pack completion evidence and does not require/reinterpret individual binding completion;
- individual mode remains fail-closed on incomplete individual binding evidence even when packs are present;
- pack mode fails closed when required pack evidence is absent or malformed;
- incomplete core work does not advance aggregate processed core identity;
- successfully flushed unit progress survives restart;
- batching prevents per-unit whole-checkpoint uploads;
- no flat state adoption/compatibility/fallback path is active;
- `force_prune_recheck` audits matching observation days without recopying them or changing processed hashes solely because of the audit;
- forced prune does not affect bindings, run manifests, compact latest-timeseries or core;
- no AQI-level/AQI-debug backup path is active;
- core coverage remains active without core pruning.

The PR #69 scoped-root backup expansion was reverted on 18/09/2026. The resulting normal backup scope is the intended active design.

Functional acceptance occurs through real TEST Dropbox backup operation after deployment. Broad speculative pre-deployment test suites are not required.
