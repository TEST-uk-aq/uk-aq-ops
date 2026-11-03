# Prune Stage 2A: original-session capability and checked batch completion

3 November 2026. TEST code only, based on Ops main
`45794ebd5373462e4cd81c40e98fe2b99b5157af` and authoritative system-docs main
`fc877e4`. This closes the two bounded implementation-interface gaps identified
in the Stage 2 review. It does not implement the wider producer/independent
JSONgen consumer integration or enable schema-2 publication.

## Original PostgreSQL session

The existing coordinator retains the exclusive observations-operation advisory
lock on its original client, as before. Its new `assertOwned()` queries
`pg_backend_pid()` and its own granted exclusive advisory-lock entry in
`pg_locks` **on that client**. It pins the first backend PID, rejects replacement
or absent ownership and uses the existing lock-loss abort/cancellation path.
The operation is marked ended before normal release. No assertion acquires or
reacquires a lock; other owners retain their existing supervision interface.

A private request/reply extension crosses the two existing process boundaries:

```text
Phase B -> job IPC -> child supervisor relay -> coordinator -> original PG client
Phase B <- fresh challenged reply <- relay <- actual ownership result
```

The supervisor creates the target IPC channel only for the existing
`prune_daily` owner. It relays one bounded message at a time and cannot produce
an ownership result. The original coordinator checks the original run/nonce,
strictly increasing request sequence, fresh UUID challenge and allowed boundary.
The worker requires the same challenge/run/nonce/sequence and pinned backend PID.
Replies are one-use, with a maximum five-second client wait. Timeout, disconnect,
replay, session replacement and close permanently invalidate that capability;
late success cannot revive it. Invalid owner requests use the existing process
group termination path. Original heartbeat, liveness pipe, cancellation and
cleanup/termination remain in place. There is no socket/HTTP service, new lock,
database table, durable lease, persistent reply history or deployment setting.

The real job passes the capability through the existing execution adapters into
Phase B. Where present, Phase B checks it at observation processing/publication,
checked batch finalisation, optional preparation and before beginning, immediately
before COMMIT and after acknowledged COMMIT of the existing separate protected
candidate/gate/outbox transaction. Owner failure is a mandatory safety error, not
an optional JSONgen warning. Lost/ROLLBACK COMMIT acknowledgement still cannot
return a successful handover. An uncertain post-COMMIT owner check suppresses the
handover and reports the original gate unconfirmed; it does not pretend to undo
an already committed database transaction. Independent authentication/replay
remains governed by the existing outbox contracts; the IPC reply is not a receipt
or durable original acceptance. There is no new source-deletion gate.

Schema-1 callers without the private channel preserve the existing interface.
Actual supervised Prune obtains fresh owner checks; the inactive schema-2 adapter
requires the original capability and cannot substitute environment context.

## Pre-gate batch completion

The existing `validatePhaseBV3RunFinalizationResult` implementation is moved,
without relaxing its conditions, into a shared Prune-only module. Its original
Phase B callers and test wrapper use the same function.

`preparePruneExactOnlyBatchCompletionV3()` consumes the actual checked batch
result, expected connector/day membership, original run and the original live
capability. It admits only opaque physical preparations bound to that **same
capability object**, not another/reacquired operation with the same run string.
It reuses the independent physical inspection already held in the verifier's
existing private proof map; it authenticates current completed canonical chains,
stored selectors/leaves, latest format/coverage and the required batch metadata
identities. Existing SHA/size/ETag checks remain. No additional Parquet inspection
is introduced. Without checksum-capable HEAD, existing full-body identity reads
remain necessary. A bare success flag cannot substitute for these proofs and
current identities.

The existing completion handle/map now also carries an explicit **nested
completion schema 2**, containing the batch identity projection instead of an
R2 run-summary reference. The existing optional final-evidence preparation checks
that this projection matches its actual finalisation result, retains the signed
PENDING key as `dataset_id` and remains `precommit_prepared_unverified`.
The existing outer envelope/bundle/outbox versions and synchronous schema-1
preparation are unchanged. The earlier latent generic completion schema 1/run
artifact path is preserved for its original caller contract; it is not required
by the new Prune-specific adapter.

The real Phase B finalisation boundary calls the new adapter when a future
schema-2 producer supplies its original opaque prepared scopes, then awaits
`preparePruneOriginalFinalEvidenceWithExactOnlyCompletion()`. Missing/unsupported
optional evidence leaves JSONgen ineligible while valid canonical work and its
protected gate may complete. An actual original-session failure is rethrown.
The protected original PostgreSQL gate/outbox COMMIT remains durable acceptance.

The late `writeRunManifest()` report and accepted budget-stop omission remain
untouched. No earlier mandatory Prune run artifact separate from that late report
was found. No artifact is added or moved to satisfy this interface.

## Files and reuse

Changed active files:

- `workers/shared/uk_aq_r2_history_writer.mjs`: live original-client ownership and
  closed operation lifetime.
- `scripts/operations/uk_aq_with_observations_global_operation_lock.mjs` and
  `uk_aq_observations_global_operation_child_supervisor.mjs`: existing IPC relay
  and original-client assertion service within the existing processes.
- New `scripts/operations/lib/uk_aq_prune_original_operation.mjs`: bounded private
  message/client handling, with only one outstanding request in memory.
