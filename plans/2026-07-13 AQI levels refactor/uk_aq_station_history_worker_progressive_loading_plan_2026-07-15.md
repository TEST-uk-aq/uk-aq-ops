# UK AQ station-history Worker and AQI-first progressive loading plan

**Date:** 15 July 2026  
**Status:** Implementation plan for TEST first  
**Primary implementation model:** GPT-5.6 Terra, High reasoning  
**Primary repositories:**

- Operations and Cloudflare Workers: `TEST-uk-aq/uk-aq-ops`
- Website: `TEST-uk-aq/TEST-uk-aq-root.github.io`

## 1. Purpose

Extract station time-series and AQI-history orchestration from the existing `uk-aq-cache-proxy` into a private Cloudflare Worker named:

```text
uk-aq-station-history
```

The existing cache proxy remains the public API gateway and continues to own:

- origin validation;
- CORS;
- Turnstile session creation;
- session-cookie validation;
- cache-bypass authorisation;
- local TEST development bypass;
- ordinary metadata and lookup routes;
- chart metrics;
- website debug-log uploads.

The new station-history Worker owns the data-specific work needed by station pages, charts, tables, downloads and other future website features:

- recent observations from the ingest database;
- live DAQI and EAQI calculation from those observations;
- recent authoritative AQI reconciliation with R2;
- historical AQI reads from R2;
- historical observation reads from R2;
- source-boundary decisions;
- source precedence;
- chunk contracts;
- completeness and gap diagnostics;
- data-specific cache-key construction;
- deliberate stale fallback behaviour.

The public website must continue to call the existing public gateway hostname. The new Worker is private and is reached through a Cloudflare Service Binding.

### Non-negotiable Hex Map compatibility requirements

These requirements clarify and override any earlier wording that could be read
as requiring recent-first or AQI-first loading to blank an already valid chart.
They preserve the established legacy-loader behaviour while the progressive
station-history path remains reversible.

#### A. Existing-chart continuity on time-range changes

This behaviour MUST remain equivalent to the existing legacy Hex Map chart.

Changing the chart time range must not clear or temporarily remove observations,
AQI bands, guideline lines or other already-rendered chart data.

When a valid chart frame already exists:

1. Immediately retain all currently rendered observations, DAQI and EAQI bands,
   guideline lines and other chart overlays.
2. Animate the existing x-axis from the old range to the new range.
3. Stretch or compress the existing line paths and AQI bands during that
   transition.
4. Immediately display any cached points that intersect the new range.
5. Fetch only intervals not already covered by the page-session cache.
6. Merge and render newly fetched AQI and observation data from newest to
   oldest.
7. Keep successful existing and newly loaded intervals visible when another
   interval fails.
8. Never blank the chart merely to guarantee that a newly fetched AQI response
   is the first network-derived layer.

“AQI first” applies to the order in which newly fetched layers are processed
for an initially empty chart. It must not override existing-chart continuity
during a window change.

Range contraction retains the complete page-session cache and displays only
the intersecting points. It must not delete older cached points or refetch a
shorter range that is already covered. Explicit Refresh may request a fresh
authoritative head, but visible history remains until that response is ready.

#### B. Independent DAQI and EAQI availability

DAQI and EAQI availability are independent. For PM2.5 and PM10, DAQI requires
rolling 24-hour context while EAQI uses the individual hourly concentration.
Incomplete rolling context may leave DAQI null with an
`insufficient_samples` status and missing reason, but must not suppress a valid
EAQI value for the same hour. The inverse legitimate state must also be
preserved. Each index retains its own value, calculation status and missing
reason, and overall response completeness remains truthful.

#### C. Partial chunk behaviour

A partial authoritative AQI or observation chunk contributes every valid,
identity-compatible, non-conflicting row. It remains partial and retryable,
does not seed a normal complete cache entry, leaves genuine missing intervals
visible, and cannot replace an already rendered stable-head AQI hour. A failure
in one interval does not remove successful existing or neighbouring intervals.

#### D. Covered-range cache semantics

Page-session coverage is represented as covered time intervals separately for
AQI and observations, with complete, partial, failed and stale state where
applicable. Exact chunk keys remain useful for retry identity, diagnostics,
in-flight deduplication and completed-request bookkeeping, but are not the sole
coverage representation. Interval subtraction determines missing work, so a
chunk-boundary change cannot refetch an already covered interval.

#### E. Bounded parallel progressive fetching

Historical progressive loading MUST use bounded parallel network fetching. It
must not issue every AQI or observation history request serially when multiple
independent chunks are required.

1. Fetch and render the newest missing chunk first.
2. After the newest missing chunk has settled, allow a small bounded number of
   older chunks to be fetched concurrently.
3. Preserve newest-to-oldest visible commit order even when network responses
   complete out of order.
4. A failed or partial newer chunk remains a visible, retryable gap but does
   not permanently prevent successful older chunks from being committed.
5. AQI and observation history streams remain independent and may fetch in
   parallel.
6. Observation history for separate selected sensors may fetch concurrently,
   subject to an overall bounded request limit.
7. Reuse the existing legacy queue and concurrency mechanisms where practical.
8. Do not introduce unbounded `Promise.all()` over every historical chunk.
9. Do not duplicate requests already covered by the page-session interval
   cache.
10. Preserve successful rows and intervals when another request fails.
11. Coalesce rapid successive chart updates so multiple responses do not cause
    unnecessary full redraws.
12. Performance improvements must not weaken stable-head AQI no-replacement,
    R2 source precedence, partial-chunk retry behaviour, cache completeness or
    newest-to-oldest visual extension.

#### F. Canonical hourly AQI identity

Every hourly AQI comparison, expected-hour calculation, missing-hour
calculation, gap calculation and merge key MUST use canonical UTC hour-start
timestamps.

1. Exact requested chart bounds may retain minutes, seconds and milliseconds.
2. AQI identities use UTC hour starts such as `2026-07-16T00:00:00.000Z`.
3. The first expected AQI hour is the first canonical hour start that falls
   inside the exact requested interval: use the exact start when it is already
   hour-aligned, otherwise use the next UTC hour start.
4. The end bound remains exclusive.
5. Expected-hour generation uses the same canonical grid as R2 AQI
   normalisation, live AQI calculation, canonical AQI keys and the final merge.
6. Never compare a whole-hour calculated timestamp with an expected key that
   retains arbitrary request minutes, seconds or milliseconds.
7. Observation timestamp precision and observation coverage semantics remain
   unchanged by this AQI-specific correction.

#### G. Independent AQI and observation head bounds

The browser MUST treat these Worker fields as independent contracts:

- `aqi.stable_head_start_utc`;
- `aqi.stable_head_end_utc`;
- `observations.stable_head_start_utc`;
- `observations.stable_head_end_utc`.

AQI bounds must not be used to replace an observation head, record observation
coverage, choose the next older observation cursor, or decide whether
observation history is already covered. Primary and secondary selected series
use their own explicit observation bounds and next-boundary fields, including
observations-only station-series responses.


## 2. Decisions already made

No further user decision is required before starting this plan.

