# R2 history

## Purpose

This directory contains the authoritative contracts for UK AQ canonical R2 observation history, stable v2 timeseries binding, observation-history Integrity, Prune Daily history publication and deletion safety, and the observation-history index-v3 architecture and cut-over.

This README is an area router. It tells readers which contracts to load for a task and does not duplicate their detailed behaviour.

For the cross-system map, start with [`../SYSTEM_OVERVIEW.md`](../SYSTEM_OVERVIEW.md). For specialised contracts not named by a common route below, use [`CONTRACT_INDEX.md`](CONTRACT_INDEX.md).

## Current authority at a glance

- The active canonical R2 history product is **observation history**.
- Calculated AQI / `aqilevels` is permanently retired as an R2 history product under [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md). Current calculated station-chart AQI is owned by [`../aqi-levels/README.md`](../aqi-levels/README.md).
- Canonical logical observation history remains v2. The selected final observation-timeseries physical/index authority is v3 under [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md), as amended by the load-bearing [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md) and [`observation_history_index_v3_transition_modes_amendment.md`](observation_history_index_v3_transition_modes_amendment.md). The exact-leaf design selects `timeseries-aligned-v2`, 1,024-row physical segments, exact-timeseries leaves and private bounded physical paging. An environment may already have persistent v3 authority from an earlier physical generation; that does not by itself mean the final exact-leaf generation has been accepted.
- Stable physical timeseries binding remains a separate v2 contract under [`contract.md`](contract.md).
- Canonical observation cross-run exclusion is owned by [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md), which supersedes older fine-grained observation concurrency wording.

Do not infer current behaviour from an older summary when an explicit amendment or retirement contract says otherwise.

## Choose the smallest task route

Read only the route matching the task, then add narrower contracts only when that boundary changes.

### Serving-generation metadata for dashboard readers

Read [generation_descriptor_contract.md](generation_descriptor_contract.md) for the authenticated stable-service runtime authority and cache/failure boundary.

### Stable timeseries binding and continuity

Start with:

1. [`contract.md`](contract.md)
2. [`continuity.md`](continuity.md)

Add only when needed:

- [`interfaces.md`](interfaces.md) for interfaces;
- [`operations.md`](operations.md) for publication/reconciliation operations;
- [`recovery.md`](recovery.md) for recovery;
- [`validation.md`](validation.md) for validation.

[`timeseries_binding_contract.md`](timeseries_binding_contract.md) is a compatibility redirect for older links only. New work should link to `contract.md` directly.

### Observation-history index v3 steady state

For physical observation packing, exact timeseries indexing, exact-leaf physical paging or ranged Parquet reads, start with:

1. [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md)
2. [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md)
3. [`interfaces.md`](interfaces.md)

The exact-leaf amendment is load-bearing for all new v3 implementation work. Where the base contract still describes `timeseries-bounded-v1`, 8,192/16,384-row groups, 1,000-ID child shards, runtime footer-derived offsets or runtime `timeseries_id` decode, the amendment is authoritative.

For exact-v3 publication/removal semantics also apply [`observation_history_index_v3_transition_modes_amendment.md`](observation_history_index_v3_transition_modes_amendment.md): authoritative exact-v3 scopes are non-empty; absence/removal uses the existing explicit writer-owned removal/complete-replacement semantics rather than a zero-row exact-leaf manifest.

Add writer/finalisation contracts only when that boundary changes:

- [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md)
- [`history_writer_coordination.md`](history_writer_coordination.md)
- [`implementation_safety_contract.md`](implementation_safety_contract.md)
- [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md)
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md)

For the controlled first post-cut-over write, its dedicated post-write verification, or the gate before the first locked post-v3 Dropbox backup, also read [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md). It distinguishes immutable migration-generation verification from verification of a legitimately advanced steady-state generation.

For station-history consumption add [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md). The exact-leaf amendment owns the additional post-v3 private `physical_cursor`, ≤24-hour low-level request and whole-invocation page/row-budget boundary. For backup behaviour add [`../backup_and_recovery/r2_history_dropbox_backup_contract.md`](../backup_and_recovery/r2_history_dropbox_backup_contract.md).

### Observation-history v3 migration, rebuild or cut-over

Start with:

1. [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md)
2. [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md)
3. [`observation_history_index_v3_transition_modes_amendment.md`](observation_history_index_v3_transition_modes_amendment.md)
4. [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md)
5. [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md)
6. [`observation_history_index_v3_integrity_authority_amendment.md`](observation_history_index_v3_integrity_authority_amendment.md)
7. [`observation_history_index_v3_recovery_determinism_amendment.md`](observation_history_index_v3_recovery_determinism_amendment.md)
8. [`observation_history_index_v3_backup_evidence_location_amendment.md`](observation_history_index_v3_backup_evidence_location_amendment.md)
9. [`observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md`](observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md)
10. [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md)
11. [`phase6_operational_writer_freeze_contract.md`](phase6_operational_writer_freeze_contract.md)
12. [`phase6_full_site_maintenance_contract.md`](phase6_full_site_maintenance_contract.md)
13. [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md)

For the high-performance **GCP clean-build migration or its required pre-LIVE TEST rehearsal**, also read [`observation_history_v3_gcp_clean_migration_contract.md`](observation_history_v3_gcp_clean_migration_contract.md). It is an authoritative future implementation contract for the GCE execution profile, not evidence that the GCP runner has already been deployed or accepted through real TEST operation.

The exact-leaf amendment is load-bearing for the migration target. It supersedes the old `timeseries-bounded-v1` migration writer-limit authority and requires the migration/checkpoint to target `timeseries-aligned-v2`, the 1,024-row segment cap, exact-timeseries leaves and offline-authoritative `observed_at_utc`/`value` byte ranges. Prototype `_prototype` prefixes remain calibration evidence only and are not canonical migration roots.

The transition-modes amendment is load-bearing for the current final-generation migration path. It requires an explicit `v2-to-v3` or `v3-rebuild` transition, pins source/target generations into migration authority, keeps LIVE `v2-to-v3` intact, defines additional rollback authority for an already-v3 rebuild, makes exact-v3 scopes non-empty, and requires one strong targeted end-to-end `v2-to-v3` migration contract test before LIVE. It also supersedes the earlier requirement to roll an already-v3 TEST environment back to v2 solely to repeat a complete v2-to-v3 rehearsal after the final exact-leaf layout change.

The Integrity-authority amendment is load-bearing for this route: `UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2` is a loaded environment/profile semantic value, not a persistent GitHub repository authority, and operator tooling must not require a GitHub Integrity-version variable merely to satisfy migration gates.

The recovery-determinism amendment is load-bearing for migration/resume/verification: exact prepared canonical JSON bytes must survive restart, changed completed-object identity fails closed, replay-state authentication must scale to the real archive, ordinary journal reading remains exact, only one fully authenticated crash-interrupted trailing append may be promoted by the locked mutating repair path, recovered publication objects require current exact verification before reuse, and runner/profile recovery identity is preserved.

The GCP clean-build contract is additionally load-bearing when that execution profile is selected: GCE admission and high-concurrency authority are profile-bound, the relevant v3 observation-generation target must be proven empty, migration-time clean-target admission must become durable authenticated recovery evidence before target progress, and real interrupted/resumed clean TEST acceptance is required before the profile is used for LIVE.

The backup-evidence-location amendment is load-bearing whenever migration backup authority is checked: the hierarchical inventory root is an R2-side authority, while the hierarchical checkpoint/state root is Dropbox-side. Tooling must not search the Dropbox destination for the R2 inventory root or substitute one identity for the other.

The post-cutover rollback-data-preservation amendment is load-bearing before the controlled v3 writer or source-destructive writer release: a pre-migration v2 rollback generation does not automatically contain observations first archived after cut-over, and a v3-target Dropbox backup is not automatically a tested v3-to-v2 replay bridge. Source deletion must therefore remain suppressed or separately recoverable while a complete pre-migration v2 rollback is still claimed available.

The steady-state acceptance amendment is load-bearing after the first accepted post-cut-over canonical write: the original post-cut-over verifier authenticates the immutable migration generation and must not be repinned to current R2, while a separate strictly read-only steady-state verifier must authenticate the advanced accepted generation before the first locked post-v3 Dropbox backup. It also owns the UTC connector-day acceptance invariant and the post-migration/pre-write baseline requirement for unaffected-history claims.

Add the backup contracts referenced by the migration/operator contracts only when backup or rollback evidence is in scope.

These contracts describe controlled TEST and restricted LIVE beta migration/rebuild operations. They do not themselves authorise deployment, scheduler, R2, maintenance or LIVE mutations.

### Prune Daily Phase B

The permanent Phase B R2 model is observation-only.

Start with:

1. [`prune_daily_observation_only_phase_b_contract.md`](prune_daily_observation_only_phase_b_contract.md)
2. [`prune_daily_complete_snapshot_child_set_contract.md`](prune_daily_complete_snapshot_child_set_contract.md)
3. [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md)
4. [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md)
5. [`history_writer_coordination.md`](history_writer_coordination.md)

