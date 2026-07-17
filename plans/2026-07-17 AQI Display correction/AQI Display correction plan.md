# AQI display correction plan

- Date: 17 July 2026
- Status: Proposed, with Phase 0 inventory completed
- Primary repository: `TEST-uk-aq/uk-aq-ops`
- Website repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`
- Authoritative system documentation: `system_docs/aqi-levels/`
- R2 history scope: v2 only
- Intended TEST station-history routing: enabled for station series, AQI history and observations history

## Purpose

Correct AQI period handling everywhere it affects the displayed UK DAQI and European AQI bands in the active R2 v2 path, while preserving calculation formulas, stored R2 v2 timestamps, source precedence, completeness behaviour, history integrity and unrelated website behaviour.

The canonical time contract is:

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

## Route-name clarification

`/v1/aqi-history` is the HTTP API route and contract version. It is not R2 history v1.

Retaining that route does not bring R2 history v1 into scope. The route must not be renamed as part of this work.

## R2 v2-only scope

This correction applies only to the active R2 history v2 read, response, station-history and website consumer paths.

The implementation must:

- inspect and amend only the active v2 path where required;
- leave R2 v1 code, objects, tests and compatibility behaviour unchanged;
- avoid adding v1 support or repairing equivalent v1 defects;
- stop and report a configuration mismatch if deployed TEST evidence shows that the exercised path is not using v2.

R2 v1 is retiring and is explicitly out of scope.

## Intended TEST routing

The intended TEST repository variables are:

```text
UK_AQ_STATION_HISTORY_STATION_SERIES_ENABLED=true
UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true
UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED=true
UK_AQ_STATION_HISTORY_WORKER_NAME=uk-aq-station-history-test
```

`UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true` makes progressive older AQI-history chunks pass through the private station-history Worker before that Worker calls the AQI History R2 API.

The station-history AQI route is therefore an intended active TEST path and its corrections are mandatory in this plan. They must not be treated as optional or dormant.

The variable may be enabled before implementation because this is TEST. Functional correctness is established after the implementation is deployed through real TEST requests.

## R2 v2 data is not expected to change

Stored v2 AQI rows already use `timestamp_hour_utc` as the canonical hour-ending endpoint.

This plan does not expect or permit changes to:

- v2 AQI parquet rows;
- `history/v2/aqilevels/hourly/data` objects;
- `history/v2/aqilevels/hourly/debug` objects;
- day, connector or pollutant manifests;
- v2 timeseries indexes;
- v2 timeseries metadata;
- R2 prefixes;
- Prune Daily AQI calculation or write behaviour;
- backfill or history-repair tools;
- raw observation history;
- database schema;
- inactive daily or monthly AQI roll-ups.

No R2 v2 rebuild, rewrite, migration or reindex is required.

The v2 API read layer may change its response projection, filtering and partition selection. Those are read-contract changes, not changes to stored R2 v2 data.

If implementation evidence shows that stored v2 rows themselves are shifted, stop and report the evidence. Do not expand this plan into a history rewrite.

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

Every implementation phase must compare its final diff against the mandatory functionality in these documents and report pass or fail compliance.

## Confirmed current defects

### Website renderers

Both active station-chart renderers currently treat endpoint `n` as the start of the coloured rectangle and draw to `n + 1 hour`.

Affected files:

- `hex_map/index.html`;
- `sensors/index.html`.

This extends the final AQI colour beyond the final plotted concentration timestamp.

### Website loader and direct parsers

`station-history-loader.js` currently normalises one ambiguous `date` from fields including `period_start_utc` and `timestamp_hour_utc`.

It does not retain explicit period start and end boundaries.

Both active HTML pages also contain direct AQI payload parsing that must be corrected independently of the shared loader:

- `hex_map/index.html`;
- `sensors/index.html`.

Every active parser must use this endpoint priority during the compatibility transition:

1. `period_end_utc`;
2. `timestamp_hour_utc`;
3. legacy `period_start_utc` only as a temporary fallback for the old ambiguous response.

Compact-array decoding must remain aligned with response `columns` metadata.

### Hex-map AQI carry-forward

The hex-map chart currently carries DAQI or European AQI forward across missing endpoint hours.

This violates the no-fill rule. A missing endpoint must leave the represented hour blank.

The correction must be limited to AQI band handling. Unrelated concentration-series behaviour must remain unchanged.

### v2 AQI History R2 API

`workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` reads canonical v2 `timestamp_hour_utc` endpoints but exposes the same value as `period_start_utc`.

The worker also uses start-inclusive, end-exclusive assumptions in affected row filtering, expected-hour generation, recent-row handling, gap calculations and day-partition selection.

At midnight it can omit the partition containing endpoint `E`.

### Station-history stable head and chunks

The intended active station-history path applies start-labelled semantics in:

- `workers/uk_aq_station_history/src/stable_head.mjs`;
- `workers/uk_aq_station_history/src/index.mjs`;
- `workers/uk_aq_station_history/src/history_chunks.mjs`.

Known consequences include:

- first endpoint boundary selected incorrectly;
- final endpoint omitted;
- expected endpoint and missing-range logic incorrect;
- stable-head and older-chunk completeness incorrect;
- adjacent chunks vulnerable to omission or duplication;
- endpoint coverage sometimes described as extending to `n + 1 hour`;
- an already hour-ending R2 endpoint may be advanced by another hour;
- history chunks relabel endpoint values as `period_start_utc`.

### Cache contract ambiguity

Changing `period_start_utc` from an endpoint alias to a true period start changes the meaning of cached rows.

A corrected response-contract marker and coordinated cache identity are mandatory. Old ambiguous cached responses must not be interpreted under the corrected contract.

The exact cache path includes:

- `workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs`;
- `workers/uk_aq_cache_proxy/src/index.ts` where required to apply the marker or key.

Use the explicit marker:

```text
aqi_hour_interval_v2
```

An equivalent existing repository naming convention may be used only when clearly established and documented.

## Mandatory retained functionality

The work must retain all of the following:

- supported pollutants remain `pm25`, `pm10` and `no2`;
- DAQI PM remains a rolling 24-hour mean ending at `n`;
- DAQI NO2 remains an hourly mean ending at `n`;
- European AQI remains an hourly mean ending at `n`;
- breakpoint values and inclusive upper-bound behaviour remain unchanged;
- PM DAQI still requires 24 endpoint hours: `n-23h` through `n`;
- European AQI remains independently available when PM DAQI is `insufficient_samples`;
- negative and non-finite observation values remain excluded from AQI calculation but retained in raw observation history;
- committed R2 v2 AQI remains authoritative over live calculation for the same endpoint;
- older history chunks extend backwards only and must not replace the stable head;
- AQI and observation completeness remain independent;
- missing AQI hours remain blank;
- incomplete and gap-bearing responses remain explicitly partial and non-cacheable where required;
- v2 data and debug profiles remain aligned and unchanged;
- v2 manifest and index hierarchy remains unchanged;
- stored `timestamp_hour_utc` values and parquet row identities remain unchanged;
- station-history remains private behind the cache-proxy Service Binding;
- unrelated map, sensor-list, concentration-chart, authentication and cache behaviour remains unchanged;
- daily and monthly roll-ups remain inactive;
- v1 remains untouched and out of scope.

## Explicit non-goals

This plan must not:

- modify any R2 v1 code path, object, test or compatibility contract;
- rewrite or shift historical R2 v2 AQI timestamps;
- rebuild or reindex R2 v2 history;
- change R2 v2 parquet, manifests, indexes or metadata;
- change Prune Daily AQI calculation or write behaviour;
- change AQI breakpoint tables;
- change pollutant support;
- modify raw observation history;
- modify database schema;
- reactivate daily or monthly roll-ups;
- interpolate or forward-fill missing AQI hours;
- create a second public AQI calculation path;
- replace R2 precedence with last-write-wins merging;
- broaden R2 scans when required v2 indexes are missing;
- rename public routes;
- change authentication, CORS, Service Binding privacy or unrelated TTLs;
- refactor unrelated website or Worker code;
- create a broad speculative pre-deployment test suite.

## Expected implementation boundary

### Ops repository

Expected implementation targets:

- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`;
- focused existing tests or fixtures for that Worker;
- `workers/uk_aq_aqi_history_r2_api_worker/README.md`;
- `workers/uk_aq_station_history/src/stable_head.mjs`;
- `workers/uk_aq_station_history/src/index.mjs`;
- `workers/uk_aq_station_history/src/history_chunks.mjs`;
- narrowly related station-history helpers and existing focused fixtures;
- `workers/uk_aq_station_history/README.md`;
- `workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs`;
- `workers/uk_aq_cache_proxy/src/index.ts` only where required to apply the response marker or cache identity;
- `.github/workflows/uk_aq_cache_proxy_deploy.yml` only if structurally required to carry an existing variable or contract marker.

