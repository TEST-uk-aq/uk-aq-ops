# UK-AQ v2 History Integrity: Remaining Implementation and Acceptance Plan

Generated: 13/07/2026 14:06 Europe/London  
Repository: `TEST-uk-aq/uk-aq-ops`  
Branch: `main`  
Scope: **current v2 history-integrity implementation only**

Recommended repository location:

```text
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-remaining-implementation-plan-2026-07-13-1406.md
```

---

# 1. Purpose

This plan replaces the remaining-work sections of the earlier blocker plan.

It starts from the current local implementation state after Phases 8 and 9:

```text
current integrity entrypoint is v2-only
history/v2/core is the required core snapshot
the integrity checker is read-only
the old --run-backfill route is rejected
the Phase 3 executor owns v2 observation manifest/index finalisation
AQI completeness uses expected UTC-hour identities
the full Python suite currently has 10 stale-fixture failures
no real CIC-Test acceptance has run
```

The goal is to finish a coherent v2-only system with:

```text
a read-only integrity checker
a complete, non-executing v2 repair plan
one dedicated v2 repair orchestrator
authoritative specialist writers behind that orchestrator
safe dry-run and write gates
mandatory post-repair verification
successful local validation
real CIC-Test acceptance
```

The old integrity-controlled `--run-backfill` route must remain unavailable. It must not be restored as a broad master write switch.

---

# 2. Non-negotiable architecture

## 2.1 Integrity checker

The current integrity checker must:

```text
read source evidence
read v2 core and v2 history
derive observation and AQI findings
produce a deterministic v2 repair plan
write only local state, logs and reports
never invoke observation, manifest, index or AQI writers
```

Supported history mode:

```text
v2 only
```

The current CLI must reject unsupported history modes before preflight or scanning.

## 2.2 Core snapshot

The authoritative current core snapshot path is:

```text
R2_history_backup/history/v2/core
```

Required CIC-Test path:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core
```

Required LIVE template path:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/R2_history_backup/history/v2/core
```

No current integrity configuration, test, fixture, documentation or fallback may select another core version.

## 2.3 Repair execution

There must be one dedicated v2 repair orchestrator, separate from the checker.

The orchestrator controls:

```text
repair-plan validation
scope selection
dry-run preview
environment and bucket gates
dependency ordering
specialist-writer invocation
verification
status and exit propagation
idempotence
```

Specialist writers may remain separate:

```text
source-to-v2 observation data writer
Phase 3 observation manifest/index executor
v2 hourly AQI writer
post-repair integrity checker
```

Only the orchestrator decides when they execute.

## 2.4 Safety boundaries

Default mode:

```text
dry-run
```

A real write requires:

```text
explicit --write-r2
UK_AQ_ENV_NAME=CIC-Test
resolved bucket=uk-aq-history-cic-test
an explicit selected scope
a compatible current v2 integrity report
no unsupported action within the selected scope
```

This plan does not authorise:

```text
LIVE repair execution
LIVE R2 mutation
SQL deployment
automatic commit, stage, push, branch or pull request creation
archive changes
```

---

# 3. Current remaining blockers

## Blocker 1: ten stale AQI fixtures

The full Python integrity suite currently reports 10 failures.

The failures are in:

```text
scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py
```

Affected tests:

```text
test_eligible_observation_still_requires_aqi_manifest
test_v2_aqi_integrity_reports_missing_aqi_against_existing_observations

test_v2_aqi_rebuild_queue_executes_connector_scoped_rebuild
test_v2_aqi_post_rebuild_validation_fails_when_manifest_missing_after_obs_repair
test_v2_aqi_post_rebuild_validation_fails_when_rows_below_observations
test_v2_aqi_post_rebuild_validation_passes_with_manifest_rows_covering_pm_observations
test_v2_aqi_post_rebuild_validation_resolves_dropbox_root_and_dir_without_absolute_root
test_v2_aqi_integrity_gap_queues_and_executes_aqi_only_rebuild
test_v2_aqi_integrity_reason_gets_post_rebuild_validation
test_v2_observation_then_aqi_queue_executes_r2_rebuild_after_rows_written
```

