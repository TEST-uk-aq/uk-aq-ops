# R2 history Dropbox backup amendment for observation-history index v3

## Authority and scope

This document is the authoritative narrow amendment for how the existing R2 logical-v2 history Dropbox backup selects and verifies the compact observation-timeseries operational summary across the observation-history index-v3 cut-over.

It amends, only for this scope:

- [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md);
- [`../r2_history/observation_history_index_v3_migration_contract.md`](../r2_history/observation_history_index_v3_migration_contract.md);
- [`../r2_history/observation_history_index_v3_operator_contract.md`](../r2_history/observation_history_index_v3_operator_contract.md).

Where the broad Dropbox backup contract hard-codes the v2 compact observation-timeseries summary, this amendment governs once the persistent observation-timeseries authority is v3.

This amendment does **not** change the logical history version from v2. It does not move timeseries binding, core history, observation run manifests or canonical observations into a logical v3 history domain.

## Logical backup identity remains v2

The canonical logical observation history remains:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

The existing hierarchical backup inventory/checkpoint design remains the logical-v2 history backup design. The existing format-generation roots remain valid unless a separate migration explicitly changes them, but they live in different systems:

```text
R2 source-inventory control product:
  history/_index_v2/backup_inventory_v2/root.json

Dropbox destination checkpoint/state:
  _ops/checkpoints/r2_history_backup_state_v2/root.json
```

The R2 inventory root and its shards MUST remain in R2 and are not normal Dropbox backup payload. Tooling MUST NOT construct `<Dropbox root>/history/_index_v2/backup_inventory_v2/root.json` and treat its absence as backup incompleteness.

The `_index_v2` text in those backup-inventory/checkpoint paths identifies the existing backup-format generation. It MUST NOT be interpreted as permission to keep using the v2 observation-timeseries summary after observation-timeseries authority has moved to v3.

A separate backup-format migration is not required merely because the compact observation-timeseries summary changes generation.

## Observation-timeseries compact-summary authority

The active compact observation-timeseries summary selected by the backup MUST follow the persistent observation-history index authority:

```text
UK_AQ_R2_HISTORY_INDEX_VERSION=v2
    -> history/_index_v2/observations_timeseries_latest.json

UK_AQ_R2_HISTORY_INDEX_VERSION=v3
    -> history/_index_v3/observations_timeseries_latest.json
```

No other value is valid for this selector. Empty, malformed or unsupported authority MUST fail closed.

For v2 authority, the selected compact summary remains the only observation-timeseries index object required in the normal Dropbox backup.

For v3 authority, the normal Dropbox backup MUST additionally carry the small **scoped-root dependency-evidence set** declared by the selected global latest object. This set consists only of the exact scoped root manifest objects referenced by:

```text
history/_index_v3/observations_timeseries_latest.json
    -> day_summaries[].scoped_roots[]
```

Each retained descriptor identifies one exact object such as:

```text
history/_index_v3/observations_timeseries/
  day_utc=YYYY-MM-DD/
    connector_id=N/
      pollutant_code=CODE/
        manifest.json
```

The bulk derived scoped tree remains excluded from normal Dropbox backup. Descendant exact-leaf/page objects and any other derived index payload beneath those roots are not normal backup payload merely because the root manifest is retained.

This is a narrow evidence exception, not a bulk-index backup. The retained scoped-root manifests exist so a partial fixed-v3 Integrity repair can prove unchanged global-latest dependencies against the same pinned Dropbox generation without consulting live R2.

## Unrelated domains remain v2

Changing `UK_AQ_R2_HISTORY_INDEX_VERSION` to v3 changes only the observation-timeseries generation selected for the compact operational summary and the corresponding observation-history runtime authority.

It MUST NOT redirect or rename the existing backup coverage for:

```text
history/v2/observations
history/v2/_ops/observations/runs
history/_index_v2/timeseries_binding
history/v2/core
```

In particular:

- timeseries binding remains under `_index_v2` and retains its existing source-manifest and backup range semantics;
- core remains logical v2;
- canonical observations remain under `history/v2/observations` even after their physical Parquet layout is rewritten for the v3 reader;
- observation run manifests remain logical v2.

A coding agent MUST NOT mechanically replace `_index_v2` with `_index_v3` across the backup implementation.

