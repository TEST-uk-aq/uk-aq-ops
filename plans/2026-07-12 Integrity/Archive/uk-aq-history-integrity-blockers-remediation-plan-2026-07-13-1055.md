# UK-AQ History Integrity Blockers and Remediation Plan

Generated: 13/07/2026  
Revised: 13/07/2026 10:55 Europe/London  
Repository: `TEST-uk-aq/uk-aq-ops`  
Branch: `main`

Plan filename:

```text
uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md
```

Recommended repository location:

```text
uk-aq-ops/plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md
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

This revision uses the CIC-Test system as the primary integration-test environment. It deliberately reduces exhaustive mocked testing and moves confidence-building into staged real runs.

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

CIC-Test read-only runs and dry-runs are expected at the checkpoints defined below. A scoped CIC-Test R2 write is permitted only at the explicit write checkpoint, after the user has reviewed the dry-run and approved the write.

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

# 3. Pragmatic testing and real-run policy

This is a test system. Real CIC-Test execution is the primary integration and acceptance evidence.

Local automated testing remains necessary where a real run cannot reliably prove a safety property, but it must be proportionate.

## Required local testing

For each implementation phase, run only:

```text
one focused test file or focused test command for the changed behaviour
syntax checks for changed Python, Node or shell files
git diff --check
```

Add a small regression test only when it protects one of these critical boundaries:

```text
dry-run performs no PUT or DELETE
LIVE cannot pass a CIC-Test write gate
parquet and AQI keys cannot be written or deleted by the Phase 3 executor
parent writes preserve complete child sets
blocked or failed work returns a non-zero exit where shell callers depend on it
AQI completeness uses hourly grain rather than raw observation-row parity
```

Do not build a separate test for every permutation where one representative regression test plus a real CIC-Test run proves the behaviour adequately.

## Full-suite frequency

Do not run the complete Python and Node suites after every phase.

Run them only:

```text
once after the Phase 3 executor corrections are complete
once at final local validation
when a focused test exposes a wider regression
```

## Real CIC-Test acceptance sequence

Use this sequence as the main integration proof:

```text
1. real one-day integrity check-only run with DuckDB
2. real Phase 3 CIC-Test R2 dry-run using the generated integrity report
3. review the exact planned keys and bytes/hashes
4. one explicitly approved scoped O3 CIC-Test write
5. real post-write integrity check-only run
6. repeat the same repair command and confirm idempotent no-op behaviour
7. run a short multi-day CIC-Test integrity check after AQI grain correction
```

## LIVE boundary

No LIVE repair execution is part of this plan.

---

# 4. Authoritative status before remediation

| Area | Current audited status |
| --- | --- |
| Phase 1 backup gate | Implementation substantially complete, but the canonical SQL test and plan wording are inconsistent with the deleted ops SQL mirror |
| Phase 2 read-only validation | Local implementation substantially complete; real DuckDB runtime validation remains pending |
| Phase 3 manifest and index repair | In progress; implementation has unresolved safety, planning, execution-order and status-propagation blockers |
| Phase 4 observation and AQI repair | Plan says not started, but existing `--run-backfill` code already implements overlapping write-capable behaviour |
| Plans and documentation | Multiple contradictory status records and stale runtime paths |
| Runtime deployment model | Launcher and Python deployment are documented, but the Phase 3 Node dependency bundle is not defined clearly |

---

# 5. Confirmed blockers to resolve

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

plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md

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
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md
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
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md
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

# Runtime checkpoint A: real Phase 2 DuckDB acceptance

## Goal

Run the prepared one-day CIC-Test integrity command now, rather than waiting until all later implementation phases are complete.

This is a real integration run against the CIC-Test Dropbox history mirror. It is read-only with respect to R2 and backfill systems.

## Required run

Use the deployed launcher or the complete ops checkout, with:

```text
environment: CIC-Test
profile: manual
source: all
from/to day: 2026-05-17
history version: v2
check-only: true
run-backfill: absent
concurrency: 1
DuckDB: real venv package
```

## Acceptance evidence

Review the generated JSON report and confirm:

```text
real parquet statistics were produced by DuckDB
O3 data was readable
O3 was classified as manifest/index hierarchy work rather than data repair
O3 did not create an AQI rebuild action
repair actions remained planned and non-executing
no backfill subprocess ran
no R2 PUT or DELETE occurred
```

Do not add more mocked tests to compensate for a failed real run. Diagnose the actual failure and make the smallest correction.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and perform Runtime checkpoint A only.

Do not search or modify archive/.

Use the configured CIC-Test integrity launcher and real venv Python/DuckDB.

Run the existing one-day manual v2 check-only command for 2026-05-17. Do not add --run-backfill. Keep daily task health disabled for this manual acceptance run.

Inspect the generated JSON report, logs and exit code. Confirm the exact DuckDB evidence, O3 findings, repair actions and absence of executed writes/backfills.

If the real run reveals a clear implementation defect, make only the narrow correction needed, run the same real check again, and run only the focused test covering that correction plus syntax and git diff --check.

Do not contact R2 directly, perform R2 PUT/DELETE, deploy SQL, commit, stage or push.

Update the runtime checkpoint record in this plan and stop.
```

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