| Decision | Agreed approach |
|---|---|
| New Worker name | `uk-aq-station-history` |
| Source directory | `workers/uk_aq_station_history/` |
| Service Binding | `STATION_HISTORY` |
| Public gateway | Existing `uk-aq-cache-proxy` |
| Public authentication | Remains in the cache proxy |
| New combined recent route | `/api/aq/station-series` |
| Existing AQI route | `/api/aq/aqi-history` retained |
| Existing observation route | `/api/aq/timeseries` retained |
| Short-range source | Ingest only when it fully covers output plus AQI context |
| Short ranges | 12-hour and 24-hour requests normally do not touch R2 |
| Long-range AQI first paint | Stable AQI head assembled inside the Worker before browser rendering |
| AQI precedence | R2 AQI wins over live-calculated AQI |
| Observation precedence | R2 observations win over ingest observations |
| Mid-load AQI replacement | Forbidden |
| Historical loading order | AQI gets first visual render and higher priority; both AQI and observation chunks proceed newest first without waiting for all AQI history to finish |
| Website x-axis | Fixed to the full requested range before chunks arrive |
| Cache migration | Keep public-response cache ownership in the gateway initially |
| Stale behaviour | Implement deliberately, not by relying on unsupported Cache API directives |
| Deployment | TEST first, followed by real operational validation |
| Production | Not part of these implementation prompts |

### 2.1 Phased compatibility boundary

The Worker extraction and website integration are deliberately separate.

Phases 1 through 5 are backend-only. They may modularise and move the existing
`/api/aq/timeseries` and `/api/aq/aqi-history` behaviour behind the private
`STATION_HISTORY` binding with the same public URLs, request formats, response
formats, session behaviour and chart behaviour. The website remains unchanged
through those phases and all new routes remain disabled by default.

Phase 6 is the first website integration phase. It makes the minimal loader
change needed to use `/api/aq/station-series` so one ingest observations fetch
can supply both the recent observations and the recent live-calculated AQI.
It does not change chart drawing, the public hostname, Turnstile/session
handling, station selection, tooltips, symbols, colours, or the existing
historical public route names.

The legacy website loading path remains an explicit TEST rollback until the
new loader has passed real TEST operational validation. The combined endpoint
is therefore an optimisation and rendering-quality phase, not a prerequisite
for safely extracting the Worker.

## 3. Important design rules

### 3.1 One AQI value per hour per browser load

The browser must never receive two competing AQI values for the same:

```text
timeseries_id + pollutant + timestamp_hour_utc
```

For a long-range request, the Worker must first build a stable AQI head:

```text
recent R2 AQI
      +
live-calculated AQI for R2-missing recent hours
      =
one authoritative AQI head response
```

The merge happens before the response reaches the website.

If R2 and live calculation disagree for an overlapping hour:

- retain the R2 AQI row;
- discard the live-calculated duplicate;
- record an operational mismatch diagnostic;
- do not send both values to the browser;
- do not change the colour after first render.

A value may change after an explicit refresh or a later page load if the underlying authoritative data has changed. It must not change partway through one page load.

### 3.2 Recent observations are fetched once

The combined recent route fetches ingest observations once, including any required PM rolling context.

The same fetched observations are used to:

1. calculate recent AQI;
2. populate the recent observation response.

Do not query ingest once for AQI and again for observations during the same combined request.

Do not persist temporary ingest rows in server-side storage between separate browser requests. The website may retain the returned observations in its existing in-memory or local browser cache.

### 3.3 PM context is not output

For PM2.5 and PM10, the Worker may need up to 23 hours before the requested output start to calculate the first 24-hour rolling AQI result.

Context observations:

- contribute to AQI calculation;
- must not be returned as output observations unless they are inside the requested output range;
- must not produce AQI rows outside the requested output range.

NO2 normally does not need the same prior rolling context.

### 3.4 Use capability checks, not window labels alone

The 12-hour and 24-hour paths should normally be ingest-only, but the implementation must decide this from actual coverage.

Use ingest-only when ingest fully covers:

```text
required_context_start_utc
through
requested_end_utc
```

and the ingest response is complete.

Do not assume that a request labelled `24h` is safe if:

- it is an older historical 24-hour request;
- ingest retention has changed;
- the connector has delayed or partial data;
- the PM context start is outside ingest coverage.

### 3.5 Separate AQI and observation completeness

The website must be able to display complete AQI even if an observation-history chunk fails, and vice versa.

However:

- incomplete recent observations mean live-calculated AQI is also incomplete;
- incomplete AQI source data must not be labelled complete;
- incomplete responses must not be stored as normal cache entries;
- successfully loaded chunks must remain displayed if a later chunk fails.

### 3.6 Recent-first rendering is an invariant

For every chart load, the browser must render the most recent available AQI
and observations first, even when its in-memory or local browser cache already
contains older chunks for the same timeseries.

The loader may hydrate older cached points in memory, but it must not present
an older-only chart while a current station-series response or newer chunk is
available. It must:

1. fix the x-axis to the full requested range;
2. apply the current recent station-series AQI head as the first AQI visual
   layer;
3. render the current recent observations immediately after that AQI-first
   paint;
4. extend both datasets backwards from newer chunks to older chunks; and
5. show an empty recent interval only when the current response establishes
   that the data is actually absent, or when the current request has failed.

Older cached or newly received chunks may fill missing historical intervals;
they must never delay, conceal, or replace the newer available interval. This
rule applies to normal loads, range expansion, cache hydration, retry, and
refresh.

## 4. Target architecture

```text
Website
  |
  | public /api/aq/*
  v
uk-aq-cache-proxy
  |
  |-- origin, CORS, Turnstile, session cookie
  |-- public cache lookup and conditional response
  |-- metadata, postcode, metrics and debug routes
  |
  | private Service Binding: STATION_HISTORY
  v
uk-aq-station-history
  |
  |-- recent ingest observations
  |-- shared AQI calculation
  |-- recent R2 AQI authority check
  |-- R2 AQI history
  |-- R2 observation history
  |-- merge, chunk and completeness contracts
  v
Existing upstream services
  |
  |-- Supabase ingest Edge Function / RPC
  |-- uk-aq-aqi-history-r2-api Worker
  |-- uk-aq-observs-history-r2-api Worker
```

Cloudflare Service Bindings allow the private Worker to be called without a public URL and are intended for this separation of concerns. The initial plan uses HTTP-style `fetch()` binding calls because the existing public gateway is already request/response based. RPC can be considered later, but is not needed for this extraction.

## 5. Public and internal contracts

### 5.1 New public combined route

```text
GET /api/aq/station-series
```

Minimum query parameters:

```text
timeseries_id
connector_id
pollutant
start_utc
end_utc
window
format=objects
```

The public gateway validates the session and forwards an internal request through `STATION_HISTORY`.

### 5.2 Internal recent/head route

```text
GET /v1/station-series
```

For 12-hour and 24-hour requests that qualify for ingest-only operation, it returns the whole requested range.

For longer requests, it returns the newest stable head needed for the first render and supplies boundaries for older chunks.

Suggested response shape:

```json
{
  "schema_version": 1,
  "request": {
    "timeseries_id": 123,
    "connector_id": 6,
    "pollutant": "pm25",
    "start_utc": "2026-06-01T00:00:00.000Z",
    "end_utc": "2026-07-15T09:00:00.000Z",
    "window": "90d"
  },
  "source": {
    "mode": "ingest_only",
    "required_context_start_utc": "2026-07-14T10:00:00.000Z",
    "output_start_utc": "2026-07-15T09:00:00.000Z",
    "output_end_utc": "2026-07-15T09:00:00.000Z",
    "ingest_response_complete": true,
    "used_recent_r2_aqi": false
  },
  "aqi": {
    "rows": [],
    "response_complete": true,
    "has_gap": false,
    "next_chunk_end_utc": null,
    "source_counts": {
      "r2": 0,
      "live_calculated": 0
    },
    "mismatch_count": 0
  },
  "observations": {
    "rows": [],
    "response_complete": true,
    "has_gap": false,
    "next_chunk_end_utc": null,
    "source_counts": {
      "ingest": 0
    }
  }
}
```

The exact existing DAQI/EAQI row columns must be preserved. Do not invent a second AQI row schema.

