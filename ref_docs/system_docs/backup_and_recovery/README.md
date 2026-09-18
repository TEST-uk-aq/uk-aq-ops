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

It is the narrower authority for the one compact observation-timeseries summary selected by inventory and sync:

```text
v2 -> history/_index_v2/observations_timeseries_latest.json

v3 -> history/_index_v3/observations_timeseries_latest.json
```

The normal v3 backup does **not** additionally copy or revalidate the complete scoped/exact observation-timeseries index tree merely to support SOS-light. Derived indexes are rebuildable from the canonical Dropbox baseline plus a repair overlay under the SOS-light three-phase contract.

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

For SOS-light fixed-v2/fixed-v3 repair, route back to [`../r2_history/sos_light_three_phase_authority_contract.md`](../r2_history/sos_light_three_phase_authority_contract.md). The normal Dropbox backup remains the simple canonical baseline; it is not expanded with derived v3 dependency evidence.

For the **first locked post-v3 backup after a controlled steady-state write**, also read [`../r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md`](../r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md). That contract owns any separate post-write acceptance gate.

For an observation-history **`v3-rebuild`** or LIVE **`v2-to-v3`** migration, use the dedicated transition/migration contracts. Those migration/rollback rules are distinct from normal SOS-light repair and normal Dropbox backup scope.
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