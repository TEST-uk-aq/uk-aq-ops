# Prune Stage 2D: original-attempt authority after restart

## Finding and scope

**Existing persistence cannot authenticate either an unfinished original R2 publication after restart (case A) or a fully finalised original R2 publication whose gate transaction did not commit (case B). No recovery code is justified by the available authority.** Keep both cases fail-closed. Independently reading/replaying an already committed original outbox (case C) remains supported through the existing JSONgen reader; it does not resume an unfinished publication or grant deletion authority.

This is an investigation-only change. It preserves all implementation, tests, schema, configuration, historical receipts and operational guards. No new ledger, table, service, lock, environment variable or verification system is proposed for implementation here. No deployment, Prune run, operational R2/PostgreSQL/Cloudflare/Dropbox call, functional TEST operation or LIVE access occurred. GitHub fetch/push/PR operations are delivery operations only.

Reviewed revisions, fetched from the TEST remotes on 3 November 2026:

- Ops `main`: `e9fc6477128be7a1ef99c30376a5e26058de1489`, merged PR #172.
- System-docs `main`: `4556a382faea1c1f9df23261bf04b5b4f9cd3909`, including the Stage 2C/2D boundary.
- Schema `main`: `ee8a5ab568e011587b3b8c8fd0def6b54669fdaa`.

Read the applicable root/Prune `AGENTS.md`, system overview and R2 router; exact-only future contract; run exclusion and writer coordination; observation-only Phase B, complete-snapshot, connector gate, source identity, file identity, atomic deletion and implementation-safety contracts; JSONgen/Prune handover quick reference; and the [Stage 2C report](prune-stage2c-dormant-publication-2026-11-03.md). Authoritative `system_docs/` is unchanged. This report is implementation evidence and a Chat-mode handover, not a replacement authoritative contract.

## Actual persistence and call paths

