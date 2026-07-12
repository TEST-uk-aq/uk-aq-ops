# UK-AQ Phase 2c Ops-Only Working-Tree Correction Plan for VS Code Vibe Code

Generated: 12/07/2026 11:33 Europe/London

Plan filename:

```text
uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md
```

Expected location inside the ops repository:

```text
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md
```

# Critical repository boundary

## The only writable repository

Vibe Code may change files only inside:

```text
TEST-uk-aq/uk-aq-ops
```

Expected GitHub repository:

```text
TEST-uk-aq/uk-aq-ops
```

This is a hard boundary.

## Repositories that must not be changed

Do not create, edit, rename, delete, format, generate, stage or otherwise modify any file in:

```text
TEST-uk-aq/uk-aq-ingest
uk-aq-ingest
TEST-uk-aq-ingest
TEST-uk-aq/uk-aq-schema
uk-aq-schema
TEST-uk-aq-schema
TEST-uk-aq/uk-aq
uk-aq
```

Also do not change:

```text
any sibling repository
any parent directory
any shared workspace file outside uk-aq-ops
any Dropbox copy outside uk-aq-ops
any temporary checkout outside uk-aq-ops
any symlink target outside uk-aq-ops
```

The ingest repository is completely out of scope.

There is no reason to add anything to the ingest repository for this plan.

## Read-only exception for the schema repository

The sibling schema repository may be read only when a test needs to inspect the canonical SQL file.

Allowed:

```text
read a file
check whether a file exists
run a test that references the existing canonical schema file
report a missing path
```

Not allowed:

```text
edit a schema file
copy a schema file
generate a schema file
create a compatibility file
change a schema test fixture outside uk-aq-ops
commit or stage anything in the schema repository
```

The ingest repository has no read-only exception. Do not search it, index it, inspect it or use it for this work unless the user explicitly requests that separately.

---

# Mandatory repository verification before every phase

Before reading or editing implementation files, run:

```bash
pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch
```

Continue only when all of the following are true:

```text
Git top-level directory is the local TEST-uk-aq-ops checkout
origin is TEST-uk-aq/uk-aq-ops
branch is main
working tree has only the expected changes from earlier completed phases
```

If the Git root is not the ops repository:

```text
STOP
DO NOT EDIT ANY FILE
REPORT THE DETECTED PATH
```

Do not try to fix the workspace by editing another repository.

## Absolute path containment check

Before every file write, confirm that the resolved path is inside:

```text
<OPS_REPO_ROOT>
```

Conceptually:

```python
resolved_target.relative_to(resolved_ops_root)
```

If that containment check fails:

```text
DO NOT WRITE THE FILE
```

Do not follow a symlink to a target outside the ops repository.

## No multi-repository edits

Do not use editor-wide replacement, workspace formatting or refactoring across multiple repositories.

Do not use commands such as:

```bash
git -C ../uk-aq-ingest ...
find .. -type f -exec sed -i ...
grep -rl ... .. | xargs ...
prettier --write ..
ruff format ..
black ..
```

Use only repository-relative paths within `uk-aq-ops`.

---

# Purpose

This plan completes the remaining Phase 2 integrity-checking corrections in the uncommitted working tree of:

```text
Repository: TEST-uk-aq/uk-aq-ops
Branch: main
```

Vibe Code must make code, test, plan and documentation changes only inside the ops repository.

Vibe Code must not:

- change the ingest repository;
- change the schema repository;
- change the website repository;
- change any sibling repository;
- create a commit;
- amend a commit;
- create a tag;
- create a branch;
- switch to another branch;
- stage files unless explicitly asked;
- push;
- open or update a pull request;
- deploy;
- apply SQL;
- copy files to the runtime machine;
- mutate history data;
- perform R2 writes;
- begin Phase 3.

All changes must remain uncommitted for the user to inspect.

---

# Closed pull requests

The earlier Codex pull requests are closed and are historical references only:

```text
PR #2
PR #3
PR #4
```

Inspect them through GitHub while staying in the ops repository.

Allowed:

```bash
gh pr view 2 --repo TEST-uk-aq/uk-aq-ops
gh pr diff 2 --repo TEST-uk-aq/uk-aq-ops

gh pr view 3 --repo TEST-uk-aq/uk-aq-ops
gh pr diff 3 --repo TEST-uk-aq/uk-aq-ops

gh pr view 4 --repo TEST-uk-aq/uk-aq-ops
gh pr diff 4 --repo TEST-uk-aq/uk-aq-ops
```

If an exact file version is needed, fetch a read-only reference into the ops repository's own `.git` metadata:

```bash
git fetch origin pull/2/head:refs/remotes/origin/closed-pr-2
git fetch origin pull/3/head:refs/remotes/origin/closed-pr-3
git fetch origin pull/4/head:refs/remotes/origin/closed-pr-4
```

Remain on `main`.

Inspect only ops-repository files:

```bash
git diff main refs/remotes/origin/closed-pr-4 --   scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py

git show refs/remotes/origin/closed-pr-4:scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
```

Do not use:

```bash
gh pr checkout
git switch closed-pr-*
git checkout closed-pr-*
git cherry-pick <commit>
```

Do not reread complete PR diffs in every phase.

Use the Phase 2c.0 record as the primary comparison.

---

# Development and runtime model

## Development environment

Vibe Code works only in:

```text
TEST-uk-aq/uk-aq-ops
```

The ops checkout is the source of truth for:

- integrity code;
- integrity tests;
- ops documentation;
- ops plans;
- the uncommitted working-tree diff.

## Runtime environment

The integrity process runs locally on a separate machine.

After reviewing the working-tree changes, the user manually copies the required runtime files from the ops repository to that machine.

Vibe Code must not:

- copy files to the runtime machine;
- use SSH, SCP, rsync or Dropbox for deployment;
- edit runtime `.env` files;
- edit runtime secrets;
- edit launchd, cron or scheduler configuration;
- claim deployment occurred;
- claim runtime validation occurred.

## Required runtime handoff after each implementation phase

At the end of Phases 2c.1, 2c.2, 2c.3 and 2c.4, report:

### Runtime files to copy

List only changed runtime files inside `uk-aq-ops`.

### Development-only files

List changed ops files that do not need to be copied, such as tests, plans and docs.

### Dependency changes

State:

```text
No dependency change
Development/test dependency change only
Runtime dependency change
```

### Runtime configuration impact

State whether the phase changes:

```text
environment variables
paths
scheduler configuration
database access
R2 access
Dropbox paths
CLI arguments
report formats
```

Where none apply:

```text
No runtime configuration change.
```

### Runtime validation commands

Provide safe read-only commands using:

```text
<INTEGRITY_INSTALL_DIR>
<RUNTIME_VENV>
```

Do not invent absolute paths.

### Expected result

State:

- expected exit code;
- expected status;
- relevant report fields;
- expected absence of writes.

### Rollback files

List runtime files the user should back up before replacement.

---

# Working-tree rules

## Required starting state

Before each implementation phase:

```bash
cd <OPS_REPO_ROOT>
git switch main
git pull --ff-only
git status --short --branch
git branch --show-current
git log --oneline -8
```

If unrelated changes already exist inside the ops repository:

```text
STOP
REPORT THEM
DO NOT DISCARD OR OVERWRITE THEM
```

## No Git history changes

Do not run:

```bash
git commit
git commit --amend
git tag
git branch <new-name>
git switch -c
git checkout -b
git push
git merge
git rebase
git cherry-pick
gh pr create
gh pr reopen
gh pr merge
```

## No staging

Do not run:

```bash
git add
git restore --staged
```

unless the user explicitly asks.

## End-of-phase checks

Run inside the ops repository:

```bash
git diff --check
git diff --stat
git status --short
```

Also prove that changed paths are ops-repository paths only:

```bash
git diff --name-only
git ls-files --others --exclude-standard
```

Every returned path must be relative to the ops repository.

## Sibling repository protection check

At the start of Phase 2c.1, record the status of known sibling repositories without changing them, if they exist:

```bash
git -C ../TEST-uk-aq-ingest status --porcelain 2>/dev/null || true
git -C ../uk-aq-ingest status --porcelain 2>/dev/null || true
git -C ../TEST-uk-aq-schema status --porcelain 2>/dev/null || true
```

At the end of every implementation phase, run the same read-only status commands.

Compare the output.

If a sibling repository changed during the phase:

```text
STOP
DO NOT TRY TO CLEAN IT
REPORT THE EXACT PATHS
MARK THE PHASE BLOCKED
```

Do not use `git restore`, `git clean`, deletion or any other command in a sibling repository.

---

# Authoritative contracts

Inspect only the ops-repository writer and shared files:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/shared/
scripts/backup_r2/
```

Do not search the ingest repository for equivalents.

Do not guess:

- required manifest fields;
- timestamp field names;
- zero-row behaviour;
- stored hash requirements;
- AQI eligibility rules;
- source-evidence semantics.

---

# Primary writable files

All writable paths must be inside `uk-aq-ops`.

Likely implementation files:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

Likely test files:

```text
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
```

Likely docs and plans:

```text
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md
```

No file under an ingest repository is writable.

---

# Remaining issues

1. DuckDB statistics exclude null `timeseries_id` rows from total `row_count`.
2. Null `timeseries_id` rows are not separately counted or reported.
3. Successful empty source counts can be conflated with unavailable source evidence.
4. Required pollutant manifest fields are incompletely validated.
5. Required parent aggregate fields are incompletely validated.
6. Required parent timestamp validation is not domain-specific.
7. Empty pollutant counts lack corrected data-manifest terminology.
8. Genuine zero-row pollutant partitions are not distinctly classified.
9. Source evidence is not propagated to all planning gaps.
10. Missing listed parquet files can be planned incorrectly.
11. Contradictory actions can be produced for one partition.
12. Missing child manifest hashes are not detected.
13. Missing parent child-entry hashes are not detected.
14. Stored-hash terminology needs correction.
15. Canonical hash recalculation remains out of scope.
16. Real DuckDB tests need to run locally.
17. The full suite needs the sibling schema repository available read-only.
18. Obsolete Cloud-only SHAs remain in the original plan.
19. Local and runtime validation status must be recorded separately.
20. No Phase 3 work should begin.

---

# Phase status

| Phase | Name | Status | Working-tree result | Repository boundary |
| --- | --- | --- | --- | --- |
| 2c.0 | Inspect `main` and closed PRs | Complete | No code changes | Ops only |
| 2c.1 | Correct manifest schema and parquet statistics | Local validation complete, uncommitted | All tests pass, no sibling changes | Ops only |
| 2c.2 | Propagate evidence and correct planning | Not started |  | Ops only |
| 2c.3 | Complete stored-hash validation | Not started |  | Ops only |
| 2c.4 | Run full local validation and prepare handoff | Not started |  | Ops only |

Allowed status values:

```text
Not started
In progress
Blocked
Changes prepared, uncommitted
Local validation complete, uncommitted
Runtime validation pending
Runtime validation complete
```

After each phase:

1. update this table in the ops plan file;
2. update the implementation record;
3. list exact changed ops paths;
4. prove no sibling repository changed;
5. record tests;
6. produce the runtime handoff;
7. leave all changes uncommitted and unstaged;
8. do not push;
9. do not deploy;
10. stop after the requested phase.

---

# Phase 2c.0: Inspection record

## Status

```text
Complete
```

## Baseline

```text
main commit: ed9c9ab00f559ae31402e98aefcec2e214a750d2
```

## Findings

Current ops `main` contains the core Phase 2 read-only framework but not the complete corrections.

No implementation files were changed in this phase.

The ingest repository is not part of the implementation.

---

# Phase 2c.1: Correct manifest schema and parquet statistics

## Goal

Correct observation and AQI pollutant, connector and day validation within the ops repository only.

## Scope

### A. Domain-specific parent timestamps

Add required validation using the correct domain fields.

Expected shape, subject to writer confirmation:

```python
if domain == "observations":
    timestamp_fields = (
        ("min_observed_at_utc", "min_timestamp_utc"),
        ("max_observed_at_utc", "max_timestamp_utc"),
    )