Review-only and expected unchanged:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- `lib/aqi/aqi_levels.mjs`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- all R2 v2 writer and storage code;
- schema repository.

### Website repository

Expected implementation targets:

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`;
- narrowly related existing tests or fixtures;
- directly related browser or local cache-shape markers only when required.

The root `index.html` AQI placeholder is not an active renderer and remains out of scope.

## Structural validation and functional validation

Before implementation, validate only that the proposed response fields, compact columns, cache marker, cache-key transition, Worker bindings and deployment order are structurally viable.

During implementation, syntax and type checks may be used to show that changed files are structurally valid. Do not substitute a speculative or broad pre-deployment functional suite for real TEST operation.

Functional testing happens after deployment through real TEST API requests, browser operation and Worker diagnostics.

## Compatibility-safe deployment strategy

Use this sequence:

1. confirm repository and workflow inputs structurally select R2 v2;
2. add `period_end_utc` and retain `timestamp_hour_utc` as the canonical endpoint;
3. add the `aqi_hour_interval_v2` response marker and versioned affected cache identity;
4. update `station-history-loader.js` and both direct HTML parsers to prefer the explicit endpoint;
5. update both renderers to draw `n - 1 hour` to `n`;
6. remove hex-map AQI carry-forward;
7. correct true `period_start_utc`, v2 range selection, gaps, stable-head coverage, chunk boundaries and endpoint-day partition selection;
8. deploy the coordinated changes to TEST in observable stages;
9. validate through the real enabled station-history AQI route;
10. remove only temporary legacy fallback proven unnecessary.

Do not silently change the meaning of `period_start_utc` before every active consumer uses the explicit endpoint and affected caches are version-isolated.

---

# Phase 0: completed inventory and structural configuration evidence

## Status

Completed as a read-only source and workflow inventory.

No code, configuration, R2 object or deployed service was changed by the inventory.

## Structural findings

Repository and workflow inputs select R2 v2 and identify:

- AQI History R2 API Worker: `uk-aq-aqi-history-r2-api`;
- cache Worker: `uk-aq-cache-test`;
- station-history Worker: `uk-aq-station-history-test`;
- public AQI route through the cache proxy;
- private station-history Service Binding;
- v2 data, index and binding prefixes;
- required v2 timeseries index behaviour.

The intended TEST routing variables are all true for station series, AQI history and observations history after the user adds `UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true` and redeploys the cache proxy.

## Limits of Phase 0 evidence

Phase 0 established structural viability from repository and workflow inputs. It did not prove the values present inside the already deployed Cloudflare Workers.

Live runtime confirmation belongs to Phase 4 and must show:

- the AQI-history flag reached the deployed cache Worker;
- a progressive older AQI request passed through `uk-aq-station-history-test`;
- that Worker called the AQI History R2 API;
- the returned response used the R2 v2 path.

## Confirmed change inventory

Ops:

- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`;
- `workers/uk_aq_station_history/src/stable_head.mjs`;
- `workers/uk_aq_station_history/src/index.mjs`;
- `workers/uk_aq_station_history/src/history_chunks.mjs`;
- `workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs`;
- `workers/uk_aq_cache_proxy/src/index.ts` where required;
- relevant Worker READMEs and existing focused fixtures.

