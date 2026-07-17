# AQI display correction plan

- Date: 17 July 2026
- Status: Proposed
- Primary repository: `TEST-uk-aq/uk-aq-ops`
- Website repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`
- Authoritative system documentation: `system_docs/aqi-levels/`
- R2 history scope: v2 only

## Purpose

Correct AQI period handling everywhere it affects the displayed DAQI and European AQI bands in the active v2 path, while preserving the existing calculation formulas, stored R2 v2 timestamps, source precedence, history integrity and unrelated website behaviour.

The required time contract is:

```text
timestamp_hour_utc = n
period_start_utc   = n - 1 hour
period_end_utc     = n
represented interval = (period_start_utc, period_end_utc]
```

For a requested represented interval from `S` to `E`, the required AQI endpoint rows are:

```text
S < n <= E
```

A row ending at `07:00` must colour `06:00` to `07:00`. It must not colour `07:00` to `08:00`.

## v2-only scope

This correction applies only to the active R2 history v2 path.

The implementation must:

- inspect and amend only the v2 read and response path where required;
- leave v1 code, v1 objects, v1 tests and v1 compatibility behaviour unchanged;
- avoid adding new v1 support or fixing equivalent v1 defects;
- stop and report a configuration mismatch if the deployed TEST path is not using v2.

R2 v1 is being retired and is explicitly out of scope.

## R2 v2 data is not expected to change

The stored v2 AQI rows already use `timestamp_hour_utc` as the canonical hour-ending endpoint.

This plan does not expect changes to:

- v2 AQI parquet rows;
- `history/v2/aqilevels/hourly/data` objects;
- `history/v2/aqilevels/hourly/debug` objects;
- pollutant, connector or day manifests;
- v2 timeseries indexes;
- v2 timeseries metadata;
- Prune Daily AQI calculation or write behaviour;
- R2 prefixes;
- backfill or history-repair tools;
- raw observation history;
- database schema.

No R2 v2 rebuild, rewrite, migration or reindex is required merely to correct display semantics.

The v2 R2 API read layer may still need changes because it currently projects and filters stored endpoint timestamps incorrectly. Changing a response projection or a request boundary is not a change to the underlying R2 v2 data.

If Phase 0 finds evidence that v2 stored rows themselves are shifted, stop and report the evidence. Do not expand this display-correction plan into a history rewrite.

## Authoritative references

Implementation must conform to:

- `system_docs/aqi-levels/README.md`;
- `system_docs/aqi-levels/contract.md`;
- `system_docs/aqi-levels/data-flow.md`;
- `system_docs/aqi-levels/state-model.md`;
- `system_docs/aqi-levels/interfaces.md`;
- `system_docs/aqi-levels/operations.md`;
- `system_docs/aqi-levels/recovery.md`;
- `system_docs/aqi-levels/validation.md`;
- `system_docs/aqi-levels/decisions/0001-hour-ending-aqi-intervals.md`;
- `system_docs/aqi-levels/decisions/0002-hourly-only-active-product.md`.

These documents take precedence over older broad AQI, R2, Prune Daily, backfill and archived service documentation.

Every implementation phase must compare its final diff against the mandatory functionality in these documents before deployment.

## Confirmed current defects

### Website rendering

Both active station-chart renderers currently treat an AQI timestamp `n` as the start of the coloured rectangle and draw to `n + 1 hour`.

Affected website files include:

- `hex_map/index.html`;
- `sensors/index.html`.

This causes the final coloured AQI section to extend beyond the final plotted concentration timestamp.

### Website loader

`station-history-loader.js` currently normalises one ambiguous `date` from fields including `period_start_utc` and `timestamp_hour_utc`.

It does not retain explicit period start and end boundaries. This allows a field naming defect upstream to become a rendering defect downstream.

### v2 AQI History R2 API

`workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` reads canonical v2 `timestamp_hour_utc` endpoint values but exposes the value as `period_start_utc` without subtracting one hour.

The current response therefore gives an endpoint timestamp a start-time field name.

### Station-history range and completeness logic

The station-history path generally generates expected AQI hours and filters rows using start-inclusive, end-exclusive timestamp logic.

For hour-ending rows, represented interval `S` to `E` requires endpoint selection:

```text
S < n <= E
```

Changing only the website rectangle would leave:

- the first endpoint boundary wrong;
- the final endpoint omitted in some ranges;
- gap detection wrong;
- chunk completeness wrong;
- midnight endpoint reads vulnerable to omission.

### Midnight v2 partition boundary

R2 v2 AQI `day_utc` follows the endpoint date.

The interval `17 July 23:00` to `18 July 00:00` is represented by endpoint `18 July 00:00` and is stored under:

```text
day_utc=2026-07-18
```

The v2 reader must include the endpoint-day partition when the request ends at midnight.

### Inactive roll-ups

Daily and monthly AQI roll-ups are inactive. They are not part of this correction and must not be reactivated, refreshed or amended by this work.

## Mandatory retained functionality

The work must retain all of the following:

- supported pollutants remain `pm25`, `pm10` and `no2`;
- DAQI PM remains a rolling 24-hour mean ending at `n`;
- DAQI NO2 remains an hourly mean ending at `n`;
- European AQI remains an hourly mean ending at `n`;
- breakpoint values and inclusive upper-bound behaviour remain unchanged;
- PM DAQI still requires 24 hourly values;
- European AQI remains independently available when PM DAQI is `insufficient_samples`;
- negative and non-finite observation values remain excluded from AQI calculation but retained in raw observation history;
- committed R2 v2 AQI remains authoritative over live calculation for the same endpoint;
- older history chunks must not replace the stable head;
- AQI and observation completeness remain independent;
- incomplete and gap-bearing responses remain explicitly partial and non-cacheable where currently required;
- v2 data and debug R2 profiles remain aligned and unchanged;
- v2 manifest and index hierarchy remains unchanged;
- stored `timestamp_hour_utc` values and existing parquet row identities remain unchanged;
- daily and monthly roll-ups remain inactive;
- station-history remains private behind the cache-proxy Service Binding;
- unrelated map, sensor list, observation chart and cache behaviour remains unchanged;
- v1 remains untouched and out of scope.

## Explicit non-goals

This plan must not:

- modify any v1 code path, object, test or compatibility contract;
- rewrite or shift historical R2 v2 AQI timestamps;
- rebuild or reindex R2 v2 history;
- change R2 v2 parquet, manifests, indexes or metadata;
- change Prune Daily AQI calculation or write behaviour;
- change AQI breakpoint tables;
- change pollutant support;
- modify raw observation history;
- modify database schema;
- reactivate daily or monthly roll-ups;
- introduce interpolation or forward-fill for missing AQI hours;
- create a second public AQI calculation path;
- replace R2 precedence with last-write-wins merging;
- broaden R2 scans when required v2 indexes are missing;
- refactor unrelated website or Worker code;
- create a broad speculative pre-deployment test suite.

## Expected change boundary

Expected code changes are limited to:

### Ops repository

- the v2 response and range branch of `workers/uk_aq_aqi_history_r2_api_worker/`;
- `workers/uk_aq_station_history/`;
- narrowly related v2 response tests and Worker documentation;
- `workers/uk_aq_cache_proxy/src/index.ts` only if a response-contract or cache namespace marker is structurally required.

### Website repository

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`;
- their narrowly related tests or fixtures;
- directly related local cache-shape versioning only if required.