### 5.3 Existing AQI history route

```text
GET /api/aq/aqi-history
```

After extraction, the gateway forwards this to:

```text
GET /v1/aqi-history
```

It returns R2 AQI chunks only.

It must not independently calculate another live tail. The live-calculated tail has one owner: `/v1/station-series`.

### 5.4 Existing timeseries route

```text
GET /api/aq/timeseries
```

After extraction, the gateway forwards its v2 station-history behaviour to:

```text
GET /v1/observations-history
```

It returns R2 observation chunks for the historical part of progressive loading.

Legacy behaviour can remain behind a rollback flag during TEST migration.

## 6. Loading sequences

### 6.1 Normal 12-hour and 24-hour request

```text
Website
  |
  | GET station-series
  v
Station-history Worker
  |
  | fetch ingest observations once
  | include PM context when required
  | calculate AQI
  | strip context-only output
  v
Combined response
  |
  | website renders AQI
  | website renders observations
  v
Finished
```

R2 is not touched when ingest fully covers the required context and output interval.

### 6.2 Longer request

```text
1. Website requests station-series.

2. Worker:
   a. determines recent R2 AQI coverage for the exact series/pollutant;
   b. reads a bounded recent R2 AQI head;
   c. reads ingest observations after the authoritative R2 boundary,
      plus any PM context needed;
   d. calculates live AQI only for missing recent AQI hours;
   e. merges R2 AQI over live-calculated AQI;
   f. returns one stable AQI head plus recent observations.

3. Website:
   a. fixes the full requested x-axis;
   b. renders AQI from the stable head;
   c. starts older R2 AQI chunks, newest first;
   d. renders recent observations from the same head response;
   e. starts older R2 observation chunks, newest first.

4. Each older chunk extends backwards only.
```

No later chunk may replace an AQI hour already delivered in the stable head. Any overlap must be used for verification and deduplication, not visual replacement.

## 7. Chunking policy

Chunk sizes must be configurable and tuned using real TEST payload sizes.

Recommended initial defaults:

| Request range | Recent head | AQI chunk | Observation chunk |
|---|---:|---:|---:|
| 12h | whole range | none | none |
| 24h | whole range | none | none |
| 7d | recent ingest-covered part | up to 7 days | 1 to 2 days |
| 31d | recent ingest-covered part | 7 to 14 days | 1 to 3 days |
| 90d | recent ingest-covered part | 14 to 31 days | 3 to 7 days |

Rules:

- newest chunks first;
- bounded maximum rows, bytes and R2 object count;
- deterministic, non-overlapping output ranges after merge;
- small source overlap allowed internally;
- R2 precedence resolves overlap;
- website retains successful chunks;
- retry only the failed chunk;
- no broad refetch of already complete older chunks.

## 8. Cache-key and freshness design

### 8.1 Retain the hourly AQI generation idea

Recent or mutable AQI responses should retain a proxy-only hourly generation component.

Example internal cache component:

```text
__uk_aq_aqi_generation_hour=1:2026-07-15T09:00:00.000Z
```

Apply it to the finished, stable AQI response that the browser will render.

Do not separately cache:

- a live-only AQI result;
- a recent-R2-only AQI result;
- an intermediate merge result.

The cache entry must represent:

```text
R2-authoritative AQI + live-calculated missing recent hours
```

The generation component:

- is part of the cache key;
- is not forwarded to the underlying R2 or ingest service;
- changes at the next UTC hour;
- is omitted for explicitly immutable AQI chunks.

### 8.2 Recent combined bundle cache

The combined `/station-series` response includes observations, so it must not be cached for the entire hour merely because its AQI section uses hourly generation.

Recommended starting behaviour:

- short fresh TTL, initially 60 seconds;
- canonical key includes schema version and requested output bounds;
- no storage when observations or AQI are incomplete;
- response metadata identifies the AQI generation hour;
- browser may keep the successful response in local memory/cache for the page session.

### 8.3 Immutable history cache

R2-only chunks outside the mutable horizon can use long-lived versioned keys.

The key must include:

```text
contract version
domain
profile
timeseries_id
connector_id
pollutant
chunk start
chunk end
format
```

Avoid cache busters and semantically equivalent timestamp variants.

## 9. Deliberate stale behaviour

The existing cache proxy emits `stale-while-revalidate` and `stale-if-error` directives while storing responses through `caches.default`.

Cloudflare's Cache API does not implement those directives for `cache.put()` and `cache.match()`.

Therefore:

> It is worth addressing the actual desired stale behaviour as part of the cache-boundary design.

Do not merely copy the current stale directives into the new Worker and assume they operate.

### 9.1 Recommended explicit stale strategy

Keep public-response cache ownership in the gateway during the first extraction.

For each cacheable station-history response, maintain:

```text
fresh cache key
stale fallback cache key
```

The stale copy contains explicit metadata:

```json
{
  "cached_at_utc": "...",
  "fresh_until_utc": "...",
  "stale_until_utc": "...",
  "source_complete": true,
  "payload": {}
}
```

Request behaviour:

```text
1. Fresh cache hit:
   return fresh response.

2. Fresh cache miss:
   call station-history Worker.

3. Successful complete upstream response:
   write fresh entry;
   write or refresh stale fallback entry;
   return fresh response.

4. Upstream failure:
   inspect stale fallback;
   serve it only when:
     - it was originally complete;
     - it has no unresolved source gap;
     - current time is before stale_until_utc;
     - its cache class permits stale service.

5. No valid stale fallback:
   return the upstream failure or partial response;
   do not disguise it as success.
```

Stale responses must carry clear diagnostics, for example:

```text
X-UK-AQ-Cache: STALE
X-UK-AQ-Stale: true
X-UK-AQ-Stale-Age-Seconds: <number>
X-UK-AQ-Stale-Reason: upstream_error
Warning: 110 - "Response is stale"
```

The JSON metadata should also contain:

```json
{
  "served_stale": true,
  "stale_age_seconds": 0,
  "stale_reason": "upstream_error"
}
```

### 9.2 Suggested configurable stale limits

These are starting defaults, not hard-coded policy:

| Cache class | Suggested fresh TTL | Suggested maximum stale fallback |
|---|---:|---:|
| Recent combined station-series | 60 seconds | 5 minutes |
| Mutable stable AQI head | hourly generation | 2 hours |
| Mutable observation chunk | 60 seconds | 5 minutes |
| Immutable R2 AQI chunk | 24 hours or longer | 7 days |
| Immutable R2 observation chunk | 24 hours or longer | 7 days |

Do not serve stale data for:

- authentication failures;
- request validation errors;
- unsupported pollutants;
- incomplete source responses;
- known gaps;
- mismatched contract versions;
- explicit cache bypass;
- POST requests.

### 9.3 Cache ownership decision point

The first extracted version keeps cache ownership in the public gateway.

After the private Worker is operational in TEST, run one targeted operational check to determine whether moving data-specific Cache API ownership into the service-bound Worker is useful and reliable under the actual custom-domain request path.

This is a genuine targeted TEST check because cache behaviour depends on the deployed Cloudflare execution path.

Do not move cache ownership merely for conceptual purity.

Possible final choices after TEST:

1. Keep all public response caching and explicit stale fallback in the gateway.
2. Move fresh data caches to station-history, but keep public stale fallback in the gateway.
3. Move both to station-history only if the deployed behaviour is clear, observable and simpler.

The default recommendation is option 1 unless TEST evidence shows a meaningful benefit.

## 10. Source boundaries and overlap

Do not use one global "R2 is current through this timestamp" boundary.

Resolve coverage for the exact:

```text
domain
timeseries_id
connector_id
pollutant
```

