# UK-AQ Phase 2c.2 Ops-Only Source Evidence and Repair Planning Plan

Generated: 12/07/2026 19:58 Europe/London

Plan filename:

```text
uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md
```

Expected repository location:

```text
plans/2026-07-12 Integrity/uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md
```

## Purpose

This plan addresses the remaining Phase 2c.2 defects found in the current `uk-aq-ops` integrity checker.

It does not repeat Phase 2c.1 or Phase 2c.3 work.

It does not require a real DuckDB-backed run at this stage. DuckDB validation is explicitly deferred until the checker is copied to the test integrity system or another environment where DuckDB is installed.

The work must remain:

```text
repository: TEST-uk-aq/uk-aq-ops
branch: main
state: uncommitted and unstaged
```

---

# Hard repository boundary

The only writable repository is:

```text
TEST-uk-aq/uk-aq-ops
```

Do not create, edit, rename, delete, format, generate, stage or otherwise modify any file in:

```text
uk-aq-ingest
TEST-uk-aq-ingest
uk-aq-schema
TEST-uk-aq-schema
the website repository
any sibling repository
any parent directory outside uk-aq-ops
```

The schema repository may be read only where an existing test requires the canonical SQL.

Do not search or modify the ingest repository.

Before every implementation phase, verify:

```bash
pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch
```

Continue only if:

```text
Git root = TEST-uk-aq/uk-aq-ops
origin = https://github.com/TEST-uk-aq/uk-aq-ops.git
branch = main
```

---

# No commit, deploy or runtime-copy rule

Codex must not:

```text
commit
amend a commit
stage files
create a branch
switch branches
create a tag
push
open or update a pull request
deploy
apply SQL
copy files to the integrity machine
write to R2
mutate history data
begin Phase 3
```

All changes must remain uncommitted and unstaged for user review.

---

# DuckDB decision

A real DuckDB-backed run is not required by this plan.

The current development environment does not have the Python `duckdb` module installed. That is acceptable because the checker will later be tested on the separate test integrity system.

Codex must not:

```text
install DuckDB
change dependency files merely to add DuckDB
mark the phase blocked because DuckDB is absent
fake a real DuckDB run
claim live parquet validation occurred
```

The final record must say:

```text
Real DuckDB-backed validation deferred to the test integrity system.
```

---

# Confirmed findings to analyse

Codex must independently confirm each finding against the current local working tree before changing code.

## Finding A: successful-empty source evidence is ignored

The source lookup can return:

```text
source_partition_state = successful_empty
source_counts = {}
source_skip_reason = null
```

This is authoritative evidence that the source contains zero rows for the partition.

The current mismatch helper appears to return early when `source_counts` is empty. If confirmed, this suppresses the required mismatch when parquet contains rows.

Required example:

```text
source state: successful_empty
source counts: {}
parquet counts: {101: 3}
```

Expected result:

```text
source_r2_timeseries_row_mismatch
r2_only_timeseries_ids = [101]
source_rows = 0
r2_rows = 3
fault_class = data fault
```

Unavailable source evidence must remain distinct. An unavailable source must not be treated as authoritative zero.

## Finding B: connection-unavailable evidence is not propagated

The source helper can represent:

```text
connection_unavailable
source_connection_unavailable
```

But the real observations runtime appears to call it only when `conn` is not `None`.

If confirmed, `conn=None` results in no partition evidence, so repair planning cannot distinguish unavailable source evidence from no evidence.

Required behaviour:

```text
conn=None
→ source helper or equivalent evidence builder creates connection_unavailable evidence
→ relevant partition gaps receive that evidence
→ uncertain scopes produce operator-review actions
```

## Finding C: repair precedence does not remove contradictory actions

Actions appear to be keyed by action kind as well as day, connector and pollutant. If confirmed, one partition can retain both:

```text
observation_pollutant_manifest_repair
observation_data_repair
```

or:

```text
source_mapping_issue
observation_data_repair
```

Required precedence:

```text
proven data fault
> uncertain source evidence requiring operator review
> proven manifest-only fault
```

For a single domain, day, connector and pollutant scope, the final plan must not contain contradictory lower-priority actions.

## Finding D: dependent AQI rebuild metadata is wrong

An AQI rebuild planned because observation data must change appears to retain:

```text
data_changes_required = false
```

If confirmed, this is misleading.

Required behaviour:

```text
observation data repair for PM2.5, PM10 or NO2
→ dependent AQI rebuild may be planned
→ status=planned
→ executes=false
→ data_changes_required=true
```

Do not plan dependent AQI rebuilding for O3, manifest-only repairs, operator-review actions or index-only actions.

## Finding E: untracked ops SQL mirror needs classification

Codex reported an untracked SQL mirror inside `uk-aq-ops`.

Inspect its exact path and contents. Classify it as:

```text
required existing ops fixture
intentional ops documentation/reference
accidental copy of canonical schema SQL
unrelated pre-existing user work
```

Do not delete or modify it without evidence.

If it is an accidental copy created to make a schema test pass, make the test locate the sibling schema repository read only and remove only the confirmed accidental copy.

---

# Phase status

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 2c.2a | Correct source-state comparison and propagation | Local validation complete, uncommitted | Successful-empty and unavailable states |
| 2c.2b | Enforce repair precedence and AQI metadata | Local validation complete, uncommitted | One unambiguous result per partition |
| 2c.2c | Non-DuckDB completion checks and SQL-mirror review | Not started | DuckDB deferred to test system |

Allowed status values:

```text
Not started
In progress
Blocked
Changes prepared, uncommitted
Local validation complete, uncommitted
```

---

# Phase 2c.2a: Correct source-state comparison and propagation

## Goal

Make successful-empty source results authoritative while keeping unavailable source evidence distinct and propagating both through the real observations integrity path.

## Analyse before editing

Inspect:

```text
_current_source_counts_for_v2_partition
_build_v2_source_r2_mismatch_gap
run_v2_observations_integrity_checks
source evidence attachment to partition gaps
_classify_v2_gaps
```

Record each finding as confirmed, partly confirmed or not confirmed.

## Required implementation

1. Do not infer source availability only from whether `source_counts` is truthy.
2. Preserve these distinct states:

```text
successful_non_empty
successful_empty
connection_unavailable
scope_unavailable
metadata_unavailable
pollutant_absent
counts_unavailable
```

3. When the state is `successful_empty`, compare an empty source map with the actual parquet map. If parquet is non-empty, create R2-only mismatch details.
4. For unavailable states, do not generate a source/R2 mismatch by treating the source as empty.
5. The real runtime must create source evidence even when `conn=None`.
6. Attach compact source evidence to every relevant gap created for the partition.

## Required tests

1. successful-empty source plus parquet rows produces a mismatch;
2. all parquet timeseries are reported as R2-only;
3. successful-empty source plus empty parquet produces no mismatch;
4. unavailable connection plus parquet rows does not create a false source/R2 mismatch;
5. `conn=None` propagates `connection_unavailable` evidence;
6. scope unavailable remains distinct;
7. metadata unavailable remains distinct;
8. pollutant absent remains distinct;
9. successful non-empty behaviour still works;
10. the real observations path remains read only.

## Validation commands

Do not require DuckDB. Use the existing mock/fake parquet statistics path.

```bash
python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

```bash
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py \
  scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
```

```bash
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- successful-empty is authoritative;
- R2-only rows are detected against successful-empty source;
- unavailable source is not treated as empty;
- `conn=None` produces explicit unavailable evidence;
- evidence reaches real runtime gaps;
- focused tests pass;
- no write behaviour is added;
- changes remain uncommitted and unstaged.

## Implementation record

Status:

```text
Local validation complete, uncommitted
```

Analysis confirmation:

```text
Confirmed Finding A and Finding B. Successful-empty source partitions are now authoritative for source/R2 comparison, unavailable source states remain distinct, and conn=None now produces and propagates connection_unavailable evidence into relevant partition gaps.
```

Files changed:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py
scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
```

Tests:

```text
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
```

---

# Codex prompt for Phase 2c.2a

```text
Read the complete plan:

plans/2026-07-12 Integrity/uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md

Implement Phase 2c.2a only.

Do not begin Phase 2c.2b, Phase 2c.2c or Phase 3.

HARD REPOSITORY BOUNDARY:

Modify only TEST-uk-aq/uk-aq-ops.

Do not search or modify the ingest repository.
Do not modify the schema repository, website repository or any sibling repository.
The schema repository may be read only where an existing test requires canonical SQL.

Before editing, verify:

pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch

Continue only in TEST-uk-aq/uk-aq-ops on main.

Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy runtime files, write R2 data or mutate history data.

Do not install DuckDB. Real DuckDB validation is deferred to the test integrity system.

FIRST, independently analyse and confirm or reject Findings A and B in the plan.

Inspect:

_current_source_counts_for_v2_partition
_build_v2_source_r2_mismatch_gap
run_v2_observations_integrity_checks
source evidence propagation

Add minimal regression tests demonstrating each confirmed defect before or alongside the fix.

Implement confirmed corrections:

1. successful_empty must be authoritative even though its source map is empty;
2. successful_empty plus non-empty parquet must produce R2-only mismatch details;
3. unavailable states must not be treated as authoritative zero;
4. conn=None must still produce and propagate connection_unavailable evidence;
5. relevant real-path gaps must receive compact partition evidence.

Run the Phase 2c.2a validation commands.

Update only the Phase 2c.2a status and implementation record in this plan.

Leave all changes uncommitted and unstaged.

