# UK-AQ History Integrity Blockers and Remediation Plan

Generated: 13/07/2026  
Repository: `TEST-uk-aq/uk-aq-ops`  
Branch: `main`

Plan filename:

```text
uk-aq-history-integrity-blockers-remediation-plan-2026-07-13.md
```

Recommended repository location:

```text
uk-aq-ops/plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13.md
```

---

# 1. Purpose

This plan consolidates the remaining blockers found during the audit of:

```text
uk-aq-ops/plans/2026-07-12 Integrity
uk-aq-ops/scripts/uk-aq-history-integrity
```

It is intended to bring the plans, checker, repair executor, tests, runtime deployment model and existing write-capable integrity paths into one coherent safety model.

The work must be performed in controlled phases. Codex must independently confirm each finding against the current `main` branch before changing code.

The plan does not authorise:

```text
R2 writes
CIC-Test repair execution
LIVE repair execution
SQL deployment
runtime deployment
commits
staging
pushing
pull requests
```

unless the user separately instructs Codex to perform one of those actions.

---

# 2. Repository and archive rules

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

---

# 3. Authoritative status before remediation

| Area | Current audited status |
| --- | --- |
| Phase 1 backup gate | Implementation substantially complete, but the canonical SQL test and plan wording are inconsistent with the deleted ops SQL mirror |
| Phase 2 read-only validation | Local implementation substantially complete; real DuckDB runtime validation remains pending |
| Phase 3 manifest and index repair | In progress; implementation has unresolved safety, planning, execution-order and status-propagation blockers |
| Phase 4 observation and AQI repair | Plan says not started, but existing `--run-backfill` code already implements overlapping write-capable behaviour |
| Plans and documentation | Multiple contradictory status records and stale runtime paths |
| Runtime deployment model | Launcher and Python deployment are documented, but the Phase 3 Node dependency bundle is not defined clearly |

---

# 4. Confirmed blockers to resolve

Codex must re-confirm these against current `main` before editing.

## Blocker A: canonical readiness SQL test points at a deleted ops mirror

The ops SQL mirror was deleted:

```text
scripts/uk-aq-history-integrity/sql/uk_aq_rpc_daily_task_backup_readiness.sql
```

The current test still expects that file and compares it with the canonical schema file.

Required outcome:

```text
The test reads the canonical file directly from TEST-uk-aq/uk-aq-schema.
The test does not require or recreate an ops SQL mirror.
The master plan no longer requires two SQL copies to remain identical.
The schema repository remains read-only.
```

Expected canonical path, subject to repository confirmation:

```text
../TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql
```

The test should locate the sibling repository robustly and fail with a clear message if the canonical file is unavailable.

## Blocker B: Phase 2 runtime acceptance is still pending

The Python checker now depends on the real `duckdb` package for complete v2 validation.

Local mocked tests are not a replacement for a real check against the CIC-Test Dropbox history mirror.

Required runtime acceptance case:

```text
environment: CIC-Test
profile: manual
history version: v2
day: 2026-05-17
mode: check-only
run-backfill: absent
```

The acceptance run must confirm:

```text
real DuckDB parquet reads occur
the O3 hierarchy fault is detected correctly
valid O3 parquet is not classified as requiring data repair
O3 does not plan AQI work
the repair plan is deterministic and non-executing
no R2 writes occur
no backfill command is executed
reports are created successfully
```

## Blocker C: Phase 3 write gate is incomplete

The dedicated Phase 3 executor must require both:

```text
UK_AQ_ENV_NAME=CIC-Test
configured R2 bucket=uk-aq-history-cic-test
```

Neither condition alone is sufficient.

Required rejection cases:

```text
LIVE + test bucket
CIC-Test + LIVE bucket
LIVE + LIVE bucket
missing environment
missing bucket
```

## Blocker D: Phase 3 dry-run is not an accurate write preview

The dry-run must construct the same proposed object hierarchy as write mode.

Required in-memory order:

```text
proposed pollutant manifest
→ proposed connector manifest
→ proposed day manifest
→ proposed observation indexes
→ proposed latest index and metadata
```

The only difference between dry-run and write mode should be whether remote PUT operations occur.

A dry-run must not build a proposed day parent from the stale live connector when a proposed connector replacement already exists in memory.

## Blocker E: parent writes do not re-list the complete child set immediately before PUT

Before every connector or day parent write, the executor must:

```text
freshly list the complete child prefix
compare the complete child-key set with the planned set
freshly read every required child
compare ETag where available
compare exact body hash as a fallback and verification mechanism
block if any child is added, removed or changed
```

HEAD-checking only the originally known children is insufficient because it cannot detect a new sibling.

## Blocker F: execution order is wrong when several connectors on one day need repair

The current safe target order is:

```text
all required pollutant or connector repairs for one day
→ one complete day-manifest rebuild
→ one targeted observation index rebuild
→ one verification stage
```

The executor must not repeatedly write the day and indexes after each individual connector.

## Blocker G: index execution is omitted from scope and top-level status

Index results must participate in:

```text
changed
status
blocked_dependency
failed
succeeded
verification
overall result
exit code
```

An index-only scope must not be reported as `skipped_unchanged` when the index was written, blocked or failed.

## Blocker H: blocked generic index work can return shell success

The generic index CLI must return non-zero when its structured result is:

```text
failed
blocked_dependency
verification_failed
invalid_input
```

It must not return `ok=true` for a blocked operation.

Shell wrappers must be able to trust the exit code.

## Blocker I: the O3 Phase 3 test does not use the real action contract

The real O3 acceptance case requires an observation index rebuild.

The test must use the real repair-plan shape produced by the integrity checker, including:

```text
requires_index_rebuild=true
```

It must prove:

```text
O3 parquet is untouched
all sibling pollutants are preserved
all sibling connectors are preserved
connector parent is rebuilt once
day parent is rebuilt once
O3 observation index is rebuilt
relevant latest index and metadata are refreshed
AQI is not queued or written
a second run is idempotent
```

## Blocker J: the standalone day-manifest repair utility does not fully validate children

Before using a connector child to rebuild a day parent, validate:

```text
manifest_kind
history_version
domain
day_utc
connector_id
manifest key/path
stored manifest hash
required arrays and aggregate fields
```

The utility should reuse a shared strict validator rather than maintain a weaker parallel contract.

## Blocker K: no deterministic integrity-report to Phase 3 executor handoff

The executor must accept either:

```text
the complete integrity JSON report directly
```

or:

```text
a normalised repair plan produced by a read-only exporter
```

Manual invention or editing of repair action JSON is not acceptable.

The handoff must:

```text
select only v2 observation Phase 3 action kinds
reject AQI actions
reject observation data-repair actions
reject operator-review actions
reject v1 actions
deduplicate scopes deterministically
preserve contributing gap types
preserve requires_index_rebuild
```

## Blocker L: Phase 4 is already partly implemented outside the new phased contract

The main integrity checker already contains write-capable paths reached through:

```text
--run-backfill
```

These include some combination of:

```text
source-driven observation repair
manifest/index follow-up
AQI rebuild queueing
AQI execution
post-repair rechecks
```

The Phase 4 plan currently says `Not started`, which is inaccurate.

Every existing v2 write-capable path must be inventoried and classified before additional Phase 4 code is added.

## Blocker M: AQI completeness uses invalid raw row-count parity

The current code can treat:

```text
aqi_rows < observation_rows
```

as evidence that AQI is stale or partial.

Observation history and AQI history have different grains. AQI is hourly, while observations may contain many measurements per hour.

The completeness check must become grain-aware.

Possible correct evidence includes:

```text
expected UTC hour buckets derived from observation timestamps
authoritative AQI eligibility rules
minimum valid sample rules used by the AQI writer
expected AQI hour keys versus actual AQI hour keys
AQI parquet versus AQI manifest and index consistency
```

Raw observation-row-to-AQI-row parity must not trigger a rebuild.

## Blocker N: plans contain contradictory status records

Examples include:

```text
Phase 2 marked complete while runtime validation remains pending
Phase 2c subphases marked both not started and complete in different sections
Phase 3 marked in progress in one table and complete in an implementation record
Phase 3 remaining issues still saying "To be updated"
Phase 4 marked not started despite existing write-capable code
```

There must be one authoritative status table.

Recommended authority:

```text
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
```

Other plans should be marked as historical implementation records.

## Blocker O: runtime paths and deployment documentation are stale

The env examples and system documentation still contain old repository paths.