Maintain separate boundaries for:

```text
aqi_r2_coverage_end
observations_r2_coverage_end
```

Use bounded overlap:

- observations: initially 1 to 3 hours;
- PM AQI source context: up to 23 hours;
- AQI output overlap: enough to compare R2 and calculated identity without returning duplicates.

Record mismatch diagnostics without logging observation values:

```text
r2_live_aqi_overlap_count
r2_live_aqi_mismatch_count
r2_live_aqi_mismatch_hours
r2_observation_overlap_count
r2_ingest_observation_mismatch_count
```

Do not log raw credentials or large row payloads.

## 11. Feature flags and rollback

Suggested TEST flags:

```text
UK_AQ_STATION_HISTORY_SERVICE_ENABLED=false
UK_AQ_STATION_HISTORY_RECENT_BUNDLE_ENABLED=false
UK_AQ_STATION_HISTORY_STABLE_AQI_HEAD_ENABLED=false
UK_AQ_STATION_HISTORY_PROGRESSIVE_CHUNKS_ENABLED=false
UK_AQ_STATION_HISTORY_EXPLICIT_STALE_ENABLED=false
```

Existing fallback paths remain during TEST.

The public gateway should be able to route each feature independently:

```text
station-series -> new service or disabled
aqi-history -> new service or existing path
timeseries -> new service or existing path
```

Do not delete the embedded cache-proxy implementation until TEST operations have validated the new path.

## 12. Repository and archive policy

Before changing existing files:

- inspect the repository's current archive convention;
- create one new task-specific archive directory;
- archive only files changed by that phase;
- do not overwrite previous archive snapshots;
- do not duplicate unrelated trees.

Suggested root:

```text
archive/2026-07-15/station-history-worker/
```

Use phase subdirectories where helpful.

## 13. Implementation phases

---

# Phase 0: Confirm structural viability and freeze contracts

## Objective

Inspect the current TEST repositories and produce a concise implementation report before changing production code.

This is not a speculative test phase. It validates only that the proposed file boundaries, imports, route contracts, deployment workflow and Service Binding configuration are structurally viable.

## Required outputs

- exact current cache-proxy routes and handlers;
- exact shared AQI library imports;
- current website calls for AQI and observations;
- current browser local-cache and chunk handling;
- current R2 Worker response contracts;
- proposed source file split;
- proposed service-binding configuration;
- list of public contracts that remain unchanged;
- list of new contracts;
- identified blockers, if any.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Work across these TEST repositories:

1. TEST-uk-aq/uk-aq-ops
2. TEST-uk-aq/TEST-uk-aq-root.github.io

Do not modify files in this phase.
Do not create a pull request.
Do not deploy.
Do not alter repository variables, Cloudflare settings, Supabase objects or R2 objects.

Goal:

Validate the structural viability of extracting station time-series and AQI-history orchestration from `workers/uk_aq_cache_proxy` into a private Worker named `uk-aq-station-history`, while retaining the existing cache proxy as the public security gateway.

Inspect the current code, not archived copies.

Confirm:

- public cache-proxy route mapping;
- session, CORS, Turnstile and cache-bypass boundaries;
- current timeseries v2 stitch implementation;
- current AQI history proxy cache-key implementation;
- current R2 observations and AQI Worker request/response contracts;
- current shared AQI calculation library;
- current website chart request order;
- current website observation and AQI chunking;
- current browser local-cache behaviour;
- current deployment workflow conventions;
- current archive policy.

Proposed architecture to validate:

- new directory `workers/uk_aq_station_history/`;
- Worker name `uk-aq-station-history`;
- caller Service Binding `STATION_HISTORY`;
- private service Worker with no public route;
- gateway keeps public auth and initial cache ownership;
- new public `GET /api/aq/station-series`;
- existing `GET /api/aq/aqi-history`;
- existing `GET /api/aq/timeseries`;
- station-series fetches ingest observations once and returns calculated AQI plus recent observations;
- 12h/24h use ingest only when output plus PM context is fully covered;
- longer ranges build a stable AQI head from recent R2 AQI plus live-calculated missing hours;
- R2 AQI wins overlaps before anything reaches the browser;
- older AQI chunks load newest first;
- older observation chunks load after AQI, newest first;
- no mid-load AQI replacement.

Do not design a broad pre-implementation test suite.

Return:

1. structural viability verdict;
2. current files and functions involved;
3. proposed module/file boundaries;
4. proposed internal request and response contracts;
5. website changes required;
6. workflow and binding changes required;
7. variables and secrets that move to the new Worker;
8. variables and secrets that remain in the gateway;
9. rollback boundaries;
10. any genuine blocker that must be resolved before implementation.
```

---

# Phase 1: Modularise station-history logic inside the existing proxy

## Objective

Extract the existing data-specific logic into modules without changing deployed behaviour.

Suggested modules:

```text
workers/uk_aq_cache_proxy/src/station_history/
  contracts.ts
  request_window.ts
  ingest_observations.ts
  r2_observations.ts
  r2_aqi.ts
  aqi_live.ts
  merge.ts
  completeness.ts
  cache_keys.ts
```

The cache proxy entry point should become a dispatcher rather than containing all station-history code.

## Scope

- move code only;
- preserve all current public routes and output contracts;
- preserve current feature flags;
- preserve current cache ownership;
- preserve current source precedence;
- no new Worker deployment yet.

## Post-implementation checks

Run syntax/type checks and the existing affected cache-proxy, timeseries and AQI tests.

Functional behaviour is validated later through real TEST operations, not claimed from module tests alone.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 1 of the station-history extraction plan.

Do not deploy.
Do not alter repository variables.
Do not merge.
Do not change public API behaviour.
Do not create the new Worker yet.

Goal:

Modularise the existing station-history-related code currently embedded in:

workers/uk_aq_cache_proxy/src/index.ts

Move cohesive logic into:

workers/uk_aq_cache_proxy/src/station_history/

Use repository-consistent names after inspecting the current code.

The modules should cover:

- station-history contracts;
- request-window and context resolution;
- ingest observation reads;
- R2 observation reads and paging;
- R2 AQI reads;
- live AQI calculation;
- R2/live merge precedence;
- completeness and gap decisions;
- station-history cache-key canonicalisation.

Keep in the gateway entry point:

- origin and CORS;
- Turnstile;
- session minting and verification;
- cache-bypass authorisation;
- local TEST bypass;
- route dispatch;
- ordinary metadata/postcode routes;
- chart metrics;
- website debug logs;
- public cache lookup and response wrapping.

Requirements:

- preserve all current route names;
- preserve all current response schemas and headers;
- preserve current AQI hourly-generation cache behaviour;
- preserve current timeseries v2 behaviour;
- preserve R2-over-ingest and R2-AQI-over-live precedence;
- do not introduce a new test framework;
- follow archive policy before modifying existing files;
- archive only files changed in this phase.

After implementation:

- run TypeScript checks;
- run existing targeted cache-proxy, timeseries and AQI tests;
- add only focused tests needed to prove imports and moved functions preserve the current contract;
- report functional TEST validation as still outstanding.

Return:

1. files moved or created;
2. entry-point reduction;
3. preserved contracts;
4. checks run;
5. unresolved structural issues;
6. final commit and pull-request details.

Do not deploy or merge.
```

---

# Phase 2: Create the private station-history Worker and Service Binding

## Objective

Create the private Worker and route existing data behaviour through it behind disabled-by-default flags.

## Scope

- new `workers/uk_aq_station_history/`;
- Worker `wrangler.toml`;
- deployment workflow;
- gateway Service Binding declaration;
- internal auth contract;
- no website change;
- no production cutover;
- gateway still owns public cache.

