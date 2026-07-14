# UK AQ AQI migration: two-pass Codex Cloud plan

**Date:** 14 July 2026  
**Target environment:** TEST only  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Related repositories:**

- `TEST-uk-aq/uk-aq-ingest`
- `TEST-uk-aq/uk-aq-schema`
- `TEST-uk-aq/TEST-uk-aq-root.github.io`

## 1. Purpose

Implement the new AQI architecture in two Codex Cloud passes instead of many small tasks.

The final architecture is:

```text
Obs AQI DB
  observations + metadata + ops state

Phase B prune/history
  reads and freezes D-1 and D observations
  writes D observations to R2
  calculates D AQI from the same frozen source
  writes D AQI to R2

Integrity
  repairs historical R2 observations
  rebuilds affected historical R2 AQI

AQI history worker
  reads R2 AQI first
  calculates only recent AQI keys missing from R2
  R2 AQI always wins
  R2 observations always win over overlapping ingest observations

Cache proxy
  owns all AQI response caching
  uses an internal UTC hourly generation key for recent or mixed requests

Supabase calculated AQI tables
  retained temporarily during TEST cutover
  removed only after dependency and operational validation
```

The failed GCP AQI hourly service and schedulers have already been removed or are being removed manually. They must not be restored.

---

## 2. Non-negotiable architecture

### 2.1 R2 AQI precedence

For the canonical AQI row key:

```text
timeseries_id + pollutant_code + timestamp_hour_utc
```

precedence is:

```text
R2 AQI
  > live-calculated AQI
  > no row
```

An R2 row wins even if its index value is null or its status reports insufficient data.

### 2.2 R2 observation precedence

For the repository's canonical observation identity:

```text
R2 observation
  > ingest observation
```

Ingest observations may fill missing source keys but must not replace overlapping R2 observations.

### 2.3 Permanent AQI generation

For Phase B target day `D`:

```text
read and freeze D-1 and D source observations
             │
             ├── write D observations to R2
             │
             └── calculate D AQI from the same frozen rows
                         │
                         └── write D AQI to R2
```

Requirements:

- PM2.5 and PM10 use D-1 as rolling context.
- Only day-D AQI output is written.
- Normal Phase B does not reread R2 to calculate AQI.
- The same normalised frozen source must feed both outputs.
- AQI generation or R2 write failure blocks prune completion.
- Retry remains idempotent.

### 2.4 Historical repair

Integrity remains responsible for:

- historical R2 observation repair;
- recalculation of affected R2 AQI;
- replacement of repaired AQI history.

No observation-manifest hash is required.

### 2.5 Supabase AQI retirement

Calculated AQI tables, views, functions, indexes and RPCs in Supabase are not dropped during either Codex pass.

They may be disabled or marked legacy only after:

1. Phase B writes permanent AQI directly to R2.
2. The AQI history worker no longer reads materialised Supabase AQI.
3. Station Snapshot v2 no longer reads materialised Supabase AQI.
4. The ingest dashboard no longer expects Obs AQI DB AQI coverage.
5. Active repository dependency searches are clean.
6. TEST has completed normal operations successfully.

---

# 3. Pass 1: core AQI implementation in `uk-aq-ops`

## Recommended Codex model

**GPT-5.6 Sol, High reasoning**

This pass contains transaction/snapshot handling, PM rolling correctness, prune gates, multiple R2 writers and Worker cache semantics. Do not use a low-cost model.

## Objective

Implement the complete core architecture in `TEST-uk-aq/uk-aq-ops`, but do not deploy, enable feature flags, remove legacy database objects or perform irreversible cleanup.

The pass should cover:

1. Phase B permanent AQI generation from frozen observations.
2. Removal of the materialised Supabase AQI fallback from the AQI history worker.
3. R2-first live AQI calculation for recent missing hours.
4. Cache proxy ownership of all AQI response caching.
5. UTC hourly cache-generation keys.
6. Feature flags, diagnostics, documentation and code-level tests.
7. A complete dependency report for the remaining Supabase AQI consumers.

