# AQI display correction plan

- Date: 17 July 2026
- Status: Proposed
- Primary repository: `TEST-uk-aq/uk-aq-ops`
- Website repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`
- Schema repository: `TEST-uk-aq/uk-aq-schema`
- Authoritative system documentation: `system_docs/aqi-levels/`

## Purpose

Correct AQI period handling everywhere it affects the displayed DAQI and European AQI bands, while preserving the existing calculation formulas, stored R2 timestamps, source precedence, history integrity and unrelated website behaviour.

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

## Confirmed current defects

### Website rendering

Both active station-chart renderers currently treat an AQI timestamp `n` as the start of the coloured rectangle and draw to `n + 1 hour`.

Affected website files include:

- `hex_map/index.html`;
- `sensors/index.html`.

This causes the final coloured AQI section to extend beyond the final plotted concentration timestamp.

### Website loader

`station-history-loader.js` currently normalizes one ambiguous `date` from fields including `period_start_utc` and `timestamp_hour_utc`.

It does not retain explicit period start and end boundaries. This allows a field naming defect upstream to become a rendering defect downstream.

### AQI History R2 API

`workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` stores and reads canonical `timestamp_hour_utc` endpoint values but exposes the value as `period_start_utc` without subtracting one hour.

The current response therefore gives an endpoint timestamp a start-time field name.

### Station-history range and completeness logic

The station-history path generally generates expected AQI hours and filters rows using start-inclusive, end-exclusive timestamp logic.

For hour-ending rows, represented interval `S` to `E` requires endpoint selection `S < n <= E`.

Changing only the website rectangle would leave:

- the first endpoint boundary wrong;
- the final endpoint omitted in some ranges;
- gap detection wrong;
- chunk completeness wrong;
- midnight endpoint partition reads vulnerable to omission.

### Midnight partition boundary

R2 AQI `day_utc` follows the endpoint date.

The interval `17 July 23:00` to `18 July 00:00` is represented by endpoint `18 July 00:00` and is stored under `day_utc=2026-07-18`.

Readers must include the endpoint-day partition when the request ends at midnight.

### Inactive roll-ups

Daily and monthly AQI roll-ups are inactive. Their SQL groups by endpoint date and would be wrong at calendar boundaries under the accepted interval contract.

They are not part of this active correction and must not be reactivated or refreshed by this work.

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
- committed R2 AQI remains authoritative over live calculation for the same endpoint;
- older history chunks must not replace the stable head;
- AQI and observation completeness remain independent;
- incomplete and gap-bearing responses remain explicitly partial and non-cacheable where currently required;
- v2 data and debug R2 profiles remain aligned;
- manifest and index hierarchy remains unchanged;
- stored `timestamp_hour_utc` values and existing parquet row identities remain unchanged;
- daily and monthly roll-ups remain inactive;
- station-history remains private behind the cache-proxy Service Binding;
- unrelated map, sensor list, observation chart and cache behaviour remains unchanged.

## Explicit non-goals

This plan must not:

- rewrite or shift historical R2 AQI timestamps;
- rebuild all AQI history merely to correct display semantics;
- change AQI breakpoint tables;
- change pollutant support;
- modify raw observation history;
- reactivate daily or monthly roll-ups;
- introduce interpolation or forward-fill for missing AQI hours;
- create a second public AQI calculation path;
- replace R2 precedence with last-write-wins merging;
- broaden R2 scans when required indexes are missing;
- refactor unrelated website or Worker code;
- create a broad speculative pre-deployment test suite.

## Deployment strategy

Use an additive, compatibility-safe transition so an old website and a new website are not forced to interpret the same ambiguous field differently during deployment.

The recommended sequence is:

1. inspect active configuration and all consumers;
2. add an explicit endpoint field through the ops interfaces while retaining temporary compatibility;
3. update both website renderers and loader to use the endpoint explicitly;
4. correct ops range, gap, chunk and period-start semantics;
5. validate through the real TEST pipeline;
6. remove only temporary compatibility code that is proven unnecessary.

Do not silently change the meaning of `period_start_utc` before every active consumer can use an explicit endpoint.

---

# Phase 0: targeted inventory and deployed configuration check

## Objective

Confirm the exact active code paths and repository-variable overrides before implementation.

This phase is read-only. It must not change code, configuration, R2 objects or deployed services.

## Required checks

### Ops repository

Search active, non-archive code for:

- `period_start_utc`;
- `period_end_utc`;
- `timestamp_hour_utc`;
- `canonicalAqiHourStarts`;
- `hourStarts`;
- `missingAqiHourRanges`;
- `renderAqiBands` references in tests or fixtures;
- `startMs` / `endMs` filters applied to AQI rows;
- daily/monthly roll-up refresh calls;
- AQI compact response column lists;
- AQI history cache keys or schema markers that may require versioning.

Confirm active ownership across:

- `lib/aqi/aqi_levels.mjs`;
- `workers/uk_aq_station_history/`;
- `workers/uk_aq_aqi_history_r2_api_worker/`;
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- `workers/uk_aq_cache_proxy/src/index.ts`;
- current deployment workflows;
- active tests.

Ignore archived implementations except as historical evidence.

### Website repository

Search for every AQI consumer and renderer, including:

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`;
- AQI response normalizers;
- DAQI and European AQI tooltip logic;
- chart range clipping;
- local storage or cache state that serializes normalized AQI points;
- tests and fixtures using `period_start_utc` or `timestamp_hour_utc`.

