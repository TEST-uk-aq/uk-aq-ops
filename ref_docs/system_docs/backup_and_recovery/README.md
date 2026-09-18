# Backup and recovery

This area owns migrated active backup contracts for:

- scheduled logical Supabase database dumps to Dropbox;
- hierarchical logical-v2 R2 history backup to Dropbox.

It also contains the packed `timeseries_binding` Dropbox transport contract. Phase 1 R2 pack publication, Phase 2 Dropbox packed transport, Phase 3 SOS-light Integrity consumption, Phase 4 pack-to-individual restore and Phase 5 scheduled/default TEST cut-over are implemented and operationally proven on TEST. The runtime-consumer cut-over audit also passed: active request-time consumers continue to read the unchanged individual R2 binding paths and no runtime consumer reads the pack namespace. Packed bindings are now the current scheduled/default TEST binding-backup authority. LIVE adoption remains separate and pending normal TEST-to-LIVE promotion.

It does **not** yet define complete system-wide restore architecture.

## Task routes

Read only the route matching the task.

### Supabase logical database dump

Read [`contract.md`](contract.md), then implementation/workflow files as needed.

This owns scheduler/workflow runtime, concurrent `ingestdb`/`obs_aqidb` dumps, Dropbox layout/retention, task health, bounded-memory SQL splitting, failure behaviour and TEST acceptance. Historical GCP backup-service documentation is not an active fallback.

### R2 history backup shared scope

Read [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md) for shared backup scope, source/destination roles, one-active-hierarchical-path rules, logical-v2 backup-format identity, writer boundaries and restore limitations.

Then select the implementation-specific contract below rather than loading both automatically.

### R2 backup inventory builder

For `scripts/backup_r2/build_backup_inventory.mjs`, inventory roots/shards, source-hierarchy traversal or full-scan verification, add:

- [`r2_history_backup_inventory_contract.md`](r2_history_backup_inventory_contract.md)

Do not load Dropbox copy/checkpoint detail unless the task also changes the consumer state contract.

### R2 Dropbox sync/checkpoint

For `scripts/backup_r2/sync_history_to_dropbox.mjs`, Dropbox state, rclone copy planning, stale observation pruning, checkpoint batching or completion ordering, add:

- [`r2_history_dropbox_sync_contract.md`](r2_history_dropbox_sync_contract.md)

Add the inventory contract only when changing the inventory/state interface itself.

### Timeseries-binding packed Dropbox backup

**Phases 1–5 implemented and operationally accepted on TEST. Packed bindings are the current scheduled/default TEST binding-backup authority.**

For work that creates, copies, verifies, materialises or restores packed `timeseries_binding` backup payload, read:

1. [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md);
2. [`r2_history_timeseries_binding_pack_backup_contract.md`](r2_history_timeseries_binding_pack_backup_contract.md);
3. the inventory or sync contract only for the implementation boundary being changed.

The pack contract owns the intentional difference between individual R2 runtime bindings and packed Dropbox transport, pack publication/checkpoint semantics, the current SOS-light-only Integrity materialisation boundary and binding-pack restore ordering.

Current implementation status is:

```text
Phase 1  deterministic R2 pack producer                         accepted
Phase 2  additive inventory + Dropbox packed transport         accepted
Phase 3  SOS-light-only Integrity support                      accepted
Phase 4  pack restore + exact-byte TEST round trip             accepted
Gate 13  runtime binding-consumer audit                         passed
Phase 5  TEST scheduled/default cut-over to pack authority     accepted
```

Phase 5 was accepted on 04/09/2026 through GitHub Actions run `33923153503`, triggered by the normal scheduler/external-dispatch path with no binding-mode override. The workflow therefore selected its new `pack` default, ran the normal full backup path, reused all 143 current packs without rebuilding or copying unchanged pack data, completed the non-binding backup domains and normal task-health lifecycle, and left the retained individual rollback generation untouched.

Manual `individual` selection remains available as bounded rollback during the observation period, but it is no longer the normal scheduled/default TEST authority. Direct lower-level CLI defaults remain conservative and do not redefine the workflow authority.

### Operation/runbook work

Read:

1. the shared R2 backup contract;
2. the inventory and/or sync contract for the operation being changed;
3. [`r2_history_hierarchical_backup_runbook.md`](r2_history_hierarchical_backup_runbook.md).

When the operation concerns packed bindings, also read the pack contract above.

### Observation-history index v3 and backup

When persistent observation-history index authority, v3 cut-over or the compact latest-timeseries unit is in scope, also read:

- [`r2_history_index_v3_backup_amendment.md`](r2_history_index_v3_backup_amendment.md)

