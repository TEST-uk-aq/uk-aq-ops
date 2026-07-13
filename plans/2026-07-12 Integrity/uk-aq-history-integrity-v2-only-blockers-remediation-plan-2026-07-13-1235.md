# UK-AQ v2 History Integrity Blockers and Remediation Plan

Generated: 13/07/2026  
Revised: 13/07/2026 12:35 Europe/London  
Repository: `TEST-uk-aq/uk-aq-ops`  
Branch: `main`  
Scope: **v2 only**

Plan filename:

```text
uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md
```

Recommended repository location:

```text
uk-aq-ops/plans/2026-07-12 Integrity/uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md
```

---

# 1. Purpose

This plan consolidates the remaining blockers found during the audit of:

```text
uk-aq-ops/plans/2026-07-12 Integrity
uk-aq-ops/scripts/uk-aq-history-integrity
```

The current integrity system must now be treated as a **v2-only system**.

The current codebase does not need to retain, test or expose v1 history-integrity behaviour. If v1 integrity work is ever required, an older integrity codebase can be used separately.

This changes the design requirement:

```text
do not preserve v1 compatibility inside the current integrity entrypoints
do not retain v1-only repair branches merely for backwards compatibility
do not require current integrity tests to prove v1 behaviour
do not allow --history-version v1 or --history-version both
```

The streamlined order is:

```text
complete the v2-only consolidation and remaining code changes
→ run one proportionate local validation milestone
→ run one combined real CIC-Test acceptance sequence
```

The combined real acceptance still requires:

```text
a newly generated current v2 integrity report
a successful v2 executor dry-run
explicit user approval before the first CIC-Test R2 write
```

Those are safety gates inside the final real run, not separate development phases.

The plan does not authorise:

```text
LIVE repair execution
LIVE R2 mutation
SQL deployment
commits
staging
pushing
pull requests
```

unless the user separately instructs Codex to perform one of those actions.

A scoped CIC-Test R2 write is permitted only at the explicit approval point in Phase 11.

---

# 2. Scope and repository rules

## Current integrity scope

The supported current system is:

```text
history version: v2
observation domain: v2
AQI hourly domain: v2
repair planning: v2
repair execution: v2
runtime acceptance: CIC-Test v2
```

The following current integrity modes are out of scope and should be removed or rejected:

```text
history version v1
history version both
v1 integrity validation
v1 repair planning
v1 repair execution
v1/v2 comparison mode
current documentation promising v1 support
```

## Important shared-code boundary

The v2-only decision applies to the **current history-integrity system**.

Some generic ops modules, backup tools or production writers may still support v1 for callers outside history integrity. Do not delete shared v1 functionality merely because it exists.

For each shared module:

```text
remove v1 code when it is integrity-only and no current non-integrity caller needs it
leave shared v1 support in place when another current ops workflow still calls it
stop current integrity entrypoints from invoking or exposing it
```

The audit must distinguish:

```text
current integrity-specific code
shared generic ops code
historical archive code
```

Only the first category is required to become v2-only.

## Writable repository

The only writable repository is:

```text
TEST-uk-aq/uk-aq-ops
```

Expected GitHub repository:

```text
https://github.com/TEST-uk-aq/uk-aq-ops
```

## Read-only schema repository

The canonical SQL source is in:

```text
TEST-uk-aq/uk-aq-schema
```

The schema repository may be inspected read-only where required.

Do not modify it in this plan.

## Other repositories

Do not search or modify:

```text
TEST-uk-aq/uk-aq-ingest
TEST-uk-aq/uk-aq
any sibling repository other than the read-only schema exception
```

## Archives

The repository archives are intentional project history.

Codex must not:

```text
delete archive files
rewrite archive files
format archive files
include archive files in broad search-and-replace operations
treat archive copies as current implementation
use archive code as the authoritative runtime source
```

Unless the user explicitly requests archive work, exclude:

```text
archive/
```

from code searches, formatting, test edits and implementation changes.

The older v1 integrity implementation is not to be migrated into this plan.

## Authoritative Dropbox mirror paths

The local Dropbox R2 history mirror directory is:

```text
R2_history_backup
```

The current roots are:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/R2_history_backup
```

The current integrity system must use the v2 core snapshot:

```text
R2_history_backup/history/v2/core
```

All current integrity environment templates, local runtime configuration, tests,
documentation and preflight checks must use this v2 core path. No legacy core
snapshot path is part of the supported current integrity system.

---

# 3. Pragmatic testing and real-run policy

This is a test system. Real CIC-Test execution is the primary integration and acceptance evidence.

Local automated testing remains necessary where a real run cannot reliably force or prove a safety property, but it must remain proportionate.

## Required local testing

For each remaining implementation phase, run only:

```text
one focused test file or focused test command for the changed behaviour
syntax checks for changed Python, Node or shell files
git diff --check
```

Add a small regression test only when it protects one of these critical boundaries:

```text
current integrity rejects v1 and both modes
dry-run performs no PUT or DELETE
LIVE cannot pass a CIC-Test write gate
parquet and AQI keys cannot be written or deleted by the Phase 3 executor
parent writes preserve complete child sets
blocked or failed work returns a non-zero exit where shell callers depend on it
AQI completeness uses hourly grain rather than raw observation-row parity
```

Do not build a separate test for every permutation where one representative regression plus the final real CIC-Test run provides adequate evidence.

## Full-suite frequency

Do not run complete suites after every remaining phase.

Run them:

```text
once in Phase 10 final local validation
when a focused test exposes a wider regression
```

The Phase 7 milestone suites have already passed and do not need to be repeated until Phase 10.

The final current integrity suite should be v2-only. Remove or rewrite v1-only integrity tests rather than preserving them as a compatibility requirement.

## Combined real CIC-Test acceptance

Do not run another standalone Runtime checkpoint A while code work remains.

After Phases 8 to 10 are complete, Phase 11 must run this sequence:

```text
1. confirm the corrected R2_history_backup paths exist
2. run a real one-day v2 integrity check-only scan with DuckDB
3. inspect the newly generated current v2 repair plan
4. run the v2 Phase 3 CIC-Test R2 dry-run using that report
5. review exact proposed keys, hashes, dependencies and zero-write evidence
6. request explicit user approval
7. perform one scoped O3 CIC-Test write
8. rerun the one-day v2 integrity check-only scan
9. repeat the repair command and confirm an idempotent no-op
10. run a short multi-day CIC-Test check for the corrected v2 AQI hourly logic
```

A current v2 integrity report and successful dry-run remain mandatory before the write.

## LIVE boundary

No LIVE repair execution is part of this plan.

---

# 4. Current authoritative status

| Area | Current status |
| --- | --- |
| Phase 0 baseline audit | Complete |
| Phase 1 canonical schema contract | Complete |
| Phase 2 plan authority, paths and runtime model | Complete, but current documentation must now be made v2-only |
| Phase 3 runtime command preparation | Complete |
| Phase 4 report handoff and dual write gate | Complete |
| Phase 5 staged dry-run hierarchy and day batching | Local implementation complete; real validation deferred to Phase 11 |
| Phase 6 concurrency protection and verification | Complete locally |
| Phase 7 status propagation and utility hardening | Complete locally; milestone suites passed |
| Dropbox mirror root correction | Complete: current roots use `R2_history_backup` |
| Core snapshot path conversion | Complete locally: v2 core path and writer-layout importer contract are enforced; real directory check deferred to Phase 11 |
| Phase 8 v2-only conversion and write-path consolidation | Implementation complete; runtime acceptance pending |
| Phase 9 AQI hourly-grain correction | Implementation complete; real v2 AQI acceptance deferred to Phase 11 |
| Phase 10 final proportionate local validation | Incomplete: 10 current Python fixture failures require focused follow-up |
| Phase 11 combined real CIC-Test acceptance | Not started |
| Current v1 integrity support | Rejected before scan or repair work; the disabled historical wrapper retains unreachable legacy argument-handling code |
| LIVE repair enablement | Not authorised |

The master current-status authority remains:

```text
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
```

The other plans and implementation records are historical evidence.

---

# 5. Blocker disposition under the v2-only decision

| Blocker | Current disposition |
| --- | --- |
| A: canonical readiness SQL test | Resolved |
| B: real v2 DuckDB acceptance | Pending combined Phase 11 run |
| C: dual environment and bucket write gate | Resolved locally |
| D: accurate dry-run hierarchy | Resolved locally |
| E: complete child re-list/re-read before parent PUT | Resolved locally |
| F: multi-connector ordering | Resolved locally |
| G: index status propagation | Resolved locally |
| H: blocked generic index shell success | Resolved locally |
| I: realistic O3 action contract | Covered by focused fixture; real proof pending Phase 11 |
| J: strict standalone day child validation | Resolved locally for v2 observations |
| K: deterministic complete-report handoff | Resolved locally |
| L: overlapping current v2 `--run-backfill` paths | Resolved locally in Phase 8 by disabling the unsafe integrity route; generic non-integrity writers are retained |
| M: invalid AQI raw-row parity | Resolved locally in Phase 9; real v2 AQI acceptance deferred to Phase 11 |
| N: contradictory plan statuses | Resolved, with a further v2-only status update required |
| O: stale runtime/deployment paths | Resolved |
| P: incorrect local mirror directory `r2-history` | Resolved as `R2_history_backup` |
| Q: current integrity still exposes or contains v1/both behaviour | Resolved locally in Phase 8: parser/launcher accept v2 only and reports are v2 only |
| R: current core snapshot configuration still points at a legacy core path | Resolved locally in Phase 8; real directory acceptance deferred to Phase 11 |

## Remaining substantive blockers

```text
Blocker L: assign one clear owner and execution order to every reachable v2 write
Blocker Q: convert the current integrity entrypoints, plans, tests and runtime contract to v2 only
Blocker R: resolved locally; Phase 11 must confirm the real v2 core directory
```

Resolved blockers must not be reopened without current evidence of a regression.

---

# 6. Remediation phases

---

# Phase 0: baseline and evidence capture

## Goal

Confirm the exact current repository state before editing and create a reliable findings matrix.

## Required analysis

Inspect current, non-archive files under:

```text
plans/2026-07-12 Integrity
scripts/uk-aq-history-integrity
scripts/backup_r2
workers/shared
workers/uk_aq_prune_daily
tests
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
```

Do not search `archive/`.

Create a table mapping every blocker in this plan to:

```text
confirmed
partly confirmed
not confirmed
superseded
```

Record the exact file and function evidence.

## Outputs

```text
no implementation changes unless needed to make the audit scriptable
updated blocker plan implementation record
exact test baseline
exact current test failures
exact current branch and commit
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops on branch main.