1. `runPhaseBBackup` calls candidate discovery before claiming a candidate. The canonical branch of `populateBackupCandidates` upserts one mutable `(day_utc, connector_id)` row. Ordinary unfinished candidates become `pending`, their `run_id` becomes null, and source/completion fields are cleared. Completed matching aggregates receive additional current source/deletion-state validation. Persistent historical-block markers retain diagnostic run/reason information, not publication permission. See [discovery](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L1593), [rediscovery updates](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L1702) and [orchestration](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7334).
2. [Claiming](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L2237) writes the current run ID and explicitly clears the source-identity columns. [Source acquisition](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L3137) reads metadata and compact rows in one `REPEATABLE READ` transaction, writes a temporary local NDJSON snapshot and computes the complete canonical connector/day hash in memory. That transaction commits without persisting an authenticated attempt/source admission. The local source is cleaned after connector verification and before batch finalisation, or on handled failure; a crash-left temporary file has no accepted recovery reader/authentication contract.
3. The live path is `exportCandidateToR2` → `exportCandidateObservationsToR2` → `writeFrozenCandidateObservationsToV2` → `publishFrozenV3Observations` → the operational shared connector publisher. [Admission](../../workers/uk_aq_prune_daily/committed_history_guard.mjs#L170) precedes canonical PUTs. Source rows and the optional prepublication absence/Core capture are still operation-local. The real builder emits schema 1. The dormant factory adds schema 2 only through its private injected-adapter path.
4. `resume_parts_json` and cursor/count fields are not a hidden schema-2 recovery facility. Their checkpoint writer is called by `writeCommittedV2PartAndCheckpoint`, reached from `publishFrozenV2Observations`; the selected-v3 path uses the shared publisher instead. Even that v2 function starts its local part state at zero. Retaining export descriptors on aggregate equality does not retain original admission, complete frozen-source incarnation, selector predecessors or checked-batch authority. See [checkpoint update](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L2496) and [v2/v3 dispatch](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L3783).
5. The dormant writer retains its `pending` map, continuation closure, original selector/ETag, conditional-write state and latest predecessor in memory. Continuation is retained only after canonical publication and original physical-proof preparation. Physical proofs and completions use private `WeakMap` entries and exact original-operation object binding. Serialised copies cannot recreate them. See [factory](../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L2508), [publisher](../../workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs#L346), and [proof binding](../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs#L450).
6. `recordDurableEvidence` does not establish a durable attempt journal in the operational adapter. Its [default recorder](../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs#L813) GETs an object, checks its full size/SHA and returns an in-memory `durable: true` descriptor. This proves retained object bytes; there is no persisted original-owner/stage/recovery record supplied by that name.
7. [Whole-batch validation](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L4551) precedes any candidate/gate transaction. Optional AURN PENDING upload occurs before canonical publication; its complete original evidence bundle is prepared/uploaded only after validated batch finalisation. Both can survive remotely, but their trusted pointer/identity binding is supplied by the later committed outbox. The optional [run summary](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L6903) is written after gate transactions and is skipped on budget stop; it is not original batch or COMMIT authority.
8. [Candidate/gate completion](../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L2367) atomically stores matching run, manifest and source fields plus READY. Optional outbox insertion is SAVEPOINT-isolated. The SQL function requires candidate/gate tuple versions from that very transaction and matching original fields; its append-only row becomes visible only if the transaction commits. `attempt_id` is currently the same UUID as `run_id`, not an independently retained prepublication attempt. A successful gate can legitimately have no outbox. A lost/ambiguous COMMIT acknowledgement produces no eligible completion reference.
9. Gate failure after R2 finalisation can retain `PRUNE_GATE_ONLY_RECOVERY_UNPROVEN:` with original run, connector-manifest hash and source hash in mutable diagnostic JSON. The source columns are cleared by `markCandidateFailed`. This marker does not retain all final parents/latest, physical proof, selector write outcomes, unchanged source incarnation or a trustworthy COMMIT outcome. It cannot be promoted to gate restoration authority.

Canonical schema definitions are the [candidate/gate/outbox bootstrap](https://github.com/TEST-uk-aq/uk-aq-schema/blob/ee8a5ab568e011587b3b8c8fd0def6b54669fdaa/schemas/ingest_db/main_db_dualwrite_bootstrap.sql#L335), its [original acceptance function](https://github.com/TEST-uk-aq/uk-aq-schema/blob/ee8a5ab568e011587b3b8c8fd0def6b54669fdaa/schemas/ingest_db/main_db_dualwrite_bootstrap.sql#L1044), and [observation row definition](https://github.com/TEST-uk-aq/uk-aq-schema/blob/ee8a5ab568e011587b3b8c8fd0def6b54669fdaa/schemas/ingest_db/uk_aq_core_schema.sql#L1186). This review used SQL source only, with no database query or deployment-state claim.

## Durable-authority matrix

Trust classes: **1** independently authenticated durable fact through an existing accepted reader; **2** mutable database state/diagnostic timestamp; **3** retained object/content identity without proof of the original attempt; **4** ephemeral capability; **5** missing or incomplete evidence. A hash's strength as content identity does not establish its provenance.

| Required fact | Existing evidence and trust level | What a restarted invocation can establish |
|---|---|---|
| Original invocation and attempt | Candidate `run_id`/status (**2**); optional pending/bundle invocation fields (**3**); original session IPC (**4**); committed original outbox (**1**, only after gate COMMIT). | Exact committed event identity through its private reader. No accepted immutable unfinished-attempt identity; rediscovery can clear the candidate run. |
| Candidate identity/lifecycle | One mutable day/connector row, READY/CONSUMED/block markers (**2**), with transaction checks in live completion/deletion. No per-attempt history in that relation (**5**). | Current state and persisted block diagnostics. A later claim of the same day/connector is not the original candidate attempt. |
| Frozen complete source and membership | Temporary snapshot/in-memory rows (**4**); source hashes in completed candidate/gate or failure diagnostics (**2**); optional private PENDING bytes with per-scope membership (**3** until authenticated with **1**). | Content equality when an independently pinned original source exists. No prepublication durable admission binding the entire frozen source to the original attempt. |
| Row incarnation / no source change or later arrival | Source v1 hashes canonical row content, preserving duplicate multiplicity, with no row-incarnation token (**3** as content evidence). Source rows have logical PK and `created_at`; the accepted source identity does not capture that timestamp or tuple history (**5**). | A changed current hash can reject. An equal hash cannot rule out change-and-revert, identical reinsertion or intermediate arrivals/removals. READY/CONSUMED prevents reuse after recorded Prune deletion; it does not prove every external mutation during an outage. |
| Original prior-canonical first-publication admission | Live root/hierarchy/index GETs and callback capture (**4**); optional retained before bytes (**3**, authenticated for a committed event via **1**). | Current committed absence/presence can be checked. No independently anchored original pre-write absence/admission for an unfinished attempt. |
| Canonical files / pollutant / connector identity | Current hierarchy, manifest hashes and physical object SHA/size/ETag (**3**); original direct inspection (**4**); complete retained committed handover (**1**, after independent validation). | Current content, membership and pinned dependencies; disagreement rejects. Not original writer ownership. The shared operational connector/day builders even use `runId: null`; an incidental manifest `run_id` elsewhere would still be a self-description, not an acceptance record. |
| Exact selector and immutable leaves | Revision-key content hashes and selected parent bytes (**3**); original selector predecessor/ETag, exact write attempts and readbacks (**4**). | Current selected format and complete dependency bytes. No durable authenticated transition record tying an interrupted switch to this original attempt. Recomputing equal revision bytes cannot supply it. |
| Day / aggregate / root / latest and whole batch | Current final hierarchy/latest bytes (**3**); checked batch and physical proof handles (**4**); optional late summary (**3**); complete original outbox-bound evidence (**1**). | Current coherence can be checked. Selected parent or latest existence alone cannot prove complete original batch verification. No independently authenticated pre-gate durable completion fact. |
| Original protected gate/outbox COMMIT | Live acknowledgement and post-ack original-session check (**4**); mutable candidate/gate (**2**); append-only original outbox read through restricted authenticated PostgreSQL reader (**1**). | A matching visible original outbox proves committed acceptance under its SQL contract. Missing outbox does not prove rollback, because insertion is optional. The SQL tuple `xmin` check binds the gate transaction, not original observation-row incarnation or R2 verification by the database. |
| Retention across interruption/rediscovery | Remote pending/bundle objects may survive (**3**), committed outbox is append-only (**1**); candidate fields can be reset (**2**); local proofs/continuations disappear (**4**). | Existing committed-event replay remains possible while required original data is retained. No accepted retention/discovery/authentication path preserves all unfinished-attempt authority before the first possible mutation (**5**). |

## Recovery cases

### A. Canonical, immutable-leaf, selector or latest publication interrupted

| Interrupted state | Existing supported boundary | Cross-invocation original-attempt result |
|---|---|---|
| Canonical files/children exist; selector incomplete or absent | Within the live original owner, only a retained verified continuation can continue exact publication. Failure before that continuation exists remains blocked. | **Blocked.** Loose children do not prove original admission/source/ownership. |
| Some immutable revision leaves exist; selector has not switched | Same-operation continuation verifies exact leaf bytes/current object identities before the conditional selector write. | **Blocked.** Leaf hashes can prove reusable content, not the original publication attempt or prepared predecessor. |
| Schema-2 selector selected; hierarchy/latest/batch unfinished | Keep the selected parent; same-operation identity checks may finish the original outstanding work. It is not success. | **Blocked.** A new factory refuses an already selected schema-2 scope; a fresh lock supplies no missing original proof. Never blindly restore schema 1. |
| Original session lost or process restarted after any of these | Old capabilities are unusable; no supported rehydration interface exists. | **Blocked**, even when all current bytes happen to match. |

The guard separately permits **ordinary first-publication admission** when the authenticated current root-to-scope hierarchy and applicable latest authority establish no committed connector/day. That may coexist with loose orphan objects. This existing branch is not proof that a restarted process has recovered the exact original attempt; Stage 2D neither relabels it as recovery nor changes it. Missing/contradictory hierarchy or an already committed connector with missing index fails closed. Already committed matching history is rejected rather than adopted.

Even a future original-attempt admission must retain the existing immutable-leaf/conditional-write/authoritative-readback protocol, pin current canonical bytes and every dependency, and reject superseding selector/canonical work. Cross-invocation reinspection cannot itself prove original ownership. The exact-only contract also forbids reusing transient footer/physical-layout evidence across invocations: persisting JSON versions of the old opaque handles would not satisfy it. An accepted fresh physical inspection or a specifically accepted durable completed-verification handover would still be necessary for the applicable phase.

### B. Entire R2 batch completed; original gate transaction interrupted

This case is gate-only: **zero canonical R2 PUTs**, including manifests, indexes and latest. It is available contractually only after proving the entire original R2 batch already succeeded. A selected selector with incomplete latest or parents is case A.

The four gate-only requirements remain unmet in combination:

1. Candidate run/error fields and self-described objects cannot independently establish the exact original publication attempt.
2. The frozen complete source is not durably anchored before publication; current content hashes cannot establish unchanged original row incarnation across the interruption.
3. Current root/selector/latest coherence does not prove original physical verification and complete original batch success. The checked handles are ephemeral, and an optional failure marker/late report is insufficient.
4. Original candidate/gate evidence may be missing, reset or contradicted; a fresh source/deletion transaction cannot retrospectively reconstruct the missing publication provenance.

An optional bundle uploaded after completed R2 but before gate COMMIT is a particularly narrow temptation. It contains useful exact before/after metadata, source/binding identities and final-batch descriptions, and it is uploaded conditionally with checksum/readback. However, the signer authorises object-specific transport using writer credentials and caller-supplied identity; it does not check the original PostgreSQL lock, canonical admission, source lifetime, batch verifier or gate COMMIT. Its deterministic intent ID is a digest, not an independently readable semantic acceptance. The existing consumer first requires a genuine private-reader outbox token, then authenticates the outbox-pinned envelope, bundle and PENDING bytes. **An orphan bundle does not become an accepted original completion because its key contains an invocation UUID.** Promoting it would change the trust contract and would still not solve row incarnation or earlier partial-publication recovery.

Keep automatic restoration and deletion disabled. An uncertain COMMIT must be reconciled against independent durable authority under the existing contracts; no new event may be minted to make uncertainty disappear. Outbox absence alone cannot decide the outcome. No gate-only operation was implemented or run.

### C. Original gate/outbox already committed

Preserve [private original outbox discovery/read](../../scripts/jsongen/prune-outbox-reader.mjs#L32) → [independent handover authentication](../../scripts/jsongen/prune-consumer-authentication.mjs#L225) → existing replay/receipt/registration behavior. The reader authenticates the retained original event, not the current mutable gate; later READY consumption or source cleanup need not rewrite historical acceptance. Full original evidence and private-source bytes must still authenticate; a bare outbox with `not_captured` evidence does not automatically qualify as CONFIRMED.

If acknowledgement/delivery was lost but the original outbox really committed, the independent reader can discover that same event. This is existing replay, not a new gate recovery mechanism. A committed gate without optional outbox can remain valid for its existing deletion safeguards while JSONgen lacks independently authenticable event evidence; retry discovery cannot synthesize an outbox or original event for it.

Index-only schema-1/schema-2 equivalence remains metadata-only currentness work against unchanged authenticated canonical observations. It creates no new PENDING dataset, confirmation, historical receipt or deletion permission. Managed JSONgen monthly selection remains disabled; currentness/freshness authority remains separately gated. Existing metadata currentness inspection is unchanged.

## Minimal contract decision for ChatGPT in Chat mode

**Recommended current decision:** record that cross-invocation original-attempt recovery remains unsupported with present persistence. Continue fail-closed operation and retain affected IngestDB rows for authorised resolution. This resolves the investigation; it does not remove the underlying activation blocker.

If restart recovery is still required, first approve a narrow original-attempt retention/admission amendment. These are missing facts and their necessary origins, not an implemented schema or permission to create a second proof system:

| Missing decision | Where the authority must originate | Why existing records cannot substitute |
|---|---|---|
| Preserve a recoverable original identity and first-publication admission before the first possible canonical mutation, with exact source membership and accepted planned dependencies. Define which existing candidate/evidence fields may retain it and how ordinary rediscovery is prevented from erasing/reassigning it. | Original Prune coordinator/admission under the existing global lock, through an explicitly protected durable boundary in the existing persistence design. | Current candidate is keyed by scope, mutable and reset; original absence callback and prepared selector state are in memory. Existing JSONgen outbox is post-gate acceptance and must keep that meaning. |
| Prove no source incarnation/change/rediscovery across an outage, including identical remove-and-reinsert and change-and-revert. Decide an authoritative source mutation/incarnation fence and its retention, or explicitly leave every unprovable case blocked. | IngestDB source ownership/mutation path tied to the original complete snapshot. | Content v1 hash intentionally omits incarnation. `created_at`, current tuple metadata, observation timestamps and candidate timestamps are not a captured original mutation history. Current global observations exclusion does not lock out ordinary ingestion. |
| Authenticate original publication stage and exact current dependencies; distinguish prepared/leaves/selector-selected from fully finalised R2, without treating a description as a physical proof. Decide fresh inspection versus accepted retained completed-verification evidence for each phase. | Existing owning canonical publisher/physical verifier and checked batch finaliser, bound to the retained original attempt before it is lost. | Default durability recorder only verifies object bytes; continuation/conditional outcomes and actual-byte proof provenance are transient. Current hashes can reject mismatches but cannot prove there was no intervening superseding work. |
| For gate-only recovery, independently authenticate full original R2 success before a missing gate COMMIT, define retention/reader authority and uncertain-COMMIT reconciliation, and preserve separate fresh deletion safeguards. | Original checked batch completion through an accepted durable boundary usable before the gate, with existing candidate/gate transactions left intact. | Optional precommit bundle has no accepted standalone completion reader/trust root; optional post-gate outbox cannot prove an attempt whose transaction rolled back. Making optional JSONgen transport mandatory would change canonical/deletion failure isolation. |

Prefer bounded retention in the already owned candidate/original-evidence lifecycle if a future design can meet these facts. Do not overload `last_error`, export-resume JSON, historical receipts or the committed outbox by implication. The authoritative contract must settle trust, mutation/rediscovery behavior, reader authorization and retention first; schema/configuration/permission changes, if genuinely necessary, require their own bounded implementation. No concrete wire schema or migration is authorised by this proposal. If the no-new-authority constraint remains absolute, cases A and B remain blocked.

Before any later activation: implement only the approved recovery scope; retain schema-1, hard publisher-inactive and operational pre-READY boundaries; satisfy mixed-format readers/cursor/cache, physical-schema support, repair/reconstruction/backup/restore and supported-writer prerequisites; then separately authorise deployment and controlled real TEST acceptance of restart/interruption, supersession, uncertain writes/COMMIT, lock loss and atomic deletion. Managed JSONgen and LIVE acceptance remain independent.

## Safety and validation

No implementation file changed, so the pre-change code archive rule and Prune control-flow test-authoring exception are not triggered. Documentation must not receive code-style archive copies. No speculative tests were added. No manual apply/deploy/run command is part of this delivery; rollback is removal/reversion of this report alone.

The unchanged code preserves normal schema-1 publication, the hard `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false` constant, operational schema-2 rejection before READY, original-session heartbeat/IPC/loss cancellation, mandatory source-to-final physical verification, candidate/gate/outbox atomicity, READY/CONSUMED whole-connector/day deletion safeguards, optional JSONgen SAVEPOINT isolation and historical receipt identities.

All checks used synthetic configuration and local injected adapters, without operational-service access. Node was `v24.19.0`.

| Check | Result |
|---|---|
| Existing lifecycle, completion, independent consumer, original-operation and schema-1 writer checks | **30 pass / 0 fail / 0 cancelled / 0 skipped**; exit 0 |
| Existing filtered gate/optional evidence/COMMIT/finalisation/rejection checks | **19 pass / 0 fail / 0 cancelled / 0 skipped**; exit 0, including ten finalisation subchecks |
| One complete Node run | **129 test-file processes: 82 pass / 47 fail / 0 cancelled / 0 skipped**; exit 1; 145.8 seconds |
| Exactly those 47 failing files on clean detached unchanged `e9fc6477` baseline, same options/configuration/dependencies | **0 pass / 47 fail / 0 cancelled / 0 skipped**; exit 1; 71.2 seconds; identical failing filename set |
| Six syntax checks and six bounded imports listed below | All pass; exit 0 |
| Report local reference existence, documentation-only scope and `git diff --check` | Pass; authoritative docs/schema worktrees clean |

**Baseline limits:** Stage 2C reported 83/46 file processes; this environment reports 82/47. Its historical report does not retain the full 46-name list, so this investigation does not claim to identify that one-file delta or reproduce every historical assertion. All 47 present failures reproduce on unchanged current TEST main; active code and tests are byte-identical to that baseline. There are no introduced implementation changes or newly failing filenames relative to this paired current-main comparison. The full suite is still red.

Relevant reproduced failures include `uk_aq_prune_committed_history_guard`, `uk_aq_prune_daily_hierarchy_integration`, `uk_aq_prune_phase_b_paths`, `jsongen_prune_consumer`, `jsongen_prune_pending_source` and `uk_aq_observations_global_operation_integration`. The unfiltered committed-history guard process receives **SIGKILL in both runs**, not an assertion diagnostic; its cause remains environment/resource-indeterminate. The other listed file processes exit 1 in both runs. File-level reproduction does not establish identical individual failure sets or excuse a broken safety assertion. The 49 focused checks separately passed; the name filter intentionally excludes unrelated legacy cases and Node reports zero skips.

Exact focused commands:

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/uk_aq_prune_exact_only_lifecycle.test.mjs \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  tests/uk_aq_prune_original_operation.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs

node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  --test-name-pattern='original-session assertions|optional evidence constraint|COMMIT acknowledgement|default-off Prune completion|v3 finalization|pre-commit final preparation|schema-2 committed' \
  tests/uk_aq_prune_history_gate.test.mjs \
  tests/jsongen_prune_pending_source.test.mjs \
  tests/uk_aq_prune_committed_history_guard.test.mjs
```

Complete Node command, run once in the task branch while code/tests were unchanged:

```sh
export UK_AQ_ENV_NAME=TEST UK_AQ_GITHUB_REPO=fixture-org/fixture-ops
export UK_AQ_JSONGEN_R2_BUCKET=fixture-derived-bucket
export UK_AQ_JSONGEN_R2_ENDPOINT=https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com
mapfile -t stage2d_test_files < <(rg --files tests -g '*.test.mjs' | sort)
node --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap \
  "${stage2d_test_files[@]}" > /workspace/work/prune-stage2d/full-suite.tap 2>&1
```

The 47 baseline filenames were extracted with `^not ok \d+ - (tests/[^\n]+\.test\.mjs)$` from that TAP file into `/workspace/work/prune-stage2d/full-failed-files.txt`. A detached worktree at `origin/main`/`e9fc6477` shared the installed `node_modules` directory. Its exact subset command, after the same four exports, was:

```sh
mapfile -t stage2d_baseline_files < /workspace/work/prune-stage2d/full-failed-files.txt
node --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap \
  "${stage2d_baseline_files[@]}" > /workspace/work/prune-stage2d/baseline-failures.tap 2>&1
```

Syntax/import commands used the same six modules, with no entrypoint invocation:

```sh
stage2d_modules=(
  workers/uk_aq_prune_daily/committed_history_guard.mjs
  workers/uk_aq_prune_daily/phase_b_history_r2.mjs
  workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs
  workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs
  workers/shared/uk_aq_observation_history_operational_writer_v3.mjs
  scripts/operations/lib/uk_aq_prune_original_operation.mjs
)
for stage2d_module in "${stage2d_modules[@]}"; do node --check "$stage2d_module"; done
node --import ./tests/jsongen_test_environment.mjs --input-type=module -e \
  "await Promise.all(process.argv.slice(1).map(p => import('./' + p)));" \
  "${stage2d_modules[@]}"
git diff --check
```

No Python suite ran because no Python changed. No functional/cloud validation ran because it was explicitly excluded. A separate read-only review found no material factual/scope issue; two wording clarifications were incorporated. These results establish the documented source-level boundary, not operational restart/deletion acceptance.