Confirm there are no third active AQI chart implementations.

### Schema repository

Confirm:

- `timestamp_hour_utc` remains the hourly endpoint storage field;
- daily/monthly updater is not called from an active service;
- no active public RPC changes are required for this display correction;
- any schema comments or focused tests that incorrectly call the endpoint a period start are identified.

Do not change inactive roll-up SQL in this plan unless a misleading active interface comment must be corrected. Record it as deferred reactivation work.

### Deployed TEST configuration

Check actual repository variables or deployed values for:

```text
UK_AQ_R2_HISTORY_VERSION
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED
UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED
UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX
UK_AQ_STATION_HISTORY_STATION_SERIES_ENABLED
UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED
UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED
```

Also record active Worker names and URLs used by the cache proxy and station-history binding.

This is the only mandatory pre-implementation environment check. It is needed because workflow defaults can be overridden and the active Prune Daily branch cannot be inferred safely from source alone.

## Phase 0 output

Produce a concise implementation inventory containing:

- files that require changes;
- files reviewed but not changed;
- active Prune Daily AQI branch;
- active R2 history version;
- active website consumers;
- proposed additive response fields;
- whether a response-contract or cache-key version is required;
- any newly found consumer that changes the later phases.

Do not implement in Phase 0.

## Codex prompt for Phase 0

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Work in the TEST UK AQ repositories. This is a read-only implementation inventory for the AQI display timestamp correction. Do not edit files, create commits, change configuration, deploy, or write to R2/Supabase.

Primary repositories:
- TEST-uk-aq/uk-aq-ops
- TEST-uk-aq/TEST-uk-aq-root.github.io
- TEST-uk-aq/uk-aq-schema

Read first:
- uk-aq-ops/system_docs/aqi-levels/README.md
- uk-aq-ops/system_docs/aqi-levels/contract.md
- uk-aq-ops/system_docs/aqi-levels/interfaces.md
- uk-aq-ops/system_docs/aqi-levels/validation.md
- uk-aq-ops/system_docs/aqi-levels/decisions/0001-hour-ending-aqi-intervals.md
- this plan

Authoritative rule:
- timestamp_hour_utc=n is the interval endpoint
- period_start_utc=n-1 hour
- period_end_utc=n
- represented interval requests S..E need endpoints S < n <= E

Audit all active, non-archive producers and consumers. Search for period_start_utc, period_end_utc, timestamp_hour_utc, expected-hour generation, AQI range filtering, gap detection, chunk boundaries, compact response columns, cache keys, website normalization, AQI rendering and inactive roll-up callers.

Inspect the actual TEST repository/deployment variables where available for:
UK_AQ_R2_HISTORY_VERSION
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED
UK_AQ_AQI_HISTORY_R2_TIMESERIES_INDEX_ENABLED
UK_AQ_AQI_HISTORY_R2_REQUIRE_TIMESERIES_INDEX
UK_AQ_STATION_HISTORY_STATION_SERIES_ENABLED
UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED
UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED

Return:
1. exact active files that need changes, grouped by repository;
2. active Prune Daily AQI branch and R2 history version;
3. every active website AQI renderer/consumer;
4. response and cache compatibility risks;
5. recommended additive endpoint fields and whether a response-contract version is needed;
6. files reviewed but intentionally unchanged;
7. any conflict with the plan.

