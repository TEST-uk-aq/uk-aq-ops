# Latest Snapshot warm local cache and run-report reduction

- **Date:** 17 July 2026
- **Repository:** `TEST-uk-aq/uk-aq-ops`
- **Environment:** TEST only
- **Status:** Proposed amendment
- **Recommended coding model:** GPT-5.6 Codex with **High reasoning**

## Purpose

Reduce avoidable per-minute R2 reads and successful run-report object growth without changing the Latest Snapshot product, public API, state semantics, schedule or failure boundaries.

This is one amendment with two related optimisations:

1. retain an opportunistic warm local cache inside the current Cloud Run container while keeping R2 as the durable source of truth;
2. stop writing one successful scheduled run-report object every minute, while retaining structured logs and useful diagnostic reports.

The two optimisations should be implemented in one branch and deployed together, but they must remain independently configurable and reversible.

## Authoritative sources

Before implementation, read and follow:

```text
AGENTS.md
system_docs/README.md
system_docs/latest_snapshot/README.md
system_docs/latest_snapshot/contract.md
system_docs/latest_snapshot/data_flow.md
system_docs/latest_snapshot/state_model.md
system_docs/latest_snapshot/interfaces.md
system_docs/latest_snapshot/operations.md
system_docs/latest_snapshot/recovery.md
system_docs/latest_snapshot/validation.md
system_docs/latest_snapshot/decisions/0001-latest-valid-observation-state.md
system_docs/latest_snapshot/decisions/0002-finite-windows-from-all-snapshot.md
```

The authoritative Latest Snapshot system documents take precedence over this plan if an unrelated behaviour is described more precisely there.

Codex must not edit `system_docs/`. ChatGPT in Chat mode will update the authoritative system documentation after implementation and TEST validation.

## Current implementation facts

The current Cloud Run service:

- receives a request from Cloud Scheduler every minute;
- uses `run_service.ts` as a long-running HTTP parent process;
- starts `run_job.ts` in a new Deno child process for each accepted invocation;
- retains the existing child timeout, `SIGTERM` and `SIGKILL` safeguards;
- reads latest state from R2 at the start of each run;
- reads the R2 core metadata cache at the start of each run, even when the cache remains valid for 24 hours;
- reads the previous family manifest before rebuilding the three physical `window=all` products;
- writes state, metadata, physical snapshots and the manifest to R2 where required;
- currently defaults successful per-run report objects to enabled under `latest_snapshots/v2/_runs/`;
- continues writing structured Cloud Logging summaries independently of R2 run reports.

Because `run_job.ts` is a fresh child process on each invocation, a module-level in-memory cache inside that file would not survive between runs. A container-local filesystem cache can survive across child processes while the Cloud Run container remains warm.

Cloud Run container-local storage is ephemeral. The service must always tolerate a cold start or the loss of every local cache file.

## Target behaviour

### Warm local cache

Use a small container-local cache under:

```text
/tmp/uk-aq-latest-snapshot-cache
```

The path may be configurable for local execution, but `/tmp/uk-aq-latest-snapshot-cache` should remain the production default.

Cache the durable R2 bytes and associated validation metadata for:

1. `latest_snapshots_state/v1/latest_state.json`;
2. `latest_snapshots_state/v1/core_metadata_cache_v2.json`;
3. `latest_snapshots/v2/manifest.json`.

The local cache is an optimisation only. It is not a new state authority, backup or recovery source.

Required behaviour:

- a cold start or cache miss uses the existing R2 load path;
- a warm local entry is reused only after validating it against the corresponding R2 object using the strongest stable fingerprint already exposed by the existing R2 helper, preferably ETag and otherwise an existing reliable combination such as size and last-modified metadata;
- if validation shows a mismatch, the current R2 object is downloaded and the local cache is refreshed;
- if the local data or sidecar is corrupt, incomplete or inconsistent, ignore it and use the normal R2 path;
- if R2 validation or loading fails, do not silently use an unvalidated stale local copy as authoritative;
- do not expand the task into a redesign of existing object-specific R2 failure semantics;
- after a successful durable R2 write, update the matching local cache entry using the exact bytes that were written;
- update local files atomically using a temporary file and rename;
- local cache read or write failures must be logged and treated as cache misses unless the underlying durable R2 operation itself failed;
- never acknowledge Pub/Sub messages based only on a local cache write;
- no state or manifest write may be considered complete until the R2 write has succeeded;
- a local cache hit must not alter state hashes, manifest hashes, stable JSON, row ordering, cursor derivation or generated R2 bytes;
- disabling the local cache must return the service to the existing direct-R2 behaviour without a migration.

