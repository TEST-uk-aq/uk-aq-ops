# 2026-07-21 Modularise Integrity Backfill

## Purpose

Modularise UK AQ History Integrity and the local backfill worker so policy ownership, side-effect boundaries and retry behaviour are explicit.

The principal orchestration files are:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
workers/uk_aq_backfill_local/run_job.ts
```

This work also implements the approved functional corrections that exposed the need for clearer boundaries:

- one authoritative observation repair decision;
- explicit `--repair-pollutants` permission for every destructive observation repair;
- Latest Snapshot authentication capability preflight before canonical R2 mutation;
- independent current-state target audit;
- failed-target-only current-state resume.

The implementation must follow:

- `system_docs/r2_history/integrity.md`;
- `system_docs/r2_history/current_state_reconciliation.md`;
- `system_docs/r2_history/integrity_modularisation.md`;
- `system_docs/latest_snapshot/integrity_reconciliation.md`.

## Current operational baseline

The focused SOS missing-connector correction is implemented.

A real CIC-Test repair for 24 July 2026 then proved that:

- authoritative UK-AIR source evidence completed;
- observation repair succeeded;
- AQI rebuilding succeeded;
- canonical apply succeeded;
- final observation and AQI verification succeeded;
- timeseries current-state reconciliation updated 522 records;
- Latest Snapshot reconciliation failed because the local `info@ukaq.co.uk` `gcloud` credentials had expired.

The verified R2 and successful timeseries changes remained committed. The run exposed two architectural requirements:

1. authentication capability must be checked before canonical mutation;
2. a failed late target must be resumable without repeating successful source, R2, AQI or timeseries work.

# Codex prompts

Run the following prompts in the same local VS Code Codex session. Codex may implement the complete authorised series without waiting for operator confirmation between internal phases.

**Recommended model for both prompts: GPT-5.6 Codex with High reasoning.**

## Codex Prompt 1: Implement the complete modularisation and recovery series

```text
Use GPT-5.6 Codex with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Work locally in the existing VS Code checkout. Do not use Codex Cloud, a remote worktree, GitHub web editing or the ChatGPT GitHub connector for implementation.

Implement the complete authorised Integrity and backfill modularisation series in one local feature branch and one Codex session. Do not pause for operator approval between the internal phases.

Create one branch from an up-to-date local main, using a clear name such as:

codex/2026-07-29-integrity-modularisation

Use sequential, coherent commits. Push the completed branch and open one draft pull request at the end. Do not merge it.

Before changing code, read these authoritative contracts in full:

- system_docs/r2_history/integrity.md
- system_docs/r2_history/current_state_reconciliation.md
- system_docs/r2_history/integrity_modularisation.md
- system_docs/latest_snapshot/integrity_reconciliation.md
- plans/2026-07-21 Modularise Integrity Backfill/2026-07-21_modularise_integrity_backfill.md

Also inspect the current implementation, focused tests, Git history and the existing compatibility wrapper.

Do not redesign functional behaviour outside the approved changes below.

Approved functional changes
===========================

1. Central observation repair decision
--------------------------------------

Create one authoritative pure repair-decision owner for observation Integrity findings.

The decision must explicitly represent the equivalent of:

- repair kind;
- data changes required;
- scope grain;
- day;
- connector;
- exact pollutant where applicable;
- index-rebuild requirement;
- source-evidence requirement;
- operator pollutant permission requirement;
- AQI policy;
- executability policy;
- reason.

Detection emits facts. The decision owner classifies them. Suggested repair output, repair-plan construction, executable-scope validation and AQI dependency planning must consume the same decision rather than independently maintaining overlapping gap-type sets.

Preserve these missing-scope semantics:

- day_dir_missing: connector/day wildcard data repair;
- connector_dir_missing: connector/day wildcard data repair;
- pollutant_dir_missing with a concrete supported pollutant: exact pollutant data repair;
- pollutant_dir_missing without a concrete supported pollutant: fail closed.

Do not restore permissive compatibility inference when an explicit plan exists.

2. Explicit destructive pollutant permission
--------------------------------------------

