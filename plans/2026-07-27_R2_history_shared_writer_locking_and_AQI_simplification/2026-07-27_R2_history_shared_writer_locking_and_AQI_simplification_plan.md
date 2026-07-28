# R2 history shared writer, locking and AQI simplification plan

**Date:** 2026-07-27  
**Repository:** `TEST-uk-aq/uk-aq-ops`  
**System:** TEST  
**Status:** Ready for implementation  

## Goal

Bring the active implementation into line with the authoritative R2 history contracts so that:

- Integrity and Prune Daily may run concurrently when they are not mutating the same protected R2 resources;
- Integrity fails the complete request immediately if the requested range reaches any requested connector's IngestDB boundary;
- Prune Daily and Integrity use one shared canonical R2 v2 connector-day writer;
- parent day manifests preserve connectors already written by another run;
- connector, day and global index work is targeted and performed once at the correct scope;
- only Prune Daily owns connector-day prune gates;
- Prune Daily has one AQI implementation, calculated from canonical observations;
- AQI failure does not block deletion of observations whose R2 observation history has already been verified;
- chart metrics maintenance is removed from the Prune Daily critical path and runs separately;
- the R2 structure migration can be performed by Integrity through the same shared writer without involving prune gates.

## Mandatory authority

The system documents are mandatory contracts, not background guidance. Active code must be changed to match them. Codex must read them before changing code and must reread the relevant sections before completing each phase.

Required reading order:

1. `AGENTS.md` and any nearer repository instructions.
2. `system_docs/r2_history/README.md`
3. `system_docs/r2_history/history_writer_coordination.md`
4. `system_docs/r2_history/prune_connector_day_gate.md`
5. `system_docs/r2_history/aqi_history_write_pipeline.md`
6. `system_docs/r2_history/integrity.md`
7. `system_docs/r2_history/connector_gate_file_identity.md`
8. `system_docs/r2_history/contract.md`
9. Other linked system documents relevant to files being changed.

Where active code, old comments, tests, plans or legacy documentation conflict with the current `system_docs`, the current `system_docs` win.

## Codex execution rules

**Recommended model:** use the strongest available Codex model at **High reasoning**.

These rules apply to every Codex phase:

1. Do not make assumptions about current behaviour, schema, environment variables, workflow triggers, database access, lock ownership or call order. Inspect the implementation first.
2. Do not silently choose between materially different implementations. If a decision is genuinely required and is not already settled by the current system contracts or this plan, stop and report:
   - the exact decision;
   - the code and contract evidence;
   - the viable options;
   - the consequences of each option;
   - a recommendation, clearly labelled as a recommendation rather than an implemented decision.
3. Do not continue past a contract conflict, missing prerequisite or unsafe ambiguity.
4. Do not weaken, reinterpret or amend the behavioural decisions in the system contracts merely to fit the existing code.
5. Preserve unrelated functionality. Do not opportunistically refactor code outside this scope.
6. Do not create archive copies for `system_docs`, tests or other files. Follow the repository archive rules.
7. Keep changes deterministic and byte-stable where the current R2 manifest and index contracts require that.
8. Do not add broad speculative test suites.
9. Before deployment, run only:
   - syntax and type checks needed to establish structural viability;
   - directly relevant deterministic contract checks identified in this plan;
   - existing focused tests affected by the changed modules.
10. Functional testing happens later through real operations on the TEST system.
11. Do not run a real R2 migration, real Integrity repair, destructive prune, production deployment or LIVE operation during the Codex phases.
12. Update system documentation only where implementation ownership, file paths or operational detail has changed. Do not change the contract decisions already recorded.
13. After each phase, report:
   - files changed;
   - behaviour changed;
   - behaviour deliberately preserved;
   - checks run;
   - any remaining risks or decisions.
14. Codex may continue through the Codex phases in sequence only while no unresolved decision or contract conflict exists.

## Explicit decisions already made

Codex must not reopen these decisions:

- Integrity owns only the continuous historical region before each connector's earliest IngestDB day.
- If the requested inclusive end day reaches the earliest IngestDB day for any requested connector, the complete Integrity request fails immediately.
- Integrity must not trim the range, skip a connector or process a valid prefix.
- Integrity and Prune Daily may run at the same time.
- There is no global requirement that Prune Daily must be stopped before Integrity runs.
- Writer concurrency is controlled by connector-day, day-finalisation and global-index advisory locks.
- Only Prune Daily owns `uk_aq_ops.prune_connector_day_gates`.
- Integrity and migration do not create, complete, clear or backfill prune gates.
- The existing gate names are retained.
- `uk_aq_ops.prune_day_gates` is not removed by this plan. Its consumers may be audited separately later.
- The normal Phase B AQI path always calculates AQI from canonical observations.
- The legacy AQI RPC/export path is retired.
- ObsAQIDB may supply only the documented older PM observation context needed by the observation-derived AQI calculation.
- AQI success is not a prerequisite for a connector-day observation deletion gate.
- Chart metrics maintenance must run separately from Prune Daily.
- The historical R2 structure migration is performed through Integrity and the shared writer, not through Prune Daily.

## Intended end-state flow

### Prune Daily

```text
select eligible connector-day from IngestDB
        ↓
acquire connector-day writer lock
        ↓
mark connector prune gate incomplete
        ↓
write and verify canonical observation history
        ↓
write and verify connector-targeted observation indexes
        ↓
release connector-day writer lock
        ↓
set connector prune gate complete
        ↓
calculate and write observation-derived AQI separately
        ↓
finalise each affected day under the day lock
        ↓
finalise aggregate/latest indexes under the global lock
        ↓
delete matching IngestDB observations through the connector gate
```

An AQI failure leaves AQI or aggregate whole-day state incomplete but does not revoke a successful connector observation gate and does not prevent the corresponding observation deletion path from continuing.

### Integrity

```text
resolve complete requested connector set and inclusive date range
        ↓
query earliest IngestDB day for every requested connector
        ↓
fail complete request if any requested end day overlaps a boundary
        ↓
perform source acquisition, comparison and repair planning
        ↓
check-only or dry-run stops without live R2 locks or writes
        ↓
real repair acquires connector-day locks only for exact mutation scopes
        ↓
write through the shared connector-day writer
        ↓
finalise affected days and aggregate indexes through shared locks
        ↓
verify and report
```

Integrity never changes prune gates.

### Shared finalisation

```text
connector-specific data and leaf indexes
        ↓
small parent day manifests merged under a day lock
        ↓
small aggregate/latest indexes updated under a global lock
```

Unchanged connector Parquet is not reread during the normal parent-manifest merge.

---

# Codex phases

## Phase 1: Contract-led implementation inventory and structural viability

**Owner:** Codex  
**Code changes:** None unless required only to expose an existing broken import during structural inspection.  

### Tasks

1. Read the mandatory contracts in the required order.
2. Inspect the current implementation and map the exact files and functions responsible for:
   - Prune Daily Phase B connector selection;
   - observation writing and verification;
   - AQI calculation and writing;
   - observation and AQI day-manifest finalisation;
   - targeted and full index rebuilding;
   - connector gate state changes;
   - historical gate adoption or recovery;
   - Integrity startup guardrails;
   - any current check that Prune Daily is not running;
   - Integrity real R2 mutation;
   - chart metrics maintenance;
   - task-health reporting and workflow entrypoints.
3. Identify every active reference to the retired AQI path, including:
   - `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED`;
   - the exactly-one-writer configuration check;
   - `runAqilevelsBackup()` or equivalent;
   - legacy AQI rows or connector-count RPC names;
   - `aqilevels_source` aliases;
   - v1 AQI write prefixes in the active path;
   - legacy fallback branches;
   - tests and configuration that exist only for the retired path.
4. Identify every active Integrity or maintenance path that creates, completes, invalidates or backfills `prune_connector_day_gates`.
5. Confirm how Integrity currently connects to the operational database and determine the existing authoritative route for querying the earliest IngestDB day per requested connector.
6. Confirm whether PostgreSQL advisory locks can be held on the same long-lived database sessions used by the active writers.
7. Confirm the current language and process boundary between the Python Integrity orchestrator and the JavaScript or Deno R2 mutation worker.
8. Confirm the exact current parent-manifest and index structures so the shared finaliser can merge existing connectors without reading unchanged Parquet.
9. Confirm the existing Cloudflare-to-GitHub trigger pattern that a separate chart metrics workflow can reuse.
10. Report the exact implementation map before proceeding.

### Mandatory stop conditions

Stop before Phase 2 if:

- querying the IngestDB boundary would require a new public RPC rather than an existing private database route;
- a schema change outside this repository is required and the exact ownership is not already documented;
- the active writer cannot hold advisory locks on a stable database session;
- the current Integrity mutation architecture cannot use one canonical lock-key derivation and writer implementation without a material design decision;
- chart metrics has no existing reusable scheduling or authentication pattern and a new trigger design would be required;
- any current system contract conflicts with another current system contract.

### Phase completion criteria

- Every affected implementation path has been identified.
- Structural viability is established.
- No unresolved decision remains.
- No functional tests or external writes have been run.

## Phase 2: Shared advisory-lock infrastructure and Integrity boundary guard

**Owner:** Codex

### Tasks

1. Add one canonical shared advisory-lock helper for R2 history writers.
2. The helper must own:
   - environment-aware lock identity;
   - deterministic key derivation;
   - separate namespaces for connector-day, day-finalisation and global-index locks;
   - non-blocking acquisition with a short bounded retry period;
   - structured acquisition, contention, release and failure diagnostics;
   - safe release in `finally` paths;
   - explicit handling of connection loss.
3. Ensure TEST and LIVE cannot share a lock identity accidentally.
4. Do not duplicate lock-key derivation between Prune Daily and Integrity. If thin language wrappers are unavoidable, they must consume one canonical namespace and key contract rather than reimplementing it independently.
5. Add the request-level Integrity IngestDB boundary guard for every mode:
   - resolve the complete requested connector set;
   - query the earliest UTC day represented in IngestDB for every requested connector;
   - compare the inclusive `requested_end_day` with every boundary;
   - fail the complete request immediately when `requested_end_day >= earliest_ingestdb_day` for any connector;
   - report every blocking connector in one bounded result;
   - run before source acquisition, Dropbox comparison, proposal generation or live R2 access.
6. Do not add per-day empty checks, range clipping, connector skipping or a second routine pre-write boundary check.
7. Remove or bypass the broad Integrity guard that requires all Prune Daily activity to be stopped.
8. Preserve all other Integrity readiness and Dropbox backup guards unless a current system contract explicitly changes them.
9. Integrate the connector-day lock with the current live mutation entrypoints sufficiently to prevent same-connector-day concurrent mutation during the later refactor.
10. Do not acquire writer locks in Integrity check-only or dry-run modes.

### Focused structural checks

These checks are genuinely required because incorrect lock identity or boundary handling could permit conflicting writes:

- identical environment, namespace and resource identity produces the same advisory-lock key;
- different environments or lock namespaces do not collide in the focused fixture;
- connector-day identity includes both `day_utc` and `connector_id`;
- day-finalisation identity includes the day but not a connector;
- global-index identity is environment-scoped;
- lock acquisition is bounded and release occurs on success and error;
- a request crossing one connector boundary fails the whole request and reports all blockers;
- a valid request is not blocked merely because Prune Daily is running elsewhere;
- check-only and dry-run do not acquire writer locks.

### Phase completion criteria

- Shared lock infrastructure exists and is used by the current mutation boundaries.
- Integrity has one request-level hard boundary guard.
- The global Prune Daily-running exclusion is removed from Integrity.
- No live mutation has been run.

## Phase 3: Extract the shared canonical connector-day writer

**Owner:** Codex

### Tasks

1. Extract one canonical R2 v2 connector-day writer used by both Prune Daily and real Integrity or migration writes.
2. Keep caller-specific responsibilities outside the shared writer.
3. The caller continues to own:
   - source selection and acquisition;
   - Integrity comparison and repair planning;
   - Prune Daily candidate selection and source freezing;
   - the Integrity boundary check;
   - prune-gate changes;
   - IngestDB deletion;
   - run-specific reports and task-health state.
4. The shared writer must own the connector-scoped functionality required by the contracts:
   - canonical observation normalisation;
   - canonical `verification_status` handling;
   - observation-content hash calculation;
   - deterministic Parquet creation;
   - pollutant manifests;
   - connector manifests;
   - physical file-identity evidence;
   - connector-targeted observation indexes;
   - observation-derived AQI connector outputs when requested by the caller;
   - AQI data and debug connector manifests;
   - connector-targeted AQI indexes;
   - connector-scoped read-back verification;
   - connector-day lock acquisition and release.