Add a runtime switch:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED
```

Required values:

- default: `true`;
- false values should follow the repository's existing boolean parsing conventions.

An optional directory variable may be added if useful for local execution:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_DIR
```

Default:

```text
/tmp/uk-aq-latest-snapshot-cache
```

Do not add a complicated eviction system. The cache contains only the three named durable objects and their small sidecars.

### Run-report policy

Add:

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE
```

Accepted values:

```text
all
failures
off
```

Default:

```text
failures
```

Semantics:

- `all`: write the existing run-report object for every completed scheduled or manual run;
- `failures`: write a report for a completed failed or partial build, and for every manual invocation whether successful or failed;
- `off`: do not write R2 run-report objects;
- structured Cloud Logging remains enabled in every mode;
- the family manifest continues to be written according to the existing rules in every mode;
- early failures that occur before a build report can be assembled remain represented by structured service logs and normal failure status. Do not broaden this amendment into a new global exception-reporting framework.

Compatibility with the old setting:

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED
```

Required resolution order:

1. when `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE` is explicitly present, it wins;
2. when the new mode is absent and the old boolean is explicitly present, map `true` to `all` and `false` to `off`;
3. when neither is present, use `failures`.

The active GitHub Actions deployment workflow should pass the new mode with a default of `failures` and should stop supplying a default `true` value for the old boolean.

Do not delete existing `_runs` objects. Their retention or cleanup is outside this amendment.

## Functionality that must not change

This amendment must preserve all unrelated behaviour in the authoritative Latest Snapshot system documents.

### Pub/Sub and state

Preserve:

- the dedicated Latest Snapshot Pub/Sub subscription;
- the subscription safety comparison with the raw observs writer subscription;
- pull batch, retry and acknowledgement chunk limits;
- malformed message handling;
- acknowledgement ordering after successful state handling;
- latest state identity `(connector_id, timeseries_id)`;
- latest-valid pollutant value eligibility;
- PM2.5, PM10 and NO2 current-value rules;
- `observed_at` ordering and existing same-timestamp tie-breaking;
- state schema version `1`;
- state key and deterministic serialisation;
- hash-gated state writes;
- maximum state entry protection;
- raw observation preservation.

### Metadata

Preserve:

- the `history/v2/core` source family;
- the existing lookback and refresh interval;
- required connector, network, station, timeseries, phenomenon and observed-property tables;
- `station.network_id -> networks.id` public network ownership;
- public visibility and geography eligibility;
- no connector-derived network fallback;
- metadata-cache schema version and R2 key.

The warm local cache must not postpone an R2 metadata refresh once the existing metadata refresh interval has expired.

### Physical snapshots and manifest

Preserve:

- exactly three physical current snapshot objects: PM2.5/all, PM10/all and NO2/all;
- the `latest_snapshots/v2` prefix;
- stable object keys;
- v2 top-level and row fields;
- row ordering and cursor meanings;
- stable JSON and SHA-256 hash gating;
- skipping unchanged snapshot writes;
- previous manifest-entry preservation on a pollutant build failure;
- the three-entry physical manifest;
- `matrix.windows=["all"]`;
- optional run reports remaining outside the manifest product inventory.

### Public API and downstream consumers

Do not change:

- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs` unless a directly related compatibility correction is demonstrably required;
- finite-window derivation from the physical `all` object;
- UTC-minute cutoffs;
- finite response order, counts, cursors or ETags;
- `window=all` direct response behaviour;
- public routes, accepted query values or response fields;
- the v2 contract marker;
- cache-proxy routes, cache keys, authentication or website behaviour.

### Cloud Run service operation

Preserve:

- Cloud Scheduler cadence `* * * * *`;
- `Etc/UTC` scheduling;
- no scheduler retries;
- service CPU, memory, concurrency and instance limits;
- maximum instances `1`;
- the in-memory overlap guard;
- request and child timeouts;
- child-process isolation;
- `SIGTERM`, grace period and `SIGKILL` escalation;
- manual and scheduler trigger-mode detection;
- service egress metrics behaviour;
- secret bindings and authentication.

Do not move `run_job.ts` into the long-running parent process merely to obtain an in-memory cache. The existing child-process timeout and termination boundary is load-bearing and must remain.

## Scope

### Expected active files

```text
workers/uk_aq_latest_snapshot_cloud_run/run_job.ts
workers/uk_aq_latest_snapshot_cloud_run/README.md
.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml
config/uk_aq_github_env_targets.csv
```

A focused helper may be added under:

```text
workers/uk_aq_latest_snapshot_cloud_run/
```

For example:

```text
local_r2_cache.ts
```

Use the name and split that best fit the existing code. Do not create a general repository-wide cache framework for this amendment.

`run_service.ts`, `service_core.ts`, the Dockerfile and shared R2 helper should remain unchanged unless inspection proves a small change is structurally necessary. Explain any such deviation before making it.

### Out of scope

- `system_docs/` changes by Codex;
- Artifact Registry cleanup;
- deletion or retention of existing run-report objects;
- changing R2 bucket lifecycle rules;
- changing public API caching;
- changing the physical snapshot matrix;
- changing Pub/Sub subscription architecture;
- schema or database migrations;
- raw observation changes;
- AQI or WHO changes;
- changing Cloud Run resources or schedule;
- redesigning the service into a continuously running worker;
- broad shared-library refactoring;
- LIVE deployment.

## Archive rule

Follow `AGENTS.md`.

This date already contains archive snapshots for some Latest Snapshot files. Reuse an existing `archive/2026-07-17/...` copy where one already exists. Do not create a second archive copy of the same source file on the same date.

Only add an archive snapshot for another active non-test implementation file if the change is genuinely major or high-risk under the repository archive policy.

## TEST validation policy

Follow `AGENTS.md` and `system_docs/latest_snapshot/validation.md`.

Before deployment:

- perform only the smallest structural review needed to prove that the cache can persist across child processes in the same container and that R2 remains durable authority;
- run syntax or type validation for changed files;
- parse the changed workflow configuration;
- do not create new automated tests by default;
- add at most one narrow deterministic check only if Codex identifies a specific cache-consistency or mode-resolution risk that cannot reasonably be confirmed through normal TEST operation;
- do not run broad suites, external R2 operations, Pub/Sub calls, browser automation, shadow comparisons or a soak period before deployment.

Functional validation belongs to the deployed TEST service.

# Phase 0: confirm structural viability

## Goal

Confirm the smallest viable implementation shape before editing code.

## Required inspection

1. Confirm the parent Cloud Run process and child job share the container filesystem and that `/tmp` is available to the child under the existing Deno permissions.
2. Identify the current loaders and writers for:
   - latest state;
   - core metadata cache;
   - previous manifest.
3. Identify the object metadata currently exposed by `r2HeadObject` or existing response helpers.
4. Choose the strongest stable R2 fingerprint already available without a broad shared-helper change.
5. Confirm the new run-report mode can be resolved before the existing report-write decision without altering build success or failure handling.
6. Confirm the GitHub Actions workflow currently supplies the legacy run-report boolean and locate the relevant configuration inventory entry.
7. Confirm there is no active consumer that requires a successful scheduled `_runs` object every minute.

## Decision gate

Proceed when:

- the local cache can be implemented within the existing child-process model;
- local files remain optional and disposable;
- R2 validation remains part of every local-cache reuse decision;
- successful scheduled report objects are not an input to another active system.

If an active dependency on every successful run-report object is found, stop and report it rather than silently changing that consumer.

## Codex prompt for Phase 0 and implementation preparation

```text
Use GPT-5.6 Codex with High reasoning.

Work in TEST-uk-aq/uk-aq-ops only. Do not inspect or modify LIVE.

Read AGENTS.md and the complete authoritative Latest Snapshot area under system_docs/latest_snapshot/. Then read:

plans/2026-07-17 latest_snapshot warm cache and reports/plan.md

Perform Phase 0 only. Confirm the structural viability of a container-local /tmp cache shared by run_service.ts and each run_job.ts child process, while keeping R2 as durable authority. Identify the exact state, metadata-cache and manifest load/write functions, the strongest existing R2 fingerprint available for validation, the current successful run-report writer, and whether any active consumer depends on every successful scheduled _runs object.

Do not edit code, configuration, tests or system_docs in this phase. Do not run external operations. Do not propose a broad test programme.

