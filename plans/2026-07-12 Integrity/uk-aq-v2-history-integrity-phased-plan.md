# UK-AQ v2 History Integrity Improvement Plan

## Document purpose

This plan breaks the v2 history integrity work into four controlled phases so that each safety boundary can be reviewed and tested before the next one begins.

The work spans:

```text
TEST-uk-aq-ops
TEST-uk-aq-schema
```

Primary integrity code:

```text
TEST-uk-aq-ops/scripts/uk-aq-history-integrity
```

Relevant supporting code may also exist under:

```text
TEST-uk-aq-ops/workers/uk_aq_prune_daily
TEST-uk-aq-ops/workers/shared
TEST-uk-aq-ops/scripts/backup_r2
```

Canonical database SQL belongs in:

```text
TEST-uk-aq-schema/schemas/obs_aqi_db
```

A matching deployable copy may also exist in:

```text
TEST-uk-aq-ops/scripts/uk-aq-history-integrity/sql
```

The two SQL copies must remain semantically identical.

---

## Overall objective

Build a reliable v2 integrity flow that:

1. only scans the Dropbox history mirror after the required daily backup tasks have completed successfully;
2. validates actual observation and AQI storage against pollutant, connector and day manifests;
3. compares source data with actual parquet content rather than trusting manifest-declared counts alone;
4. distinguishes data faults, manifest-only faults and index-only faults;
5. repairs observation manifests and indexes safely without dropping valid sibling pollutants;
6. repairs observation data only where source-versus-parquet comparison proves it is necessary;
7. queues AQI rebuilding only after verified observation data changes for an AQI-enabled pollutant;
8. verifies every changed object directly against live R2;
9. produces reports that clearly separate detection, planning, execution and verification.

Accuracy and data safety take priority over speed.

## Plan validation record

Repository validation on 2026-07-12 confirmed that the phased design is the
recommended implementation approach, with these corrections to the original
Phase 1 assumptions:

- inventory generation and Dropbox sync are ordered steps in one GitHub
  workflow, not separate daily-health tasks;
- the authoritative factual task key is `ops.r2_history_dropbox_backup`;
- the real table is `uk_aq_ops.daily_task_runs`;
- valid factual statuses are `Started`, `Finished`, and `Failed`;
- readiness requires the latest attempt to have status `Finished`;
- the real completion column is `finished_at`;
- latest-attempt ordering is `attempt DESC, updated_at DESC`;
- the workflow reports its final `Finished` status only after inventory build
  and inventory-driven Dropbox sync both complete successfully;
- the exposed RPC schema is `uk_aq_public`;
- the project-authoritative Obs AQI credentials are
  `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY`, with established
  daily-task-health and generic fallback names retained for compatibility.

The implementation must use that single workflow task key. The earlier guessed
keys `r2_backup_inventory` and `r2_history_dropbox_sync` are not valid
`daily_task_definitions` keys and must not be used.

## Implementation options and impact assessment

### Option A — retain the four safety-gated phases (recommended)

Pros:

- each write capability is introduced only after its read and verification
  dependencies are tested;
- Phase 1 adds one small Obs AQI PostgREST response per scheduled integrity run;
  this is negligible Supabase endpoint-response egress and does not change the
  website's fixed one-minute polling requirement;
- Phase 2 is read-only and primarily reads the local Dropbox mirror; source
  adapter traffic must be measured separately and must not be described as
  Supabase egress unless it is an actual Supabase response;
- Phases 3 and 4 can minimize R2 Class B reads and Worker requests by limiting
  fresh verification to affected objects while still proving every repair;
- no phase aggregates, downsamples, or removes raw history granularity;
- Phase 1 adds no database tables or rows, so its database-size impact is zero
  apart from existing daily-task health rows already written by scheduled jobs;
- later report/ledger growth is bounded metadata, while repaired R2 data keeps
  raw observation granularity.

Cons:

- more review and deployment checkpoints;
- Phase 2 parquet validation can increase local I/O and temporary/report size;
- fresh live-R2 verification in Phases 3 and 4 adds targeted R2 read operations.

### Option B — combine validation and repair in one release

Pros:

- fewer implementation handoffs;
- potentially shorter elapsed development time.