elif domain == "aqilevels":
    timestamp_fields = (
        ("min_timestamp_hour_utc", "min_timestamp_utc"),
        ("max_timestamp_hour_utc", "max_timestamp_utc"),
    )
else:
    timestamp_fields = ()
```

Do not require the other domain's timestamp fields.

### B. Required parent aggregate fields

For writer-confirmed required fields, detect:

```text
missing
wrong type
incorrect value
```

Likely candidates:

```text
row_count
source_row_count
file_count
total_bytes
min_timeseries_id
max_timeseries_id
```

### C. Required pollutant fields

Confirm required fields from the ops writer.

Distinguish:

```text
missing
wrong type
invalid value
mismatch with parquet
```

Apply to observations and AQI.

### D. Missing versus zero

Required `row_count` behaviour:

```text
missing → schema mismatch
invalid type → schema mismatch
integer zero → data_partition_zero_rows only if forbidden by writer
positive integer → normal validation
```

### E. Zero-row policy

Confirm from:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
```

Do not inspect or modify ingest code.

### F. DuckDB statistics

Calculate separately:

```text
COUNT(*)
COUNT(timeseries_id)
null timeseries_id count
per-timeseries counts
min/max IDs
min/max timestamp
```

`row_count` must equal `COUNT(*)`.

Report:

```text
parquet_null_timeseries_id_rows
```

as a data fault.

### G. Empty-count terminology

Use:

```text
data_manifest_empty_timeseries_counts
```

for pollutant data manifests.

Keep index terminology for actual index manifests.

## Required tests

Add or adapt ops-repository tests for:

1. healthy observation connector parent;
2. healthy observation day parent;
3. healthy AQI connector parent;
4. healthy AQI day parent;
5. no cross-domain timestamp requirement;
6. missing connector `row_count`;
7. string connector `file_count`;
8. missing day `total_bytes`;
9. missing pollutant `row_count`;
10. invalid pollutant `row_count`;
11. genuine zero pollutant `row_count`;
12. missing `file_count`;
13. missing `total_bytes`;
14. missing required counts map;
15. optional min/max behaviour;
16. required min/max behaviour;
17. total rows include null IDs;
18. null count is correct;
19. null-ID gap emitted;
20. corrected data-manifest terminology;
21. index terminology retained;
22. observation and AQI parity.

## Validation commands

Run from the ops repository:

```bash
python3 -m py_compile   scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py   scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

```bash
python3 -m unittest   scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py   scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py   scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
```

```bash
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- all changes are inside `uk-aq-ops`;
- no ingest file changed;
- no sibling repository changed;
- schema and parquet corrections pass;
- no write behaviour added;
- changes remain uncommitted and unstaged;
- runtime handoff complete.

## Implementation record

Status:

```text
Local validation complete, uncommitted
```

Changed ops files:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
```

Sibling repository status comparison:

```text
Pre-phase: all sibling repos clean (no porcelain output)
Post-phase: TEST-uk-aq-ingest: clean, uk-aq-ingest: clean, TEST-uk-aq-schema: clean
No sibling repository changed during Phase 2c.1
```

Tests:

```text
Phase 2c.1 tests: 18 tests passed (test_v2_phase2_validation.py)
Full v2 suite: 120 tests passed (test_v2_*.py)
python3 -m py_compile: passed for both bin files
git diff --check: passed (after trailing whitespace fix)
```

Runtime handoff:

```text
Runtime files to copy:
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py

Development-only files (no copy needed):
  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
  plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md

Dependency changes: No dependency change
Runtime configuration impact: No runtime configuration change

Runtime validation commands:
  cd <INTEGRITY_INSTALL_DIR>
  source <RUNTIME_VENV>/bin/activate
  python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py