The shared AQI calculation library should remain unchanged unless endpoint output filtering is implemented there already and cannot be corrected safely in the v2 station-history layer.

Prune Daily, R2 writers, manifests, indexes, history repair tools and schema are review-only for this plan and are expected to remain unchanged.

## Deployment strategy

Use an additive, compatibility-safe transition so an old website and a new website are not forced to interpret the same ambiguous field differently during deployment.

The recommended sequence is:

1. confirm TEST uses R2 v2 and inventory every active v2 consumer;
2. add an explicit endpoint field through the v2 ops read interfaces while retaining temporary website compatibility;
3. update both website renderers and the loader to use the explicit endpoint;
4. correct v2 range, gap, chunk and period-start semantics;
5. validate through the real TEST pipeline;
6. remove only temporary compatibility code that is proven unnecessary.

Do not silently change the meaning of `period_start_utc` before every active website consumer can use an explicit endpoint.

---

# Phase 0: targeted v2 inventory and deployed configuration confirmation

## Objective

Confirm that TEST is using the R2 v2 AQI history path and identify the exact active v2 producers and consumers before implementation.

This phase is read-only. It must not change code, configuration, R2 objects or deployed services.

## Mandatory targeted check

Confirm the deployed TEST value:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

Also confirm the active v2 read settings and bindings used by:

- the AQI History R2 API Worker;
- the station-history Worker;
- the cache proxy;
- the website station-history route.

Relevant settings may include:

```text
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX
UK_AQ_R2_HISTORY_INDEX_V2_PREFIX
UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED
UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX
UK_AQ_STATION_HISTORY_STATION_SERIES_ENABLED
UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED
UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED
```

If TEST is not using v2, stop. Do not implement a v1 correction.

No Prune Daily branch check is required because this plan does not change the v2 writer.

## Ops repository inventory

Search active, non-archive code for:

- `period_start_utc`;
- `period_end_utc`;
- `timestamp_hour_utc`;
- v2 AQI history prefixes;
- v2 range and day-partition enumeration;
- expected AQI endpoint generation;
- AQI gap detection;
- stable-head and older-chunk boundaries;
- compact and object response columns;
- cache keys or response markers;
- any shared v1/v2 branch where a v2-only guard is required.

Confirm active ownership across:

- `workers/uk_aq_aqi_history_r2_api_worker/`;
- `workers/uk_aq_station_history/`;
- `workers/uk_aq_cache_proxy/src/index.ts`;
- current deployment workflows;
- active focused tests.

Review Prune Daily, shared R2 indexes and v2 history layout only to confirm that stored rows are already correct endpoints. They are not implementation targets.

Ignore archived implementations except as historical evidence.

## Website repository inventory

