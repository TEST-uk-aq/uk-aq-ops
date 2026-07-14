# UK-AQ v2 Integrity Six-Stage Verification and Repair Plan

Generated: 13/07/2026  
Repository analysed: `TEST-uk-aq/uk-aq-ops`  
Branch analysed: `main`  
Scope: **v2 only**

Recommended repository location:

```text
plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md
```

---

# 1. Objective

Implement the agreed v2 Integrity flow in this exact order:

```text
1. Observs
2. Observs manifests
3. Observs indexes
4. AQI Levels
5. AQI Levels manifests
6. AQI Levels indexes
7. One final verification
```

Integrity must:

```text
verify all six areas
repair all six areas when --run-backfill is enabled
avoid rebuilding the same parent or index more than once
use source-cache and the Dropbox R2 backup as the normal verification base
use a sparse local overlay for objects changed during the current run
write repaired objects to Cloudflare R2 History
read each changed object back from R2 once to verify it
use the verified overlay copy for every later task in the same run
```

The current system remains v2-only.

Do not restore v1 or `both` handling.

---

# 2. Current online implementation analysis

This analysis is based on the online `main` branch of `TEST-uk-aq/uk-aq-ops`.

## 2.1 Current entrypoint

Current file:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

Online blob:

```text
a2f9da34c839eeddceb45681538866fda68c0b73
```

The current Python entrypoint already contains:

```text
v2 core import
source adapters and source-cache state
source-versus-observation comparison
v2 observation hierarchy validation
v2 AQI hourly validation
repair-plan generation
observation repair execution functions
AQI repair queue and execution functions
post-repair verification functions
daily task health reporting
```

The repair code was disconnected rather than removed.

The current main flow calls:

```text
run_v2_gap_backfills(... run_backfill=False)
queue_v2_aqi_rebuilds_from_integrity_gaps(... run_backfill=False)
```

This means current reports can plan repairs, but the existing observation and AQI specialists do not execute.

## 2.2 Current CLI state

The Python parser rejects:

```text
--run-backfill
```

The shell launcher also rejects it before Python starts.

Current launcher:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
```

Online blob:

```text
5bc3a52bb52ebe944e415939240eae6e4b7cc36f
```

The launcher must be changed so:

```text
--check-only remains read-only
--run-backfill enables the ordered v2 repair flow
--dry-run with --run-backfill plans the complete repair flow without writes
--check-only and --run-backfill cannot be used together
v1 and both remain rejected
```

## 2.3 Current observation and AQI specialist wrapper

Current file:

```text
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

Online blob:

```text
eac3758bf19de6b9676575c9fa31a4c3b0d8e9f0
```

The wrapper still contains the previous observation-only and AQI-only specialist commands, but an unconditional exit disables them.

The existing specialist modes are:

```text
--observs-only
--aqi-only
```

The underlying active writer is:

```text
scripts/uk_aq_backfill_local.sh
workers/uk_aq_backfill_local/run_job.ts
```

It supports:

```text
source_to_r2 + observations_only
r2_history_obs_to_aqilevels + aqilevels_only
v2 history paths
connector/day/timeseries scoping
```

The integrity wrapper currently performs a targeted index rebuild immediately after each specialist writer. That must change because the new order requires indexes to run only after all data and manifest work for the domain has finished.

## 2.4 Current repair planning

The Python repair planner already distinguishes:

```text
observation_data_repair
observation_pollutant_manifest_repair
observation_connector_manifest_repair
observation_day_manifest_repair
observation_index_repair

aqi_rebuild
aqi_pollutant_manifest_repair
aqi_connector_manifest_repair
aqi_day_manifest_repair
aqi_index_repair
```

This is suitable for the agreed six-stage flow.

The planner also correctly avoids AQI repair for unsupported pollutants and uses the v2 core mapping to determine AQI eligibility.

## 2.5 Current manifest and index executor

Current file:

```text
scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
```

Online blob:

```text
e80cdcfc199c60ba8e728deb1a5155f446b174c6
```

It currently:

```text
accepts a complete Integrity report
repairs v2 observation connector/day manifests
repairs observation indexes
stages parent/index proposals before writing
re-lists and re-reads children before parent writes
GETs each changed object after PUT and verifies the exact body
requires CIC-Test plus the CIC-Test bucket for writes
```

It currently does not repair:

```text
observation pollutant manifests
AQI manifests
AQI indexes as part of the same ordered Integrity flow
```

It also reads live R2 children while building its proposals. The new overlay design should replace repeated live reads with:

```text
verified overlay first
Dropbox backup second
```

R2 should still be used to upload and verify changed objects.

## 2.6 Current index builder

Current file:

```text
scripts/backup_r2/uk_aq_build_r2_history_index.mjs
```

Online blob:

```text
fc1f113e2fe7aa3c6b2c6b60ddeab2a899e4139a
```

It already supports:

```text
observations
aqilevels
targeted v2 updates
day range
connector scope
dry-run by default
write mode
```

This should remain the specialist index builder for stages 3 and 6.

It must be invoked once per final affected scope, not automatically after each data writer.

## 2.7 Current AQI validation

The current v2 AQI logic uses:

```text
timeseries_id + UTC-hour identity
```

It does not use raw observation-row parity.

This must be preserved.

## 2.8 Current Dropbox readiness gate

The current gate verifies that the configured backup task finished before Integrity started.

It does not yet prove that the backup began after:

```text
the latest ops.prune_daily attempt
the latest ops.r2_core_snapshot attempt
the previous non-dry-run repair-mode ops.history_integrity attempt
```

A new Integrity-specific readiness contract is required.

## 2.9 Current runtime deployment

The repository documentation describes a complete ops checkout as the runtime model.

The operational process also copies the updated:

```text
uk-aq-history-integrity.py
```

to the local runtime machine.

The implementation must therefore keep the online repository as the source of truth and include a deliberate runtime copy/sync step after code changes.

If new helper files are introduced, they must also be present in the complete runtime checkout. Prefer keeping the Python coordinator and overlay logic in `uk-aq-history-integrity.py` unless a separate helper is clearly justified.

---

# 3. Agreed data-source model

## 3.1 Normal verification base

Use:

```text
source-cache
+
R2_history_backup
```

Normal comparisons:

```text
Observs:
source-cache versus Dropbox observation parquet

Observs manifests:
Dropbox observation parquet and child manifests versus Dropbox parent manifests

Observs indexes:
Dropbox final observation manifests versus Dropbox observation indexes

AQI Levels:
expected UTC hours from final observs versus Dropbox AQI parquet

AQI Levels manifests:
Dropbox AQI parquet and child manifests versus Dropbox parent manifests

AQI Levels indexes:
Dropbox final AQI manifests versus Dropbox AQI indexes
```