Do not propose broad tests. Do not implement anything.
```

---

# Phase 1: add an explicit AQI endpoint contract in ops

## Objective

Remove timestamp ambiguity from internal AQI responses without yet relying on a changed meaning of the existing `period_start_utc` field.

## Required implementation

### AQI History R2 API Worker

In `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`:

- retain stored `timestamp_hour_utc` as the canonical endpoint;
- add an explicit `period_end_utc` response field equal to the canonical endpoint;
- expose or retain `timestamp_hour_utc` in object responses where compatibility allows;
- calculate a true `period_start_utc` as endpoint minus one hour only when the compatibility strategy from Phase 0 proves every active consumer can tolerate it;
- otherwise introduce a clearly versioned additive contract first, with the corrected start field in that contract;
- update compact response columns and object response fields consistently;
- keep `format=compact`, `objects` and retained TSV behaviour internally consistent;
- preserve source, coverage, partial-response and cache behaviour;
- do not alter stored parquet values;
- do not change R2 source precedence;
- do not broaden scans or weaken required-index behaviour.

### Station-history Worker

In `workers/uk_aq_station_history/`:

- normalize incoming R2 rows around an explicit endpoint;
- make every internal AQI row retain `period_end_utc` or canonical endpoint information;
- keep temporary compatibility fields only where required for the deployment sequence;
- ensure live-calculated rows and R2 rows expose the same timestamp fields;
- keep stable-head precedence and mismatch logic unchanged;
- keep AQI and observation sections independent;
- preserve existing routes and private Service Binding architecture.

### Cache proxy

Review `workers/uk_aq_cache_proxy/src/index.ts` and deployment configuration:

- update only if a response-contract marker, cache namespace or feature flag is structurally required;
- do not change public route names;
- do not change authentication, CORS, stale fallback or unrelated TTLs;
- prevent old cached ambiguous rows being served under a new contract marker if the response semantics change.

### Prune Daily and R2 writer

Do not shift or rewrite stored AQI timestamps.

Only amend active writer metadata, manifest fields or comments if necessary to state explicitly that `timestamp_hour_utc` is the endpoint.

If the active branch emits a public field named `period_start_utc` before R2 storage, correct that projection while preserving the stored endpoint field.

Do not trigger a historical rebuild.

### Focused checks

Before deployment, run only:

- syntax/type checks for changed Worker files;
- the smallest existing AQI API response test;
- one compact deterministic check proving endpoint `07:00` yields start `06:00` and end `07:00`;
- one compact format-consistency check for compact and object responses.

Do not run broad repository suites or external service tests before deployment.

## Phase 1 acceptance

- all new live and R2 station-history AQI rows have an explicit endpoint;
- API field meanings are unambiguous in the new/additive contract;
- existing stored timestamps are unchanged;
- source precedence and completeness are unchanged;
- old website deployment remains operational during the transition;
- no history rebuild occurs.

## Codex prompt for Phase 1

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 1 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops only.

Read the complete plan and all system_docs/aqi-levels files first. Use the Phase 0 inventory and actual deployed configuration as authoritative evidence. Do not use archive code as an active implementation source.

Goal:
Add an explicit hour-ending AQI endpoint contract through the AQI History R2 API and station-history path without shifting stored timestamp_hour_utc values and without breaking the currently deployed website during the transition.

Required invariant:
- endpoint n represents (n-1h,n]
- period_end_utc=n
- true period_start_utc=n-1h

Implement the compatibility-safe additive design selected in Phase 0. Update:
- workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
- its focused tests and README where needed
- workers/uk_aq_station_history active source and focused tests
- cache proxy only if a contract marker/cache namespace change is genuinely required
- active writer metadata/comments only if needed to make endpoint meaning explicit

Do not:
- rewrite R2 data
- shift timestamp_hour_utc
- rebuild history
- alter breakpoints or calculation formulas
- alter R2-over-live precedence
- weaken completeness or required-index behaviour
- change public route names, auth, CORS or unrelated cache settings
- touch inactive daily/monthly roll-up logic
- refactor unrelated code

Before implementation, validate only that the chosen additive interface is structurally viable for all active consumers. Then implement.

Run only narrow checks:
- syntax/type checks for changed files
- the smallest existing focused response tests
- one endpoint transformation check: 07:00 -> start 06:00, end 07:00
- compact/object field consistency

Do not run broad suites or external functional tests. Functional validation will occur after deployment on TEST.

Update system_docs/aqi-levels only if implementation details require clarification, without weakening the contract.

Return:
1. changed files;
2. exact compatibility strategy;
3. checks run and results;
4. deployment order for the next phase;
5. anything blocked or intentionally deferred.
```