Expected result:
  Exit code: 0
  All Phase 2c.1 validation logic active
  No write behaviour added
  parquet_null_timeseries_id_rows emitted for null ID rows
  data_manifest_empty_timeseries_counts terminology used

Rollback files: None (first runtime copy; user backs up existing file before replacement)
```

---

# Phase 2c.1 Vibe Code prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md

Implement Phase 2c.1 only.

HARD REPOSITORY BOUNDARY:

The only repository you may modify is:

TEST-uk-aq/uk-aq-ops

Do not create, edit, delete, rename, format, generate, stage or otherwise modify any file in uk-aq-ingest, TEST-uk-aq-ingest, uk-aq-schema, TEST-uk-aq-schema, the website repo, or any sibling repository.

The ingest repository is completely out of scope. Do not search it or add anything to it.

Before every file write, confirm the resolved target path is inside the uk-aq-ops Git root. Do not follow symlinks outside that root.

Verify before editing:

pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch

Stop without editing if the repository is not TEST-uk-aq/uk-aq-ops on main.

Work only in the existing local main working tree.

Do not create a commit.
Do not amend a commit.
Do not create a tag.
Do not create or switch branches.
Do not stage files.
Do not push.
Do not deploy.
Do not apply SQL.
Do not copy files to the runtime machine.
Do not begin Phase 2c.2 or Phase 3.

Implement only:

1. domain-specific required parent timestamp validation;
2. required parent aggregate presence/type/value validation;
3. required pollutant manifest field validation;
4. missing versus invalid versus genuine zero handling;
5. total, non-null and null timeseries_id parquet statistics;
6. parquet_null_timeseries_id_rows;
7. data_manifest_empty_timeseries_counts terminology.

Inspect only the authoritative writer files inside uk-aq-ops.

Run the Phase 2c.1 tests and repository-boundary checks.

At the end:

- leave all changes uncommitted and unstaged;
- list every changed and untracked ops path;
- confirm no path outside uk-aq-ops changed;
- show read-only status comparisons for ingest and schema sibling repos;
- update the Phase 2c.1 record in this ops plan;
- provide the runtime handoff;
- stop.
```

---

# Phase 2c.2: Propagate source evidence and correct planning

## Goal

Ensure source and parquet evidence flows through the actual ops integrity runtime path.

## Scope

### A. Source states

Distinguish:

```text
successful non-empty
successful empty
connection unavailable
scope unavailable
metadata unavailable
pollutant absent
counts unavailable
```

Successful empty is authoritative.

Unavailable is not empty.

### B. One partition evidence object

Build a compact evidence object in the ops integrity checker.

### C. Evidence propagation

Attach evidence to relevant manifest, parquet and source mismatch gaps through the real runtime path.

Do not inject evidence manually in tests.

### D. Action precedence

Use:

```text
data fault > operator review > manifest-only
```

Do not emit contradictory actions for one scope.

### E. AQI planning

Do not plan AQI for:

```text
manifest-only
operator review
index-only
O3
```

All actions remain planned and non-executing.

## Required tests

Use ops tests for:

1. successful empty source plus parquet rows;
2. unavailable source plus parquet rows;
3. missing parquet plus unavailable source;
4. missing parquet plus source-proven rows;
5. manifest mismatch with matching parquet/source;
6. manifest mismatch with source disagreement;
7. orphan readable parquet;
8. unreadable parquet;
9. null-ID parquet rows;
10. no contradictory actions;
11. O3 manifest-only;
12. O3 operator review;
13. PM10 data fault;
14. all actions planned;
15. all actions non-executing.

## Validation commands

```bash
python3 -m unittest   scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
```

```bash
python3 -m unittest   scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
```

```bash
python3 -m unittest discover   -s scripts/uk-aq-history-integrity/tests   -p 'test_*.py'
```