- `workers/uk_aq_prune_daily/job.mjs`, `server.mjs`, `phase_b_history_r2.mjs`:
  capability handoff, live boundaries and optional Prune-specific batch adapter.
- New `workers/shared/uk_aq_prune_batch_finalization_v3.mjs`: the unchanged shared
  validator and projection of already-required finalisation references.
- `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs` and
  `uk_aq_observation_history_exact_only_publication_v3.mjs`: same-operation proof
  binding and pre-gate batch completion without a run-summary prerequisite.
- `scripts/jsongen/prune-final-evidence.mjs`: match the nested schema-2 batch
  completion to the original finalisation result.

Tests: the existing completion and history-gate tests plus the new narrowly scoped
`tests/uk_aq_prune_original_operation.test.mjs`. Six newly in-scope implementation
files have exact pre-change archives under `archive/2026-11-03/`; earlier daily
copies for the three Stage 1 modules are reused unchanged. New code has no
pre-change copy. Archives are never imported or run. No configuration catalogue,
DDL, consumer, historical receipt or authoritative system-doc file changed.

## Validation

All 11 changed/new active modules and all three changed/new test modules pass
`node --check`; all 11 active modules import successfully. Archive identity checks
and `git diff --check` pass.

The fixture command environment was process-local:

```sh
export UK_AQ_ENV_NAME=TEST
export UK_AQ_GITHUB_REPO=fixture-org/fixture-ops
export UK_AQ_JSONGEN_R2_BUCKET=local-derived-fixture
export UK_AQ_JSONGEN_R2_ENDPOINT=https://00000000000000000000000000000000.r2.cloudflarestorage.com
```

No operational data service was called. The IPC integration test runs the actual
coordinator/supervisor/child processes with an in-memory PostgreSQL adapter; it
never invokes Prune or a real database.

```sh
node --test --test-isolation=none tests/uk_aq_prune_original_operation.test.mjs tests/jsongen_prune_exact_only_completion.test.mjs
# 13 pass / 0 fail / 0 skip: actual private IPC, original ownership/replacement,
# normal release, replay/timeout, and pre-gate batch identity without a report.
node --test --test-isolation=none --test-name-pattern='original-session assertions|optional evidence constraint|COMMIT acknowledgement|default-off Prune completion|v3 finalization|pre-commit final preparation|schema-2 committed' tests/uk_aq_prune_history_gate.test.mjs tests/jsongen_prune_pending_source.test.mjs tests/uk_aq_prune_committed_history_guard.test.mjs
# 19 pass / 0 fail / 0 skip, including 10 incomplete-finalisation subchecks.
node --test --test-isolation=none tests/uk_aq_r2_history_writer_coordination.test.mjs tests/uk_aq_observations_global_operation_integration.test.mjs tests/uk_aq_prune_phase_b_lock_dispatch.test.mjs
# 24 pass / 4 fail / 0 skip. All four failures reproduce on unchanged main:
# old backup CLI expectation, SIGKILL lifecycle timing in this container,
# migration clean/exact-revision admission, and retired v2 transition fixture.
```

The required complete Node suite was run **once**, enumerating every test module
with one file process at a time and a 120-second per-file guard:

```sh
mapfile -t test_files < <(rg --files tests -g '*.test.mjs' | sort)
node --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap "${test_files[@]}"
```

Result: **127 file processes, 81 pass / 46 fail / 0 cancelled / 0 skipped**,
108.1 seconds, exit 1. Both new/updated completion-capability test files and the
full changed history-gate file pass. The broad suite is not green. Existing
coordination failures were reproduced individually on unchanged main. A targeted
comparison of the six relevant failing file processes on unchanged `45794ebd`
also returned 0 pass / 6 fail / 0 skip: `jsongen_prune_consumer`,
`jsongen_prune_pending_source`, `uk_aq_observations_global_operation_integration`,
`uk_aq_prune_committed_history_guard`, `uk_aq_prune_daily_hierarchy_integration`
and `uk_aq_prune_phase_b_paths`. This establishes existing file-level failures,
not identical individual failure sets for every file. The other 40 broad-suite
failures are not attributed or repaired by this bounded task. The focused commands
above have 56 passing checks in total, alongside the four reproduced existing
coordination failures.
No Python suite was run.

## Remaining boundaries and documentation handover

Keep `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false`, the operational
Prune schema-2 selection rejection before READY, all unsupported reader/repair/
reconstruction/backup guards, schema-3/hash-v1-only inspection and disabled managed
JSONgen selection. This PR does not select an exact-only producer or implement
the independent JSONgen consumer. Those wider Stage 2 connections remain the next
bounded implementation work; consumer support must explicitly understand the
new Prune-specific nested completion representation while preserving historical
schema-1 receipts and index-only no-event semantics.

ChatGPT may record these two TEST code interface corrections in authoritative
system docs. No new architecture decision, durable proof catalogue or SQL schema
is needed. Original session loss/release/replay and batch/report ordering have
local regression evidence; deployed resource budgets, actual PostgreSQL rights,
end-to-end original outbox authentication and real TEST Prune/consumer acceptance
still require separately authorised deployment and operations. Schema-2
activation and monthly JSONgen publication remain separate gates.

No merge, deployment, Prune run, runtime configuration change, operational R2/DB
mutation or LIVE work occurred. There are no apply/deploy commands for this stage.
Rollback before activation is a code release rollback, preserving data, receipts
and all existing inactive guards.