---

# Phase 2: correct the website loader and both AQI renderers

## Objective

Make the website use the explicit endpoint and draw each DAQI and European AQI band over the correct represented hour.

## Required implementation

### Website loader

In `station-history-loader.js`:

- normalize AQI rows into explicit `periodStart` and `periodEnd` values, or equivalent clearly named properties;
- prefer `period_end_utc` from the new ops contract;
- accept `timestamp_hour_utc` as the canonical endpoint fallback;
- during the temporary compatibility window, treat the existing ambiguous timestamp field according to the exact old contract only where the endpoint fields are absent;
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

### Browser/local cache compatibility

Review any serialized station-history cache or local state:

- version or invalidate only if normalized AQI point shape changes and stale stored rows would be interpreted incorrectly;
- do not clear unrelated website state;
- do not introduce a permanent dual timestamp interpretation.

### Focused checks

Before deployment, use only:

- syntax checks for changed JavaScript;
- the existing focused loader test where available;
- one deterministic loader check for endpoint normalization;
- one deterministic renderer-boundary check for each renderer;
- one missing-hour check;
- one independent DAQI-null/European-AQI-valid check.

Do not add browser automation or a broad website suite before TEST deployment.

## Phase 2 acceptance

- both charts draw endpoint `07:00` from `06:00` to `07:00`;
- neither chart colours `07:00` to `08:00` from that row;
- the final coloured edge aligns with the final plotted value;
- a missing endpoint produces a blank hour;
- valid European AQI remains visible when DAQI is null;
- older chunks cannot replace the stable head;
- existing observation chart behaviour is unchanged.

## Codex prompt for Phase 2

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 2 of the AQI Display correction plan in TEST-uk-aq/TEST-uk-aq-root.github.io.

Read:
- the complete plan in the ops repository
- all ops/system_docs/aqi-levels files
- the completed Phase 1 response contract and deployment notes

Goal:
Make every active website AQI consumer use the explicit hour-ending endpoint and render each DAQI and European AQI band over (n-1h,n].

Required files include:
- station-history-loader.js
- hex_map/index.html
- sensors/index.html
- only their focused tests/fixtures and any directly related cache-shape versioning

Requirements:
- prefer period_end_utc
- use timestamp_hour_utc as canonical endpoint fallback where present
- keep only the minimum temporary fallback needed for the old deployed ops response
- normalize explicit period start/end values
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