Website:

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`;
- related existing fixtures and cache-shape markers where required.

Review-only:

- Prune Daily;
- shared AQI calculation;
- v2 writers, parquet, manifests, indexes and metadata;
- schema.

Phase 0 must not be repeated unless configuration or topology changes materially before implementation.

---

# Phase 1: add the explicit v2 endpoint and cache contract

## Objective

Remove timestamp ambiguity from v2 AQI responses without changing stored R2 v2 data and without immediately requiring all consumers to reinterpret the old `period_start_utc` field.

## Required implementation

### AQI History R2 API Worker

In the active v2 path of `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`:

- retain `timestamp_hour_utc` as the canonical endpoint;
- add `period_end_utc = timestamp_hour_utc`;
- add the response-contract marker `aqi_hour_interval_v2`;
- keep compact `columns`, compact `points`, object responses and retained TSV output consistent;
- preserve source diagnostics, coverage, partial responses, ordering, row limits, required-index and bounded-scan behaviour;
- avoid changing the meaning of the old field until the compatibility sequence makes that safe;
- guard any shared helper so v1 remains unchanged.

### Station-history Worker

In the intended active path:

- normalise incoming v2 R2 rows around the explicit endpoint;
- retain canonical endpoint information on all R2 and live-calculated AQI rows;
- make the stable-head and history-chunk response shapes carry the same explicit endpoint fields;
- preserve R2-over-live precedence, mismatch diagnostics and AQI/observation independence;
- preserve `/v1/station-series`, `/v1/aqi-history` and private Service Binding architecture.

Expected files include:

- `workers/uk_aq_station_history/src/stable_head.mjs`;
- `workers/uk_aq_station_history/src/index.mjs`;
- `workers/uk_aq_station_history/src/history_chunks.mjs`.

### Cache proxy

Make the cache-contract transition mandatory:

- add the corrected AQI interval marker to affected cache identity;
- ensure old ambiguous responses cannot collide with corrected responses;
- update `workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs`;
- update `workers/uk_aq_cache_proxy/src/index.ts` where needed to apply or expose the marker;
- preserve public route names, authentication, CORS, stale fallback and unrelated TTLs.

Browser cache versioning remains conditional only when the stored browser timestamp is proven to remain an unambiguous canonical endpoint. Document that decision.

### Documentation

Update the two Worker READMEs to describe:

- endpoint meaning;
- response marker;
- compatibility sequence;
- `/v1/aqi-history` as an HTTP route version rather than R2 v1;
- unchanged R2 v2 storage.

## Pre-deployment structural validation

Only verify:

- changed JavaScript or TypeScript parses or type-checks;
- compact `columns` structurally match compact points;
- object fields and response marker are present in the intended v2 branch;
- cache keys include the new contract component;
- shared code changes are guarded away from v1.

Do not run broad functional or external-service tests before deployment.

## Phase 1 acceptance

- v2 responses expose an explicit endpoint;
- the corrected contract has an explicit marker;
- affected cache identity is version-isolated;
- station-history and direct AQI API shapes agree;
- old website compatibility is retained for the deployment transition;
- R2 v2 storage, writers, manifests, indexes and metadata are unchanged;
- v1 is unchanged;
- system-document compliance is reported.

## Codex prompt for Phase 1

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 1 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops.

Read the complete plan and every file under system_docs/aqi-levels/ first.

Scope:
- active R2 AQI history v2 only
- the intended TEST station-history AQI route is active and mandatory
- R2 v1 remains untouched
- R2 v2 storage, writers, parquet, manifests, indexes, metadata, prefixes and schema remain unchanged

Required contract:
- timestamp_hour_utc=n is the canonical endpoint
- period_end_utc=n
- represented interval is (n-1h,n]
- add response marker aqi_hour_interval_v2

Update:
- workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
- relevant focused existing fixtures and README
- workers/uk_aq_station_history/src/stable_head.mjs
- workers/uk_aq_station_history/src/index.mjs
- workers/uk_aq_station_history/src/history_chunks.mjs
- workers/uk_aq_station_history/README.md
- workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs
- workers/uk_aq_cache_proxy/src/index.ts only where needed to apply the marker or key

Make compact and object responses consistent. Preserve retained TSV behaviour where active. Version affected cache identity so old ambiguous rows cannot be interpreted under the corrected contract.

Do not change calculations, source precedence, partial-response rules, scan budgets, required-index behaviour, routes, auth, CORS, unrelated TTLs, observations, Prune Daily, R2 data or v1.

Before implementation, validate structural viability only. After implementation, run only syntax or type checks and inspect the resulting response and cache shapes. Functional testing happens after deployment on TEST.

Compare the final diff against every mandatory document under system_docs/aqi-levels/ and report pass or fail compliance.

Return changed files, compatibility strategy, cache marker and key change, structural checks, confirmation that v1 and R2 v2 storage are unchanged, system-doc compliance and deployment notes.
```

