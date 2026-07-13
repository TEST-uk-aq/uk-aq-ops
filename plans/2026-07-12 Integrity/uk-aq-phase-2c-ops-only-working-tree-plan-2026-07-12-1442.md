# UK-AQ Phase 2c Ops-Only Working-Tree Correction Plan for VS Code Codex

Generated: 12/07/2026 14:42 Europe/London

Plan filename:

```text
uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
```

Expected location inside the ops repository:

```text
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
```

> Historical implementation record. Current history-integrity phase status is
> authoritative only in `uk-aq-v2-history-integrity-phased-plan.md`.

# Critical repository boundary

## The only writable repository

Codex may change files only inside:

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

Codex must make code, test, plan and documentation changes only inside the ops repository.

Codex must not:

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

Codex works only in:

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

Codex must not:

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
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
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
21. Equivalent UTC timestamps can be falsely reported as mismatches because manifest and DuckDB timestamp strings are compared textually.
22. Empty parent manifests can be falsely reported as missing min/max IDs and timestamps when the writer correctly emits explicit nulls.
23. Required `files` arrays are not clearly validated for presence and type.
24. Archive snapshot changes and untracked archive copies remain in the working tree and must be classified before Phase 2c.1 is accepted.

---

# Independent review of the first Phase 2c.1 implementation

Reviewed: 12/07/2026 14:42 Europe/London

The reported validation commands were independently reproduced:

```text
27 focused tests passed
71 combined Phase 2c.1 tests passed
py_compile passed
git diff --check passed
```

Those results show that the first correction pass substantially improved the checker, but they do not prove the implementation matches the writer contract in all cases. The following findings must be independently confirmed by Codex and then corrected where confirmed.

## Finding 1: semantic timestamp comparison is still required

Current validation appears to compare timestamp values as raw strings. Equivalent representations can therefore be reported as mismatches, for example:

```text
manifest: 2026-06-11T00:00:00Z
DuckDB:   2026-06-11 00:00:00+00
```

The comparison must parse supported timestamp representations, normalise them to UTC and compare instants. It must not silently accept malformed timestamps.

## Finding 2: empty parent null aggregates need writer-compatible handling

The writer can emit explicit null values for min/max IDs and timestamps when no child value exists. A genuinely empty parent with correct zero counts must not receive schema findings merely because these aggregate values are null.

The checker must distinguish:

```text
aggregate expected from children -> field required, correctly typed and equal
no aggregate exists -> explicit writer-compatible null accepted
required field absent entirely -> report only if the writer contract requires field presence
```

## Finding 3: required `files` field presence and type

Pollutant, connector and day manifests created by the ops writer include a `files` array. The checker must clearly distinguish:

```text
files missing
files has the wrong type
files is a valid empty array where the writer permits it
files contains entries that disagree with actual parquet
```

Missing or wrongly typed `files` must produce a schema finding rather than being silently normalised to an empty list.

## Finding 4: archive working-tree hygiene

The reported working tree includes tracked and untracked archive snapshot paths. Codex must classify each one before changing it:

```text
archive/2026-07-12/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
archive/2026-07-12/plans/
archive/2026-07-12/scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
```

Do not delete or restore an archive path merely because it is under `archive/`. Determine whether it was created by this Phase 2c work, whether it was pre-existing, and whether it contains unrelated user work. Remove or revert only accidental Phase 2c archive copies after recording the evidence and exact safe action.

---

# Phase status

| Phase | Name | Status | Working-tree result | Repository boundary |
| --- | --- | --- | --- | --- |
| 2c.0 | Inspect `main` and closed PRs | Complete | No code changes | Ops only |
| 2c.1 | Correct manifest schema and parquet statistics | Local validation complete, uncommitted | Timestamp normalization, null-aggregate handling, and `files` validation corrected; focused and full v2 tests passed | Ops only |
| 2c.2 | Propagate evidence and correct planning | Not started |  | Ops only |
| 2c.3 | Complete stored-hash validation | Local validation complete, uncommitted | Stored-hash presence and consistency validation added and verified; focused phase tests and `npm run check` passed | Ops only |
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

### H. Semantic UTC timestamp comparison

Confirm the current comparison path before editing. Where timestamps represent the same instant, formatting differences must not create a mismatch.

Required behaviour:

```text
Z and +00:00 forms for the same instant -> equal
space and T separators for the same instant -> equal
equivalent non-UTC offsets -> equal after UTC normalisation
different instants -> mismatch
missing required timestamp -> schema finding
malformed timestamp -> schema finding
```

Use one shared parser/normaliser where practical. Do not compare timestamps solely through raw string equality.

### I. Empty parent min/max and timestamp rules

Inspect the actual v2 writer constructors. When the calculated child aggregate is null, accept the writer-compatible explicit null. When child data supplies an aggregate, require a valid value and compare it.

Do not turn a valid empty parent into four false schema findings.

### J. Required `files` arrays

Validate `files` explicitly on pollutant, connector and day manifests for both observations and AQI.

Required distinctions:

```text
missing -> schema mismatch
wrong type -> schema mismatch
valid list -> continue content and aggregate validation
valid empty list -> accepted only where compatible with the writer and partition state
```

### K. Archive working-tree classification

Inspect the reported archive changes without modifying sibling repositories. Record whether each archive path is:

```text
pre-existing unrelated work
intentional retained snapshot
accidental Phase 2c copy
```

Do not clean unrelated work. Remove or restore only confirmed accidental Phase 2c archive changes and report the exact commands used.

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
22. observation and AQI parity;
23. observation timestamp `2026-06-11T00:00:00Z` equals DuckDB `2026-06-11 00:00:00+00`;
24. equivalent timestamps with different UTC offsets compare equal;
25. genuinely different timestamp instants produce a mismatch;
26. malformed required timestamp produces a schema finding;
27. empty observation parent with zero aggregates and explicit null min/max fields is healthy;
28. empty AQI parent with zero aggregates and explicit null min/max fields is healthy;
29. non-empty parent missing required min/max data still fails;
30. `files` missing and wrongly typed are reported for pollutant, connector and day manifests;
31. observation and AQI `files` validation parity.

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
- timestamp comparisons are semantic UTC comparisons rather than raw string comparisons;
- equivalent timestamp representations do not create false mismatches;
- malformed timestamps are not silently accepted;
- valid empty parents accept writer-compatible explicit null min/max values;
- non-empty parents still require and validate min/max values;
- required `files` arrays are validated for presence and type at pollutant, connector and day levels;
- archive paths are classified and only confirmed accidental Phase 2c copies are removed or reverted;
- no write behaviour added;
- changes remain uncommitted and unstaged;
- runtime handoff complete.

## Implementation record

Status:

```text
Local validation complete, uncommitted
```

Current reported working-tree paths:

```text
M  archive/2026-07-12/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
D  plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1133.md
M  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
M  scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
M  scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
M  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
?? archive/2026-07-12/plans/
?? archive/2026-07-12/scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
?? "plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md"
```

The archive paths above were classified as intentional retained snapshots. No archive path was removed or reverted, and none is a runtime copy target.

Sibling repository status comparison:

```text
Reported clean before and after the correction pass.
Codex repeated the read-only comparison during the correction pass and the sibling repositories remained unchanged.
```

Tests already reported and independently reproduced:

```text
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
Ran 29 tests: OK

python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
Ran 73 tests: OK

python3 -m py_compile ...
passed

git diff --check
passed
```

Independent review result:

```text
The correction pass is complete for Phase 2c.1.
Blocking issues resolved: semantic timestamp comparison, empty-parent explicit null aggregate handling, and required files array presence/type validation.
Archive paths were classified as intentional retained snapshots and left untouched.
```

Runtime handoff:

```text
Runtime copy remains pending for the user-managed handoff.
Runtime validation commands are documented in the phase section above.
No dependency change identified.
No runtime configuration change identified.
```

---

# Phase 2c.1 correction Codex prompt