Return:
1. changed files;
2. old/new timestamp normalization behaviour;
3. focused checks run;
4. exact TEST visual checks to perform;
5. any temporary compatibility fallback that remains.
```

---

# Phase 3: correct ops endpoint selection, gaps and chunk boundaries

## Objective

Correct the underlying range semantics so the right AQI rows are returned, not merely drawn differently.

This phase should deploy after the website can consume explicit endpoint fields.

## Required implementation

### Shared endpoint helpers

Create or centralize narrowly scoped helpers in the ops AQI path for:

- canonical endpoint parsing;
- true period start derivation;
- expected endpoint generation for represented interval `S` to `E`;
- endpoint-in-range predicate `S < n <= E`;
- conversion between represented interval boundaries and any legacy start-inclusive/end-exclusive source query required internally.

Avoid multiple slightly different implementations across API and station-history code.

Do not create a broad date utility refactor.

### Station-history on-the-fly filtering

Correct `calculateAqiRows` output filtering so represented interval requests select:

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
- actual start/end diagnostics where they currently imply forward coverage;
- latest R2 AQI coverage end so an endpoint `n` does not falsely claim coverage through `n + 1 hour`.

Gap ranges returned to consumers should describe represented missing intervals clearly.

### AQI History R2 API range selection

Correct row selection and day-partition enumeration for represented intervals:

- exclude endpoint `S`;
- include endpoint `E`;
- include the endpoint-day partition at midnight;
- keep `since_utc` semantics explicitly documented and consistent;
- preserve row limits, ordering and source coverage diagnostics;
- preserve R2 precedence;
- preserve bounded scan behaviour.

Where an internal parquet filter or Supabase query uses start-inclusive/end-exclusive mechanics, translate the represented interval deliberately rather than changing stored values.

### History chunks

Correct older AQI chunk boundaries so adjacent chunks:

- have no duplicated represented hour;
- have no omitted represented hour;
- remain newest-first by cursor and ascending within each returned chunk;
- end at or before the stable-head represented boundary;
- retain immutable/mutable cache classification.

Observation chunk semantics must remain unchanged unless a shared helper accidentally couples them. Keep observation timestamps separate from AQI endpoint semantics.

### Response contract finalization

After the website consumes the explicit endpoint:

- make `period_start_utc` the true start in the selected response contract;
- retain `period_end_utc` as the canonical endpoint;
- keep `timestamp_hour_utc` where useful for internal/debug compatibility;
- remove or deprecate any temporary ambiguous alias according to the Phase 0 compatibility decision;
- version cache keys or response markers if required so old cached rows are not interpreted under new semantics.

### Prune Daily and R2

Verify the writer already stores correct endpoint rows and endpoint-day partitions.

Do not change stored data unless Phase 0 found an active writer path that actually shifts or labels timestamps incorrectly before storage.

Update only focused tests/comments/manifests needed to protect the endpoint role.

### Focused checks

Before deployment, run only narrow deterministic checks for:

- `S < n <= E` endpoint selection;
- 23 preceding PM context hours plus current endpoint;
- no duplicate or missing endpoint across adjacent chunks;
- midnight endpoint included from the new endpoint-day partition;
- gap interval for one missing endpoint;
- R2/live overlap still retains R2;
- API compact/object response field consistency.

Do not run broad integration suites before deployment.

## Phase 3 acceptance

- represented range requests return exactly the required endpoint rows;
- the final endpoint is included;
- the initial pre-range endpoint is excluded;
- midnight requests include the proper endpoint-day partition;
- gap and completeness reporting matches represented intervals;
- adjacent chunks are continuous without duplication;
- stored R2 timestamps remain unchanged;
- R2/live precedence remains unchanged.

## Codex prompt for Phase 3

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 3 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops.

Prerequisites:
- Phase 1 explicit endpoint contract is deployed on TEST
- Phase 2 website supports period_end_utc and renders (n-1h,n]

Read the full plan and all system_docs/aqi-levels documents first.

Goal:
Correct all active ops AQI range selection, expected endpoint, gap, coverage and history chunk semantics to use represented interval S..E => endpoints S < n <= E.

Review and update active code in:
- lib/aqi/aqi_levels.mjs only where output filtering/helpers belong
- workers/uk_aq_station_history/
- workers/uk_aq_aqi_history_r2_api_worker/
- focused tests and worker READMEs
- Prune Daily/R2 writer comments or focused assertions only where needed to protect endpoint meaning
- cache proxy only if final response marker/cache versioning requires it

Requirements:
- centralize narrow endpoint helpers rather than duplicate off-by-one logic
- retain 23 preceding PM endpoint hours for 24-hour DAQI context
- select output endpoints with start < n <= end
- fix expected endpoints and missing AQI interval reporting
- fix stable-head and older-chunk completeness
- ensure adjacent AQI chunks neither duplicate nor omit a represented hour
- include midnight endpoint E from E's endpoint-day R2 partition
- stop claiming coverage to n+1h from a row ending at n
- make period_start_utc a true start in the finalized contract
- retain period_end_utc as endpoint
- preserve R2-over-live precedence, scan budgets, partial behaviour and observation semantics

Do not:
- shift or rewrite stored R2 timestamps
- change breakpoint/calculation formulas
- change raw observations
- reactivate daily/monthly roll-ups
- modify observation range semantics unless required to prevent accidental coupling
- broaden scans when indexes are missing
- refactor unrelated time utilities

Before implementation, validate structural viability only. Run narrow checks for:
- endpoint selection boundaries
- PM context
- midnight partition
- one missing endpoint gap
- adjacent chunk continuity
- R2/live precedence
- compact/object field consistency

Do not run broad suites or external functional tests. Deploy to TEST for functional validation.

Return:
1. changed files;
2. endpoint helper and range translation design;
3. exact old/new boundary behaviour;
4. focused checks run;
5. TEST deployment and validation sequence;
6. anything deliberately unchanged in Prune Daily/R2.
```

---

# Phase 4: TEST deployment and functional validation