Every destructive observation data repair requires an explicit non-empty --repair-pollutants selection.

This includes exact and wildcard repairs.

Required exact-scope behaviour:

- no requested pollutant list: non-executable with a clear explicit-selection-required reason;
- matching requested pollutant: execute only that pollutant;
- non-matching requested list: non-executable as outside_operator_requested_pollutant_scope.

Do not widen exact scope.

AQI work remains limited to pm25, pm10 and no2. O3 remains observation-only for AQI purposes.

3. Latest Snapshot authentication capability preflight
------------------------------------------------------

Extract one authentication owner for:

- URL and audience validation;
- exact identity-token command construction;
- optional configured base account;
- optional configured impersonated service account;
- mandatory configured audience;
- bounded subprocess and error handling;
- real-run preflight;
- fresh final token acquisition.

For a real repair whose selected pollutants can produce pm25, pm10 or no2 Latest Snapshot candidates, and when current-state reconciliation is enabled, run the authentication capability preflight after proposal validation but before canonical R2 mutation.

The preflight must invoke the same audience-specific token helper as the final call and discard the token without logging it.

If token acquisition fails, fail before canonical R2 writes.

The final Latest Snapshot invocation must obtain a fresh token again after final R2 verification.

Do not perform the preflight for an O3-only repair.

Check-only and dry-run validate configuration shape but must not require an interactive login refresh or call a mutating route.

No audience-less, different-account, empty-token or unauthenticated fallback is permitted.

4. Independent current-state target audit
-----------------------------------------

Separate timeseries and Latest Snapshot into independently audited targets.

Persist enough SQLite evidence to distinguish:

- final R2 verification success;
- timeseries status and counts;
- Latest Snapshot status and counts;
- attempt count per target;
- retryable versus terminal failure;
- bounded error;
- candidate identity or deterministic evidence needed for resume;
- linked source Integrity run.

A failed Latest Snapshot target must not make the report imply that verified R2 or successful timeseries work failed.

Preserve overall failure or partial status when a required target failed.

5. Failed-target-only resume
----------------------------

Implement the operator-supported current-state resume contract.

Preferred CLI:

--resume-current-state-run-id <integrity run id>
--resume-current-state-target failed|timeseries|latest_snapshot|all

The target defaults to failed.

If the existing parser or durable audit makes another exact flag name materially safer, use it only when the code, system docs and plan remain consistent.

Resume must:

- load the referenced Integrity run and target audit;
- validate environment and scope;
- prove that final verified R2 evidence still exists and remains valid;
- reproduce or load deterministic candidates;
- obtain fresh target credentials;
- retry failed or pending targets by default;
- skip successful targets by default;
- preserve monotonic and idempotent target rules;
- write a linked retry attempt and updated report.

Resume must not repeat successful:

- source downloads;
- source comparisons;
- observation proposal generation;
- AQI proposal generation;
- canonical R2 apply;
- manifest or index repair;
- successful current-state targets.

If final verified R2 evidence cannot be proven, fail closed and require a new scoped Integrity run.

6. Python modularisation
------------------------

Modularise uk-aq-history-integrity_impl.py according to the ownership contract.

Use coherent modules under:

scripts/uk-aq-history-integrity/bin/integrity/

Expected responsibility areas include:

- CLI and validation;
- configuration and runtime context;
- database and core snapshot;
- source checks per connector;
- observation and AQI detection;
- authoritative repair decisions;
- planning and executable scope;
- source evidence;
- metadata and index repair;
- canonical apply;
- final verification;
- current-state auth, candidates, timeseries, Latest Snapshot, audit, resume and coordination;
- reporting, daily state and task health.

Do not create empty modules merely to match a diagram.

uk-aq-history-integrity.py remains the public entrypoint.

The compatibility wrapper may continue exporting established names used by focused tests and tooling, but each compatibility name must delegate to one authoritative implementation.

Modules must not perform network, R2, SQLite, gcloud, lock or report work merely because they are imported.

Pass shared mutable runtime state explicitly rather than creating hidden new module globals.

Reduce uk-aq-history-integrity_impl.py to composition, compatibility exports and orchestration.