## 3.2 Sparse local overlay

Create one run-specific directory:

```text
UK_AQ_HISTORY_INTEGRITY_TMP_DIR/
  run-<UTC>/
    overlay/
      history/
        v2/
        _index_v2/
    run-state.json
```

Do not copy complete days into the overlay.

Only store objects created or changed by the current run.

Combined local reads use:

```text
1. verified object in the run overlay
2. otherwise the corresponding object in R2_history_backup
```

Only an overlay object marked `r2_verified=true` may be used as a dependency for a later stage.

## 3.3 Cloudflare R2 use

For objects changed by Integrity:

```text
create final object locally
store it in the overlay
PUT it to Cloudflare R2 History
GET it back once
verify exact bytes/hash and expected structure
mark the overlay object verified
use the overlay for all later stages
```

Do not copy repaired objects into the Dropbox backup.

The next scheduled Dropbox backup will refresh the base before the next daily Integrity run.

## 3.4 Changed-scope sets

Maintain deterministic sets in memory and in `run-state.json`:

```text
OBSERVS_CHANGED
OBS_MANIFESTS_CHANGED
OBS_INDEXES_CHANGED
AQILEVELS_CHANGED
AQI_MANIFESTS_CHANGED
AQI_INDEXES_CHANGED
BLOCKED_SCOPES
```

Leaf scope:

```text
day_utc
connector_id
pollutant_code
timeseries_ids where applicable
```

Parent scopes are derived from the leaf sets.

---

# 4. Final run rules

## Check-only mode

```text
verify all six stages
produce all findings and proposed actions
do not create repair overlay objects
do not invoke data writers
do not PUT or DELETE R2 objects
```

## Repair dry-run

```text
--run-backfill --dry-run
```

It must:

```text
perform normal verification
construct the six-stage execution plan
show changed-scope sets
show overlay paths and proposed R2 keys
show dependency ordering
perform no R2 PUT or DELETE
```

## Repair mode

```text
--run-backfill
```

It must execute stages 1 to 6 in order, followed by one final verification.

## One repair pass only

Do not automatically begin a second repair loop.

If final verification still finds a fault:

```text
mark the run failed
report the exact remaining scope
retain the failed run overlay for investigation
```

---

# 5. Phase 1: implement the Integrity freshness gate

## Goal

Trust the Dropbox backup without broad preflight R2 reads.

Integrity may begin only when the latest successful real Dropbox backup started after all relevant R2 writer attempts finished.

Relevant writers:

```text
ops.prune_daily
ops.r2_core_snapshot
ops.history_integrity when a previous run was non-dry-run repair mode
```

## Required readiness rules

Block when:

```text
any relevant writer is still running
no successful real Dropbox backup exists
the backup started before or during the latest relevant writer attempt
the backup finished after the current Integrity run started
```

Prune Daily and core snapshot status do not need to be successful.

Any finished attempt counts because it may have written partially before failing.

For previous Integrity:

```text
only non-dry-run repair mode makes Dropbox stale
check-only and repair dry-run do not
```

The scheduled Sunday full backup uses the same Dropbox backup task and satisfies the gate when it is the latest qualifying successful backup.

## Implementation

Prefer a new canonical RPC in `uk-aq-schema`, rather than changing the existing date-based backup RPC in a way that affects other callers.

Suggested contract:

```text
uk_aq_public.uk_aq_rpc_history_integrity_readiness(
  p_integrity_started_at_utc timestamptz
)
```

Return:

```text
ready
blocked_reason
backup_run_id
backup_started_at
backup_finished_at
latest_writer_finished_at
writer_runs
```

The RPC should query the latest task attempts across dates.

Update the ops client, env templates and reports to use the new RPC.

Keep `--allow-stale-dropbox` as an explicit manual recovery override.

## Structural checks only

```text
SQL file is structurally valid
Python compiles
git diff --check
```

Do not build a large RPC test suite.

Functional validation happens by running scheduled-style Integrity on CIC-Test after deployment.

### Phase 1 implementation record (13/07/2026)

Implemented in the schema and ops source repositories:

- Added the dedicated canonical RPC
  `uk_aq_public.uk_aq_rpc_history_integrity_readiness(timestamptz)` in
  `schemas/obs_aqi_db/uk_aq_rpc_history_integrity_readiness.sql`. It uses
  `uk_aq_ops.daily_task_runs` across all dates, includes failed Prune Daily and
  core-snapshot attempts, blocks relevant running writers, and treats only
  non-dry-run repair-mode Integrity attempts as writers.
- Updated the Integrity caller and reports to use the RPC and record its backup
  and writer details. `--allow-stale-dropbox` remains an explicit override.
- Added `repair_mode` alongside the legacy `run_backfill` task-health summary
  field, so the gate can classify future repair runs while retaining old-row
  compatibility.
- Updated CIC-Test/LIVE env templates and current Integrity documentation. The
  general date-based backup-readiness RPC remains unchanged for other callers.

Structural validation completed: SQL reviewed; `python3 -m py_compile`,
`bash -n` for both env templates, and `git diff --check` passed. No Integrity
run, SQL apply, R2 contact, deployment, commit, staging, or push was performed.

## Recommended model

### Proposal-evidence corrective record — 2026-07-14

#### Application-evidence follow-up

- Blocked-day successful writes: **confirmed**. A top-level deterministic
  `application.operations` ledger now reports every staged proposal regardless
  of its day-plan status.
- Overlay overwrite by unattempted proposals: **confirmed**. Only succeeded
  PUT-and-GET-verified proposals replace authoritative overlay objects. Other
  proposals are recorded as non-authoritative evidence; attempted writes that
  lack exact GET verification are recorded as uncertain blockers.
- Partial application evidence: **confirmed**. Application stops at the first
  failure, reports prior successes, marks later proposals not-run due to
  dependency and retains the overall failure.
- Metadata operation import: **confirmed**. Python merges operation evidence by
  metadata key with deterministic identity unions rather than appending
  duplicates.

Structural checks passed: `py_compile`, both Node checks, both shell checks and
`git diff --check`. Aggregate expansion and affected-index schema enrichment
remain CIC-Test follow-up validation items. No SQL or operational command ran.

- Undefined final metadata-operation lookup: **confirmed**. Final verification
  now deterministically merges operation evidence by metadata key, unions
  replacement, removal and affected-index identities, and fails on conflicts.