## Internal security

A Service Binding is already private to the caller, but preserve an explicit internal contract:

- reject public-style requests that lack the expected binding marker or route;
- do not expose a custom domain;
- do not duplicate browser session verification in the private Worker;
- gateway strips browser cookies and passes only required request context;
- upstream secrets live only where needed.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 2 of the station-history extraction plan.

Do not deploy.
Do not alter live repository variables.
Do not merge.
Do not change the website.

Create a private Cloudflare Worker:

- directory: workers/uk_aq_station_history/
- Worker name: uk-aq-station-history
- Service Binding name in the gateway: STATION_HISTORY
- no public route or custom domain

The existing `uk-aq-cache-proxy` remains the public gateway and retains:

- origin/CORS;
- Turnstile;
- session-cookie validation;
- cache bypass;
- public response caching.

The new Worker receives internal HTTP-style Service Binding requests.

Implement disabled-by-default routing flags so the gateway can independently route:

- station-series;
- aqi-history;
- timeseries;

to the new service or the existing embedded path.

Initially, the new Worker should host behaviour equivalent to the current modularised station-history implementation. Do not add the new recent combined contract yet unless needed for a clean skeleton.

Add:

- `wrangler.toml`;
- deployment workflow following repository conventions;
- environment interface;
- Service Binding configuration in the gateway;
- structured internal route errors;
- observability;
- version/contract diagnostic headers.

Move only data-specific variables and secrets that the private Worker actually needs.

Do not move:

- Turnstile secret;
- session signing secret;
- allowed browser origins;
- Dropbox debug-log credentials;
- chart-metrics credentials unless the current implementation proves they are data-path dependencies.

Follow archive policy.

After implementation:

- run syntax/type checks;
- run affected existing tests;
- add focused Service Binding contract tests using the repository's current Worker test style;
- do not claim operational success until deployed to TEST.

Return:

1. new Worker files;
2. gateway binding changes;
3. new workflow;
4. variables and secrets required;
5. disabled-by-default flags;
6. rollback path;
7. checks run;
8. final commit and PR details.

Do not deploy or merge.
```

---

# Phase 3: Implement the combined recent station-series route

## Objective

Implement one ingest read that supplies:

- live-calculated AQI;
- recent observations.

## Public route

```text
GET /api/aq/station-series
```

## Internal route

```text
GET /v1/station-series
```

## Required behaviour

- calculate required PM context;
- fetch ingest once;
- validate ingest completeness;
- normalise rows;
- calculate AQI;
- strip context-only rows;
- return AQI and observations independently;
- return full requested 12h/24h when ingest coverage allows;
- return no R2 data in qualified ingest-only mode;
- return source boundaries and next-chunk hints.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 3 of the station-history extraction plan.

Do not deploy.
Do not enable the feature flag.
Do not alter repository variables.
Do not merge.

Add:

GET /api/aq/station-series

to the public gateway, forwarded through the private STATION_HISTORY Service Binding to:

GET /v1/station-series

Implement the recent ingest bundle.

Inputs:

- timeseries_id;
- connector_id;
- pollutant;
- start_utc;
- end_utc;
- window;
- format=objects.

Behaviour:

1. Resolve the exact output interval.
2. Resolve required AQI context:
   - PM2.5/PM10 may require 23 prior hours;
   - NO2 normally starts at the output start.
3. Fetch ingest observations once.
4. Validate source completeness and bounds.
5. Normalise observations through existing shared helpers.
6. Calculate DAQI/EAQI through the existing shared AQI library.
7. Remove context-only AQI and observation rows from output.
8. Return:
   - AQI rows;
   - observation rows;
   - independent completeness and gap fields;
   - source boundaries;
   - source counts;
   - next historical chunk boundary hints.
9. For 12h and 24h requests, use ingest-only mode when ingest fully covers context plus output.
10. In qualified ingest-only mode, do not call either R2 upstream.
11. If ingest is incomplete, calculated AQI must also be marked incomplete and the response must be uncacheable.
12. Do not fetch ingest twice within one request.

Preserve current AQI row schema and breakpoint semantics.

Add focused post-implementation coverage for:

- NO2 12h ingest-only;
- PM 24h with 23h context;
- context rows excluded from output;
- incomplete ingest makes AQI incomplete;
- one ingest fetch per request;
- no R2 call in qualified fast path.

Do not build a speculative pre-implementation suite.

Follow archive policy.

Return:

1. route contract;
2. source-boundary logic;
3. ingest call count;
4. PM context behaviour;
5. response schema;
6. checks run;
7. final commit and PR details.

Do not deploy, enable or merge.
```

---

# Phase 4: Implement the stable AQI head for longer ranges

## Objective

Prevent AQI colour changes by resolving recent R2 authority before first render.

## Required behaviour

For longer ranges:

1. determine exact recent R2 AQI coverage;
2. read bounded recent R2 AQI;
3. fetch ingest observations for the missing live tail plus PM context;
4. calculate live AQI;
5. merge before response;
6. R2 wins;
7. return one row per hour;
8. record mismatches;
9. older AQI chunks only extend backwards.

## VS Code Codex prompt

```text
Use GPT-5.6 Sol with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 4 of the station-history extraction plan.

Do not deploy.
Do not enable flags.
Do not alter repository variables.
Do not merge.

Extend `/v1/station-series` for longer ranges so the first AQI response is stable and authoritative.

Required algorithm:

1. Resolve R2 AQI coverage for the exact:
   - timeseries_id;
   - connector_id;
   - pollutant.
2. Fetch a bounded recent R2 AQI head.
3. Determine which recent output hours are missing from R2.
4. Fetch ingest observations only for the required live-calculation interval plus AQI context.
5. Calculate live AQI only for eligible missing output hours.
6. Merge inside the Worker:
   R2 AQI > live-calculated AQI.
7. Return exactly one AQI row per canonical identity/hour.
8. Do not return both competing values.
9. Count and log overlap/mismatch diagnostics without logging observation values.
10. Provide the next older AQI chunk boundary.
11. Ensure later AQI chunks can only extend backwards and cannot replace the stable head.

Retain the 12h/24h ingest-only fast path from Phase 3.

Add fail-closed behaviour when:

- recent R2 claims coverage but the response is incomplete;
- live source is incomplete for required missing hours;
- source identities cannot be reconciled;
- duplicate conflicting rows survive final merge.

Add focused post-implementation tests for:

- matching R2/live overlap;
- differing R2/live AQI with R2 retained;
- one output row per hour;
- mismatch diagnostics;
- no later chunk replacement contract;
- PM context across the R2/live boundary;
- incomplete source response remains uncacheable.

Follow archive policy.

Return:

1. stable-head algorithm;
2. exact precedence;
3. mismatch diagnostics;
4. response-boundary fields;
5. checks run;
6. final commit and PR details.

Do not deploy, enable or merge.
```

---

# Phase 5: Extract and formalise historical AQI and observation chunks

## Objective

Make historical chunks predictable, bounded and reusable.

## AQI chunks

- R2 only;
- newest first;
- larger chunks;
- immutable detection;
- no live calculation;
- no replacement of stable head.

## Observation chunks

- R2 only for the historical region;
- newest first;
- smaller chunks;
- R2 wins any source overlap;
- independent completeness.

## VS Code Codex prompt