Dry-run output must show enough information for real-run approval:

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

Add or retain representative regressions for:

```text
proposed connector feeds proposed day
two connectors on one day cause one day/index update
dry-run causes zero PUT/DELETE
```

Do not run the full Python suite in this phase unless the Python report contract changes.

## Real acceptance

After focused checks pass, run a real CIC-Test Phase 3 dry-run using the actual report produced at Runtime checkpoint A.

The real dry-run must contact CIC-Test R2 only for permitted LIST/HEAD/GET reads and must produce zero writes.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and implement Phase 5 only.

Do not search or modify archive/.

Refactor the Phase 3 executor so dry-run and write mode share one staged in-memory hierarchy grouped by day. Repair all selected connectors before constructing one day proposal and one targeted index/latest/metadata proposal set.

Keep dry-run as the default and perform no PUT or DELETE in dry-run.

Use only focused executor tests for the three representative behaviours named in the plan, plus node --check and git diff --check. Do not run the full Python or repository test suites unless a changed Python contract requires it.

After local checks pass, run a real CIC-Test dry-run using the actual integrity JSON report from Runtime checkpoint A. Review the exact proposed keys, hashes, dependencies and zero-write evidence.

Do not use --write-r2. Do not contact LIVE, deploy, commit, stage or push.

Update the Phase 5 implementation and real-run record, then stop.
```

## Phase 5 implementation and real-run record

**Status: local implementation complete; real CIC-Test R2 dry-run blocked by
the Runtime checkpoint A report contract. No R2 mutation occurred.**

The Phase 3 executor now groups selected scopes by day and constructs one
staged in-memory hierarchy before its final write stage:

```text
selected connector proposals
→ one day proposal from the complete staged connector set
→ one targeted observations index/latest/metadata proposal set
→ optional PUT stage only when --write-r2 is present
```

Dry-run remains the default. It returns staged proposal keys, old SHA-256 and
ETag where available, new SHA-256, exact proposed body, dependencies,
changed/skipped state, blocked scopes, and expected verification. No PUT or
DELETE is issued during planning. The staged adapter presents proposed parent
objects to the targeted index builder, so the day/index proposal is derived
from the same hierarchy that write mode would apply.

Required local checks:

```text
node --test --test-name-pattern='one-connector|two connector|dry-run proposal bytes' tests/uk_aq_phase_3_repair_executor.test.mjs
3 passed, 0 failed.

node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
node --check workers/shared/r2_sigv4.mjs
node --check workers/shared/uk_aq_r2_history_index.mjs
git diff --check
Passed.
```

### Real CIC-Test dry-run attempt

Used the newest available checkpoint-A report for the required one-day scope:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-history-integrity/reports/2026-07-11T205039Z-summary.json
```

Its context is `CIC-Test`, manual, `sos`, 2026-05-17,
`history_version_mode=v2`, `check_only=true`, and `run_backfill=false`. It is
not a valid current Phase 3 handoff report: v2 observations has no
`repair_plan` array. It has these suggested kinds:

```text
rebuild_v2_observations_index_only
uk_air_csv_to_v2_observations_backfill_required
```

The second is outside the Phase 3 manifest/index executor contract and must
not be silently filtered or converted into a hand-authored action.

The exact dry-run command omitted `--write-r2` and stopped during input
validation:

```text
node scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs \
  --repair-plan-json /Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-history-integrity/reports/2026-07-11T205039Z-summary.json

exit: 1
Invalid complete integrity report: expected checked v2 observations results
```

`runV2ObservationsRepair` validates the report before resolving R2
configuration or issuing a request. This attempt therefore performed zero R2
LIST, HEAD, GET, PUT, and DELETE operations. No proposed keys, hashes,
dependencies, or staged zero-write plan exists to review from this rejected
input.

The successful real-acceptance prerequisite is a current checkpoint-A report
whose `history_version_results.v2.observations.repair_plan` is present and
contains only supported Phase 3 observation manifest/index actions for the
selected scope. Generating or selecting that report is outside Phase 5; the
executor’s reject-before-R2 safety contract must not be weakened to bypass it.