- Broad affected-index validation: **confirmed**. Only operation-recorded index
  keys are required in the scoped final view; preserved historical entries do
  not require their out-of-window index files.
- Non-zero executor JSON discard: **confirmed**. Python retains valid JSON
  output, successful operations and blocked evidence even when the specialist
  exits non-zero.
- Partial application evidence: **confirmed**. The executor now returns the
  failed operation plus all earlier results, marks later proposals not-run due
  to dependency, and stops before dependent metadata/latest writes.

Structural checks passed: `py_compile`, both Node checks, shell syntax and
`git diff --check`. Aggregate-field expansion remains for CIC-Test validation;
no SQL or operational command was run.

```text
Codex: GPT-5.6 Terra
Reasoning: High
```

This phase crosses canonical SQL, task-health semantics and Python fail-closed behaviour.

## Codex prompt

```text
Model recommendation: GPT-5.6 Terra, High reasoning.

Implement Phase 1 of:

plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md

Inspect the complete plan first.

Repositories:
- TEST-uk-aq/uk-aq-schema for the canonical RPC SQL.
- TEST-uk-aq/uk-aq-ops for the Integrity caller, env templates, status reporting and plan record.

Do not search or modify archive/.

Create a new Integrity-specific readiness RPC rather than weakening unrelated backup-readiness callers.

The gate must use daily_task_runs and require the latest successful non-dry-run ops.r2_history_dropbox_backup to have started after the latest finished attempt of:

- ops.prune_daily;
- ops.r2_core_snapshot;
- ops.history_integrity only where the previous run was non-dry-run repair mode.

A failed writer attempt still makes an older Dropbox backup stale.
Block if a relevant writer is still running.
Require the backup to have finished before the current Integrity run started.

Return enough timestamps and task details for the Integrity report to explain the decision.

Update uk-aq-history-integrity.py, env templates and current docs to call the new RPC. Preserve --allow-stale-dropbox as an explicit manual override.

Use only structural checks:
- SQL structural review;
- python3 -m py_compile for changed Python;
- bash -n for changed shell/env files;
- git diff --check.

Do not run Integrity, deploy SQL, contact R2, commit, stage or push.

Update the Phase 1 implementation record in the plan and stop.
```

---

# 6. Phase 2: implement the sparse overlay and six-stage coordinator

## Goal

Create the common run state used by every repair stage.

## Required implementation

Add a v2 repair coordinator in:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

Preferred main function name:

```text
run_v2_integrity_repair_flow
```

Add overlay primitives:

```text
create_run_overlay
resolve_combined_local_path
stage_overlay_object
mark_overlay_uploaded
mark_overlay_verified
record_changed_scope
record_blocked_scope
write_run_state
```

`run-state.json` must record:

```text
run id
environment
base Dropbox root
overlay root
object key
local path
SHA-256
bytes
stage
dependencies
uploaded
R2 verification status
changed-scope sets
```

## Coordinator ordering

The coordinator must own this order:

```text
observs
observs manifests
observs indexes
aqilevels
aqilevels manifests
aqilevels indexes
final verification
```

The source adapters must not independently write during their scan.

Even in repair mode, run source adapters as evidence/cache collectors first.

All writes happen only through the ordered coordinator after detection is complete.

## CLI changes

Restore `--run-backfill` for v2.

Enforce:

```text
--check-only and --run-backfill are mutually exclusive
--run-backfill --dry-run plans repairs without writes
--run-backfill without --dry-run enables writes
v1 and both remain rejected
```

Do not execute any repair in this phase beyond wiring the coordinator skeleton.

## Structural checks only

```text
python3 -m py_compile
bash -n
git diff --check
```

A single direct CLI parse invocation is allowed to prove that valid v2 repair mode reaches preflight and invalid combinations reject.

Do not run the full test suite.

### Phase 2 implementation record (13/07/2026)

Implemented the Phase 2 v2 coordinator in
`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`:

- Added the sparse local run overlay and `run-state.json` primitives. The state
  records the run/environment/base and overlay roots, object hash/size/stage/
  dependency/upload/verification fields, changed-scope sets, and blocked scopes.
- Added overlay-first, Dropbox-second local resolution. Overlay entries are
  selected only after `r2_verified=true`; staging rejects copying a Dropbox
  backup object into the overlay.
- Restored v2 `--run-backfill` in both Python and the shell launcher, made it
  mutually exclusive with `--check-only`, and retained v2-only validation.
- Added the exact seven-stage coordinator order. Dry-run marks every stage
  planned; non-dry-run keeps every Phase 2 specialist stage not run. Neither
  path calls an R2 writer.
- Forced source adapters and the legacy v2 repair planners to remain
  `run_backfill=False` during detection, so all future writes remain owned by
  the coordinator.

Structural validation completed: `python3 -m py_compile`, `bash -n` for the
launcher and env templates, and `git diff --check` passed. No Integrity run,
R2 contact, deployment, commit, staging, or push was performed.

## Recommended model

```text
Codex: GPT-5.6 Terra
Reasoning: High
```

## Codex prompt

```text
Model recommendation: GPT-5.6 Terra, High reasoning.

Implement Phase 2 of:

plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md

Work in TEST-uk-aq/uk-aq-ops main.
Do not search or modify archive/.

Implement a sparse run overlay under UK_AQ_HISTORY_INTEGRITY_TMP_DIR. It must store only changed/generated objects and a run-state.json file.

Combined local reads must resolve:
1. verified overlay object;
2. otherwise R2_history_backup.

Do not update or copy repaired files into R2_history_backup.

Add one v2 repair coordinator that owns the exact stage order:

observs
→ observs manifests
→ observs indexes
→ aqilevels
→ aqilevels manifests
→ aqilevels indexes
→ final verification.

Restore --run-backfill in the Python parser and shell launcher for v2 only.
Make --check-only and --run-backfill mutually exclusive.
Allow --run-backfill --dry-run to plan the full flow without writes.

Important: the source adapters must remain read-only/cache-only during the initial scan. Do not let adapter-level run_backfill calls write before the coordinator starts.

Keep the coordinator stage bodies stubbed or not_run where later phases own the specialist integration. Do not re-enable the old unordered execution path.

Prefer keeping overlay/coordinator Python in uk-aq-history-integrity.py because that file is copied to the local runtime machine.

Use only:
- python3 -m py_compile;
- bash -n;
- one direct CLI parser/preflight invocation if needed;
- git diff --check.

Do not run Integrity against data, contact R2, deploy, commit, stage or push.

Update the Phase 2 implementation record and stop.
```