7. TypeScript local backfill modularisation
------------------------------------------

Modularise workers/uk_aq_backfill_local/run_job.ts according to the ownership contract.

Extract coherent ownership for:

- environment and run scope;
- SOS, Sensor.Community, OpenAQ and Breathe London source adapters;
- complete connector-day and source-evidence proposal staging;
- observation export, Parquet and manifests;
- AQI rebuild, export and manifests;
- R2 object access and history paths.

run_job.ts remains the executable orchestration entrypoint.

Preserve:

- source acquisition ordering;
- complete connector-day rules;
- explicit selected-pollutant scope;
- source-evidence hashes and fields;
- observation and AQI calculations;
- Parquet schemas and ordering;
- object keys;
- manifest shapes;
- event names;
- no-data classifications;
- canonical apply boundaries;
- all fail-closed checks.

Source adapters must not independently perform canonical R2 apply.

8. Stage and dependency boundaries
----------------------------------

Preserve the functional order while exposing clear stage ownership:

- source acquisition;
- detection;
- repair decision;
- observation proposal;
- observation metadata proposal;
- AQI proposal;
- Latest Snapshot auth preflight;
- canonical apply;
- first_value_at reconciliation;
- final verification;
- timeseries reconciliation;
- Latest Snapshot reconciliation;
- reporting and task health.

The coordinator owns ordering, not domain policy.

Do not allow lower-level modules to import the entrypoint or higher-level coordinator.

Implementation sequence and commits
===================================

Implement all phases without an operator pause, but keep coherent commits:

1. inventory and structural viability;
2. central repair decision and explicit pollutant permission;
3. auth preflight, independent target audit and resume;
4. Python package extraction;
5. TypeScript module extraction;
6. orchestration slimming, compatibility exports and ownership documentation;
7. final structural review and report.

The inventory may be committed in the plan directory, but do not stop after producing it.

Preservation constraints
========================

Do not change unless explicitly authorised above:

- existing public entrypoint paths;
- existing environment-variable names or precedence;
- existing CLI names, defaults or validation;
- existing log event names and established fields;
- R2 layouts, keys or retention;
- Parquet schemas;
- manifest schemas and hierarchy;
- source mapping policy;
- AQI algorithms or thresholds;
- WHO calculations;
- Dropbox backup behaviour;
- Integrity date selection;
- SQLite as the Integrity audit store;
- Latest Snapshot single-writer ownership;
- current-state monotonic and same-timestamp rules.

Do not perform repository-wide formatting or unrelated cleanup.

Pre-deployment validation
=========================

Do not create a broad speculative functional test suite.

Before implementation, validate structural viability only.

After implementation, run existing structural checks and only targeted deterministic checks genuinely needed for the approved functional changes:

- connector_dir_missing uses the same authoritative repair decision through planning and executable scope;
- exact and wildcard repairs require explicit requested pollutants;
- auth command includes configured account, impersonation and audience;
- auth preflight occurs before canonical mutation;
- failed preflight causes no canonical writes;
- successful targets persist independently;
- failed-target-only resume skips successful stages and targets;
- resumed target remains monotonic and idempotent.

Run as applicable:

- python compilation for every touched module;
- direct public entrypoint import;
- public --help;
- existing TypeScript type/check command;
- bash -n for touched shell files;
- import-cycle and stale-reference searches;
- git diff --check;
- confirmation that no generated artefacts are committed.

Do not run:

- real Integrity repairs;
- live R2 mutations;
- Cloud Run calls;
- schema deployment;
- IAM changes;
- LIVE operations;
- browser testing;
- a new broad test matrix.

System documentation
====================

Update system docs only for final code ownership, exact resume CLI names and any implementation detail that must remain authoritative.

Do not weaken or reinterpret the functional contracts.

Completion
==========

At the end:

- review the complete diff;
- ensure the working tree is clean;
- show the branch and commit sequence;
- push the branch;
- open one draft PR;
- do not merge;
- provide a report containing changed files, final module map, preserved contracts, targeted checks, known residual risks and exact post-deployment CIC-Test commands.
```

## Codex Prompt 2: Review the complete branch and fix structural drift

```text
Use GPT-5.6 Codex with High reasoning.