---

# Phase 2: correct the website loader, direct parsers and both renderers

## Objective

Make every active website AQI consumer use the explicit endpoint and draw DAQI and European AQI over the correct represented hour.

## Required implementation

### Shared loader

In `station-history-loader.js`:

- normalise every AQI row into explicit period start and period end values;
- use endpoint priority:
  1. `period_end_utc`;
  2. `timestamp_hour_utc`;
  3. temporary legacy `period_start_utc` fallback;
- key AQI identity and merges by the canonical endpoint;
- preserve valid European AQI when DAQI is null;
- preserve older-chunk no-replacement of the stable head;
- correct authoritative-head replacement boundaries using represented intervals;
- preserve observation merging and coverage state;
- retain the legacy fallback only for the compatibility window.

### Direct parser in `hex_map/index.html`

Correct the direct AQI payload parser as well as the renderer:

- use the same endpoint priority as the shared loader;
- decode compact arrays from the supplied `columns` metadata;
- do not assume a fixed compact-column position after the contract changes;
- retain explicit start and end values.

### Direct parser in `sensors/index.html`

Apply the same parser rules:

- same endpoint priority;
- same compact-column handling;
- same explicit start and end representation.

### Hex-map renderer

In `hex_map/index.html`:

- draw endpoint `n` from `n - 1 hour` to `n`;
- clip the rectangle to the chart domain;
- do not draw an index rectangle when that index value is null;
- preserve DAQI and European AQI independently;
- remove AQI carry-forward across missing endpoints;
- leave each missing represented hour blank;
- ensure the final coloured edge ends at the final endpoint;
- preserve the intentionally selected DAQI colour ordering;
- preserve legends, tooltips, range controls and concentration rendering.

The no-fill change applies only to AQI bands. Do not alter unrelated concentration-series behaviour.

### Sensors renderer

In `sensors/index.html`:

- apply the same `n - 1 hour` to `n` geometry;
- apply the same clipping and missing-hour behaviour;
- preserve independent DAQI and European AQI rows;
- correct older/head boundary checks so endpoint ownership follows `S < n <= E`;
- preserve unrelated chart and page behaviour.

### Browser and local caches

Review serialised AQI state:

- version or invalidate only affected state that would otherwise reinterpret old ambiguous timestamps;
- do not clear unrelated state;
- keep endpoint identity unambiguous;
- do not introduce permanent dual semantics.

## Pre-deployment structural validation

Only verify:

- changed JavaScript parses;
- all three parsers use the documented endpoint priority;
- compact decoding follows `columns`;
- both renderers derive start as endpoint minus one hour;
- no-fill code path does not carry AQI into a missing endpoint;
- cache shape is structurally isolated where changed.

Functional visual validation occurs after deployment on TEST.

## Phase 2 acceptance

- both charts derive `06:00` to `07:00` from endpoint `07:00`;
- neither chart draws `07:00` to `08:00` from that row;
- the final coloured edge aligns with the final endpoint;
- a missing endpoint leaves a blank represented hour;
- valid European AQI remains visible when DAQI is null;
- both direct parsers and the shared loader agree;
- older chunks cannot replace the stable head;
- observation-chart behaviour is unchanged;
- no v1-specific behaviour is added;
- system-document compliance is reported.

## Codex prompt for Phase 2

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 2 of the AQI Display correction plan in TEST-uk-aq/TEST-uk-aq-root.github.io.

Read:
- the complete plan in TEST-uk-aq/uk-aq-ops
- every file under uk-aq-ops/system_docs/aqi-levels/
- the deployed Phase 1 response and cache contract

Scope:
- active R2 v2 station-history website path only
- v1 is out of scope

Update:
- station-history-loader.js
- hex_map/index.html
- sensors/index.html
- only narrowly related existing fixtures and affected cache-shape markers

Every parser, including the direct parsers in both HTML pages, must use:
1. period_end_utc
2. timestamp_hour_utc
3. temporary legacy period_start_utc fallback

Decode compact arrays from response columns metadata.

Render endpoint n from n-1h to n in both charts. Clip to the chart range. Preserve DAQI and European AQI independently. Remove AQI carry-forward in the hex-map chart so a missing endpoint remains blank. Do not alter unrelated concentration-series behaviour.

Preserve website colours, legends, tooltips, controls, observation rendering and stable-head precedence.

Do not change AQI calculations, APIs, R2 data, v1 or unrelated layout.

Before implementation, validate structural viability only. After implementation, run JavaScript syntax checks and inspect parser, renderer and cache shapes. Functional testing happens after deployment through the real TEST website.

Compare the final diff against applicable mandatory requirements in system_docs/aqi-levels/ and report pass or fail compliance.

Return changed files, old and new normalisation, direct-parser changes, no-fill change, cache decision, structural checks, system-doc compliance and TEST deployment notes.
```

---

# Phase 3: correct v2 endpoint selection, gaps, coverage and chunks

## Objective

Correct the active v2 range semantics so the right endpoint rows are returned and described, not merely drawn differently.

This phase follows deployment of the explicit endpoint-aware website.

## Required implementation

### Narrow endpoint helpers

Create or centralise narrowly scoped v2 helpers for:

- canonical endpoint parsing;
- true start derivation;
- endpoint selection predicate `S < n <= E`;
- expected endpoint generation;
- represented missing-interval generation;
- translation to any source query that internally requires inclusive-start or exclusive-end mechanics.

Avoid a broad date utility refactor. Do not modify v1 helpers.

### AQI History R2 API

Correct the active v2 path in `worker.mjs`:

- exclude endpoint `S`;
- include endpoint `E`;
- include the endpoint-day partition when `E` is midnight;
- correct recent or live-row filtering to the same endpoint contract;
- correct expected endpoint and gap calculations;
- document and retain deliberate `since_utc` semantics;
- retain ordering, row limits, diagnostics, R2 precedence, scan budgets and required-index behaviour;
- make `period_start_utc = period_end_utc - 1 hour` in the final corrected contract;
- retain `period_end_utc` and `timestamp_hour_utc`.

### Station-history stable head

Correct:

- canonical expected endpoints;
- AQI output filtering;
- PM context retention of the 23 preceding endpoints plus `n`;
- stable-head completeness;
- R2/live merge boundaries;
- source coverage diagnostics;
- latest R2 coverage end so endpoint `n` does not claim coverage to `n + 1 hour`.

### Older AQI chunks

Correct `history_chunks.mjs` so:

- requested represented range uses `S < n <= E`;
- adjacent chunks omit no represented hour;
- adjacent chunks duplicate no represented hour;
- rows are ascending within a chunk;
- cursors extend backwards only;
- older chunks do not replace stable-head rows;
- mutable and immutable classifications remain;
- missing endpoint intervals and partial reasons are accurate;
- observation chunk semantics remain unchanged.

### Cache finalisation

Keep the mandatory `aqi_hour_interval_v2` contract and cache identity.

Remove or deprecate only temporary ambiguous aliases that the Phase 1 and Phase 2 rollout no longer requires.

Do not merge corrected responses into old cache identity.

## Pre-deployment structural validation

Only verify:

- endpoint helper predicates and loops encode `S < n <= E`;
- midnight enumeration includes `E`'s endpoint day;
- PM context count remains structurally 24 endpoints;
- chunk cursor equations are adjacent without overlap or omission;
- response fields and compact columns remain aligned;
- cache identity retains the corrected contract;
- v1 branches remain untouched.

Functional boundary and continuity testing happens after deployment on TEST.

## Phase 3 acceptance

- represented ranges return the exact required endpoint rows;
- final endpoint `E` is included;
- endpoint `S` is excluded;
- midnight endpoint is read from the endpoint-day partition;
- gap and completeness output describes represented intervals correctly;
- adjacent chunks have no omission or duplication;
- stable-head rows remain authoritative over older chunks;
- R2 v2 remains authoritative over live rows;
- stored R2 v2 data is unchanged;
- v1 is unchanged;
- system-document compliance is reported.

## Codex prompt for Phase 3

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Implement Phase 3 of plans/2026-07-17 AQI Display correction/AQI Display correction plan.md in TEST-uk-aq/uk-aq-ops.

Prerequisites:
- Phase 1 explicit endpoint and aqi_hour_interval_v2 cache contract are deployed
- Phase 2 website consumes period_end_utc and renders (n-1h,n]
- UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true is intended for TEST

Read the complete plan and every file under system_docs/aqi-levels/ first.

Scope:
- active R2 AQI history v2 API and station-history paths
- v1 remains untouched
- R2 v2 storage, writers, parquet, manifests, indexes, metadata, prefixes and schema remain unchanged

Update the affected v2 logic in:
- workers/uk_aq_aqi_history_r2_api_worker/worker.mjs
- workers/uk_aq_station_history/src/stable_head.mjs
- workers/uk_aq_station_history/src/index.mjs
- workers/uk_aq_station_history/src/history_chunks.mjs
- narrowly related v2 helpers, existing fixtures and READMEs
- cache files only where needed to retain the final aqi_hour_interval_v2 identity

Required semantics:
- timestamp_hour_utc=n
- period_end_utc=n
- period_start_utc=n-1h
- represented request S..E selects S < n <= E
- PM DAQI context uses n-23h through n
- midnight endpoint E is read from E's endpoint-day partition
- adjacent older AQI chunks neither omit nor duplicate a represented hour
- endpoint n never claims coverage after n

Preserve R2-over-live precedence, partial responses, scan budgets, required indexes, observations, routes, auth, CORS and unrelated TTLs.

Do not change v1, calculations, Prune Daily, R2 objects, manifests, indexes, metadata, schema or inactive roll-ups.

Before implementation, validate structural viability only. After implementation, run syntax or type checks and inspect boundary, chunk and response shapes. Functional testing happens after deployment on TEST.

Compare the final diff against every mandatory requirement in system_docs/aqi-levels/ and report pass or fail compliance.

Return changed files, helper and range design, old and new boundaries, cache finalisation, confirmation that v1 and R2 v2 storage are unchanged, structural checks, system-doc compliance and deployment sequence.
```