5. Preserve the exact current canonical R2 v2 paths, schema, hash contract, verification-status contract and deterministic manifest behaviour.
6. Preserve existing out-of-scope pollutant children exactly as required by the Integrity contract.
7. Ensure new manifests include the timeseries row-count metadata required to build targeted indexes without rereading the newly written Parquet.
8. Do not make the shared writer set or clear prune gates.
9. Do not make the shared writer infer the complete connector set for a day.
10. Keep source adapters separate. Do not force Prune Daily and Integrity to share source acquisition logic.
11. Replace duplicated writer logic only after the shared path can produce the same canonical outputs.
12. Remove obsolete duplicated implementations once no active caller uses them.

### Focused structural checks

- the same canonical rows produce equivalent logical output through the Prune Daily and Integrity callers;
- the shared writer uses the existing authoritative observation-content hash helper;
- new connector manifests contain required row-count metadata;
- gate functions are not imported or called by the shared writer;
- lock release occurs after connector-scoped verification and on failure;
- check-only and dry-run do not invoke the live writer.

### Phase completion criteria

- Prune Daily and real Integrity or migration converge on one canonical connector-day writer.
- Source ownership remains separate.
- No parent day manifest is yet rebuilt solely from the current run.

## Phase 4: Shared day finaliser and targeted index finalisation

**Owner:** Codex

### Tasks

1. Add one shared day finaliser used after connector writes.
2. Protect each affected day with the day-finalisation advisory lock.
3. Acquire the day lock before reading the parent manifests used for the merge.
4. For each affected day:
   - read the latest valid observation day manifest;
   - read the latest valid AQI data and debug day manifests where applicable;
   - preserve valid connector references already present;
   - replace or add only connector references changed by the current run;
   - write each parent manifest once;
   - read back and verify the completed parent manifests;
   - release the day lock.
5. Do not build a day manifest solely from current Prune Daily candidates, current Integrity actions or the connectors written by the current run.
6. Do not reread unchanged connector Parquet during the normal merge.
7. Use bounded prefix listing and connector-manifest rediscovery only when the current parent manifest is absent or structurally invalid.
8. Keep connector and pollutant leaf indexes scoped by day, connector and pollutant.
9. Update leaf indexes only for connectors changed by the run.
10. Collect affected days and finalise each affected day once per run.
11. Add the environment-scoped global index-finalisation lock.
12. After all day finalisation:
    - acquire the global lock;
    - reread the current metadata required for aggregate/latest indexes;
    - update affected aggregate/latest payloads once;
    - preserve unrelated days and connectors;
    - use byte-stable put-if-changed behaviour;
    - read back and verify changed payloads;
    - release the lock.
13. Use the non-nested lock lifecycle from the contract:

```text
connector-day lock: acquire, write, verify, release
then
day lock: acquire, merge, verify, release
then
global lock: acquire, update aggregates, verify, release
```

14. Remove the routine second unconditional full history-index rebuild only after the targeted shared finaliser is structurally complete and every current normal caller uses it.
15. Retain a full index builder only as an explicit repair or maintenance command.

### Focused structural checks

These are required because a lost parent-manifest update could hide valid connector history:

- existing day connector 1 plus current-run connector 2 produces a final day manifest containing both;
- a later merge replacing connector 2 preserves connector 1 unchanged;
- different connectors may write concurrently but day finalisation is serialised;
- the parent manifest is read after the day lock is acquired;
- current-run candidate lists cannot become the whole-day connector set;
- unrelated days and connector indexes remain byte-identical;
- the normal route does not invoke the full rebuild after successful targeted finalisation.

### Phase completion criteria

- Parent manifests cannot lose connectors written by another run.
- Connector indexes remain targeted.
- Day and global finalisation occurs once at the correct scope per run.

## Phase 5: Convert Prune Daily to the shared writer and correct gate sequence

**Owner:** Codex

### Tasks

1. Convert normal Prune Daily Phase B connector-day writes to the shared writer.
2. Keep the existing IngestDB frozen source and candidate identity rules.
3. For each candidate:
   - acquire the connector-day lock through the shared writer;
   - mark or keep the connector prune gate incomplete before observation replacement;
   - write and verify canonical observation history;
   - update and verify connector-targeted observation indexes;
   - release the connector-day lock;
   - set the exact connector prune gate complete from the final verified connector-manifest evidence.