Search for every active AQI consumer and renderer, including:

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`;
- AQI response normalisers;
- DAQI and European AQI tooltip logic;
- chart range clipping;
- local storage or cache state that serialises normalised AQI points;
- tests and fixtures using `period_start_utc`, `period_end_utc` or `timestamp_hour_utc`.

Confirm there is no third active AQI chart implementation.

## Phase 0 output

Produce a concise inventory containing:

- confirmation that TEST uses v2;
- exact v2 files that require changes;
- files reviewed but intentionally unchanged;
- every active website AQI consumer;
- proposed additive endpoint fields;
- whether a response-contract or cache-key version is required;
- confirmation that no R2 v2 data, writer, manifest, index or schema change is needed;
- any conflict with this plan or the mandatory system documentation.

Do not implement in Phase 0.

## Codex prompt for Phase 0

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Work in the TEST UK AQ repositories. This is a read-only v2 implementation inventory for the AQI display timestamp correction. Do not edit files, create commits, change configuration, deploy, or write to R2 or Supabase.

Repositories:
- TEST-uk-aq/uk-aq-ops
- TEST-uk-aq/TEST-uk-aq-root.github.io

Read first:
- the complete AQI Display correction plan
- every file under uk-aq-ops/system_docs/aqi-levels/

Scope:
- R2 AQI history v2 only
- v1 is retiring and is out of scope
- do not propose or implement any v1 changes

Authoritative rule:
- timestamp_hour_utc=n is the interval endpoint
- period_start_utc=n-1 hour
- period_end_utc=n
- represented interval S..E requires endpoints S < n <= E

First confirm the deployed TEST value UK_AQ_R2_HISTORY_VERSION=v2 and identify the active v2 Worker names, URLs, bindings, prefixes and required-index settings. If TEST is not on v2, stop and report that mismatch.

Audit all active, non-archive v2 producers and consumers. Search for endpoint projection, AQI range filtering, day-partition selection, expected endpoints, gap detection, chunk boundaries, compact/object response columns, cache keys, website normalisation and both renderers.

Review the v2 Prune Daily writer, parquet schema, manifests and indexes only to confirm stored timestamp_hour_utc rows are already hour-ending endpoints. They are expected to remain unchanged.

Return:
1. confirmation that TEST uses v2;
2. exact active files that need changes, grouped by repository;
3. every active website AQI renderer and consumer;
4. response and cache compatibility risks;
5. recommended additive endpoint fields and whether a response-contract version is needed;
6. files reviewed but intentionally unchanged;
7. explicit confirmation that no R2 v2 data, writer, manifest, index or schema change is required;
8. any conflict with the plan or system_docs/aqi-levels.

Do not propose broad tests. Do not implement anything.
```

---

# Phase 1: add an explicit endpoint contract to the v2 read path

## Objective

Remove timestamp ambiguity from v2 AQI responses without changing R2 v2 stored data and without yet relying on a changed meaning of the existing `period_start_utc` field.

## Required implementation

### v2 AQI History R2 API Worker

In the active v2 branch of `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`:

- retain stored `timestamp_hour_utc` as the canonical endpoint;
- add an explicit `period_end_utc` response field equal to the canonical endpoint;
- expose or retain `timestamp_hour_utc` in object responses where compatibility allows;
- calculate a true `period_start_utc` as endpoint minus one hour only when the compatibility strategy from Phase 0 proves every active consumer can tolerate it;
- otherwise introduce a clearly versioned additive v2 response contract first;
- update compact response columns and object response fields consistently;
- keep retained TSV behaviour consistent where it remains active;
- preserve source, coverage, partial-response and cache behaviour;
- preserve required-index and bounded-scan behaviour;
- do not alter R2 v2 parquet, manifests, indexes or stored timestamps;
- do not edit the v1 branch.

Where v1 and v2 share response helpers, make the smallest guarded change that affects v2 only.

### Station-history Worker

In `workers/uk_aq_station_history/`:

- normalise incoming v2 R2 rows around an explicit endpoint;
- make every internal AQI row retain `period_end_utc` or equivalent canonical endpoint information;
- ensure live-calculated rows and v2 R2 rows expose the same timestamp fields;
- keep temporary compatibility fields only where required for the deployment sequence;
- keep stable-head precedence and mismatch logic unchanged;
- keep AQI and observation sections independent;
- preserve existing routes and private Service Binding architecture.

### Cache proxy

Review `workers/uk_aq_cache_proxy/src/index.ts` and deployment configuration:

- update only if a v2 response-contract marker, cache namespace or feature flag is structurally required;
- do not change public route names;
- do not change authentication, CORS, stale fallback or unrelated TTLs;
- prevent old cached ambiguous rows from being interpreted under a new v2 contract marker.

### R2 v2 writer and storage

No changes are expected.

Do not edit:

- Prune Daily AQI writer logic;
- v2 data or debug profiles;
- R2 manifests;
- v2 indexes;
- v2 timeseries metadata;
- R2 prefixes;
- backfill or repair scripts.

If implementation cannot proceed without changing these areas, stop and explain why. Do not broaden scope automatically.

## Focused checks

Before deployment, run only:

- syntax or type checks for changed Worker files;
- the smallest existing v2 AQI API response test;
- one compact deterministic check proving endpoint `07:00` yields start `06:00` and end `07:00`;
- one compact format-consistency check for compact and object v2 responses;
- one guard check proving the v1 branch or fixture is unchanged where shared code was touched.

Do not run broad repository suites or external service tests before deployment.

