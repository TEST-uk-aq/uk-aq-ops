# UK AQ R2-first AQI generation, live fallback and proxy-owned cache plan

**Date:** 13 July 2026  
**Target repository:** `TEST-uk-aq/uk-aq-ops`  
**Target environment:** TEST only  
**Status:** Proposed implementation plan  
**Supersedes:** `uk_aq_r2_first_live_aqi_fallback_cache_plan_2026-07-13.md`

## 1. Purpose

Replace the failed GCP hourly AQI-level materialisation services with two coordinated AQI paths:

1. **Permanent R2 AQI generation during Phase B prune/history export**
   - Phase B reads and freezes the observation input required for day `D`.
   - The same frozen source data is used to:
     - write day `D` observations to R2; and
     - calculate and write day `D` AQI levels to R2.
   - This removes the dependency on materialised AQI rows in Obs AQI DB.

2. **Recent provisional AQI fallback at request time**
   - The AQI history worker reads authoritative R2 AQI first.
   - It calculates only AQI hours that are absent from R2 and still available from recent observation sources.
   - R2 AQI always wins.
   - Public AQI response caching is owned entirely by `uk_aq_cache_proxy`.
   - Recent and mixed requests use an internal UTC hourly cache-generation key.

The plan must preserve AQI accuracy while reducing broad, repeated database reads.

---

## 2. Fixed architectural decisions

These decisions are requirements. Codex should not redesign them.

### 2.1 R2 AQI always wins

The canonical AQI row key is:

```text
timestamp_hour_utc + timeseries_id + pollutant_code
```

Precedence is:

```text
R2 AQI row
  > live-calculated AQI row
  > no row
```

An existing R2 AQI row wins even when:

- `daqi_index_level` or `eaqi_index_level` is null;
- the calculation status is `insufficient_samples`;
- the calculation status is `missing_input`;
- a missing reason is present.

The live request path must never replace an existing R2 AQI row.

### 2.2 R2 observations always win

When observation rows from R2 and ingest DB overlap at the repository's canonical observation identity:

```text
R2 observation
  > ingest DB observation
```

Ingest DB observations may fill source-observation keys that are absent from R2. They must not overwrite an R2 observation.

### 2.3 Permanent AQI is calculated by Phase B from frozen observations

The existing Phase B AQI export currently reads already-calculated AQI rows from Obs AQI DB RPCs. That dependency is to be removed.

The replacement design is **Option A**:

```text
Read and freeze D-1 and D observation input
             │
             ├── write D observations to R2
             │
             └── calculate D AQI from the same frozen input
                         │
                         └── write D AQI to R2
```

For PM2.5 and PM10, day `D-1` is required only as rolling context. The observation history output for this Phase B candidate remains day `D`.

The prune process must not reread R2 merely to calculate the normal Phase B AQI output.

### 2.4 Integrity owns historical R2 repair

Integrity remains the only process expected to put late or repaired historical observations into R2 after normal Phase B completion.

When integrity changes historical R2 observations, it remains responsible for rebuilding the affected R2 AQI output.

No observation-manifest hash is required for the normal design.

### 2.5 Cache proxy owns all public AQI response caching

Final public request path:

```text
Website
  -> uk_aq_cache_proxy /api/aq/aqi-history
  -> uk_aq_aqi_history_r2_api_worker /v1/aqi-history
```

The AQI history worker becomes a stateless read/calculation service. Its own `caches.default` response cache is removed from the final enabled path.

### 2.6 Retire the failed GCP AQI hourly implementation

The following TEST resources are retired and must not be restored:

- AQI hourly Cloud Run service;
- sync scheduler;
- short reconciliation scheduler;
- deep reconciliation scheduler;
- rolling-deep reconciliation scheduler;
- active deployment workflow;
- active service code path.

The code and documentation should be preserved under a dated archive.

---

## 3. Final data flows

### 3.1 Permanent R2 history path