```text
Use GPT-5.6 Sol with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 5 of the station-history extraction plan.

Do not deploy.
Do not enable flags.
Do not alter repository variables.
Do not merge.

Move the public gateway's station-history handling for:

- `/api/aq/aqi-history`;
- `/api/aq/timeseries`;

behind the STATION_HISTORY Service Binding, retaining disabled-by-default rollback flags.

Internal routes:

- `/v1/aqi-history`;
- `/v1/observations-history`.

AQI-history requirements:

- R2 AQI only;
- no independent live calculation;
- bounded start/end chunk;
- newest-first contract;
- immutable/mutable classification;
- exact source completeness;
- preserve existing AQI response formats where still required;
- reject a chunk that overlaps the stable head in a way that would replace an already delivered hour.

Observation-history requirements:

- R2 observations for the requested historical chunk;
- bounded object/page/row limits;
- newest-first contract;
- completeness and gap details;
- deterministic ordering and dedupe;
- R2 authority on overlap;
- retain existing timeseries contract during rollback.

Add response fields needed by the website to request the next older chunk without guessing source coverage.

Do not change the public website in this phase.

Add focused post-implementation coverage for:

- chunk boundary continuity;
- newest-first progression;
- deterministic retry;
- immutable classification;
- incomplete R2 response;
- independent AQI and observation failure;
- no stable-head replacement.

Follow archive policy.

Return:

1. public-to-internal route mapping;
2. chunk contracts;
3. limits and configuration;
4. rollback flags;
5. checks run;
6. final commit and PR details.

Do not deploy, enable or merge.
```

---

# Phase 6: Implement website AQI-first progressive rendering

## Objective

Update the website so AQI always renders before observations and historical data fills backwards without visual AQI replacement.

## Required sequence

```text
station-series response
  -> fix full x-axis
  -> render stable AQI head
  -> start older AQI chunks, newest first
  -> render recent observations
  -> start older observation chunks, newest first
```

The website may render recent observations immediately after starting the first
AQI chunk request. It must not wait for every older AQI chunk to finish before
starting older observation chunks. AQI remains the first visual layer and has
higher loading priority; historical observation loading proceeds independently
once the recent head has been rendered.

## Website state

Maintain independent state for:

```text
aqi_head
aqi_chunks
recent_observations
observation_chunks
aqi_complete
observations_complete
aqi_errors
observation_errors
```

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Repository:

TEST-uk-aq/TEST-uk-aq-root.github.io

Implement Phase 6 of the station-history progressive-loading plan.

Do not deploy.
Do not change production URLs.
Do not merge.

Inspect the current chart and local-cache implementation before editing.

New load order:

1. Request `/api/aq/station-series`.
2. Fix the x-axis to the full requested range.
3. Render the stable AQI head first.
4. Start older `/api/aq/aqi-history` chunks, newest first.
5. Render recent observations from the station-series response.
6. Start older `/api/aq/timeseries` chunks, newest first.
7. Merge and render each successful chunk incrementally.

Rules:

- never replace an already rendered AQI hour with a later chunk;
- treat such overlap as a contract error and retain the existing stable-head row;
- retain successful chunks if a later chunk fails;
- retry only failed chunks;
- maintain independent AQI and observation completeness;
- when hydrating local cache, do not render an older-only cached range ahead of
  the current recent head unless the current head is actually absent or the
  current request fails;
- keep current selected sensor, symbol, tooltip and chart-window behaviour;
- do not resize the x-axis as chunks arrive;
- do not refetch completed chunks when expanding or rerendering;
- preserve existing browser/local cache where compatible;
- version new cache entries so old contracts cannot be mistaken for the new schema;
- process the AQI section of station-series before the observations section.
- When the current recent request fails, older cached data may be rendered only
  with an explicit stale or unavailable-current-data state. It must not be
  presented as though it represents the current interval.

For 12h/24h:

- station-series should normally complete the load;
- do not request R2 chunks when both next-chunk boundaries are null.

For longer ranges:

- request AQI chunks before observation-history chunks;
- chunk newest first;
- use configured concurrency conservatively;
- avoid broad parallel floods.

Add focused post-implementation tests or harness checks using the existing website test approach for:

- AQI renders first;
- fixed x-axis;
- no AQI replacement;
- 12h/24h no R2 chunk calls;
- a warm local cache containing older data still renders the current recent
  head first when it is available;
- failed older observation chunk does not remove AQI;
- failed older AQI chunk does not remove recent AQI;
- chunk retry does not duplicate rows.

Follow the website repository's archive policy.

Return:

1. files changed;
2. request sequence;
3. state model;
4. local-cache versioning;
5. no-replacement guard;
6. checks run;
7. final commit and PR details.