They must reflect the current repository location:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
```

The Phase 3 runtime deployment model must also be explicit.

The executor depends on Node code outside:

```text
scripts/uk-aq-history-integrity/bin/
```

Document either:

```text
run from a complete ops checkout
```

or:

```text
deploy a defined runtime bundle containing every imported Node module
```

Do not document an incomplete manual copy list as a supported runtime installation.

---

# 5. Remediation phases

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

plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13.md

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
| M | **Confirmed.** `uk-aq-aqi-gap-check.py`, `status_for`, classifies `aqi_rows < obs_rows` as `stale_or_partial_aqi_data`; `uk-aq-history-integrity.py` retains `aqi_rows_below_observation_rows` (including `validate_v2_aqilevels_integrity_checks`). | `test_v2_aqilevels_integrity.py`, `test_v2_aqi_integrity_reports_aqi_rows_below_observations`, and `test_v2_repair_execution.py` assert that raw-row parity behaviour. | Authoritative grain-aware expected-hour tests, including 288 five-minute observations/24 valid AQI hours, eligibility and invalid/missing hour cases. | Code, test | Phase 10 |
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
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13.md
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
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13.md
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

Make dry-run and write mode generate the same proposed hierarchy and repair all scopes for a day in one bottom-up transaction plan.

## Required implementation

Build an in-memory staged object map.

For each day:

```text
all selected pollutant-level proposals
all selected connector-level proposals
one day proposal
one targeted index proposal
one latest/metadata proposal set
```

Dry-run must show:

```text
planned keys
old hashes
new hashes
changed or unchanged
dependencies
blocked scopes
expected verification
```

Write mode must use the same proposed bytes.

## Acceptance criteria

```text
dry-run proposed day includes proposed connector content
two connector repairs cause one day rebuild
one index rebuild occurs after all connector work
dry-run performs zero PUT and DELETE requests
write mode changes only the expected observation keys
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 5 only.

Do not contact real R2.

Refactor the Phase 3 executor so dry-run and write mode share one in-memory staged hierarchy.

Group selected actions by day.

For each day:

1. construct every required child or connector proposal;
2. construct one day proposal from the complete proposed connector set;
3. construct one targeted observation index/latest/metadata proposal set;
4. only then perform writes when --write-r2 is present.

Dry-run must output the complete final proposed hierarchy without writing.

Add mocked tests for:

- one connector O3 repair;
- two connector repairs on one day;
- proposed connector feeding proposed day;
- one day write only;
- one index update only;
- zero dry-run writes;
- deterministic byte output;
- unchanged objects skipped.

Do not implement Phase 6 concurrency re-listing yet except where structurally unavoidable.

Run all relevant tests and static checks.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 5 implementation record and stop.
```

## Phase 5 implementation record

**Status: implementation complete; Phase 6 fresh-list concurrency protection
has not been implemented.**

The v2 observations executor now constructs an in-memory staged object map for
each selected day before it performs any real PUT. Connector proposals are
constructed first from the current pollutant children, then one day proposal is
constructed from the staged complete connector set. A single targeted v2
observations index/latest/metadata proposal set is then constructed for that
day, with the staged map visible to the index builder.

The same proposal bytes are used for dry-run and write mode. Dry-run returns:

- grouped day plans and blocked scopes;
- every proposed key, old SHA-256/ETag, new SHA-256, byte count, changed or
  skipped status, dependencies, expected verification, and exact proposed
  body; and
- the one targeted index/latest/metadata result per affected day.

Only after all selected days have been staged does `--write-r2` apply changed
proposals. Unchanged objects are retained in the plan and skipped. The adapter
used for index planning intercepts every staged read, list, HEAD, and PUT, so
the index proposal sees proposed connector/day manifests and no R2 PUT occurs
while planning. It is an in-memory executor-only adapter; production R2 calls
remain unchanged when no adapter is supplied.

For the structurally required index handoff, the shared R2 helpers now support
an optional in-memory adapter and the targeted index function accepts an
optional R2 configuration override. This lets the unchanged index builder
generate its exact proposal set from staged parents; it does not add Phase 6
fresh LIST/GET race checks or concurrency behavior.

Files changed for this phase:

```text
scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
tests/uk_aq_phase_3_repair_executor.test.mjs
workers/shared/r2_sigv4.mjs
workers/shared/uk_aq_r2_history_index.mjs
```

Mocked coverage now proves:

```text
one-connector O3 repair
two connector repairs on one day
proposed connector content feeds the proposed day
one day-manifest write only
one targeted index/latest/metadata proposal set only
zero dry-run PUTs
deterministic proposal bytes
unchanged proposals skipped
```

Validation run:

```text
node --test tests/uk_aq_phase_3_repair_executor.test.mjs
7 tests passed.