## Codex Cloud prompt 1

```text
You are working in the repository:

TEST-uk-aq/uk-aq-ops

Use GPT-5.6 Sol with High reasoning.

Do not deploy.
Do not commit, push or open a pull request unless the Codex Cloud task requires a branch for its normal output.
Do not enable new feature flags.
Do not drop or alter production data.
Do not remove Supabase AQI tables, views, functions, indexes or RPCs.
Do not restore the retired GCP AQI hourly Cloud Run service or schedulers.

Implement the complete core R2-first AQI architecture described below.

==================================================
FIXED ARCHITECTURE
==================================================

1. R2 AQI always wins.

Canonical AQI key:

timeseries_id + pollutant_code + timestamp_hour_utc

Precedence:

R2 AQI
  > live-calculated AQI
  > no row

An existing R2 AQI row wins even when its index value is null or its status reports insufficient or missing input.

2. R2 observations always win over overlapping ingest observations.

Ingest observations may fill observation keys absent from R2. They must not replace an R2 observation.

3. Permanent AQI is generated by Phase B.

For target day D:

- read and freeze D-1 and D canonical observations;
- use the same normalised frozen source rows to:
  a. write day-D observations to R2;
  b. calculate and write day-D AQI to R2;
- PM2.5 and PM10 use D-1 as rolling context;
- only day-D AQI rows are written;
- normal Phase B must not reread R2 to calculate AQI;
- an AQI calculation or AQI R2 write failure must block prune completion;
- retries must remain idempotent.

4. Integrity continues to own historical R2 observation repair and affected AQI rebuilds.

Do not add observation-manifest hashes.

5. The AQI history worker becomes R2-first with live observation fallback.

It must:

- read authoritative R2 AQI first;
- identify expected AQI keys missing from R2;
- restrict live calculation to the recent ingest-retention/mutable window;
- read only the required requested timeseries and pollutant observation windows;
- include the preceding 23 hours for PM output windows;
- read R2 observations and ingest observations;
- merge observations with R2 precedence;
- calculate using the shared AQI library;
- insert only AQI keys absent from R2;
- return explicit provenance and completeness diagnostics;
- stop reading materialised Supabase AQI rows as the fallback source.

6. The cache proxy owns all public AQI response caching.

Request path:

website
  -> uk_aq_cache_proxy
  -> uk_aq_aqi_history_r2_api_worker

Requirements:

- add an internal, versioned UTC hourly generation component to recent or mixed AQI cache keys;
- do not forward the generation parameter to the AQI worker;
- immutable explicit historical requests keep stable long-lived cache keys;
- ambiguity defaults to the recent/mixed policy;
- partial or incomplete responses are never cached;
- preserve bypass, CORS, retries, ETag and 304 behaviour;
- remove or disable the AQI worker's own caches.default response cache in the final feature-flagged path;
- direct authenticated AQI worker responses should be no-store;
- make only a narrowly scoped AQI-route exception allowing the proxy to cache a complete authenticated upstream no-store response;
- do not weaken no-store or private handling for any other proxy route.

==================================================
PHASE B IMPLEMENTATION
==================================================

Inspect the current code before editing, especially:

- workers/uk_aq_prune_daily/phase_b_history_r2.mjs
- its callers and workflow configuration
- candidate, checkpoint, resume and prune-day gate logic
- v2 observation data writers and manifests
- v2 AQI data/debug writers and manifests
- history index builders
- lib/aqi/aqi_levels.mjs
- integrity/backfill AQI rebuild paths
- current AQI history RPC source path

Choose a bounded way to freeze source observations.

Acceptable examples include:

- a stable repeatable-read transaction with bounded cursors;
- a bounded local staging file;
- an in-memory design only where actual row volumes are measured and explicitly capped.

Do not create unbounded memory use.

The same normalised source snapshot must feed both:

- day-D observation output;
- D-1 plus D AQI calculation input.

Keep connector/day partitioning where practical.

Record an explicit successful no-supported-AQI-source outcome when a connector/day contains no supported calculated AQI pollutants.

The day gate must not report history_done=true until all required observation and AQI data, manifests and indexes have succeeded and been verified.

==================================================
SHARED AQI CODE
==================================================

Reuse the existing shared AQI library.

Do not copy or redefine:

- pollutant normalisation;
- hourly aggregation;
- PM rolling 24-hour logic;
- DAQI breakpoints;
- EAQI breakpoints;
- required sample counts;
- calculation statuses or missing reasons;
- algorithm version.

The same algorithm must remain usable by:

- Phase B;
- integrity/backfill;
- live AQI fallback.

==================================================
FEATURE FLAGS
==================================================

Use existing naming conventions where possible. Otherwise add disabled-by-default flags equivalent to:

UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=false
UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=true

Do not enable them in this task.

==================================================
STRUCTURAL AND CODE VALIDATION
==================================================

Before implementation, only check that the proposed transaction, cursor, staging and migration structure is viable.

After implementation, run the repository's existing relevant unit, contract and integration-style code tests.

Add targeted tests only for implemented behaviour, including:

- same frozen source feeds observation and AQI output;
- day-D observation output;
- D-1 plus D PM input;
- day-D AQI output only;
- AQI write failure blocks the prune gate;
- idempotent retry;
- explicit no-supported-pollutant outcome;
- R2 AQI precedence, including null/status rows;
- R2 observation precedence;
- distinct late ingest observations;
- NO2, PM2.5 and PM10 live calculation;
- multiple and overlapping missing-hour windows;
- ingest-retention boundary;
- partial response handling;
- deterministic same-hour cache key;
- UTC hour rollover;
- immutable historical key stability;
- generation parameter not forwarded upstream;
- incomplete response not cached;
- no-store exception limited to the AQI upstream.

Do not claim operational success. Functional validation will occur later through real TEST deployments and normal operations.

==================================================
DEPENDENCY AUDIT
==================================================

Search all active code and documentation in this repository for current dependencies on:

- uk_aq_aqilevels.timeseries_aqi_hourly
- uk_aq_aqilevels.timeseries_aqi_daily
- uk_aq_aqilevels.timeseries_aqi_monthly
- uk_aq_timeseries_aqi_hourly
- uk_aq_rpc_aqilevels_history_day_connector_counts
- uk_aq_rpc_aqilevels_history_day_rows
- helper, staging, rollup and reconciliation functions used only by materialised Supabase AQI
- Obs AQI DB AQI coverage metrics
- Station Snapshot AQI reads

Do not remove cross-repository consumers in this pass.

Create a precise migration report listing:

- active dependencies removed;
- active dependencies remaining;
- database objects that appear removable later;
- database objects that must remain for observations, metadata, ops or integrity;
- cross-repository work required in Pass 2.

==================================================
OUTPUT
==================================================

Return:

1. summary of the implemented architecture;
2. files changed;
3. the chosen frozen-source mechanism and its bounds;
4. Phase B failure and retry behaviour;
5. AQI history source precedence;
6. cache-key and cacheability design;
7. feature flags and defaults;
8. tests run and results;
9. remaining Supabase AQI dependencies;
10. exact manual TEST deployment and validation steps;
11. any issue that prevents safe completion.

Do not deploy or perform destructive database changes.
```