These fixtures use count-only pseudo-parquet evidence. The Phase 9 implementation correctly requires valid:

```text
timeseries_id
UTC hour
finite non-negative source value
AQI-eligible pollutant identity
actual AQI hour identity
```

The tests must be updated. Production code must not be weakened to restore count-only parity.

## Blocker 2: disabled wrapper retains dead legacy code

The integrity-specific backfill wrapper exits before work but retains unreachable argument-processing and legacy execution code.

Required decision:

```text
if no current caller needs the wrapper:
    delete it and remove current references
else:
    replace it with a minimal explicit disabled wrapper
```

Do not remove generic backfill writers used outside integrity.

## Blocker 3: stale plan records

The current blocker plan contains stale statements, including resolved blockers still listed as remaining.

The authoritative status must be corrected so that:

```text
Phases 8 and 9 are locally implemented
Phase 10 is incomplete only because of the 10 fixture failures and dead wrapper cleanup
the single v2 repair orchestrator is identified as remaining implementation
real CIC-Test acceptance is pending
```

## Blocker 4: no complete v2 repair orchestrator

The old integrity `--run-backfill` route was correctly disabled, but no replacement currently owns the full v2 repair sequence.

The current system can repair supported observation manifest/index faults through the Phase 3 executor, but there is no single validated route for:

```text
observation data repair
post-data manifest/index finalisation
dependent AQI repair
mandatory final integrity verification
```

This is not a reason to restore `--run-backfill`.

A dedicated orchestrator must be implemented.

## Blocker 5: safe scope selection is not guaranteed

The complete integrity report may contain:

```text
the wanted O3 manifest/index action
unrelated data-repair actions
operator-review actions
other connector/day/pollutant scopes
```

A write must not require manually editing the report.

The orchestrator and the Phase 3 handoff must support deterministic explicit selection by:

```text
day_utc
connector_id
pollutant_code where applicable
action family
```

Requirements:

```text
select before any R2 request
reject unsupported actions inside the selected scope
report ignored out-of-scope actions
require at least one selected action
preserve the original report as authoritative input
```

## Blocker 6: local CIC-Test env is incomplete

The ignored local file exists:

```text
scripts/uk-aq-history-integrity/env/CIC-Test.env
```

It does not currently declare:

```text
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT
```

Before a real run it must resolve to:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core
```

Do not print or overwrite secrets.

## Blocker 7: no real v2 acceptance evidence

Still pending:

```text
real v2 core import
real DuckDB parquet read
current one-day repair plan
real CIC-Test Phase 3 dry-run
approved O3 manifest/index write
post-write integrity
idempotent rerun
real AQI hourly-grain check
```

---

# 4. Phase A: repair stale tests and remove dead integrity code

## Goal

Return the current v2-only checker and test suite to a coherent state without changing the accepted hourly AQI contract.

## A1. Update AQI integrity fixtures

For every failed AQI integrity test:

1. Create source observation fixture rows with:
   ```text
   explicit UTC timestamps
   valid timeseries IDs
   finite non-negative values
   supported pollutant codes where AQI is expected
   ```

2. Create actual AQI fixture rows with explicit matching or missing UTC-hour identities.

3. Make the expected-hour set visible in assertions where useful.

4. Replace count-only assertions such as:
   ```text
   aqi_rows_below_observations
   rows covering observations
   ```
   with hour-based assertions such as:
   ```text
   missing_expected_aqi_hours
   expected_hour_count
   actual_hour_count
   missing_hour_keys
   ```

5. Preserve tests for:
   ```text
   missing AQI manifest
   missing expected AQI hour
   successful post-rebuild validation
   failed post-rebuild validation
   AQI-only repair reason
   observation-repair then AQI dependency
   Dropbox root resolution
   ```

6. Do not make an unsupported pollutant create expected AQI output.

## A2. Update AQI repair fixtures

For mocked rebuild tests:

```text
the pre-rebuild source fixture must establish the expected UTC-hour identities
the mocked AQI writer result must contain actual hourly identities
the post-rebuild manifest/parquet fixture must represent the same hours
```

A mocked rebuild that reports success without the required hourly evidence must continue to fail post-rebuild validation.

## A3. Remove stale names and comments

Search current non-archive integrity code and tests for active raw-parity terminology:

```text
aqi_rows_below_observation_rows
rows_below_observations
aqi_rows < observation_rows
row parity
rows covering observations
stale_or_partial_aqi_data
```

For current behaviour:

```text
remove
rename
or clearly mark as historical migration text
```

Do not rewrite archived evidence.

## A4. Remove or minimise the disabled wrapper

Inspect current callers of:

```text
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
```

Exclude `archive/`.

If there are no current callers:

```text
delete the wrapper
remove tracked configuration and documentation references
remove tests that exist only for its old interface
```

If a current caller requires the path:

```text
replace the file with a minimal script that prints the supported v2 replacement guidance and exits 2
remove all unreachable old argument-processing and execution code
```

## A5. Correct plan status

Update:

```text
plans/2026-07-12 Integrity/uk-aq-v2-history-integrity-phased-plan.md
the current v2-only blocker/remaining-work plan
```

Remove resolved blockers from “remaining” sections.

## Focused validation

Run the two affected Python modules first:

```bash
python3 -m unittest \
  scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py \
  scripts/uk-aq-history-integrity/tests/test_v2_repair_execution.py \
  -v