```text
Read the complete updated plan:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md

Continue Phase 2c.1 only. Do not start Phase 2c.2, Phase 2c.3, Phase 2c.4 or Phase 3.

HARD REPOSITORY BOUNDARY

The only writable repository is:

TEST-uk-aq/uk-aq-ops

Do not create, edit, delete, rename, format, generate, stage or otherwise modify any file in an ingest repository, schema repository, website repository or any sibling repository. The schema repository may be read only where an existing test requires its canonical SQL. Do not search or modify the ingest repository.

Before reading implementation files or making any change, run:

pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git status --short --branch

Continue only when the Git root is TEST-uk-aq/uk-aq-ops, origin is https://github.com/TEST-uk-aq/uk-aq-ops.git and the branch is main. Work with the existing uncommitted Phase 2c.1 changes.

Do not commit, amend, tag, branch, switch branches, stage, push, deploy, apply SQL, copy runtime files, mutate history data or perform R2 writes.

FIRST: INDEPENDENTLY CONFIRM THE REVIEW FINDINGS

Do not blindly implement the findings. Inspect the current working-tree code, the tests and the authoritative writer in:

workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/shared/
scripts/backup_r2/

For each finding below:

1. identify the exact current function and comparison path;
2. identify the relevant writer contract;
3. add or run a minimal regression test that demonstrates the problem where possible;
4. record in the updated plan whether the finding is confirmed, partly confirmed or not confirmed;
5. if not confirmed, explain the evidence and do not make an unnecessary change.

Finding A: timestamp values are compared as raw strings

Confirm whether equivalent timestamp representations such as these currently produce a false mismatch:

manifest: 2026-06-11T00:00:00Z
DuckDB:   2026-06-11 00:00:00+00

Also test equivalent offsets, for example 2026-06-11T01:00:00+01:00 versus 2026-06-11 00:00:00+00.

Finding B: empty parent explicit null aggregates

Confirm whether a valid empty observation or AQI parent with row_count=0, source_row_count=0, file_count=0, total_bytes=0, files=[] and writer-compatible explicit null min/max fields receives false schema findings. Confirm the exact writer behaviour for field presence and null values.

Finding C: required files arrays

Confirm whether a missing or wrongly typed files field is silently normalised to an empty list instead of producing a clear schema finding. Confirm the files contract for pollutant, connector and day manifests in both domains.

Finding D: archive working-tree paths

Inspect these reported paths and classify each as pre-existing unrelated work, intentional retained snapshot or accidental Phase 2c copy:

archive/2026-07-12/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
archive/2026-07-12/plans/
archive/2026-07-12/scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py

Do not delete, restore or clean unrelated work. Remove or revert only a confirmed accidental Phase 2c archive copy, and record the evidence and exact command.

SECOND: FIX EVERY CONFIRMED FINDING

1. Timestamp comparison

Use a shared timestamp parser/normaliser where practical. Parse supported ISO-8601 forms, including Z and explicit offsets, normalise timezone-aware values to UTC and compare instants. Do not rely on raw string equality. Do not silently accept malformed values. Preserve domain-specific field names:

observations: min_observed_at_utc, max_observed_at_utc
aqilevels: min_timestamp_hour_utc, max_timestamp_hour_utc

Required behaviour:

- equivalent representations compare equal;
- equivalent offsets compare equal;
- different instants produce a mismatch;
- missing required values produce schema findings;
- malformed required values produce schema findings.

2. Empty parent aggregates

When child aggregation produces a real min/max value, require the parent field to contain a correctly typed equivalent value. When child aggregation produces no value, accept the explicit null representation used by the writer. Treat a completely missing field according to the confirmed writer contract. Do not weaken non-empty validation.

3. files validation

Validate files explicitly for pollutant, connector and day manifests in observations and AQI:

- missing -> schema mismatch;
- wrong type -> schema mismatch;
- valid list -> continue existing content, aggregate and parquet checks;
- valid empty list -> accept only when compatible with the writer and the manifest/partition state.

Do not let a malformed files field masquerade as a healthy empty list.

4. Archive hygiene

Apply only the safe actions supported by the classification. Keep unrelated user work untouched. The final report must distinguish intended live changes from archive paths.

REQUIRED REGRESSION TESTS

Add focused tests for at least:

1. 2026-06-11T00:00:00Z equals 2026-06-11 00:00:00+00;
2. equivalent non-UTC offsets compare equal after UTC normalisation;
3. genuinely different instants produce a timestamp mismatch;
4. malformed required timestamp produces a schema finding;
5. empty observation connector/day parents with explicit null min/max fields are healthy;
6. empty AQI connector/day parents with explicit null min/max fields are healthy;
7. non-empty parent missing required min/max fields still fails;
8. files missing and files wrong type fail clearly at pollutant, connector and day levels;
9. observation and AQI parity;
10. no duplicate findings for one malformed field.

Run:

python3 -m py_compile \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py

python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py

python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py \
  scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py \
  scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py

git diff --check
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
git status --short

Repeat the read-only sibling status checks from the plan and compare them with the starting output.

PLAN UPDATE AND STOP CONDITION

Update this new plan file only, not the old 11:33 plan. Record:

- analysis confirmation for each finding;
- exact writer evidence;
- exact files changed;
- tests and counts;
- skipped tests, if any;
- archive classification and safe actions;
- remaining limitations;
- runtime/development split.

Mark Phase 2c.1 as Local validation complete, uncommitted only if every confirmed blocker is fixed and all acceptance criteria pass. Otherwise leave it In progress or Blocked.

Do not copy the runtime checker yet. Leave all changes uncommitted and unstaged. Stop after reporting the Phase 2c.1 correction result.
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
Local validation complete, uncommitted
```

Changed ops files:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
```

Sibling repository status comparison:

```text
git -C ../TEST-uk-aq-ingest status --porcelain -> clean
git -C ../TEST-uk-aq-schema status --porcelain -> clean
git -C ../TEST-uk-aq status --porcelain -> clean
```

Tests:

```text
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py -> passed
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py -> 76 tests passed
npm run check -> passed
```

Runtime handoff:

```text
Runtime file to copy:
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
Development-only files:
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md
Dependency impact:
No dependency change.
Runtime configuration impact:
No runtime configuration change.
Safe read-only validation:
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
npm run check
Rollback file:
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

---

# Phase 2c.2 Codex prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md

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
To be updated by Codex.
```

Sibling repository status comparison:

```text
To be updated by Codex.
```

Tests:

```text
To be updated by Codex.
```

Runtime handoff:

```text
To be updated by Codex.
```

---

# Phase 2c.3 Codex prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md

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
To be updated by Codex.
```

Sibling repository status comparison:

```text
To be updated by Codex.
```

DuckDB version:

```text
To be updated by Codex.
```

Schema path used read-only:

```text
To be updated by Codex.
```

Tests:

```text
To be updated by Codex.
```

Runtime handoff:

```text
To be updated by Codex.
```

Runtime validation:

```text
Pending user-run validation
```

---

# Phase 2c.4 Codex prompt

```text
Read the complete file:

plans/2026-07-12 Integrity/uk-aq-phase-2c-ops-only-working-tree-plan-2026-07-12-1442.md

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