---

# 4. Manual checkpoint after Pass 1

Do not start Pass 2 until the Pass 1 output has been reviewed.

## Mike's low-cost checks

1. Review the changed-file list.
2. Confirm the new features remain disabled by default.
3. Confirm no Supabase AQI object has been dropped.
4. Confirm the GCP AQI service is not restored.
5. Inspect the proposed frozen-source mechanism.
6. Confirm Phase B AQI failure blocks prune completion.
7. Confirm the AQI history worker is R2-first.
8. Confirm the hourly generation parameter is internal to the proxy cache key.
9. Review the remaining dependency inventory.
10. Decide whether the Pass 1 branch should be merged before starting Pass 2.

## Real TEST validation after deployment

Functional validation should happen through real TEST operations, not speculative pre-implementation suites.

After deploying behind disabled flags:

1. Run a normal Phase B cycle for a controlled eligible day.
2. Enable the new Phase B path in TEST.
3. Confirm observation and AQI Parquet, manifests and indexes reach R2.
4. Confirm PM midnight values use prior-day context.
5. Confirm a forced or genuine AQI failure blocks pruning.
6. Confirm retry succeeds idempotently.
7. Enable live fallback.
8. Confirm R2 AQI wins.
9. Confirm a recent R2 gap is filled from observations.
10. Enable proxy hourly generation.
11. Confirm MISS, same-hour HIT and next-hour MISS.
12. Confirm incomplete responses are not cached.

