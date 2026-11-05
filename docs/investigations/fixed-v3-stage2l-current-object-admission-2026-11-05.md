# Stage 2L: original-session read-only current-object admission

## Result and source authority

`admitSchema2CurrentObjectsV1()` is a dormant, explicitly invoked, read-only helper. It authenticates current R2 predecessors against independently validated Stage 2K v1 preparation under the retained Stage 2J original PostgreSQL operation. It creates no executable proposal, publication capability, reusable currentness handle or operational command.

Base: actual TEST Ops `main`, `9e0872d66d5f2ae55b47b7d8b0e7c8bd99b4484f`. GitHub independently confirmed PR #185 was merged on 5 November 2026 at that commit. Authoritative TEST system-docs were read at `b1365bb9592fe39c34e6587bf687e3aaea599acf`; its Stage 2K implementation note still says submitted, which is stale status rather than missing design authority. No authoritative documentation was edited.

The route was repository AGENTS → current system overview → R2-history README → exact-only future contract, observations-operation exclusion, SOS-light three-phase authority and implementation safety. Stage 2H/I/J/K handovers and the actual merged preparation, resource, verifier, R2, Node bridge, Python coordinator/descriptor and supervisor/holder interfaces were inspected. The Stage 2K handover investigation predates its subsequent accepted v1 implementation; merged code and the active v1 contract were used together.

## Structural assessment and integration gap

Stage 2J already provides the required genuine assertion through the retained owner, supervisor IPC, Python's private one-shot descriptor and the selected Node APPLY child. No new transport, database session, lock acquisition or service is necessary for a callable helper. Stage 2K provides an independent validator for exact local preparation, including complete source/physical/canonical/index closure and the strict freeze.

The normal operational route remains unsupported for this helper: Python scheduling rejects preparation as executable authority, forwards its descriptor only to the selected generic or SOS-light APPLY child, and both existing bridge functions reject preparation before attaching their APPLY lifecycle. The helper is not called by either bridge, planner or coordinator. There is no supported standalone launch command or non-mutating operational entry point. A future integration decision must specify how an explicitly non-mutating call is reached inside the protected selected-child lifetime without weakening those scheduling/rejection rules. This PR deliberately does not create that decision or an IPC alternative.

The helper accepts the same independently supplied `request` inputs as `validateSchema2PreparationV1`, explicit `phase: "APPLY"`, existing R2 configuration/adapter and the inherited environment. A phase string alone is insufficient: a live original-session channel and matching frozen owner/run/nonce are mandatory. Neither a supplied `valid: true` result nor a copied environment lock context can establish admission.

## Implemented authentication

1. Bound plain JSON request shape, string bytes, depth and member count before copying it; reject hidden binary/Map/class values, sparse oversized arrays and accessors. Snapshot validator inputs and environment before awaiting. Independently reopen/reconstruct the v1 preparation using the existing validator. Its complete fingerprint, source provenance, original/proposed selectors, canonical/physical graph, body references and resource admission remain unchanged.
2. Match the frozen preparation's owner/run/nonce to the inherited original operation context. Use the genuine imported `assertOriginalIntegrityOperationHeld({ expectedRunId })`, with no injectable ownership callback. The original module supplies the same process capability throughout. Check the returned owner/run, stable backend PID, advancing sequence and read-only/no-repair result.
3. Freshly GET every frozen baseline canonical manifest, physical file and checkpoint-selected compact latest through the existing one-attempt bounded identity-encoding GET. Require exact expected byte size/SHA and an actual strong quoted response ETag for every current object. An optional returned checksum must agree too. No ETag is inferred from a SHA, checkpoint or rebuilt object.
4. Authenticate the complete current registry against all frozen prior descriptors. Before physical reconstruction, reserve the complete baseline row/series/file fan-out, serialization and dependency upper bounds. Reapply Stage 2K physical preflight to fresh bytes, including the aggregate uncompressed-page ceiling.
5. For every selected affected or retained scope, independently reconstruct with the existing exact-only verifier using only the newly authenticated current-byte cache. This checks the completed root/year/month/day/connector/pollutant chain and aliases, canonical file identities and complete physical routing, row groups, segments, projected ranges, decoded values/status and observation hash. Compare the rebuilt source descriptor and entire selected-format descriptor with the frozen **prior** state.
6. Authenticate every reconstructed selected object against fresh R2 bytes: all immutable schema-2 revisions/selectors, or the entire schema-1 exact/aligned graph where selected. Reconcile every dependency identity and reconstruct/check completed compact latest. A proposed replacement is retained separately in the diagnostic and is never substituted for its current predecessor.
7. Full bounded GET rechecks require the same SHA, size and strong ETag for every object. Independently revalidate the preparation and all actual referenced local/source bytes again, then make a final original-session assertion before returning the diagnostic. No checksum-capable HEAD is assumed; no HEAD fallback or list operation is used.

Every successful remote read has original-session assertions before and after it; physical reconstruction also has phase assertions. An unsuccessful remote read cannot advance admission: it closes the capability. After channel consumption, any failed assertion, remote/local contradiction, timeout or uncertain result closes the original operation permanently. Stage 2J's production close/loss handling terminates the APPLY child and cancels the protected chain; no retry, reconnect, reacquisition or later restored bytes can revive that channel. Invalid preparation/phase/context rejected before channel consumption is a precondition failure, not a partially successful current-object operation.

## Bounds, unsupported inputs and evidence lifetime