Continue in the same local repository and feature branch created for the complete Integrity modularisation series.

Review the whole branch against:

- system_docs/r2_history/integrity.md
- system_docs/r2_history/current_state_reconciliation.md
- system_docs/r2_history/integrity_modularisation.md
- system_docs/latest_snapshot/integrity_reconciliation.md
- the pre-refactor Git revision

This is a final review and correction pass. Do not introduce a new design.

Confirm and correct where necessary:

1. one authoritative observation repair decision feeds reporting, planning, scope validation and AQI policy;
2. no duplicated active data-gap or metadata-gap policy sets can drift independently;
3. every destructive exact or wildcard observation repair requires explicit --repair-pollutants permission;
4. auth preflight occurs before canonical R2 mutation and final invocation obtains a fresh token;
5. identity-token construction has one owner and no fallback path;
6. timeseries and Latest Snapshot persist independent target outcomes;
7. failed-target-only resume cannot repeat successful source, R2, AQI or current-state work by default;
8. resume fails closed when final verified R2 evidence is missing or inconsistent;
9. public entrypoints, environment variables, CLI compatibility, event names, report fields, R2 keys, schemas and stage meanings remain compatible;
10. imports have no side effects and no lower-level module imports an entrypoint;
11. compatibility exports delegate to one implementation rather than retaining duplicate live code;
12. run_job.ts and uk-aq-history-integrity_impl.py are primarily orchestration.

Run only the agreed structural checks and targeted deterministic checks. Do not run real operations or add a broad test suite.

Fix confirmed structural or contract drift in additional coherent commits on the same branch.

Update the draft PR description and final implementation report. Do not merge the PR.
```

# Implementation model

Codex performs the complete authorised code series locally in one feature branch.

The branch contains multiple coherent commits but may be delivered as one draft pull request. There is no requirement to deploy or validate each internal commit separately.

This is intentionally different from the earlier plan, which required deployment pauses between release groups. The system is TEST, and real functional validation will occur after the complete structurally reviewed series is deployed.

Codex must stop rather than guess only when it finds a genuine structural blocker such as:

- an unavoidable circular dependency;
- hidden mutable global state that cannot be moved safely;
- missing durable evidence required for resume;
- an existing production caller that depends on behaviour contradicted by the approved contract;
- a schema change whose safe migration cannot be established.

A routine implementation choice within the approved contracts is not a reason to pause.

# Target architecture

## Python

```text
scripts/uk-aq-history-integrity/bin/
├── uk-aq-history-integrity.py
├── uk-aq-history-integrity_impl.py
└── integrity/
    ├── cli.py
    ├── config.py
    ├── runtime.py
    ├── database.py
    ├── core_snapshot.py
    ├── models.py
    ├── source_checks/
    ├── detection/
    ├── repair/
    ├── current_state/
    ├── reporting.py
    ├── daily_profile.py
    └── task_health.py
```

The exact modules may differ where the current dependency graph provides a clearer ownership boundary.

## TypeScript

```text
workers/uk_aq_backfill_local/
├── run_job.ts
├── config/
├── source_adapters/
├── integrity/
├── observations/
├── aqilevels/
└── r2/
```

No empty or artificial modules are required.

# Required code outcomes

## Repair classification

One authoritative decision owns the transition from detected observation gap to repair action.

Report rendering, plan construction, executable scope and AQI dependency use that result.

## Auth preflight

For a real Latest Snapshot-capable repair:

```text
proposal validated
→ identity-token capability preflight
→ canonical R2 mutation
→ final R2 verification
→ fresh identity token
→ Latest Snapshot call
```

Expired local credentials must fail before canonical mutation.

## Current-state resume

A late target failure produces independent durable results.

The default resume path retries only failed or pending current-state targets.

It does not repeat successful source, R2, AQI or target work.

# Structural validation before deployment

Only these categories are required:

- compile, import, type and shell syntax checks;
- import graph and stale-reference checks;
- contract-name comparisons;
- targeted deterministic checks for the approved classifier, explicit pollutant, auth-preflight and resume changes;
- `git diff --check`;
- manual diff review.

Do not add a speculative pre-deployment functional suite.

# Mike or ChatGPT deployment and operational validation

## Phase 1: Review the draft PR

Confirm:

- changes stay within the authorised scope;
- commits are coherent;
- no generated files or unrelated formatting are included;
- system docs match final code ownership and CLI names;
- public entrypoints and contracts remain compatible.

Merge only after the structural review is satisfactory.

## Phase 2: Deploy to the dedicated Integrity machine

Pull the merged `main` in the TEST operations checkout selected by:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test
```