## Inventory-builder requirements

The active inventory builder MUST obtain or receive the persistent observation-history index authority explicitly and MUST derive the required compact latest-timeseries key from that authority.

It MUST NOT rely on a hard-coded v2 compact key after v3 authority is accepted.

For the selected compact summary, inventory identity MUST continue to include at least:

```text
relative_path
sha256
byte_size
```

When the selected generation changes from v2 to v3, the inventory MUST treat that as an intentional source-unit identity change. It MUST NOT reuse a previously processed v2 compact unit as proof that the required v3 compact unit is backed up.

If the authority-selected compact summary is missing, malformed or unreadable, the inventory build MUST fail clearly. The backup builder MUST NOT rebuild index objects as a side effect and MUST NOT silently fall back to the other generation.

When authority is v3, the inventory builder MUST also derive the scoped-root dependency-evidence set from the exact selected global-latest bytes. It MUST:

- reject duplicate scoped-root descriptors;
- reject scope/key contradictions;
- require a valid exact key, SHA-256 and byte size for every retained root;
- verify the actual R2 root-manifest object at that exact key against the descriptor before treating the inventory as complete;
- bind the evidence set to the same global-latest identity from which it was derived.

The inventory MUST NOT recursively inventory the whole `history/_index_v3/observations_timeseries/` tree for this purpose.

## Dropbox state and completeness

Dropbox state for the compact latest-timeseries unit MUST record the exact selected source path as well as its SHA-256, byte size and successful copy/verification evidence.

For v3 authority, Dropbox state MUST additionally record completion evidence for the exact scoped-root dependency-evidence set derived from that same latest object. The state representation MAY use exact per-root identities, a deterministic set digest, or both, but it MUST be sufficient to prove that:

- every root descriptor declared by the pinned global latest was present;
- every corresponding Dropbox object was copied/read back successfully;
- every Dropbox object's byte size and SHA-256 matched the pinned descriptor;
- no required root was omitted;
- the verified root set belongs to the same global-latest identity recorded by the checkpoint.

A backup run is complete for the current R2 inventory only when the authority-selected compact summary has been copied and source/destination identity verification has succeeded and, for v3, the complete referenced scoped-root evidence set has also been verified before the Dropbox checkpoint/state advances.

After authority changes from v2 to v3:

- prior successful state for the v2 compact summary is historical/rollback evidence only;
- it MUST NOT satisfy current backup completeness;
- the first complete post-cut-over backup MUST record successful processing of the v3 compact summary.

The v2 compact summary MAY remain in Dropbox during the rollback window. Its continued presence does not make it the active currentness unit while authority is v3.

## First post-cut-over backup gate

After the observation-history authority has changed to v3, normal history writers MUST remain frozen until the coordinated cut-over requirements in the v3 migration contract are satisfied.

Before the first authoritative post-cut-over Dropbox backup is accepted, the operator MUST establish that:

1. the v3 reader/index cut-over has passed the required post-cut-over validation;
2. the normal steady-state observation writer is using the accepted v3-target physical writer/index finalisation path;
3. at least the required first controlled normal post-cut-over write has been verified where the migration contract requires it;
4. the current canonical observation root represents the accepted post-cut-over generation;
5. the current compact observation-timeseries summary is `history/_index_v3/observations_timeseries_latest.json` and is valid for the current accepted v3 generation;
6. every scoped root declared by that global latest exists in R2 with the declared exact key, byte size and SHA-256;
7. the locked R2 backup inventory selects that v3 compact summary and its exact scoped-root dependency-evidence set;
8. copy and destination verification complete successfully for the compact summary and every required scoped-root manifest;
9. the resulting Dropbox checkpoint records the accepted current canonical observation generation, the selected v3 compact-summary identity and completion evidence for the exact retained-root set.

Until that first post-cut-over backup succeeds, the pinned pre-migration Dropbox generation remains the rollback baseline and MUST NOT be overwritten or reinterpreted as though it were already the new accepted baseline.

The implementation/runbook MUST preserve enough immutable migration/rollback evidence to distinguish the old pre-migration rollback baseline from the first accepted post-cut-over backup generation.

## Integrity and currentness boundary