Do not deploy or merge.
```


# Phase 6b: Integrate station-history loading into the Hex Map chart

## Objective

Update `hex_map/index.html` to use the new station-history loading path.

The Hex Map supports up to four selected observation series but displays AQI bands from only one selected AQI-source sensor. The implementation must therefore:

* load the stable AQI head for the selected AQI-source series;
* load recent observations for every selected series;
* render the current AQI head first;
* render recent observation lines immediately afterwards;
* extend AQI and observations backwards independently;
* preserve the current multi-sensor chart behaviour;
* retain the existing loader as a TEST rollback path.

The standalone Sensors page implementation should be treated as a reference, not copied blindly, because Hex Map has multi-series selection, separate AQI-source selection and more complex in-memory caching.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Work across these TEST repositories:

1. TEST-uk-aq/TEST-uk-aq-root.github.io
2. TEST-uk-aq/uk-aq-ops, only if a small station-series contract extension is genuinely required

Implement Phase 6b of the station-history progressive-loading plan.

Primary website file:

hex_map/index.html

Existing shared helper:

station-history-loader.js

Do not deploy.
Do not alter Cloudflare variables or repository secrets.
Do not change production.
Do not remove the current Hex Map loading path.
Do not merge.

Background:

The standalone `sensors/index.html` page has already been migrated to the
station-history progressive loader.

The Hex Map chart has not yet been migrated. It still uses its previous
independent AQI-history and timeseries loading paths.

The Hex Map supports up to four selected sensor series. Only one selected
series is the AQI-band source.

Goal:

Implement the station-history loader for Hex Map while preserving all existing
chart, selection, caching and rendering behaviour.

Required loading sequence:

1. Resolve the full requested chart range and fix the x-axis to it.
2. Request the current station-series head for the selected AQI-source series.
3. Render the stable AQI head as the first visual data layer.
4. Render the recent observations returned for that AQI-source series.
5. Obtain recent observations for every other selected series.
6. Start older AQI-history chunks for the AQI-source series, newest first.
7. Start older observation-history chunks for all selected series, newest first.
8. Allow older AQI and observation loading to proceed independently.
9. Extend data backwards only.
10. Never replace an AQI hour already delivered by the stable head.

Do not wait for every historical AQI chunk to finish before starting or
rendering historical observations.

Multi-series behaviour:

- AQI is requested and rendered only for the selected AQI-source series.
- Every selected series must receive a recent observation head.
- Preserve the existing maximum of four selected sensors.
- Preserve symbol ordering and selected-sensor ordering.
- Preserve the ability to change which selected sensor supplies the AQI bands.
- A change to the AQI-source sensor must not unnecessarily refetch complete
  observation history for unchanged selected series.
- Adding or removing a secondary selected sensor must not replace or repaint a
  complete stable AQI head unnecessarily.

Inspect the current station-series contract before implementation.

Preferred design for secondary selected series:

- support an observations-only station-series request such as
  `include_aqi=false`;
- it should fetch ingest observations once and return recent observations
  without performing recent R2 AQI lookup or live AQI calculation;
- the normal AQI-source request retains the existing full AQI plus observations
  contract.

Only add this small backend option if the current contract does not already
provide an equivalent capability.

If adding `include_aqi=false`:

- modify only the minimum necessary files in `TEST-uk-aq/uk-aq-ops`;
- preserve the existing default behaviour when the parameter is absent;
- require the same request identity and coverage validation;
- retain the 12h/24h ingest-only capability check;
- do not call the R2 AQI Worker;
- do not calculate DAQI or EAQI;
- return an explicit AQI-disabled state rather than pretending AQI is complete;
- preserve cacheability rules for the observation response;
- add the parameter to canonical cache-key construction so AQI and
  observations-only responses cannot collide;
- retain all existing feature flags and rollback behaviour.

Do not use the full AQI station-series operation for secondary sensors as the
permanent implementation merely to discard their AQI output. A temporary
fallback is acceptable only when explicitly documented and protected behind
the existing legacy rollback path.

Recent-first invariant:

- cached historical points may hydrate memory before the network response;
- older-only cached data must not render ahead of an available current
  station-series head;
- render the current stable AQI head first;
- render current recent observations immediately afterwards;
- then extend both datasets backwards;
- when the current request fails, older cached data may be displayed only with
  an explicit stale/current-data-unavailable state;
- cached historical data must never appear to represent the current interval.

AQI no-replacement rule:

Use `station-history-loader.js` or an equivalent shared helper so that:

- existing stable-head AQI rows remain authoritative for the current load;
- later history chunks cannot replace them;
- equivalent overlap is deduplicated;
- conflicting overlap is logged as a contract error;
- the already rendered colour is retained;
- no last-write-wins AQI merge is introduced.

Observation merge rules:

- deduplicate observation points by exact timestamp and series identity;
- stable recent ingest observations remain visible while history loads;
- R2 historical chunks extend backwards;
- source overlap must not create duplicate line points;
- retain successful chunks when another series or chunk fails;
- retry only failed chunks.

Caching:

- add a versioned Hex Map station-history cache contract;
- do not mistake the old Hex Map cache schema for a complete station-history
  response;
- old cache data may be used only as a stale historical seed;
- preserve current useful in-memory caching;
- do not refetch complete chunks when rerendering, expanding or changing only
  the AQI source;
- keep AQI and observation completeness independently;
- key observation state per series;
- key AQI state per AQI-source series, pollutant and requested range;
- include any observations-only station-series mode in the cache identity.

12-hour and 24-hour behaviour:

- when recent ingest coverage includes the whole requested output plus required
  PM context, do not request R2 AQI or R2 observations;
- the AQI-source station-series response supplies stable AQI and recent
  observations;
- secondary observations-only station-series responses supply the other recent
  lines;
- when all returned next-chunk boundaries are null, make no history requests.

Longer ranges:

- render the stable AQI head before any observation line;
- render all available recent observation heads immediately after that first
  AQI paint;
- start AQI history before observation history;
- observation history may continue while AQI history is still in flight;
- process chunks newest first;
- preserve the fixed full-range x-axis;
- avoid broad parallel request floods;
- retain the current global and per-series concurrency protections where
  compatible.

Preserve all current Hex Map behaviour, including:

- chart mode and map mode transitions;
- selected sensor limit;
- symbol assignment;
- selected AQI source control;
- chart range selector;
- tooltip contents and date formatting;
- DAQI and EAQI visual appearance;
- WHO guideline rendering;
- loading indicator;
- progress bar;
- sensor list ordering;
- area and map context;
- chart metrics;
- website debug logging;
- Turnstile/session handling;
- current local-development behaviour.

Rollback:

Add a TEST-only loader switch using the repository’s existing configuration or
query-parameter conventions.

The old Hex Map loader must remain available until real TEST operation has
validated the new multi-series path.

The new path should be the normal TEST default only when that matches the
current Phase 6 deployment approach. Otherwise leave it disabled by default
and clearly report the enabling step.

Repository handling:

- inspect the current archive convention before modifying files;
- archive only files changed by this task;
- do not overwrite existing archives;
- do not modify unrelated website or ops files.

Post-implementation checks:

Use the existing test and validation approaches only. Do not introduce a broad
new test framework.

Add focused checks for:

1. stable AQI head renders before observation lines;
2. primary AQI-source station-series request;
3. recent observations for every selected series;
4. secondary series do not perform unnecessary AQI work;
5. changing AQI source preserves complete observation caches;
6. adding/removing a secondary series preserves the stable AQI head;
7. no AQI replacement from older chunks;
8. conflicting overlap retains the displayed stable-head value;
9. fixed x-axis throughout progressive loading;
10. 12h and 24h make no R2 requests when ingest coverage is sufficient;
11. AQI and observation histories proceed independently after first paint;
12. one failed series or chunk does not remove successful series;
13. warm historical cache does not render ahead of current recent data;
14. failed current request visibly marks cached data as stale;
15. retries do not duplicate AQI or observation points;
16. legacy Hex Map loader remains functional through the rollback switch.

After implementation, run:

- the existing website checks;
- the station-history loader tests;
- any focused Hex Map loader harness already used by the repository;
- affected ops tests only if `include_aqi=false` or another backend contract
  extension was added.

Do not claim functional success from static checks alone. Real chart behaviour
must be validated after deployment through TEST operations.

Return:

1. whether a backend observations-only extension was required;
2. exact website and ops files changed;
3. new Hex Map request sequence;
4. multi-series state and cache model;
5. AQI no-replacement implementation;
6. recent-first rendering implementation;
7. 12h/24h R2 avoidance;
8. rollback switch and its default;
9. checks run and results;
10. TEST variables or flags that must be enabled;
11. real operational scenarios still requiring validation;
12. final commit and pull-request details.

Do not deploy or merge.
```


---

# Phase 7: Implement explicit fresh and stale cache behaviour

## Objective

Replace assumed stale directives with explicit, observable behaviour.

## Initial ownership

The public gateway owns:

- fresh response cache;
- stale fallback cache;
- conditional requests;
- public cache diagnostics.

The private Worker owns:

- data correctness;
- source completeness;
- source-specific cache-key components;
- AQI generation-hour metadata.

## VS Code Codex prompt

```text
Use GPT-5.6 Sol with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 7 of the station-history extraction plan.

Do not deploy.
Do not enable the flag.
Do not alter live repository variables.
Do not merge.

The current code uses `caches.default` while emitting stale-while-revalidate and stale-if-error directives. Cloudflare Cache API `cache.put()` and `cache.match()` do not implement those directives.

Implement deliberate stale fallback in the public cache proxy for station-history routes only.

Routes:

- station-series;
- aqi-history;
- timeseries.

Design:

- versioned fresh cache key;
- versioned stale fallback key;
- explicit cached_at, fresh_until and stale_until metadata;
- fresh hit;
- upstream fetch on fresh miss;
- write both entries only for complete, gap-free responses;
- on upstream failure, serve stale only inside the configured stale window;
- no stale response for validation/auth errors, partial responses, known gaps, bypass requests or unsupported contracts;
- clear stale diagnostic headers and JSON metadata;
- preserve ETag and 304 behaviour where semantically correct.

Retain AQI hourly generation for mutable stable AQI responses.

Do not make the recent combined observations response hourly-stale. It uses a short fresh TTL.

Add configuration with safe defaults for:

- recent bundle fresh TTL;
- recent bundle max stale;
- mutable AQI max stale;
- mutable observation max stale;
- immutable history max stale.

Keep the feature disabled by default.

Do not move cache ownership into the private Worker in this phase.

Add focused post-implementation coverage for:

- fresh hit;
- upstream success refreshes stale copy;
- upstream failure serves valid stale;
- stale window expired;
- incomplete response never seeds stale;
- bypass never serves stale;
- stale headers and JSON diagnostics;
- AQI generation-hour key remains internal;
- station-series observations do not receive an hour-long fresh TTL.

Follow archive policy.

Return:

1. fresh/stale key design;
2. metadata schema;
3. route-specific defaults;
4. exclusion rules;
5. checks run;
6. final commit and PR details.

Do not deploy, enable or merge.
```