---

# 7. Phase 3: implement stages 1 to 3, Observs and observation metadata

## Goal

Reconnect the existing v2 observation repair specialist, then rebuild observation manifests and indexes once from the final observation state.

## Required structural inspection before editing

Inspect the current output contract of:

```text
workers/uk_aq_backfill_local/run_job.ts
scripts/uk_aq_backfill_local.sh
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

Confirm exactly which v2 observation objects are generated by `observations_only`.

This targeted inspection is necessary because the coordinator must not write the same manifest or index twice.

## Stage 1: Observs

Verification source:

```text
source-cache
versus
R2_history_backup observation parquet
```

For mismatches:

```text
group by day + connector
include affected pollutant and timeseries IDs
run one scoped v2 observation repair
generate final parquet locally in the overlay
upload to R2
GET and verify
add the leaf scope to OBSERVS_CHANGED
```

Use the existing chunking/staging support.

Extend the targeted stage so Integrity always uses the run overlay, not only multi-chunk repairs.

Observation repair must not immediately rebuild the final observation index.

Remove the unconditional disabled exit from the Integrity specialist wrapper and make it v2-only.

Remove unreachable v1 argument handling from that Integrity-specific wrapper.

## Stage 2: Observs manifests

For scopes in `OBSERVS_CHANGED`:

```text
rebuild pollutant manifests automatically from final overlay/base parquet
rebuild connector manifests once from the complete final pollutant set
rebuild day manifests once from the complete final connector set
```

For scopes not changed in stage 1:

```text
use the existing v2 validation findings
repair only manifest faults found in the command range
```

Extend or generalise the existing Phase 3 executor so it can rebuild observation pollutant manifests from the combined local view.

It must no longer block `observation_pollutant_manifest_repair`.

Build order:

```text
pollutant
→ connector
→ day
```

After each changed manifest:

```text
write overlay
PUT R2
GET R2
verify
mark overlay verified
```

## Stage 3: Observs indexes

Use the existing targeted v2 index builder.

Affected work set:

```text
observation index faults found during verification
union
days/parents changed by stage 2
```

Run once after all observation manifests for the affected day are final.

Do not rebuild observation indexes per pollutant or per observation chunk.

## Failure rules

```text
failed observation repair blocks stages 2 to 6 for that scope
failed observation manifest verification blocks observation indexes and AQI
failed observation index verification blocks AQI for that scope
unrelated scopes may continue
```

## Structural checks only

```text
python3 -m py_compile
bash -n
node --check for changed .mjs
deno check for changed .ts
git diff --check
```

Do not run the full Python or Node suites.

Do not perform a functional repair yet.

## Phase 3 implementation record — 2026-07-13

Implemented the first three coordinator stages in
`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` and the
observation specialist path.

- Inspected the `observations_only` contract before editing. The v2 writer
  emits pollutant-part parquet (`part-*.parquet`), then pollutant, connector,
  and day manifests; the local wrapper can also perform a full index rebuild.
  The Integrity wrapper now disables that full rebuild and no longer invokes a
  targeted index itself, leaving one post-manifest targeted index pass to the
  coordinator.
- Restored the v2-only Integrity specialist wrapper, retaining its observation
  and AQI modes while removing the disabled exit and unreachable v1 path.
- Reconnected the observation specialist only after read-only detection. It
  groups work by day/connector and preserves timeseries/pollutant detail,
  blocks non-ready source-cache scopes, and always enables the run overlay as
  its targeted local stage. Successful leaf scopes populate `OBSERVS_CHANGED`.
- The coordinator now invokes the observation metadata specialist after the
  observations stage. It supports pollutant-manifest actions, then connector
  and day manifests, and invokes the targeted observation index only after the
  day’s manifest work. Changed metadata/index proposals are persisted into the
  sparse overlay and verified execution results populate
  `OBS_MANIFESTS_CHANGED` / `OBS_INDEXES_CHANGED`.
- Failed observation repair blocks the metadata/index stages for that scope;
  AQI stages remain explicitly `not_run` for Phase 4.
- Updated the current operator docs and env-template comments to describe the
  active observation stages and the coordinator-owned index.

Structural checks passed:

```text
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
bash -n scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
deno check workers/uk_aq_backfill_local/run_job.ts
git diff --check
```

No Integrity run, R2 request, deployment, commit, stage, or push was performed.

### Phase 1 to 4 correction record — 2026-07-14

The Phase 1 to 4 implementation was corrected after a cross-stage review.

- The canonical Integrity readiness RPC now blocks a running Dropbox backup as
  `dropbox_backup_running` and returns its task details for reports. It remains
  separate from unrelated backup-readiness callers.
- Source-to-R2 writers retain their exact generated observation and AQI bytes
  in the sparse run overlay. Integrity compares each subsequent R2 GET with
  those bytes before marking the object verified; it no longer populates the
  overlay by copying a later live object.
- Metadata repair plans from the verified overlay plus Dropbox combined local
  view. It can reconstruct a faulty pollutant manifest when final parquet
  metadata is available and emits an exact blocked dependency reason when it
  is not. R2 is reserved for writes, GET verification and parent race guards.
- A successful observation repair no longer uses the legacy AQI queue path.
  The Phase 4 coordinator is the sole AQI queue owner, one connector/day.
- AQI writer-generated manifests are rebuilt and verified in pollutant,
  connector and day order before the targeted AQI index. Optional AQI debug
  output is captured only when `--require-aqi-debug` made it required.
- Repair-stage completion is reported as
  `repair_stages_completed_final_verification_pending`. Pre-repair gaps remain
  evidence for Phase 5 and do not alone make a completed coordinator run fail.

Structural checks passed: `py_compile`, `bash -n`, `node --check`, `deno check`
and `git diff --check` (including the schema repository). No Integrity run, R2
request, SQL apply, deployment, commit, stage or push was performed.

## Phase 5 implementation record — 2026-07-14

Implemented one final, read-only verification pass after the six ordered repair
stages.

- The final pass reuses the v2 validators against a disposable combined local
  view. It resolves verified overlay objects before Dropbox objects and uses
  source-cache for observation truth.
- It verifies observations, observation manifests and indexes, AQI Levels, AQI
  manifests and indexes. It records every remaining actionable scope by stage,
  plus the existing R2 GET verification evidence for each changed object.
- Remaining actionable gaps, unverified uploaded objects and blocked scopes
  make the coordinator fail, and the top-level process returns non-zero.
- Daily task-health summaries now include repair flags at start and R2 write
  attempt, changed-object count, six-stage counts, overlay path and remaining
  gap count at finish.
- Cleanup is deterministic: after reports for a successful non-dry-run repair,
  remove only `generated-objects` and the disposable verification view. Retain
  the sparse verified overlay and run state. Failed overlays are retained.

Structural checks passed: `py_compile`, `bash -n`, `node --check`, `deno check`
and `git diff --check`. No Integrity run, R2 request, deployment, commit, stage
or push was performed.

### Follow-up correction record — 2026-07-14

Analysis of the remaining six-stage issues:

- Issue 1, tombstones: **confirmed**. Targeted force-replace deletes were not
  represented in the combined local view. The writer now records successful,
  HEAD-confirmed deletes in targeted-stage metadata. Integrity imports them as
  verified tombstones, which hide stale Dropbox keys in Python, Node and final
  verification views without changing the backup.
- Issue 2, parquet-derived leaves: **confirmed**. The metadata executor reused
  manifest metadata. It now reads final local parquet parts with the existing
  `hyparquet` stack and derives row counts, hashes, bytes, time ranges and
  timeseries counts before rebuilding observation or AQI pollutant manifests.
- Issue 3, dependency propagation: **confirmed**. A blocked pollutant could
  leave parent proposals active. The affected connector, day and day index are
  now blocked, reported in the executor result and persisted to run state.
- Issue 4, full backup scans: **confirmed**. Node planning now scans only the
  requested day and index prefixes. Final verification links only the selected
  date range, indexes and latest index objects.
- Issue 5, stopped limits: **confirmed**. `stopped_limit` now survives a
  successful partial coordinator and returns non-zero.
- Issue 6, report state: **confirmed**. Completed repair reports retain
  `pre_repair` evidence but make the principal v2 status and displayed checks
  reflect final verification. Dry-runs remain explicitly planned only.
- Issue 7, task health: **confirmed**. `fail` and `stopped_limit` now use the
  daily-task failure RPC with the complete final summary.
- Issue 8, final scope: **partially confirmed**. The validators already checked
  standalone manifests, indexes, source cache and required debug. The scoped
  view now preserves those checks while adding tombstone exclusion and verified
  overlay precedence. No second repair loop was introduced.
- SQL compatibility: **not a confirmed schema issue**. The already-applied
  readiness RPC `running_backup_run` shape matches Python validation; failed,
  non-dry-run repair attempts remain freshness writers. No SQL change is needed.

Files changed for this correction are the Integrity Python coordinator, v2
metadata executor, local writer, current documentation and this plan. Structural
checks passed: `py_compile`, `bash -n`, `node --check`, `deno check` and
`git diff --check` in both repositories. No operational command was run.

### Final follow-up correction record — 2026-07-14

Analysis of the final runtime review:

- Issue 1, scoped local-object key construction: **confirmed**. The recursive
  scanner referenced a loop-local prefix outside its scope and could not return
  correctly keyed files. It now retains each full root-relative R2 key exactly
  once.
- Issue 2, observation parquet timestamp contract: **confirmed**. The v2
  writer emits `observed_at_utc`, while metadata repair read `observed_at`.
  Metadata repair now inspects the parquet schema, prefers `observed_at_utc`,
  accepts only legacy `observed_at`, and blocks the exact leaf with a precise
  missing-column reason otherwise.
- Issue 3, missing-pollutant dependency propagation: **confirmed**. A missing
  requested pollutant recorded a leaf block but did not always block its
  connector. It now blocks connector, day and targeted index proposals while
  retaining the leaf reason.
- Issue 4, exact global index baseline: **partially confirmed**. Day-prefix
  scans were already scoped, but the targeted index merge lacked the one global
  latest-index baseline it reads. The resolver now accepts explicit exact keys
  and loads only that observations or AQI latest-index object; no full index
  scan was added.
- Issue 5, changed-object accounting: **confirmed**. Reports counted verified
  writes but omitted verified deletion work. Final verification, reports and
  task-health summaries now expose verified writes, deletes and their
  de-duplicated total; delete-plus-recreate of the same key counts once.

No SQL change is required: this is a v2 runtime-only correction and the
existing readiness RPC contract remains compatible. Structural checks passed:
`python3 -m py_compile`, both required `node --check` commands, `deno check`,
both required `bash -n` commands, and `git diff --check`. No Integrity run, R2
request, SQL apply, deployment, commit, stage or push was performed.

### Index safety follow-up record — 2026-07-14

- Issue 1, global metadata rebuild from scoped Integrity input: **confirmed**.
  The targeted v2 update unconditionally called the full metadata rebuild even
  though the sparse resolver holds neither all historical days nor the other
  domain's data. Integrity now selects a targeted merge. Its identity is
  `domain`, `day_utc`, `connector_id`, `pollutant_code`; exact existing
  metadata retains untouched observation and AQI entries, then recalculates
  coverage. Missing or invalid metadata is `blocked_dependency`. The full
  rebuild remains available for callers with complete live-R2 evidence.
- Issue 2, required-child warnings: **confirmed**. Required day, connector and
  pollutant reads could be skipped while a latest summary continued. They now
  fail closed and become a structured blocked scope, with no latest or metadata
  proposal for that incomplete day.
- Issue 3, final metadata validation: **confirmed**. The final view exposed
  changed overlay bodies but did not validate global metadata. It now validates
  each changed metadata key exactly, including schema, identity, unique entries,
  aggregate counts and affected pollutant-index row counts.

Files changed: shared v2 index code, metadata executor, Integrity coordinator,
current documentation and this plan. Targeted local checks passed: a merge of
two observation and two AQI days replaced one observation day while retaining
the other three entries and recalculating aggregates; a missing required
connector emitted no latest-index proposal. SQL remains compatible and no SQL
was changed. First CIC-Test checks are a narrow repair dry-run showing affected
timeseries IDs and preserved/replaced counts, then an approved narrow repair
confirming GET verification and final metadata checks.

### Targeted metadata removal follow-up record — 2026-07-14

- Issue 1, removal-only IDs: **confirmed**. Planning now unions old and final
  pollutant-index IDs and removes only the matching full metadata identity.
- Issue 2, blocked metadata with staged indexes: **confirmed**. The executor
  removes every proposal from a blocked index plan before application.
- Issue 3, dry-run status: **confirmed**. Local-only metadata proposals report
  `planned`, never `succeeded`.
- Issue 4, local not-found handling: **confirmed**. `OBJECT_NOT_FOUND` reaches
  the shared fetch helper as an absent exact metadata object.
- Issue 5, removal verification: **partially confirmed**. Removal updates use
  normal changed-object evidence; final-empty metadata remains fail-closed as
  `timeseries_metadata_delete_required_not_supported` pending verified delete
  and tombstone support.
- Issue 6, tombstone fallback: **confirmed**. Tombstones are checked before
  dynamic Dropbox exact-key fallback.
- Issue 7, latest ordering: **confirmed**. Latest summaries apply after
  pollutant and metadata proposals, and no latest proposal survives a block.

Targeted local checks passed for removal-only preservation and final-empty
planning. No SQL change is required and no operational command was run.

### Final index-safety follow-up record — 2026-07-14

- Previous pollutant-index evidence: **confirmed**. Missing or invalid old
  timeseries counts now block with a precise reason rather than becoming `{}`.
- Proposal rollback: **confirmed**. Each day index plan snapshots the complete
  proposal map and restores it on a thrown planner error or metadata block,
  including overwritten multi-day latest proposals.
- Explicit ordering: **confirmed**. Application is deterministic by proposal
  kind: manifests, pollutant indexes, metadata, then latest summaries. Latest
  proposals record lower-level index/metadata dependencies.
- Final verification: **partially confirmed**. Changed metadata operations now
  persist expected hash plus replacement/removal identities and final checking
  requires the affected pollutant index. The existing unsupported final-empty
  deletion remains fail-closed.

Structural checks passed: `py_compile`, both Node checks, both shell checks and
`git diff --check`. No SQL change or operational command was performed.

## Recommended model

```text
Codex: GPT-5.6 Terra
Reasoning: High
```

## Codex prompt

```text
Model recommendation: GPT-5.6 Terra, High reasoning.

