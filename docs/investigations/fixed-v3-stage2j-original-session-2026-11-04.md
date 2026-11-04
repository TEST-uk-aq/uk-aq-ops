# Stage 2J: original-session Integrity assertion transport

Implemented from current TEST Ops `main` at `c591126134bf2f172037821f08a0b5aa5043d943`, including merged Stages 2H (`29522625`, PR #179) and 2I (`da53c1b7`, PR #180). Branch: `codex/stage2j-integrity-lock-assertions`. This delivery provides an operation-local assertion capability, not schema-2 repair admission or operational acceptance. No deployment, database/R2 operation or LIVE change was performed.

## Authority and structural viability

Read the repository `AGENTS.md`, TEST system-docs router and applicable R2-history/Integrity route, especially observations exclusion, SOS-light three-phase authority, implementation safety, Integrity APPLY safety and the future exact-only contract. Current authoritative docs were read from `12166cd0d1de9dee68176d3e0481ad9aed359b61`; the workspace's older system-docs files were not substituted for the Stage 2J amendment. Stage 2H/2I implementation handovers informed the active-path review. No authoritative `system_docs/` files were edited.

The actual locked reentry is:

```text
initial Python coordinator (subprocess.run; waits for the complete locked run)
  Node global observations-operation lock holder (retained PostgreSQL client)
    Node child supervisor (detached protected process-group leader)
      Python fixed-v3 ...sos-light-v3_impl.py (same process group)
        subprocess.Popen -> selected generic or dedicated SOS-light Node APPLY
```

The holder already retains real `lock.assertHeld()` and `lock.assertOwned()` capabilities. The latter queries `pg_backend_pid()` and its own granted advisory lock using the exact original client, pins the backend PID and permanently aborts on ownership loss or replacement. The existing helper cannot assert after its callback ends. It is unchanged by this PR. No separate history-writer connection is used as original-session proof.

Previously, only Prune received an original-operation callback and supervisor IPC relay. Integrity's supervisor launch used inherited standard streams; Python's APPLY `Popen` used the default descriptor closure. There was no existing Integrity assertion route across that extra boundary. A private inherited duplex descriptor works with the actual POSIX process model, without moving database ownership or introducing a service.

## Transport and interface

New `scripts/operations/lib/uk_aq_integrity_original_operation.mjs` implements a separate Integrity protocol. The holder pins the original backend **before** exposing the channel, creates a fresh operation lifetime ID, and serves only genuine requests closed over that retained lock object. Each successful assertion calls `lock.assertHeld()` and awaits `lock.assertOwned()`; both the existing helper and the server check the original backend identity. The assertion endpoint has no acquisition API.

The holder-to-supervisor hop uses the existing private Node IPC. The supervisor creates a duplex descriptor at Python fd `3`, authenticates finite frames, relays the requests over IPC and forwards only matching owner responses. There is no listening socket, TCP service, daemon, SQL table, persistent proof or scheduled/background assertion monitor. Existing lock heartbeat/liveness protection remains in place.

`integrity/original_operation.py` consumes launch metadata before normal configuration loading, removes it from `os.environ` and marks fd `3` non-inheritable. Its one-shot `popen_apply()` checks the selected execution path and exact repository APPLY entrypoint, uses `pass_fds=(3,)` and `close_fds=True`, then closes Python's copy immediately. Only that actual selected Node child retains the endpoint. Planners, R helpers, Step 0 and other subprocesses do not receive it. A second transfer fails. Python never creates an ownership result.

Channel creation is limited to owner `integrity` and the canonical fixed-v3 implementation script passed to a Python executable (`python`, `python3` or `python3.N`). Other command paths, the stable snapshots and retired v2 keep their existing launch behaviour. Fixed-v3 cannot opt into the retained v2 recovery profile. An unsupported/custom interpreter basename has no new capability; it does not acquire weaker positive assertion authority.

`UK_AQ_INTEGRITY_ORIGINAL_OPERATION_CHANNEL` is **private per-spawn descriptor metadata**, not a new environment-specific/operator configuration value, secret or catalogue entry. It carries the fd number and expected binding, not proof. Copying it or the existing inherited lock context cannot produce a real response from the holder. The trust boundary is the original process-created IPC/descriptor chain and the original-session callback, not an environment `held` flag. This assumes the trusted repository code/process hierarchy, like the existing Prune IPC; it is not attestation against a compromised lock holder or arbitrary code execution inside the trusted processes.

Both active APPLY bridges expose:

```js
await assertOriginalIntegrityOperationHeld({ expectedRunId });
```

The bridge initializes the process-local capability against its existing required owner/run/nonce context. A call returns only a fresh read-only result (`owner`, `run_id`, `session_pid`, request `sequence`, `read_only: true`, `repair_authorized: false`). It does not return a reusable publication permission. Its successful result establishes ownership at that query, not guaranteed future ownership.

Every request/response binds:

- fixed owner `integrity`;
- original run identity;
- original lock-operation nonce;
- original PostgreSQL backend PID;
- fresh operation lifetime UUID and first-use Node child lifetime UUID;
- strictly increasing assertion sequence;
- fresh UUID challenge, echoed exactly and never reused by the owner.

Frames are capped at 2,048 bytes before JSON parsing; each original operation permits at most 1,024 serialized assertions. At most one request may be outstanding. The client, supervisor and holder bound pending requests to at most five seconds. Challenge tracking is bounded by that finite assertion limit. Timeout configuration is an injected local-check seam, not an operator setting.

## Failure, cancellation and cleanup

Ownership/session mismatch, stale/duplicate request, repeated challenge, overlap, mismatched/replayed response, timeout, failed IPC send, disconnection, broken pipe or client cancellation permanently invalidates the affected channel. Late query results cannot generate success after failure. The original owner checks its abort signal around the same-session query. After an observed original-session loss, restoring a mock connection or acquiring a later lock cannot revive the old capability.

Holder-side assertion failure records a failure and terminates the existing protected group with its established TERM/KILL escalation; an apparently successful child exit cannot overwrite that failure. Supervisor transport failure uses its existing emergency group kill. Client transport failure invalidates pending assertions and terminates the APPLY process; the resulting broken endpoint cancels the supervised operation. A Python or supervisor exit follows the established group cleanup, and the holder kills remaining descendants before the lock callback can return/release. Controlled cancellation closes the Integrity assertion server/relay before continuing the existing signal path.

A normal Node completion sends a bound **lifecycle-only** end frame and permanently closes the capability; this frame is not a successful assertion. A Python run that never launches APPLY sends an unused end frame at normal process exit. Unexpected APPLY death does not get that graceful end because Python has already relinquished its fd. No restart, resume, transport reconnect or lock reacquisition is implemented. The original `finally` release and database-client cleanup remain responsible for final lock release.

## Integration versus enforcement

The transport is **connected through the active fixed-v3 launch chain**, and its read-only API is independently callable from either selected Node APPLY process. It is not merely a standalone IPC demo. The two bridge functions attach the optional capability and close it in `finally`.

There is deliberately **no new per-mutation assertion/admission step** in current schema-1 scheduling, DELETE, PUT, verification or finalisation. Existing callers without this private channel retain their existing inherited-context requirement; calling the new assertion API without a channel fails explicitly. A failed attempted assertion never falls back to that weaker context check. The newly wired path adds initial original-session pinning and channel/lifetime cancellation, but it does not claim new operationally accepted repair authority or continuous per-mutation ownership enforcement. Actual deployed behaviour has not changed because this PR was not deployed.

Prune retains its original helper, message types, stages and same-session callback unchanged. Integrity cannot use Prune admission, checked-batch, gate BEGIN/COMMIT, deletion, committed-outbox, JSONgen or recovery semantics. Shared supervision still uses separate relays and completion handling. Non-Integrity command spawning and existing v2 paths do not receive the new descriptor.

Unchanged guards include `validateGenericV3SelectedFormats()` and its pre-schedule invocation, dedicated SOS-light's schema-2 guard, the immutable-key allowlist, `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false`, and Prune's pre-READY rejection. No frozen schema-2 format, selector/current-object admission, conditional publication, repair execution, source deletion, R2 PUT/DELETE, backup scope, restore/conversion, Station History/cache or JSONgen event/receipt/monthly rule was changed. Stage 2D was not reopened.

## Files and archives

Active changes:

- `scripts/operations/lib/uk_aq_integrity_original_operation.mjs` (new bounded protocol/API).
- `scripts/operations/uk_aq_with_observations_global_operation_lock.mjs` (original callback/session binding and cancellation).
- `scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs` (separate Integrity descriptor relay).
- `scripts/uk-aq-history-integrity/bin/integrity/original_operation.py` (new one-shot handoff).
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py` (canonical `Popen` handoff).
- `scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs` and `uk_aq_apply_sos_light_v3_proposal.mjs` (optional capability lifecycle/API).
- `tests/uk_aq_integrity_original_operation.test.mjs` (narrow high-risk-boundary checks).
- This handover.

The five modified pre-existing active code files were preserved byte-for-byte before editing under `archive/2026-11-04/` with identical relative paths. Every copy was checked against the base commit. New implementation files, tests and documentation have no code-style archive copies. Archive content is never imported/executed. CodeQL already includes active Python; no workflow change was necessary.

## Targeted local validation

Node `v24.19.0`. No real PostgreSQL/R2/Dropbox service was used.

- **9 new test groups pass**, exercising fresh real-helper callbacks, owner/run/nonce/session/lifetime binding, context-only rejection, pending response mismatches, stale sequences/challenges, replay, overlap, original backend replacement, loss before/during assertions (including abort before a blocked query can return), permanent failure, bounded framing, timeouts/disconnect/cancellation and no reacquisition or repair permission.
- The narrow process-chain group runs the actual holder/supervisor, exact production Python `run_canonical_apply_executor()` function and its real `Popen`/one-shot descriptor handoff in separate processes, then both real bridge assertion exports. Local planning/source/Core prerequisites are stubbed; tiny Python/Node executable harnesses supply fixture state and invoke the API without executing operational main/APPLY mutation. It covers both modes, normal completion without an assertion, no APPLY launch, unexpected Node exit, Python death and supervisor death. This establishes structural routing, not a complete real repair run or real session continuity.
- **37 existing focused checks pass**: 22 Stage 2I generic selected-format checks, 5 Prune original-operation checks (including its actual IPC chain), and 10 shared writer/lock coordination checks.
- Of 5 existing selected supervision/inherited-run checks, **4 pass / 1 fails**. The existing `unexpected coordinator SIGKILL cannot leave the protected child running` check times out waiting for PID disappearance. The identical check also fails on an unchanged detached `c5911261` baseline, at the same wait. It is not reported as a Stage 2J regression or as passing lifecycle acceptance. The new supervisor/Python/APPLY failure cases pass independently. No unrelated lifecycle code/test repair was added.
- Node syntax and real imports for changed modules/bridges pass. Both changed/new Python sources compile. Five archive/base comparisons, protected-helper/validator/allowlist equality and `git diff --check` pass.

Commands (from repository root):

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/uk_aq_integrity_original_operation.test.mjs
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/uk_aq_prune_original_operation.test.mjs \
  tests/uk_aq_r2_history_writer_coordination.test.mjs \
  scripts/backup_r2/tests/uk_aq_generic_v3_selected_format.test.mjs
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  --test-name-pattern='lost retained lock|Integrity apply child verifies|supervised locked command preserves|unexpected coordinator SIGKILL|controlled coordinator SIGTERM' \
  tests/uk_aq_observations_global_operation_integration.test.mjs
```

The process-chain checks require local inherited-socket syscalls, allowed through the cloud command's network permission; they make no remote service calls. The failed SIGKILL check was compared using only its exact name on unchanged `main`. Full Node/Python suites were not run. Stage 2I's historical nine proposal-transport failures were not rerun or attributed to this change. Local injected ownership results do not prove actual PostgreSQL session continuity during a deployed operation.

## Chat-mode documentation and real TEST acceptance handover

Chat mode should record Stage 2J as **implemented connected, read-only assertion transport awaiting operational acceptance**, with schema-1 mutation semantics and schema-2 rejection preserved. It should distinguish the added initial session pin/lifetime cancellation from per-mutation assertion enforcement, which is not enabled. No database schema, persistent state, externally configured environment setting, deployment target, backup payload or service changes are required by this interface. Authoritative system-doc updates belong to Chat mode, not this Codex PR.

After separate deployment/operation authorisation, a finite real TEST acceptance must establish:

1. The original global lock acquisition, advisory identity and backend PID; absence of any second acquisition for assertions.
2. A fresh API call from each actual selected Node APPLY process reaching that exact retained backend, with matching run/nonce/lifetime/sequence/challenge; no R2 mutation caused by the call alone.
3. Continued ownership across normal Python/Node transitions, successful graceful no-APPLY/unused/completed channel paths and final lock/client cleanup.
4. Actual PostgreSQL session loss or ownership loss while a request is pending, prompt operation cancellation, no late successful assertion and permanent refusal after any later acquisition.
5. Supervisor IPC/descriptor disconnection, Python exit, APPLY cancellation and unexpected group termination, proving no running descendant retains a usable capability; resolve the existing local PID-disappearance-check limitation with real process-state evidence.
6. Failure/cleanup with mutation disabled, plus separately authorised schema-1 operation compatibility and an independent normal Prune operation proving unchanged exclusion/stages/release.

No real TEST operation or deployment is authorised by this delivery, and no remote apply command was executed. Operational acceptance is still required before this capability is treated as accepted authority. Rollback is a reviewed Git revert of this code; do not execute archive snapshots. A revert removes the new transport while retaining the pre-existing context/supervision model and schema-2 guards.

Next separate decisions remain: an independently validated **frozen schema-2 proposal representation** (accepted source/baseline, complete immutable closure, finite scope/budgets, exact proposed bytes and prior selected identities), then bounded APPLY-time **current-object admission** (current selector strong ETag/predecessor, full canonical/file/physical proof and final rechecks). Neither is supplied by a successful lock assertion. Conditional selector publication, actual schema-2 repair, physical-schema-4 inspector acceptance, non-derivable historical identities, interruption/recovery and any source deletion remain separately unresolved/disabled.