Return a concise Phase 0 finding with:
- exact files and functions involved;
- the selected cache fingerprint and why it is sufficient;
- any genuinely necessary small shared-helper change;
- confirmation that child processes can reuse /tmp in a warm container;
- run-report dependency findings;
- any blocker or deviation from the plan.
```

# Phase 1: implement the warm local cache

## Goal

Reduce repeated R2 body downloads while preserving byte-for-byte durable products and existing service boundaries.

## Required implementation

1. Add a focused local-cache helper or focused functions in the Latest Snapshot Cloud Run directory.
2. Use a deterministic local filename derived safely from the known durable object identity. Do not interpolate untrusted paths directly into filesystem paths.
3. Store:
   - durable object bytes;
   - a small sidecar containing the R2 validation fingerprint and object identity.
4. Validate the local entry against R2 before reuse.
5. On a cold start, missing entry, invalid sidecar, fingerprint mismatch or local parse failure, use the existing R2 GET path.
6. Refresh the local entry after a successful R2 GET.
7. After a successful R2 PUT of state, metadata cache or manifest, replace the local bytes and sidecar atomically.
8. If the local write fails after R2 succeeds, continue the run and log a cache warning.
9. If R2 does not validate the local copy, do not use the stale local copy merely to keep the run alive.
10. Add `UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED`, default `true`.
11. Add a configurable cache directory only if useful, defaulting to `/tmp/uk-aq-latest-snapshot-cache`.
12. Add compact structured telemetry sufficient to distinguish:
    - disabled;
    - cold miss;
    - warm hit;
    - fingerprint mismatch and refresh;
    - corrupt local entry;
    - local write failure.
13. Include cache statistics in the existing job summary or a single dedicated structured event. Do not create per-object noisy logs on every normal hit if one compact summary is sufficient.

## Required cache semantics by object

### Latest state

- Preserve the current state parser and state-map result.
- Preserve the state hash used for write gating.
- Never update the local state cache before the R2 state PUT succeeds.
- Pub/Sub acknowledgement must remain after successful state handling and durable state persistence.

### Core metadata cache

- Preserve the current metadata freshness interval.
- A locally cached metadata object must still be considered expired when its existing `generated_at` age exceeds the configured refresh interval.
- Expiry must cause the existing R2/core-snapshot refresh path to run.
- Never allow local caching to extend metadata freshness beyond the current policy.

### Previous manifest

- Preserve previous-entry lookup and partial-failure behaviour.
- Never update the local manifest cache before the R2 manifest PUT succeeds.
- A local manifest hit must produce the same previous-entry comparison as the R2 bytes.

## Phase 1 acceptance

- disabling the feature restores direct R2 loading;
- a cold container uses R2 and populates local files;
- a subsequent child in the same warm container can reuse validated local bytes;
- a changed R2 object invalidates and refreshes the local copy;
- a corrupt local file is ignored;
- local failures do not replace durable R2 failures or acknowledgement rules;
- generated state and manifest bytes remain unchanged for identical input.

# Phase 2: implement run-report modes

## Goal

Stop successful scheduled runs creating a permanent R2 report object every minute while retaining useful diagnostic evidence.

## Required implementation

1. Add `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE` with `all`, `failures` and `off`.
2. Default to `failures` when neither the new mode nor legacy boolean is present.
3. Preserve the legacy `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED` fallback mapping.
4. Reject or fail clearly on an explicitly invalid new mode. Do not silently convert an invalid configured mode to another mode.
5. Decide whether to write a report only after the current build result and trigger mode are known.
6. Under `failures`:
   - do not write a report for a successful scheduled run;
   - write a report for a completed partial or failed build;
   - write a report for a completed manual run, including a successful manual run.
7. Preserve the existing report schema and key naming for reports that are written.
8. Preserve the current structured `latest_snapshot_job_summary` log for every completed run.
9. Add the resolved mode and report-write decision/reason to compact structured telemetry.
10. Update the Cloud Run deployment workflow to pass the new mode with default `failures`.
11. Stop the workflow from supplying a default `true` value for the legacy boolean.
12. Update `config/uk_aq_github_env_targets.csv` consistently.
13. Update the worker-local README with the new settings and compatibility rule.
14. Do not delete old report objects.

## Phase 2 acceptance

- scheduled success in `failures` mode writes no `_runs` object;
- a completed manual run in `failures` mode remains reportable;
- `all` preserves the old every-completed-run behaviour;
- `off` writes no run reports;
- the legacy boolean still works only when the new mode is absent;
- manifest and job success semantics do not depend on whether a run report is written.

## Codex prompt for Phases 1 and 2

```text
Use GPT-5.6 Codex with High reasoning.