```text
Eligible Phase B day D
      │
      ▼
Read observation input from ingest DB
      │
      ├── day D rows for permanent observation export
      │
      └── D-1 context plus D rows for AQI calculation
      │
      ▼
Freeze and normalise the source rows
      │
      ├── write day D observation Parquet and manifests to R2
      │
      └── calculate day D AQI with the shared AQI library
                 │
                 ├── write v2 AQI data Parquet
                 ├── optionally write v2 AQI debug Parquet
                 └── write connector/day manifests and indexes
      │
      ▼
Verify required R2 outputs
      │
      ▼
Mark Phase B history gate complete
      │
      ▼
Allow normal prune deletion
```

### 3.2 Permanent AQI output locations

Keep the existing v2 layouts:

```text
history/v2/aqilevels/hourly/data/
history/v2/aqilevels/hourly/debug/
```

The data profile should contain the compact fields required by the website reader.

The debug profile should contain calculation inputs, sample counts, statuses, reasons, algorithm version and computed timestamp.

### 3.3 Recent request-time fallback path

```text
AQI history request
      │
      ▼
Read authoritative R2 AQI
      │
      ▼
Identify expected AQI hours absent from R2
      │
      ▼
Restrict missing hours to the recent ingest fallback window
      │
      ▼
Read only the required R2 and ingest observations
      │
      ▼
Merge observations with R2 precedence
      │
      ▼
Calculate missing AQI rows with the shared AQI library
      │
      ▼
Insert only AQI keys absent from R2
      │
      ▼
Return provenance and completeness diagnostics
```

### 3.4 Source distinction

Permanent R2 rows:

```text
source = r2
provisional = false
```

Request-time calculated rows:

```text
source = live_calculated
provisional = true
```

This distinction is diagnostic. It does not alter precedence.

---

## 4. Phase B source-freezing requirements

### 4.1 Required input windows

For target day `D`:

**NO2**

```text
D 00:00 UTC through D+1 00:00 UTC
```

**PM2.5 and PM10**

```text
D-1 00:00 UTC through D+1 00:00 UTC
```

This two-day read gives the shared AQI library enough context to calculate rolling 24-hour DAQI values for every hour in `D`.

Only AQI rows whose `timestamp_hour_utc` falls within day `D` are written.

### 4.2 Same source snapshot for observations and AQI

The worker must not independently rerun two unrelated database queries whose results could differ during the same candidate export.

Preferred implementation:

1. Open a transaction with an appropriate stable snapshot.
2. Stream or stage the required source rows.
3. Use the same normalised frozen row set for:
   - day `D` observation output;
   - `D-1` and `D` AQI calculation input.
4. Complete all required writes.
5. Mark the candidate/day gate complete only after verification.

Codex must inspect the current transaction and cursor design before choosing the exact implementation.

Acceptable approaches include:

- one repeatable-read transaction with separate cursors;
- a temporary local staging file keyed by run/day/connector;
- an in-memory buffer only where measured row volumes are safely bounded.

Do not load an unbounded connector/day dataset into memory without measurement and explicit limits.

### 4.3 Connector handling

Phase B candidates are currently connector/day scoped.

AQI calculation should preserve that scope where possible:

```text
day D + connector_id
```

For each connector candidate:

- read relevant canonical pollutants;
- group by `timeseries_id`;
- calculate only supported pollutants;
- write connector-partitioned AQI outputs;
- aggregate connector manifests into the day manifest.

### 4.4 Safe completion gate

A day must not be considered safely backed up for pruning until all required outputs have succeeded.

Required v2 completion for day `D`:

- observation connector manifests complete;
- observation day manifest complete;
- AQI data connector manifests complete for supported source rows;
- AQI data day manifest complete;
- required AQI indexes updated;
- debug output complete when debug output is configured as required;
- all written objects verified to exist.

A genuine day or connector with no supported AQI pollutants should be recorded as an explicit successful no-AQI-source outcome, not an ambiguous missing export.

### 4.5 Failure behaviour

If AQI generation or AQI R2 writing fails:

- do not delete day `D` observations from ingest DB;
- leave the relevant candidate/day gate retryable;
- preserve completed observation parts where the existing resume design safely supports it;
- log the failed stage clearly;
- do not report `history_done=true`.

Retries must be idempotent.

---

## 5. Shared AQI calculation code

The same AQI algorithm must be used by:

- Phase B permanent R2 generation;
- integrity historical AQI rebuild;
- request-time live AQI fallback.

Keep and reuse the repository's shared AQI library, including:

- pollutant normalisation;
- observation deduplication;
- hourly aggregation;
- PM rolling 24-hour calculation;
- DAQI breakpoints;
- EAQI breakpoints;
- required observation counts;
- calculation status and missing reason;
- algorithm version.

Do not create separate copies of the breakpoint tables or rolling logic.

A future algorithm change should be made once in the shared library and covered by parity tests across all three consumers.

---

## 6. Hourly cache-generation design

### 6.1 Internal cache key

For recent or mixed AQI requests, the proxy adds an internal generation value to the cache key only:

```text
__ukaq_aqi_generation=2026-07-13T14Z
```

An integer epoch-hour is also acceptable.

Requirements:

- UTC only;
- deterministic within the hour;
- changes at the next UTC hour;
- not forwarded to the AQI history worker;
- not visible in the website URL;
- versioned internally.

### 6.2 Difference from TTL-only caching

Without a generation key:

```text
cached at 14:58
expires near 15:58
```

With a generation key:

```text
14:58 request uses 14:00 generation
15:00 first request uses 15:00 generation and must re-read upstream
```

The key does not proactively run at the hour boundary. It forces a refresh on the first request in the new hour.

### 6.3 Cache ownership

Final design:

```text
uk_aq_cache_proxy:
  owns complete AQI response caching

uk_aq_aqi_history_r2_api_worker:
  no internal response cache
  direct response uses Cache-Control: no-store
```

The proxy must make a narrowly scoped exception for the authenticated AQI upstream so it can cache a complete `no-store` upstream response after validating completeness.

Do not weaken `no-store` handling for other proxy routes.

### 6.4 Recommended TEST defaults

Recent or mixed:

```text
browser max-age:            300 seconds
edge s-maxage:              3900 seconds
stale-while-revalidate:     0 seconds
stale-if-error:             300 seconds
generation interval:        3600 seconds
```

Immutable R2-only history:

- retain the current long immutable profile unless tests identify a problem;
- no hourly generation key.

### 6.5 Cacheability

Cache only when:

- status is `200`;
- the request is not bypass/no-cache;
- `X-UK-AQ-Response-Complete` is true;
- no R2 source error is reported;
- no observation-source error is reported;
- no budget stop occurred.

Partial responses must use `no-store` and must not be cached.

---

## 7. Feature flags

Use TEST feature flags during migration.

Suggested names:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true

UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=false
UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=true
```

After successful TEST validation:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false

UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true
UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=false
```

Use the repository's existing naming conventions where they differ.

---

# 8. Implementation phases

## Phase 0: Manual retirement of TEST GCP resources

**Owner:** Mike  
**Codex model:** None  
**Cost:** No Codex usage  

### Manual actions

1. Delete or disable all TEST Cloud Scheduler jobs for the retired AQI hourly service.
2. Delete the TEST Cloud Run AQI hourly service.
3. Disable its GitHub Actions workflow.
4. Record:
   - service name;
   - region;
   - scheduler job names;
   - deletion date.
5. Do not delete shared secrets, database objects or Artifact Registry images yet.

### Acceptance checks

- no scheduler targets the service;
- the Cloud Run service no longer exists;
- the workflow cannot redeploy it.

---

## Phase 1: Archive the retired GCP implementation

**Owner:** Codex  
**Recommended model:** GPT-5.6 Terra  
**Reasoning:** Medium  

### Scope

Archive active artefacts associated with:

```text
workers/uk_aq_timeseries_aqi_hourly_cloud_run
.github/workflows/uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml
```

Preferred archive root:

```text
archive/2026-07-13/retired-timeseries-aqi-hourly-cloud-run/
```

Update active documentation and configuration inventories.

Do not remove shared AQI code, Phase B, integrity, AQI history worker or cache proxy.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit, push or open a PR.

Archive and retire the failed TEST GCP AQI hourly materialisation implementation.

Inspect all references to:
- workers/uk_aq_timeseries_aqi_hourly_cloud_run
- its deploy workflow
- scheduler configuration
- tests
- system docs
- config/uk_aq_github_env_targets.csv

Create:
archive/2026-07-13/retired-timeseries-aqi-hourly-cloud-run/

Preserve relevant files and original relative paths where practical. Remove deployment-capable artefacts from active paths and update active docs so the service is not described as operational.

Hard constraints:
- Keep the shared AQI calculation library.
- Keep workers/uk_aq_prune_daily and Phase B history code.
- Keep integrity and backfill AQI rebuild code.
- Keep workers/uk_aq_aqi_history_r2_api_worker.
- Keep workers/uk_aq_cache_proxy.
- Do not drop SQL objects.

Run relevant tests and report:
1. files found;
2. files archived;
3. active files removed or amended;
4. references intentionally retained;
5. test results;
6. manual cleanup still required.
```

---

## Phase 2: Audit the current Phase B AQI export and freeze contract

**Owner:** Codex  
**Recommended model:** GPT-5.6 Sol  
**Reasoning:** High  

### Scope

Before changing code, map:

- how Phase B reads observation candidates;
- transaction isolation and cursor usage;
- v2 observation row normalisation;
- current legacy AQI RPC export;
- day and connector completion gates;
- resume/checkpoint behaviour;
- AQI data/debug manifest and index writers;
- memory and row-volume constraints;
- all consumers of the legacy AQI RPCs and materialised Obs AQI DB table/view.

Produce a written implementation note and add contract tests/scaffolding without changing enabled behaviour.

### Acceptance criteria

- exact files/functions to change are identified;
- the stable source-snapshot design is chosen and justified;
- no unbounded in-memory design is proposed;
- legacy dependencies are documented;
- tests lock day filtering and PM D-1 context rules;
- feature flags default to old behaviour.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Audit the current Phase B observation and AQI history path before implementation.

Fixed future design:
- Phase B will calculate permanent day-D AQI from the same frozen observation source data used to write day-D observations.
- PM2.5 and PM10 calculation input must include D-1 plus D.
- Only day-D AQI rows are written.
- Normal Phase B must not reread R2 to calculate AQI.
- Integrity remains responsible for historical R2 repairs and AQI rebuilds.
- The legacy Obs AQI DB AQI RPC export will be retired after validation.

Inspect:
- workers/uk_aq_prune_daily/phase_b_history_r2.mjs
- its callers and workflow configuration
- shared AQI library
- v2 observation and AQI writers/manifests/indexes
- SQL/RPC definitions for uk_aq_rpc_aqilevels_history_day_connector_counts and uk_aq_rpc_aqilevels_history_day_rows
- candidate/day-gate and resume logic
- tests and system docs

Determine the safest bounded way to freeze source observations so the same snapshot feeds both outputs. Consider transaction isolation, multiple cursors, local staging and measured memory limits.

Add disabled-by-default feature-flag scaffolding and focused tests for:
- D-only observation output
- D-1 plus D PM calculation input
- D-only AQI output
- same normalised source rows feeding both paths
- no prune gate completion when AQI write fails
- explicit successful no-supported-AQI-source outcome
- idempotent retry

Do not implement the full new path yet. Produce a report with:
1. current data flow;
2. exact legacy dependencies;
3. recommended freeze mechanism;
4. measured/estimated row volumes;
5. proposed function boundaries;
6. migration risks;
7. test results.
```

---

## Phase 3: Implement permanent Phase B AQI calculation from frozen observations

**Owner:** Codex  
**Recommended model:** GPT-5.6 Sol  
**Reasoning:** High  