This amendment does not independently redefine Integrity source authority or its canonical observations-root currentness gate.

Where Integrity requires a current Dropbox checkpoint before a write-enabled run, the checkpoint MUST be produced by the authority-aware backup implementation defined here after v3 cut-over. A checkpoint produced by the pre-cut-over v2 compact-summary selection MUST NOT be represented as a complete post-cut-over backup checkpoint merely because its canonical logical history version is still v2.

For fixed-v3 partial repair, the pinned Dropbox generation MUST contain and authenticate every unchanged scoped-root manifest retained by the pinned global latest and required by the proposed new global latest. Integrity MUST NOT satisfy those unchanged external dependencies from live R2 or from an unrelated overlay object.

Integrity remains frozen until the separate v3 steady-state writer/index requirements in the active R2 history contracts are satisfied and the required post-cut-over backup baseline exists.

## Rollback behaviour

Rollback remains operational rather than hybrid.

When a formal rollback restores v2 observation-history runtime authority, the backup selector returns to:

```text
history/_index_v2/observations_timeseries_latest.json
```

only after the rollback procedure has restored or rebuilt a valid v2-compatible canonical/index generation and set the persistent observation-history index authority back to v2 according to the migration contract.

The backup MUST NOT automatically select a v2 summary merely because a v3 summary is missing or invalid while authority still says v3.

## Fail-closed requirements

The backup/inventory implementation MUST fail rather than silently continue when:

- `UK_AQ_R2_HISTORY_INDEX_VERSION` is missing or is not `v2` or `v3`;
- the derived compact summary for the selected authority is missing;
- inventory/state claims one generation while the selected source path belongs to the other generation;
- the selected compact summary cannot be copied and verified;
- under v3 authority, any scoped root declared by the selected global latest is missing, scope/key-contradictory, byte-size-mismatched or SHA-mismatched;
- under v3 authority, any required scoped-root manifest cannot be copied and read-back verified in Dropbox;
- a current-complete checkpoint would otherwise be published without successful processing of the selected compact summary and, for v3, its complete scoped-root dependency-evidence set.

There MUST be no automatic v3-to-v2 compact-summary fallback.

## Implementation ownership

This amendment applies to at least:

- `scripts/backup_r2/build_backup_inventory.mjs`;
- `scripts/backup_r2/sync_history_to_dropbox.mjs` and its hierarchical state helpers where compact-unit path identity is validated;
- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`;
- any currentness/validation helper that assumes the compact observation-timeseries summary is always `_index_v2`.

Implementation MUST preserve all existing mandatory canonical observation, run-manifest, timeseries-binding and core backup coverage while making the observation-timeseries compact-summary selection authority-aware and, for v3, carrying only the additional exact scoped-root dependency-evidence manifests required by this amendment.

As of 18/09/2026, TEST code selects and backs up the v3 global latest object but does not yet inventory/copy its referenced scoped-root manifests or record their checkpoint completeness. That is an implementation gap against this amended contract. Until corrected and accepted through a real locked TEST backup, a fixed-v3 Integrity run MUST NOT treat the existing checkpoint as sufficient proof for retained scoped-root dependencies.

## Validation

Before resuming the authoritative post-cut-over backup in TEST, deterministic structural validation MUST prove at least:

- v2 authority resolves exactly the v2 compact summary;
- v3 authority resolves exactly the v3 compact summary;
- invalid authority fails closed;
- v3 authority does not redirect timeseries-binding or core paths;
- previous v2 compact-unit checkpoint state cannot satisfy v3 compact-unit completeness;
- missing v3 compact summary cannot fall back to v2;
- v3 latest descriptors produce an exact scoped-root evidence set without scanning the complete scoped tree;
- missing, duplicate, scope/key-contradictory, SHA-mismatched or byte-size-mismatched retained roots fail closed;
- the Dropbox checkpoint cannot become complete until every required retained root is copied and verified against the same latest identity;
- descendant exact-leaf/page objects remain excluded from normal backup;
- the R2 backup inventory root is not required as a Dropbox-local file;
- unchanged source/state units outside the compact summary and retained-root evidence set remain byte-stable where the existing backup contract requires it.

Functional acceptance then occurs through the first real locked TEST post-cut-over backup and verification of the resulting Dropbox checkpoint.