## Mandatory system-doc check

Before completing the phase, compare the full diff with all files under `system_docs/aqi-levels/` and report whether every mandatory invariant is retained.

## Phase 1 acceptance

- all new live and v2 R2 station-history AQI rows have an explicit endpoint;
- v2 API field meanings are unambiguous in the additive contract;
- R2 v2 stored timestamps and object content are unchanged;
- v2 source precedence and completeness are unchanged;
- v1 is unchanged;
- the old website deployment remains operational during the transition;
- no history rebuild or reindex occurs;
- the diff conforms to all mandatory AQI system documentation.

## Codex prompt for Phase 1

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 1 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops.

Read the complete plan and every file under system_docs/aqi-levels/ first. Use the completed Phase 0 inventory and confirmed deployed v2 configuration as authoritative evidence.

Scope:
- active R2 AQI history v2 read path only
- v1 is out of scope and must remain unchanged
- R2 v2 data, writer, parquet, manifests, indexes, metadata and prefixes must remain unchanged

Goal:
Add an explicit hour-ending AQI endpoint contract through the v2 AQI History R2 API and station-history path without shifting timestamp_hour_utc and without breaking the currently deployed website during the transition.

Required invariant:
- endpoint n represents (n-1h,n]
- period_end_utc=n
- true period_start_utc=n-1h

Update only:
- the active v2 branch of workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
- its focused v2 tests and README where needed
- workers/uk_aq_station_history active source and focused tests
- cache proxy only if a v2 contract marker or cache namespace change is genuinely required

Do not:
- edit or fix v1
- rewrite R2 v2 data
- change Prune Daily
- change v2 manifests or indexes
- rebuild or reindex history
- alter breakpoints or calculation formulas
- alter R2-over-live precedence
- weaken completeness or required-index behaviour
- change public routes, auth, CORS or unrelated cache settings
- touch inactive daily or monthly roll-ups
- refactor unrelated code

Before implementation, validate only that the additive v2 interface is structurally viable for all active consumers.

Run only narrow checks:
- syntax/type checks for changed files
- smallest focused v2 response tests
- 07:00 -> start 06:00, end 07:00
- compact/object consistency
- v1 unchanged where shared helpers were touched

Do not run broad suites or external functional tests. Functional validation will occur after deployment on TEST.

Before finishing, compare the full diff against every mandatory requirement in system_docs/aqi-levels/ and include a pass/fail compliance table.

Return:
1. changed files;
2. exact v2 compatibility strategy;
3. confirmation that R2 v2 data and v1 are unchanged;
4. focused checks run and results;
5. system-doc compliance result;
6. deployment order for Phase 2;
7. anything blocked or intentionally deferred.
```

---

# Phase 2: correct the website loader and both AQI renderers

## Objective

Make the website use the explicit v2 endpoint and draw each DAQI and European AQI band over the correct represented hour.

## Required implementation

### Website loader

In `station-history-loader.js`:

- normalise AQI rows into explicit `periodStart` and `periodEnd` values, or equivalent clearly named properties;
- prefer `period_end_utc` from the new v2 ops contract;
- accept `timestamp_hour_utc` as the canonical endpoint fallback;
- during the temporary compatibility window, use the minimum fallback needed for the old deployed response;
- do not add v1-specific compatibility logic;
- do not discard one index because the other is null;
- key AQI merge identity by the canonical endpoint;
- retain stable-head no-replacement behaviour for older chunks;
- update authoritative-head replacement boundaries using represented intervals rather than treating endpoint keys as starts;
- preserve observation merging and coverage state unchanged.

### Hex map station chart

In `hex_map/index.html`:

- update `renderAqiBands` or equivalent so each row ending at `n` draws from `n - 1 hour` to `n`;
- clip rectangles to the chart domain;
- do not create a rectangle for a missing index value;
- preserve independent DAQI and European AQI rows;
- leave a missing hour blank;
- ensure the final colour ends at the final AQI endpoint and does not extend one hour beyond the concentration line;
- preserve the current DAQI colour ordering intentionally chosen for the website;
- preserve tooltip, legend, range selector and observation rendering behaviour.

### Sensors station chart

Apply the same interval correction in `sensors/index.html`.

The two implementations must use the same endpoint semantics and missing-hour behaviour.

Do not fix only one chart.

### Browser or local cache compatibility

Review any serialised station-history cache or local state:

- version or invalidate only if the normalised AQI point shape changes and stale stored rows would be interpreted incorrectly;
- do not clear unrelated website state;
- do not introduce permanent dual timestamp interpretation;
- do not add v1-specific fallbacks.

## Focused checks

Before deployment, use only:

- syntax checks for changed JavaScript;
- the existing focused loader test where available;
- one deterministic loader check for endpoint normalisation;
- one deterministic renderer-boundary check for each renderer;
- one missing-hour check;
- one independent DAQI-null and European-AQI-valid check.

Do not add browser automation or a broad website suite before TEST deployment.

## Mandatory system-doc check

Before completing the phase, compare the website diff with all applicable mandatory behaviour in `system_docs/aqi-levels/`, especially the contract, interfaces, decision 0001 and validation acceptance criteria.

## Phase 2 acceptance

- both charts draw endpoint `07:00` from `06:00` to `07:00`;
- neither chart colours `07:00` to `08:00` from that row;
- the final coloured edge aligns with the final plotted value;
- a missing endpoint produces a blank hour;
- valid European AQI remains visible when DAQI is null;
- older chunks cannot replace the stable head;
- existing observation chart behaviour is unchanged;
- no v1-specific behaviour was added;
- the diff conforms to the mandatory AQI system documentation.

## Codex prompt for Phase 2

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 2 of the AQI Display correction plan in TEST-uk-aq/TEST-uk-aq-root.github.io.

Read:
- the complete plan in the ops repository
- every file under ops/system_docs/aqi-levels/
- the completed Phase 1 v2 response contract and deployment notes

Scope:
- active v2 station-history response only
- v1 is out of scope

Goal:
Make every active website AQI consumer use the explicit hour-ending endpoint and render each DAQI and European AQI band over (n-1h,n].

Required files include:
- station-history-loader.js
- hex_map/index.html
- sensors/index.html
- only their focused tests or fixtures and directly related cache-shape versioning

Requirements:
- prefer period_end_utc
- use timestamp_hour_utc as canonical endpoint fallback where present
- keep only the minimum temporary fallback needed for the old deployed v2 response
- do not add v1 compatibility
- normalise explicit period start and end values
- merge AQI identity by endpoint
- retain stable-head precedence over older chunks
- draw x1=n-1h and x2=n
- clip to chart range
- leave missing hours blank
- keep DAQI and European AQI independent
- preserve current website DAQI colours, legends, tooltip behaviour and observation chart behaviour
- correct both active chart implementations

Do not:
- change AQI calculation or breakpoints
- forward-fill or interpolate gaps
- change unrelated layout or map behaviour
- introduce a new public API route
- run broad browser automation before deployment

Use only narrow pre-deployment checks:
- JavaScript syntax
- focused loader test
- 07:00 endpoint renders 06:00-07:00 in both charts
- no colour after final endpoint
- missing 08:00 remains blank
- European AQI remains visible when DAQI is null

Functional testing happens after deployment on TEST through the real website.

Before finishing, compare the full diff against the applicable mandatory requirements in ops/system_docs/aqi-levels/ and include a pass/fail compliance table.

Return:
1. changed files;
2. old and new timestamp normalisation behaviour;
3. focused checks run;
4. system-doc compliance result;
5. exact TEST visual checks;
6. any temporary compatibility fallback that remains.
```