At the end report:

- analysis result for each finding;
- exact ops files changed;
- tests and counts;
- git diff --stat;
- git diff --name-only;
- git ls-files --others --exclude-standard;
- git status --short;
- sibling repository status comparison;
- remaining limitations.

Stop after Phase 2c.2a.
```

---

# Phase 2c.2b: Enforce repair precedence and AQI metadata

## Goal

Produce one unambiguous highest-priority repair outcome per affected partition and make dependent AQI action metadata truthful.

## Analyse before editing

Inspect:

```text
build_v2_repair_plan
add_action
observation gap classification
AQI-dependent action planning
action ordering and final return
```

## Required implementation

1. Apply final precedence by pollutant partition scope:

```text
proven data fault
> operator review due unavailable evidence
> manifest-only repair
> index-only repair
```

2. Parent connector/day actions are separate scopes and must not be incorrectly removed.
3. Do not return both manifest repair and data repair for one pollutant partition.
4. Do not return operator review plus a lower-confidence repair for the same partition.
5. Manifest-only repair is permitted only when parquet is readable, no structural data fault exists, source evidence is authoritative, and parquet agrees with source.
6. When observation data repair for PM2.5, PM10 or NO2 requires dependent AQI rebuilding, set:

```text
kind = aqi_rebuild
status = planned
executes = false
data_changes_required = true
```

7. Do not add dependent AQI work for O3, manifest-only, operator-review or index-only actions.
8. All actions remain non-executing.

## Required tests

1. manifest mismatch plus proven source/parquet agreement yields manifest repair only;
2. manifest mismatch plus source/parquet disagreement yields data repair only;
3. missing parquet plus unavailable source yields operator review only;
4. missing parquet plus source-proven rows yields data repair only;
5. no partition returns both manifest repair and data repair;
6. no partition returns operator review plus a lower-confidence repair;
7. PM2.5 observation data repair plans dependent AQI rebuild;
8. dependent AQI rebuild has `data_changes_required=true`;
9. PM10 and NO2 parity;
10. O3 does not plan dependent AQI;
11. manifest-only work does not plan dependent AQI;
12. operator review does not plan dependent AQI;
13. all actions remain planned and non-executing;
14. parent connector/day repairs remain separate and intact.

## Validation commands

```bash
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
```

```bash
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
```

```bash
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py \
  scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
```

```bash
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- contradictory pollutant actions are eliminated;
- precedence is evidence-driven;
- uncertain source state produces operator review;
- proven data fault dominates manifest-only repair;
- dependent AQI metadata is truthful;
- O3 and non-data actions do not trigger AQI rebuilding;
- all actions remain non-executing;
- tests pass;
- changes remain uncommitted and unstaged.

## Implementation record

Status:

```text
Local validation complete, uncommitted
```

Analysis confirmation:

```text
Finding C confirmed. The repair plan now selects one highest-priority observation action per partition and prunes lower-priority contradictory actions.
Finding D confirmed. Dependent AQI rebuilds are only retained for observation data repairs and now carry data_changes_required=true.
```

Files changed:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
```

Tests:

```text
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py -q
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py -q
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py -q
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py -q
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
git diff --check
```

---

# Codex prompt for Phase 2c.2b

```text
Read the complete plan:

plans/2026-07-12 Integrity/uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md

Implement Phase 2c.2b only.

Do not begin Phase 2c.2c or Phase 3.

Modify only TEST-uk-aq/uk-aq-ops.
Do not search or modify the ingest repository.
Do not modify any sibling repository.
Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy runtime files, write R2 data or mutate history data.

Do not install or require DuckDB.

FIRST, independently analyse and confirm or reject Findings C and D in the plan.

Inspect:

build_v2_repair_plan
add_action
scope keys
action precedence
dependent AQI planning
final action return

Add regression tests for every confirmed defect.

Implement:

1. one highest-priority action outcome per pollutant partition;
2. data repair > operator review > manifest-only precedence;
3. no contradictory manifest/data or review/repair actions;
4. dependent AQI rebuilding only after proven observation data change;
5. data_changes_required=true for dependent AQI rebuild actions;
6. no dependent AQI work for O3, manifest-only, operator-review or index-only actions;
7. all actions status=planned and executes=false.

Preserve separate connector/day parent-manifest repair scopes.

Run the Phase 2c.2b validation commands.

Update only the Phase 2c.2b status and implementation record in this plan.

Leave all changes uncommitted and unstaged.

At the end report:

- analysis result for each finding;
- exact files changed;
- tests and counts;
- examples of final action output for data, review and manifest-only cases;
- git diff --stat;
- git diff --name-only;
- git ls-files --others --exclude-standard;
- git status --short;
- sibling repository status comparison;
- remaining limitations.