node --test tests/uk_aq_r2_history_index.test.mjs
25 tests passed.

python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
252 tests passed. Existing intentional parser/backup-gate diagnostics and
ResourceWarnings were emitted; the suite completed with OK.

node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
node --check workers/shared/r2_sigv4.mjs
node --check workers/shared/uk_aq_r2_history_index.mjs
npm run check
git diff --check
Passed.
```

No real R2 contact, R2 write, delete, backfill, SQL, deployment, runtime-file
copy, archive access, commit, stage, push, branch, or tag operation occurred.

---

# Phase 6: concurrency protection and fresh verification

## Goal

Prevent parent replacement when the live child set or child contents change between planning and writing.

## Required implementation

Immediately before every parent PUT:

```text
fresh LIST complete child prefix
compare complete key set
fresh GET each child
compare exact body hash
compare ETag where available
block on added child
block on removed child
block on changed child
```

After writes:

```text
fresh GET changed object
verify exact body bytes or canonical hash
verify expected content and references
fresh LIST where hierarchy membership matters
```

No stale Dropbox mirror may be used as proof of repair.

## Acceptance criteria

Tests cover:

```text
new sibling appears
existing sibling disappears
existing sibling body changes
ETag unavailable but body changes
requested child disappears
verification body mismatch
verification byte-length mismatch
```

All must block or fail safely.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 6 only.

Do not contact real R2.

Add complete-child concurrency protection to every Phase 3 parent write.

Before connector and day PUT operations:

- freshly list the full child prefix;
- compare the complete key set with the planned set;
- freshly GET all children;
- compare exact body hashes;
- use ETag as an additional identity signal where available;
- block on any addition, removal or content change.

After each changed write, perform fresh remote verification.

Do not use the Dropbox mirror as verification evidence.

Add mocked race tests for every case listed in Phase 6 acceptance criteria.

Ensure blocked dependencies prevent all dependent day and index writes.

Run focused and full tests plus static checks.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 6 implementation record and stop.
```

---

# Phase 7: status propagation, exit codes and standalone utility hardening

## Goal

Make every repair outcome machine-reliable and ensure shell callers cannot mistake blocked work for success.

## Required implementation

Supported statuses:

```text
planned
executing
skipped_unchanged
succeeded
failed
blocked_dependency
not_run
```

Requirements:

```text
index results participate in scope status
index-only work reports correctly
blocked dependencies propagate upward
verification failures propagate upward
overall succeeded requires all required work and verification to succeed
a no-op is not falsely reported as succeeded
blocked or failed generic index CLI exits non-zero
```

Also harden the standalone day-manifest utility with strict shared child validation.

## Acceptance criteria

```text
index-only success
index-only blocked
connector failure blocks day and index
day verification failure blocks index
generic blocked index command exits non-zero
standalone utility rejects wrong-domain and wrong-identity children
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 7 only.

Do not contact real R2.

Correct Phase 3 structured status propagation and CLI exit behaviour.

Include connector, day, index, latest, metadata and verification outcomes in scope and top-level status.

A blocked or failed generic index build must produce ok=false and a non-zero process exit.

A no-op must be reported clearly and must not claim a successful repair.

Refactor the standalone day-manifest repair utility to use strict shared validation for every connector child.

Add mocked and command-level tests proving all Phase 7 acceptance cases.

Run:

- focused Node tests;
- full Python integrity suite;
- node --check on modified .mjs files;
- bash -n on modified shell scripts;
- npm run check;
- git diff --check.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 7 implementation record and stop.
```

---

# Phase 8: real O3 end-to-end mocked acceptance

## Goal

Prove the exact known O3 failure can be repaired safely through the real Phase 2 report and Phase 3 executor contract.

## Required fixture

```text
history version: v2
domain: observations
day: 2026-05-17
connector: 1
pollutant: o3
```

Fixture state:

```text
valid O3 parquet exists
valid O3 pollutant manifest exists
connector manifest omits O3
valid sibling pollutants exist
valid sibling connectors exist
O3 observation index is missing or stale
AQI action is absent
```

## Required assertions