Implement Phase 3 of:

plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md

Work in TEST-uk-aq/uk-aq-ops main.
Do not search or modify archive/.

First inspect the exact v2 observations_only output contract in run_job.ts and the two shell wrappers. Record which parquet and manifest objects the writer already generates so no object is written twice.

Reconnect the existing v2 observation repair specialist under the Phase 2 coordinator.

Requirements:

- source adapters remain read-only during detection;
- group repair by day + connector with pollutant/timeseries detail;
- use source-cache as repair input;
- always use the run overlay as the local targeted stage;
- PUT changed observation objects to R2;
- GET and verify each changed object;
- mark verified objects in run-state.json;
- populate OBSERVS_CHANGED;
- do not run the final observation index from the data writer/wrapper.

Activate uk_aq_integrity_backfill.sh for v2 only. Remove its unconditional disabled exit and unreachable v1 handling. Preserve its specialist observation/AQI modes.

Then implement observation manifests and indexes:

- rebuild pollutant manifests from final combined overlay/Dropbox parquet;
- rebuild connector manifests once from the complete pollutant set;
- rebuild day manifests once from the complete connector set;
- repair unchanged-scope manifest faults found by Integrity;
- extend the Phase 3 executor so observation_pollutant_manifest_repair is supported rather than blocked;
- run targeted observation indexes once after all manifests for the affected day are final;
- upload and GET-verify every changed manifest/index object;
- populate OBS_MANIFESTS_CHANGED and OBS_INDEXES_CHANGED.