Record issues before Pass 2 removes active consumers.

---

# 5. Pass 2: cross-repository consumer migration and Supabase AQI retirement preparation

## Recommended Codex model

**GPT-5.6 Sol, High reasoning**

Use Sol because this pass crosses repository boundaries and must avoid accidentally removing observation, metadata or ops dependencies.

A lower-cost alternative is **GPT-5.6 Terra, High reasoning** only if Pass 1 produced a precise, trusted dependency report and the workspace exposes all required repositories.

## Workspace requirement

This pass requires access to:

- `TEST-uk-aq/uk-aq-ops`
- `TEST-uk-aq/uk-aq-ingest`
- `TEST-uk-aq/uk-aq-schema`
- `TEST-uk-aq/TEST-uk-aq-root.github.io`

If Codex Cloud exposes only one repository, do not guess or fabricate cross-repository changes. Stop and report which repositories are unavailable. The task can then be repeated per repository using the same fixed architecture.

## Objective

Remove active consumers of materialised Supabase AQI, update dashboards and snapshots, prepare but do not apply destructive schema cleanup, and leave the TEST system ready for operational validation.

## Codex Cloud prompt 2

```text
Use GPT-5.6 Sol with High reasoning.

This is a cross-repository TEST migration. The required repositories are:

- TEST-uk-aq/uk-aq-ops
- TEST-uk-aq/uk-aq-ingest
- TEST-uk-aq/uk-aq-schema
- TEST-uk-aq/TEST-uk-aq-root.github.io

If any required repository is unavailable in the Codex Cloud workspace, stop and report exactly which repository is missing. Do not guess changes for unavailable repositories.

Do not deploy.
Do not enable feature flags.
Do not drop Supabase tables, views, functions, indexes, schemas or grants.
Do not restore the retired GCP AQI service.
Do not remove observation, metadata, ops, integrity or repair objects.

Assume Pass 1 has implemented:

- Phase B permanent R2 AQI generation from frozen D-1 and D observations;
- R2-first live AQI fallback from observations;
- cache proxy-owned AQI response caching;
- UTC hourly generation keys;
- disabled-by-default migration feature flags.

Review the actual Pass 1 code and dependency report before editing.

==================================================
FINAL TARGET
==================================================

Obs AQI DB remains in use for:

- recent observations;
- stations;
- timeseries;
- phenomena;
- observed properties;
- connectors;
- public observation/metadata read paths;
- Phase B candidates;
- prune gates;
- run state;
- integrity and repair state;
- operational metrics and logs.

Calculated UK AQ AQI materialisation in Supabase is no longer an active runtime dependency.

Permanent AQI is stored in R2.

The AQI history worker serves R2 AQI first and live-calculates only missing recent hours from observations.

The cache proxy owns AQI caching.

Source-provided network index observations remain ordinary observations. They are not the same as UK AQ-calculated AQI and must not be deleted.

==================================================
TASK A: STATION SNAPSHOT MIGRATION
==================================================

Find all active Station Snapshot and Station Snapshot v2 reads of materialised Supabase AQI, including references to:

- uk_aq_aqilevels.timeseries_aqi_hourly
- uk_aq_aqilevels.timeseries_aqi_daily
- public AQI views or RPCs
- Obs AQI DB AQI fallback fields

Migrate active snapshot code so calculated AQI comes from the R2-first AQI history path or an existing R2-derived snapshot path.

Requirements:

- do not call materialised Supabase AQI;
- preserve R2 precedence;
- preserve current payload fields where the website contract needs them;
- update source/provenance labels;
- do not break direct observation reads;
- keep source-provided network index observations distinct from calculated AQI;
- preserve current authentication and cache-proxy routing.

Update relevant tests and system documentation after implementation.

==================================================
TASK B: INGEST DASHBOARD AND STORAGE COVERAGE
==================================================

Find active code that tracks Obs AQI DB AQI storage or coverage, including:

- uk_aq_obs_aqidb_day_counts_current
- aqilevels day sets
- aqilevels hourly-day RPC fallbacks
- Obs AQI DB AQI size metrics
- AQI coverage bars, squares, badges or tooltips
- Dropbox/R2 AQI overlap calculations

Change the dashboard model to:

Obs AQI DB:
  observations only

R2:
  observations
  AQI levels

Requirements:

- keep observation coverage and ops metrics;
- remove or mark legacy the Obs AQI DB calculated-AQI coverage layer;
- retain R2 AQI coverage;
- update labels, payload keys, help text, tooltips and docs;
- avoid silently reusing an old field with a changed meaning;
- provide compatibility handling only where needed for a safe TEST cutover.

==================================================
TASK C: SCHEMA DEPENDENCY INVENTORY
==================================================

In uk-aq-schema and all active SQL in the other repositories, inventory the calculated AQI object family.

Include:

- schemas;
- tables;
- partitions;
- helper and staging tables;
- hourly, daily and monthly rollup tables;
- materialised or ordinary views;
- public views;
- RPCs;
- reconciliation functions;
- history export functions;
- triggers;
- scheduled function assumptions;
- indexes;
- grants;
- comments;
- size metrics;
- test fixtures;
- dashboard dependencies.

Classify every object as:

1. KEEP:
   observations, metadata, ops, integrity or shared infrastructure;

2. RETIRE AFTER TEST VALIDATION:
   used only by calculated Supabase AQI materialisation;

3. UNKNOWN:
   requires manual confirmation.

Do not classify an object from its name alone. Trace actual references.

==================================================
TASK D: PREPARE NON-DESTRUCTIVE RETIREMENT MIGRATION
==================================================

Create a proposed, guarded retirement migration or SQL runbook, but do not execute it.

It must:

- refuse LIVE unless explicitly adapted later;
- verify required replacement paths exist;
- verify no active public view or function depends on the target objects;
- list target objects before removal;
- separate disable/revoke steps from DROP steps;
- preserve source-provided index observations;
- preserve shared AQI calculation code outside the database;
- preserve all observation, metadata, ops and integrity objects;
- include rollback notes where rollback is structurally possible.

Prefer a two-stage retirement:

Stage 1:
- disable or revoke active use;
- retain objects for a TEST observation period.

Stage 2:
- drop only after normal TEST operation proves no dependency remains.

Do not apply either stage in this task.

==================================================
TASK E: ACTIVE REPOSITORY CLEANLINESS
==================================================

Search active code, workflows, configuration and current system documentation for retired runtime references.

Archive-only historical references may remain when clearly labelled.

Remove or update active references to:

- retired GCP AQI hourly services and schedulers;
- materialised Supabase AQI as a current source;
- short, deep and rolling reconciliation as active services;
- legacy AQI history RPC export as the preferred Phase B path;
- Obs AQI DB AQI coverage as an active dashboard layer.

Do not remove Pass 1 rollback scaffolding until TEST validation is complete.

==================================================
VALIDATION
==================================================

Before editing, only verify that the cross-repository contracts and proposed migration structure are viable.

After implementation, run existing relevant tests and add targeted tests for the changed consumer contracts.

Do not claim operational success. Functional validation will occur later through real TEST deployment and normal operations.

Required implemented-behaviour checks include:

- Station Snapshot no longer queries materialised Supabase AQI;
- observation reads remain intact;
- calculated AQI source/provenance is correct;
- dashboard no longer expects Obs AQI DB calculated-AQI coverage;
- R2 AQI coverage remains visible;
- schema inventory includes all discovered dependants;
- retirement migration refuses unsafe execution;
- no target KEEP object is included in retirement;
- active docs match the new architecture.

==================================================
OUTPUT
==================================================

Return:

1. repositories inspected;
2. repositories unavailable, if any;
3. files changed by repository;
4. Station Snapshot migration summary;
5. ingest dashboard migration summary;
6. complete classified database object inventory;
7. proposed Stage 1 disable/revoke sequence;
8. proposed Stage 2 drop sequence;
9. objects deliberately retained;
10. tests run and results;
11. manual TEST deployment and operational validation steps;
12. any unresolved UNKNOWN dependency.

Do not deploy or execute destructive SQL.
```

