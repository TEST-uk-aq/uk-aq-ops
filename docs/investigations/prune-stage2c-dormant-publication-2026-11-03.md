# Prune Stage 2C: dormant connector-to-batch exact-only publication

Implementation based on TEST `main` **5a8fa6c4ffcf208fb45914ecdd9d1a1833afcbe4**, including #167, #168, #170 and #171. Authoritative prose was read from TEST system-docs `f199c0e9745de749e5499aab117325eac5132a00`, including the 3 November Stage 2B/2C exact-only and JSONgen contracts. `system_docs/` was not changed. No deployment, Prune invocation, operational PostgreSQL/R2/Cloudflare calls, migration, conversion or object retirement occurred.

## Changed files and reused interfaces

- `workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs`: private-symbol integration into the existing connector publisher and a named `createDormantPruneExactOnlyWriterV3()` adapter. The factory requires explicit injected storage, canonical-publication and coordination adapters; native operational R2 configuration is rejected. It has no environment selector or operational caller.
- `workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs`: conditional immutable-leaf/selector publication, retained same-operation continuation, pinned latest publication and optional checksum-capable HEAD forwarding to the existing physical verifier.
- `tests/uk_aq_prune_exact_only_lifecycle.test.mjs`: ten targeted deterministic tests using actual serialized Parquet and the existing canonical connector/day/aggregate publishers.
- This implementation/ChatGPT handover.

Both active modules already had 3 November pre-change copies under `archive/2026-11-03/workers/shared/`. Those immutable daily copies were reused under the at-most-once-per-day rule. No archive is imported or executed.

Reused interfaces: complete frozen source identity and `admitPruneFrozenConnectorSnapshot`; canonical target writer, checksum-aware Parquet PUT/verification and canonical publishers; exact-only canonical encoder/revision builder and publication dependency plan; `r2PutObjectConditional`; original-session `assertHeld` IPC capability; opaque direct physical proofs; existing connector finalisation evidence and `runPruneDailyObservationHistoryV3RunFinalization`; checked-batch completion and the existing optional JSONgen completion/evidence channel.

## Actual split publication sequence

The dormant factory freezes a copy of the complete connector/day input, recomputes its duplicate-preserving source identity and requires exact equality with the caller's frozen source evidence. The real committed-history admission guard runs before any mutation, under fresh original-session assertions. Existing canonical authority is never treated as historical replacement permission.

Only the private factory capability replaces the prepared exact hierarchy with schema 2. Ordinary and operational callers still build schema 1. The same connector writer writes/verifies canonical Parquet, pollutant children and connector manifest. The actual-byte direct verifier then authenticates canonical source/file membership and builds its original-operation-bound physical proof. Its independently built selector and leaves must match the writer's prepared artifacts exactly.

The existing publication plan supplies complete dependency identities. All immutable leaf revisions across the connector are published/read back before any selector changes. Existing revisions require exact body, byte size, SHA-256 and current object identity; they are never PUT again. Conflicting bytes are fatal. New revisions use conditional `If-None-Match: *`. Old schema-1/aligned objects are retained.

Each original selector identity is captured before canonical writes. Immediately before its switch, the physical proof and all immutable dependencies are rechecked. The single selector is created with `If-None-Match: *`, or replaced with `If-Match` against its original strong ETag. Exact resulting bytes, size, hash, ETag and immutable dependencies are checked again. This is the existing conditional-write facility, not an ordinary GET/PUT presented as CAS.

Connector results carry the real scoped-root evidence and original prepared physical handles. Batch finalisation uses the existing complete day/month/year/root and compact-latest path. Latest's original identity is pinned before this phase and its PUT is conditional; unchanged unrelated scopes remain authenticated by the existing finaliser. After finalisation, the original scopes and full checked batch are independently rechecked by `preparePruneExactOnlyBatchCompletionV3`. The result exposes one operation-local completion per connector for the already-existing optional evidence interface.

No late `history/v3/_ops/observations/runs/.../run_manifest.json` is required or moved. The completion remains **prepared before the original gate transaction**, not a committed outbox or deletion permission. Existing `phase_b_history_r2.mjs` optional evidence handling, protected candidate/gate/outbox COMMIT, original-session checks around COMMIT and separate atomic source-deletion checks are unchanged. Optional upload/evidence failures retain their existing isolation; actual lock or mandatory publication failures remain fatal.

## Interruption and recovery limits

- Leaf-only publication and partially selected connectors cannot enter batch completion.
- An uncertain conditional result is reconciled by current exact identity readback. Successful responses also require matching returned/current ETags. A failed precondition cannot be retried as an unconditional write or accepted as another writer's selection.
- The original connector continuation is retained only after canonical child verification and physical-proof preparation. A selector/leaf/readback/durability interruption may resume inside the **same live operation**, rechecking canonical files/source, selector and immutable dependencies. This continuation never rewrites canonical files/children. A replaced same-byte object with a changed pinned ETag is rejected.
- A selected parent with unfinished latest is retained. Batch retry reauthenticates the same original scopes and latest predecessor/result before completing required parents/latest; it does not restore an older selector.
- Lock loss permanently invalidates the dormant owner. A new or later-reacquired session cannot revive it. No metadata-only recovery creates READY or deletion eligibility.