No full Python or repository-wide suite was run. No `--write-r2`, R2
PUT/DELETE, LIVE contact, deployment, SQL, backfill, runtime-file copy, commit,
stage, push, branch, or tag operation occurred.

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
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md

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

# Phase 8: real CIC-Test O3 repair acceptance

## Goal

Use the real test system as the end-to-end Phase 3 acceptance environment.

Do not build a large synthetic O3 test suite. Retain one small regression proving that the executor accepts the real integrity action shape with `requires_index_rebuild=true`; use the real CIC-Test run for integration proof.

## Pre-write gate

Before any write, the real dry-run must show only the expected scoped observation keys for:

```text
day: 2026-05-17
connector: 1
pollutant: o3
environment: CIC-Test
bucket: uk-aq-history-cic-test
```

Confirm explicitly:

```text
no parquet key
no AQI key
no DELETE
all sibling pollutants preserved
all sibling connectors preserved
one connector parent proposal
one day parent proposal
required observation index/latest/metadata proposals only
```


## Real write and verification

After approval:

```text
run the scoped CIC-Test repair with --write-r2
inspect the executor result and R2 verification evidence
run the same one-day integrity check-only command again
confirm the O3 hierarchy/index gaps are gone
run the same repair command again and confirm an idempotent no-op
```

If the real run fails, fix the real defect and add only a focused regression test for that defect.

LIVE remains disabled.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and perform Phase 8 up to the approval boundary first.
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md

Do not search or modify archive/ and do not contact LIVE.

Use the real CIC-Test integrity report and run the Phase 3 executor dry-run for the scoped O3 case on 2026-05-17, connector 1.

Report every proposed key, changed/unchanged result, dependency and verification expectation. Confirm no parquet key, AQI key or DELETE operation is present and that all sibling pollutants/connectors are preserved.

Stop before --write-r2 and ask for the user's explicit approval.

After the user separately approves, run the scoped CIC-Test write, inspect fresh verification, rerun the one-day integrity check-only command, and rerun the repair command to prove idempotent no-op behaviour.

Use only one small local regression test for the real integrity action shape. Add another focused test only if the real run exposes a code defect.

Do not deploy SQL, commit, stage or push.
```

---

# Phase 9: audit and reconcile existing Phase 4 write-capable paths

## Goal

Inventory existing `--run-backfill` observation and AQI write paths before adding or redesigning Phase 4 behaviour.

## Required analysis

Classify each reachable path as:

```text
v1 or v2
observation or AQI
data, manifest or index write
trigger and evidence
environment/dependency gate
verification and status propagation
retain, disable, refactor or remove
```

Do not add new write behaviour in this phase.

## Testing policy

This is an analysis phase. Do not run full test suites.

Run only syntax checks for any documentation/code comments changed and `git diff --check`.

Use evidence from the completed real Phase 2 and Phase 3 CIC-Test runs when deciding which existing paths are trustworthy.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and perform Phase 9 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md

Do not search or modify archive/.

Trace every current path reachable through --run-backfill in the integrity Python, shell wrappers, local backfill script and relevant ops workers/helpers. Do not inspect the ingest repository.

Classify each path by version, domain, write type, evidence, environment/dependency gates, verification, status propagation and tests. Use the completed real CIC-Test run evidence where relevant.

Recommend retain, disable, refactor or remove, but do not implement new write behaviour.

Do not run full test suites. Run only syntax checks for changed files and git diff --check.

Do not contact R2, run a backfill, deploy, commit, stage or push.

Update the master plan and Phase 9 record, then stop.
```

---

# Phase 10: correct AQI grain-aware completeness rules

## Goal

Replace invalid raw observation-row-to-AQI-row comparisons with the real hourly AQI writer contract.

## Required implementation

Inspect the authoritative ops AQI writer and confirm:

```text
hour key
pollutant eligibility
minimum valid input requirements
missing/invalid hour handling
expected output per valid hour
```

Update both the main integrity checker and `uk-aq-aqi-gap-check.py` to compare expected hourly output with actual hourly AQI data, manifest and index evidence.

## Proportionate local checks

Keep only three focused regression cases:

```text
288 five-minute observations with 24 valid AQI hours is healthy
one expected AQI hour missing is detected
ineligible pollutant is not treated as missing AQI
```

Do not create a large synthetic AQI matrix.

## Real CIC-Test acceptance

Run the corrected checker against a short CIC-Test date range containing real multi-observation-per-hour data. Review the reported expected and actual hour counts and ensure it no longer produces false raw-row-parity failures.

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
Read the complete revised blockers plan and implement Phase 10 only.
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md

Do not search or modify archive/ and do not use the ingest repository.

Inspect the authoritative hourly AQI writer/calculation contract in uk-aq-ops. Replace raw observation-row-to-AQI-row completeness checks in the main integrity checker and uk-aq-aqi-gap-check.py with expected-hour logic.