### Required behaviour

For each eligible `day D + connector` candidate:

1. Read and freeze canonical observation rows from D-1 through the end of D.
2. Preserve the existing day-D observation export behaviour.
3. Use the same normalised frozen rows to calculate AQI.
4. Reuse the shared AQI library.
5. Write only day-D AQI rows.
6. Write v2 AQI data Parquet.
7. Write v2 AQI debug Parquet when enabled.
8. Write connector and day manifests.
9. Update required v2 AQI indexes.
10. Complete the day gate only when all required outputs succeed.
11. Preserve retry and resume safety.
12. Do not use the legacy AQI RPC path when the new flag is enabled.

### Efficiency requirements

- stream or stage source rows rather than loading arbitrary datasets into memory;
- do not reread raw observations once for observations and again independently for AQI unless the chosen stable transaction design proves this is safest and bounded;
- group calculations by timeseries;
- discard D-1 output rows after rolling context has been calculated;
- bound local staging and clean it safely after success;
- log source rows read, D rows written, context rows, AQI rows and timings.

### Acceptance criteria

- generated AQI matches shared-library fixtures;
- PM values at the start of D use D-1 context;
- observation and AQI outputs derive from the same frozen source set;
- an AQI failure blocks prune completion;
- retry is idempotent;
- no call to the legacy AQI history RPC occurs when new mode is enabled;
- old mode remains available behind the migration flag.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Implement permanent Phase B AQI generation from the same frozen observation source used for the observation R2 export.

Fixed design:
- target scope is day D plus connector_id;
- day-D observations are written to history/v2/observations;
- PM2.5 and PM10 calculation input includes D-1 and D;
- NO2 only requires D, but a shared bounded frozen input may include D-1 when that simplifies the connector pipeline;
- only day-D AQI rows are written;
- use the existing shared AQI library;
- normal Phase B must not reread R2 for AQI calculation;
- integrity remains responsible for later historical repair;
- no observation-manifest hash is required.

Implement behind:
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED

Retain the legacy RPC export behind:
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED

Use the freeze mechanism selected in Phase 2. Do not introduce unbounded memory use.

Required outputs:
- v2 observation Parquet and manifests
- v2 AQI hourly data Parquet and manifests
- v2 AQI hourly debug Parquet and manifests when configured
- required v2 timeseries indexes
- run and day-gate diagnostics

Required safety:
- same normalised source snapshot feeds both outputs;
- AQI write failure blocks history_done/prune;
- retries are idempotent;
- successful no-supported-pollutant candidates are explicit;
- partial objects are not promoted as complete;
- existing observation resume/checkpoint safety is preserved.

Add structured logs for:
- frozen source row counts by day and pollutant
- D-1 context rows
- D observation rows
- calculated AQI rows
- data/debug files and bytes
- per-stage timings
- completion-gate decision

Add comprehensive tests, including PM boundary hours at 00:00 UTC, missing samples, late source rows present before freeze, retries and forced R2 write failures.

Run all relevant tests and report:
1. files changed;
2. freeze implementation;
3. source and output row counts in fixtures;
4. test results;
5. remaining legacy dependencies.
```

---

## Phase 4: Validate Phase B parity and cut over from legacy RPC export

**Owner:** Mike runs validation; Codex prepares tools  
**Recommended model:** GPT-5.6 Terra  
**Reasoning:** Medium  

### Validation strategy

Run both paths for selected completed TEST days without pruning additional data:

```text
legacy Obs AQI DB RPC export
versus
new frozen-observation calculation
```

Compare canonical fields:

- connector;
- station;
- timeseries;
- pollutant;
- timestamp hour;
- DAQI level;
- EAQI level;
- calculation statuses;
- missing reasons;
- source/required counts where available.

Differences must be explained. Expected differences caused by the broken or stale materialised service should be identified rather than automatically treated as failures.

### Cutover

After acceptance:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

Do not drop legacy database objects yet.

### Manual tasks that save Codex cost

Mike can:

1. choose representative connector/day samples;
2. run dry-run or comparison commands supplied by Codex;
3. inspect generated R2 manifests;
4. confirm expected TEST bucket paths;
5. enable repository variables after reviewing output.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Create TEST validation tooling and a runbook for comparing:
A. the current legacy Phase B AQI RPC source;
B. the new Phase B AQI calculated from frozen observations.

The comparison must be read-only or write to isolated comparison prefixes. It must not prune data.

Compare canonical AQI keys and values, summarise exact matches and field-level differences, and classify likely causes:
- stale/broken legacy materialisation;
- source snapshot difference;
- rolling-context difference;
- algorithm mismatch;
- metadata mismatch;
- genuine implementation defect.

Provide commands for a small representative set and a wider sample. Add safety checks that refuse LIVE targets.

After comparison, provide the exact GitHub variable changes required to enable the new path and disable the legacy export in TEST.

Do not drop SQL objects. Run tests and report results.
```