4. Ensure only Prune Daily writes `prune_connector_day_gates`.
5. Keep `completion_source=prune_daily_phase_b` as the only supported normal completion source.
6. Remove normal historical gate adoption, backlog scanning and migration work from Prune Daily.
7. Remove or retire the manual Integrity gate-completion path, including `scripts/backup_r2/uk_aq_complete_integrity_connector_gates.mjs`, once no active supported path depends on it.
8. Remove active code and tests whose purpose is to let Integrity or historical migration complete prune gates.
9. Keep `prune_day_gates` intact. Do not remove or rename it in this phase.
10. Separate connector observation success from AQI and whole-day completion in Phase B return values and top-level control flow.
11. Ensure an AQI-only failure:
    - leaves AQI or aggregate day completion incomplete;
    - does not invalidate a successful connector observation gate;
    - does not cause the normal prune stage to skip deletion for connector-days with valid observation gates.
12. Preserve connector-specific deletion filtering before and after ObsAQIDB repair.
13. Preserve existing physical file-identity checks before gate completion.
14. Continue to fail closed for observation write, observation verification, connector-targeted observation-index or mandatory prune-comparison failures.
15. Use the shared day and global finalisers after connector work.

### Focused structural checks

These are deletion-safety checks and are genuinely required:

- observation write success followed by AQI failure leaves the connector gate valid;
- the same AQI failure leaves aggregate day state incomplete;
- prune filtering still allows the valid connector and blocks an invalid connector on the same day;
- only Prune Daily can call the connector-gate completion function;
- missing historical gates are not scanned by a normal run;
- no active caller references the retired gate-completion script;
- a connector observation failure invalidates only that connector-day gate.

### Phase completion criteria

- Prune Daily uses the shared writer and locks.
- Observation deletion is independent from AQI completion.
- Historical gate migration is no longer part of normal operation.

## Phase 6: Convert Integrity and migration to the shared writer

**Owner:** Codex

### Tasks

1. Keep the request-level boundary guard as the first scoped eligibility decision for every Integrity mode.
2. Preserve current source acquisition, mapping, count, hash, status, repair-planning and Dropbox-baseline contracts.
3. Preserve the rule that check-only and dry-run do not access live R2 and do not acquire writer locks.
4. Convert real repair and R2 structure migration writes to the shared connector-day writer.
5. Use connector-day locks only for exact mutation scopes.
6. Use the shared day finaliser after all connector mutations for an affected day.
7. Use the shared global index finaliser last.
8. Preserve selected-pollutant repair scope and opaque child preservation.
9. Remove every Integrity action that creates, completes, invalidates or backfills a prune gate.
10. Remove `history_integrity` as an active prune-gate completion source.
11. Remove or replace reports and tests that describe gate completion as an Integrity success condition.
12. Keep Integrity's own repair verification and audit evidence. Removing prune-gate ownership must not weaken R2 verification.
13. Ensure concurrent operation is allowed when Prune Daily and Integrity target different connector-days.
14. Ensure same connector-day contention fails safely through the shared lock.
15. Ensure different connectors on the same day can write independently and then serialise through the day finaliser.
16. Keep migration free of prune-gate work.

### Focused structural checks

- a boundary overlap fails the complete request before source acquisition;
- a valid check-only run does not acquire locks or access live R2;
- real Integrity uses the connector, day and global lock sequence;
- Integrity cannot import or invoke prune-gate mutation functions;
- migration mode uses the shared writer without gate changes;
- a same-connector-day lock conflict fails without mutation;
- different connector-days do not conflict.

### Phase completion criteria

- Integrity and Prune Daily may run concurrently on unrelated work.
- Integrity has no prune-gate ownership.
- Migration uses the shared canonical writer.

## Phase 7: Remove the legacy AQI RPC/export path

**Owner:** Codex

### Tasks

1. Make observation-derived AQI the only active Phase B implementation.
2. Retain the current canonical AQI calculation from observations, including:
   - DAQI and EAQI calculation through the shared AQI library;
   - older PM2.5 and PM10 observation context from ObsAQIDB;
   - target-day IngestDB observation precedence;
   - AQI data and debug R2 outputs;
   - AQI connector and day manifests;
   - targeted AQI indexes;
   - AQI statuses and missing reasons.