---

# Phase 8: TEST deployment and operational validation

## Objective

Deploy and validate through real TEST operations.

Unit and contract tests do not establish operational success.

## Deployment order

1. Deploy private station-history Worker with all routing flags disabled.
2. Add and verify the gateway Service Binding.
3. Enable station-series for TEST only.
4. Validate 12h and 24h.
5. Enable stable AQI head for longer ranges.
6. Enable historical AQI chunks.
7. Enable historical observation chunks.
8. Deploy website progressive loading.
9. Enable explicit stale behaviour last.
10. Observe before removing rollback paths.

## Operational validation matrix

### 12h and 24h

Confirm:

- no R2 calls when ingest fully covers source context;
- one ingest request per station-series request;
- AQI appears before observations;
- PM first-hour rolling result is correct;
- no historical chunk requests;
- complete response is cacheable;
- incomplete ingest response is not cacheable.

### 7d, 31d and 90d

Confirm:

- stable AQI head includes R2 authority before render;
- no colour changes during one load;
- older AQI extends backwards;
- recent observations render after the initial AQI paint; older observation
  chunks may proceed while older AQI chunks remain in flight;
- a warm older browser cache does not hide the current recent head;
- fixed x-axis;
- chunk retries are bounded;
- no duplicate rows;
- correct gap diagnostics.

### Failure operations

Confirm:

- R2 AQI failure retains recent AQI;
- R2 observations failure retains AQI and recent observations;
- ingest failure does not claim live AQI completeness;
- stale fallback is clearly marked;
- expired stale is not served;
- cache bypass reaches fresh upstream behaviour;
- rollback flags restore previous path.

### Cache ownership check

After the system is otherwise stable, run one targeted TEST check:

- invoke the private Worker through the Service Binding;
- determine whether Cache API ownership inside the private Worker is observable and reliable under the custom-domain gateway path;
- compare complexity and hit behaviour with gateway-owned caching;
- retain gateway ownership unless evidence supports moving it.

## VS Code Codex prompt for operational support

```text
Use GPT-5.6 Terra with High reasoning.

Repositories:

1. TEST-uk-aq/uk-aq-ops
2. TEST-uk-aq/TEST-uk-aq-root.github.io

This is the TEST operational validation phase.

Do not change production.
Do not remove rollback paths.
Do not delete old variables or code.
Do not merge follow-up fixes without review.

First inspect the deployed TEST configuration and confirm the intended flags and Service Binding.

Then support a staged TEST validation:

1. station-series only;
2. 12h/24h ingest-only;
3. stable AQI head for 7d/31d/90d;
4. AQI chunks;
5. observation chunks;
6. website progressive loader;
7. explicit stale fallback.

Use real TEST requests and browser operations.

Capture:

- request order;
- source mode;
- source counts;
- context bounds;
- R2 calls;
- ingest calls;
- cache HIT/MISS/STALE;
- AQI generation hour;
- response completeness;
- gap status;
- mismatch diagnostics;
- chunk timing;
- visible render order;
- any AQI colour replacement.

Do not invent synthetic success.

If a clear defect is found:

- identify the smallest safe fix;
- prepare one focused PR;
- preserve rollback;
- rerun the affected TEST operation.

Return:

1. deployed versions;
2. flag state;
3. each operational scenario and outcome;
4. cache behaviour;
5. AQI visual stability;
6. failures and fixes;
7. remaining blocker before wider TEST use.
```

---

# Phase 9: Remove embedded duplicate paths after TEST acceptance

## Objective

Simplify the cache proxy only after real TEST operation shows the new service is stable.

## Removal scope

- embedded timeseries stitching;
- embedded AQI-history data orchestration;
- moved data-specific imports;
- moved data-specific variables and secrets;
- obsolete flags;
- obsolete tests.

Retain:

- public gateway route mapping;
- authentication;
- cache and explicit stale fallback;
- Service Binding;
- public diagnostics;
- rollback documentation for the deployed version.

## VS Code Codex prompt

```text
Use GPT-5.6 Terra with High reasoning.

Repository:

TEST-uk-aq/uk-aq-ops

Implement Phase 9 only after TEST operational acceptance has been explicitly recorded.

Do not deploy.
Do not merge.
Do not remove any path still needed for rollback without documenting the replacement.

Remove station-history data orchestration that is now duplicated in `uk-aq-cache-proxy`.

Retain:

- public gateway route mapping;
- session and origin security;
- public cache ownership;
- explicit stale fallback;
- STATION_HISTORY Service Binding;
- cache bypass;
- diagnostics.

Remove only code, variables, secrets and tests proven obsolete by TEST operation.

Update:

- Worker README/system documentation;
- deployment workflow variable lists;
- environment target documentation;
- migration report;
- rollback instructions.

Run affected checks after implementation.

Return:

1. deleted duplicate code;
2. retained gateway responsibilities;
3. removed variables/secrets;
4. documentation updates;
5. checks run;
6. final commit and PR details.

Do not deploy or merge.
```

## 14. Acceptance criteria

The plan is complete when TEST operations show all of the following.

### Architecture

- `uk-aq-station-history` is private.
- `uk-aq-cache-proxy` remains the public gateway.
- public website URLs are stable.
- station-history changes can deploy independently.
- gateway failures and station-history failures are distinguishable in logs.

### Recent data

- ingest observations are fetched once per combined recent request;
- PM context is correctly included;
- context-only rows are excluded from output;
- qualified 12h/24h requests do not touch R2;
- incomplete ingest never produces apparently complete AQI.

### AQI visual stability

- the stable AQI head is merged before browser delivery;
- R2 wins overlap;
- the browser receives one AQI value per hour;
- no colour changes occur during one load because a later R2 chunk disagrees;
- mismatch diagnostics are available operationally;
- older chunks extend backwards only.

### Progressive loading

- AQI renders before observations;
- x-axis is stable;
- AQI chunks load before observation chunks;
- chunks load newest first;
- failed chunks retry independently;
- successful chunks are retained;
- no duplicate rows appear.

### Cache behaviour

- mutable AQI uses hourly generation keys;
- the key represents the finished stable AQI result;
- short recent observation data is not frozen for an hour;
- incomplete responses are not cached as complete;
- stale behaviour is explicit and observable;
- unsupported Cache API stale directives are not relied upon;
- stale responses are bounded and clearly marked.

### Rollback

- each route can return to the previous path during TEST;
- no Supabase or R2 data object is removed by this plan;
- no production cutover occurs without a separate decision.

## 15. Decisions intentionally deferred to TEST evidence

These do not block implementation:

- exact AQI chunk duration;
- exact observation chunk duration;
- exact concurrency;
- exact recent stale maximum;
- exact immutable stale maximum;
- whether any data-specific cache ownership should move into the private Worker;
- final removal date for embedded gateway fallback.

Use configurable defaults, record real TEST payload sizes and timings, then adjust.

## 16. Recommended PR sequence

Use one focused PR per phase where practical:

```text
PR A: modularise existing cache-proxy station-history code
PR B: add private Worker and Service Binding
PR C: combined recent station-series route
PR D: stable AQI head
PR E: historical chunk contracts
PR F: website progressive loader
PR G: explicit stale cache behaviour
PR H: post-TEST cleanup
```

Avoid stacking many unreviewed PRs on one long-lived branch.

Each PR should state:

- exact parent branch;
- feature flags and defaults;
- no deployment performed;
- TEST operational validation still required;
- rollback path;
- checks run;
- contracts changed or preserved.