---

## Phase 5: Implement R2-first recent live AQI fallback

**Owner:** Codex  
**Recommended model:** GPT-5.6 Sol  
**Reasoning:** High  

### Required behaviour

1. Read R2 AQI first.
2. Treat every existing R2 AQI key as authoritative.
3. Find expected hourly keys absent from R2.
4. Restrict live calculation to the configured recent ingest window.
5. Build minimal source windows:
   - NO2: missing output hours;
   - PM: missing output hours plus 23-hour lookback.
6. Read R2 observations and ingest DB observations only for the requested timeseries and pollutant.
7. Merge source observations R2-first.
8. Calculate using the shared AQI library.
9. insert only R2-missing AQI rows.
10. Return structured provenance and completeness.
11. Do not read materialised Obs AQI DB AQI rows as the fallback source.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Implement R2-first live AQI fallback in workers/uk_aq_aqi_history_r2_api_worker.

Non-negotiable precedence:
- existing R2 AQI always wins;
- R2 observations win over overlapping ingest observations;
- ingest observations may fill only missing source keys;
- live-calculated AQI may fill only missing R2 AQI keys.

Use the shared AQI library. Do not copy the algorithm.

Plan minimal source windows for missing AQI hours. PM requires the preceding 23 hours. Merge overlapping windows.

Use bounded reads and return structured partial diagnostics on source or budget failure. Do not claim response completeness when calculation is incomplete.

Keep the feature disabled by default:
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false

Remove the materialised Obs AQI DB AQI table/view as a live row source, but do not drop database objects.

Add tests for:
- R2 AQI precedence including null/status rows;
- R2 observation precedence;
- distinct late ingest observations;
- NO2;
- PM2.5;
- PM10;
- multiple and overlapping gaps;
- ingest retention boundary;
- source failure and budget stop;
- provenance fields.

Run relevant tests and report files, read paths, variables and results.
```

---

## Phase 6: Move all AQI response caching to cache proxy

**Owner:** Codex  
**Recommended model:** GPT-5.6 Sol  
**Reasoning:** High  

### Required behaviour

- proxy classifies recent/mixed versus immutable before lookup;
- ambiguous requests are recent;
- recent/mixed internal cache keys include UTC hour generation;
- generation is not forwarded upstream;
- complete AQI responses can be cached by the proxy even when authenticated upstream returns `no-store`;
- partial responses are never cached;
- generic `no-store` protection remains unchanged for other routes;
- AQI worker internal cache remains temporarily available behind a migration flag;
- timestamp canonicalisation is audited for short windows and aliases.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Make workers/uk_aq_cache_proxy the sole public AQI response cache owner and add a UTC hourly generation component for recent or mixed AQI history requests.

Requirements:
- build a separate internal cache-key URL;
- add a versioned UTC hour generation only to recent/mixed keys;
- never send it to the AQI worker;
- immutable explicit historical requests keep a stable key;
- ambiguity defaults to recent;
- preserve bypass, CORS, retries, ETag and 304 behaviour.

Add a narrow authenticated-AQI exception so the proxy may cache a complete upstream response even when the internal AQI worker returns Cache-Control: no-store. Do not weaken generic no-store/private handling.

Cache only complete successful responses. Add cache-scope and generation diagnostics.

Audit hourly canonicalisation for days, explicit start/end aliases, since and sub-three-day windows.

Add deterministic time-injected tests for same-hour keys, hour rollover, immutable stability, upstream URL equality, cacheability and partial-response rejection.

Keep the feature disabled by default:
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=false

Run tests and report files, variables and results.
```