## Objective

Validate the coordinated correction through real TEST operations rather than expanding pre-deployment test coverage.

## Deployment order

Use the compatibility strategy confirmed in Phase 0. The expected safe order is:

1. deploy Phase 1 ops additive endpoint contract;
2. verify old website remains functional;
3. deploy Phase 2 website endpoint-aware loader and renderers;
4. verify it works with the additive Phase 1 response;
5. deploy Phase 3 finalized ops range and period-start semantics;
6. allow normal cache expiry or deliberately version only affected cache entries;
7. validate recent and historical chart paths;
8. allow the next normal Prune Daily operation to validate closed historical output.

Do not combine all repositories into one unobservable deployment unless Phase 0 proves there is an atomic deployment mechanism.

## Required real TEST checks

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
- the response reports the corresponding gap and is not cached as complete.

### PM incomplete DAQI

Use a recent PM range with fewer than 24 rolling hours where available.

Confirm:

- DAQI is null with `insufficient_samples`;
- European AQI remains present when the hourly mean is valid;
- the European AQI band uses the correct hour-ending interval.

### R2/live seam

Use a range spanning committed R2 and recent live-calculated AQI.

Confirm:

- there is no omitted or duplicated hour at the seam;
- R2 wins in overlap;
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

- is returned;
- comes from the `00:00` endpoint day partition where R2 history is used;
- colours `23:00` to `00:00`;
- is not assigned to `00:00` to `01:00`;
- is not omitted from the end of the preceding represented day.

### Prune Daily closed history

After normal Prune Daily processing:

- inspect a newly closed AQI day;
- confirm data/debug row keys align;
- confirm endpoint-day manifest and indexes include the expected midnight row;
- compare one endpoint with the same endpoint previously calculated live;
- confirm levels, statuses and interval meaning match;
- confirm no daily/monthly roll-up refresh occurred.

### Compatibility and unrelated behaviour

Confirm:

- observation lines, tooltips and units remain correct;
- DAQI and European AQI colours and legends remain unchanged;
- station search, chart range controls and older-history loading still work;
- partial responses remain non-cacheable;
- private Worker routes remain private;
- no new errors appear in Worker, cache-proxy or browser logs.

## Rollback

If Phase 1 causes compatibility issues, roll back the additive ops deployment only. Stored data is unaffected.

If Phase 2 causes rendering issues, roll back the website while retaining the additive endpoint fields in ops.

If Phase 3 causes range or completeness issues, roll back the finalized ops range change while the website continues using the explicit endpoint from Phase 1.

Do not roll back by rewriting R2 timestamps.

Keep each phase deployable and reversible independently.

## Phase 4 acceptance

The correction is complete only when all acceptance criteria in `system_docs/aqi-levels/validation.md` pass through the real TEST system.

## Codex prompt for Phase 4 review

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Perform the Phase 4 post-deployment review for the AQI Display correction on TEST.

Do not make code changes initially. Use the deployed TEST services, real API responses, normal Prune Daily output and both website chart implementations.

Read:
- the complete plan
- system_docs/aqi-levels/validation.md
- deployment notes from Phases 1-3

Validate:
1. one endpoint n draws only n-1h to n in both charts;
2. no colour extends beyond the final concentration endpoint;
3. a missing endpoint leaves one blank represented hour;
4. PM DAQI can be insufficient while European AQI remains visible;
5. R2/live seam has no omission or duplicate and R2 wins overlap;
6. older chunks extend backwards without replacing stable head;
7. midnight endpoint 00:00 is returned from the endpoint-day partition and colours 23:00-00:00;
8. newly closed Prune Daily data/debug rows and indexes preserve the same endpoint semantics;
9. partial responses remain partial/non-cacheable;
10. unrelated observations, colours, legends, tooltips, range controls and private routing remain unchanged;
11. daily/monthly roll-ups remain inactive.

Capture exact request ranges, endpoint timestamps, source modes, completeness fields and bounded screenshots/log excerpts needed to support each conclusion. Do not expose secrets.

If a defect is found, classify it as:
- API projection
- endpoint selection
- gap/completeness
- chunk boundary
- R2 partition/index
- live calculation context
- website normalization
- renderer geometry
- cache compatibility

Recommend the narrowest rollback or correction. Do not rewrite R2 timestamps and do not broaden the scope without evidence.