Cons:

- materially higher risk of rewriting valid parquet or dropping sibling
  pollutants before hierarchy classification is proven;
- harder to distinguish detection egress/cost from repair and verification
  traffic;
- potentially much larger one-time R2 operation counts and repair output;
- greater risk of unintended storage growth from duplicate or unnecessary
  rewrites, while offering no legitimate database-size benefit.

Recommendation: use Option A. Its small Phase 1 Supabase response-egress cost
and zero schema-size growth are preferable to the R2 operation, storage, and
data-integrity risks of a combined release.

Operational note: local implementation and mocked/fixture tests do not grant
permission to execute live-R2 writes or CIC-Test cloud smoke tests. Phases 3 and
4 must not be marked operationally verified until the user explicitly grants
the corresponding execution permission and fresh remote verification succeeds.

---

## Known failure case

The immediate fault involved:

```text
history version: v2
domain: observations
day: 2026-05-17
connector: 1
pollutant: o3
```

A valid O3 pollutant partition and pollutant manifest existed, but the parent connector manifest omitted O3 from one or more of its representations. The observation index builder therefore failed to discover O3 and the corresponding O3 index was missing.

The new integrity flow must detect and repair this hierarchy without:

- rewriting valid O3 parquet;
- dropping valid sibling pollutants;
- triggering an unnecessary AQI rebuild for O3.

---

# Phase status

| Phase | Name | Status | Completion commit | Notes |
| --- | --- | --- | --- | --- |
| 1 | Backup gate correctness and safety | Complete | `6965763` | Committed on `main`; implementation and local validation complete. |
| 2 | Complete read-only v2 validation | Complete | `4438499` | Implemented on main across `7e1b352..4438499`; local validation complete; runtime Phase 2 validation remains pending. |
| 3 | Observation manifest and index repair | Not started |  |  |
| 4 | Observation data repair and AQI sequencing | Not started |  |  |

Allowed status values:

```text
Not started
In progress
Blocked
Complete
```

After completing a phase, Codex must:

1. update this table;
2. add the completion commit;
3. update the phase's “Implementation record” section;
4. record tests and exact outcomes;
5. record any changes to later phases caused by what was learned;
6. avoid marking a phase complete if any acceptance criterion remains unmet.

---
# Phase 1: Backup gate correctness and safety

## Goal

Make the scheduled-run Dropbox backup readiness gate correct, secure and testable before it is used operationally.

This phase must not change parquet, manifests, indexes or live R2 history data.

## Scope

### 1. Confirm the real system contract

Read and confirm:

- the actual daily task health table;
- exact task health columns;
- valid status values;
- exact task keys used for:
  - R2 backup inventory generation;
  - R2-to-Dropbox history sync;
- the PostgREST-exposed schema;
- the current Obs AQI DB credential variables;
- existing RPC request conventions;
- existing `SECURITY DEFINER`, `search_path`, revoke and grant conventions.

Search at least:

```text
daily_task_runs
daily_task_health
r2_backup_inventory
r2_history_dropbox_sync
build_backup_inventory
sync_history_to_dropbox
OBS_AQIDB_SUPABASE_URL
OBS_AQIDB_SECRET_KEY
```

Confirmed contract:

```text
table: uk_aq_ops.daily_task_runs
task key: ops.r2_history_dropbox_backup
success status: Finished
completion column: finished_at
latest attempt: attempt DESC, updated_at DESC
```

Do not leave guessed task keys or guessed column names in the implementation.

### 2. Fix the RPC request body

The Python request must send all required arguments:

```json
{
  "p_scheduled_for_date": "YYYY-MM-DD",
  "p_integrity_started_at_utc": "UTC ISO-8601 timestamp",
  "p_task_keys": ["task_a", "task_b"]
}
```

Validate:

- scheduled date format;
- UTC timestamp format;
- non-empty task-key list.

### 3. Select the correct PostgREST schema

Use the established schema, expected to be:

```text
uk_aq_public
```

Send:

```text
Accept-Profile: uk_aq_public
Content-Profile: uk_aq_public
```

Prefer the existing schema constant rather than duplicating a literal.

### 4. Resolve credentials correctly

Support the established Obs AQI DB variables, including the confirmed project names.