```text
repair input comes from a realistic integrity report fixture
no parquet PUT or DELETE
connector rebuilt once with all siblings
day rebuilt once with all connectors
O3 observation index rebuilt
latest and metadata refreshed where required by the authoritative index builder
fresh verification passes
AQI not queued
second execution is idempotent
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 8 only.

Do not contact real R2.

Create a realistic end-to-end mocked acceptance test for the known O3 case.

The input must be the same complete integrity report shape produced by the Python checker.

The repair action must retain requires_index_rebuild=true.

Use fake R2 state containing:

- valid O3 parquet;
- valid O3 pollutant manifest;
- valid sibling pollutant manifests;
- an incomplete connector parent;
- another valid connector sibling;
- a day parent requiring rebuild;
- a missing or stale O3 observation index.

Assert:

- zero parquet writes;
- zero DELETE requests;
- exact allowed changed keys only;
- connector written once;
- day written once;
- indexes/latest/metadata repaired;
- no AQI action or AQI key;
- fresh verification;
- idempotent second run.

Run all Phase 3 tests and the full repository checks.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 8 implementation record and stop.
```

---

# Phase 9: audit and reconcile existing Phase 4 write-capable paths

## Goal

Inventory all existing observation and AQI write behaviour before implementing any new Phase 4 executor.

## Required analysis

Trace every path reachable through:

```text
--run-backfill
```

Classify:

```text
v1 only
v2 observation data repair
v2 manifest/index follow-up
AQI queue creation
AQI rebuild execution
post-repair validation
legacy compatibility
```

For every v2 path, document:

```text
trigger
input evidence
write target
environment gate
dependency gate
verification
AQI eligibility source
failure propagation
test coverage
```

Decide whether each path should be:

```text
retained and incorporated into Phase 4
temporarily disabled for v2
refactored behind a single executor
removed as obsolete
```

Do not implement new write behaviour in this phase.

## Acceptance criteria

```text
complete write-path inventory
no duplicate Phase 4 architecture
master plan accurately reflects existing code
unsafe v2 execution path identified clearly
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and perform Phase 9 only.

This is an audit phase. Do not add new write behaviour.

Do not search or modify archive/.

Trace every current code path reachable through --run-backfill in:

scripts/uk-aq-history-integrity
scripts/uk_aq_backfill_local.sh
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
relevant workers and shared helpers

Do not inspect the ingest repository.

For each path, classify:

- v1 or v2;
- observation or AQI;
- data, manifest or index write;
- evidence source;
- environment gate;
- dependency gate;
- live verification;
- status propagation;
- tests.

Identify overlap with the planned Phase 4 architecture.

Recommend retain, disable, refactor or remove for each path, but do not implement the recommendation.

Update the master phased plan and the Phase 9 implementation record accurately.

Run read-only tests and static checks only.

Do not contact R2, run a backfill, commit, stage, push, deploy or copy files.

Stop after the inventory.
```

---

# Phase 10: correct AQI grain-aware completeness rules

## Goal

Replace raw observation-row-to-AQI-row comparisons with the real hourly AQI writer contract.

## Required analysis

Inspect the authoritative AQI writer and calculation code in `uk-aq-ops`.

Do not infer the rule from current integrity checks.

Confirm:

```text
AQI hour key
pollutant eligibility
minimum input requirements
handling of missing hours
handling of invalid values
expected number of AQI outputs per valid hour
```

## Required implementation

Update both:

```text
main v2 AQI integrity validation
uk-aq-aqi-gap-check.py
```

Use the same shared or equivalent grain-aware expectation logic.

Do not trigger AQI rebuild merely because raw observation row count exceeds AQI row count.

## Acceptance criteria

Tests include:

```text
288 five-minute observations and 24 valid AQI hours is healthy
missing expected AQI hour is detected
extra AQI hour is detected where invalid
ineligible pollutant is skipped
manifest/index mismatch remains detectable
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and implement Phase 10 only.

Do not contact real R2.

Inspect the authoritative AQI hourly writer/calculation contract in uk-aq-ops.

Do not use the ingest repository.

Confirm the real rules for:

- AQI-enabled pollutants;
- hourly bucket identity;
- minimum valid source observations;
- expected AQI output rows;
- missing and invalid hours.

Replace raw aqi_rows < observation_rows completeness checks in both the main integrity checker and uk-aq-aqi-gap-check.py.

Use grain-aware expected-hour comparisons.

Add tests including the 288-observation/24-hour healthy case.

Run the complete Python suite and relevant Node/static checks.

Do not commit, stage, push, deploy or copy files.

Update only the Phase 10 implementation record and stop.
```