Return a pass/fail table against the documented acceptance criteria and any precise follow-up changes required.
```

---

# Phase 5: remove temporary compatibility code and close documentation

## Objective

Remove only temporary transition code that is no longer needed after the finalized contract has operated successfully on TEST.

This phase is optional and must not happen merely for tidiness.

## Preconditions

- Phase 4 acceptance criteria pass;
- caches carrying the ambiguous old response have expired or are isolated by contract version;
- no active website consumer depends on the ambiguous field meaning;
- logs show no old-contract requests during a reasonable TEST observation period;
- rollback evidence is retained.

## Allowed cleanup

- remove temporary fallback that treats ambiguous `period_start_utc` as an endpoint;
- remove a temporary response alias only where the compatibility decision explicitly permits it;
- simplify tests to the finalized contract;
- update Worker READMEs and system docs to mark implementation discrepancies resolved;
- record the deployed response contract and completion date.

## Prohibited cleanup

- removing `period_end_utc`;
- removing canonical endpoint information;
- deleting old R2 history;
- changing cache, route or auth behaviour unrelated to the transition;
- activating daily/monthly roll-ups;
- broad refactoring.

## Codex prompt for Phase 5

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Review whether Phase 5 cleanup is justified for the AQI Display correction.

Read the full plan, Phase 4 validation report and all system_docs/aqi-levels files.

First determine whether every precondition is proven:
- finalized contract has passed TEST validation
- old ambiguous cached responses are expired or version-isolated
- no active consumer relies on ambiguous period_start_utc-as-endpoint behaviour
- no old-contract requests remain in relevant logs

If any precondition is not proven, do not edit code. Return what evidence is missing.

If all preconditions are proven, remove only temporary compatibility code and update focused documentation/tests to the final contract:
- period_start_utc is true start
- period_end_utc is endpoint
- represented range S..E uses S < n <= E

Do not remove period_end_utc or canonical endpoint information. Do not touch R2 data, calculations, inactive roll-ups, routes, auth, unrelated cache policy or unrelated website code.

Use only syntax/type checks and the smallest focused contract tests before deployment. Functional confirmation remains on TEST.

Return changed files, removed temporary behaviour, retained permanent compatibility fields and final TEST checks.
```

---

# Cross-phase change matrix

| Area | Expected change | Must not change |
|---|---|---|
| Shared AQI calculation | Endpoint-aware output filtering/helpers where required | Breakpoints, averaging formulas, 24-hour PM rule |
| AQI History R2 API | Explicit start/end fields, endpoint-aware ranges and partitions | Stored timestamps, R2 precedence, scan budgets |
| Station-history Worker | Endpoint-aware normalization, gaps, coverage and chunks | Private routing, observation semantics, source precedence |
| Prune Daily | Protect/document endpoint role; only fix active mislabelling if found | Historical timestamps, deletion gate, schedules, roll-ups |
| R2 indexes/manifests | Include correct endpoint-day reads and unchanged canonical rows | Prefixes, hierarchy, deterministic byte stability |
| Cache proxy | Contract/cache versioning only if required | Route names, auth, CORS, unrelated TTLs |
| Website loader | Explicit period start/end, endpoint-keyed merge | Stable-head precedence, observation merge |
| Hex map chart | Draw `[n-1h,n]` | Colours, legend, tooltip, observation line |
| Sensors chart | Draw `[n-1h,n]` | Colours, legend, tooltip, observation line |
| Schema | Clarifying comments/focused assertions only | Active schema, inactive roll-up activation |

# Overall completion criteria

The plan is complete only when:

1. every active AQI producer and consumer uses an unambiguous hour-ending endpoint;
2. represented interval requests select `S < n <= E`;
3. both website chart implementations draw `n - 1 hour` to `n`;
4. the final coloured edge aligns with the final valid concentration endpoint;
5. missing hours remain blank;
6. midnight endpoint rows are included from the correct endpoint-day partition;
7. PM rolling context remains 24 endpoint hours;
8. European AQI remains independent of PM DAQI completeness;
9. R2 remains authoritative over live calculation;
10. chunks have no omitted or duplicated represented hours;
11. partial responses remain explicit and appropriately non-cacheable;
12. data/debug history, manifests and indexes remain internally consistent;
13. no stored AQI timestamps are shifted or rewritten;
14. daily and monthly roll-ups remain inactive;
15. unrelated website and API behaviour is retained;
16. all functional acceptance checks pass through the real TEST system.