It is the narrower authority for the observation-timeseries backup evidence selected by inventory and sync:

```text
v2 -> history/_index_v2/observations_timeseries_latest.json

v3 -> history/_index_v3/observations_timeseries_latest.json
      + the exact scoped root manifest objects declared by
        day_summaries[].scoped_roots[]
```

For v3, those scoped root manifests are a small dependency-evidence set used by partial fixed-v3 Integrity. The bulk `history/_index_v3/observations_timeseries/` tree remains excluded from normal Dropbox backup; descendant exact-leaf/page objects are not copied merely because their root manifest is retained.

It does **not** migrate these unrelated backup domains to v3:

```text
history/v2/observations
history/v2/_ops/observations/runs
history/_index_v2/timeseries_binding
history/v2/core
history/_index_v2/backup_inventory_v2/
_ops/checkpoints/r2_history_backup_state_v2/
```

The binding-pack namespace is likewise generation-neutral and is governed separately by the packed-binding contract rather than observation-history index generation.

As of 18/09/2026, the contract requires the v3 scoped-root dependency-evidence set but the TEST backup implementation still copies only the v3 global latest object. That implementation gap must be closed and accepted by a real locked TEST backup before fixed-v3 Integrity may rely on the checkpoint for unchanged scoped-root dependencies.

For the **first locked post-v3 backup after a controlled steady-state write**, also read [`../r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md`](../r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md). That contract requires a separate strictly read-only post-write verifier to authenticate the advanced steady-state generation before the backup is eligible to start. The migration-era post-cutover verifier is not repinned or weakened for this purpose.

For an observation-history **`v3-rebuild`**, also read [`../r2_history/observation_history_index_v3_transition_modes_amendment.md`](../r2_history/observation_history_index_v3_transition_modes_amendment.md). The complete verified pre-migration canonical v2 Dropbox generation is the rollback data authority. The superseded old v3 index generation is derived data and is not a recovery target, so an exact old-v3 snapshot or deterministic old-v3 reproduction is not required. Before incompatible mutation, the rebuild must instead pin the required v2 runtime rollback evidence. Formal rollback restores and verifies canonical v2, rebuilds and verifies index_v2, then restores and independently verifies v2 deployed authority.

For a LIVE **`v2-to-v3`** migration, the same transition amendment defines the same canonical-v2 rollback basis: the complete frozen pre-migration canonical v2 backup generation, including canonical Parquet and manifests, together with its pinned identities and v2 runtime recovery evidence. Retained `_index_v2` objects are derived evidence only; the supported formal rollback rebuilds and verifies index_v2 from the restored canonical v2 generation.

Load other R2-history migration/operator contracts only when their migration gates or evidence are actually in scope.

### Restore or recovery

Do not infer complete system-wide restore capability from the backup contracts. The generic R2 restore workflow predates the complete hierarchical design.

The packed-binding contract is a narrow exception for its own migration: the dedicated pack-to-individual binding restore path is implemented and Phase 4 has passed a real isolated TEST round trip, including exact recovery/readback of all 6,265 individual binding objects, reconstruction/readback of all 143 range manifests, exact reproduction of the authoritative source-root identity and root-last publication. This proves packed-binding recovery, but it does not make the generic R2 restore complete system-wide recovery authority.

The observation-history index-v3 migration family is another specific exception: its formal rollback behaviour is governed by [`../r2_history/observation_history_index_v3_transition_modes_amendment.md`](../r2_history/observation_history_index_v3_transition_modes_amendment.md) and the migration/operator contracts it amends.

Substantial generic restore replacement/retirement requires a dedicated active recovery contract first.

For observation repair, current-state reconciliation, binding recovery or current History Integrity, route to [`../r2_history/README.md`](../r2_history/README.md).

## Cross-area boundaries

Use only when the task crosses them:

- observation hierarchy, run exclusion, binding or index v3: [`../r2_history/README.md`](../r2_history/README.md);
- implementation safety/archive rules: repository `AGENTS.md`.

Dropbox checkpoint state is evidence of copied/verified source identity. It is not permission to author or repair R2.

## Implementation ownership

R2 history backup:

```text
scripts/backup_r2/
.github/workflows/uk_aq_r2_history_dropbox_backup.yml
```

Supabase logical dumps:

```text
workers/uk_aq_supabase_db_dump_backup_service/
.github/workflows/uk_aq_supabase_db_dump_backup.yml
```

The `_service` directory name does not make the retired GCP Cloud Run Service active.

## Validation

Before deployment use only targeted structural/deterministic checks required by the selected contract. Functional acceptance occurs through real TEST backup operation after deployment.