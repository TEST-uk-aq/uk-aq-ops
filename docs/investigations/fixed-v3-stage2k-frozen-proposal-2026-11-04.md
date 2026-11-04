# Stage 2K: frozen schema-2 proposal representation review

**Investigation-only result: no implementation files changed.** Complete frozen schema-2 repair preparation and independent validation remain blocked on a supported preparation-only representation decision. The task required stopping this part if a new proposal schema or contract decision was necessary. No new schema, API, fingerprint or validator success result was introduced.

This report contains findings from this public repository's code, PR status and local checks. The contract handover is separate; authoritative documentation was not edited.

## Base and review

Actual TEST main was `99426232f8244a5aac2567985eb3b0e2038a0742`. [PR #182](https://github.com/TEST-uk-aq/uk-aq-ops/pull/182) merged at that SHA on 4 November 2026 at 16:39:10 UTC. Stage 2J is therefore part of the base; no unmerged work was copied. Branch: `codex/stage2k-frozen-schema2-proposal`.

The supplied checkout was stale and the configured shell Git proxy was unreachable. A scoped current-main checkout was materialised through the GitHub connector. The signed base commit, reconstructed trees and downloaded blobs were checked against their Git identities. All 188 materialised tracked files, including implementation and checks, matched pinned main before this report was added.

The review covered the actual PROPOSE/APPLY paths, offline reconstruction, selected-format rejection, immutable builders, file-backed transport and Python/Node freeze projections. See the preceding [Stage 2F](fixed-v3-stage2f-offline-reconstruction-2026-11-04.md), [2H](fixed-v3-stage2h-apply-authority-2026-11-04.md), [2I](fixed-v3-stage2i-selected-format-2026-11-04.md) and [2J](fixed-v3-stage2j-original-session-2026-11-04.md) public handovers.

## Structural findings

1. [File-backed transport](../../scripts/backup_r2/lib/sos_light_v3_proposal_transport.mjs) preserves exact local bytes, SHA-256, sizes and body references. It can technically carry schema-2 files; it does not independently validate their complete repair closure or define preparation-only admission.
2. In the actual [Python coordinator](../../scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py), `_load_authenticated_v3_proposal_result()` accepts `planned`, or separately allowed `blocked_dependency`; **a blocked result must contain no proposals**. `_record_metadata_executor_overlay()` and `stage_file_backed_proposal_object()` transfer changed/required records into staged `runState.objects`. There is no supported populated preparation-only state at this boundary. Extra eligibility flags alone do not change its admission rules.
3. The [key allowlist](../../scripts/backup_r2/lib/observation_history_integrity_key_allowlist.mjs) excludes schema-2 immutable revision keys. Local and external-dependency admission both use it. The task requires keeping this mutation boundary closed.
4. The [generic selected-format guard](../../scripts/backup_r2/lib/generic_v3_selected_format_validation.mjs) rejects affected prior-schema-2 selections and staged schema-2/unknown selectors. The [dedicated SOS guard](../../scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs) independently rejects schema 2 before complete-day deletion admission. These remain rejection boundaries, not positive preparation admission.
5. The [generic freeze](../../scripts/backup_r2/lib/generic_v3_proposal_validation.mjs), SOS freeze and matching Python projections bind their existing staged identity/provenance and mode-specific mutation authority. Current generic scope/fingerprint identifiers are v4/v5; the SOS fingerprint is v2. They do not define the requested schema-2 preparation projection of distinct prior/final selectors and finite whole-closure resource admission. Existing schema-1 semantics must retain their meanings.
6. [Stage 2F](../../scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs) authenticates accepted-checkpoint original selected identity, canonical/physical bytes and separately pinned overlay/source evidence, then rechecks the subset. It returns per-scope existing-nonempty reconstruction results, not the final complete canonical/physical/derived/aggregate/latest mode-specific frozen repair graph. Its finite explicit scope list has no explicit maximum for total scopes, unique objects, aggregate bytes, decoded rows or peak working resources. Existing per-file caps are not a whole-closure budget.

The [immutable builder](../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs) and [format validators](../../workers/shared/uk_aq_observation_history_exact_leaf_format_v3.mjs) already provide schema/kind/version dispatch, revision derivation from canonical semantic bytes with `key` omitted, full-leaf SHA/size, sorted membership and direct-canonical schema-2 dependencies. Schema-1 aligned dependencies remain separate. No new index layout or hash primitive is needed.

The [offline verifier](../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs) authenticates canonical ancestor/alias/file identities and inspects actual complete physical bytes independently of leaf claims. Its reconstruction subset remains physical schema 3, writer v3 and observation hash v1 with the existing aligned-v2/direct-column profile. Schema-4 reader compatibility does not establish schema-4 rebuild capability. Non-derivable historical optional ETags/profile fields and ambiguous hash versions remain blockers; a project SHA is not an original/current ETag.

Generic authority already distinguishes nonempty replacement, authoritative-no-data and unavailable-source preservation. Supported schema-1 empties remove the target without a synthetic zero-row exact manifest. Stage 2F does not extend this to schema 2; `resolveExactV3SelectedFormat({ removing: true })` explicitly blocks schema-2 removal before legacy exact/aligned prefix deletion. A new representation must state its supported empty/new/removal subset without inferring immutable revision retirement.

## Decision needed

Define a supported, versioned **preparation-only extension** of the existing proposal/run-state representation, reusing local body-reference transport where possible. It must specify:

- An enforced non-executable state and independent validator, separate from `planned` mutation candidates and empty blocked results. `repair_apply_eligible` and `publication_eligible` remain `false`; ordinary APPLY must reject it.
- A frozen projection of accepted checkpoint/baseline/source identities, complete finite mode-specific scope, distinct prior/final selector and format or authenticated absence, exact canonical/file/immutable/scoped/aggregate/latest dependencies, provenance and supported empty/preserved/no-op outcomes.
- Mandatory finite scope/object/byte/decode/resource admission before allocation or parsing, applied equally to preparation and independent validation. No unlimited default, new operator setting or permanent proof store.
- Complete independent source/physical/graph validation and versioned compatibility, including matching Python/Node projection where both carry the new freeze. Historical identifiers retain their original meanings.

This decision does not require a new database, service, ledger, backup domain or index layout. It does not grant APPLY, conversion, selector publication or an operational physical-proof capability. It was not silently implemented in this report-only PR.

## Validation

**47 existing directly relevant checks passed, zero failed**, using Node `v24.19.0`: 14 offline reconstruction checks, 11 selected-format reconstruction/rejection checks and 22 Stage 2I generic format/closure checks including nested checks.

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap \
  scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs \
  scripts/backup_r2/tests/uk_aq_selected_format_reconstruction_v3.test.mjs \
  scripts/backup_r2/tests/uk_aq_generic_v3_selected_format.test.mjs
```

Eleven relevant Node syntax checks, the actual planner import, Python coordinator compilation and report diff checks passed. No operational entry point was executed. Implementation and check files remained identical to pinned main; no new tests were added. These local checks establish existing supported preparation and rejection only, not a newly implemented frozen graph or real PostgreSQL/R2 acceptance.

The public Stage 2I handover reports nine unchanged-baseline proposal-transport failures; Stage 2J reports one unchanged-baseline coordinator-SIGKILL PID-disappearance timeout. Those separate checks were not rerun or reported fixed here. Full suites were not run. Initial missing imports were resolved by materialising exact current-main dependencies before the successful checks.

## Preserved boundaries and delivery

The sole repository change is this report. No implementation, tests, configuration, schema or authoritative documentation changed. No code archive was required or created; existing same-day archives were left intact and not executed. Rollback is a documentation revert.

Generic/dedicated schema-2 rejection, immutable-key restriction and `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false` remain unchanged. Schema-1 proposal/mutation/verification/finalisation and Stage 2J's callable transport remain unchanged; no per-mutation assertion was added. Prune's original-operation, completed-batch, gate, outbox, receipt/deletion protocols and Stage 2D recovery were not changed. Backup scope and independent Core/binding/status/JSONgen authority were not expanded.

After preparation representation acceptance, future APPLY still independently needs original continuously held Integrity-session assertions; bounded current canonical/selector/complete immutable/file authentication; actual strong selector ETag/predecessor; comparison with frozen prior/proposed identities; final rechecks; immutable create/exact-reuse; conditional selector replacement and ambiguous-result reconciliation; and complete canonical/root/latest finalisation. Current-object admission belongs at APPLY, not DETECT/PROPOSE. The existing permitted Step 0 currentness gate is unchanged.

No remote SQL, R2/Dropbox content lookup or mutation, Prune invocation, source deletion, deployment, conversion, recovery, operational activation or LIVE repository work occurred. GitHub work was limited to TEST source/status reads and authorised report branch/commit/PR delivery. No apply/deploy/run command is supplied; functional acceptance remains a separately authorised deployment and finite real TEST operation after the missing boundaries exist.