```bash
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- ops files only;
- no ingest changes;
- evidence uses the real runtime path;
- action precedence is deterministic;
- no write behaviour;
- uncommitted and unstaged;
- runtime handoff complete.

## Implementation record

Status:

```text
Not started
```

Changed ops files:

```text
To be updated by Vibe Code.
```

Sibling repository status comparison:

```text
To be updated by Vibe Code.
```

Tests:

```text
To be updated by Vibe Code.
```

Runtime handoff:

```text
To be updated by Vibe Code.
```

---

# Phase 2c.2 Vibe Code prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md

Implement Phase 2c.2 only.

HARD REPOSITORY BOUNDARY:

Modify only TEST-uk-aq/uk-aq-ops.

Do not change or search uk-aq-ingest or TEST-uk-aq-ingest.
Do not modify uk-aq-schema, TEST-uk-aq-schema, the website repo, or any sibling repo.

Before every write, confirm the resolved path is inside the uk-aq-ops Git root.

Work on the existing local main working tree containing the reviewed Phase 2c.1 changes.

Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy files or begin Phase 2c.3.

Implement one real partition-evidence path.

Distinguish successful empty source counts from unavailable source evidence.

Propagate evidence to real runtime gaps.

Use action precedence:

data fault > operator review > manifest-only.

Prevent contradictory actions.

Keep all actions planned and non-executing.

Run the Phase 2c.2 tests and repository-boundary checks.

At the end:

- leave changes uncommitted and unstaged;
- list every changed and untracked ops path;
- confirm no path outside uk-aq-ops changed;
- show read-only sibling status comparisons;
- update this ops plan;
- provide the runtime handoff;
- stop.
```

---

# Phase 2c.3: Complete stored-hash validation

## Goal

Complete stored-hash presence and consistency validation inside the ops integrity checker only.

## Scope

Confirm the writer contract from ops files.

Detect:

1. child manifest missing its own required hash;
2. parent child-entry missing a required hash;
3. stored parent/child mismatch.

Use honest terminology.

Do not claim canonical recalculation.

## Required tests

Add ops tests for:

1. observation child hash missing;
2. AQI child hash missing;
3. connector child hash missing;
4. day child hash missing;
5. parent-entry hash missing;
6. stored mismatch;
7. healthy match;
8. optional absence where allowed;
9. observation/AQI parity;
10. documentation terminology.

## Validation commands

```bash
python3 -m unittest   scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py   scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py   scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
```

```bash
npm run check
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- ops files only;
- no ingest changes;
- missing hashes detected;
- mismatches detected;
- terminology accurate;
- no canonical claim;
- no writes;
- uncommitted and unstaged;
- runtime handoff complete.

## Implementation record

Status:

```text
Not started
```

Changed ops files:

```text
To be updated by Vibe Code.
```

Sibling repository status comparison:

```text
To be updated by Vibe Code.
```

Tests:

```text
To be updated by Vibe Code.
```

Runtime handoff:

```text
To be updated by Vibe Code.
```

---

# Phase 2c.3 Vibe Code prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md

Implement Phase 2c.3 only.

HARD REPOSITORY BOUNDARY:

Modify only TEST-uk-aq/uk-aq-ops.

Do not change or search the ingest repository.
Do not modify the schema repository, website repository or any sibling repository.

Before every write, confirm the target resolves inside the uk-aq-ops Git root.

Work on the existing local main working tree containing reviewed Phase 2c.1 and 2c.2 changes.

Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy files or begin Phase 2c.4.

Inspect only ops writer files.

Implement stored-hash presence and consistency validation.

Do not claim canonical recalculation.

Run the Phase 2c.3 tests and repository-boundary checks.

At the end:

- leave changes uncommitted and unstaged;
- list every changed and untracked ops path;
- confirm no path outside uk-aq-ops changed;
- show read-only sibling status comparisons;
- update this ops plan;
- provide the runtime handoff;
- stop.
```

---

# Phase 2c.4: Full local validation and runtime handoff

## Goal

Run all local tests from the ops repository and prepare manual runtime handoff.

## Schema repository rule

The schema repository may be read only for its canonical SQL file.

Do not edit it.

Do not copy files into it.

Do not create files in it.

Do not change its Git state.

## Scope

### A. DuckDB environment

Use the ops development environment.

Record DuckDB version.

### B. Real generated parquet tests

