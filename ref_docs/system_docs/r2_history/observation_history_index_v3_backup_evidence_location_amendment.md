# Observation-history index v3 backup-evidence location amendment

## Authority and scope

This document is the authoritative narrow amendment for the location, naming and interpretation of hierarchical R2-history backup evidence used by the observation-history index-v3 migration, preflight, rollback and cut-over gates.

It amends, for this scope:

- [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md);
- [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md);
- [`../backup_and_recovery/r2_history_dropbox_backup_contract.md`](../backup_and_recovery/r2_history_dropbox_backup_contract.md).

The detailed inventory and Dropbox-state behaviour remains owned by:

- [`../backup_and_recovery/r2_history_backup_inventory_contract.md`](../backup_and_recovery/r2_history_backup_inventory_contract.md);
- [`../backup_and_recovery/r2_history_dropbox_sync_contract.md`](../backup_and_recovery/r2_history_dropbox_sync_contract.md).

This amendment records the location distinction exposed during the TEST index-v3 rehearsal when a verification path attempted to require an R2-only hierarchical inventory object beneath the Dropbox backup destination.

## Core location boundary

The hierarchical backup has two different persistent control authorities with different storage locations.

### R2-side backup inventory authority

The active hierarchical inventory root is an R2 object:

```text
history/_index_v2/backup_inventory_v2/root.json
```

Its child inventory objects also remain in R2 beneath:

```text
history/_index_v2/backup_inventory_v2/...
```

This inventory describes the current R2 source backup scope and source identities.

It is not normal Dropbox backup payload.

### Dropbox-side processed-state authority

The active hierarchical Dropbox checkpoint/state root is a Dropbox destination file:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
```

Its child state files remain beneath:

```text
_ops/checkpoints/r2_history_backup_state_v2/...
```

This state records which R2 source identities have been copied and verified successfully in Dropbox.

## Prohibited path inference

Migration, preflight, rollback and verification tooling MUST NOT infer that the R2 backup inventory is mirrored beneath the Dropbox backup destination.

In particular, tooling MUST NOT construct or require:

```text
<Dropbox backup root>/history/_index_v2/backup_inventory_v2/root.json
```

Absence of that Dropbox-local path is expected and MUST NOT be reported as incomplete backup coverage.

Likewise, the Dropbox checkpoint/state root MUST NOT be treated as though it were an R2 inventory object.

The two authorities are complementary and non-interchangeable.

## V3 scoped-root dependency-evidence payload

The R2 inventory authority remains R2-only, but this location rule does not prohibit normal Dropbox payload from including source objects that the backup contract explicitly selects.

Under v3 observation-timeseries authority, the normal backup now includes the exact scoped root manifests referenced by the selected global latest object as a narrow dependency-evidence set. Those files live in Dropbox at their normal source-relative keys, for example:

```text
history/_index_v3/observations_timeseries/
  day_utc=YYYY-MM-DD/
    connector_id=N/
      pollutant_code=CODE/
        manifest.json
```

This does **not** mean the R2 hierarchical inventory root has moved to Dropbox and does not authorise mirroring the complete derived v3 index tree. The distinction is:

```text
R2 backup inventory/control authority
    -> remains R2-only

selected source payload and dependency evidence
    -> may be copied to Dropbox when the active backup contract requires it
```

The exact v3 scoped-root payload and checkpoint-completeness rules are owned by [`../backup_and_recovery/r2_history_index_v3_backup_amendment.md`](../backup_and_recovery/r2_history_index_v3_backup_amendment.md) and [`../backup_and_recovery/r2_history_dropbox_sync_contract.md`](../backup_and_recovery/r2_history_dropbox_sync_contract.md).

## Required migration evidence terminology

Where older migration/operator wording says or implies:

```text
Dropbox inventory-root SHA-256
Dropbox state-root SHA-256
```

it MUST be interpreted and, in new evidence/reporting, named as:

```text
R2 backup inventory-root identity
Dropbox backup state/checkpoint-root identity
```

The first identity comes from the hierarchical R2 inventory authority.

The second identity comes from the Dropbox hierarchical state/checkpoint tree.

A migration plan/checkpoint MAY pin both identities, but it MUST retain the location distinction and MUST NOT represent the R2 inventory root as a Dropbox file.

## Preflight and verification requirements

When a migration gate validates backup authority:

```text
R2 inventory-root identity
    -> read from current R2 hierarchical backup inventory
       or validate against immutable migration evidence derived from that R2 inventory

Dropbox state/checkpoint-root identity
    -> read from the configured Dropbox backup destination
       or validate against immutable migration evidence derived from that Dropbox state
```

If the gate needs both authorities, both MUST be validated independently.

A matching Dropbox checkpoint does not replace the R2 inventory identity, and a valid R2 inventory does not prove that Dropbox copy/verification completed.

Tooling MUST fail closed on a genuine mismatch between the pinned R2 inventory identity and the accepted R2 inventory, or between the pinned Dropbox state identity and the accepted Dropbox state.

It MUST NOT fail merely because the R2 inventory root is absent from Dropbox.

## Backup-format generation remains v2

The active locations remain:

```text
R2 inventory:
  history/_index_v2/backup_inventory_v2/root.json

Dropbox state:
  _ops/checkpoints/r2_history_backup_state_v2/root.json
```

The `_index_v2` component of the R2 inventory path is the existing backup-format generation. It is not the active observation-timeseries generation selector.

Changing persistent observation-timeseries authority from v2 to v3 therefore MUST NOT mechanically rename the hierarchical backup inventory or Dropbox state roots.

The index-v3 backup amendment changes only the authority-selected compact observation-timeseries summary required by the backup unless another explicit backup-format migration is authorised.

## LIVE runbook requirement

The restricted LIVE implementation runbook MUST identify these two evidence sources separately.

Before migration mutation, the operator must be able to state explicitly:

```text
R2 backup inventory-root key and exact identity
Dropbox backup state/checkpoint-root path and exact identity
```

Any command that searches the Dropbox destination for the R2 inventory-root key is invalid and MUST be corrected before LIVE execution.

DRAFT or generated LIVE commands must not use ambiguous labels such as `Dropbox inventory root` when they mean the R2 inventory authority.

## Implementation reconciliation

Any current TEST/LIVE preflight, verifier or migration helper that constructs the R2 inventory-root path relative to the Dropbox destination is inconsistent with this contract and MUST be corrected and rehearsed on TEST before LIVE.

The correction must preserve the real backup completeness gates. It must not weaken source-inventory identity, destination checkpoint/currentness, source/destination copy verification or rollback authority.

## Change rule

A future decision to copy the hierarchical R2 inventory itself into Dropbox, rename either control tree, or migrate the backup-format generation requires an explicit backup contract change.

It MUST NOT happen implicitly as a side effect of the observation-history index-v3 cut-over.