Work in TEST-uk-aq/uk-aq-ops only. Do not inspect or modify LIVE.

Read AGENTS.md, the complete authoritative system_docs/latest_snapshot/ area, and:

plans/2026-07-17 latest_snapshot warm cache and reports/plan.md

Use the accepted Phase 0 findings and implement Phases 1 and 2 in one focused branch/change set.

Implement an opportunistic container-local /tmp cache for latest_state.json, core_metadata_cache_v2.json and the v2 manifest. Keep the existing run_service.ts child-process isolation and timeout/kill boundary. R2 remains durable authority. Validate every local reuse against the corresponding R2 object using the strongest existing fingerprint identified in Phase 0. Use atomic local writes, treat local errors as cache misses/warnings, and never acknowledge Pub/Sub based only on local state.

Add UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED with default true. Add a cache-directory variable only if useful, defaulting to /tmp/uk-aq-latest-snapshot-cache.

Add UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE with all, failures and off. Default to failures. When the new mode is absent, retain compatibility with UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED by mapping true to all and false to off. In failures mode, successful scheduled runs write no R2 run-report object, completed failures/partial failures write a report, and completed manual runs write a report. Preserve the existing report schema for reports that are written.

Update the active Cloud Run deployment workflow, config/uk_aq_github_env_targets.csv and the worker-local Cloud Run README where required. Do not edit system_docs. Do not change the R2 API Worker, cache proxy, website, public v2 contract, physical three-object matrix, state schema, latest-valid rules, Pub/Sub acknowledgement ordering, scheduler cadence, Cloud Run resources, overlap handling, timeout handling or raw observation systems.

Follow the archive policy. Reuse any existing archive/2026-07-17 copy and do not create duplicate same-day snapshots.

Before implementation, only confirm structural viability. After edits, run only syntax/type validation and workflow parsing. Do not create new tests by default. Add one narrow deterministic check only if a specific high-risk cache-consistency or mode-resolution condition genuinely cannot be verified through normal TEST operation, and explain why.

Return:
- exact files changed;
- implementation summary;
- resolved environment-variable semantics;
- local-cache fingerprint and atomic-write design;
- preserved behaviours checked against system_docs;
- minimal checks run;
- deployment requirements;
- rollback settings;
- a concise handover for ChatGPT to update system_docs after deployment.
```

# Phase 3: deploy once to TEST and validate real operation

## Goal

Deploy both optimisations together and validate them through normal TEST service operation with the smallest useful checks.

## Deployment

Use the existing Latest Snapshot Cloud Run deployment workflow.

Required TEST configuration:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=failures
```

Do not change scheduler cadence, Cloud Run resources, Pub/Sub subscription, R2 prefixes or public API configuration.

## Minimal operational validation

### First invocation after deployment

A cold or newly revised container may report cache misses. Confirm:

- the child completes normally;
- `success_count=3`;
- `failure_count=0`;
- `matrix.windows=["all"]`;
- the manifest has three physical entries;
- Pub/Sub acknowledgement remains healthy;
- no new state, metadata, R2, timeout or overlap errors appear;
- local cache population is reported without affecting the durable run.

### Subsequent warm invocation

On a subsequent invocation handled by the same warm container, confirm at least one validated local cache hit. A cache miss caused by a genuine Cloud Run cold start is expected and is not a defect.

Do not run a soak period. One confirmed warm hit is sufficient.

### Run-report behaviour

For one successful scheduled run in `failures` mode, confirm:

- the normal structured job summary is present;
- the manifest remains current;
- the report decision says the successful scheduled report was skipped;
- no new successful scheduled `_runs` object is written.

Do not deliberately cause a service or data failure merely to test failure reporting.

A successful manual invocation may be used once to confirm that `failures` mode still writes a manual diagnostic report if this can be checked without broadening the operation. It is optional if the code path is structurally clear and the scheduled-success goal has been confirmed.

### Public output

Make one representative request through the normal TEST path, or load the normal TEST map/search once, and confirm Latest Snapshot data still displays.

No all-window matrix comparison, browser automation, backfill, shadow mode or soak period is required.

## Rollback

### Configuration-only rollback

The two features are independently reversible:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