---

# Phase 4: TEST deployment and functional validation

## Objective

Validate the coordinated correction through real TEST operations, including the enabled station-history AQI route.

## Deployment order

1. ensure `UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true` exists as a repository variable;
2. deploy the cache proxy so the variable reaches the Worker;
3. deploy Phase 1 additive endpoint and cache contract;
4. confirm the old website remains functional;
5. deploy Phase 2 website parser and renderer changes;
6. confirm the website uses the explicit endpoint;
7. deploy Phase 3 final range, start, coverage and chunk semantics;
8. allow affected old caches to expire or rely on the mandatory version isolation;
9. exercise recent, stable-head and progressive older-history paths.

No Prune Daily deployment or R2 v2 data operation is required.

Keep deployments observable and independently reversible.

## Required runtime evidence

### Routing and v2 source

Record evidence that:

- the deployed cache Worker received `UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true`;
- a progressive older AQI request routed through `uk-aq-station-history-test`;
- the private station-history Worker called the AQI History R2 API;
- the response used R2 history v2;
- `/v1/aqi-history` remained private behind the Service Binding where intended.

Do not use v1 responses as acceptance evidence.

### Single endpoint geometry

In both chart implementations, confirm endpoint `n`:

- is associated with the concentration point at `n`;
- starts DAQI colour at `n - 1 hour`;
- ends DAQI colour at `n`;
- starts European AQI colour at `n - 1 hour`;
- ends European AQI colour at `n`;
- produces no colour after `n`.

### Range boundaries

For a represented request `S` to `E`, confirm:

- endpoint `S` is excluded;
- the first returned endpoint colours the first represented hour;
- endpoint `E` is included;
- no row claims coverage beyond `E`.

### Midnight endpoint

Use a range ending or crossing UTC midnight.

Confirm endpoint `00:00`:

- is returned;
- comes from the endpoint-day v2 partition where R2 is used;
- colours `23:00` to `00:00`;
- does not colour `00:00` to `01:00`.

### Missing endpoint and no-fill

Use a real range with a missing AQI endpoint or a narrowly controlled TEST condition.

Confirm:

- the represented missing hour is blank;
- the preceding AQI is not carried forward;
- a later AQI is not extended backwards;
- DAQI and European AQI remain independent;
- the response is partial and non-cacheable where required.

### PM incomplete DAQI

Confirm a recent PM case where fewer than 24 valid endpoint hours are available:

- DAQI is null with `insufficient_samples`;
- European AQI remains present when the hourly mean is valid;
- the European AQI band uses the correct represented hour.

### R2/live seam

Confirm:

- there is no omitted or duplicated represented hour;
- R2 v2 wins at overlapping endpoints;
- mismatch diagnostics remain visible;
- the seam does not extend the final endpoint forward.

### Progressive older chunks

Load at least two older AQI chunks and confirm:

- progressive requests use the station-history AQI route;
- chunks extend backwards only;
- boundary endpoints occur exactly once;
- stable-head rows are not replaced;
- visual continuity appears only where endpoint rows are continuous.

### Cache contract

Confirm:

- responses expose `aqi_hour_interval_v2`;
- cache diagnostics or keys show corrected contract isolation;
- old ambiguous responses are not served under the new interpretation;
- partial responses are not cached as complete;
- unrelated cache profiles and TTLs are unchanged.

### R2 v2 immutability

Use bounded evidence for affected dates and timeseries to confirm no rewrite of:

- v2 parquet objects;
- manifests;
- indexes;
- timeseries metadata;
- stored timestamps.

Also confirm:

- Prune Daily code, configuration and output behaviour are unchanged;
- shared AQI calculation code is unchanged;
- v1 code and deployment are unchanged.

A full bucket inventory is not required.

### Unrelated behaviour

Confirm:

- concentration lines, units and tooltips remain correct;
- DAQI and European AQI colours and legends remain unchanged;
- station search and range controls work;
- private routes remain private;
- no new Worker, cache-proxy or browser errors appear.

## Rollback

- Phase 1 issue: roll back the additive API, station-history and cache-contract deployment together.
- Phase 2 issue: roll back the website while retaining the additive explicit endpoint response.
- Phase 3 issue: roll back the final range and period-start changes while retaining Phase 1 fields.
- Routing issue: set `UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=false` and redeploy the cache proxy.

Never roll back by rewriting R2 timestamps or modifying v1.

## Phase 4 acceptance

The correction is complete only when:

- all applicable acceptance criteria in `system_docs/aqi-levels/validation.md` pass through real TEST v2 operation;
- progressive older AQI requests demonstrably use station-history;
- the corrected cache contract is isolated;
- bounded evidence confirms R2 v2 data and metadata are unchanged;
- v1 remains unchanged and is not used as acceptance evidence.

## Codex prompt for Phase 4 review

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Perform the Phase 4 post-deployment review for the AQI Display correction on TEST.

Read the complete plan, every file under system_docs/aqi-levels/ and deployment notes from Phases 1 to 3.

Do not change code initially. Use real TEST API requests, the website, Worker diagnostics and bounded R2 metadata evidence.

Validate:
1. UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true reached the deployed cache Worker.
2. A progressive older AQI request routes through uk-aq-station-history-test and then the AQI History R2 API.
3. Responses use R2 history v2 and expose aqi_hour_interval_v2.
4. Endpoint n renders only n-1h to n in both charts.
5. S < n <= E holds at first and final range boundaries.
6. Midnight endpoint 00:00 comes from the endpoint-day v2 partition and colours 23:00-00:00.
7. A missing endpoint remains blank with no AQI carry-forward.
8. DAQI and European AQI remain independent.
9. The R2 v2/live seam has no omission or duplication and R2 wins overlap.
10. At least two older AQI chunks extend backwards without replacing the stable head.
11. Partial responses remain partial and non-cacheable.
12. Old ambiguous cache identity cannot serve under the corrected contract.
13. Unrelated chart, route, auth, CORS and cache behaviour remains unchanged.
14. Bounded evidence confirms v2 parquet, manifests, indexes, metadata and stored timestamps were not rewritten.
15. Prune Daily, shared AQI calculation and v1 remain unchanged.
16. All mandatory system_docs/aqi-levels/ requirements pass.

Capture exact ranges, endpoints, source modes, headers, completeness fields and bounded screenshots or log excerpts. Do not expose secrets.

If a defect is found, classify it narrowly as API projection, endpoint selection, gap/completeness, stable head, chunk boundary, v2 partition read, live context, website normalisation, renderer geometry, no-fill, routing or cache compatibility.

