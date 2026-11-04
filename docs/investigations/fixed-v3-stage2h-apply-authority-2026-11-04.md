# Stage 2H: fixed-v3 APPLY-time authority and repair readiness

## Result

**Investigation-only delivery: successful schema-2 repair admission remains blocked at the active Integrity/SOS-light APPLY process boundary. No implementation files changed.** Existing components can authenticate selected schema-2 bytes and physical files when supplied a genuine continuously held operation adapter. The active repair children do not expose that complete interface, and Stage 2F preparation is not a validated frozen schema-2 repair proposal. Adding a success-returning admission helper using only the children's environment context or the offline preparation report would assert authority those inputs do not establish.

This takes the investigation-only option in the Stage 2H request. It does not claim that all components are missing, that a new lock service is needed, or that schema-2 repair has become operationally compatible. The smallest next work is an authenticated Integrity process-boundary adapter and a separate validation-only schema-2 proposal boundary, described below. Existing schema-1 execution stays unchanged.

Source baseline: TEST Ops `627cbef48becc9856cd89dfd6547b9198f0e1e0a`, current `main` when inspected, with parent `bcf17e40f2992258a05dbfdca0bf3edce48b91b0` (PR #178) and the requested #172/#173/#174/#177 history. Authoritative contracts were read from TEST system-docs `21de3471381d71ffc83775f8f26147517f5497d6`. The supplied local checkouts were older; a scoped checkout of exact current Git objects was materialised through the GitHub connector because the execution workspace's Git proxy was unreachable. Downloaded blobs, tree objects and the signed base commit were checked against their Git identities. No older implementation was used as the PR base.

## Authority and reading route

The route began with the current `SYSTEM_OVERVIEW.md`, R2-history and backup/recovery READMEs, then the accepted future exact-only contract, SOS-light three-phase authority, observations exclusion, implementation safety, transition modes and backup amendment. Relevant Integrity APPLY safety, proposal dependency/transition/final-write-set provenance, preflight/journal, canonical hierarchy, shared writer, direct replacement and generation-matched Core identity contracts were consulted. The Stage 2E and Stage 2F investigation handovers were read.

The accepted exact-only contract governs schema-2 direct canonical dependencies, immutable revisions, complete physical proof and single-selector publication. It does not activate repair. SOS-light DETECT/PROPOSE still use the accepted checkpoint, canonical Dropbox baseline, immutable source and repair overlay. Step 0's locked observations-root equality is the existing narrow pre-planning R2 exception. Any future current-selection admission must run only after proposal freeze, inside APPLY, and must never become planning or preservation input.

Authoritative `system_docs/` was not edited. Stage 2D's decision was treated as controlling; its investigation was not reopened.

## Actual execution paths

| Boundary | Current code and behaviour |
| --- | --- |
| Coordinator entry | `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.sh` launches the repository Python coordinator. `run_canonical_apply_executor()` in `uk-aq-history-integrity-sos-light-v3_impl.py` authenticates complete persisted proposal ingestion and pinned Core identity, validates the final transition, records the mode-specific fingerprint, then launches the selected Node child with `subprocess.Popen`. |
| DETECT/PROPOSE | `scripts/backup_r2/uk_aq_execute_v2_observations_repair_impl.mjs` supplies the combined local store and staged ownership/tombstone machinery, despite its historical filename. `uk_aq_plan_sos_light_v3_observation_metadata.mjs` builds fixed-v3 derived metadata from pinned local authority. `prepareOfflineExactV3Reconstruction()` is explicitly callable preparation; it does not produce an executable frozen repair graph. |
| Dedicated SOS-light frozen validation | `uk_aq_apply_sos_light_v3_proposal.mjs:applyValidatedSosLightV3Proposal()` checks fixed v3, coordinator lock context and generation-matched Core, then invokes `validateLocalSosLightV3Proposal()`, `validateFinalSosLightV3ProposalGraph()` and the pinned unreferenced-connector gate. |
| Dedicated SOS-light mutation | The bridge calls `sos_light_v3_apply_persistence.mjs:runPersistedSosLightV3Apply()`. This executes the frozen per-day graph and shared tail directly: planned complete observation-day deletion, exact staged PUTs, byte and required source-semantic verification, then the frozen shared metadata tail/latest. It does **not** call the disconnected canonical writer adapter. |
| Generic fixed-v3 frozen validation | `uk_aq_apply_generic_v3_proposal.mjs:applyValidatedGenericV3Proposal()` dispatches to `uk_aq_apply_integrity_proposal.mjs:applyValidatedProposal({ generation: "v3", ... })`, using `requireGenericV3CoordinatorFreeze()`, `validateLocalGenericV3Proposal()` and `validateFinalGenericV3ProposalGraph()`. The mode-specific authority includes selected replacements/removals or explicitly supported metadata-only scope. |
| Generic mutation/finalisation | `applyValidatedProposal()` freezes a dependency schedule, executes the admitted deletions and staged objects through its existing writer/finaliser and verification machinery, and persists completion/journal evidence. This is another execution of frozen bytes, not a schema-2 conditional selector publisher. |
| Separate legacy adapter | `lib/observation_history_integrity_writer_v3.mjs:runValidated*()` loads validated source partitions and calls `runDisconnected*()` operational writers. The active fixed-v3 bridges above do not import this adapter. Its guard is real, but is not proof of protection at every active APPLY entrance. |
| Current-object/physical helper | `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs` has current GET, canonical-chain, selected immutable-leaf and independent physical inspection helpers. These are not invoked as a new repair admission stage by either active bridge. |

This distinction matters: neither the shared publisher's inactive flag nor a guard in `runValidated*()` can be cited as if the active direct frozen-byte executors necessarily passed through it.

## Existing rejection boundaries

1. The normal planner's `resolveExactV3SelectedFormat()` preserves each checkpoint-selected format. It rejects selected schema-2 removal before legacy exact/aligned prefix deletion. `buildExactV3HierarchyForCatalogueEntry()` rejects an affected selected schema-2 scope before invoking the schema-1 builder. Full fallback retains format authority and therefore also blocks when it needs such a scope. An unaffected schema-2 descriptor may remain in compact latest; that is not affected-scope repair permission.
2. Dedicated `validateDedicatedSosHistoricalProposalV3()` explicitly rejects schema-2/unknown selector bodies before complete-day deletion admission. `validateLocalSosLightV3Proposal()` calls it.
3. The active shared proposal key allowlist in `lib/observation_history_integrity_key_allowlist.mjs` recognises schema-1 exact leaf names and aligned objects. It does not recognise schema-2 immutable keys of the form `.../_exact_v2/timeseries_id=<9 digits>/revision=<sha256>.json`. `validateLocalProposal()` rejects such a staged object or external dependency through `requireObservationHistoryIntegrityKey()` / external-dependency validation. A complete affected schema-2 replacement graph cannot pass this existing interface.
4. The separate legacy Integrity writer's `assertValidatedApplyRepresentation()` explicitly rejects schema-2/unknown selector payloads before source loading. This protects that adapter, not the generic direct bridge.
5. Legacy migration/rebuild rejects a compact registry containing selected schema 2 and checks actual selected schema-1 bodies before its old reconstruction route. It is not a repair workaround.
6. `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3` remains `false`. The shared publication finaliser derives schema-2 policy from bytes and rejects it. Existing dormant Prune conditional publication is separately original-operation-bound, not an Integrity repair publisher.

**Important limit on the generic guarantee:** the generic bridge has no dedicated equivalent of the SOS selector-body schema-2 guard. The allowlist accepts the deterministic selector pathname without authenticating its selected format; its immutable revision rejection is a key-family boundary, not a universal payload-format guard. The shared final parent validator specifically checks v2 scoped-index semantics and does not establish a complete schema-2 direct proof graph. Therefore this investigation does not claim every hand-constructed selector-only generic proposal is rejected by schema inspection. Normal affected schema-2 planning and complete revision graphs remain blocked. A future validation-only integration must explicitly establish format/closure at this actual entrance; widening its key regex alone would be unsafe. No guard was relaxed or execution route enabled here.

## APPLY-time authority matrix

Classification: **E** = existing independently authenticated evidence at its owning boundary; **A** = available through a supported existing adapter but not a complete connected repair admission; **L** = available only inside the continuously held original operation; **O** = offline preparation, insufficient for current APPLY; **M** = missing integration or explicitly unsupported decision. These describe interfaces, not observations of real R2 in this task.

| Requirement | Classification and existing evidence | Remaining boundary |
| --- | --- | --- |
| Selected canonical root and complete descendant chain | **A/L.** Direct verifier `canonicalSource()` reads and validates root/year/month/day/connector/pollutant, aggregate hashes, selected child identities, matching aliases and repeated file tables. | Requires genuine held-operation assertions around reads/rechecks. A root hash alone does not authenticate a complete descendant chain or derived selection. No such live read was executed here. |
| Current scoped selector key/body/size/SHA | **A/L.** `readStoredExactOnlyHierarchy()` reads the deterministic selector; validators reconcile its complete schema-2 body and selected immutable leaves against canonical authority. Reconstruction also authenticates its compact-latest descriptor. | Not exposed as proposal-bound admission in the active repair child. Validate the parent and enforce the finite read budget before following its leaf map. |
| Current selector strong ETag | **A**, export gap **M**. Native `r2GetObject()` returns the actual response ETag; `isStrongR2Etag()` recognises a quoted strong validator. | Direct verifier contexts retain ETags internally but exported selector identities strip them, and their context only requires a nonempty ETag. Its report cannot serve as a strong conditional predecessor. Require strong current GET identity explicitly; SHA is never an ETag. |
| Previous selected-format identity | **O**, current reconciliation **M**. Checkpoint-authenticated compact latest and Stage 2F preserve original selector format/key/size/SHA. | Authenticate actual current selector separately and compare with frozen prior identity. Same observations-root content hash does not prove unchanged selection. |
| Complete immutable leaf map | **A/L.** Schema-2 parent commits numerically ordered complete leaf tuples; full artifact validation reconciles membership/counts/dependencies. | Active repair proposal closure cannot represent its immutable revision family. No requested-leaf-only shortcut is sufficient. |
| Required selected immutable leaf bodies and exact revisions | **A/L** through current GET and strict revision/body validators; **O** when deterministically reconstructed offline. | Current object existence/body is independent of offline reproduction. Missing/conflicting revision, changed selection or unbounded traversal blocks. Never overwrite a different revision body. |
| Actual canonical Parquet identities | **A/L.** Direct verifier GET hashes actual complete bytes and reconciles canonical key/size/SHA; repeated reads or checksum-capable HEAD also compare ETag. | A checksum-incapable HEAD uses the helper's full-GET recheck; contradictory HEAD cannot fall back. Preserve per-file caps and add admission-wide scope/object/byte bounds. |
| Supported direct physical verification | **A/L.** `inspectPinnedCanonicalObservationFilesV3()` independently checks actual serialised bytes, complete physical routing/columns/ranges and decoded canonical hash/status/counts. | Supported reconstruction subset is schema 3 / `parquet-wasm-zstd-v3` / observation hash v1 / `timeseries-aligned-v2` / `hyparquet-direct-column-v1`. Schema-4 reader support is not schema-4 inspector capability. |
| Global lock ownership and continued validity | **L** in `withObservationsGlobalOperationLock()`; active child adapter **M**. The retained client exposes `assertHeld()` and same-session `assertOwned()` querying `pg_locks`, binding backend PID and latching loss. | Integrity children receive validated environment owner/run/nonce context and supervisor termination, not the actual same-session ownership assertion. Only `owner === "prune_daily"` gets the original-operation IPC capability; its protocol/stages and relay are Prune-specific. |
| Frozen source/repair-overlay identity | **E/O.** Existing mode-specific freeze, staged SHA/size/dependency validation, `loadImmutableSourcePartition()` and final staged-Parquet/source comparison authenticate existing admitted graphs. Stage 2F independently verifies baseline and changed-overlay provenance. | Stage 2F does not return the mode-specific complete frozen APPLY graph/schedule. Dedicated schema-2 validation is blocked; generic immutable keys are outside admission. A caller's `validated: true`, copied audit or preparation report is insufficient. |
| Conditional write and uncertain-result reconciliation | **A/L**, repair integration **M**. `r2PutObjectConditional()` implements a separate one-attempt conditional primitive; dormant Prune code checks strong predecessors, create/exact-reuse and authoritative ambiguous-result readback. | Generic/SOS repair writers use their established PUT/deletion machinery, not this selector protocol. The Prune lifecycle cannot be relabelled as repair authority. No conditional writer was executed or connected. |
| Parent/root/latest finalisation | **E** for existing schema-1 frozen schedules/shared finalisers; schema-2 repair **M**. | Current selector and compact latest must agree; selector-selected/latest-incomplete is not success. Complete current canonical hierarchy and final latest acceptance must be rechecked by the owning future repair path. |
| Repair/removal scope and supersession | **E/O** for existing frozen generic selected-pollutant / SOS complete-day authority; current schema-2 supersession **M**. | Bind an explicit finite selected-scope list to the frozen authority. Reject missing/changed format, selector/latest contradiction and any unsupported new/removal/conversion scope. Keep immutable revisions outside legacy prefix deletion. |
| Independent Core authority | **E** at existing process-boundary validation via `validateIntegrityCoreSnapshotIdentity()`, generation-matched pinned local manifest/identity. | Must remain independently required. Observations-root equality or new index verification cannot select/refresh Core or attest its currentness. |
| Independent binding and status authorities | **E/O** at their existing owning checkpoint/source/physical-status boundaries; a new cross-domain attestation **M**. | No observation-index helper establishes external binding/verification-overlay freshness. Retain whichever independent authorities the operation depends on; physical schema-3 status comparison does not implement the future schema-4 overlay. |

## Why no new successful admission helper was added

There are reusable safe read components, but no existing active child interface satisfies the conjunction required by this task:

1. an independently validated, frozen schema-2 repair proposal, including its complete immutable direct-canonical graph, source evidence, exact bounded scopes and prior selector identities;
2. an assertion of the actual original global lock session before and after all admission reads and at final recheck;
3. actual current selected selector/leaf/file identities, including strong selector predecessors, bound back to that frozen proposal without changing its bytes or scope.

The first is not supplied by Stage 2F or by widening the generic allowlist. The second is not supplied by `requireObservationsGlobalOperationLockContext()`: that function validates the inherited context, not a fresh `pg_locks` query. The Python coordinator launches another Node process without forwarding the Prune IPC assertion protocol. A separate PostgreSQL client owned by a generic writer is not the session that owns the outer operation lock.

An arbitrary injected callback returning success would not fix this. Nor would acquiring another lock, trusting the environment's `held=true`, promoting offline identity to current selection, or fabricating a metadata-only physical proof. Existing direct verifier callbacks are usable when the caller genuinely holds that authority; this does not make them available in a different process automatically.

No new public helper, CLI, success capability or admission result was introduced. Consequently **no current-state identities are newly authenticated by this PR**. All identity mechanisms in the matrix already existed. Any eventual result must explicitly retain `read_only: true`, `publication_eligible: false`, `repair_apply_eligible: false`, `source_deletion_eligible: false` and `original_writer_completion: false`, even when current-object checks pass. It must expose blockers rather than silently granting mutation or proof capabilities.

## Canonical change, selection change and mixed formats

A future admission must compare three separate things: the authenticated prior checkpoint selection, the frozen proposed replacement and the independently authenticated current selection/source.

- Exact canonical baseline and exact selector unchanged: current applicability can be considered only after all other required checks pass.
- Canonical source unchanged but selector identity or format differs: classify an index-only selection change, not an observation event. Reject use of the frozen old predecessor; do not silently convert, re-plan or accept a newer selector as the original.
- Canonical root/source/file identity advanced or contradicts the frozen baseline: stale/superseded proposal; reject. Even unchanged logical observations do not justify ignoring changed pinned source bytes without separately accepted equivalence rules.
- Selector and compact latest disagree, or selected leaves are absent/contradictory: incomplete/ambiguous state; reject. Offline reconstruction cannot resolve which interrupted operation owns it.

Mixed repair scopes must authenticate each DCP's selected format independently, including different formats within one day. Schema 1 retains aligned dependencies and its existing bytes. Schema 2 retains only direct canonical dependencies and immutable revisions. An unaffected retained schema-2 registry entry is not a successful affected schema-2 repair. No schema-1-only operation gains new lock RPC, physical inspection or current-index traversal dependencies from this documentation-only change.

## Future publication compatibility, not executable instructions

After a separately accepted implementation and operational authorisation, the intended sequence remains:

1. Authenticate the complete frozen proposal, original baseline and immutable source/overlay identity.
2. Hold and continuously verify the accepted global observations-operation exclusion; for normal Integrity this begins at Step 0 and spans the entire run.
3. Authenticate current canonical root-to-DCP source, each selected format, selector, full immutable leaf set and strong current predecessor. Compare against frozen baseline/prior identities; never discover repair membership from R2.
4. Perform complete required direct physical and independent source-to-final verification for the supported physical schema/profile. Preserve separate Core/binding/status requirements.
5. Conditionally create or exact-reuse immutable revisions and verify exact bodies; never overwrite different bytes or sweep old revisions.
6. Recheck current source, exclusion and the selector predecessor immediately before selection.
7. Use a supported conditional replacement of the single deterministic scoped selector. A GET followed by ordinary PUT is not CAS.
8. Reconcile an ambiguous write only by exact authoritative readback and the same operation's accepted attempt identity. Do not blindly retry or roll back.
9. Complete the owning canonical child/parent/root and latest finalisation in its contracted order and verify exact results.
10. Independently verify the final selected hierarchy and completion evidence; retain every repair/source/gate safeguard. Index verification alone never grants source deletion, Prune completion or JSONgen publication authority.

No part of this sequence was implemented as a mutation route here.

## Interruption boundaries

| State | Required interpretation |
| --- | --- |
| Original APPLY alive, original session continuously held | Only that operation may use its current assertions and operation-local proof. This is not an active schema-2 repair continuation route today. |
| Lock lost before selector publication | Latch failure; stop progress and invalidate admission/proof. Fixed-v3 cannot borrow the distinct retired fixed-v2 recovery semantics. |
| Immutable leaves written, selector unchanged | Leaves are unselected dependencies; existence alone does not authorise adoption or completion. No automatic cleanup, deletion or repair resume. |
| Selector switched, latest/finalisation incomplete | New selector remains selected; incomplete publication is not success. Never restore an old selector blindly or adopt it through offline reconstruction. Explicitly authorised recovery would need its own supported authority. |
| Later operation changed canonical data or selection | Reject old applicability/predecessor/proof, including an index-only switch with unchanged observation root. |
| Restart lost the original operation-local authority | Fail closed. A fresh lock establishes current exclusion only. Stage 2D's Prune restart/gate-only decision is unchanged; SOS-light does not solve it. |

No durable event ledger, lock service, database table, automatic restart adoption or speculative rollback is proposed as part of this delivery.

## Validation and baseline comparison

Node `v24.19.0`; **27 existing focused checks passed, zero failed** after materialising the required current-main import dependencies:

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap \
  scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs \
  scripts/backup_r2/tests/uk_aq_selected_format_reconstruction_v3.test.mjs
# 25 passed

node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  --test-name-pattern='lost retained lock|Integrity apply child verifies' --test-reporter=tap \
  tests/uk_aq_observations_global_operation_integration.test.mjs
# 2 passed
```

These establish existing bounded offline/schema-1/mixed-format behaviour, historical non-derivable identity and unsupported-physical-schema blockers, the planner/legacy/dedicated schema-2 rejection boundaries, and mocked supervisor lock-loss/run-ownership behaviour. The lock checks use injected local adapters, not a real PostgreSQL session. They do not demonstrate a new successful current schema-2 repair admission, selector CAS, real lock exclusion, recovery, or TEST operational acceptance.

No new tests or speculative fixtures were written. Relevant Node syntax/import checks and `git diff --check` were performed. Every pre-existing tracked implementation/test blob remains identical to the base commit, so these are also unchanged-baseline results; no separate changed-runtime comparison exists for this docs-only PR. The Station History suite and full Node/Python suites were not run. Stage 2G's reported 29 passes and eight unchanged-baseline Station History failures remain historical evidence, not this PR's results and not a green full suite.

No R2, Dropbox, PostgreSQL, Cloudflare, deployment, migration, Prune or repair operation was run. GitHub reads and branch/commit/PR delivery are the only remote repository work. No LIVE repository/code/data was inspected or modified.

## Chat-mode documentation handover and next bounded decision

Record Stage 2H as an **investigation-only current-process authority assessment**, not implemented admission or repair readiness. Link this report from the exact-only/SOS-light status route if Chat mode updates authoritative documentation. Code-only pre-change archiving does not apply: the sole repository change is this investigation document, with no new or overwritten code archives.

The next bounded implementation needs these explicit interface decisions:

1. **Integrity lock assertion transport:** decide a supported owner/run/session-bound, operation-lifetime assertion adapter from the existing lock coordinator through the Python coordinator to the actual APPLY child, or an accepted same-process placement. Reuse the existing global lock. Do not claim Prune's protocol/stages already cover Integrity or that a new session proves continuity. Assertions must fail permanently on timeout/disconnection/session replacement/loss and must not acquire a lock.
2. **Validation-only frozen schema-2 representation:** define how independently accepted source/baseline, complete immutable graph, prior selected identities, bounded scope/budgets and exact proposed bytes enter and are rechecked by the mode-specific freeze. Preserve active schema-2 APPLY rejection. For generic execution, require explicit payload/format closure at the direct bridge, not just the disconnected writer's guard. Do not merely widen mutation allowlists or add schema-2 bytes to current schedules.
3. **Current-object admission seam:** with the two interfaces above, reuse bounded authenticated GET/HEAD and the direct verifier. Return exact current selector strong ETag, selector/leaf/canonical/file identities and currentness classification in an immutable read-only result; perform whole-subset final rechecks and return explicit blockers. `r2GetObjectBounded()` already offers byte/deadline-limited transport; do not invent a transport or allocate unbounded bodies before checking budgets. Do not mint a physical proof from metadata checks.

Separately, exact historical reconstruction with non-derivable optional ETags/profile fields still needs an authenticated retained source or explicitly versioned equivalence decision. Physical schema 4 requires an accepted actual-byte inspector, not reader compatibility. Neither is solved by a current-root hash.

Before any future real TEST acceptance: separately approve deployment of compatible consumers/adapters; establish a complete accepted checkpoint and independent Core/binding/status authorities; pass normal IngestDB-boundary and Step 0 gates under genuine exclusion; exercise a finite schema-2 and same-day mixed scope with real current-object identities, selector changes, stale source, missing/conflicting leaves, strong-ETag/ambiguous-result failures and actual lock loss. Any later write-enabled acceptance must separately authorise repair publication and verify complete source-to-final semantics, immutable create/reuse, conditional single-selector selection, final hierarchy/latest, interruption failures and downstream reader/cursor/cache behaviour. Publication must remain disabled until all required consumers and safeguards are accepted. No operational apply/deploy command is authorised or supplied by this delivery.

Restrictions preserved: schema-1 production; direct canonical schema-2 dependencies; inactive schema-2 shared publication and Prune pre-READY rejection; original gate/outbox/deletion ownership; normal backup scope and generic restore; Station History; JSONgen receipts/committed outbox and absence of new PENDING/CONFIRMED data; environment-independent code and deployment configuration. No SQL, secrets/configuration, cloud services or persistent proof system changed. Rollback is deletion/revert of this document only; archive code is never an executable recovery path.