---

# Phase 3: correct v2 endpoint selection, gaps and chunk boundaries

## Objective

Correct the underlying active v2 range semantics so the right AQI rows are returned, not merely drawn differently.

This phase deploys after the website can consume explicit endpoint fields.

## Required implementation

### Narrow endpoint helpers

Create or centralise narrowly scoped helpers in the active v2 ops AQI read path for:

- canonical endpoint parsing;
- true period-start derivation;
- expected endpoint generation for represented interval `S` to `E`;
- endpoint-in-range predicate `S < n <= E`;
- conversion between represented interval boundaries and any start-inclusive or end-exclusive source query required internally.

Avoid multiple slightly different implementations across the v2 API and station-history code.

Do not create a broad date utility refactor and do not modify v1 helpers.

### Station-history on-the-fly filtering

Correct AQI output filtering so represented interval requests select:

```text
startMs < timestamp_hour_utc <= endMs
```

Retain the 23 preceding endpoint hours required for PM context.

Do not shift source observations or rolling-window endpoints.

### Expected endpoints and gaps

Replace start-labelled expected-hour logic for AQI with endpoint-aware generation.

Correct:

- expected endpoint lists;
- `missingAqiHourRanges` or equivalent;
- stable-head completeness;
- history-chunk completeness;
- seam-gap detection;
- actual start and end diagnostics where they currently imply forward coverage;
- latest v2 R2 AQI coverage end so an endpoint `n` does not falsely claim coverage through `n + 1 hour`.

Gap ranges returned to consumers should describe represented missing intervals clearly.

### v2 AQI History R2 API range selection

Correct v2 row selection and day-partition enumeration for represented intervals:

- exclude endpoint `S`;
- include endpoint `E`;
- include the endpoint-day v2 partition at midnight;
- keep `since_utc` semantics explicitly documented and consistent;
- preserve row limits, ordering and source-coverage diagnostics;
- preserve R2 v2 precedence;
- preserve required-index and bounded-scan behaviour.

Where an internal parquet filter or recent-source query uses start-inclusive or end-exclusive mechanics, translate the represented interval deliberately rather than changing stored values.

### History chunks

Correct older AQI chunk boundaries so adjacent chunks:

- have no duplicated represented hour;
- have no omitted represented hour;
- remain newest-first by cursor and ascending within each returned chunk;
- end at or before the stable-head represented boundary;
- retain immutable or mutable cache classification.

Observation chunk semantics must remain unchanged.

### Response contract finalisation

After the website consumes the explicit endpoint:

- make `period_start_utc` the true start in the selected v2 response contract;
- retain `period_end_utc` as the canonical endpoint;
- keep `timestamp_hour_utc` where useful for internal or debug compatibility;
- remove or deprecate any temporary ambiguous alias according to the Phase 0 compatibility decision;
- version cache keys or response markers only where required.

