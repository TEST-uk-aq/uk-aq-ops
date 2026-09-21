# R2 history contract index

## Purpose

This file is a discovery index for the many narrow contracts in `r2_history/`.

It is not part of the default reading path. Start with [`README.md`](README.md) and read this index only when the task needs a specialised contract not already named by the common task route.

The linked contracts remain authoritative for their stated scope. This index does not restate their detailed behaviour.

## Core area contracts

| File | Scope |
|---|---|
| [`generation_descriptor_contract.md`](generation_descriptor_contract.md) | Authenticated stable-service serving-generation authority for local and hosted dashboards |
| [`contract.md`](contract.md) | Stable v2 physical timeseries binding |
| [`continuity.md`](continuity.md) | Binding continuity-family rules |
| [`interfaces.md`](interfaces.md) | R2 history interfaces |
| [`operations.md`](operations.md) | Binding publication and operational procedures |
| [`recovery.md`](recovery.md) | Binding recovery |
| [`validation.md`](validation.md) | Binding validation |

[`timeseries_binding_contract.md`](timeseries_binding_contract.md) is a compatibility redirect for older links only. New documentation must link directly to `contract.md`.

## Canonical observation coordination and publication

| File | Scope |
|---|---|
| [`observation_history_schema_contract.md`](observation_history_schema_contract.md) | Canonical observation row/Parquet names, status compatibility, boundary mappings and persisted-name changes |
| [`aurn_validation_status_contract.md`](aurn_validation_status_contract.md) | Connector `1` P/R semantics and trusted presentation fallback; field naming defers to the schema contract |
| [`observations_run_exclusion_contract.md`](observations_run_exclusion_contract.md) | Global canonical-observation operation exclusion and backup/start-state boundary |
| [`history_writer_coordination.md`](history_writer_coordination.md) | Shared observation writer/finaliser ownership and IngestDB boundary |
| [`implementation_safety_contract.md`](implementation_safety_contract.md) | Shared writer, affected-day finalisation and implementation safety |
| [`lock_environment_boundary.md`](lock_environment_boundary.md) | Supabase/database advisory-lock environment boundary |
| [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md) | Observation manifest hierarchy |
| [`legacy_manifest_compatibility.md`](legacy_manifest_compatibility.md) | Legacy manifest compatibility |
| [`integrity_global_index_publication_order_contract.md`](integrity_global_index_publication_order_contract.md) | Integrity global-index publication ordering |
| [`connector_gate_file_identity.md`](connector_gate_file_identity.md) | Durable physical Parquet identity verification |
| [`protected_connector_preservation_contract.md`](protected_connector_preservation_contract.md) | Preservation of protected connector content |

## Observation-history index v3

| File | Scope |
|---|---|
| [`observation_history_v3_side_by_side_generation_contract.md`](observation_history_v3_side_by_side_generation_contract.md) | **Current authoritative v2→v3 migration/generation model:** independent `history/v3` + `_index_v3` generation, one `UK_AQ_R2_HISTORY_VERSION` selector, short frozen-source final cut-over, no v2 shadow writing after accepted cut-over, and intact-v2 same-window rollback |
| [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md) | Base target physical layout, exact v3 index and ranged Parquet reader contract; migration/version-boundary wording is superseded where it conflicts with the side-by-side generation contract |
| [`observation_history_index_v3_exact_leaf_amendment.md`](observation_history_index_v3_exact_leaf_amendment.md) | Load-bearing selected exact-leaf amendment: `timeseries-aligned-v2`, 1,024-row segments, exact stored column ranges, private `physical_cursor`, and bounded station-history page/row walking |
| [`observation_history_index_v3_transition_modes_amendment.md`](observation_history_index_v3_transition_modes_amendment.md) | Historical hard-cut-over/final-generation transition model; retained for non-conflicting exact-leaf/tooling details but superseded for migration topology, generation selection and rollback by the side-by-side generation contract |
| [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md) | Historical offline in-place v2-to-v3 hard cut-over model; retained for non-conflicting implementation/evidence details but superseded for migration topology, namespaces, selector and rollback by the side-by-side generation contract |
| [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md) | Operator tooling and acceptance evidence, subject to the current side-by-side generation authority model |
| [`observation_history_index_v3_integrity_authority_amendment.md`](observation_history_index_v3_integrity_authority_amendment.md) | Loaded Integrity semantic-version authority during v3 migration/cut-over; no GitHub Integrity-version authority |
| [`observation_history_index_v3_recovery_determinism_amendment.md`](observation_history_index_v3_recovery_determinism_amendment.md) | Exact prepared-byte recovery, append-only completed identities, scalable replay authentication and LIVE exact-only resume/verification |
| [`observation_history_index_v3_recovery_scaling_amendment.md`](observation_history_index_v3_recovery_scaling_amendment.md) | Bounded resume re-verification, recovery progress, dependency-safe journal batching and compatibility with existing singleton recovery entries |
| [`observation_history_index_v3_test_legacy_resume_and_planner_scaling_amendment.md`](observation_history_index_v3_test_legacy_resume_and_planner_scaling_amendment.md) | Authenticated TEST-only mutating resume for exact historical canonical ordering evidence, immutable evidence preservation and recovered-plan/planner scaling boundary |
| [`observation_history_index_v3_planner_optimisation_and_test_acceptance_amendment.md`](observation_history_index_v3_planner_optimisation_and_test_acceptance_amendment.md) | Exact-semantics publication-planner optimisation, real planner progress/ETA, preservation of the old interrupted rehearsal as historical evidence, and mandatory fresh TEST full-migration acceptance before LIVE; resume is required only if the fresh TEST run is naturally interrupted |
| [`observation_history_index_v3_backup_evidence_location_amendment.md`](observation_history_index_v3_backup_evidence_location_amendment.md) | R2 inventory-root versus Dropbox checkpoint/state-root location and migration evidence naming |
| [`observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md`](observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md) | Historical long rollback-window preservation model; superseded where it requires keeping v2 current after an accepted side-by-side v3 cut-over |
| [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md) | Dedicated post-write steady-state verification, subject to the side-by-side generation cut-over/rollback boundary |
| [`phase6_operational_writer_freeze_contract.md`](phase6_operational_writer_freeze_contract.md) | Operational writer-freeze mechanics retained where compatible with the short frozen-source side-by-side final cut-over |
| [`phase6_full_site_maintenance_contract.md`](phase6_full_site_maintenance_contract.md) | Historical full-site maintenance boundary; full-site maintenance is not required solely for the current side-by-side generation migration |