**Precise remaining recovery blocker:** process restart, loss of the original session, or an interruption before the canonical stage has produced a retained verified continuation cannot be resumed by these transient handles. `workers/uk_aq_prune_daily/committed_history_guard.mjs:170` authenticates current root/index authority; its committed/missing-index branches explicitly reject when original unfinished-attempt identity cannot be proved. Matching source or canonical content does not establish that identity, and no accepted cross-invocation admission artifact is supplied by the current interface. The dormant factory therefore fails closed with an explicit original-attempt recovery requirement. It neither adds a ledger nor weakens the guard. Separately accepted recovery admission using existing candidate/original-operation evidence is required before operational activation; this PR does not claim crash/restart acceptance or a fully activated producer.

## Compatibility readiness

These are source-level findings, not deployment claims. “Implemented but not deployed/accepted” includes code whose schema-2 operational deployment/acceptance was not established here.

| Interface | Readiness | Precise condition / files |
|---|---|---|
| Station History reader and cursor 4 | Implemented but not deployed/accepted | `workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs:131` admits `[1,2]`; shared `uk_aq_observation_history_exact_leaf_reader_v3.mjs:713` emits cursor 4 for schema-2 selections and verifies current selector/leaf/physical identity on continuation. Station History `src/r2_observations.mjs` retains shared 16-page/5,000-row budgets. Real schema-2 paging/CPU acceptance is outstanding. |
| Mixed selected schema-1/schema-2 scopes | Implemented but not deployed/accepted | Shared exact reader dispatches each authenticated scoped selector explicitly; latest builder/validator in `uk_aq_observation_history_exact_leaf_index_v3.mjs` records both selected formats. Requires actual mixed-scope and cursor continuation acceptance. |
| Selected-format cache identity / invalidation | Implemented but not deployed/accepted | Exact reader `prepareObservationHistoryExactLeafRequestV3` hashes selector key/size/SHA plus exact format; `worker_v3.mjs:535` requires that identity in cache keys. Cursor continuation rereads selected identities. Real cache hit/invalidation, stale cursor and resource-budget checks remain. |
| Physical metadata / accepted Parquet schema 3 | Implemented and compatible | Original-operation verifier and `target_writer.mjs` inspector support physical schema 3 / `parquet-wasm-zstd-v3` / hash v1 / `hyparquet-direct-column-v1`. Current canonical body, complete membership, ranges, counts, values/status hash and unchanged file SHA/size/ETag are required. Local actual-byte checks pass. |
| Physical schema 4 and other hash versions | Blocked | `uk_aq_observation_history_exact_only_verifier_v3.mjs:229` and target writer's offline inspector explicitly reject schema 4/unsupported writer or hash. Reader support does not establish rebuild/producer capability. |
| Prune committed-history admission / previous publication | Blocked | `committed_history_guard.mjs` can authenticate schema-2 metadata to reject historical republication, but cannot infer original unfinished-attempt recovery/deletion authority. `phase_b_history_r2.mjs:5627` still rejects schema 2 before READY through `rejectExactOnlyOriginalHandoverV3`. The operational builder remains schema 1 and the shared publisher inactive constant stays false. |
| Repair / reconstruction | Blocked | `scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs:1220` reconstructs with the default schema-1 hierarchy; `scripts/backup_r2/lib/observation_history_migration_v3.mjs` likewise builds the established schema-1 format. No accepted format-preserving schema-2 repair/rebuild or conversion executor exists. Existing guards/defaults are unchanged. |
| Backup and restore/rebuild | Blocked | `scripts/backup_r2/build_backup_inventory.mjs:451` retains canonical history and the compact latest identity; bulk exact indexes remain excluded. `restore_history_from_dropbox.mjs` is the existing generic copy route, not proof of schema-2 derived-index reconstruction. A tested canonical-baseline/overlay-to-schema-2 rebuild and restore acceptance are required; backup transport alone is insufficient. |
| Integrity / SOS-light selected format | Blocked | `scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs:229` routes to the established writers; SOS metadata reconstruction emits schema 1. Compatible selected-format proposal/APPLY/rebuild and independent original-completion evidence remain absent/unaccepted. No implementation changes here. |
| JSONgen original authentication and currentness | Implemented but not deployed/accepted | `scripts/jsongen/prune-exact-only-authentication.mjs`, `prune-consumer-authentication.mjs`, `exact-only-metadata.mjs`, `authority.mjs` and `currentness.mjs` authenticate original committed outbox/PENDING/bundle and metadata-only selected equivalence. Schema-2 real original-event acceptance remains outstanding; all-writer coverage/coherent currentness/freshness and monthly selection remain blocked. `control.mjs:selectManagedPublications` still throws. |