```

Then run:

```text
py_compile for changed Python files
bash -n for changed shell files
git diff --check
```

Do not run real integrity, R2 or the full suite yet.

## Acceptance criteria

```text
all 10 formerly failing tests pass
no production fallback to count-only AQI parity was added
dead legacy wrapper code is gone
current plans accurately describe remaining work
```

---

# 5. Phase B: implement the single v2 repair orchestrator

## Goal

Replace the disabled broad integrity write route with a dedicated, repair-plan-driven v2 orchestrator.

## B1. Entrypoint

Add one explicit current entrypoint under the integrity tooling, for example:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-execute-v2-repair.py
```

The exact implementation language may change after inspecting the current call graph, but the entrypoint must remain separate from the read-only checker.

Do not re-enable `--run-backfill`.

## B2. Input contract

Required input:

```text
--integrity-report-json <current complete report>
```

Accept only a complete v2 report whose contract includes:

```text
history_version_mode=v2
checked_versions=[v2]
history_version_results.v2.history_version=v2
implemented observations result
implemented AQI result where AQI work is requested
repair-plan arrays with current action contracts
```

Reject before any remote request:

```text
unsupported history mode
malformed report
unchecked result
unknown action
operator-review action selected for execution
source-mapping action selected for execution
unsafe or incomplete scope
```

## B3. Explicit selectors

Support deterministic selectors:

```text
--day YYYY-MM-DD
--connector-id <positive integer>
--pollutant-code <canonical code>
--action-family manifest-index|observation-data|aqi
```

Rules:

```text
dry-run may select one or more explicit scopes
write mode requires an explicit scope
the selected action set is sorted and de-duplicated
ignored out-of-scope actions are reported
unsupported selected actions block execution
zero selected actions is an error
manual JSON editing is forbidden
```

The O3 acceptance selector must be representable as:

```text
day=2026-05-17
connector_id=1
pollutant_code=o3
action_family=manifest-index
```

## B4. Action ownership

### Observation manifest/index actions

Delegate to:

```text
scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
```

This remains the authoritative v2 observation hierarchy/index finaliser.

### Observation data-repair actions

Delegate to the existing authoritative source-to-v2 observation writer only after confirming:

```text
the action contains the exact source evidence and scope required by the writer
the writer can be constrained to the selected connector/day/timeseries scope
the writer targets v2
the writer has its own safe CIC-Test gate
```

If the current writer cannot be safely constrained:

```text
keep observation-data execution disabled
return blocked_dependency or not_supported
do not silently fall back to the old integrity wrapper
```

### AQI actions

Delegate to the authoritative v2 hourly AQI writer only when:

```text
pollutant is AQI eligible
required observation-data work is absent or verified complete
required observation manifest/index work is verified complete
expected source UTC-hour identities are available
```