The side-by-side generation contract now owns migration topology, generation namespaces, the single normal generation selector, final catch-up/cut-over, the no-shadowing decision and the same-window rollback boundary. Older hard-cut-over and transition contracts remain useful only for non-conflicting physical-layout, exact-leaf, operator, verification and recovery details.

The exact-leaf amendment remains authoritative for `timeseries-aligned-v2`, 1,024-row physical segments, exact stored column ranges, private physical paging and bounded station-history walking. Existing exact-leaf/planner work is reused by the side-by-side generation rather than redesigned.

## Integrity

| File | Scope |
|---|---|
| [`integrity.md`](integrity.md) | Main v2 Integrity detection, planning, repair and verification contract; generation-specific wording is amended for selected v3 operation by `integrity_generation_aware_core_snapshot_amendment.md` |
| [`integrity_dry_run_reporting_contract.md`](integrity_dry_run_reporting_contract.md) | Shared v2/v3 repair dry-run execution status, proposed-state evidence, unresolved-LIVE state and task-completion semantics |
| [`integrity_modularisation.md`](integrity_modularisation.md) | Integrity module ownership and stage boundaries |
| [`integrity_core_snapshot_identity.md`](integrity_core_snapshot_identity.md) | Immutable run-scoped latest-complete core snapshot identity; generation-specific v2-only wording is amended by `integrity_generation_aware_core_snapshot_amendment.md` |
| [`integrity_generation_aware_core_snapshot_amendment.md`](integrity_generation_aware_core_snapshot_amendment.md) | **Current generation-aware Integrity core identity boundary:** selected `UK_AQ_R2_HISTORY_VERSION` owns matching `history/v2/core` or `history/v3/core`, with one pinned generation-matched identity across check-only, proposal, apply and verification |
| [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md) | Proposal ownership and generic apply safety |
| [`integrity_apply_progress_persistence_contract.md`](integrity_apply_progress_persistence_contract.md) | Durable apply-progress persistence |
| [`integrity_preflight_generation_and_journal_completion_contract.md`](integrity_preflight_generation_and_journal_completion_contract.md) | Preflight generation and journal completion |
| [`integrity_connector_observation_totals.md`](integrity_connector_observation_totals.md) | Connector observation-total evidence |
| [`proposal_dependency_provenance_contract.md`](proposal_dependency_provenance_contract.md) | Proposal dependency provenance |
| [`proposal_run_state_transition_contract.md`](proposal_run_state_transition_contract.md) | Proposal and run-state transitions |
| [`final_staged_write_set_provenance_contract.md`](final_staged_write_set_provenance_contract.md) | Provenance of the final staged write set |
| [`direct_selected_partition_replacement_contract.md`](direct_selected_partition_replacement_contract.md) | Direct selected-partition replacement |
| [`daily_profile_selection.md`](daily_profile_selection.md) | Scheduled selection |
| [`current_state_reconciliation.md`](current_state_reconciliation.md) | Post-verification timeseries and Latest Snapshot reconciliation |

