# Stage 2I: generic fixed-v3 selected-format rejection

Implemented against TEST Ops `295226251fd13a5934b0e7e40470b0a63a157720` (merged Stage 2H PR #179), on `codex/stage2i-generic-selected-format`. This is a validation-only correction to the active generic APPLY route. Schema-2 repair, publication and source deletion remain unsupported. No deployment or operational repair was performed.

## Authority and execution seam

Read the TEST system-docs router and relevant R2-history/Integrity routes at `21de3471381d71ffc83775f8f26147517f5497d6`, including the accepted future exact-only contract, SOS-light three-phase authority, observations exclusion, implementation safety, generic APPLY safety, dependency/transition/final-write-set provenance, publication ordering and generation-matched Core identity. Stage 2H's report supplied the active-path analysis. No authoritative `system_docs/` was edited and no conflicting contract was found.

Inspected:

- `scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs`
- `scripts/backup_r2/lib/generic_v3_proposal_validation.mjs`
- `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs`
- `scripts/backup_r2/lib/observation_history_integrity_key_allowlist.mjs`
- `scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs`

The active coordinator selects `uk_aq_apply_generic_v3_proposal.mjs`. Its exported bridge checks execution/lock context and configuration, then calls `applyValidatedProposal({ generation: "v3", ... })` with the generic callbacks. The shared executor performs generation admission, `requireGenericV3CoordinatorFreeze()`, independent Core validation, `validateLocalGenericV3Proposal()`, dedicated-mode separation and `validateFinalGenericV3ProposalGraph()`, before constructing/persisting the frozen schedule or executing operations. No alternate active generic fixed-v3 caller was found. The shared legacy CLI remains generation-restricted; dedicated SOS-light retains its own guard.

The new `validateGenericV3SelectedFormats()` runs first inside **generic final-graph validation**. Local proposal loading has already read each staged file and verified its SHA-256/size into `proposal.objects[*].body`. The guard rechecks those buffers and semantic dependency identities. `putAndVerifyObject()` publishes those same buffers, without reopening their staged paths. A second staged-file reload would add no identity protection to this execution model. Existing final source/Parquet/parent checks, scheduling, runtime dependency verification and journalling remain in place.

A guard failure follows the existing final-proposal failure path: `apply.status=failed`, `r2_mutation_possible=false`, no schedule execution, mutation journal, PUT, DELETE, prefix removal, derived/latest publication or success result. This does not depend on the disconnected legacy writer adapter.

## Changes and behaviour

- Added `scripts/backup_r2/lib/generic_v3_selected_format_validation.mjs`.
- Added its invocation/import in `scripts/backup_r2/lib/generic_v3_proposal_validation.mjs`.
- Added targeted checks in `scripts/backup_r2/tests/uk_aq_generic_v3_selected_format.test.mjs` using existing deterministic canonical/index builders and injected local adapters.
- Preserved the exact pre-change generic validator at `archive/2026-11-04/scripts/backup_r2/lib/generic_v3_proposal_validation.mjs`; it matches the base commit. Tests, documentation and new code did not receive archive copies.

Every staged deterministic scoped selector is inspected, including a selector outside declared affected authority. It must have strict schema `1`, kind `observation_timeseries_physical_leaf_scoped_manifest`, version `exact-timeseries-leaf-v1`, matching key/scope and the current supported schema-1 physical identity. Schema 2, unknown/missing/contradictory format fields, direct-canonical schema-2 authority in a schema-1 selector, malformed JSON and non-object shapes fail.

The guard binds affected scopes to the existing canonical selected-scope authority, including metadata-only scopes. It authenticates the checkpoint-pinned original compact latest from local Dropbox and validates its canonical registry with existing helpers. An affected prior schema-2 selection fails, including attempted conversion/removal under an otherwise schema-1 proposal.

An affected non-empty selector must close over actual schema-1 exact leaves, aligned manifest/shards and canonical dependencies. Body references must match frozen SHA/size/provenance; complete leaf membership, scope, counts, coverage, aligned authority and latest descriptor identities must agree. Staged derived objects outside that closure fail. Omitting immutable revision keys or supplying `structurally_validated` flags does not admit a selector-only proposal.

Supported schema-1 complete replacements, metadata-only repairs, authenticated authoritative-empty removal and legitimate pinned external dependencies remain admitted. A byte-identical replacement may keep its selector/latest outside the PUT set when the actual checkpoint-pinned selector and complete compatible dependency bodies authenticate against the final graph. An empty final latest is checked against the existing deterministic empty-registry encoder. No unchanged derived objects are forced into the write set.

For an **unaffected preserved schema-2 reference**, the complete descriptor must remain exactly equal to its checkpoint-authenticated original. It cannot be added, removed, relabelled or altered through latest metadata, and canonical/derived DCP mutations cannot borrow preserved-scope authority. Where canonical ancestors are staged, they must retain the relevant child references and authenticated dependency identities, including agreeing aliases. This permits an unrelated schema-1 repair, including a rebuilt canonical parent that preserves its schema-2 sibling, without requiring schema-2 leaf bodies or immutable revisions in the repair graph.

Ambiguous affected selection, missing checkpoint/body/closure, changed preserved descriptor, omitted preserved canonical child, conflicting source or unavailable external dependency fails closed. Traversal is limited to the frozen affected graph, explicit local dependencies and known retained-scope ancestor paths. There is no live-R2 lookup, additional backup inventory or new schema registry. Invocation-local dependency maps/cache avoid repeatedly scanning the same dependency lists or hashing the same file for every leaf.

## Targeted validation and baseline

Node `v24.19.0`.

- **22 new checks passed.** They cover supported schema-1 replacement/metadata-only/empty/external graphs, unchanged selector/latest reuse, mixed preserved schema-2 references and canonical-parent preservation; schema-2/unknown/missing/malformed selectors; selector-only and metadata-only incomplete graphs; body/leaf/dependency/latest contradictions; changed staged files; prior schema-2 conversion; unchanged allowlist rejection of immutable revisions; and zero adapter calls/no finalisation on admission rejection through the actual bridge. A positive bridge check reaches the validated frozen schedule and deliberately stops at the absent retained database adapter, without executing a repair.
- The **same 22 checks on unchanged Stage 2H main** produced **8 passes / 14 failures**. Unsupported inputs reached the old scheduling/execution boundary instead of the required format rejection. This is a comparison of local structural checks, not a claim that a real mutation was performed.
- **27 existing Stage 2H focused checks passed**: 25 offline/selected-format reconstruction checks and 2 retained-lock/Integrity-child checks. These use mocks/local fixtures, not a genuine database lock session.
- Existing proposal-transport checks produced **15 passes / 9 failures both before and after** the change, with identical failing test names and the existing `Generic fixed-v3 unexpected preserved source authority` error. Their fixtures omit the current required source-authority null field. These baseline failures were not repaired or hidden.
- Syntax checks for both validators, the new checks, generic bridge and shared executor, a real generic-bridge import, archive/base equality and `git diff --check` passed.

Commands:

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap scripts/backup_r2/tests/uk_aq_generic_v3_selected_format.test.mjs
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs scripts/backup_r2/tests/uk_aq_selected_format_reconstruction_v3.test.mjs
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-name-pattern='lost retained lock|Integrity apply child verifies' --test-reporter=tap tests/uk_aq_observations_global_operation_integration.test.mjs
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap scripts/backup_r2/tests/uk_aq_sos_light_v3_proposal_transport.test.mjs
```

The complete Node/Python suites were not run and are not claimed green. Functional acceptance requires a separately authorised TEST deployment and finite real operation. No apply/deploy command is authorised or supplied here.

## Chat-mode handover and remaining interfaces

Record Stage 2I as explicit **generic pre-mutation rejection**, not successful schema-2 repair admission. The selected-format guard supplements the existing mode-specific freeze and final graph. No proposal/fingerprint version, environment configuration, schema, persistent ledger, SQL or service changed. Rollback is a normal reviewed Git revert of this PR; archive paths are never executable recovery paths. Reverting also restores the Stage 2H admission gap.

Next decisions remain separate and unimplemented:

1. Transport a genuine original Integrity owner/run/session-bound lock assertion through the coordinator/process boundary; fail permanently on loss, replacement, timeout or disconnection, without acquiring another lock. Inherited context is still not that assertion.
2. Define a validation-only frozen schema-2 proposal representation with complete immutable closure, accepted source/baseline, finite scopes/budgets and prior selector identities. Stage 2F preparation remains insufficient and the immutable-key allowlist remains closed.
3. Only after those interfaces, separately integrate authenticated APPLY-time current-object admission; separately authorise any actual schema-2 execution.

No schema-2 APPLY/publication/source deletion or immutable retirement, Prune activation/pre-READY change, Stage 2D restart recovery, JSONgen event/receipt/outbox/monthly rule, backup/restore/conversion scope or Station History behaviour was enabled. `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3` stays `false`; the shared key allowlist and dedicated SOS-light guard are unchanged. No R2, PostgreSQL, Dropbox, Cloudflare, deployment or LIVE operation was performed. Remote work was limited to authorised TEST Git/GitHub delivery.