Add only the three focused regression tests listed in the plan. Run those focused tests, Python syntax checks and git diff --check.

Then run a real short-range CIC-Test integrity check and inspect expected versus actual hourly evidence. If it exposes a defect, make the smallest fix and add only a focused regression for that defect.

Do not perform LIVE work, deploy, commit, stage or push.

Update the Phase 10 record and stop.
```

---

# Phase 11: final validation and operational handoff

## Goal

Run one final proportionate local validation, then rely on the completed real CIC-Test evidence as the main acceptance record.

## Final local validation

Run once:

```bash
python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q
```

Run the focused Phase 3 Node test files, not every unrelated repository test.

Also run:

```text
py_compile for changed Python files
node --check for changed Node files
bash -n for changed shell files
npm run check
git diff --check
```

Do not add more tests merely to increase totals.

## Required final evidence

Summarise:

```text
Phase 2 real DuckDB check-only result
Phase 3 real R2 dry-run result
approved Phase 3 scoped CIC-Test write result
post-write integrity result
idempotent rerun result
AQI grain-aware real-run result
remaining LIVE-disabled limitations
```

### Recommended Codex model

```text
GPT-5.6 Terra
Reasoning: High
```

### Codex prompt

```text
plans/2026-07-12 Integrity/uk-aq-history-integrity-blockers-remediation-plan-2026-07-13-1055.md
Read the complete revised blockers plan and perform Phase 11 only.

Do not search or modify archive/.

Run the full Python integrity suite once, the focused Phase 3 Node test files, syntax checks for changed files, npm run check and git diff --check.

Do not add tests merely to increase coverage or test counts.

Compile the real CIC-Test evidence from the Phase 2 check-only run, Phase 3 dry-run, approved scoped write, post-write check, idempotent rerun and AQI grain-aware run.

Update the authoritative master status and blocker completion table honestly. Keep LIVE repair execution disabled unless a later plan explicitly enables it.

Do not deploy SQL, commit, stage or push.

Stop after the final report.
```

---

# 7. Runtime approval gates

## Gate 1: real Phase 2 check-only acceptance

This gate is expected and should be run early.

Permitted:

```text
source and Dropbox reads
DuckDB parquet reads
local SQLite/log/report writes
```

Forbidden:

```text
R2 PUT/DELETE
backfill
AQI rebuild execution
```

## Gate 2: real Phase 3 CIC-Test dry-run

Expected after Phase 5.

Permitted:

```text
CIC-Test R2 LIST/HEAD/GET
complete proposed repair output
```

Forbidden:

```text
PUT
DELETE
LIVE access
```

## Gate 3: scoped Phase 3 CIC-Test write

Permitted only after the user reviews Gate 2 and explicitly approves.

Required:

```text
UK_AQ_ENV_NAME=CIC-Test
bucket=uk-aq-history-cic-test
scoped O3 action from the real integrity report
--write-r2
```

After the write, immediately run post-write integrity and idempotence checks.

## Gate 4: LIVE

Not authorised by this plan.

---

# 8. Completion criteria for the blocker plan

```text
[ ] canonical SQL test reads uk-aq-schema directly
[ ] plans have one authoritative status table
[ ] stale runtime paths are corrected
[ ] real Phase 2 DuckDB check-only acceptance completed
[ ] Phase 3 executor accepts the real integrity report
[ ] dual CIC-Test environment/bucket gate enforced
[ ] real Phase 3 dry-run shows the complete final hierarchy and zero writes
[ ] parent writes re-list and re-read complete child sets
[ ] multi-connector day work produces one day/index update
[ ] index and verification outcomes control status and exit codes
[ ] scoped real O3 CIC-Test write succeeds after explicit approval
[ ] post-write integrity confirms the O3 fault is fixed
[ ] repeated repair is an idempotent no-op
[ ] existing Phase 4 write paths are inventoried and reconciled
[ ] AQI completeness is hourly-grain aware
[ ] real CIC-Test AQI check no longer reports raw-row-parity false positives
[ ] final proportionate local suites and syntax checks pass
[ ] no archive file changed
[ ] no LIVE mutation occurred
```

---

# 9. Recommended model summary

Use:

```text
GPT-5.6 Terra
Reasoning: High
```

for the remaining architecture and repair phases.

The reduced-testing approach saves usage by avoiding repeated exhaustive suites and large mocked matrices. Terra remains appropriate because the remaining work crosses Python, Node, shell, R2 hierarchy, status propagation and real-run interpretation.

Use real CIC-Test runs as the primary integration evidence. Keep small local tests only for safety properties that a normal real run cannot reliably force or prove.