Run without skipping.

Do not leave generated files.

### C. Full suite

Run the ops integrity suite.

Use the sibling schema repository read only.

### D. Read-only behaviour

Confirm no R2 write or history mutation path was added.

### E. Plans

Update only plan files inside `uk-aq-ops`.

Remove obsolete Cloud-only SHAs.

State:

```text
Local validation complete, uncommitted
Runtime copy pending
Runtime validation pending
```

Do not insert a new commit SHA.

### F. Runtime handoff

Produce the final copy manifest and safe validation commands.

## Validation commands

```bash
python3 -m py_compile   scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py   scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
```

```bash
python3 -m unittest discover   -s scripts/uk-aq-history-integrity/tests   -p 'test_*.py'
```

```bash
npm run check
git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short
```

## Acceptance criteria

- every changed path is inside ops;
- ingest unchanged;
- schema unchanged;
- full tests pass;
- DuckDB tests run;
- read-only behaviour confirmed;
- plans accurate;
- no commit;
- no stage;
- no push;
- no deployment;
- runtime handoff complete.

## Implementation record

Status:

```text
Not started
```

Changed ops files:

```text
To be updated by Vibe Code.
```

Sibling repository status comparison:

```text
To be updated by Vibe Code.
```

DuckDB version:

```text
To be updated by Vibe Code.
```

Schema path used read-only:

```text
To be updated by Vibe Code.
```

Tests:

```text
To be updated by Vibe Code.
```

Runtime handoff:

```text
To be updated by Vibe Code.
```

Runtime validation:

```text
Pending user-run validation
```

---

# Phase 2c.4 Vibe Code prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md

Implement Phase 2c.4 only.

HARD REPOSITORY BOUNDARY:

The only writable repository is TEST-uk-aq/uk-aq-ops.

Do not change or search the ingest repository.
The schema repository may be read only for canonical SQL required by tests.
Do not modify the schema repository, website repository or any sibling repository.

Before every write, confirm the target resolves inside the uk-aq-ops Git root.

Work on the existing local main working tree containing reviewed Phase 2c.1, 2c.2 and 2c.3 changes.

Do not commit, stage, tag, branch, switch branches, push, deploy, apply SQL, copy files or begin Phase 3.

Run real DuckDB tests without skipping.

Run the full ops integrity suite.

Use the sibling schema repository read only.

Confirm read-only behaviour.

Update only ops plan and documentation files.

Remove obsolete Cloud-only SHAs.

State that local changes are validated but uncommitted and runtime validation is pending.

Run all repository-boundary checks.

At the end:

- leave changes uncommitted and unstaged;
- list every changed and untracked ops path;
- confirm no path outside uk-aq-ops changed;
- show read-only sibling status comparisons;
- provide DuckDB version and test counts;
- provide the final runtime handoff;
- stop.
```

---

# Final repository-boundary checklist

```text
[ ] Git root verified as TEST-uk-aq/uk-aq-ops
[ ] Origin verified as TEST-uk-aq/uk-aq-ops
[ ] Branch remained main
[ ] Every written path resolved inside the ops repository
[ ] No symlink outside ops was followed for writing
[ ] No workspace-wide formatter touched sibling repositories
[ ] No ingest repository file was read, searched or changed
[ ] No ingest repository file was created
[ ] No ingest repository file was deleted
[ ] No schema repository file was changed
[ ] Schema repository was read only where required
[ ] No website repository file was changed
[ ] No sibling repository Git state changed
[ ] Pre-phase and post-phase sibling statuses were compared
[ ] All changed tracked paths are ops-relative
[ ] All untracked paths are ops-relative
[ ] No branch was created
[ ] No tag was created
[ ] No commit was created
[ ] No file was staged
[ ] No push occurred
[ ] No PR was opened or modified
[ ] No deployment occurred
[ ] No SQL was applied
[ ] No runtime file transfer occurred
[ ] No R2 write behaviour was added
[ ] All requested tests passed
[ ] Runtime copy manifest was supplied
[ ] Runtime validation remains pending until the user runs it
```