Expected candidates may include:

```text
DAILY_TASK_HEALTH_SUPABASE_URL
OBS_AQIDB_SUPABASE_URL
SUPABASE_URL
UK_AQ_SUPABASE_URL
```

and:

```text
DAILY_TASK_HEALTH_SUPABASE_SERVICE_ROLE_KEY
OBS_AQIDB_SECRET_KEY
OBS_AQIDB_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_SERVICE_ROLE_KEY
UK_AQ_SUPABASE_SERVICE_ROLE_KEY
```

Confirm the authoritative order from the repository.

Confirmed precedence is dedicated daily-task-health variables, then the Obs
AQI project variables, then established generic compatibility fallbacks. The
backfill environment is loaded before this resolution.

The backfill environment file must be loaded before credential resolution.

Never log secret values.

### 5. Correct the SQL

Maintain matching definitions in:

```text
TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql
TEST-uk-aq-ops/scripts/uk-aq-history-integrity/sql/uk_aq_rpc_daily_task_backup_readiness.sql
```

Requirements:

- exact real table and column names;
- exact real success status;
- latest-run semantics;
- task completion before integrity start;
- safe fixed `search_path`;
- private table references fully qualified;
- `REVOKE ALL ... FROM PUBLIC`;
- `GRANT EXECUTE ... TO service_role`;
- no unnecessary writable `public` schema in `search_path`.

### 6. Scheduled-run behaviour

For non-manual profiles:

```text
backup inventory
→ Dropbox sync
→ integrity gate
→ Dropbox scan
```

If backup readiness fails:

```text
status = blocked_backup_not_ready
```

The run must stop before:

- opening or scanning the Dropbox history tree;
- importing the core snapshot;
- running source adapters;
- running cross-checks;
- attempting repairs.

`--allow-stale-dropbox` must remain an explicit recovery override and must be recorded in reports.

## Out of scope

Do not implement in Phase 1:

- new hierarchy validation;
- parquet reads;
- manifest repair;
- index repair;
- AQI repair;
- live-R2 history writes.

## Required tests

Add tests proving:

1. all three RPC parameters are sent;
2. the endpoint is correct;
3. method is `POST`;
4. `Accept-Profile` is correct;
5. `Content-Profile` is correct;
6. API key and bearer token are set;
7. Obs AQI DB credentials are resolved;
8. the backfill env is loaded before credential resolution;
9. missing credentials block safely;
10. empty task keys block safely;
11. RPC HTTP failure blocks safely;
12. unexpected response shape blocks safely;
13. latest unsuccessful task blocks;
14. task completion after integrity start blocks;
15. stale-backup override passes and is recorded;
16. scheduled entry point stops before Dropbox scanning.

## Validation commands