Confirm the selected commit and public `--help` output.

Refresh the local Google base-account credentials before the first authenticated operation:

```bash
gcloud auth login info@ukaq.co.uk
```

Confirm audience-specific impersonated token acquisition without displaying the token.

## Phase 3: Resume the failed 24 July Latest Snapshot target

Use the implemented resume CLI and the original Integrity run ID from the failed report.

Default to the failed target only.

Confirm:

- no source acquisition repeats;
- no observation or AQI proposal repeats;
- no canonical R2 write repeats;
- the already successful timeseries target is skipped;
- fresh authentication succeeds;
- Latest Snapshot state and products reconcile;
- the retry is linked to the original run;
- overall current-state status becomes complete without misreporting earlier stages.

## Phase 4: Real scoped SOS repair

Run one new real CIC-Test SOS repair with explicit pollutants, for example:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source sos \
  --from-day <selected complete UTC day> \
  --to-day <same day> \
  --history-version v2 \
  --run-backfill \
  --repair-pollutants pm25,pm10,no2,o3
```

Confirm:

- auth preflight happens before any canonical mutation;
- source evidence and repair decisions use the selected scope;
- only expected R2 prefixes change;
- AQI work is limited to PM2.5, PM10 and NO2;
- final verification succeeds;
- timeseries and Latest Snapshot each report independent success;
- O3 does not create AQI or Latest Snapshot work.

## Phase 5: Idempotent repeat and no rollback

Repeat the exact operation and confirm no unnecessary R2, timeseries, state or product rewrites.

Run an older verified scope and confirm current state does not move backwards.

## Phase 6: Normal operational coverage

Through real TEST operations, cover:

- one check-only run;
- normal source checks for SOS, Sensor.Community and OpenAQ;
- one daily-profile run or the next natural scheduled run;
- task-health reporting;
- a Dropbox backup after a successful writer run;
- a normal scheduled Latest Snapshot run after reconciliation;
- a normal website chart and map/list check for a repaired sensor.

## Phase 7: Compare operational reports

Compare with the pre-refactor baseline:

- selected days, connectors and pollutants;
- source files and row counts;
- repair decisions and proposal stages;
- planned and applied object operations;
- manifest hierarchy and indexes;
- AQI outcomes;
- final verification;
- current-state target outcomes;
- task-health and backup evidence.

Accept run-specific differences such as timestamps, IDs and genuinely changed source data.

Treat changed scope, event names, status meanings, R2 layout, schema, missing guards or repeated successful stages as behavioural drift.

# Completion criteria

The plan is complete when:

- the Python and TypeScript entrypoints are primarily orchestration;
- one authoritative repair decision feeds every later repair stage;
- exact and wildcard destructive repairs require explicit pollutant permission;
- authentication preflight occurs before canonical mutation;
- final invocation uses a fresh audience-specific token;
- timeseries and Latest Snapshot are independently audited;
- a failed target resumes without repeating successful R2 or target work;
- public contracts remain compatible;
- real CIC-Test validation shows no unexplained drift;
- the final module map is recorded in the plan directory.

# Out of scope

This plan does not authorise:

- changing AQI algorithms or thresholds;
- changing source mapping policy;
- changing R2 layouts, schemas or retention;
- changing Dropbox backup ownership;
- changing Integrity date-selection policy;
- replacing SQLite;
- creating a second Latest Snapshot writer;
- introducing a broad dependency-injection framework;
- repository-wide formatting;
- a speculative pre-deployment functional test suite;
- LIVE deployment before CIC-Test validation is complete.