3. Remove the retired implementation and its selection infrastructure:
   - `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED`;
   - exactly-one-writer validation;
   - `runAqilevelsBackup()` or equivalent;
   - materialised AQI source RPC names and code used only by that exporter;
   - `aqilevels_source` aliases;
   - active v1 AQI write prefixes and branches;
   - fallback branches in `runPhaseBBackup()`;
   - workflow and environment configuration for the retired path;
   - tests that exist only to preserve writer selection or legacy export.
4. `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true` may temporarily remain only as a required-true assertion if removal in the same change would create avoidable deployment ambiguity. It must not remain a mode selector.
5. If the required-true guard remains, document it as temporary and identify the later removal point.
6. Keep ObsAQIDB PM context. Do not remove it as though it were the retired materialised AQI source.
7. Ensure no active Phase B AQI output writes to v1 history paths.
8. Keep AQI result reporting separate from connector observation-gate reporting.

### Focused structural checks

- retired flag, alias, exporter and fallback references are absent from active code and configuration;
- the observation-derived AQI path remains available and structurally complete;
- PM context still comes from the documented observation-context RPC only;
- AQI data and debug outputs retain the canonical v2 paths;
- no v1 AQI write path remains active;
- AQI failure cannot invalidate an observation gate.

### Phase completion criteria

- Phase B has one AQI implementation.
- ObsAQIDB is not a materialised AQI source for Phase B.

## Phase 8: Separate chart metrics from Prune Daily

**Owner:** Codex

### Tasks

1. Identify the exact chart metrics function currently called by Prune Daily.
2. Extract or expose it through a standalone entrypoint without changing its calculation or maintenance behaviour.
3. Add a separate GitHub Actions workflow using the existing authenticated Cloudflare-to-GitHub triggering pattern already used by this repository.
4. Give the standalone task its own:
   - workflow identity;
   - task-health key;
   - report and logs;
   - timeout and controlled failure result.
5. Remove chart metrics execution from the Prune Daily server and critical path.
6. Ensure a chart metrics failure cannot change the Prune Daily result, connector gates or IngestDB deletion decision.
7. Do not change chart metric formulae, schema or retention as part of this extraction.
8. Do not create a new scheduling architecture if the existing pattern can be reused.
9. If the exact dispatch event, schedule or authentication cannot be derived from an existing repository pattern, stop and request that decision rather than inventing one.

### Focused structural checks

- Prune Daily no longer imports or invokes chart metrics maintenance;
- the standalone entrypoint imports successfully;
- the workflow uses an existing trigger and secret pattern;
- task-health identity is separate;
- chart metrics failure has no path to alter prune gates or prune status.

### Phase completion criteria

- Chart metrics is a separate operational task.
- Prune Daily contains only work relevant to its own observation, history and pruning responsibilities.

## Phase 9: Code cleanup, documentation alignment and minimal structural validation

**Owner:** Codex

### Tasks

1. Remove dead imports, environment variables, configuration rows, aliases, tests and comments made obsolete by Phases 2 to 8.
2. Update system documentation only where:
   - implementation file paths changed;
   - workflow names changed;
   - task-health keys changed;
   - a temporary required-true AQI guard remains;
   - operational commands need exact updated names.
3. Do not alter the decisions in the authoritative contracts.
4. Update example environment files and deployment configuration consistently.
5. Confirm no active normal path performs:
   - Integrity prune-gate completion;
   - historical gate backlog scanning;
   - legacy AQI RPC export;
   - v1 AQI writing;
   - a second unconditional full index rebuild;
   - chart metrics inside Prune Daily;
   - a global Prune Daily-running exclusion for Integrity.
6. Run only the smallest relevant structural checks:
   - JavaScript, Deno, Python and shell syntax or type checks for changed files;
   - SQL structure checks only if SQL changed;
   - the focused deterministic checks from the earlier phases;
   - existing directly affected focused tests;
   - repository diff and formatting checks.
7. Do not run a real R2 write, real Integrity repair, destructive prune or full external integration suite.
8. Produce a concise implementation report containing:
   - phase-by-phase completion;
   - files changed;
   - removed legacy components;
   - environment or workflow changes needed at deployment;
   - checks run and results;
   - exact remaining operational validation steps;
   - any temporary compatibility guard still present.

### Codex completion criteria