```bash
python3 -m py_compile   scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

```bash
python3 -m unittest discover   -s scripts/uk-aq-history-integrity/tests   -p 'test_*.py'
```

```bash
git diff --check
```

Run repository static checks where applicable:

```bash
npm run check
```

Do not apply SQL during implementation.

## Acceptance criteria

Phase 1 is complete only when:

- the Python RPC request matches the SQL signature;
- the correct PostgREST schema is selected;
- actual Obs AQI DB credentials are resolved;
- actual task keys are confirmed;
- the two SQL copies match;
- a scheduled run cannot scan Dropbox when the backup is not ready;
- the full integrity test suite passes, or any unrelated pre-existing failure is identified precisely;
- no live deployment has been performed.

## Implementation record

Status:

```text
Complete
```

Completed work:

```text
- Confirmed the real daily-task table, columns, statuses and workflow task key.
- Corrected both SQL copies to use latest-attempt semantics, Finished and finished_at.
- Removed writable public and private schemas from the SECURITY DEFINER search_path.
- Added all three RPC arguments and uk_aq_public PostgREST profile headers.
- Added authoritative Obs AQI credential resolution after backfill-env loading.
- Added fail-closed validation for dates, UTC timestamps, task keys, HTTP errors and response shape.
- Moved the scheduled backup gate ahead of Dropbox-inspecting preflight.
- Kept --allow-stale-dropbox explicit and report-visible.
- Updated env examples, master env documentation and integrity documentation.
- Created required 2026-07-12 pre-change archive snapshots in ops and schema repos.
```

Tests:

```text
- python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py: PASS
- python3 -m unittest scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py: PASS (18 tests)
- python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py': PASS (203 tests)
- npm run check: PASS
- cmp of ops and canonical readiness SQL: PASS (byte-identical)
- git diff --check: PASS in both ops and schema repos
```

Remaining issues:

```text
- Completion commit: 6965763.
- No remaining Phase 1 implementation issue is recorded.
- Phases 3-4 remain separate and are not enabled by Phase 1.
```

---
# Phase 2: Complete read-only v2 validation

## Goal

Make the v2 checker accurately describe the real state of observations and AQI before any new repair execution is enabled.

Phase 2 must remain strictly read-only.

## Scope

### 1. Actual storage discovery

Start from actual folders and files in the scoped Dropbox mirror.

Do not discover children only from parent manifests.

Validate both:

```text
history/v2/observations
history/v2/aqilevels/hourly/data
```

Keep AQI debug optional according to:

```text
--check-aqi-debug
--require-aqi-debug
```

### 2. Pollutant manifest validation

Validate:

- manifest existence;
- valid JSON;
- kind, version, domain, profile and grain;
- path-versus-manifest day, connector and pollutant;
- actual versus listed parquet files;
- duplicate file keys;
- file count;
- byte count;
- row count;
- source row count where applicable;
- per-timeseries row counts;
- min/max IDs and timestamps where supported;
- deterministic hash where the writer contract permits it.

Use clear gap types, including:

```text
data_manifest_missing
data_manifest_invalid_json
data_manifest_unlisted_parquet
data_manifest_listed_parquet_missing
data_manifest_duplicate_file_key
data_manifest_file_count_mismatch
data_manifest_total_bytes_mismatch
data_manifest_row_count_mismatch
data_manifest_timeseries_row_count_mismatch
data_manifest_path_mismatch
data_manifest_hash_mismatch
```

### 3. Connector manifest validation

Report:

```text
connector_manifest_missing
```

Compare actual child pollutant manifests independently against:

```text
pollutant_codes
child_manifests
pollutant_manifests
files
```

Validate confirmed aggregates such as:

```text
row_count
source_row_count
file_count
total_bytes
timeseries range
timestamp range
child hashes
parquet keys
```

Run connector validation exactly once per connector-day.

### 4. Day manifest validation

Report:

```text
day_manifest_missing
```

Compare actual connector manifests independently against:

```text
connector_ids
child_manifests
connector_manifests
files
```

Validate confirmed day aggregates.

### 5. Actual parquet comparison

Use DuckDB, PyArrow or the existing supported parquet reader to calculate actual per-timeseries row counts from parquet.

Keep three comparisons separate:

```text
source vs actual parquet
actual parquet vs pollutant manifest
pollutant manifest vs parent hierarchy
```

Classify both source-only and R2-only differences.

### 6. Fault classification

Classify findings as:

```text
data fault
pollutant manifest-only fault
connector manifest-only fault
day manifest-only fault
index-only fault
metadata-only fault
source mapping issue
source unavailable
```

A missing or invalid manifest with valid readable parquet must be manifest-only.

### 7. Repair plan only

Produce an ordered, deduplicated repair plan.

Do not execute writes.

Each action should include:

```text
kind
day_utc
connector_id
pollutant_code
data_changes_required
requires_index_rebuild
gap_types
status = planned
```

## Out of scope

Do not implement in Phase 2:

- R2 PUT or DELETE operations;
- manifest rewriting;
- index rewriting;
- AQI execution;
- live-R2 repair verification.

## Required tests

Cover at least:

- missing connector manifest;
- missing day manifest;
- every independent connector representation;
- every independent day representation;
- no duplicate connector gaps;
- row, file and byte aggregate mismatches;
- zero-value aggregate handling;
- child hash mismatch where supported;
- manifest count matches source but parquet differs;
- parquet matches source but manifest differs;
- R2-only rows;
- source-only rows;
- unreadable parquet;
- valid parquet plus missing manifest classified as manifest-only;
- O3 manifest-only finding does not plan AQI.

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
```

## Acceptance criteria