### R2 v2 writer and storage

No changes are expected or permitted under this plan.

The phase may read v2 partitions differently, but it must not change:

- stored endpoint rows;
- parquet content;
- partition names;
- manifests;
- indexes;
- metadata;
- Prune Daily;
- history repair or backfill tooling.

Do not edit v1.

## Focused checks

Before deployment, run only narrow deterministic checks for:

- `S < n <= E` endpoint selection;
- 23 preceding PM context hours plus the current endpoint;
- no duplicate or missing endpoint across adjacent chunks;
- midnight endpoint included from the v2 endpoint-day partition;
- one missing-endpoint gap interval;
- R2 v2 and live overlap still retains R2;
- v2 compact and object response-field consistency;
- v1 unchanged where shared helpers were touched.

Do not run broad integration suites before deployment.

## Mandatory system-doc check

Compare the complete Phase 3 diff with every file under `system_docs/aqi-levels/`. Report each mandatory retained function as pass or fail before deployment.

## Phase 3 acceptance

- represented range requests return exactly the required v2 endpoint rows;
- the final endpoint is included;
- the initial pre-range endpoint is excluded;
- midnight requests include the proper v2 endpoint-day partition;
- gap and completeness reporting matches represented intervals;
- adjacent chunks are continuous without duplication;
- stored R2 v2 timestamps and objects remain unchanged;
- R2 v2 and live precedence remains unchanged;
- v1 remains unchanged;
- the diff conforms to all mandatory AQI system documentation.

## Codex prompt for Phase 3

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 3 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops.

Prerequisites:
- Phase 1 explicit v2 endpoint contract is deployed on TEST
- Phase 2 website supports period_end_utc and renders (n-1h,n]

Read the full plan and every file under system_docs/aqi-levels/ first.

Scope:
- active R2 AQI history v2 read and station-history paths only
- v1 is out of scope and must remain unchanged
- R2 v2 data, writer, parquet, manifests, indexes and metadata must remain unchanged

Goal:
Correct active v2 AQI range selection, expected endpoint, gap, coverage and history-chunk semantics to use represented interval S..E => endpoints S < n <= E.

Review and update only:
- workers/uk_aq_station_history/
- the active v2 branch of workers/uk_aq_aqi_history_r2_api_worker/
- narrowly scoped shared endpoint helpers where structurally necessary
- focused tests and Worker READMEs
- cache proxy only if final v2 response marker or cache versioning requires it

Requirements:
- centralise narrow v2 endpoint helpers rather than duplicate off-by-one logic
- retain 23 preceding PM endpoint hours for 24-hour DAQI context
- select output endpoints with start < n <= end
- fix expected endpoints and missing AQI interval reporting
- fix stable-head and older-chunk completeness
- ensure adjacent AQI chunks neither duplicate nor omit a represented hour
- include midnight endpoint E from E's v2 endpoint-day partition
- stop claiming coverage to n+1h from a row ending at n
- make period_start_utc a true start in the final v2 contract
- retain period_end_utc as endpoint
- preserve R2-over-live precedence, scan budgets, required-index behaviour, partial responses and observation semantics

Do not:
- edit or fix v1
- shift or rewrite stored R2 v2 timestamps
- change Prune Daily
- change v2 parquet, manifests, indexes or metadata
- change breakpoint or calculation formulas
- change raw observations
- reactivate daily or monthly roll-ups
- modify observation range semantics unless required to prevent accidental coupling
- broaden scans when indexes are missing
- refactor unrelated time utilities

Before implementation, validate structural viability only.

Run narrow checks for:
- endpoint selection boundaries
- PM context
- midnight v2 partition
- one missing-endpoint gap
- adjacent chunk continuity
- R2 v2/live precedence
- compact/object field consistency
- v1 unchanged where shared code was touched

Do not run broad suites or external functional tests. Deploy to TEST for functional validation.

Before finishing, compare the full diff against every mandatory requirement in system_docs/aqi-levels/ and include a pass/fail compliance table.