Apply dependency blocking exactly as the plan states.

Use only:
- py_compile;
- bash -n;
- node --check;
- deno check for changed TypeScript;
- git diff --check.

Do not run a real Integrity job, contact R2, commit, stage or push.

Update the Phase 3 implementation record and stop.
```

---

# 8. Phase 4: implement stages 4 to 6, AQI Levels and AQI metadata

## Goal

Reconnect the existing AQI specialist after observation data and metadata are final.

## Stage 4: AQI Levels

AQI-eligible pollutants come from the v2 core mapping.

For eligible scopes in `OBSERVS_CHANGED`:

```text
rebuild AQI automatically
```

Do not rely only on hour-count comparison because changed observation values may alter AQI while retaining the same hour identities.

For eligible scopes not in `OBSERVS_CHANGED`:

```text
verify expected UTC-hour identities against existing AQI
repair only AQI faults found
```

AQI work set:

```text
AQI-eligible leaf scopes derived from OBSERVS_CHANGED
union
AQI data faults detected in unchanged observation scopes
```

Run one AQI specialist repair per final connector/day scope.

AQI generation must use final repaired observations.

Preferred implementation:

```text
read final observations through the combined overlay/Dropbox resolver
```

If the current AQI writer cannot safely accept a local read adapter, the smallest acceptable fallback is:

```text
use the already uploaded and verified live R2 observations
```

Record any such live-R2 read exception in the implementation record.

The AQI writer must not immediately run the final AQI index.

After changed AQI parquet:

```text
store final generated objects in overlay
PUT R2
GET and verify
add to AQILEVELS_CHANGED
```

Preserve UTC-hour identity validation.

## Stage 5: AQI Levels manifests

For scopes in `AQILEVELS_CHANGED`:

```text
rebuild AQI pollutant manifests automatically
rebuild AQI connector manifests once
rebuild AQI day manifests once
```

For unchanged AQI data scopes:

```text
repair only AQI manifest faults detected by Integrity
```

Build order:

```text
AQI pollutant
→ AQI connector
→ AQI day
```

Use the combined overlay/Dropbox view.

## Stage 6: AQI Levels indexes

Use the existing targeted index builder with the AQI domain.

Affected work set:

```text
AQI index faults found during verification
union
days/parents changed by stage 5
```

Run once after final AQI manifests are complete.

## Failure rules

```text
AQI is blocked if observation stages are not verified
failed AQI data repair blocks AQI manifests/indexes
failed AQI manifests block AQI indexes
unsupported pollutants never enter stages 4 to 6
unrelated scopes may continue
```

## Structural checks only

```text
python3 -m py_compile
bash -n
node --check
deno check
git diff --check
```

No full test suites.

## Phase 4 implementation record — 2026-07-14

Implemented the ordered AQI stages in
`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` and extended
`scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs` into the shared
v2 metadata executor.

- AQI work is now the union of AQI-eligible `OBSERVS_CHANGED` leaves and
  executable AQI data faults from unchanged observation scopes. Eligibility is
  read from the v2 core mapping; unsupported or unmapped pollutants are not
  queued.
- The existing queue/execution specialist runs one v2 AQI rebuild per final
  connector/day after observation stages are verified. AQI rebuilds are
  triggered for eligible observation changes even when their UTC-hour identity
  is unchanged; unchanged scopes retain the existing UTC-hour validation.
- Narrow live-R2 exception: the current AQI writer only reads committed R2
  observations. Phase 4 uses the observation objects already PUT-and-GET
  verified by Phase 3, then GET-verifies every resulting AQI object into the
  sparse overlay. This avoids an unsafe local-reader rewrite in this phase.
- The AQI wrapper remains index-free. The generalized metadata executor repairs
  AQI pollutant/connector/day manifests for unchanged scopes and runs one
  targeted AQI index only after final manifests. Changed proposals are recorded
  in `AQI_MANIFESTS_CHANGED` and `AQI_INDEXES_CHANGED`; captured AQI data
  scopes populate `AQILEVELS_CHANGED`.
- Observation-stage, AQI-data, and AQI-metadata dependency failures block their
  downstream scope while unrelated connector/day scopes continue.

Structural checks passed:

```text
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
bash -n scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
node --check scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
deno check workers/uk_aq_backfill_local/run_job.ts
git diff --check
```

No Integrity run, R2 request, deployment, commit, stage, or push was performed.

## Recommended model

```text
Codex: GPT-5.6 Terra
Reasoning: High
```

## Codex prompt

```text
Model recommendation: GPT-5.6 Terra, High reasoning.