## Validation

Validation uses synthetic process configuration and injected local adapters only. No operational endpoint is contacted. The two changed modules and new test pass `node --check`; both shared and operational writer modules import successfully; `git diff --check` passes. The ten new lifecycle tests pass, preserving duplicates and proving one independent physical inspection per file with reuse at batch completion.

Focused command:

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/uk_aq_prune_exact_only_lifecycle.test.mjs \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  tests/uk_aq_prune_original_operation.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs
# 30 pass / 0 fail / 0 skipped

node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  --test-name-pattern='original-session assertions|optional evidence constraint|COMMIT acknowledgement|default-off Prune completion|v3 finalization|pre-commit final preparation|schema-2 committed' \
  tests/uk_aq_prune_history_gate.test.mjs tests/jsongen_prune_pending_source.test.mjs \
  tests/uk_aq_prune_committed_history_guard.test.mjs
# 19 pass / 0 fail / 0 skipped (includes ten finalisation subchecks)
```

These 49 focused checks cover original-session absence/replacement/replay/timeout, failed or ambiguous COMMIT, optional evidence isolation, activation guards, schema-1 publication and the changed lifecycle. The name filter deliberately excludes unrelated legacy failures; Node reports zero skips for these commands.

An additional unfiltered focused run of eleven relevant test-file processes returned **8 pass / 3 fail / 0 skipped**. All three failing files (`uk_aq_prune_committed_history_guard`, `uk_aq_prune_daily_hierarchy_integration`, `uk_aq_prune_phase_b_paths`) also failed on unchanged current-main `5a8fa6c4` with the same environment/runner options. This is file-level reproduction, not individual-failure equivalence.

Complete Node suite (once): **129 test-file processes, 83 pass / 46 fail / 0 cancelled / 0 skipped**, exit 1, 101.4 seconds. The new lifecycle file passes. All **46 identical failing file names** also failed on unchanged current-main `5a8fa6c4` using the same synthetic environment, runner, concurrency and timeout: **0 pass / 46 fail / 0 cancelled / 0 skipped**, exit 1, 53.3 seconds. Only those failing files were rerun on baseline; no second complete suite ran. This establishes file-level baseline reproduction, not identical individual failure sets, a green suite, deployment evidence or real functional acceptance.

The selected baseline used the same Node options with the exact 46 file names extracted from the full TAP failure list in a clean detached worktree at `5a8fa6c4`. Both trees shared the installed dependency directory.

The complete suite command (run once after code stabilised) is:

```sh
export UK_AQ_ENV_NAME=TEST UK_AQ_GITHUB_REPO=fixture-org/fixture-ops
export UK_AQ_JSONGEN_R2_BUCKET=fixture-derived-bucket
export UK_AQ_JSONGEN_R2_ENDPOINT=https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com
mapfile -t test_files < <(rg --files tests -g '*.test.mjs' | sort)
node --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap "${test_files[@]}"
```

No Python suite ran because no Python implementation changed. No remote functional tests ran because deployment and real operations were explicitly excluded.

## ChatGPT documentation handover / activation prerequisites

ChatGPT in Chat mode may record the new **dormant injected-adapter connector-to-batch lifecycle**, conditional immutable/selector/latest semantics, same-original-operation interruption recovery and precommit completion reuse. Do not record an enabled schema-2 Prune publisher, source deletion, crash/restart recovery, deployed reader compatibility or operational CONFIRMED event.

Before any separately authorised TEST activation: resolve original unfinished-attempt recovery admission without weakening the current guard; implement/accept compatible repair/reconstruction/backup/restore and all supported writers; establish the exact physical schemas/hashes the producer and rebuild inspector can prove; deploy and accept mixed-format readers/cursor/cache support; separately review the native operational adapter and activation boundary, retaining the pre-READY guard until its full canonical/source/deletion proof can be satisfied. Then separately authorise controlled real TEST Prune, original lock/heartbeat/cancellation, complete file/parent/latest readback, protected gate/outbox COMMIT, atomic deletion and interruption/uncertain-write acceptance. JSONgen must independently authenticate the same signed PENDING dataset and committed original outbox, without another canonical Parquet scan.

Managed JSONgen monthly selection, complete writer coverage/currentness/freshness, full-month/PM-context authority and publisher acceptance remain separate prerequisites. No activation or operational command is proposed here. Before activation, rollback is a code-release revert; preserve canonical data, original outboxes, immutable receipts and old index objects. No cloud configuration, secret, SQL schema, receipt meaning or historical receipt bytes changed.