Redeploying those settings restores direct R2 reads and the previous successful run-report frequency without deleting local or R2 data.

### Code rollback

If required, restore the previous Cloud Run revision and make one representative normal request.

Local `/tmp` files require no cleanup. They disappear with the container.

Do not modify latest state, the manifest, raw observations or old run-report objects as part of rollback.

## Codex prompt for Phase 3

```text
Use GPT-5.6 Codex with High reasoning.

Perform Phase 3 of:

plans/2026-07-17 latest_snapshot warm cache and reports/plan.md

This explicitly authorises the required TEST Cloud Run deployment. Do not touch LIVE. Do not edit system_docs.

Deploy the completed Latest Snapshot warm-cache and run-report-mode amendment using the existing workflow with:

UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=failures

Do not change scheduler cadence, resources, subscription, R2 paths, the public API, the physical three-object matrix or any unrelated service setting.

Observe one normal first run and confirm success_count=3, failure_count=0, matrix.windows=["all"], three manifest entries, healthy Pub/Sub acknowledgement and no new R2/metadata/timeout/overlap error. Then confirm one validated local-cache hit on a later invocation handled by the same warm container. A real cold-start miss is acceptable.

For one successful scheduled run, confirm the structured summary remains present and no successful scheduled _runs object is written in failures mode. Do not induce a failure. A single successful manual run-report check is optional if straightforward.

Make one representative TEST public output or website map/search check. Do not run broad tests, full matrix comparisons, shadow mode or a soak period.

Return:
- deployed revision and workflow result;
- resolved runtime variables;
- first-run cache summary;
- warm-run cache summary;
- builder and manifest summary;
- scheduled run-report decision and evidence;
- representative public/website result;
- any deviation;
- the implementation handover ChatGPT needs for Phase 4.
```

# Phase 4: ChatGPT updates authoritative system documentation

## Owner

**ChatGPT in Chat mode must perform this phase. Codex must not edit `system_docs`.**

After implementation and TEST validation, ChatGPT must inspect the committed code and the Codex handover, then update the authoritative Latest Snapshot documentation where required.

At minimum inspect:

```text
system_docs/latest_snapshot/README.md
system_docs/latest_snapshot/contract.md
system_docs/latest_snapshot/data_flow.md
system_docs/latest_snapshot/state_model.md
system_docs/latest_snapshot/interfaces.md
system_docs/latest_snapshot/operations.md
system_docs/latest_snapshot/recovery.md
system_docs/latest_snapshot/validation.md
system_docs/latest_snapshot/decisions/
system_docs/migration_inventory.md
```

The documentation should record:

- R2 remains the durable source of truth;
- the local `/tmp` cache is opportunistic and disposable;
- cold starts use R2;
- local reuse requires R2 validation;
- durable writes complete before local write-through;
- local failures do not advance Pub/Sub acknowledgement or replace R2 failure handling;
- the three cached durable objects;
- cache disable and rollback behaviour;
- `UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE` semantics;
- legacy boolean compatibility;
- successful scheduled reports are skipped by default;
- structured logs and the family manifest remain available;
- manual and failed completed runs remain reportable under `failures` mode;
- existing run-report objects are retained;
- TEST validation remains deliberately minimal.

ChatGPT should add a new ADR if the implemented cache and report policy are sufficiently load-bearing to warrant one. A suitable decision title would be:

```text
ADR 0003: R2 remains durable while warm containers cache validated Latest Snapshot objects
```

The final wording must reflect the implementation actually committed and deployed, not merely this proposal.

# Final acceptance

The amendment is complete when:

1. R2 remains the durable authority for latest state, metadata cache and manifest;
2. a warm container can reuse validated local bytes across child invocations;
3. cold starts and cache loss remain safe;
4. local writes occur only after successful durable writes;
5. local failures do not alter acknowledgement or product correctness;
6. scheduled successful runs in default `failures` mode create no `_runs` object;
7. completed failed/partial and manual runs remain reportable as specified;
8. existing report schema and keys remain unchanged when a report is written;
9. the builder still creates exactly three physical `window=all` products;
10. state, metadata, manifest, public API and website behaviour remain unchanged;
11. scheduler, resources, overlap and timeout boundaries remain unchanged;
12. one normal TEST run succeeds;
13. one warm-cache hit is observed when a container remains warm;
14. one representative public or website output succeeds;
15. ChatGPT updates the authoritative system documentation after deployment.