Stop after Phase 2c.2b.
```

---

# Phase 2c.2c: Non-DuckDB completion checks and SQL-mirror review

## Goal

Run the complete available local suite, inspect repository hygiene, update the plan accurately and prepare the work for user review.

This phase does not run a real DuckDB-backed parquet check.

## Scope

### Full available test suite

```bash
python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q
```

Record test count, failures, errors and skips. A missing-DuckDB condition is acceptable if accurately recorded. All other failures and errors must be resolved.

### Syntax and Git checks

```bash
python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

```bash
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

### SQL mirror classification

Identify the exact untracked SQL path. Determine its origin, purpose, whether it duplicates sibling canonical SQL and whether tests depend on it.

Do not apply SQL. Do not modify the sibling schema repository. Do not keep an accidental copied canonical SQL file solely to make tests pass. Do not delete unrelated user work.

### Plan wording

Record:

```text
Real DuckDB-backed validation was not run in the development environment and is deferred to the test integrity system after manual runtime copy.
```

### Runtime handoff

List only runtime files that need manual copying. Tests, plans and fixtures are development-only unless the runtime machine genuinely has and runs the test tree.

Do not copy anything.

## Acceptance criteria

- full available suite passes with zero non-DuckDB failures and errors;
- syntax checks pass;
- `git diff --check` passes;
- SQL mirror is classified honestly;
- accidental duplicate SQL is not retained solely to satisfy tests;
- no sibling repository changed;
- no DuckDB validation is falsely claimed;
- changes remain uncommitted and unstaged;
- runtime handoff is accurate.

## Implementation record

Status:

```text
Not started
```

Full suite:

```text
To be updated by Codex.
```

SQL mirror:

```text
To be updated by Codex.
```

Runtime handoff:

```text
To be updated by Codex.
```

Deferred validation:

```text
Real DuckDB-backed validation deferred to the test integrity system.
```

---

# Codex prompt for Phase 2c.2c

```text
Read the complete plan:

plans/2026-07-12 Integrity/uk-aq-phase-2c2-ops-only-source-evidence-repair-plan-2026-07-12-1958.md

Implement Phase 2c.2c only.

Do not begin Phase 3.

Modify only TEST-uk-aq/uk-aq-ops.
Do not modify the ingest repository, schema repository, website repository or any sibling repository.
The schema repository may be read only for an existing canonical SQL test.

Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy runtime files, write R2 data or mutate history data.

Do not install DuckDB and do not require a real DuckDB run.

Run the complete available integrity test suite:

python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q

Run py_compile and all Git working-tree checks from the plan.

Inspect the exact untracked ops SQL mirror. Classify it as:

- required existing ops fixture;
- intentional documentation/reference;
- accidental copy of sibling canonical schema SQL;
- unrelated user work.

Do not delete unrelated work.
Do not modify the sibling schema repository.
Remove only a confirmed accidental Phase 2c copy after recording its origin and the exact safe command.

Update the Phase 2c.2c record and the phase status table.

State accurately:

Real DuckDB-backed validation was not run in the development environment and is deferred to the test integrity system after manual runtime copy.

Prepare the runtime/development file split, but do not copy anything.

Leave all changes uncommitted and unstaged.

At the end report:

- full test count and result;
- skipped tests;
- py_compile result;
- SQL mirror path and classification;
- exact files changed;
- runtime files to copy later;
- development-only files;
- dependency impact;
- runtime configuration impact;
- git diff --stat;
- git diff --name-only;
- git ls-files --others --exclude-standard;
- git status --short;
- sibling repository status comparison;
- remaining limitations.

Stop after Phase 2c.2c.
```

---

# Overall completion checklist

```text
[ ] Successful-empty source is authoritative
[ ] Successful-empty plus R2 rows produces R2-only mismatch
[ ] Unavailable source is not treated as authoritative zero
[ ] conn=None produces explicit unavailable evidence
[ ] Evidence reaches the real observations runtime gaps
[ ] One highest-priority action exists per pollutant partition
[ ] Data repair dominates manifest-only repair
[ ] Operator review replaces uncertain lower-confidence repairs
[ ] No contradictory actions remain
[ ] Dependent AQI rebuild requires proven observation data change
[ ] Dependent AQI action has data_changes_required=true
[ ] O3 does not trigger dependent AQI rebuild
[ ] Manifest-only actions do not trigger AQI rebuild
[ ] Operator-review actions do not trigger AQI rebuild
[ ] All actions remain planned and non-executing
[ ] Full non-DuckDB suite passes
[ ] py_compile passes
[ ] git diff --check passes
[ ] SQL mirror is classified
[ ] No accidental duplicate canonical SQL is retained
[ ] No ingest or sibling repository changed
[ ] No commit, stage, push or deployment occurred
[ ] Runtime files are listed but not copied
[ ] DuckDB validation is explicitly deferred to the test integrity system
```