---

# 6. Manual checkpoint after Pass 2

## Review before merge

1. Confirm all required repositories were actually inspected.
2. Review every database object classified for retirement.
3. Confirm no observation, metadata, ops or integrity object is in the removal list.
4. Confirm source-provided network index observations remain.
5. Confirm Station Snapshot uses the R2-first AQI path.
6. Confirm the ingest dashboard treats Obs AQI DB as observations-only.
7. Confirm the proposed SQL is not automatically executed.
8. Confirm rollback feature flags remain available during TEST validation.

## Functional TEST validation

After deployment:

1. Open Station Snapshot v2 for representative NO2, PM2.5 and PM10 sensors.
2. Confirm observation data still appears.
3. Confirm calculated AQI is sourced through the R2-first path.
4. Confirm R2 rows win over provisional rows.
5. Check dashboard observation coverage.
6. Check R2 observation coverage.
7. Check R2 AQI coverage.
8. Confirm no active dashboard element expects Obs AQI DB AQI rows.
9. Run normal Phase B and prune operations.
10. Run integrity against a controlled historical repair case.
11. Observe TEST over a normal operational period.
12. Only then consider Stage 1 retirement of Supabase AQI objects.
13. Observe again before Stage 2 DROP.

---

# 7. Final removal rule

Do not drop calculated Supabase AQI objects merely because repository searches are clean.

Drop them only after all of the following are true:

- Phase B is successfully producing permanent R2 AQI;
- live fallback is successfully calculating recent R2 gaps;
- cache proxy hourly generation is operating;
- Station Snapshot no longer depends on Supabase AQI;
- the ingest dashboard no longer depends on Supabase AQI;
- active repository searches are clean;
- Stage 1 disable/revoke causes no operational failures;
- normal TEST operations complete successfully;
- integrity rebuilds continue to work;
- the final object inventory has no unresolved UNKNOWN dependencies.

---

# 8. Cost-saving split

## Use Codex Cloud

Use Codex Cloud for:

- repository-wide implementation;
- transaction and prune-gate changes;
- shared AQI integration;
- Worker source and cache changes;
- cross-repository dependency tracing;
- contract changes;
- schema dependency inventory;
- guarded migration preparation.

## Mike can do manually

Mike can:

- remove GCP resources;
- review changed files;
- change TEST feature flags;
- deploy Workers;
- run normal Phase B;
- inspect R2 paths and manifests;
- run curl cache checks;
- inspect Station Snapshot;
- inspect dashboard coverage;
- apply Stage 1 only after review;
- monitor TEST;
- approve Stage 2 later.

This avoids spending Codex usage on console operations and routine visual verification.