Read the complete plan:

plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1202.md

Perform Phase 0 only.

Do not modify or search archive/.

The schema repository may be inspected read-only only where this plan explicitly requires it. Do not modify any sibling repository.

Before reading implementation files, run:

pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch
git log --oneline -12

Continue only in TEST-uk-aq/uk-aq-ops on main.

Do not commit, stage, push, branch, tag, deploy, apply SQL, copy runtime files, contact R2, run a backfill or mutate history data.

Audit every blocker A to O against the current non-archive implementation.

For each blocker record:

- confirmed, partly confirmed, not confirmed or superseded;
- exact current files and functions;
- exact test coverage;
- exact missing coverage;
- whether the issue is code, test, plan, documentation or runtime acceptance;
- the safest remediation phase.

Run the current available Python integrity suite and relevant Node tests without changing code merely to force them to pass.

Record all failures and distinguish expected current blockers from unrelated failures.

Update only the Phase 0 implementation record in this plan.

Stop after the audit.
```

## Phase 0 implementation record

Status:

```text
Complete — audit only; no implementation or runtime changes.
```

Repository evidence captured before implementation-file inspection:

```text
pwd -P: /Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
Git top level: /Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
origin: https://github.com/TEST-uk-aq/uk-aq-ops.git
branch: main
HEAD: b645131 Delete uk_aq_rpc_daily_task_backup_readiness.sql
initial worktree state: only this untracked blocker plan
```

Audit scope was limited to the required current, non-archive files in the plan,
integrity scripts, backup/index utilities, shared/prune code, tests, and current
documentation. The schema repository was read only for Blocker A: its canonical
`schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql` exists.

### Blocker findings matrix

The matrix records the full audit. Its “missing coverage” column is not a requirement to create one automated test for every listed case. Under the revised policy, Codex should use representative safety regressions and real CIC-Test runs wherever they provide stronger evidence.

| Blocker | Status and exact current evidence | Current test coverage | Missing coverage | Issue type | Safest remediation phase |
| --- | --- | --- | --- | --- | --- |
| A | **Confirmed.** `scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py`, `BackupGateAndRepairPlanTests.test_readiness_sql_matches_real_daily_task_contract_and_canonical_copy`, reads the deleted `scripts/uk-aq-history-integrity/sql/uk_aq_rpc_daily_task_backup_readiness.sql` before it reads and compares the canonical schema SQL. | The named test checks the RPC contract and canonical-copy equality; backup-gate request/order tests are also in this module. | A robust sibling-schema locator; a clear unavailable-canonical assertion; a test that does not require an ops mirror. | Code, test, plan | Phase 1 |
| B | **Confirmed.** `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`, `_read_v2_parquet_stats` (DuckDB import/use near lines 7663–7668), and `uk-aq-aqi-gap-check.py`, `read_parquet_counts`, use real DuckDB when run, but no CIC-Test acceptance result exists. | `test_v2_phase2_validation.py`, `test_duckdb_reader_returns_actual_timeseries_counts`, injects a fake DuckDB connection; `test_valid_o3_parquet_missing_manifest_is_manifest_only_and_never_queues_aqi` covers the O3 classification locally. | The specified CIC-Test manual v2 check-only run, real parquet reads, report creation, and proof of no R2/backfill activity. | Runtime acceptance | Phase 3 |
| C | **Confirmed.** `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs`, `runV2ObservationsRepair`, line 148 checks only `config.r2.bucket`; it does not require `UK_AQ_ENV_NAME=CIC-Test`. The standalone day utility, `assertTestR2WriteTarget`, also checks only the bucket. | `tests/uk_aq_phase_3_repair_executor.test.mjs`, `Phase 3 executor rejects AQI and non-CIC-Test writes before R2 access`, rejects a non-test bucket. | All environment/bucket matrix cases, missing environment/bucket cases, and a test proving rejection happens before any R2 request. | Code, test | Phase 4 |
| D | **Confirmed.** Executor functions `readChildren`, `putVerified`, and the per-scope loop in `runV2ObservationsRepair` read live children and immediately return `planned` in dry-run; they do not retain proposed connector/day/index bytes in one staged map. The index call is skipped whenever a parent result is planned. | The O3 executor test covers write-mode parent repair and idempotence. | Dry-run output equal to write-mode proposed hierarchy; proposed day built from a proposed connector; zero PUTs with planned index/latest/metadata objects. | Code, test | Phase 5 |
| E | **Confirmed.** `readChildren` lists and GETs once, then `assertUnchangedChildren` HEAD-checks only already-known keys. Calls before connector/day `putVerified` do not freshly re-list the complete prefix or re-GET every child immediately before the PUT. | Existing executor/day-utility tests cover normal writes and post-write body verification. | Added/removed sibling, changed body with unchanged/missing ETag, disappearing requested child, and verification mismatch race tests. | Code, test | Phase 6 |
| F | **Confirmed.** `normalizePlan` creates scopes by `(dayUtc, connectorId)` and `runV2ObservationsRepair` loops each scope independently, writing a day parent inside every relevant scope. Two connector repairs for one day therefore rebuild the day repeatedly. | One-connector O3 fixture only. | Two-connector/same-day fixture proving one complete day rebuild followed by one index rebuild. | Code, test | Phase 5 |
| G | **Confirmed.** Executor line 176 stores `indexResult`, but lines 176–181 calculate scope/top-level status from connector/day statuses only. An index-only scope has an empty status list and reports `skipped_unchanged`; index failures/blocks cannot control the result. | `tests/uk_aq_r2_history_index.test.mjs` checks index builder payloads and a dry-run result, not executor status propagation. | Index-only success/blocked/failed cases and connector/day dependency propagation into top-level status, verification, and exit semantics. | Code, test | Phase 7 |
| H | **Confirmed.** `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`, `runHistoryIndexBuild`, returns `ok: true` unconditionally even when `buildRepairSections` reports `blocked_dependency`; `main` exits zero unless an exception is thrown. | `uk_aq_r2_history_index.test.mjs` covers planned dry-run and a permitted configured-bucket write. | Command-level blocked/verification-failed/invalid-input non-zero exit tests. | Code, test | Phase 7 |
| I | **Confirmed.** The sole executor O3 fixture in `tests/uk_aq_phase_3_repair_executor.test.mjs` manually invents a one-action plan with `requires_index_rebuild: false`; it asserts only two parent PUTs and no parquet/AQI keys. | It proves sibling preservation and idempotence for one connector/day parent repair. Python `test_v2_phase2_validation.py` proves the checker can assign `requires_index_rebuild`. | A complete checker-shaped O3 report/plan with `requires_index_rebuild=true`, targeted index/latest/metadata assertions, no AQI action, and idempotent second end-to-end run. | Test, input contract | Phase 8 |
| J | **Confirmed.** `scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs`, `runDayManifestRebuild`, parses connector JSON through `readJsonBuffer` and passes it to `buildDayManifestFromConnectorManifests`; it has no shared strict child validator for manifest kind/version/domain/day/key/hash/required aggregates. | `uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs` covers valid rebuild, unchanged result, and post-write body mismatch. | Wrong-domain/version/day/key/connector/hash/required-field child cases and proof the utility shares the strict executor validator. | Code, test | Phase 7 |
| K | **Confirmed.** The checker emits actions under `summary.cross_check.v2_observations.repair_plan` (`run_v2_observations_integrity_checks`); the executor accepts only a hand-created top-level `{history_version, domain, repair_plan}` via `--repair-plan-json`/`normalizePlan`. No handoff invocation exists in integrity scripts. `normalizePlan` also discards `gap_types`. | Python repair-plan tests check action planning; Node executor tests supply a manually authored plan. | Direct complete-report acceptance (or tested normalizer), deterministic scope deduplication, gap-type preservation, and rejection of v1/AQI/data/operator-review actions from a real fixture. | Code, test | Phase 4 |
| L | **Confirmed.** `uk-aq-history-integrity.py` has write-capable `--run-backfill` paths through `run_cross_check_backfills`, `run_v2_gap_backfills`, `queue_v2_aqi_rebuilds_from_integrity_gaps`, `run_aqi_rebuild_queue_execution`, and `run_v2_post_repair_integrity_rechecks`. | `test_v2_repair_execution.py` has extensive mocked coverage for source repair, AQI queueing/execution, guards, and post-repair checks. | A complete classification inventory of all reachable v2 write paths, their gates/verification/status behavior, and a single Phase 4 architecture decision. | Code, plan, test inventory | Phase 9 |
| M | **Resolved locally in Phase 9.** Both current v2 integrity entrypoints derive AQI completeness from supported valid source `(timeseries_id, UTC hour)` identities, not raw row counts. | Three focused regressions cover 288 five-minute observations/24 valid hours, one missing expected hour, and ineligible O3. | Real CIC-Test v2 AQI hourly-grain acceptance remains required in Phase 11. | Code, test, runtime acceptance | Phase 11 |
| N | **Confirmed.** `uk-aq-v2-history-integrity-phased-plan.md` marks Phase 2 `Complete` while stating runtime validation remains pending and Phase 4 `Not started`; `uk-aq-phase-3-observation-manifest-index-repair-plan-2026-07-12-2302.md` marks the Phase 3 table `In progress` but its implementation record `Complete`. | None; this is plan state. | One authoritative current status table and historical-record notices on subordinate plans. | Plan | Phase 2 |
| O | **Confirmed.** Both `scripts/uk-aq-history-integrity/env/*.env.example` and `system_docs/uk-aq-r2-history-integrity.md` contain obsolete CIC/LIVE ops paths and `/Users/mikehinford/uk-aq-history-integrity` installation paths. The executor imports `workers/shared` and `workers/uk_aq_prune_daily` via repository-relative paths, while the docs describe a standalone copied launcher without a complete dependency bundle. | None for current paths/deployment model. | Non-archive path consistency checks and explicit documentation of a complete checkout or a complete, defined runtime bundle. | Documentation, runtime deployment model | Phase 2 |

### Local test baseline

```text
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
Ran 251 tests in 1.175s: FAILED (errors=1)

Expected current blocker failure:
BackupGateAndRepairPlanTests.test_readiness_sql_matches_real_daily_task_contract_and_canonical_copy
FileNotFoundError for the deleted ops mirror:
scripts/uk-aq-history-integrity/sql/uk_aq_rpc_daily_task_backup_readiness.sql

Unrelated non-failing output:
- expected mocked-fixture/logging output, including a deliberately invalid `--source sos-api` parser case;
- ResourceWarning messages for unclosed test SQLite connections.

node --test tests/uk_aq_phase_3_repair_executor.test.mjs tests/uk_aq_phase_3a_writer_contract.test.mjs tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs tests/uk_aq_r2_history_index.test.mjs
36 passed, 0 failed.
```

No archive paths were searched or modified. No R2, deployment, SQL, backfill, history-data, staging, commit, branch, tag, or push operation occurred.

---

# Phase 1: canonical schema test and Phase 1 contract repair

## Goal

Make the backup-readiness test use the canonical schema repository directly without restoring an ops SQL mirror.

## Required implementation

1. Update the SQL contract test to locate:

```text
TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql
```

2. Use a robust sibling-repository locator.
3. Fail clearly if the canonical file is unavailable.
4. Do not create a copied SQL fixture in the ops repository.
5. Update the master plan so canonical SQL belongs only in `uk-aq-schema`.
6. Remove statements requiring two SQL copies to be identical.
7. Keep the schema repository read-only.
8. Preserve all existing backup-gate request and ordering tests.

## Acceptance criteria

```text
focused backup-gate tests pass
full integrity suite no longer fails because the ops SQL mirror is absent
no new SQL mirror is created
no schema repository file changes
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 1 only.

Work only in TEST-uk-aq/uk-aq-ops on main.

Do not search or modify archive/.

The sibling TEST-uk-aq/uk-aq-schema repository is read-only.

Confirm first that the current test still expects:

scripts/uk-aq-history-integrity/sql/uk_aq_rpc_daily_task_backup_readiness.sql

and that the canonical SQL exists at:

TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql

Update the test so it reads and validates the canonical schema file directly.

Use a robust repository locator and produce a clear assertion failure if the canonical file is unavailable.

Do not recreate the deleted ops SQL mirror.

Update the master phased plan and current documentation so the canonical ownership is accurate.

Run:

python3 -m unittest scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py -v

python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q

python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py

npm run check
git diff --check

Do not commit, stage, push, deploy, apply SQL or copy files.

Update only the Phase 1 implementation record in the blockers plan and stop.
```

## Phase 1 implementation record

Status:

```text
Complete — local implementation and validation complete; no schema or runtime operation performed.
```

Implemented:

```text
- Updated test_backup_gate_and_repair_plan.py so canonical_readiness_sql_path()
  derives the sibling TEST-uk-aq-schema checkout from the current ops repository
  root and reads only schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql.
- Added a clear assertion explaining the expected canonical path and sibling
  checkout requirement when that canonical source is unavailable.
- Removed the deleted ops SQL mirror from the test contract; no mirror was
  recreated.
- Updated the master phased plan and current history-integrity documentation:
  canonical readiness-RPC SQL belongs only in uk-aq-schema and the ops test
  reads it directly.
```

Files changed:

```text
scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1202.md
```

Validation:

```text
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py -v
25 tests passed.

python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
251 tests passed.

python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
Passed.

npm run check
Passed.

git diff --check
Passed.
```

No SQL was applied and no schema file was modified. No archive, R2, deployment,
backfill, history-data, staging, commit, branch, tag, or push operation occurred.

---

# Phase 2: plan authority, stale paths and runtime deployment model

## Goal

Make plans and documentation describe the current architecture accurately before further repair code changes.

## Required implementation

1. Make the master phased plan the sole authoritative status source.
2. Mark Phase 2c and Phase 3 subplans as historical implementation records.
3. Correct contradictory phase statuses.
4. Record Phase 2 as:

```text
implementation complete
runtime acceptance pending
```

5. Record Phase 3 as:

```text
in progress
not safe for runtime execution
```

6. Record Phase 4 as:

```text
existing overlapping implementation requires audit
formal phase not complete
```

7. Correct stale repository paths in:

```text
CIC-Test.env.example
LIVE.env.example
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
```

8. Define the supported Phase 3 runtime deployment model.

## Acceptance criteria

```text
one authoritative status table
no contradictory current status claims
no obsolete CIC repository paths in current non-archive documentation
runtime bundle requirements are explicit
archive files remain untouched
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 2 only.

Do not change runtime logic in this phase.

Do not search or modify archive/.

Make:

plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md

the sole authoritative current status table.

Add a clear historical-record notice to the other implementation plans without rewriting their historical content unnecessarily.

Correct all current non-archive documentation and env examples that still reference obsolete CIC repository paths.

Document the exact current repository path:

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops

Define whether Phase 3 is supported by:

- running from a complete ops checkout; or
- a documented runtime bundle.

Choose the smallest accurate model based on the actual import graph.

Do not create an incomplete copy list.

Run documentation path searches excluding archive/, syntax checks and git diff --check.

Do not commit, stage, push, deploy or copy runtime files.

Update only the Phase 2 implementation record in the blockers plan and stop.
```

## Phase 2 implementation record

Status:

```text
Implementation complete; runtime acceptance pending.
```

Implemented:

```text
- Made uk-aq-v2-history-integrity-phased-plan.md the sole authoritative current
  history-integrity status table. It now records Phase 2 as implementation
  complete/runtime acceptance pending, Phase 3 as in progress/not safe for
  runtime execution, and Phase 4 as requiring the existing-write-path audit.
- Marked the Phase 2c, Phase 2c.2, and Phase 3 implementation plans as
  historical records without rewriting their historical status content.
- Replaced obsolete CIC/LIVE ops checkout paths in the current
  history-integrity env templates and documentation with the exact current ops
  checkout path:
  /Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
- Defined the complete ops checkout as the only supported Phase 3 runtime model.
  This follows the executor import graph through shared R2/index modules and
  the Phase B writer/package dependencies. No partial-copy runtime bundle is
  documented or supported.
- Kept local SQLite state outside the checkout in the templates and docs.
```

Files changed for Phase 2:

```text
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
plans/2026-07-12 Integrity/uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md
plans/2026-07-12 Integrity/uk-aq-phase-3-observation-manifest-index-repair-plan-2026-07-12-2302.md
scripts/uk-aq-history-integrity/env/CIC-Test.env.example
scripts/uk-aq-history-integrity/env/LIVE.env.example
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
system_docs/uk_aq_scripts.md
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1202.md
```

Validation:

```text
Documentation/env stale-path search excluding archive/: passed (no matches in
the current history-integrity documentation or env templates).

bash -n scripts/uk-aq-history-integrity/env/CIC-Test.env.example
bash -n scripts/uk-aq-history-integrity/env/LIVE.env.example
bash -n scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
Passed.

python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
Passed.

npm run check
Passed.

git diff --check
Passed after the Phase 2 record update.
```

No runtime logic changed. No archive, R2, deployment, SQL, backfill,
runtime-copy, staging, commit, branch, tag, or push operation occurred.

---

# Phase 3: real Phase 2 runtime acceptance preparation

## Goal

Prepare and verify the exact safe CIC-Test check-only command without enabling writes.

This phase may update code or documentation only where the runtime handoff is ambiguous or broken.

It must not perform the actual runtime run unless the user separately instructs Codex or the user performs it manually.

## Required preparation

Confirm:

```text
the launcher uses UK_AQ_HISTORY_INTEGRITY_PYTHON
the CIC-Test env points to the venv Python
duckdb imports successfully from that interpreter
--check-only prevents backfill
--run-backfill is absent
manual profile bypasses the scheduled backup gate
daily task health can be disabled for the manual acceptance run
```

Prepare the exact command for:

```text
2026-05-17
history-version v2
source all
concurrency 1
verbose
```

Document expected report fields and acceptable exit behaviour.

## Runtime acceptance must later confirm

```text
DuckDB reader actually runs
O3 is detected as hierarchy/index repair
O3 parquet remains valid
no AQI action is planned
no write occurs
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 3 preparation only.

Do not run the real integrity acceptance command.

Inspect the current launcher, env examples, argument parsing, check-only behaviour, run-backfill gates and report paths.

Confirm the exact safe CIC-Test runtime command for one day:

2026-05-17

Requirements:

- use the deployed shell launcher;
- use the configured venv Python;
- manual profile;
- history version v2;
- source all;
- check-only;
- no --run-backfill;
- concurrency 1;
- verbose;
- daily task health disabled for this manual acceptance run where appropriate.

Add or update tests if check-only or launcher behaviour is not already proven.

Document:

- exact command;
- expected exit code semantics;
- expected JSON report fields;
- explicit proof that no R2 write or backfill can occur;
- files that must be copied later;
- rollback files.

Do not contact R2, run a backfill, deploy, copy files, commit, stage or push.

Update only the Phase 3 implementation record in the blockers plan and stop.
```

## Phase 3 implementation record

Status:

```text
Preparation complete; CIC-Test runtime acceptance has not been run.
```

### Prepared CIC-Test acceptance command

Before the user runs this command, the complete checkout must contain a locally
configured, untracked `scripts/uk-aq-history-integrity/env/CIC-Test.env`.
Create that local configuration from `CIC-Test.env.example`, configure its
secrets and local/Dropbox state paths, and set:

```bash
UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED=false
```

in that local file for this manual acceptance only. The launcher sources the
env file after process startup, so a command-line environment assignment would
be overwritten by an env file that sets the value to `true`.

Do not run this command as part of Phase 3 preparation:

```bash
"/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh" \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-05-17 \
  --to-day 2026-05-17 \
  --history-version v2 \
  --check-only \
  --concurrency 1 \
  --verbose
```

The launcher reads `UK_AQ_HISTORY_INTEGRITY_PYTHON` from the configured env;
the current CIC-Test template resolves this to the complete checkout's
`.venv/bin/python`. DuckDB 1.5.4 imports successfully from that interpreter.
The `manual` profile bypasses the scheduled Dropbox backup-readiness gate.

### No-write proof

```text
- The command intentionally omits --run-backfill, so argparse sets
  run_backfill=false; the added parser test proves this exact argument shape.
- run_v2_gap_backfills, queue_v2_aqi_rebuilds_from_integrity_gaps, and
  run_aqi_rebuild_queue_execution return without write/backfill work when
  run_backfill is false.
- The Phase 3 R2 executor is not invoked by this command.
- --check-only is recorded in the report but is not, by itself, a mutual-
  exclusion guard: adding --run-backfill would opt into existing write-capable
  paths. The absent flag is therefore required safety evidence.
- The acceptance run will perform its normal permitted reads, local SQLite
  state/report writes, and configured Dropbox DB-copy behaviour; it must not
  perform R2 PUT/DELETE, a backfill command, or AQI rebuild execution.
```

### Expected result and report contract

```text
Expected successful process exit: 0, with JSON and Markdown reports under
UK_AQ_HISTORY_INTEGRITY_REPORT_DIR named <run-utc>-summary.json and
<run-utc>-summary.md.

An exit of 0 means the checker completed; it does not by itself mean the
history is healthy. Inspect history_version_results.v2.status and the v2
observations/AQI gap arrays. The known acceptance evidence should show valid O3
parquet classified as hierarchy/index repair, no AQI repair action for O3, and
no executed repair action.

Expected top-level JSON fields include env, profile, source, from_day, to_day,
history_version_mode, checked_versions, history_path_configs,
history_version_results, check_only=true, run_backfill=false,
backup_readiness, snapshot, cross_check, metrics, status, db_path, log_path,
started_at_utc, and finished_at_utc.

Non-zero meanings requiring investigation: 1 is a Python/runtime failure;
2 is invalid CLI input or the scheduled backup gate (not expected for manual);
3-6 are launcher env/guardrail/lock/entrypoint failures. Do not treat any
non-zero result as an acceptance result.
```

### Later manual handoff and rollback

```text
Files to copy later: no runtime code files. The supported model is the complete
ops checkout. The only local materialisation required before a later run is the
untracked env/CIC-Test.env configuration derived from its tracked template.

Rollback before/after the later manual acceptance: preserve and restore the
previous local env/CIC-Test.env (especially the daily-task-health value); retain
or restore the pre-run local SQLite file at
UK_AQ_HISTORY_INTEGRITY_DB_PATH if the acceptance must be discarded. Reports
and logs are append-only evidence and should be retained rather than rewritten.
```

Validation:

```text
scripts/uk-aq-history-integrity/tests/test_preflight.py
19 tests passed, including the exact manual-v2-check-only parser contract.

python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
252 tests passed.

bash -n scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
Passed.
```

The real acceptance command was not run. No R2, backfill, deployment,
runtime-copy, SQL, archive, staging, commit, branch, tag, or push operation
occurred.

---

# Phase 4: Phase 3 input contract and dual write gate

## Goal

Make the executor consume real integrity output safely and enforce both environment and bucket write restrictions.

## Required implementation

1. Accept the complete integrity report directly, or add a read-only normaliser.
2. Validate the top-level report and selected action structure.
3. Select only supported v2 observation Phase 3 actions.
4. Reject:

```text
AQI actions
observation data-repair actions
source-mapping/operator-review actions
v1 actions
wrong domain
unknown kinds
malformed actions
```

5. Deduplicate scopes deterministically.
6. Require both:

```text
UK_AQ_ENV_NAME=CIC-Test
CFLARE_R2_BUCKET or R2_BUCKET=uk-aq-history-cic-test
```

7. Keep dry-run as the default.
8. Require explicit `--write-r2`.

## Acceptance criteria

```text
real integrity report fixture accepted
no manual action JSON invention required
LIVE + test bucket rejected
CIC-Test + non-test bucket rejected
unsupported actions rejected before any R2 call
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 4 only.

Do not begin dry-run hierarchy staging or concurrency changes yet except where required for the input contract.

Work only in uk-aq-ops main.

Do not search or modify archive/.

Inspect the exact JSON report produced by:

scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py

and the exact input accepted by:

scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs

Implement the smallest deterministic handoff:

- preferably accept the complete integrity JSON report directly;
- otherwise add a read-only normaliser with a tested contract.

Validate and reject all unsupported action types before any R2 request.

Add a dual write gate requiring both:

UK_AQ_ENV_NAME=CIC-Test

and:

uk-aq-history-cic-test

as the configured bucket.

Add complete mocked tests for the environment/bucket matrix and real integrity report fixture.

Do not contact real R2.

Run focused Node tests, the full Python integrity suite, node --check, npm run check and git diff --check.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 4 implementation record in the blockers plan and stop.
```

## Phase 4 implementation record

**Status: implementation complete; Phase 5 staging and concurrency work has not
started.**

Implemented the smallest direct handoff from the complete integrity JSON report
to the v2 observations executor. `uk_aq_execute_v2_observations_repair.mjs` now
accepts the production report shape at:

```text
history_version_results.v2.history_version == "v2"
history_version_results.v2.observations.repair_plan
```

through the existing `--repair-plan-json` file argument. The previous explicit
v2 observations repair-plan envelope remains accepted for compatibility. No
normaliser or copied action file is required.

Before resolving or requesting R2, the executor validates every selected action:

- a complete report declares `history_version_mode` of `v2` or `both`, includes
  `v2` in `checked_versions`, and contains implemented, checked v2 observations
  results; and
- only the five observations manifest/index action kinds are allowed;
- `status` must be `planned`, `executes`, `data_changes_required`, and
  `operator_action_required` must all be `false`;
- optional action-level `history_version` and `domain` must be `v2` and
  `observations` respectively;
- index intent, non-empty `gap_types`, day, and positive connector ID must have
  the expected types; and
- scopes are deterministically sorted by day/connector, with sorted de-duplicated
  gap types retained in the returned planning record.

AQI, data-repair, source-mapping/operator-review, v1, wrong-domain, unknown,
and malformed/unsafe actions are rejected before any R2 request.

An explicit `--write-r2` additionally requires both exact conditions:

```text
UK_AQ_ENV_NAME=CIC-Test
resolved R2 bucket (R2_BUCKET or CFLARE_R2_BUCKET)=uk-aq-history-cic-test
```

Dry-run remains the default. The new gate does not alter Phase 5 hierarchy
staging, day batching, or concurrency behavior.

Files changed for this phase:

```text
scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
tests/uk_aq_phase_3_repair_executor.test.mjs
tests/fixtures/uk_aq_v2_observations_integrity_report.json
```

The mocked Node test passes the real `--repair-plan-json` fixture path through
the executor, verifies no PUT in dry-run, verifies all generated unsupported
action families and unsafe contract variants fail before a mocked R2 request,
and covers the environment/bucket matrix including `R2_BUCKET` precedence.

Validation run:

```text
node --test tests/uk_aq_phase_3_repair_executor.test.mjs
4 tests passed.

python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
252 tests passed. The suite emitted its existing intentional parser/backup-gate
diagnostics and ResourceWarnings, but completed with OK.

node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
Passed.

npm run check
Passed.
```

No real R2 contact, dry-run hierarchy staging, concurrency change, SQL,
backfill, deployment, runtime-file copy, archive access, commit, stage, push,
branch, or tag operation occurred.

---

# Phase 5: accurate dry-run and bottom-up day execution

## Goal

Make dry-run and write mode generate the same proposed hierarchy, with one day and one index operation after all connector proposals for that day.

## Required implementation

Build one in-memory staged object map for each day:

```text
all selected child/connector proposals
→ one day proposal
→ one targeted observation index/latest/metadata proposal set
```

Dry-run and write mode must use the same proposed bytes. Only the PUT stage differs.

Dry-run output must show:

```text
planned object keys
changed or unchanged
old and proposed hashes where available
dependencies
blocked scopes
```

## Proportionate local checks

Run only:

```text
focused Phase 3 executor tests
node --check for changed .mjs files
git diff --check
```

Representative regressions:

```text
proposed connector feeds proposed day
two connectors on one day cause one day/index update
dry-run causes zero PUT/DELETE
```

## Runtime policy

Do not run a separate real CIC-Test dry-run during this phase.

Real check-only report generation and the executor dry-run are now consecutive steps in Phase 11 after all remaining code changes and final local validation.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

## Phase 5 implementation record

**Status: local implementation complete; real validation deferred to Phase 11.**

The Phase 3 executor now groups selected scopes by day and constructs one staged in-memory hierarchy before its final write stage:

```text
selected connector proposals
→ one day proposal from the complete staged connector set
→ one targeted observations index/latest/metadata proposal set
→ optional PUT stage only when --write-r2 is present
```

Dry-run remains the default. It returns staged proposal keys, old SHA-256 and ETag where available, new SHA-256, exact proposed body, dependencies, changed/skipped state, blocked scopes, and expected verification.

The staged adapter presents proposed parent objects to the targeted index builder, so the day/index proposal is derived from the same hierarchy that write mode would apply.

Validation completed:

```text
node --test --test-name-pattern='one-connector|two connector|dry-run proposal bytes' tests/uk_aq_phase_3_repair_executor.test.mjs
3 passed, 0 failed.

node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
node --check workers/shared/r2_sigv4.mjs
node --check workers/shared/uk_aq_r2_history_index.mjs
git diff --check
Passed.
```

### Historical real-run attempts

An earlier dry-run attempt used `2026-07-11T205039Z-summary.json`. That report predated the current report contract and lacked:

```text
history_version_results.v2.observations.repair_plan
```

The executor correctly rejected it before R2 configuration or requests.

A later Runtime checkpoint A attempt stopped in local preflight because the env template incorrectly used:

```text
CIC-Test/r2-history
```

instead of the authoritative:

```text
CIC-Test/R2_history_backup
```

That configuration path has now been corrected in the CIC-Test and LIVE templates and the focused v2 repair execution fixture.

Neither historical attempt is a reason to interrupt the remaining implementation phases. The complete real sequence is deferred to Phase 11.

No real R2 mutation occurred.

---

# Phase 6: concurrency protection and fresh verification

## Goal

Prevent a parent replacement when the live child set or child content changes between planning and writing.

## Required implementation

Immediately before every connector or day PUT:

```text
freshly LIST the complete child prefix
compare the complete key set
freshly GET required children
compare exact body hashes
use ETag as an additional signal where available
block on added, removed or changed children
```

After every changed PUT:

```text
fresh GET
exact body/hash verification
expected key and hierarchy-reference verification
```

## Proportionate local checks

Use one focused race test for a changed key set and one for changed child content. These two representative tests are sufficient if they exercise the shared guard used by both connector and day writes.

Also run:

```text
node --check for changed files
git diff --check
```

Do not create a separate mocked test for every race permutation.

## Real-run evidence

The subsequent real CIC-Test write and post-write integrity check are the primary integration proof. Ensure logs expose the pre-write re-list/re-read and post-write verification steps so they can be audited from that run.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and implement Phase 6 only.

Do not search or modify archive/ and do not contact LIVE.

Before every Phase 3 parent PUT, freshly re-list the complete child prefix and freshly re-read the required children. Compare the full key set and exact body hashes, using ETag as an additional signal only. Block dependent work on any addition, removal or content change.

After each changed PUT, perform a fresh GET and exact verification.

Add only two representative focused race tests: one changed child-key set and one changed child body. Reuse the same guard for connector and day writes. Run only the focused executor tests, node --check and git diff --check.

Do not perform a real write in this phase. Do not deploy, commit, stage or push.

Update the Phase 6 record and stop.
```

## Phase 6 implementation record

**Status: implementation complete; no real write was performed.**

Every changed staged connector or day parent proposal now carries the complete
child snapshot from which it was built: child prefix, expected full key set,
exact SHA-256 body hash for every child, and the original ETag when a stable
live ETag exists. Immediately before that parent PUT, the shared guard:

```text
freshly LISTs the complete child prefix
freshly GETs and strictly validates every listed child
compares the complete sorted key set
compares every exact body SHA-256
compares ETag only as an additional signal when available
```

Any added/removed child, body change, or available ETag change throws a
`Blocked dependency` error before the parent PUT. Throwing stops the staged
application loop, so dependent day and index proposals are not written. A
staged child that is written earlier in the same run is compared by its exact
proposed body; it deliberately has no predicted remote ETag.

Changed PUTs continue to perform a fresh GET and require exact byte length and
body equality before reporting verification success.

Added only the two required representative focused races:

```text
new pollutant child appears before connector parent write
changed connector child body appears before day parent write
```

The first proves no connector/day write occurs. The second proves the already
independent connector may write, but the changed day child blocks the day and
all dependent work.

Validation:

```text
node --test tests/uk_aq_phase_3_repair_executor.test.mjs
9 tests passed, including both Phase 6 races.

node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
git diff --check
Passed.
```

No R2 endpoint, LIVE environment, real write, deployment, SQL, backfill,
runtime-file copy, commit, stage, push, branch, or tag operation occurred.

---

# Phase 7: status propagation, exit codes and standalone utility hardening

## Goal

Make repair outcomes reliable for humans and shell callers.

## Required implementation

Ensure connector, day, index, latest, metadata and verification outcomes participate in scope and top-level status.

Supported statuses remain:

```text
planned
executing
skipped_unchanged
succeeded
failed
blocked_dependency
not_run
```

Blocked or failed generic index work must produce a non-zero process exit.

The standalone day-manifest utility must use the shared strict child validator.

## Proportionate local checks

Use focused tests for only these critical cases:

```text
index-only success or blocked result controls final status
blocked generic index command exits non-zero
standalone utility rejects one structurally invalid child
```

Run shell syntax where changed, Node syntax and `git diff --check`.

After Phase 7, run the first milestone suite:

```text
complete Python integrity suite
all focused Phase 3 Node tests
npm run check
```

This replaces running the full suites after Phases 5 and 6.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and implement Phase 7 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1202.md

Do not search or modify archive/ and do not contact real R2.

Correct status propagation so index/latest/metadata and verification outcomes control scope and top-level results. Make blocked or failed generic index work return ok=false and a non-zero process exit. Reuse the strict shared child validator in the standalone day-manifest utility.

Add only the three focused safety tests listed in the plan. Run syntax checks and git diff --check.

Because this is the first implementation milestone, then run the complete Python integrity suite, all focused Phase 3 Node tests and npm run check once.

Do not deploy, commit, stage or push.

Update the Phase 7 implementation record and stop.
```

## Phase 7 implementation record

**Status: implementation complete; local mocked tests only.**

The Phase 3 executor now reduces connector, day, targeted index, latest-index,
timeseries-metadata, and per-object verification outcomes into each day scope
and the top-level result. `blocked_dependency` and `failed` take precedence,
set `ok: false`, and cause the executor command to return a non-zero exit.
Index-only work therefore cannot be reported as an unrelated skipped day.

The generic index command now detects blocked/failed status and count fields in
the returned rebuild summary, returns `ok: false`, prints its normal JSON
result, and sets its process exit code to `1` for shell callers.

V2 observations child-manifest validation is now shared by the Phase 3
executor and the standalone day-manifest utility. It verifies the manifest
version, domain, kind, key, day, connector where applicable, canonical hash,
required child arrays, and aggregate fields before any parent manifest is
constructed. The standalone utility applies this strict contract only to its
v2 observations connector children; existing v1 and AQI layouts are unchanged.

Added only the three required focused safety tests:

```text
blocked index-only outcome controls scope and top-level executor result
blocked generic index command returns ok=false and exits non-zero
a hash-valid but structurally incomplete v2 connector child is rejected by the standalone utility
```

Validation:

```text
node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
node --check scripts/backup_r2/uk_aq_build_r2_history_index.mjs
node --check scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs
node --check scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs
node --test tests/uk_aq_phase_3_repair_executor.test.mjs \
  tests/uk_aq_r2_history_index.test.mjs \
  tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs
42 passed, 0 failed.

python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
252 tests passed.

node --test tests/uk_aq_phase_3_repair_executor.test.mjs \
  tests/uk_aq_phase_3a_writer_contract.test.mjs \
  tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs \
  tests/uk_aq_r2_history_index.test.mjs
46 passed, 0 failed.

npm run check
git diff --check
Passed.
```

The Python suite emitted its existing deliberately-invalid parser fixture,
mocked repair diagnostics, and SQLite `ResourceWarning` messages; it still
completed `OK`. No archive path was searched or modified, and no real R2,
LIVE environment, deployment, SQL, backfill, runtime-file copy, commit, stage,
push, branch, or tag operation occurred.

---

# Phase 8: convert current integrity to v2-only and consolidate v2 write paths

## Goal

Make the current integrity codebase unambiguously v2-only and give every reachable v2 write one authoritative owner.

This phase must both analyse and implement the current v2 architecture. It must not stop after producing an inventory when a clear code change is needed.

## Phase 8A: convert the current core snapshot dependency to v2

The authoritative current core snapshot path is:

```text
R2_history_backup/history/v2/core
```

Inspect all current, non-archive references to:

```text
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
core snapshot paths
core snapshot preflight
core snapshot fixtures
core snapshot documentation
```

Required outcome:

```text
CIC-Test.env.example uses CIC-Test/R2_history_backup/history/v2/core
LIVE.env.example uses LIVE/R2_history_backup/history/v2/core
current Python and shell preflight expects the v2 core directory
current tests and fixtures create or expect a v2 core path
current documentation and active plans describe the v2 core path
the ignored local CIC-Test.env is reported for correction without printing secrets
no current integrity fallback silently chooses a legacy core directory
```

Do not merely replace a string. Confirm that the current core snapshot importer
can read the v2 core manifest and table layout. If the v2 core schema differs,
make the narrow importer adaptation required for the current integrity system.

Do not create missing Dropbox directories and do not copy data between core
versions. The real directory is checked later in Phase 11.

## Phase 8B: remove or reject current v1 integrity behaviour

Inspect current, non-archive integrity-specific code for:

```text
--history-version v1
--history-version both
checked_versions containing v1
v1 integrity validation branches
v1 repair-plan branches
v1 repair execution
v1/v2 comparison reporting
v1-only current integrity tests
current docs or env examples promising v1 support
```

Required outcome:

```text
the current integrity launcher and Python entrypoint run v2 only
v1 and both are rejected clearly before scanning or repair work
or the history-version option is removed and v2 becomes implicit
current reports declare v2 only
current repair planning and execution accept v2 only
current integrity tests and docs describe v2 only
```

Choose the smallest clear interface:

### Preferred option

Keep:

```text
--history-version v2
```

temporarily for explicitness, but reject `v1` and `both` at argument parsing.

A later cleanup may remove the argument entirely once all operational commands are updated.

Do not preserve current v1 integrity behaviour for compatibility.

## Phase 8C: inventory only the reachable v2 write paths

Trace every current v2 write path reachable through:

```text
--run-backfill
```

Inspect:

```text
scripts/uk-aq-history-integrity
scripts/uk_aq_backfill_local.sh
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
scripts/backup_r2
relevant current workers and shared helpers in uk-aq-ops
```

Do not inspect or modify the ingest repository.

For every reachable v2 path, record:

```text
entrypoint and caller
observation or AQI domain
data, manifest or index write
trigger and repair-plan evidence
target keys or tables
environment and bucket gate
dependency ordering
fresh verification
status and exit propagation
current focused tests
```

## Decision requirement for each v2 path

Choose and implement one of:

### 1. Retain as an authoritative specialist writer under the v2 orchestrator

Use this when the writer is already the correct implementation for its data product.

Typical candidates:

```text
source-to-v2-observation backfill writer
Phase 3 v2 observation manifest/index executor
v2 AQI hourly rebuild writer
post-repair v2 integrity checker
```

The specialist writer may remain separate, but only one v2 orchestration path should decide when it runs.

### 2. Refactor behind the single v2 repair orchestrator

Use this when a useful writer has multiple independent callers or when ordering is currently split across Python, shell and Node.

The target control flow is:

```text
v2 integrity checker
→ non-executing v2 repair plan
→ one v2 repair orchestrator
    → observation data writer when required
    → verified Phase 3 manifest/index executor
    → AQI rebuild only after verified observation prerequisites
    → mandatory post-repair v2 integrity check
```

“Single orchestrator” means one control plane, not one monolithic writer.

### 3. Temporarily disable the v2 route

Use this when the current path is reachable but does not yet have a safe evidence, gate, ordering or verification contract.

Disable only the unsafe v2 route. Keep read-only checking available.

### 4. Remove the v2 route as duplicate or obsolete

Use this when another authoritative writer fully replaces it and no current caller requires it.

## Treatment of v1 paths found during the audit

For integrity-specific v1 paths:

```text
remove them
or reject them at the current entrypoint
or delete unreachable v1-only helpers and tests
```

Do not retain them merely because they worked previously.

For mixed shared utilities used outside integrity:

```text
leave the generic v1 capability intact when current non-integrity callers exist
remove only the current integrity caller or v1 branch
document the shared utility as outside the current integrity support contract
```

Do not spend time validating v1 outputs.

## Required implementation outcome

At the end of Phase 8:

```text
the current integrity core snapshot dependency uses history/v2/core
the current integrity CLI is v2-only
no reachable current integrity v1 or both mode remains
every reachable v2 write has one recorded owner
duplicate v2 orchestration routes are removed or gated
AQI cannot run before required observation repair verification
manifest/index finalisation uses the authoritative Phase 3 executor
post-repair v2 verification is mandatory
```

If the existing `--run-backfill` orchestration can be safely consolidated with narrow changes, implement them now.

If a path would require a large redesign, temporarily disable that unsafe v2 path now and record the later redesign separately. Do not leave it reachable merely because a future plan might fix it.

## Proportionate local checks

Run only focused checks for actual changed boundaries:

```text
one parser or launcher test proving v1 and both are rejected
one orchestration-order test if write ordering changes
one gate test for any temporarily disabled route
syntax checks for changed files
git diff --check
```

Do not run the full suites in this phase.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete v2-only blockers plan and perform Phase 8 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md

Work only in TEST-uk-aq/uk-aq-ops on main.

Do not search or modify archive/. Do not inspect the ingest repository.

The current history-integrity system is now v2 only. An older codebase can be used separately for v1 if ever required.

First convert the current core snapshot dependency to:

R2_history_backup/history/v2/core

Update the tracked CIC-Test and LIVE env templates, current preflight logic, tests, fixtures, documentation and active plans. Confirm the importer reads the actual v2 core manifest/table layout rather than assuming the legacy layout. Inspect an ignored local CIC-Test.env only for the relevant non-secret path and report whether it needs correction; do not print secrets. Do not create Dropbox directories or copy core data.

Then convert the current integrity surface to v2 only:

- reject --history-version v1 and --history-version both before any scan or repair work, or remove the option and make v2 implicit if that is clearly smaller;
- remove current integrity-specific v1 validation, planning, execution, comparison, documentation and tests where they are no longer reachable or useful;
- do not preserve v1 behaviour for compatibility;
- do not delete generic shared v1 support that still has current non-integrity callers.

Then trace every v2 write-capable path reachable through --run-backfill across the current integrity Python, shell wrappers, local backfill script, backup_r2 utilities and relevant ops workers/shared helpers.

For each v2 path, implement one decision:

- retain as an authoritative specialist writer under one v2 orchestrator;
- refactor behind that orchestrator;
- temporarily disable the unsafe v2 route;
- remove it as duplicate or obsolete.

The target order is:

v2 repair plan
→ observation data repair when required
→ verify observation repair
→ authoritative Phase 3 manifest/index finalisation
→ AQI rebuild only when eligible and dependencies succeeded
→ mandatory post-repair v2 integrity check.

Do not create a second overlapping repair architecture.

Update the authoritative master plan with a decision table naming every reachable v2 writer, caller, owner, gate, verification and final decision.

Use only focused tests for actual changed safety boundaries, syntax checks and git diff --check. Do not run full suites.

Do not contact R2, run integrity, run a backfill, deploy, apply SQL, commit, stage or push.

Update the Phase 8 record and stop.
```

## Phase 8 implementation record

Status:

```text
Implementation complete; runtime acceptance is pending Phase 11.
```

Implemented v2-only core contract:

```text
- CIC-Test and LIVE templates now set UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2
  and UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT under R2_history_backup/history/v2/core.
- The integrity resolver accepts only v2 and rejects a legacy explicit core
  root instead of silently rewriting or falling back to it.
- Preflight reports a clear v2-core configuration error before source scans.
- The importer now validates the actual v2 core writer manifest contract:
  schema_name=uk_aq_core_snapshot, schema_version=1, prefix=history/v2/core,
  matching day/key/relative-path layout, SHA-256, row counts, and the required
  connectors, stations, timeseries, phenomena, and observed_property_mappings
  tables. The focused fixture is shaped from uk_aq_core_snapshot_to_r2.mjs.
```

The ignored local `scripts/uk-aq-history-integrity/env/CIC-Test.env` exists but
does not declare `UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT`; it needs the non-secret
v2 path from the tracked CIC-Test template before Phase 11. No local Dropbox
directory was created and no core data was copied.

Implemented v2-only surface and write-route consolidation:

```text
- --history-version accepts v2 only; v1 and both fail in argparse before
  preflight, scan, repair planning, or repair execution.
- Reports now declare only history_version_mode=v2, checked_versions=[v2],
  one v2 path configuration, and one v2 result.
- Removed the reachable v1 cross-check/comparison branch and the legacy
  cross-check/AQI health calls from the current entrypoint.
- --run-backfill is rejected by both launcher and Python parser; the direct
  integrity backfill wrapper exits 2. This disables every overlapping current
  integrity v2 data/AQI write path pending a single orchestrator.
- The Phase 3 executor remains the authoritative v2 observation
  manifest/index finaliser. Generic local backfill and index utilities remain
  available to non-integrity callers and retain their own shared v1 support.
- The authoritative master plan records each reachable writer, caller, owner,
  gate, verification requirement, and final decision.
```

Current documentation now describes the v2-only core root, rejected legacy
history modes, and disabled integrity writer route. Detailed old backfill text
is explicitly historical rather than current runtime guidance.

Focused validation:

```text
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_preflight.py \
  scripts/uk-aq-history-integrity/tests/test_history_version_paths.py -v
Passed after the v2-only fixture correction.

python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
bash -n scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
bash -n scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
Passed.
```

No archive path was searched or modified. No integrity run, backfill, R2 or
LIVE contact, deployment, SQL, runtime copy, commit, stage, or push occurred.

---

# Phase 9: correct v2 AQI grain-aware completeness rules

## Goal

Replace invalid raw observation-row-to-AQI-row comparisons with the authoritative v2 hourly AQI writer contract.

## Required analysis

Inspect the authoritative v2 AQI hourly writer and calculation code in `uk-aq-ops`.

Confirm:

```text
UTC hour key
AQI-eligible pollutants
minimum valid input requirements
missing and invalid hour handling
expected output per valid hour
```

Do not infer the rule from the current integrity checker or from v1 behaviour.

## Required implementation

Update both current v2 integrity entrypoints:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

Use shared or equivalent v2 grain-aware expected-hour logic.

Do not trigger AQI repair merely because raw observation row count exceeds AQI row count.

Remove or rewrite any current tests that encode raw-row parity or v1 expectations.

## Proportionate local checks

Keep only three representative v2 cases:

```text
288 five-minute observations with 24 valid AQI hours is healthy
one expected AQI hour missing is detected
an ineligible pollutant is not treated as missing AQI
```

Run:

```text
the focused v2 AQI tests
py_compile for changed Python files
git diff --check
```

Do not run a real CIC-Test check in this phase. The real short-range v2 AQI run is part of Phase 11.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete v2-only blockers plan and implement Phase 9 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md

Work only in TEST-uk-aq/uk-aq-ops on main.

Do not search or modify archive/ and do not inspect the ingest repository.

Inspect the authoritative v2 hourly AQI writer and calculation contract in uk-aq-ops. Confirm the UTC hour identity, eligible pollutants, minimum valid inputs, invalid/missing-hour handling and expected output per valid hour.

Replace raw observation-row-to-AQI-row completeness checks in both current integrity entrypoints with expected-hour logic.

Do not derive behaviour from v1 code. Remove or rewrite current tests that preserve v1 or raw-row-parity expectations.

Retain only these representative regressions:

- 288 five-minute observations and 24 valid AQI hours is healthy;
- one expected AQI hour missing is detected;
- an ineligible pollutant is not treated as missing AQI.

Run only the focused v2 AQI tests, Python syntax checks and git diff --check.

Do not run the real integrity checker yet. Real v2 AQI acceptance is deferred to Phase 11.

Do not contact R2, run a backfill, deploy, apply SQL, commit, stage or push.

Update the Phase 9 record and stop.
```

## Phase 9 implementation record

Status:

```text
Implementation complete; real v2 AQI acceptance is deferred to Phase 11.
```

Authoritative writer contract confirmed from the current v2 AQI writer:

```text
- `lib/aqi/aqi_levels.mjs` normalises each accepted observation timestamp to
  the containing UTC hour and groups by `(timeseries_id, UTC hour)`.
- The supported AQI pollutants are exactly no2, pm25 and pm10. O3 is not an
  AQI output pollutant.
- Only finite, non-negative source values form an hourly input. Invalid,
  missing or unsupported source rows do not create an expected AQI hour.
- One valid source hour produces one hourly AQI record. NO2 has one valid
  hourly input; PM EAQI has one valid hourly input while PM DAQI requires 24
  hourly inputs. A PM DAQI `insufficient_samples` result does not suppress the
  hourly AQI record.
```

Implemented expected-hour completeness in both current entrypoints:

```text
- `uk-aq-history-integrity.py` now reads actual parquet timestamps and valid
  source values, compares expected and actual UTC-hour identities, and emits
  `aqi_expected_hours_missing` only for missing expected output hours.
- `uk-aq-aqi-gap-check.py` now groups valid source rows and AQI rows by UTC
  hour. It reports `missing_expected_aqi_hours`, never a raw source-row versus
  AQI-row deficit.
- Retired raw-parity gap names and fixtures were rewritten. Current
  documentation describes hourly identity checking and the O3 exclusion.
```

Focused validation:

```text
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_aqi_hourly_completeness.py -v
Passed: 3 tests.

python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
Passed.
```

The focused tests prove:

```text
- 288 five-minute observations and 24 valid AQI hours are healthy;
- one missing expected AQI hour is detected; and
- O3 is not treated as missing AQI.
```

No archive path was searched or modified. No real integrity check, R2 or LIVE
contact, backfill, deployment, SQL, commit, stage, or push occurred. Phase 11
must run the real short-range CIC-Test v2 AQI acceptance check.

---

# Phase 10: final proportionate v2-only local validation

## Goal

Validate the completed v2-only current integrity code once before the combined real CIC-Test acceptance.

## Required validation

Run the current integrity Python suite once after v1-only tests have been removed or rewritten:

```bash
python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q
```

Run the focused Phase 3 v2 Node test files:

```text
tests/uk_aq_phase_3_repair_executor.test.mjs
tests/uk_aq_phase_3a_writer_contract.test.mjs
tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs
tests/uk_aq_r2_history_index.test.mjs
```

Also run:

```text
py_compile for changed Python files
node --check for changed Node files
bash -n for changed shell/env files
npm run check
git diff --check
```

Do not add tests merely to increase totals.

## Required v2-only review

Confirm:

```text
current integrity accepts or defaults to v2 only
v1 and both modes are rejected before work starts
no current integrity documentation promises v1 support
no current integrity repair plan or executor accepts v1
no current integrity test requires v1 compatibility
every reachable v2 write has one owner
unsafe duplicate v2 routes are removed or disabled
AQI completeness uses the v2 hourly contract
canonical SQL test reads uk-aq-schema directly
R2 mirror env paths use R2_history_backup
all current core snapshot references use R2_history_backup/history/v2/core
the v2 core importer contract is covered by a focused current test
no current integrity fallback points at a legacy core directory
no archive file changed
```

Do not run integrity or contact R2 in this phase.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete v2-only blockers plan and perform Phase 10 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md

Do not search or modify archive/.

Run the current integrity Python suite once, the four focused Phase 3 v2 Node test files, syntax checks for changed files, npm run check and git diff --check.

Do not add tests merely to increase coverage or totals.

Confirm that the current integrity launcher, parser, reports, plans, tests and repair paths are v2 only. Confirm v1 and both are rejected before scan or repair work.

Confirm every current core snapshot configuration, fixture and preflight uses R2_history_backup/history/v2/core and that the importer is compatible with the v2 core manifest/table layout.

Review the Phase 8 v2 writer ownership table and confirm no duplicate reachable v2 orchestration remains.

Confirm the Phase 9 AQI logic is based on expected v2 hourly output rather than raw observation-row parity.

Do not run integrity, contact R2, run a backfill, deploy, apply SQL, commit, stage or push.

Update the Phase 10 record and stop.
```

## Phase 10 implementation record

Status: **Incomplete.** The required Node, syntax, npm and diff checks passed,
but the required full current integrity Python-suite run has 10 failures.

Validation completed:

- `python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q`: 231 tests run; 10 failures.
- The four requested Phase 3 Node files: 46 passed.
- `py_compile` for changed integrity Python files/tests, `node --check` for changed Phase 3 Node files, `bash -n` for changed integrity shell files, `npm run check`, and `git diff --check`: passed.

The Python failures are focused follow-up debt from Phase 9, not external or
runtime failures. Older broad AQI repair fixtures provide count-only
pseudo-parquet statistics, while the Phase 9 contract correctly requires real
valid `(timeseries_id, UTC hour)` identities. Those fixtures either do not
establish an expected AQI hour or receive the safe
`aqi_post_rebuild_validation_failed` result. A follow-up must update those
fixtures and stale raw-parity assertions without changing the accepted hourly
contract; Phase 10 made no implementation change.

Failed tests:

```text
test_v2_aqilevels_integrity:
- test_eligible_observation_still_requires_aqi_manifest
- test_v2_aqi_integrity_reports_missing_aqi_against_existing_observations

test_v2_repair_execution:
- test_v2_aqi_rebuild_queue_executes_connector_scoped_rebuild
- test_v2_aqi_post_rebuild_validation_fails_when_manifest_missing_after_obs_repair
- test_v2_aqi_post_rebuild_validation_fails_when_rows_below_observations
- test_v2_aqi_post_rebuild_validation_passes_with_manifest_rows_covering_pm_observations
- test_v2_aqi_post_rebuild_validation_resolves_dropbox_root_and_dir_without_absolute_root
- test_v2_aqi_integrity_gap_queues_and_executes_aqi_only_rebuild
- test_v2_aqi_integrity_reason_gets_post_rebuild_validation
- test_v2_observation_then_aqi_queue_executes_r2_rebuild_after_rows_written
```

V2-only review:

```text
- The active launcher and Python parser accept/default only v2. argparse
  rejects v1 and both before preflight, scan, planning or repair work, and
  --run-backfill is rejected at the same boundary.
- The direct historical integrity backfill wrapper exits 2 before any source,
  R2 or repair action. Its unreachable legacy argument-handling block still
  names v1; it cannot execute v1 work and should be removed in the focused
  fixture follow-up.
- Current integrity templates, preflight and focused importer tests use
  R2_history_backup/history/v2/core. The importer validates the v2 core
  manifest/table layout: uk_aq_core_snapshot, schema version 1, v2 prefix,
  required table artifacts, keys, hashes and row counts.
- The Phase 8 ownership table remains valid: Phase 3 is the sole current
  manifest/index finaliser; current integrity observation and AQI write routes
  are disabled; generic v1/v2 tools are non-integrity callers.
- Phase 9 compares valid supported-pollutant UTC-hour identities and does not
  use raw observation-row-to-AQI-row parity.
```

No archive path was searched or modified. No integrity command, R2 or LIVE
contact, backfill, deployment, SQL, commit, stage, or push occurred.

---

# Phase 11: combined real v2 CIC-Test acceptance and operational handoff

## Goal

Run the complete real v2 acceptance sequence after all code and analysis work is finished.

This phase combines:

```text
real v2 DuckDB integrity scan
real v2 Phase 3 dry-run
approved scoped v2 O3 write
post-write v2 verification
v2 AQI hourly-grain acceptance
```

## Step 1: local environment and mirror preflight

Use the ignored local:

```text
scripts/uk-aq-history-integrity/env/CIC-Test.env
```

It must use:

```text
UK_AQ_ENV_NAME=CIC-Test
UK_AQ_R2_HISTORY_DROPBOX_ROOT=/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT=/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core
UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED=false
```

Confirm these existing directories without creating them:

```text
CIC-Test/R2_history_backup
CIC-Test/R2_history_backup/history/v2/core
CIC-Test/R2_history_backup/history/v2/observations
```

Do not print secrets.

## Step 2: generate a current one-day v2 integrity report

Run:

```bash
"/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh" \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-05-17 \
  --to-day 2026-05-17 \
  --history-version v2 \
  --check-only \
  --concurrency 1 \
  --verbose
```

Do not add `--run-backfill`.

If Phase 8 removes the `--history-version` option, use the equivalent v2-only command documented by Phase 8.

Inspect the new report and confirm:

```text
the report is v2 only
history_version_results.v2.observations.repair_plan exists
the expected O3 hierarchy/index action is present
O3 does not require observation data repair
O3 does not queue AQI
all actions are listed before proceeding
```

If the report contains unsupported observation data-repair or operator-review actions, stop before the executor and report them. Do not manually edit the JSON.

## Step 3: run the real v2 Phase 3 dry-run

Use the newly generated report:

```bash
node scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs \
  --repair-plan-json "/path/to/new-summary.json"
```

No `--write-r2`.

Review:

```text
environment CIC-Test
bucket uk-aq-history-cic-test
every proposed key
old and new hashes
changed and unchanged results
dependencies
expected verification
zero PUT
zero DELETE
no parquet key
no AQI key
all sibling pollutants preserved
all sibling connectors preserved
one connector proposal for the O3 scope
one day proposal
required v2 observation index/latest/metadata proposals only
```

## Step 4: approval boundary

Stop and ask the user for explicit approval.

Do not continue automatically to `--write-r2`.

## Step 5: approved scoped v2 write

After separate explicit approval, run the same executor command with:

```text
--write-r2
```

Required write gate:

```text
UK_AQ_ENV_NAME=CIC-Test
bucket=uk-aq-history-cic-test
```

Inspect fresh verification for every changed object.

## Step 6: post-write v2 integrity and idempotence

Immediately:

1. rerun the same one-day v2 integrity check-only command;
2. confirm the O3 hierarchy/index finding is gone;
3. rerun the same executor repair command;
4. confirm it is an idempotent no-op with no additional changed objects.

## Step 7: real v2 AQI hourly-grain acceptance

Run the corrected v2 checker over a short CIC-Test range containing real multiple-observations-per-hour data.

Confirm:

```text
expected AQI hours are derived using the authoritative v2 hourly contract
healthy 24-hour output is not compared against hundreds of raw observation rows
real missing expected hours remain detectable
ineligible pollutants do not create false AQI gaps
```

No LIVE or v1 run is required.

## Failure policy

If a real run exposes a clear defect:

```text
stop the current write sequence safely
make the smallest correction
add one focused regression for that exact defect
rerun the affected Phase 10 validation
repeat the relevant Phase 11 step
```

Do not add a broad synthetic suite.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete v2-only blockers plan and perform Phase 11 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-v2-only-blockers-remediation-plan-2026-07-13-1235.md

Work only in TEST-uk-aq/uk-aq-ops on main.

Do not search or modify archive/. Do not contact LIVE. Do not run or validate v1.

First inspect only the non-secret CIC-Test env values and confirm the local Dropbox mirror uses R2_history_backup. Confirm the required mirror directories exist. Do not create missing directories.

Run the current one-day CIC-Test manual v2 check-only command for 2026-05-17 with source all, concurrency 1 and no --run-backfill. If Phase 8 removed the history-version option, use the documented equivalent v2-only command.

Inspect the newly generated v2 report and list every observations repair action. Confirm the expected O3 action is manifest/index-only and that no O3 AQI action exists.

If the report is compatible, run the v2 Phase 3 executor dry-run using that exact report. Do not use --write-r2.

Report every proposed key, hash, dependency, changed/unchanged result and verification expectation. Confirm zero PUT/DELETE, no parquet or AQI key, and sibling preservation.

Stop at the approval boundary and request the user's explicit permission for --write-r2.

Only after separate approval, run the scoped CIC-Test write, inspect fresh verification, rerun the one-day v2 integrity check-only command and rerun the repair command to prove idempotence.

Then run the short-range real CIC-Test v2 AQI grain-aware check and report expected versus actual hourly evidence.

If a real run exposes a clear defect, make only the smallest correction and one focused regression for that defect, rerun the affected local validation, and repeat the failed real step.

Do not deploy SQL, commit, stage or push.

Update the authoritative master status, the Phase 11 record and the final blocker checklist, then stop.
```

---

# 7. Runtime approval gates

## Gate 1: combined read-only v2 acceptance

Performed in Phase 11 before any write.

Permitted:

```text
source and Dropbox reads
DuckDB parquet reads
local SQLite/log/report writes
CIC-Test R2 LIST/HEAD/GET during executor dry-run
complete proposed v2 repair output
```

Forbidden:

```text
R2 PUT
R2 DELETE
backfill
AQI rebuild execution
v1 execution
LIVE access
```

## Gate 2: scoped v2 Phase 3 CIC-Test write

Permitted only after the user reviews Gate 1 and explicitly approves.

Required:

```text
UK_AQ_ENV_NAME=CIC-Test
bucket=uk-aq-history-cic-test
supported scoped v2 action from the current integrity report
--write-r2
```

## Gate 3: post-write v2 verification

Required immediately after Gate 2:

```text
fresh object verification
one-day v2 integrity check-only rerun
same v2 executor command rerun as idempotent no-op
```

## Gate 4: real v2 AQI hourly-grain check

Performed after Phase 9 code and Phase 10 local validation.

This is read-only with respect to repair systems:

```text
no --run-backfill
no AQI rebuild execution
no R2 PUT or DELETE
```

## Gate 5: LIVE and v1

Not authorised or required by this plan.

---

# 8. Completion criteria for the v2-only blocker plan

```text
[x] canonical SQL test reads uk-aq-schema directly
[x] plans have one authoritative status table
[x] current ops checkout and mirror-root paths are corrected
[x] local Dropbox mirror roots use R2_history_backup
[x] current integrity core snapshot paths use R2_history_backup/history/v2/core
[x] the current importer and focused tests use the v2 core manifest/table layout
[x] no current non-archive integrity fallback points at a legacy core directory
[x] Phase 3 executor accepts the current complete v2 integrity-report contract locally
[x] dual CIC-Test environment/bucket gate is enforced
[x] Phase 3 dry-run constructs the complete staged v2 hierarchy locally
[x] parent writes re-list and re-read complete child sets
[x] multi-connector day work produces one day/index update
[x] index and verification outcomes control status and exit codes
[x] standalone v2 observation parent utility strictly validates children
[x] current integrity CLI and reports are v2 only
[x] v1 and both modes are removed or rejected before work begins
[x] current integrity-specific v1 branches, tests and documentation are removed or unreachable behind the v2-only entrypoint
[x] every reachable v2 write path has one authoritative owner
[x] duplicate or unsafe v2 write routes are removed, refactored or disabled
[x] AQI cannot run before required observation verification (current integrity has no write route)
[x] post-repair v2 integrity verification is mandatory for the future single writer sequence; no current integrity command can skip it
[x] v2 AQI completeness is hourly-grain aware
[ ] final proportionate v2-only local suites and syntax checks pass
[ ] current one-day real v2 DuckDB report is generated successfully
[ ] real v2 Phase 3 dry-run shows expected keys and zero writes
[ ] user explicitly approves the scoped CIC-Test write
[ ] scoped real v2 O3 CIC-Test write succeeds
[ ] post-write v2 integrity confirms the O3 fault is fixed
[ ] repeated v2 repair is an idempotent no-op
[ ] real CIC-Test v2 AQI check no longer reports raw-row-parity false positives
[ ] no archive file changed
[ ] no LIVE mutation occurred
[ ] no v1 runtime acceptance was required
```

---

# 9. Recommended model summary

Use:

```text
GPT-5.6 Terra
Reasoning: High
```

for Phases 8 to 11.

Phase 8 now includes the v2 core snapshot conversion, the v2-only integrity conversion, and consolidation of Python, shell, Node and worker write paths. Phase 9 must derive integrity expectations from the authoritative v2 AQI writer. Phase 11 interprets real v2 R2 hierarchy and verification evidence.

Use focused local tests while implementing. Use the combined real v2 CIC-Test run as the primary integration proof.

Do not preserve v1 compatibility in the current integrity system. Leave genuinely shared non-integrity v1 utilities alone only where current external callers still need them.