Phase 2 is complete only when:

- the checker starts from actual storage;
- actual parquet counts are used;
- missing parent manifests are detected;
- connector and day representations are checked independently;
- parent aggregate validation is implemented for confirmed schema fields;
- findings are correctly classified;
- repair plans are deterministic and non-executing;
- observations and AQI receive equivalent hierarchy validation;
- all tests pass;
- no history writes occur.

## Implementation record

Status:

```text
Complete
```

Completed work:

```text
- Phase 2 implementation is committed on main.
- The code series landed across `7e1b352..4438499`.
- Local non-DuckDB validation completed with 249 tests passing and zero skips.
- `py_compile` passed.
- `git diff --check` passed.
- The runtime Python DuckDB dependency has now been installed separately on the test integrity machine, but no real integrity run was performed in this planning task.
```

Tests:

```text
- python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py: PASS
- python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q: PASS (249 tests, 0 skips)
- git diff --check: PASS
```

Remaining issues:

```text
- Runtime Phase 2 validation remains pending until the integrity command is run.
- No Phase 3 write behaviour has been executed.
```

---
# Phase 3: Observation manifest and index repair

## Goal

Safely repair observation manifest-only and index-only faults without rewriting valid observation parquet.

## Scope

### 1. Bottom-up manifest rebuilding

Implement or reuse authoritative writer-compatible helpers for:

```text
pollutant manifest from actual parquet
connector manifest from all valid live pollutant manifests
day manifest from all valid live connector manifests
```

Prefer existing Node writers and R2 helpers.

Requirements:

- use all actual live-R2 children;
- validate children before using them;
- preserve valid siblings;
- deterministic ordering;
- writer-compatible hashes;
- byte-stable output;
- skip unchanged PUTs;
- refuse partial parent replacement;
- support dry-run;
- structured machine-readable output.

### 2. Observation repair order

```text
pollutant manifest
→ connector manifest
→ day manifest
→ observation index
→ latest index
→ metadata
→ live-R2 verification
```

Only repair the levels that are incorrect, while still rebuilding dependent parents when necessary.

### 3. O3 acceptance case

For:

```text
day = 2026-05-17
connector = 1
pollutant = o3
```

with valid O3 parquet and pollutant manifest but incomplete connector hierarchy:

- do not rewrite O3 parquet;
- preserve all siblings;
- rebuild connector with every live pollutant child;
- rebuild day with every live connector child;
- rebuild O3 observation index;
- refresh relevant metadata;
- verify live R2;
- do not queue AQI.

### 4. Live-R2 verification

After writes, perform fresh live-R2 GET/LIST checks.

Verify:

```text
pollutant manifest
connector manifest
day manifest
pollutant index
latest index references
timeseries metadata
```

Do not use the stale Dropbox mirror as proof of repair.

### 5. Action statuses

Track:

```text
planned
executing
skipped_unchanged
succeeded
failed
blocked_dependency
```

Report separately:

```text
repair_plan
repair_execution
post_repair_live_verification
```

## Out of scope

Do not implement in Phase 3:

- source-driven parquet repair;
- AQI data rebuild execution;
- AQI manifest repair execution.

## Required tests

Cover at least:

- O3 parent-manifest repair;
- no O3 parquet rewrite;
- all siblings preserved;
- connector rebuilt once;
- day rebuilt once;
- unchanged generated manifest skips PUT;
- failed connector rebuild blocks day and index;
- failed live verification marks repair failed;
- check-only performs no writes;
- dry-run performs no writes;
- live-R2 verification uses fresh remote reads.

## Acceptance criteria

Phase 3 is complete only when:

- manifest-only observation faults can be executed safely;
- parent manifests are built from complete live child sets;
- valid siblings cannot be dropped;
- indexes are rebuilt only after manifests are correct;
- live-R2 verification proves the repair;
- the exact O3 failure is covered end to end;
- AQI is not triggered by manifest-only observation work.

## Implementation record

Status:

```text
Not started
```

Completed work:

```text
To be updated after implementation.
```

Tests:

```text
To be updated after implementation.
```

Remaining issues:

```text
To be updated after implementation.
```

---
# Phase 4: Observation data repair and AQI sequencing