All Codex phases are complete only when:

- the code matches the mandatory system contracts;
- no unresolved decision has been hidden or assumed;
- the changed modules are structurally viable;
- no real TEST or LIVE operation has been run;
- the repository contains a clear implementation report for handoff.

---

# User and ChatGPT phases

## Phase 10: Review the Codex implementation against the contracts

**Owners:** Mike and ChatGPT

### Mike

1. Provide the Codex completion summary and identify the branch, PR or commit containing the work.
2. Do not deploy until the contract review is complete.

### ChatGPT

1. Inspect the actual changed code and configuration.
2. Compare it directly with:
   - `history_writer_coordination.md`;
   - `prune_connector_day_gate.md`;
   - `aqi_history_write_pipeline.md`;
   - `integrity.md`;
   - `connector_gate_file_identity.md`.
3. Check particularly for:
   - duplicated lock-key logic;
   - locks held across nested scopes;
   - parent manifests built only from current candidates;
   - Integrity gate writes left behind;
   - AQI failure still blocking prune execution;
   - a legacy AQI route left active;
   - unconditional full index rebuilds;
   - chart metrics still running in Prune Daily;
   - undocumented workflow or environment changes.
4. Identify only concrete defects, omissions or decisions.
5. Where fixes are clear, prepare a narrow Codex follow-up prompt using a Codex model at High reasoning.

### Phase completion criteria

- The implementation is judged contract-complete or a bounded correction list exists.
- No deployment occurs with an unresolved deletion-safety or concurrent-write issue.

## Phase 11: Deploy to TEST and validate through real operations

**Owners:** Mike and ChatGPT

This is the functional validation stage. It uses the real TEST system rather than a speculative pre-deployment suite.

### Mike

1. Take the normal current backups required before changing R2-writing services.
2. Apply the required TEST environment, secret and workflow changes identified by Codex.
3. Deploy the updated Prune Daily, Integrity and standalone chart metrics paths to TEST.
4. Run the smallest set of real operations needed to validate the contracts.

### Real TEST validations

#### A. Integrity boundary failure

Run an Integrity request whose inclusive end date reaches the earliest IngestDB day for one requested connector.

Confirm:

- the complete request fails immediately;
- every blocking connector is reported;
- source acquisition and repair planning do not start;
- no writer lock or live R2 mutation occurs;
- no connector is skipped and no valid prefix is processed.

#### B. Valid Integrity operation behind the boundary

Run a valid scoped Integrity check or repair entirely before the relevant connector boundary.

Confirm:

- the boundary guard passes;
- check-only remains read-only;
- a real repair uses connector, day and global lock diagnostics in the required order;
- no prune gate changes are reported.

#### C. Concurrent unrelated work

Run Integrity for SOS while Prune Daily processes an unrelated connector-day where operationally convenient.

Confirm:

- neither process fails merely because the other process exists;
- unrelated connector-day locks do not conflict;
- task-health and logs distinguish each operation.

Do not deliberately force unsafe destructive concurrency merely to create a lock conflict. Same-resource contention is covered by the focused deterministic check unless a natural TEST collision occurs.

#### D. Existing connector preservation

Use a day where Integrity has written one connector and Prune Daily later adds another connector.

Confirm:

- the final observation day manifest contains both connectors;
- AQI parent manifests contain the correct available connectors;
- connector-specific indexes for the existing connector remain present;
- unchanged connector Parquet was not unnecessarily reread or rewritten;
- the final aggregate/latest indexes include the complete current day state.

#### E. Prune gate and AQI separation

Run a normal Prune Daily operation.

Confirm:

- connector observation history verifies before its connector gate becomes true;
- deletion uses the connector gate rather than the aggregate day gate;
- AQI status is reported separately;
- an AQI-only warning or failure, if naturally encountered, does not revoke the observation gate or block eligible observation deletion;
- no artificial AQI failure needs to be injected solely for testing.

#### F. Single AQI path

Confirm from the deployed configuration and logs:

- observation-derived AQI is the only active writer;
- no materialised AQI RPC export is called;
- PM context still uses the documented ObsAQIDB observation-context RPC;
- AQI writes only to canonical v2 data and debug paths.

#### G. Standalone chart metrics

Run the separate chart metrics workflow.

Confirm:

- it completes independently;
- it has its own task-health result;
- Prune Daily no longer includes chart metrics stages;
- its failure or success cannot alter prune gates.

### ChatGPT

1. Review the real logs, reports, manifests and workflow results supplied by Mike.
2. Compare observed behaviour with the contracts.
3. Separate genuine implementation defects from expected partial or aggregate states.
4. Prepare only targeted corrections supported by the TEST evidence.

### Phase completion criteria

- Real TEST operations show the correct boundary, locks, manifest merging, gate ownership, AQI separation and standalone chart metrics behaviour.
- No unexplained R2, gate or deletion discrepancy remains.

## Phase 12: Correct only defects observed in TEST

**Owners:** Mike and ChatGPT, with Codex used only for bounded fixes

1. Do not broaden the implementation after successful TEST evidence.
2. For each observed defect:
   - identify the violated contract;
   - identify the smallest code scope;
   - write a narrow Codex prompt;
   - recommend the strongest available Codex model at High reasoning;
   - rerun only the real operation needed to prove that defect is resolved.
3. Update system documentation only if the implemented operational detail changed without changing the agreed behaviour.
4. Repeat Phase 11 only for affected paths, not as a broad regression programme.

### Phase completion criteria

- All observed contract violations are resolved.
- No unverified speculative changes remain.

## Phase 13: Use Integrity for the R2 structure migration

**Owners:** Mike and ChatGPT

This phase happens only after the shared writer and locking model has been proven by normal TEST operations.

### Mike

1. Take a current R2 and Dropbox backup before migration work.
2. Select an explicit bounded migration range and connector scope.
3. Confirm the range is entirely before every requested connector's IngestDB boundary.
4. Run the Integrity-backed migration through the shared writer in manageable batches.
5. Do not involve Prune Daily in historical gate creation or migration completion.

### Confirm for each batch

- the boundary guard passes before source work;
- shared connector-day locks are used;
- day manifests preserve all existing connectors and pollutants;
- targeted indexes are updated without dropping unrelated entries;
- aggregate/latest indexes update once after day finalisation;
- no connector prune gates are created, completed or cleared;
- the next Dropbox backup captures the changed canonical v2 objects.

### ChatGPT

1. Review each batch report and any mismatch before the next batch.
2. Confirm whether the issue is source data, mapping, R2 structure, locking, manifest merging or indexing.
3. Do not recommend continuing through an unexplained failed batch.

### Phase completion criteria

- The selected historical data is migrated through Integrity and the shared writer.
- Prune Daily remains responsible only for current IngestDB-to-R2 movement.
- No migration-specific prune gates exist.

## Phase 14: Final operational cleanup

**Owners:** Mike and ChatGPT

1. Confirm the retired AQI flag, secrets, configuration and workflow inputs are no longer deployed.
2. Remove the temporary required-true observation-derived AQI guard if Codex retained it and TEST evidence shows it is no longer needed.
3. Confirm the manual Integrity gate-completion script is absent or clearly retired and unreachable.
4. Confirm the full index builder is available only as an explicit repair tool and is not in the normal daily path.
5. Confirm chart metrics scheduling is enabled separately.
6. Confirm the system docs list the actual implementation paths and workflow names.
7. Record the final TEST acceptance result in the plan or a linked completion note.

## Final acceptance criteria

This work is complete when all of the following are true:

- Integrity fails the whole request immediately when any requested connector range reaches IngestDB.
- Integrity does not require Prune Daily to be globally stopped.
- Connector-day, day-finalisation and global-index locks are shared and deterministic.
- Same-resource writes conflict safely while unrelated connector-day work may proceed concurrently.
- Prune Daily and Integrity use one canonical connector-day writer.
- Parent day manifests preserve connectors already present in R2.
- Connector indexes are targeted, affected days are finalised once per run and global indexes are finalised once per run.
- The normal route does not perform a second unconditional full index rebuild.
- Only Prune Daily writes connector-day prune gates.
- Integrity and migration do not create or modify prune gates.
- Observation deletion is authorised by verified observation history independently from AQI completion.
- Phase B has one observation-derived AQI implementation.
- The legacy materialised AQI RPC/export path and active v1 AQI path are removed.
- Chart metrics runs separately from Prune Daily.
- Real TEST operations confirm the behaviour.
- The historical R2 structure migration can proceed through Integrity without involving Prune Daily gates.