---

## Phase 7: Coordinated cache cutover

**Owner:** Codex prepares; Mike changes variables and deploys  
**Recommended model:** GPT-5.6 Terra  
**Reasoning:** Medium  

### Deployment order

1. Deploy AQI worker with live fallback disabled and internal cache still enabled.
2. Deploy cache proxy with hourly generation disabled.
3. Run baseline requests.
4. Enable live fallback.
5. Enable proxy hourly generation.
6. Disable AQI worker internal response cache.
7. Confirm direct worker responses are `no-store`.
8. Confirm proxy MISS then HIT behaviour.
9. Keep retired GCP service absent.

Final settings:

```text
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=true
UK_AQ_AQI_INTERNAL_RESPONSE_CACHE_ENABLED=false
```

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

Prepare the coordinated TEST cutover for proxy-owned AQI caching.

Update wrangler/deploy templates, environment inventories and docs. Validate required secrets without logging values.

Final enabled path:
- AQI history worker has no response cache;
- direct AQI worker response is no-store;
- cache proxy owns recent hourly-generation caching and immutable caching;
- incomplete responses remain no-store;
- retired GCP service is not referenced.

Provide exact deployment order, GitHub variable changes, curl checks and rollback steps. Run tests and report results.
```

---

## Phase 8: End-to-end TEST validation

**Owner:** Mike for manual checks; Codex only for defects  
**Recommended model:** None initially  
**Cost:** Manual checks first  

### Phase B checks

1. Run Phase B for an isolated eligible TEST day.
2. Confirm observation data and manifests exist.
3. Confirm AQI data and manifests exist.
4. Confirm PM midnight rows use prior-day context.
5. Confirm day gate is complete only after AQI success.
6. Force or simulate an AQI write failure and confirm prune is blocked.
7. Retry and confirm idempotency.

### Request path checks

1. Direct AQI worker call returns `no-store`.
2. First proxy call returns MISS.
3. Repeated same-hour call returns HIT.
4. First request after UTC hour rollover returns MISS.
5. R2 rows are never replaced by live calculation.
6. A missing recent R2 hour can be filled from observations.
7. A partial calculation response is not cached.
8. Historical explicit-end request keeps immutable caching.

### Metrics to record

**Phase B**

- frozen rows;
- D-1 context rows;
- D observation rows;
- AQI rows;
- Parquet bytes;
- stage timings;
- peak memory where available.

**Request path**

- R2 AQI rows;
- missing hours;
- observation rows read;
- live-calculated rows;
- response duration;
- cache HIT/MISS;
- generation value.

### Pass criteria

- no GCP AQI hourly service is needed;
- permanent AQI reaches R2 through Phase B;
- Phase B does not depend on materialised Obs AQI DB AQI rows;
- website history remains R2-first;
- recent R2 gaps can be filled provisionally;
- hourly cache rollover works;
- no incomplete response is cached;
- prune safety is preserved.

---

## Phase 9: Remove migration scaffolding and finish documentation

**Owner:** Codex  
**Recommended model:** GPT-5.6 Terra  
**Reasoning:** Medium  

### Scope

After stable TEST operation:

- default new Phase B AQI generation on;
- remove or deprecate legacy RPC export branch;
- default AQI worker internal cache off or remove it;
- remove temporary comparison-only code;
- update system docs and diagrams;
- archive legacy SQL/RPC definitions only after a separate dependency audit;
- retain integrity rebuild code and shared AQI library.

### Codex prompt

```text
Work only in TEST-uk-aq/uk-aq-ops. Do not deploy, commit or push.