The complete-snapshot child-set contract is load-bearing when a Prune connector-day is rewritten: the final connector pollutant set is exactly the source-derived complete snapshot, while normal Integrity selected-partition repair remains a partial merge that preserves unrelated valid pollutant children. It also owns the first-publication rule for an absent previous connector manifest.

For IngestDB deletion safety add:

- [`prune_connector_day_gate.md`](prune_connector_day_gate.md)
- [`prune_connector_source_identity.md`](prune_connector_source_identity.md)
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md)
- [`prune_connector_day_atomic_deletion.md`](prune_connector_day_atomic_deletion.md)
- [`implementation_safety_contract.md`](implementation_safety_contract.md)

When Prune is being used as the controlled first post-cutover v3 writer or while a complete pre-migration v2 rollback remains advertised, also read [`observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md`](observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md) before allowing IngestDB deletion.

For controlled post-write acceptance and the gate before the first locked post-v3 backup, also read [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md).

For runtime or source-transport work add [`prune_daily_runtime_budget.md`](prune_daily_runtime_budget.md) or [`phase_b_source_transport_and_egress_contract.md`](phase_b_source_transport_and_egress_contract.md) as appropriate.

[`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) remains only for compatibility with older links. It must not be interpreted as an active AQI-in-R2 writer contract.

### Generic Integrity

For normal Integrity detection, planning, repair or verification, start with:

1. [`integrity.md`](integrity.md)
2. [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md)
3. [`integrity_core_snapshot_identity.md`](integrity_core_snapshot_identity.md)
4. [`history_writer_coordination.md`](history_writer_coordination.md)
5. [`implementation_safety_contract.md`](implementation_safety_contract.md)

Then load only the specialised contract needed for the task. [`CONTRACT_INDEX.md`](CONTRACT_INDEX.md) routes proposal/apply state, provenance, direct replacement, connector totals, modularisation, preflight/journal and related narrow Integrity concerns.

Common additions are:

- [`current_state_reconciliation.md`](current_state_reconciliation.md) when verified repair can affect timeseries freshness or Latest Snapshot;
- [`daily_profile_selection.md`](daily_profile_selection.md) for scheduled selection;
- [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md) plus [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md) for post-cut-over physical writing/index/read behaviour;
- [`../backup_and_recovery/r2_history_index_v3_backup_amendment.md`](../backup_and_recovery/r2_history_index_v3_backup_amendment.md) and [`../backup_and_recovery/r2_history_dropbox_sync_contract.md`](../backup_and_recovery/r2_history_dropbox_sync_contract.md) when a partial fixed-v3 repair must retain unchanged scoped roots in the global latest index and prove them from the pinned Dropbox generation.

For Latest Snapshot reconciliation also read [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md).

### SOS historical repair and SOS-light

Start with the generic Integrity route, then add:

1. [`sos_light_model.md`](sos_light_model.md)
2. [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md)
3. [`sos_run_scoped_source_acquisition_contract.md`](sos_run_scoped_source_acquisition_contract.md)

Use [`CONTRACT_INDEX.md`](CONTRACT_INDEX.md) only if the SOS task also enters direct selected-partition replacement, staged-write provenance, protected-connector preservation or another narrow Integrity boundary.

Add [`current_state_reconciliation.md`](current_state_reconciliation.md) and [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md) only when the repaired history can affect current state.

For fixed-v3 SOS-light repair that updates the global exact-v3 latest index while preserving unchanged scopes outside the selected repair range, also read:

1. [`../backup_and_recovery/r2_history_index_v3_backup_amendment.md`](../backup_and_recovery/r2_history_index_v3_backup_amendment.md);
2. [`../backup_and_recovery/r2_history_dropbox_sync_contract.md`](../backup_and_recovery/r2_history_dropbox_sync_contract.md);
3. [`observation_history_index_v3_backup_evidence_location_amendment.md`](observation_history_index_v3_backup_evidence_location_amendment.md).

Those contracts require retained unchanged scoped-root dependencies to be proven from the same pinned Dropbox generation. The global latest descriptor alone is not durable-object proof, and live R2 is not a substitute planning authority.

Do not load Prune Daily deletion-gate contracts for an SOS-only task unless the task actually crosses that ownership boundary.

### Current-state reconciliation after Integrity

Start with:

1. [`current_state_reconciliation.md`](current_state_reconciliation.md)
2. [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md)
3. [`../latest_snapshot/contract.md`](../latest_snapshot/contract.md)

Add [`integrity.md`](integrity.md) only when changing upstream verified-repair evidence rather than reconciliation alone.

### Observation manifests and legacy compatibility

Start with [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md).

Add as relevant:

- [`legacy_manifest_compatibility.md`](legacy_manifest_compatibility.md)
- [`integrity_global_index_publication_order_contract.md`](integrity_global_index_publication_order_contract.md)
- [`history_writer_coordination.md`](history_writer_coordination.md)
- [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md)
- [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md) when post-cut-over exact-leaf authority is in scope.

## Important precedence

Some established filenames remain because older active or historical documents link to them. Their presence does not make superseded behaviour current.

Current explicit precedence includes:

- [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md) over older active-AQI-in-R2 wording;
- [`prune_daily_observation_only_phase_b_contract.md`](prune_daily_observation_only_phase_b_contract.md) for the permanent observation-only Phase B model;
- [`prune_daily_complete_snapshot_child_set_contract.md`](prune_daily_complete_snapshot_child_set_contract.md) over generic child-preservation wording when Prune Daily owns a complete connector-day source snapshot;
- [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md) over older canonical-observation fine-grained cross-run concurrency wording;
- [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md) over older post-cut-over v2 physical/index wording;
- [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md) over conflicting index-v3 base/migration/operator/interface/station-history wording for physical layout, exact lookup, runtime byte-range discovery, physical paging and the bounded station-history v3 page walk;
- [`observation_history_index_v3_transition_modes_amendment.md`](observation_history_index_v3_transition_modes_amendment.md) over conflicting migration/operator/exact-leaf/backup wording for explicit `v2-to-v3` versus `v3-rebuild` transitions, final-generation TEST acceptance, non-empty exact-v3 scopes, `v2-to-v3` structural migration testing and rebuild rollback authority;
- [`observation_history_index_v3_integrity_authority_amendment.md`](observation_history_index_v3_integrity_authority_amendment.md) over operator/preflight wording that treats the Integrity semantic version as a persistent GitHub authority;
- [`observation_history_index_v3_recovery_determinism_amendment.md`](observation_history_index_v3_recovery_determinism_amendment.md) over migration/operator wording that permits byte-unstable prepared replay, treats a later changed completed-object identity as normally authoritative, permits ambiguous journal tails, or weakens profile-bound recovered-publication reuse;
- [`observation_history_v3_gcp_clean_migration_contract.md`](observation_history_v3_gcp_clean_migration_contract.md), as amended by the recovery-determinism amendment for recovery-specific semantics, for the future GCE-attested clean-build execution profile and its pre-LIVE real TEST acceptance;
- [`observation_history_index_v3_backup_evidence_location_amendment.md`](observation_history_index_v3_backup_evidence_location_amendment.md) over migration/operator wording that ambiguously describes the R2 hierarchical backup inventory as a Dropbox-local inventory root;
- [`observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md`](observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md) over migration/writer-release wording that implies the pinned pre-migration v2 generation remains a complete data-preserving rollback after post-cutover source rows have been deleted without a tested bridge;
- [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md) over migration/operator wording that treats immutable completed-migration equality as a valid verification condition after an accepted steady-state write or permits the first locked post-v3 backup before dedicated post-write verification;
- [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md), as amended by the exact-leaf, transition-modes, operator, Integrity-authority, recovery-determinism, backup-evidence-location, post-cutover rollback-data-preservation, steady-state-acceptance, writer-freeze and maintenance contracts, for v3 migration, rebuild, hard cut-over and rollback.

If two active contracts appear to conflict outside an explicit precedence statement, report the conflict rather than choosing silently.

## Area boundaries

This area owns historical observation storage and repair concerns. Related owners include:

- calculated station-chart AQI: [`../aqi-levels/README.md`](../aqi-levels/README.md);
- Latest Snapshot current-state policy: [`../latest_snapshot/README.md`](../latest_snapshot/README.md);
- R2 history Dropbox backup: [`../backup_and_recovery/README.md`](../backup_and_recovery/README.md);
- public station-chart browser behaviour: [`../station_charts/README.md`](../station_charts/README.md).

Use [`../READING_GUIDE.md`](../READING_GUIDE.md) only when a task crosses one of those area boundaries.

## Implementation and documentation notes

Implementation is distributed across `uk-aq-ops`, including shared R2 history/index code, Prune Daily, Integrity, history API Workers, station-history services, Latest Snapshot reconciliation and backup tooling. Inspect only the implementation files relevant to the selected task route.

This README intentionally no longer repeats exact runtime budgets, hash fields, deletion evidence, lock lifetimes, snapshot-selection steps or reconciliation transitions. Those details belong in the linked contracts.

There is currently no `r2_history/decisions/` directory. Older reading instructions that referred to it were stale and have been removed.