Return pass or fail tables for acceptance and system-document compliance, evidence that R2 v2 data and v1 are unchanged, and any narrow follow-up required.
```

---

# Phase 5: optional compatibility cleanup

## Objective

Remove only temporary v2 transition code after the final contract has operated successfully on TEST.

This phase is optional and must not happen merely for tidiness.

## Preconditions

- Phase 4 passes;
- caches carrying old ambiguous responses have expired or are contract-isolated;
- no active website consumer relies on `period_start_utc` as an endpoint;
- relevant TEST logs show no old-contract use during a reasonable observation period;
- rollback evidence is retained.

## Allowed cleanup

- remove the temporary fallback that interprets legacy `period_start_utc` as an endpoint;
- remove a temporary response alias only where the compatibility decision permits it;
- retain `period_end_utc`, `timestamp_hour_utc` and `aqi_hour_interval_v2`;
- update focused documentation and existing fixtures;
- record the deployed contract and completion date.

## Prohibited cleanup

- removing canonical endpoint information;
- editing v1;
- deleting or rewriting R2 v2 history;
- changing manifests, indexes or metadata;
- changing unrelated cache, route or authentication behaviour;
- activating inactive roll-ups;
- broad refactoring.

## Codex prompt for Phase 5

**Recommended model: GPT-5.6 Codex, High reasoning.**

```text
Review whether Phase 5 cleanup is justified for the AQI Display correction.

Read the full plan, Phase 4 validation evidence and every file under system_docs/aqi-levels/.

Do not edit unless all preconditions are proven:
- the corrected v2 contract passed TEST validation
- old ambiguous caches are expired or version-isolated
- no active consumer relies on period_start_utc as an endpoint
- relevant logs show no old-contract use

If evidence is incomplete, report what is missing and make no changes.

If proven, remove only temporary v2 compatibility code. Retain:
- timestamp_hour_utc=n
- period_end_utc=n
- period_start_utc=n-1h
- aqi_hour_interval_v2
- S < n <= E

Do not edit v1 or touch R2 v2 data, writers, manifests, indexes, metadata, calculations, inactive roll-ups, routes, auth, unrelated cache policy or unrelated website code.

Use syntax or type checks only before deployment. Functional confirmation remains on TEST.

Compare the final diff against every mandatory system_docs/aqi-levels/ requirement and report pass or fail compliance.
```

---

# Cross-phase change matrix

| Area | Expected change | Must not change |
|---|---|---|
| v2 AQI History R2 API | Explicit endpoint fields, true start, response marker, endpoint-aware ranges and partitions | Stored R2 v2 rows, v1, precedence, scan budgets |
| Station-history Worker | Endpoint-aware normalisation, stable head, gaps, coverage and progressive AQI chunks | Private routing, observation semantics, source precedence |
| Cache proxy | Mandatory `aqi_hour_interval_v2` cache identity for affected AQI paths | Route names, auth, CORS, unrelated TTLs |
| Website loader | Explicit start/end and endpoint-keyed merge | Observation merge, stable-head precedence |
| Direct HTML parsers | Endpoint priority and columns-aware compact decoding | Unrelated page parsing |
| Hex-map chart | Draw `n-1h` to `n`; no AQI carry-forward | Colours, legend, tooltip, concentration series |
| Sensors chart | Draw `n-1h` to `n`; endpoint-aware head/chunk boundary | Colours, legend, tooltip, concentration series |
| Shared AQI calculation | Review only | Breakpoints, averaging formulas, 24-hour PM rule |
| Prune Daily | Review only | Code, configuration, schedules and output |
| R2 v2 parquet | No change | Rows, timestamps, hashes and partitions |
| R2 v2 manifests | No change | Hierarchy, bodies, hashes and etags |
| R2 v2 indexes and metadata | No change | Prefixes, bodies, hashes and etags |
| v1 | No change | All code, data, tests and deployment behaviour |
| Schema | No change | Tables, RPCs and inactive roll-ups |

# Overall completion criteria

The plan is complete only when:

1. TEST is confirmed at runtime to use R2 v2;
2. `UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED=true` is deployed;
3. progressive older AQI requests use the private station-history Worker;
4. every active AQI producer, wrapper, parser and renderer uses an unambiguous endpoint;
5. responses expose `aqi_hour_interval_v2`;
6. affected caches are isolated from old ambiguous rows;
7. represented requests select `S < n <= E`;
8. both charts draw `n - 1 hour` to `n`;
9. missing endpoint hours remain blank without AQI carry-forward;
10. the final coloured edge aligns with the final endpoint;
11. midnight endpoints are included from the endpoint-day partition;
12. PM rolling context remains 24 endpoint hours;
13. European AQI remains independent of PM DAQI completeness;
14. R2 v2 remains authoritative over live calculation;
15. stable-head rows are not replaced by older chunks;
16. adjacent chunks have no omitted or duplicated represented hours;
17. partial responses remain explicit and appropriately non-cacheable;
18. R2 v2 parquet, manifests, indexes, metadata and stored timestamps remain unchanged;
19. Prune Daily and the shared AQI calculation remain unchanged;
20. v1 remains unchanged and out of scope;
21. daily and monthly roll-ups remain inactive;
22. unrelated website, API, auth and cache behaviour is retained;
23. every phase reports pass or fail compliance with mandatory AQI system documentation;
24. all functional acceptance checks pass through real TEST operation.