After confirmed TEST acceptance, remove temporary migration scaffolding.

Final architecture:
- Phase B permanently calculates R2 AQI from the same frozen observation source used for the R2 observation write;
- integrity rebuilds AQI after historical R2 repair;
- AQI history worker reads R2 first and live-calculates only missing recent rows;
- cache proxy owns all AQI response caching;
- GCP AQI hourly implementation remains archived.

Remove obsolete migration branches only where tests and dependency audits show they are unused. Do not drop database objects automatically.

Update system docs, runbooks, architecture diagrams, config inventory and archive manifest. Run all relevant tests and report any remaining legacy dependency.
```

---

# 9. Manual tasks Mike can do to save Codex cost

These do not need an expensive coding model:

1. Remove GCP Cloud Run and Scheduler resources.
2. Disable the retired GitHub workflow.
3. Record deleted resource names.
4. Choose representative TEST days and connectors for parity checks.
5. Run supplied comparison commands.
6. Inspect R2 object paths and manifests.
7. Change TEST GitHub variables after reviewing Codex output.
8. Deploy Workers in the documented order.
9. Run curl checks for cache MISS/HIT and hour rollover.
10. Confirm GCP resources remain absent.

Use Codex for code changes, repository-wide dependency searches, test construction and failure diagnosis.

---

# 10. Model recommendations

## GPT-5.6 Sol

Use for:

- Phase B frozen-source design;
- permanent AQI calculation integration;
- prune completion and retry safety;
- R2-first live calculation;
- cache-key and cacheability changes;
- difficult failures involving multiple workers or data stores.

## GPT-5.6 Terra

Use for:

- archiving;
- workflow/config updates;
- validation tooling;
- documentation;
- migration cleanup after design is settled.

## Lower-cost model

A lower-cost coding model is suitable for:

- simple wording changes;
- archive MANIFEST updates;
- renaming variables after the design is fixed;
- adding straightforward documentation examples.

Do not use a low-cost model for Phase B transaction/snapshot logic, PM rolling correctness, prune gates or cache-key semantics.

---

# 11. Rollback

## 11.1 Phase B rollback

Set:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
```

This rollback is temporary and only works while legacy materialised rows remain usable.

Do not restore the retired GCP service as the preferred rollback.

## 11.2 Live fallback rollback

Set:

```text
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

The worker returns available R2 AQI only.

## 11.3 Hourly generation rollback

Set:

```text
UK_AQ_AQI_PROXY_HOURLY_GENERATION_ENABLED=false
```

The proxy returns to its previous key behaviour.

## 11.4 Cache diagnosis

Use the existing authenticated cache-bypass mechanism. Partial responses remain `no-store`.

---

# 12. Final acceptance checklist

- [ ] TEST GCP AQI Cloud Run service removed.
- [ ] TEST AQI scheduler jobs removed.
- [ ] Retired implementation archived.
- [ ] Shared AQI library retained.
- [ ] Phase B reads a stable frozen observation source.
- [ ] Day-D observations and AQI derive from the same source snapshot.
- [ ] PM day-D AQI uses D-1 rolling context.
- [ ] Only day-D AQI rows are written.
- [ ] AQI data/debug Parquet and manifests reach R2.
- [ ] AQI failure blocks prune completion.
- [ ] Legacy AQI RPC export disabled after parity validation.
- [ ] Integrity historical rebuild path retained.
- [ ] R2 AQI always wins in the website reader.
- [ ] Live calculation fills only recent R2-missing AQI keys.
- [ ] R2 observations win over ingest observations.
- [ ] AQI worker internal response cache removed from final path.
- [ ] Cache proxy owns all AQI response caching.
- [ ] Recent/mixed requests use UTC hourly generation.
- [ ] Generation parameter is not forwarded upstream.
- [ ] Partial responses are never cached.
- [ ] Immutable historical caching remains long-lived.
- [ ] System documentation reflects the final architecture.