## SOS historical repair

| File | Scope |
|---|---|
| [`sos_light_three_phase_authority_contract.md`](sos_light_three_phase_authority_contract.md) | **Load-bearing SOS-light authority:** Step 0 IngestDB boundary + global observations lock + Dropbox checkpoint/writer-order + observations-root hash gate, then DETECT / PROPOSE / APPLY+VERIFY from the pinned Dropbox baseline and repair overlay |
| [`sos_light_model.md`](sos_light_model.md) | Broad SOS-light complete-day replacement model, subject to the three-phase authority contract |
| [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md) | Additional SOS historical repair behaviour not superseded by SOS-light |
| [`sos_run_scoped_source_acquisition_contract.md`](sos_run_scoped_source_acquisition_contract.md) | Run-scoped SOS source acquisition |

SOS repair may also require the general Integrity provenance, replacement and current-state contracts above depending on task scope.

## Prune Daily Phase B and deletion

| File | Scope |
|---|---|
| [`prune_daily_observation_only_phase_b_contract.md`](prune_daily_observation_only_phase_b_contract.md) | Permanent observation-only Phase B R2 model |
| [`prune_daily_complete_snapshot_child_set_contract.md`](prune_daily_complete_snapshot_child_set_contract.md) | Complete connector-day pollutant child-set replacement for Prune versus Integrity partial-merge preservation, including interrupted same-key canonical child recovery |
| [`prune_daily_v3_latest_global_recovery_contract.md`](prune_daily_v3_latest_global_recovery_contract.md) | Prune-only recovery of stale latest-global exact-v3 scoped identities by independent proof from current canonical connector/pollutant/Parquet authority |
| [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md) | Permanent retirement of calculated AQI as an R2 history product |
| [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) | Compatibility path documenting the retired AQI writer and current observation-only boundary |
| [`prune_connector_day_gate.md`](prune_connector_day_gate.md) | Connector-day observation deletion gate |
| [`prune_connector_day_gate_generation_amendment.md`](prune_connector_day_gate_generation_amendment.md) | Generation-aware v2/v3 canonical connector-manifest keys for Prune gates and dual-generation database constraint compatibility |
| [`prune_connector_source_identity.md`](prune_connector_source_identity.md) | Versioned connector-day source identity for deletion authority |
| [`prune_connector_day_atomic_deletion.md`](prune_connector_day_atomic_deletion.md) | Atomic source revalidation and connector-day deletion |
| [`prune_daily_runtime_budget.md`](prune_daily_runtime_budget.md) | Normal Phase B runtime envelope and v3 UTC-day-boundary finalisation |
| [`prune_daily_test_catchup_runtime_exception.md`](prune_daily_test_catchup_runtime_exception.md) | Temporary TEST-only three-hour catch-up envelope while the accumulated Prune backlog is cleared; shared defaults and LIVE remain unchanged |
| [`phase_b_source_transport_and_egress_contract.md`](phase_b_source_transport_and_egress_contract.md) | Phase B source transport and egress boundary |

For v3 steady-state Prune selection and cut-over, also apply [`observation_history_v3_side_by_side_generation_contract.md`](observation_history_v3_side_by_side_generation_contract.md). The old mixed `v2 observations + v3 index` normal-operation model is superseded.

For controlled post-write verification and the first normal v3 backup boundary, also apply the non-conflicting verification requirements from [`observation_history_index_v3_steady_state_acceptance_amendment.md`](observation_history_index_v3_steady_state_acceptance_amendment.md).

## Cross-area contracts often needed with R2 history

These remain owned by their own areas and should be loaded only when the task crosses that boundary:

- [`../aqi-levels/README.md`](../aqi-levels/README.md) for current calculated AQI and station-history behaviour;
- [`../latest_snapshot/README.md`](../latest_snapshot/README.md) for Latest Snapshot ownership;
- [`../backup_and_recovery/README.md`](../backup_and_recovery/README.md) for R2 history Dropbox backup and rollback evidence;
- [`../station_charts/README.md`](../station_charts/README.md) for public browser station-chart behaviour.

## Precedence reminders

Do not infer authority from file age or filename alone.

Current explicit precedence includes:

- `sos_light_three_phase_authority_contract.md` over conflicting SOS-light currentness, planning, provenance, derived-index dependency and backup-expansion wording;
- `integrity_generation_aware_core_snapshot_amendment.md` over conflicting v2-only generation/core-namespace wording in `integrity.md`, `integrity_core_snapshot_identity.md`, `sos_light_model.md` and older Integrity implementation notes; the base contracts remain authoritative for non-conflicting source authority, latest-complete selection, pinning, proposal/apply, verification and audit semantics;
- `observation_history_v3_side_by_side_generation_contract.md` over conflicting observation-history v3 base/migration/transition/operator/maintenance/rollback/backup wording for migration topology, independent v2/v3 namespaces, the single normal `UK_AQ_R2_HISTORY_VERSION` generation selector, final frozen-source catch-up/cut-over, no v2 shadow publication after accepted cut-over, and intact-v2 same-window rollback;
- `aqi_r2_retirement_contract.md` over older active-AQI-in-R2 wording;
- `prune_daily_observation_only_phase_b_contract.md` over reversible/optional Phase B observation-only wording;
- `prune_daily_complete_snapshot_child_set_contract.md` over generic child-preservation wording when Prune owns a complete connector-day source snapshot;
- `prune_daily_v3_latest_global_recovery_contract.md` over generic strict-preservation wording only for the narrow Prune retained-scope same-key identity-change case that is independently proven from current canonical observation authority;
- `prune_connector_day_gate_generation_amendment.md` over v2-only manifest-key and database completed-evidence-constraint wording in `prune_connector_day_gate.md`; the base gate contract remains authoritative for deletion safety, source identity and gate ownership;
- `prune_daily_test_catchup_runtime_exception.md` over `prune_daily_runtime_budget.md` only for the temporary TEST Phase B maximum, effective deadline, worker timeout and GitHub job timeout while backlog catch-up is active; all other runtime/safety rules and shared defaults remain unchanged;
- `observations_run_exclusion_contract.md` over older canonical-observation fine-grained cross-run concurrency wording;
- `observation_history_index_v3_contract.md` over older post-cut-over physical/index wording only where it does not conflict with the side-by-side generation contract;
- `observation_history_index_v3_exact_leaf_amendment.md` over conflicting v3 base/migration/operator/interface/station-history wording for physical layout, exact lookup, runtime byte-range discovery, physical paging, station-history page/row budgets and the absence of a public higher-level continuation protocol;
- `observation_history_index_v3_transition_modes_amendment.md` over older v3 wording only for non-conflicting exact-leaf/tooling/recovery details; its in-place transition topology, separate index-generation authority and rollback model are superseded by the side-by-side generation contract;
- `observation_history_index_v3_integrity_authority_amendment.md` over operator/preflight wording that treats the Integrity semantic version as a persistent GitHub authority;
- `observation_history_index_v3_recovery_determinism_amendment.md` over migration/operator wording that permits byte-unstable prepared replay or treats a later changed completed-object identity as normally authoritative;
- `observation_history_index_v3_recovery_scaling_amendment.md` over older recovery/migration/operator wording that requires serial resume re-verification or one recovery-journal entry per individual completed/publication evidence object;
- `observation_history_index_v3_test_legacy_resume_and_planner_scaling_amendment.md` over the recovery-determinism amendment's older read-only-only wording for `LEGACY_RECOVERY_ORDERING`, but solely for authenticated mutating resume of the already-created affected TEST recovery state; it does not relax LIVE exact-only recovery;
- `observation_history_index_v3_planner_optimisation_and_test_acceptance_amendment.md` over recovery-scaling and TEST-legacy-resume/planner-scaling wording that makes the old interrupted authority the mandatory final TEST acceptance vehicle or prohibits changing the planner for a subsequent authority; the old authority remains immutable historical evidence, while changed migration/planner code requires a fresh real TEST migration through full verification before LIVE; deliberate interruption is not required, but any natural interruption must be resolved through authenticated resume or safe abandonment/rollback before acceptance;
- `observation_history_index_v3_backup_evidence_location_amendment.md` over migration/operator wording that labels or treats the R2 hierarchical backup inventory as Dropbox-local evidence;
- `observation_history_index_v3_post_cutover_rollback_data_preservation_amendment.md` only for non-conflicting recovery evidence; its requirement to preserve v2 as a current rollback generation after accepted v3-only writes is superseded by the side-by-side generation contract;
- `observation_history_index_v3_steady_state_acceptance_amendment.md` for non-conflicting post-write verification, while the side-by-side generation contract owns when v2 ceases to be claimed as a current rollback generation;
- the older v3 migration/rebuild/maintenance contracts only for details not superseded by `observation_history_v3_side_by_side_generation_contract.md`.

If an apparent conflict is not covered by an explicit precedence statement in an active contract, report it rather than choosing silently.