---

# Phase 11: final local validation and runtime handoff

## Goal

Prove the corrected implementation is internally consistent and prepare, but do not perform, the CIC-Test runtime validation.

## Required validation

Run:

```bash
python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q
```

Run all Phase 3 Node tests.

Run:

```bash
python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

Run `node --check` on all changed `.mjs` files.

Run:

```bash
bash -n scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
bash -n scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
bash -n scripts/uk_aq_backfill_local.sh
npm run check
git diff --check
```

Inspect:

```bash
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

Confirm no archive file changed.

## Required final report

```text
every blocker A to O status
exact files changed
exact tests and totals
runtime files or complete checkout requirement
dependency changes
configuration changes
safe Phase 2 runtime command
safe Phase 3 dry-run command
remaining runtime-only acceptance
confirmation no real R2 access occurred
confirmation nothing was staged or committed
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete blockers plan and perform Phase 11 only.

Do not change implementation unless a validation failure proves a narrow defect introduced by the remediation phases.

Do not search or modify archive/.

Run every validation command in Phase 11.

Run every focused Phase 3 test and the full Python integrity suite.

Confirm the canonical SQL test reads the schema repository directly.

Confirm no current plan has contradictory status wording.

Confirm no obsolete repository path remains in current non-archive env examples or documentation.

Confirm the runtime deployment model is complete.

Prepare the exact manual CIC-Test Phase 2 check-only acceptance command and the exact Phase 3 executor dry-run command.

Do not run either runtime command.

Do not contact R2, run a backfill, deploy, copy files, commit, stage or push.

Update the blocker status matrix and final implementation record.

Stop after the final report.
```

---

# 6. Separate runtime approval gates

Local implementation and mocked tests do not authorise runtime execution.

## Runtime gate 1: Phase 2 check-only acceptance

May proceed after Phases 1 to 3 and Phase 11 validation are complete.

Permitted behaviour:

```text
read local Dropbox mirror
read source services according to normal integrity behaviour
read parquet through DuckDB
write local SQLite state and reports
```

Forbidden behaviour:

```text
R2 PUT
R2 DELETE
backfill
AQI rebuild
```

## Runtime gate 2: Phase 3 CIC-Test dry-run

May proceed only after Phases 4 to 8 and Phase 11 validation are complete.

Permitted behaviour:

```text
fresh R2 LIST, HEAD and GET reads
produce a complete proposed repair plan
```

Forbidden behaviour:

```text
R2 PUT
R2 DELETE
```

## Runtime gate 3: Phase 3 CIC-Test write

Requires separate explicit user approval after reviewing the dry-run.

Must use:

```text
UK_AQ_ENV_NAME=CIC-Test
bucket=uk-aq-history-cic-test
--write-r2
```

LIVE Phase 3 repair remains disabled.

---

# 7. Completion criteria for the blocker plan

This blockers plan is complete only when:

```text
[ ] canonical SQL test reads uk-aq-schema directly
[ ] full Python integrity suite passes
[ ] plans have one authoritative status table
[ ] stale current runtime paths are corrected
[ ] Phase 2 real DuckDB acceptance has completed
[ ] Phase 3 executor accepts real integrity output
[ ] Phase 3 dual write gate is enforced
[ ] Phase 3 dry-run is an accurate full-hierarchy preview
[ ] complete child sets are re-listed and re-read before parent writes
[ ] multi-connector day repairs use one day and one index update
[ ] index results propagate into status and exit codes
[ ] blocked generic index work exits non-zero
[ ] O3 end-to-end mocked acceptance passes
[ ] standalone parent utilities strictly validate children
[ ] existing Phase 4 write paths are fully inventoried
[ ] AQI completeness is grain-aware
[ ] no duplicate or conflicting Phase 4 architecture remains
[ ] no archive file was changed
[ ] no real R2 mutation occurred without explicit approval
```

---

# 8. Recommended model summary

Use:

```text
GPT-5.6 Terra
Reasoning: High
```

for all code and architecture phases in this plan.

The issues cross Python, Node, shell, R2 object hierarchy, live verification, status propagation and existing backfill behaviour. A smaller model may save usage but is more likely to miss cross-file safety interactions.

A smaller Codex model can be used later for a purely documentation-only tidy-up after all code and tests are already stable, but not for the repair executor, AQI rules or write-path reconciliation.