Return:
1. changed files;
2. endpoint helper and range translation design;
3. exact old and new boundary behaviour;
4. confirmation that v1 and R2 v2 stored data are unchanged;
5. focused checks run;
6. system-doc compliance result;
7. TEST deployment and validation sequence.
```

---

# Phase 4: TEST deployment and functional validation

## Objective

Validate the coordinated v2 correction through real TEST operations rather than expanding pre-deployment test coverage.

## Deployment order

Use the compatibility strategy confirmed in Phase 0:

1. deploy Phase 1 additive v2 endpoint contract;
2. verify the old website remains functional;
3. deploy Phase 2 website endpoint-aware loader and renderers;
4. verify the website works with the additive Phase 1 v2 response;
5. deploy Phase 3 finalised v2 range and period-start semantics;
6. allow normal cache expiry or version only affected cache entries;
7. validate recent and historical v2 chart paths.

No Prune Daily deployment or R2 v2 data operation is required.

Do not combine all repositories into one unobservable deployment unless Phase 0 proves there is an atomic deployment mechanism.

## Required real TEST checks

### v2 source confirmation

For every API and chart check, record evidence that the response uses the active v2 path.

Do not use v1 responses as acceptance evidence.

### Known single-hour display

Use a station with a clear final AQI endpoint `n`.

Confirm in both website chart implementations:

- the concentration point is at `n`;
- DAQI colour starts at `n - 1 hour`;
- DAQI colour ends at `n`;
- European AQI colour starts at `n - 1 hour`;
- European AQI colour ends at `n`;
- no colour appears after `n`.

### Missing-hour display

Use or identify a range containing a genuinely missing AQI endpoint.

Confirm:

- the represented missing hour is blank;
- the previous colour does not extend forward;
- the next colour does not extend backwards;
- the v2 response reports the corresponding gap and is not cached as complete.

### PM incomplete DAQI

Use a recent PM range with fewer than 24 rolling hours where available.

Confirm:

- DAQI is null with `insufficient_samples`;
- European AQI remains present when the hourly mean is valid;
- the European AQI band uses the correct hour-ending interval.

### R2 v2 and live seam

Use a range spanning committed R2 v2 and recent live-calculated AQI.

Confirm:

- there is no omitted or duplicated hour at the seam;
- R2 v2 wins in overlap;
- mismatch diagnostics remain visible if a difference exists;
- the final endpoint is not extended forward.

### Older chunk boundary

Load enough history to fetch at least two AQI chunks.

Confirm:

- chunks extend backwards only;
- the boundary hour appears exactly once;
- stable-head rows are not replaced;
- visual colours remain continuous only where endpoint rows are continuous.

### Midnight boundary

Use a chart range crossing UTC midnight.

Confirm the row ending at `00:00`:

- is returned through the v2 read path;
- comes from the `00:00` v2 endpoint-day partition where R2 history is used;
- colours `23:00` to `00:00`;
- is not assigned to `00:00` to `01:00`;
- is not omitted from the end of the preceding represented day.

### R2 v2 immutability confirmation

Confirm that the correction caused no changes to:

- v2 parquet object hashes or etags;
- v2 manifest hashes or etags;
- v2 index hashes or etags;
- v2 timeseries metadata;
- Prune Daily configuration or output behaviour.

A full bucket inventory is not required. Use bounded evidence for the affected days and timeseries.

### Compatibility and unrelated behaviour

Confirm:

- observation lines, tooltips and units remain correct;
- DAQI and European AQI colours and legends remain unchanged;
- station search, chart-range controls and older-history loading still work;
- partial responses remain non-cacheable;
- private Worker routes remain private;
- no new errors appear in Worker, cache-proxy or browser logs;
- no v1 code or deployment was changed.

## Rollback

If Phase 1 causes compatibility issues, roll back the additive v2 ops deployment only. Stored R2 data is unaffected.

If Phase 2 causes rendering issues, roll back the website while retaining the additive endpoint fields in v2 ops.

If Phase 3 causes range or completeness issues, roll back the final v2 range change while the website continues using the explicit endpoint from Phase 1.

Do not roll back by rewriting R2 timestamps or modifying v1.

Keep each phase deployable and reversible independently.

## Phase 4 acceptance

The correction is complete only when:

- all applicable acceptance criteria in `system_docs/aqi-levels/validation.md` pass through the real TEST v2 path;
- bounded evidence confirms R2 v2 stored data and metadata are unchanged;
- v1 is unchanged and was not used as acceptance evidence.

## Codex prompt for Phase 4 review

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Perform the Phase 4 post-deployment review for the AQI Display correction on TEST.

Do not make code changes initially. Use the deployed TEST v2 services, real v2 API responses and both website chart implementations.

Read:
- the complete plan
- every file under system_docs/aqi-levels/
- deployment notes from Phases 1-3

Scope:
- validate R2 AQI history v2 only
- v1 is out of scope and must not be used as acceptance evidence
- no Prune Daily or R2 data change is expected

Validate:
1. evidence confirms each tested response uses v2;
2. one endpoint n draws only n-1h to n in both charts;
3. no colour extends beyond the final concentration endpoint;
4. a missing endpoint leaves one blank represented hour;
5. PM DAQI can be insufficient while European AQI remains visible;
6. the R2 v2/live seam has no omission or duplicate and R2 wins overlap;
7. older chunks extend backwards without replacing stable head;
8. midnight endpoint 00:00 is returned from the v2 endpoint-day partition and colours 23:00-00:00;
9. partial responses remain partial and non-cacheable;
10. unrelated observations, colours, legends, tooltips, range controls and private routing remain unchanged;
11. bounded object evidence confirms v2 parquet, manifests, indexes and metadata were not rewritten;
12. v1 code and deployment remain unchanged;
13. all applicable mandatory requirements in system_docs/aqi-levels/ pass.

Capture exact request ranges, endpoint timestamps, source modes, completeness fields and bounded screenshots or log excerpts needed to support each conclusion. Do not expose secrets.

If a defect is found, classify it as:
- v2 API projection
- v2 endpoint selection
- gap or completeness
- chunk boundary
- v2 R2 partition read
- live calculation context
- website normalisation
- renderer geometry
- cache compatibility

Recommend the narrowest rollback or correction. Do not rewrite R2 v2 timestamps, edit v1 or broaden the scope without evidence.

Return:
- a pass/fail table against the documented acceptance criteria;
- a system-doc compliance table;
- confirmation that R2 v2 stored data and v1 are unchanged;
- any precise follow-up changes required.
```