### Operator and mapping actions

Never execute automatically.

Return:

```text
operator_action_required
```

with a non-zero exit for a requested write.

## B5. Dependency order

Required order per selected scope:

```text
1. observation data repair, when required
2. post-data observation validation
3. observation manifest/index finalisation
4. post-manifest/index observation validation
5. AQI rebuild, when required and eligible
6. post-AQI validation
7. final v2 integrity recheck
```

Dependency rules:

```text
failed observation data repair blocks all dependent stages
failed observation validation blocks manifest/index and AQI
failed manifest/index verification blocks AQI
unsupported pollutant never queues AQI
final integrity gaps keep the overall result non-successful
```

## B6. Dry-run

Dry-run is the default.

It must show the same selected execution graph as write mode, including:

```text
selected actions
ignored actions
specialist writer for each action
planned subprocess or module invocation
planned R2 keys where known
planned local/source reads
dependencies
blocked stages
old and proposed hashes from the Phase 3 executor
```

Dry-run must issue no:

```text
PUT
DELETE
backfill write
AQI write
```

Permitted remote operations in a real CIC-Test dry-run:

```text
LIST
HEAD
GET
```

## B7. Write gates

A write requires all of:

```text
--write-r2
UK_AQ_ENV_NAME=CIC-Test
resolved bucket=uk-aq-history-cic-test
explicit scope selectors
compatible current report
all selected actions supported
successful dry-run evidence reviewed by the operator
```

The code cannot prove that the user reviewed the result, so the operational plan must retain the explicit approval boundary.

LIVE must reject before any writer or R2 request.

## B8. Status and exits

Required top-level statuses:

```text
planned
succeeded
skipped_unchanged
blocked_dependency
operator_action_required
not_supported
verification_failed
failed
invalid_input
```

Required shell semantics:

```text
success/no-op: exit 0
blocked, unsupported, operator action, verification failure, invalid input, writer failure: non-zero
```

Every specialist result must contribute to:

```text
changed
status
verification
overall result
exit code
```

## B9. Idempotence

Repeating a successfully completed selected repair must result in:

```text
no changed objects
no repeated data rewrite
no repeated AQI rewrite
skipped_unchanged or equivalent
exit 0
```

## Focused tests

Add only representative tests for critical boundaries:

```text
complete v2 report accepted
unsupported history mode rejected before requests
mixed report is safely narrowed by explicit selectors
unsupported action inside selected scope blocks
write without explicit selector rejects
LIVE rejects before requests
data repair failure blocks manifest/index and AQI
manifest/index failure blocks AQI
O3 manifest/index action never queues AQI
dry-run performs zero writes
successful sequence performs mandatory final recheck
idempotent second run is unchanged
```

Use mocked specialist writers. Do not build a large action permutation matrix.

## Acceptance criteria

```text
one current orchestrator owns all integrity-controlled v2 writes
the checker remains read-only
the old --run-backfill route remains rejected
safe selected Phase 3 execution works
data and AQI actions are either safely delegated or explicitly blocked
no overlapping current integrity writer route remains
```

---

# 6. Phase C: final local validation

## Goal

Complete the local acceptance milestone once after Phases A and B.

## Required Python validation

```bash
python3 -m unittest discover \
  -s scripts/uk-aq-history-integrity/tests \
  -p 'test_*.py' \
  -q
```

Expected:

```text
zero failures
zero errors
```

Existing intentional parser diagnostics and non-failing warnings may remain, but record them accurately.

## Required Node validation

```bash
node --test \
  tests/uk_aq_phase_3_repair_executor.test.mjs \
  tests/uk_aq_phase_3a_writer_contract.test.mjs \
  tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs \
  tests/uk_aq_r2_history_index.test.mjs
```

## Required syntax and repository validation

```text
py_compile for all changed Python files
node --check for all changed Node files
bash -n for all changed shell/env files
npm run check
git diff --check
```

## Required code review checklist

Confirm:

```text
checker is v2-only and read-only
unsupported history modes reject before work
current core is history/v2/core
all AQI completeness logic is UTC-hour based
no count-only parity fallback exists
old --run-backfill is rejected
dead wrapper implementation is removed
one orchestrator owns current integrity writes
write mode requires an explicit selected scope
Phase 3 remains authoritative for manifest/index finalisation
AQI remains dependent on verified observation state
final recheck is mandatory
no archive file changed
```

## Acceptance criteria

Phase C is complete only when all required checks pass.

---

# 7. Phase D: combined real CIC-Test acceptance

## Goal

Prove the v2 checker, Phase 3 executor and orchestrator against the real CIC-Test system.

Do not contact LIVE.

## D1. Local env correction

Inspect without printing secrets:

```text
scripts/uk-aq-history-integrity/env/CIC-Test.env
```

Add or correct only the required non-secret values:

```text
UK_AQ_ENV_NAME=CIC-Test
UK_AQ_R2_HISTORY_DROPBOX_ROOT=/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup
UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT=/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core
UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED=false
```

Preserve credentials and other local settings.

## D2. Mirror preflight

Confirm these directories exist:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/core
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup/history/v2/observations
```

Do not create missing directories.

## D3. Generate a current one-day v2 report

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

No `--run-backfill`.

Required evidence:

```text
real v2 core manifest imported
real v2 core table artifacts validated
real DuckDB parquet statistics produced
current JSON report generated
history_version_mode=v2
checked_versions=[v2]
run_backfill=false
no writer invoked
```

## D4. Inspect every action

List every observation and AQI repair action with:

```text
kind
action family
day_utc
connector_id
pollutant_code
gap_types
requires_index_rebuild
data_changes_required
operator_action_required
executes
```

Confirm whether the expected scope exists:

```text
day_utc=2026-05-17
connector_id=1
pollutant_code=o3
```

Expected O3 classification:

```text
manifest/index hierarchy work
no observation data repair
no AQI work
```

## D5. Orchestrator dry-run for the selected O3 scope

Run the new orchestrator with the exact current report and explicit selectors.

It must delegate the selected manifest/index action to the Phase 3 executor in dry-run mode.

Review:

```text
selected action list
ignored out-of-scope action list
every proposed key
old and proposed hashes
changed or unchanged state
dependencies
expected verification
zero PUT
zero DELETE
no parquet key
no AQI key
sibling pollutants preserved
sibling connectors preserved
```

If unsupported actions exist outside the selected scope, they must be reported but must not invalidate the safe selected dry-run.

If an unsupported action exists inside the selected scope, stop.

## D6. Explicit approval boundary

Stop after the dry-run.

The user must explicitly approve the CIC-Test write.

## D7. Approved O3 write

After separate approval, run the same selected orchestrator command with write mode.

Required evidence:

```text
CIC-Test environment gate passed
test bucket gate passed
fresh child re-list/re-read passed
connector parent verified
day parent verified
targeted observation index/latest/metadata verified
no parquet write
no AQI write
no DELETE
```

## D8. Post-write integrity

Immediately rerun the same one-day check-only command.

Confirm:

```text
the O3 hierarchy/index gap is gone
O3 parquet remains valid
no new sibling gaps were introduced
no O3 AQI action exists
```

## D9. Idempotence

Rerun the same selected orchestrator command.

Expected:

```text
no changed object
no writer repetition
skipped_unchanged or equivalent
exit 0
```

## D10. Real AQI hourly-grain acceptance

Choose a short CIC-Test date range containing:

```text
supported AQI pollutants
multiple observations per UTC hour
existing AQI hourly output
```

Run the checker in check-only mode.

Confirm:

```text
expected hours are derived from valid source hour identities
hundreds of raw observation rows do not require hundreds of AQI rows
healthy hourly output is accepted
missing actual expected hours remain detectable
unsupported pollutants do not produce AQI gaps
```

## D11. Real orchestrator data/AQI dry-run

If the current report contains a genuine observation-data or AQI repair action:

```text
run a selected orchestrator dry-run for that action
inspect the specialist writer, dependency graph and zero-write evidence
do not perform the write without a separate explicit approval
```

If there is no genuine safe current case:

```text
do not manufacture or damage a partition
record that real data/AQI mutation acceptance was not available
retain the focused specialist/orchestrator tests as the current evidence
```

---

# 8. Phase E: final records and operational handoff

## Required plan updates

Update the authoritative status table with:

```text
Phase A result
Phase B orchestrator result
Phase C local validation totals
Phase D real core/DuckDB result
Phase D dry-run result
approved O3 write result
post-write result
idempotence result
AQI hourly result
any data/AQI write limitation
```

Remove obsolete contradictory current status text.

Historical implementation records may remain, but must be marked historical.

## Required documentation

Document the supported current commands:

```text
v2 integrity check-only
v2 selected repair dry-run
v2 selected repair write
post-write check-only
```

Document that:

```text
--run-backfill is not supported
the checker never writes history
the orchestrator requires a complete current report
write mode requires explicit selectors
LIVE remains disabled
```

## Required final report

Summarise:

```text
files changed
tests run and totals
real commands run
R2 reads and writes performed
exact selected O3 keys
post-write verification
idempotence
remaining limitations
git status
```

Do not commit, stage or push unless separately instructed.

---

# 9. Completion checklist

## Local implementation

```text
[ ] all 10 stale AQI tests use valid UTC-hour identities
[ ] stale raw-row-parity assertions and names are removed
[ ] dead legacy integrity wrapper code is removed
[ ] current plans no longer list resolved blockers as remaining
[ ] checker remains v2-only
[ ] checker remains read-only
[ ] all current core references use history/v2/core
[ ] dedicated v2 repair orchestrator exists
[ ] orchestrator accepts a complete current v2 report
[ ] explicit day/connector/pollutant/action selectors work
[ ] mixed reports can be safely narrowed without editing JSON
[ ] unsupported selected actions reject before requests
[ ] observation data repair has a safe specialist owner or is explicitly blocked
[ ] Phase 3 owns observation manifest/index finalisation
[ ] AQI writer is gated by verified observation dependencies
[ ] final integrity recheck is mandatory
[ ] dry-run performs zero writes
[ ] write gates require CIC-Test and the test bucket
[ ] blocked and failed work return non-zero
[ ] idempotent rerun is unchanged
```

## Local validation

```text
[ ] full current Python integrity suite passes
[ ] four focused Phase 3 Node files pass
[ ] Python syntax checks pass
[ ] Node syntax checks pass
[ ] shell/env syntax checks pass
[ ] npm run check passes
[ ] git diff --check passes
[ ] no archive file changed
```

## Real CIC-Test acceptance

```text
[ ] ignored local CIC-Test env uses history/v2/core
[ ] real v2 core directory exists
[ ] one-day current v2 report is generated
[ ] real DuckDB reads succeed
[ ] expected O3 action is present
[ ] O3 is manifest/index-only
[ ] selected O3 orchestrator dry-run shows zero writes
[ ] user explicitly approves the write
[ ] selected O3 CIC-Test write succeeds
[ ] post-write integrity confirms the gap is gone
[ ] idempotent rerun changes nothing
[ ] real AQI hourly-grain check passes
[ ] no LIVE contact or mutation occurred
```

---

# 10. Recommended implementation order

```text
Phase A
  repair fixtures
  remove dead wrapper
  correct status records

Phase B
  implement the single v2 repair orchestrator
  add explicit safe selectors
  connect specialist writers and verification

Phase C
  run final local validation once

Phase D
  current one-day report
  selected O3 dry-run
  approval
  selected O3 write
  post-write check
  idempotence
  AQI real check

Phase E
  final documentation and operational handoff
```

---

# 11. Recommended Codex model

Use:

```text
GPT-5.6 Terra
Reasoning: High
```

for the orchestrator and real-run phases.

A smaller coding model may handle the fixture-only Phase A, but the orchestrator crosses:

```text
Python
shell
Node
R2 hierarchy
source writers
AQI dependencies
status propagation
real-run interpretation
```

Use focused tests during implementation and one full validation milestone before real CIC-Test execution.