All Stage 2K per-file, physical, JSON, row, whole-graph and runtime-memory limits remain enforced. Additional current admission reserves preparation plus fresh graph working resources and permits at most **220 distinct current objects**, **440 GETs** and **twice the preparation aggregate body-byte ceiling** transferred. Each GET has its exact expected size budget and the existing 30-second maximum. With at most 64 scopes, two assertions per GET, two per reconstruction scope and initial/final assertions require at most **1,010** calls, below Stage 2J's 1,024 lifetime limit. Prior channel usage can still exhaust the channel; that fails closed rather than resetting it. Conservative combined resource admission can reject a preparation that fits v1 preparation alone.

Support remains physical schema 3 / writer `parquet-wasm-zstd-v3` / observation-content-hash v1, with the existing aligned-v2/direct-column and Stage 2K bounded encoding profile. Schema 4, unknown physical/index formats or encodings, unavailable runtime inspectors, non-reproducible historical selector bytes, missing/changed objects, weak/missing ETags, incomplete canonical/index/source evidence, and resource overflow fail closed. New nonempty, empty/removal and immutable retirement remain unsupported. This helper additionally rejects `proved_absent_noop` / no-selector outcomes because it has no supported current absence protocol; it does not change their Stage 2K diagnostic meaning.

The deeply frozen result is explicitly `authenticated_read_only_diagnostic`, with `evidence_scope: "completed_call_only"`, `reusable_currentness: false`, the unchanged preparation fingerprint, run/backend/assertion-sequence diagnostics, separate current/proposed selectors and bounded authenticated current identities/ETags. Both eligibility flags stay false, and `current_object_authority` / `conditional_publication_authority` stay null. There is no handle registry, reuse API or evidence consumer. Retaining or serializing this diagnostic cannot establish currentness for a later invocation, lock lifetime or mutation.

## Changed files and archive rule

- New `scripts/backup_r2/lib/schema2_current_object_admission.mjs`.
- Targeted additions to `scripts/backup_r2/tests/schema2_preparation.test.mjs`, reusing its existing real preparation and physical fixtures.
- `docs/superpowers/plans/2026-11-05-stage2l-current-object-admission.md`.
- This implementation/Chat-mode handover.

No pre-existing active non-test implementation file changed, so no pre-change code archive was required. Tests and documents do not receive code-style archives. No archive content is imported or executed.

## Structural validation

Node `v24.19.0`: **14 focused checks pass**, comprising the preparation/independent validation, physical/resource and execution-guard checks plus four new Stage 2L groups. The new groups cover complete mixed selected closure with distinct source-authenticated proposed replacement, immutable diagnostics and caller mutation isolation; current drift, weak selector ETag, missing immutable leaf, final ETag drift and local evidence tampering; context-only/non-APPLY rejection and ownership loss before/after reads/at final admission; and pre-clone rejection of hidden binary/Map/sparse-array payloads.

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  scripts/backup_r2/tests/schema2_preparation.test.mjs \
  scripts/backup_r2/tests/schema2_preparation_resources.test.mjs \
  scripts/backup_r2/tests/schema2_preparation_execution_guard.test.mjs
```

New/changed JavaScript syntax and actual imports of the helper and both APPLY bridges pass. Existing guard checks invoke the real Python scheduling functions and confirm opaque blocked retention remains distinct from executable scheduling. `git diff --check` passes. Full suites were not run.

Local checks use actual inherited-descriptor client/server framing but substitute PostgreSQL ownership answers and bounded R2 bodies. A test-only SIGTERM handler permits reporting permanent refusal and then deliberately exits; it is not production cancellation behavior. These checks establish structural enforcement, not real original PostgreSQL continuity, deployed descendant shutdown or functional TEST acceptance. An independent read-only review found a pre-clone hidden-binary allocation gap; its focused check failed before the plain-JSON fix and passed afterward. No other blocking review issue was identified.

## Preserved boundaries, rollback and Chat-mode handover

No operational command was invoked. No SQL, R2/Dropbox operation, Prune execution, source deletion, deployment, configuration/secret/schema change or LIVE work occurred. DETECT/PROPOSE remain local-only apart from their existing locked Step 0 root currentness gate. Stage 2K v1, generic/SOS/Python preparation rejection, selected-format guards, schema-2 key allowlist rejection and `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false` remain unchanged. No per-mutation assertion enforcement was added to existing schema-1 APPLY.

Before any schema-2 mutation could be considered, separate decisions/implementation are still required for a supported protected operational admission entry point; an executable frozen schema-2 repair contract distinct from v1 preparation; assertion enforcement at actual mutation boundaries; immutable create/exact-reuse, conditional selector publication and ambiguous-write reconciliation; canonical/root/latest finalisation and repair VERIFY; supported new/empty/removal semantics and schema-4 physical proof; downstream compatibility, deployment and finite real TEST acceptance. Stage 2D Prune restart recovery, JSONgen freshness/publication and retirement/deletion remain separate unresolved boundaries. A successful read-only diagnostic closes none of them.

**Chat-mode authoritative documentation handover:** correct Stage 2K implementation status to PR #185 merged at `9e0872d` (still not deployed/operationally accepted). Record Stage 2L as dormant callable-only read-only current predecessor authentication using the original Stage 2J channel, complete mixed-format current canonical/physical/index closure and genuine strong ETags, with all execution eligibility false. Record its tighter finite caps, unsupported absence/schema-4 cases, the operational entry-point gap and the 14 local structural passes without claiming real session continuity. No database/configuration/backup-payload/deployment changes accompany this interface. Functional acceptance needs separately authorised deployment and a finite real TEST read-only operation; no apply/deploy command is authorised by this PR.

Rollback is a reviewed Git revert/removal of this dormant helper and its checks/documentation; no external state needs undoing. Do not execute archive snapshots.