## Goal

Add safe source-driven observation data repair and dependent AQI rebuilding after observation-side behaviour is proven.

## Scope

### 1. Observation data repair

Repair observation parquet only when actual source-versus-parquet comparison proves a data fault.

For an affected pollutant:

1. repair only the affected pollutant data;
2. rebuild its pollutant manifest;
3. preserve all valid siblings;
4. rebuild connector once from all live pollutant children;
5. rebuild day once from all live connector children;
6. rebuild observation indexes and metadata;
7. verify observations directly against live R2.

### 2. AQI eligibility

Use the authoritative DB-backed or shared AQI eligibility source.

Expected current pollutant set may be:

```text
pm25
pm10
no2
```

Confirm rather than assume.

O3 must not queue AQI under the current implementation.

### 3. AQI dependency rule

Queue AQI only when:

- observation data actually changed;
- the pollutant is AQI-enabled;
- observation repair succeeded;
- observation live-R2 verification succeeded.

Manifest-only and index-only observation repairs must not queue AQI.

### 4. AQI repair sequence

```text
verified observation repair
→ AQI data rebuild where required
→ AQI pollutant manifest
→ AQI connector manifest
→ AQI day manifest
→ AQI index
→ AQI latest index
→ AQI metadata
→ AQI live-R2 verification
```

Support AQI manifest-only repair without rewriting valid AQI parquet.

### 5. Dependency blocking

If observation repair or verification fails:

```text
AQI status = blocked_dependency
```

Do not execute dependent AQI actions.

## Required tests

Cover at least:

- PM10 data repair with valid O3 sibling;
- only PM10 parquet changes;
- O3 remains untouched;
- connector contains all valid pollutants;
- AQI queues only for PM10;
- observation verification happens before AQI;
- observation verification failure blocks AQI;
- O3 data or manifest work does not queue AQI;
- AQI manifest-only repair preserves valid parquet;
- AQI parent rebuild preserves siblings;
- AQI live verification failure marks failure;
- check-only and dry-run perform no writes.

## Acceptance criteria

Phase 4 is complete only when:

- source-driven observation repair is proven;
- only affected pollutant data is rewritten;
- sibling preservation is guaranteed;
- AQI is dependency-gated on verified observation change;
- AQI manifest-only faults avoid unnecessary parquet rebuilds;
- both observation and AQI chains are verified directly against live R2;
- reporting clearly distinguishes all execution and verification outcomes.

## Implementation record

Status:

```text
Not started
```

Completed work:

```text
To be updated after implementation.
```

Tests:

```text
To be updated after implementation.
```

Remaining issues:

```text
To be updated after implementation.
```

---

# Rules applying to every phase

## Safety

- Do not deploy SQL unless explicitly instructed.
- Do not write to LIVE during development.
- Use CIC-Test for any later smoke tests.
- Do not log credentials.
- Do not overwrite local-only environment files.
- Do not introduce secrets into Git.
- Do not claim a repair succeeded until live-R2 verification passes.

## Branching

Prefer one branch or PR per phase:

```text
fix/history-integrity-backup-gate
improve/history-integrity-v2-validation
feature/history-integrity-observation-repair
feature/history-integrity-aqi-repair
```

Do not mix later-phase changes into an earlier phase unless required to make the earlier phase correct.

## Documentation

Update:

```text
docs/history-integrity.md
system_docs/uk-aq-r2-history-integrity.md
```

Document only implemented behaviour.

Do not describe planned execution as if it already exists.

## Final review for each phase

Before finishing a phase:

1. review `git status`;
2. review the complete diff;
3. run the full integrity test suite;
4. run `git diff --check`;
5. confirm no secrets were added;
6. confirm no unrelated files changed;
7. update this plan's status and implementation record;
8. state any changes required to later phases.

---

# Phase 1 Codex task instruction

When asked to implement Phase 1, Codex should:

1. read this entire plan;
2. work only within Phase 1 scope;
3. leave Phases 2 to 4 unchanged except for justified plan clarifications;
4. implement and test the backup gate fixes;
5. update the Phase 1 status and implementation record;
6. record the exact commit or branch;
7. report any blockers honestly;
8. not deploy or push unless explicitly instructed.