Implement Phase 4 of:

plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md

Work in TEST-uk-aq/uk-aq-ops main.
Do not search or modify archive/.

Reconnect the existing v2 AQI queue/execution specialist under the ordered coordinator, after observation data, manifests and indexes are verified.

Build AQI work as:

- all AQI-eligible leaf scopes derived from OBSERVS_CHANGED;
- plus AQI data faults detected for otherwise unchanged observation scopes.

Rebuild AQI automatically after eligible observation changes, even when UTC-hour identities are unchanged, because values may have changed.

Preserve the current UTC-hour identity validation for unchanged scopes and post-repair checks.

Run one AQI rebuild per final connector/day scope.

Prefer reading final observations through the combined overlay/Dropbox resolver. If adapting the writer safely would require a much larger rewrite, use the already uploaded and verified live-R2 observation scope and clearly record that narrow exception.

Do not run the final AQI index from the AQI data writer/wrapper.

Store changed AQI objects in the overlay, upload, GET-verify, and populate AQILEVELS_CHANGED.

Then implement AQI metadata:

- AQI pollutant manifests from final AQI parquet;
- AQI connector manifests once from the complete pollutant set;
- AQI day manifests once from the complete connector set;
- unchanged-scope AQI manifest repairs from existing Integrity findings;
- targeted AQI indexes once after all AQI manifests for the day are final;
- overlay + PUT + GET verification for each changed object;
- AQI_MANIFESTS_CHANGED and AQI_INDEXES_CHANGED.

Apply dependency blocking and skip unsupported pollutants.

Use only:
- py_compile;
- bash -n;
- node --check;
- deno check;
- git diff --check.

Do not run Integrity, contact R2, commit, stage or push.

Update the Phase 4 implementation record and stop.
```

---

# 9. Phase 5: final verification, status and cleanup

## Goal

Finish each repair run with one authoritative verification pass.

## Required final verification

After stages 1 to 6:

```text
verify source-cache against final observs
verify final observ manifests
verify final observ indexes
verify final AQI Levels
verify final AQI manifests
verify final AQI indexes
```

Use:

```text
source-cache for observation truth
verified overlay first
Dropbox backup second
```

For objects written during the run, retain the successful R2 GET verification evidence.

Do not perform another write loop.

## Final status

Success requires:

```text
no actionable gap in any of the six stages
all changed R2 objects verified
no blocked scope
```

Otherwise:

```text
status=failed
non-zero process exit
exact remaining scopes in report
```

## Daily task health

Start summary must include:

```text
check_only
repair_mode
dry_run
```

Final summary must include:

```text
r2_write_attempted
r2_objects_changed
six-stage result counts
overlay path
remaining gap count
```

The next run's readiness gate should treat a previous run as an R2 writer only when:

```text
repair_mode=true
dry_run=false
```

Conservatively, any such attempt makes an older Dropbox backup stale, even if the run failed.

## Overlay cleanup

```text
successful check-only: remove empty overlay
successful repair: remove generated object bodies after the final report is safely written, or retain them for a short configured period
failed repair: retain overlay and run-state.json for investigation
```

Choose the simplest deterministic policy and document it.

## Structural checks only

```text
python3 -m py_compile
bash -n
node --check
deno check
git diff --check
```

## Recommended model

```text
Codex: GPT-5.6 Terra
Reasoning: High
```

## Codex prompt

```text
Model recommendation: GPT-5.6 Terra, High reasoning.

Implement Phase 5 of:

plans/2026-07-12 Integrity/uk-aq-v2-integrity-six-stage-flow-plan-2026-07-13.md

Work in TEST-uk-aq/uk-aq-ops main.
Do not search or modify archive/.

Implement one final verification pass after all six repair stages.

It must verify:

observs
observs manifests
observs indexes
AQI Levels
AQI Levels manifests
AQI Levels indexes.

Use source-cache for observation truth and overlay-first/Dropbox-second for final local objects. Include existing R2 GET verification evidence for every uploaded object.

Do not start a second write loop. Any remaining actionable fault must fail the run, return non-zero, and identify the exact scope.

Update daily task health start/final summaries with:

check_only
repair_mode
dry_run
r2_write_attempted
r2_objects_changed
six-stage counts
overlay path
remaining gap count.

A previous non-dry-run repair-mode attempt must make an older Dropbox backup stale, even if the repair run failed.

Implement and document the smallest deterministic overlay cleanup policy. Retain failed overlays.

Use only:
- py_compile;
- bash -n;
- node --check;
- deno check;
- git diff --check.

Do not run Integrity, contact R2, commit, stage or push.

Update the Phase 5 implementation record and stop.
```

---

# 10. Phase 6: documentation and runtime handoff

## Goal

Update simple documentation and copy the completed implementation to the local runtime machine.

## Recommended worker

```text
Gemini Pro
```

Use Gemini Pro for:

```text
documentation-only updates
removing stale statements that --run-backfill is disabled
updating the six-stage flow description
updating env comments
producing the changed-file copy list
```

This work does not justify additional Codex High usage.

## Gemini Pro prompt

```text
Update current non-archive documentation for the completed UK-AQ v2 Integrity flow.

Use UK English and do not use em dashes.

Document this exact order:

Observs
Observs manifests
Observs indexes
AQI Levels
AQI Levels manifests
AQI Levels indexes
final verification.

Document:

- source-cache and R2_history_backup as the normal verification base;
- the sparse local overlay;
- overlay-first, Dropbox-second reads;
- PUT then GET verification for changed R2 objects;
- --check-only;
- --run-backfill --dry-run;
- --run-backfill;
- the daily task freshness gate;
- v2 only;
- no automatic second repair loop.

Remove stale current statements that --run-backfill is disabled.

Do not modify archive/.
Do not alter runtime code.
Run only git diff --check.
Do not commit, stage or push.
```

## Mike task: local runtime copy

The online repository remains the source of truth.

Use the existing local copy process to update the runtime machine.

At minimum copy/sync:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

Also copy/sync every changed support file reported by Codex, including any changed:

```text
scripts/backup_r2/*.mjs
workers/shared/*.mjs
workers/uk_aq_backfill_local/*.ts
workers/uk_aq_prune_daily/*.mjs
env templates where used
```

The runtime must remain a complete ops checkout.

Do not copy only the Python file if the implementation imports or invokes changed support files.

Update the ignored local CIC-Test env with new non-secret overlay/readiness variables while preserving secrets.

This is a Mike task and does not need Codex.

---

# 11. Phase 7: real CIC-Test validation

## Goal

Validate the implementation through real Integrity operations rather than a large mocked test suite.

## Worker

```text
Mike
```

Use Codex only if a real run reveals a clear code defect.

## Step 1: soundness on the runtime machine

Run only:

```text
python3 -m py_compile for the copied Python files
bash -n for copied shell files
node --check for copied Node files
deno check for copied TypeScript files
```

## Step 2: scheduled-style check-only run

Run after the scheduled Dropbox backup.

Do not use `--allow-stale-dropbox`.

Use a short known CIC-Test range first.

Confirm:

```text
readiness gate passes
v2 core imports
source-cache updates
Dropbox base is accepted
all six stages verify
no R2 write occurs
```

## Step 3: repair dry-run

Run:

```text
--run-backfill --dry-run
```

Confirm:

```text
six-stage order
changed-scope sets
proposed overlay files
proposed R2 keys
no PUT
no DELETE
one manifest/index rebuild per final affected scope
```

## Step 4: explicit approval

Stop and review the dry-run.

The first real CIC-Test repair write requires Mike's explicit approval.

## Step 5: real CIC-Test repair

Run:

```text
--run-backfill
```

Confirm:

```text
observ repairs complete before observ manifests
observ manifests complete before observ indexes
AQI repairs complete after final observ metadata
AQI manifests complete before AQI indexes
each changed object is GET-verified
one final verification runs
no second repair loop starts
```

## Step 6: next-day freshness proof

Allow the next scheduled Dropbox backup to run.

The next daily Integrity run should pass the readiness gate because the backup started after the previous repair-mode Integrity attempt.

The Sunday full backup also qualifies when it is the latest successful backup.

## Real-failure policy

When a real run exposes a clear defect:

```text
stop safely
identify the exact failed stage and scope
make the smallest correction
run only soundness checks
copy the changed file to the runtime machine
repeat the same real command
```

Do not create a broad pre-implementation or post-failure unit-test programme.

---

# 12. Minimal validation policy

## During implementation

Only:

```text
python3 -m py_compile
bash -n
node --check
deno check
SQL structural review
git diff --check
```

A single targeted parser or selector invocation is allowed where syntax alone cannot establish that the command is structurally reachable.

## Functional validation

All functional validation is through the real CIC-Test Integrity runs in Phase 7.

Do not require:

```text
the full Python suite
the full Node suite
large synthetic fixtures
speculative test matrices
```

## Exception

Add one small targeted regression only when a real CIC-Test run exposes a defect that cannot be safely reproduced by repeating the real scoped run.

Record why the targeted check is necessary.

---

# 13. Completion checklist

## Freshness

```text
[ ] new Integrity-specific readiness RPC exists
[ ] latest successful real Dropbox backup is newer than latest Prune Daily attempt
[ ] backup is newer than latest core snapshot attempt
[ ] backup is newer than previous non-dry-run repair-mode Integrity attempt
[ ] running writer tasks block Integrity
```

## Overlay

```text
[ ] sparse run overlay exists
[ ] overlay stores only changed/generated objects
[ ] overlay-first, Dropbox-second resolver exists
[ ] run-state.json records hashes, dependencies and verification
[ ] only R2-verified overlay objects feed later stages
```

## Six-stage flow

```text
[ ] --run-backfill is restored for v2
[ ] source adapters do not write during detection
[ ] Observs verify and repair
[ ] Observs manifests verify and repair bottom-up
[ ] Observs indexes verify and repair once
[ ] AQI Levels verify and repair
[ ] AQI Levels manifests verify and repair bottom-up
[ ] AQI Levels indexes verify and repair once
[ ] unsupported pollutants skip AQI
[ ] dependency failures block later stages
[ ] one final verification runs
[ ] no automatic second repair loop
```

## R2 writes

```text
[ ] every changed object is created locally first
[ ] every changed object is uploaded to the correct CIC-Test bucket
[ ] every changed object is read back and verified
[ ] repaired objects are not copied into R2_history_backup
[ ] no unnecessary repeated index rebuild occurs
```

## Runtime

```text
[ ] online repository contains final source
[ ] updated uk-aq-history-integrity.py is copied to the local runtime machine
[ ] all changed support files are synced to the complete runtime checkout
[ ] ignored CIC-Test env is updated without replacing secrets
```

## Real acceptance

```text
[ ] scheduled-style check-only run succeeds
[ ] repair dry-run shows correct six-stage order and zero writes
[ ] Mike explicitly approves the first repair write
[ ] real CIC-Test repair succeeds
[ ] final verification confirms all repaired scopes
[ ] next scheduled Dropbox backup refreshes the base
[ ] next daily Integrity readiness gate passes
[ ] no LIVE write occurs
[ ] no archive file changes
```

---

# 14. Model and usage summary

Use Codex only for the complex implementation phases:

```text
Phase 1: freshness RPC and fail-closed gate
Phase 2: sparse overlay and coordinator
Phase 3: Observs, manifests and indexes
Phase 4: AQI Levels, manifests and indexes
Phase 5: final verification and task-health integration
```

Recommended for every Codex phase:

```text
GPT-5.6 Terra
Reasoning: High
```

Use Gemini Pro for:

```text
documentation-only changes
simple current-status cleanup
env comment updates
changed-file handoff lists
```

Use Mike for:

```text
local runtime file copying
ignored env updates
running real CIC-Test commands
reviewing dry-run output
approving the first R2 write
checking next-day scheduled readiness
```