---

# Phase 5: optional removal of temporary compatibility code

## Objective

Remove only temporary v2 transition code that is no longer needed after the final contract has operated successfully on TEST.

This phase is optional and must not happen merely for tidiness.

## Preconditions

- Phase 4 acceptance criteria pass;
- caches carrying the ambiguous old v2 response have expired or are isolated by contract version;
- no active website consumer depends on the ambiguous field meaning;
- logs show no old-contract requests during a reasonable TEST observation period;
- rollback evidence is retained.

## Allowed cleanup

- remove temporary fallback that treats ambiguous `period_start_utc` as an endpoint;
- remove a temporary v2 response alias only where the compatibility decision explicitly permits it;
- simplify focused tests to the final v2 contract;
- update Worker READMEs and AQI system docs to mark implementation discrepancies resolved;
- record the deployed v2 response contract and completion date.

## Prohibited cleanup

- removing `period_end_utc`;
- removing canonical endpoint information;
- editing v1;
- deleting or rewriting R2 v2 history;
- changing v2 manifests, indexes or metadata;
- changing cache, route or authentication behaviour unrelated to the transition;
- activating daily or monthly roll-ups;
- broad refactoring.

## Codex prompt for Phase 5

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Review whether Phase 5 cleanup is justified for the AQI Display correction.

Read the full plan, Phase 4 validation report and every file under system_docs/aqi-levels/.

Scope:
- final v2 compatibility cleanup only
- v1 and R2 v2 stored data remain out of scope

First determine whether every precondition is proven:
- final v2 contract passed TEST validation
- old ambiguous cached responses are expired or version-isolated
- no active consumer relies on ambiguous period_start_utc-as-endpoint behaviour
- no old-contract requests remain in relevant logs

If any precondition is not proven, do not edit code. Return what evidence is missing.

If all preconditions are proven, remove only temporary v2 compatibility code and update focused documentation or tests to the final contract:
- period_start_utc is true start
- period_end_utc is endpoint
- represented range S..E uses S < n <= E

Do not edit v1. Do not touch R2 v2 data, writers, manifests, indexes, metadata, calculations, inactive roll-ups, routes, auth, unrelated cache policy or unrelated website code.

Use only syntax or type checks and the smallest focused contract tests before deployment. Functional confirmation remains on TEST.

Before finishing, compare the diff with every mandatory requirement in system_docs/aqi-levels/ and include a pass/fail compliance table.

Return changed files, removed temporary behaviour, retained permanent fields, system-doc compliance and final TEST checks.
```

---

# Cross-phase change matrix

| Area | Expected change | Must not change |
|---|---|---|
| v2 AQI History R2 API | Explicit start/end fields, v2 endpoint-aware ranges and partition reads | R2 v2 stored rows, v1, precedence, scan budgets |
| Station-history Worker | Endpoint-aware normalisation, gaps, coverage and chunks | Private routing, observation semantics, source precedence |
| Cache proxy | v2 contract or cache versioning only if required | Route names, auth, CORS, unrelated TTLs |
| Website loader | Explicit period start/end, endpoint-keyed merge | Stable-head precedence, observation merge, v1-specific logic |
| Hex map chart | Draw `[n-1h,n]` | Colours, legend, tooltip, observation line |
| Sensors chart | Draw `[n-1h,n]` | Colours, legend, tooltip, observation line |
| Shared AQI calculation | Expected to remain unchanged | Breakpoints, averaging formulas, 24-hour PM rule |
| Prune Daily | Review only | All code, configuration, schedules and output behaviour |
| R2 v2 parquet | No change | Rows, timestamps, hashes and partitions |
| R2 v2 manifests | No change | Hierarchy, bodies, hashes and etags |
| R2 v2 indexes and metadata | No change | Prefixes, bodies, hashes and etags |
| v1 | No change | All code, data, tests and deployment behaviour |
| Schema | No change | Tables, RPCs and inactive roll-ups |

# Overall completion criteria

The plan is complete only when:

1. TEST is confirmed to use the v2 AQI history path;
2. every active v2 AQI producer and consumer uses an unambiguous hour-ending endpoint;
3. represented interval requests select `S < n <= E`;
4. both website chart implementations draw `n - 1 hour` to `n`;
5. the final coloured edge aligns with the final valid concentration endpoint;
6. missing hours remain blank;
7. midnight endpoint rows are included from the correct v2 endpoint-day partition;
8. PM rolling context remains 24 endpoint hours;
9. European AQI remains independent of PM DAQI completeness;
10. R2 v2 remains authoritative over live calculation;
11. chunks have no omitted or duplicated represented hours;
12. partial responses remain explicit and appropriately non-cacheable;
13. R2 v2 parquet, manifests, indexes, metadata and stored timestamps remain unchanged;
14. Prune Daily remains unchanged;
15. v1 remains unchanged and out of scope;
16. daily and monthly roll-ups remain inactive;
17. unrelated website and API behaviour is retained;
18. every phase reports compliance with the mandatory AQI system documentation;
19. all functional acceptance checks pass through the real TEST v2 system.