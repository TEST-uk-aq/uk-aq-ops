# Stage 2F: offline backup-derived reconstruction preparation

Based on current TEST Ops main `a77c9a96cc239c48762f67312a27439e2bf554b1` (merged #174, including #172/#173). Applicable authoritative system-docs were read from the sibling TEST repository at `fc877e4b590990f24aadf7ecd7185748da3b3bbc`. Authoritative `system_docs/` was not edited.

## Result

**A bounded subset is structurally reconstructible without retained derived object bodies or live R2 access.** The new preparation interface independently inspects actual backed-up Parquet and regenerates the selected format. It accepts the original reconstruction only if its complete scoped-root descriptor exactly reproduces the checkpoint-selected descriptor, including selector key/size/SHA, format and coverage. The selector SHA authenticates its complete immutable leaf identity map; the schema-2 builder derives every revision key and exact leaf byte identity using the existing canonical encoding.

This proves reproduction of the **checkpoint's prior state**, not the current live selection, existence, strong ETag or publication status. The result is explicitly read-only and not publication/APPLY eligible. No writer-completion proof capability is minted.

An independently accepted repair overlay can then prepare different derived identities against its complete proposed canonical hierarchy. Original selected and newly prepared identities remain separate. There is no new event, JSONgen PENDING/CONFIRMED dataset, Prune gate or deletion authority.

The ordinary fixed-v3 planner still blocks affected schema-2 scopes; neither existing repair APPLY path was enabled. This PR adds an explicit callable preparation interface, not an executable repair/restore command or transport.

## Evidence matrix

| Input | Offline availability / derivation | Boundary |
| --- | --- | --- |
| Accepted backup/checkpoint identity | Existing independently accepted `runState.dropbox_currentness` snapshot; `allowed === true` and pinned compact latest key/size/SHA required | This adapter consumes that prior acceptance; it does not authenticate a new remote checkpoint or run Step 0 |
| Canonical root/year/month/day/connector/pollutant bodies | Retained local baseline; root content hash must equal the checkpoint processed-source-root hash | Complete selected ancestor chain, validated aggregate children, aliases, selected child descriptors, file tables and totals required |
| Canonical Parquet | Actual local bodies, checked against canonical key/order/size/SHA and independently inspected | Missing/altered bytes, physical routing, content/status/hash or version contradictions fail |
| Selected schema and selector identity | Checkpoint-authenticated compact latest registry | Cannot infer format from canonical observations alone or use checkpoint identity as current predecessor |
| Original selector/immutable leaf bodies | Normally absent from backup | Not required when complete deterministic reconstruction reproduces the checkpoint selector exactly; otherwise an explicit identity-reproduction blocker |
| Row groups, series membership, file counts, row totals, ranges and decode profile | Derived by existing `canonical-aligned-offline-v1` actual-byte inspector and existing validators | No independent backup-specific Parquet implementation; schema 3 / writer v3 / observation hash v1 only |
| Accepted repair source | Existing pollutant-scoped `source_evidence_partitions` with pinned evidence/rows SHA; existing immutable source loader validates them | Unpinned legacy self-described source files are insufficient for this adapter |
| Prepared canonical overlay | Current-run staged entries: built, structurally validated, changed, included/proposed, exact size/SHA; source ownership required for pollutant/Parquet | Independently decoded semantic metadata must match accepted source's final target, including status/hash version; consumed bytes and source evidence are rechecked |
| Operational current selector, strong ETags, conditional predecessor and held lock | **Unavailable offline** | Not inferred from SHA, root equality, reconstructed local bytes or prior backup acceptance |
| Independent Core/binding/status domains | Existing separate authorities remain required by their owning operations | This observation-index preparation does not reconstruct or attest those domains |

## Interfaces and files

1. `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs`: adds `prepareOfflineObservationHistoryScopeV3({ scope, getObject, exactSchemaVersion })`. It reuses the existing full canonical-chain authentication, direct physical inspector, logical/status reconciliation and deterministic schema-1/schema-2 builder. Its local-byte context hashes actual bodies and rechecks them. It has no ETags, held-operation assertion or entry in the operational physical-proof WeakMap. Existing operational verifier APIs retain their behavior.
2. `scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs`: adds `prepareOfflineExactV3Reconstruction({ runState, baselineStore, scopes, repairOverlay = null })`, consuming the existing checkpoint and source-specific local-store interfaces. It requires an explicit finite nonempty unique scope list and returns only per-scope preparation results. `repairOverlay`, when supplied, contains `{ store }`; current-run identities/source evidence come from the accepted `runState` snapshot. No global latest or executable proposal/write graph is returned.
3. `scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs`: targeted deterministic identity/provenance/compatibility checks, including actual filesystem-backed `createCombinedLocalStore` adapters.
4. `docs/superpowers/plans/2026-11-04-stage2f-offline-reconstruction.md`: bounded implementation plan and review/verification ledger.
5. This investigation and Chat-mode handover.

The two active files already have copies in `archive/2026-11-04/` from Stage 2E. The once-per-day archive rule requires reusing those copies, without overwriting them. Exact Stage 2F immediate predecessors are additionally retained by base commit `a77c9a96`; no archive is imported or executed.

### Calling boundary

`baselineStore.getObjectFromSourceIfExists(key, "dropbox")` must expose the **unmasked original pinned baseline**, with `source: "dropbox"`. The existing combined store can hide baseline files under proposed tombstones; such a masked view cannot establish original identities. Supply the accepted baseline view separately, as before overlay masking, or preparation fails explicitly. Do not substitute overlay bodies for missing original baseline bytes.

For changed current-run entries, `repairOverlay.store.getObjectFromSourceIfExists(key, "overlay")` must expose `source: "planned_overlay"`. The adapter hashes the actual bytes and compares them to the cloned accepted run-state identity. Mere local presence does not make an unchanged planning record an overlay authority: unchanged/skipped/excluded entries resolve from the baseline. Proposed/deleted exact tombstones and proposed exact-object/prefix tombstones block baseline fallback. A changed authenticated replacement can satisfy a tombstoned key; an omitted replacement cannot borrow the deleted old body.

Source-evidence loading is reused, including its supported final-target/preserved-source semantics. The adapter additionally requires the captured pollutant-scoped source-evidence identity, compares the independently inspected final canonical semantic metadata with `finalTargetMetadata`, then rechecks source files before returning. The interface does not acquire or approve a fresh repair source.

### Returned identities

Each scope retains `checkpoint_selected_selector`, `baseline_canonical_source`, `prepared_selector`, `canonical_source_manifest`, `canonical_chain`, selected format, hierarchy bytes and inspected source provenance. `selected_identity_reproduced` describes the authenticated original baseline reconstruction. `prepared_matches_checkpoint_selection` is false for different prepared bytes. `source_changed` describes a change to the canonical source descriptor; it is not an emitted observation-change event, and metadata-only changes also grant no event authority.

Top-level results explicitly state `read_only: true`; publication, repair APPLY, original writer completion, observation event, JSONgen PENDING/CONFIRMED and source deletion eligibility are false. `current_object_authority` is null. Physical-proof consumers reject these results because no operational proof handle exists.

## Supported subset and blockers

- **Unchanged schema 2:** complete supported canonical source independently reproduces exact selected selector and immutable revision identities. No retained derived bodies, ETag guess or live lookup is needed.
- **Changed repair overlay:** original baseline must first reproduce exactly. Complete authenticated proposed canonical hierarchy/files plus pinned accepted source evidence can prepare new schema-2 identities; these are not selected/current/published identities.
- **Schema 1:** the same mature builder and encoder preserve exact schema-1 bytes, aligned source and aligned child dependencies. Ordinary production behavior is unchanged.
- **Mixed formats:** the shared compact-latest validator/builder preserves each scope's selected format. The deterministic check reconstructs both formats against one canonical hierarchy/checkpoint and reproduces the original mixed latest exactly, without schema-2 aligned dependencies.
- **New/removed scopes:** this bounded API handles existing selected nonempty scopes only. Missing selected scopes and required tombstoned bodies block. Schema-2 operational removal, new-scope selection and conversion are not introduced. The ordinary schema-1 planner's previously accepted new-scope behavior is unchanged.
- **Missing/unauthenticated latest, unknown/missing selected format, contradictory root/checkpoint/aliases, missing/altered files, incompatible physical/hash/status/profile or contradictory dependencies:** block before a result is returned. There is no downgrade to schema 1.
- **Changed local bytes/source evidence during preparation:** fail rechecks; start again from accepted pinned inputs.
- **Historical fields not recoverable from canonical bytes:** fail exact selected-identity reproduction, even if logical observations match. A valid previously emitted leaf may contain optional original file ETags; canonical SHA is not that ETag. The targeted check demonstrates this case. Unknown historical profile/encoder differences or other semantic leaf fields can have the same effect. No SHA inversion or guessed identity is attempted.
- **Canonical content advanced after backup, intervening index-only conversion, partial selector/latest publication or superseded selection:** offline preparation cannot adjudicate these live states. It reconstructs prior checkpoint state only; all current-object and publication authority remains blocked. Even unchanged observation-root identity is not proof of current selector identity.

Universal exact historical byte restoration is therefore **not established**. If a blocked historical selection must be restored exactly, a future contract decision must identify an authenticated source for the missing original semantic fields/bodies or explicitly version acceptable reconstruction/equivalence semantics. A bounded historical-reader/format amendment may suffice; this PR does not choose a new retained payload, proof catalogue, persistence layer or routine full-tree backup.

## Backup and restore compatibility

`build_backup_inventory.mjs` and `restore_history_from_dropbox.mjs` were inspected and not changed. Inventory still selects one compact latest unit with its exact path/size/SHA alongside canonical files/manifests, existing hierarchy/checkpoint, run, Core and binding authorities. No complete exact selector/leaf tree is added to backup. Scheduled backup, Dropbox sync and packed-binding restore are untouched.

The generic restore utility predates the complete hierarchy and is still not complete system-wide restore authority. This callable preparation API adds neither recovery of independent domains nor a restore executor. It is not permission to invoke the old generic restore workflow.

## Validation and independent review

Node `v24.19.0`; all functional fixtures were local serialized Parquet with synthetic process configuration. No R2, Dropbox, database, Prune, backup, migration or APPLY operation was run. GitHub network access is delivery only.

**90 focused checks passed, 0 failed:** 14 new preparation checks plus the same 76 focused checks reported by Stage 2E. This covers exact unchanged schema-1/schema-2 output, one-checkpoint mixed hierarchy/latest identity, source-authorized changed overlays, real local-store adapters, missing/contradictory inputs, non-derivable historical ETags, unsupported schema capability, mutable bytes/evidence, tombstones, unchanged provenance, no operational proof, dormant publisher and existing completion/APPLY guards.

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap \
  scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs \
  scripts/backup_r2/tests/uk_aq_plan_sos_light_v3_observation_metadata.test.mjs \
  scripts/backup_r2/tests/uk_aq_selected_format_reconstruction_v3.test.mjs \
  tests/uk_aq_exact_only_reconstruction_v3.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs \
  tests/uk_aq_prune_exact_only_lifecycle.test.mjs \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  tests/sos_light_v3_backfill_boundary.test.mjs
```

The two modified implementation files and the new check file pass `node --check`; both implementation modules pass bounded import checks with `tests/jsongen_test_environment.mjs`. `git diff --check` passes.

The independent read-only reviewer identified two material overlay issues: removed objects could incorrectly fall back to baseline, and unchanged planning records could incorrectly shadow baseline. Both were reproduced by failing checks and fixed; all focused checks then passed. A further source-provenance check rejects unpinned legacy self-described evidence. No reviewer minor findings were deferred.

**Baseline limitation:** Stage 2E separately reported 81 baseline-matching failing assertions and 87 matching TAP error headers across migration, Integrity-writer and proposal-transport files. Those are historical assertion/header counts, not complete-suite file-process totals. Those three baseline-sensitive files were not rerun or repaired here: their execution paths are not changed by this separate preparation interface. The current 90-pass result is a focused result, not a claim that the complete suite is green. The user and repository require narrow local checks; no complete Node/Python suite was run. Local TAP evidence is in `/tmp/stage2f-*.tap` in this task workspace.

## Chat-mode documentation handover and remaining prerequisites

Record **bounded offline read-only schema-2 reconstruction preparation implemented in TEST code**, separate from operational schema-2 repair/reconstruction/removal. Explain that independently inspected canonical bytes can reproduce the original selected immutable identities exactly for the supported subset, while non-derivable historical fields remain explicit blockers. Record the accepted-checkpoint/local-store/source-evidence API, separate unmasked baseline requirement and proposed-versus-prior identities. No SQL, environment/configuration, backup-policy or deployment change is required.

Future schema-2 repair APPLY still requires separately approved integration of actual current selector/canonical/files/immutable identities; the current strong-ETag conditional predecessor; held original global writer exclusion; immutable create-or-exact-reuse and supported conditional writes; uncertain-write readback; complete canonical parent/root/latest finalisation; and preservation of independent source/deletion, Core/binding/status and JSONgen currentness boundaries. Offline bytes cannot replace any of these. Do not introduce pre-APPLY live-R2 planning/dependency discovery into DETECT/PROPOSE.

Real acceptance remains a later independently authorized TEST deployment plus actual backup-derived reconstruction/restore and failure cases, with compatible consumers deployed before any schema-2 publication. Physical schema 4, index-only conversion execution, original Prune cross-invocation recovery, monthly JSONgen and LIVE remain separate gates. `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false`, Prune's pre-READY rejection, original gate/outbox and schema-1 production remain unchanged. No historical schema-1/aligned/v2 objects were modified or deleted.

No manual apply/deploy/run command is part of this delivery. Rollback is a code revert of the two implementation additions; archive files are reference only. The PR must not be merged or deployed by this task.
