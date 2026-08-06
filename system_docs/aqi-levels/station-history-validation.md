# Station-history continuity and calculated AQI validation

## Validation principle

This is a TEST-system change. Perform only the smallest pre-deployment checks needed to establish structural viability. Functional validation happens after deployment through real station-history requests, Worker logs, R2 and the website.

Do not create a broad speculative test suite.

## Required pre-implementation inspection

Before editing, confirm:

1. the binding producer and all binding consumers can support schema versions 1 and 2;
2. existing single-member bindings can remain byte-identical schema version 1 objects;
3. the approved service-only continuity view can be read with least privilege;
4. the station-history fetch entry point receives a Cloudflare execution context supporting `waitUntil`;
5. the exact recent-head and older observation/AQI routes;
6. the complete PM context range available across R2 and ingest;
7. all active website consumers of the shared station-chart modules and any remaining `station-history-loader.js` facade;
8. the current integrity repair-planning and execution gates;
9. the current browser cache contract and compatibility AQI client;
10. the current R2 AQI algorithm-version and comparison fields;
11. the module and page-adapter ownership required by [`../station_charts/contract.md`](../station_charts/contract.md).

These are targeted structural checks, not a pre-deployment operational test programme.

## Minimal local checks

Run only:

- syntax or module-import checks for changed JavaScript, TypeScript and MJS files;
- a Cloudflare Worker build or dry-run check when Worker code changes;
- schema migration and workflow parsing checks when those files change;
- the smallest existing focused binding test;
- one targeted continuity boundary regression only if required to protect a high-risk selection rule;
- one directly relevant existing response parser, AQI comparator or shared station-chart helper check when affected.

Do not run:

- broad repository test suites;
- Supabase SQL against TEST or LIVE;
- R2 writes or broad comparisons;
- integrity or backfills;
- deployments;
- browser automation;
- external source fetches.

## Binding structural cases

### Exact-only binding

A single-member series without authoritative continuity remains:

```text
schema_version=1
no continuity field
```

Its proposed JSON must be byte-identical to the current object.

### Multi-member family

For BPLE PM2.5, the schema-version-2 family must contain:

```text
285 valid through 2026-05-17
212 valid from 2026-05-18
```

Both `timeseries_id=285.json` and `timeseries_id=212.json` contain the same deterministic family, while retaining their own exact physical top-level identities.

### Churn check

A continuity-view refresh with the same stable identity, references and validity dates must produce:

```text
changed_binding_count=0
binding_put_count=0
```

A first-time multi-member enrichment may change only the affected family member bindings.

A broad rewrite of single-member bindings is a failure.

### Invalid family cases

The builder must reject:

- overlapping validity intervals;
- conflicting `site_ref` within one family;
- mixed connector or pollutant identity;
- duplicate timeseries membership;
- one physical timeseries in two families;
- more than one open-ended member;
- missing top-level member in its nested family.

## Continuity selection cases

### Historical-only interval

A request for current BPLE PM2.5 timeseries `212` covering 2026-01-01 must route observations to physical timeseries `285`.

### Current-only interval

A request after 2026-05-18 must route to physical timeseries `212`.

### Transition interval

A request spanning the boundary must split at the date-valid transition and merge both physical streams without duplicate timestamps.

### Gap

A real validity gap must remain an incomplete response and visible gap.

### Overlap conflict

Overlapping members or different valid values for one timestamp must not be resolved silently.

## AQI deterministic cases

### Hour-ending interval

For endpoint:

```text
n = 2026-07-17T07:00:00Z
```

Required represented interval:

```text
06:00 to 07:00
```

The renderer must not colour 07:00 to 08:00.

### Request boundary

For represented interval:

```text
S=2026-07-17T06:00:00Z
E=2026-07-17T09:00:00Z
```

Required endpoints:

```text
07:00
08:00
09:00
```

### PM context across transition

For a PM endpoint shortly after the physical identity changes, the rolling input may contain observations from both members.

Required behaviour:

- 24 valid hourly means ending at `n` produce DAQI status `ok`, source count 24 and required count 18;
- 18 valid hourly means produce DAQI status `ok`, source count 18 and required count 18;
- 17 valid hourly means produce DAQI `insufficient_samples`;
- a valid hourly mean at `n` may still produce European AQI `ok` when DAQI is insufficient;
- a missing hourly mean at `n` produces European AQI `missing_input`, while DAQI may remain `ok` with at least 18 valid rolling values;
- the physical transition itself must not reset logical rolling context.

### Missing hourly PM observation

For a missing PM hourly observation at endpoint `n`:

- the European AQI interval ending at `n` remains uncoloured;
- PM DAQI remains coloured when at least 18 valid values are present in the rolling 24-hour window;
- PM DAQI remains uncoloured when fewer than 18 values are present;
- no value from either index may be stretched from a neighbouring interval.

### Settled AQI gaps and source switching

For a successfully evaluated, parseable and authoritative-identity-valid requested interval containing missing observations, excluded invalid inputs, insufficient samples, unfamiliar diagnostic strings or no valid AQI row for some hours:

- cache all valid AQI rows;
- preserve partial, status and missing-reason diagnostics;
- record unfamiliar diagnostics through bounded chart diagnostics;
- leave uncalculable index intervals blank;
- retain a valid PM DAQI interval when European AQI for the same endpoint is missing;
- record the requested interval as settled for browser request planning without labelling the response complete;
- do not use an exhaustive browser allow-list of Worker diagnostic strings as a visible-success condition;
- do not show a chart-wide user-facing incomplete or error message for the AQI-only outcome;
- after switching away and back, reuse the settled cache rather than issuing the same AQI request again;
- commit the cached AQI layer once after the approximately 50 millisecond source-change transition.

A network, HTTP, parsing, identity or unsafe replacement-conflict failure remains unsettled and retryable. When the observation chart remains usable, an AQI-only failure must leave the AQI layer blank or use an AQI-local unavailable state. It must not use the chart-wide red error banner.

## Stored-R2 validation cases

For each immutable comparable hour:

1. resolve the physical timeseries valid for that hour;
2. compare the calculated row with stored R2 AQI under that physical ID;
3. compare algorithm version before values;
4. classify `aqilevels_hourly_v1` versus `aqilevels_hourly_v2` as `not_comparable_algorithm_version`;
5. compare exact discrete fields only when versions match;
6. apply only the approved numeric tolerance;
7. report missing and mismatched rows separately.

Expected matching summary:

```text
status=match
mismatch_count=0
missing_in_r2_count=0
missing_in_calculated_count=0
not_comparable_count=0
```

A validation read failure or mismatch must not alter the foreground response or visible chart.

## TEST deployment order

For the DAQI completeness correction on an already established continuity/calculated-history TEST deployment:

1. deploy the updated station-history Worker bundle containing the shared helper;
2. leave cache-proxy routing and feature flags unchanged;
3. confirm the response reports `algorithm_version=aqilevels_hourly_v2`;
4. validate one real PM observation gap in the chart;
5. keep any historical AQI rebuild separate.

For a new continuity deployment, retain the broader order:

1. Apply the service-only continuity view.
2. Deploy schema-version-2 binding producer and readers with continuity disabled.
3. Run binding reconciliation dry-run.
4. Confirm family-scoped proposed churn.
5. Write and verify changed TEST binding objects.
6. Deploy station-history compatibility support.
7. Deploy the website combined-response consumer through the shared station-chart client/controller boundary.
8. Enable continuity.
9. Enable calculated historical AQI.
10. Enable validation mode `all`.
11. Keep historical identity repair disabled.

## Real TEST operational validation

### 1. Known PM observation gap

Open the Peterborough Garton End PM2.5 chart across the short observation gap on 2 August 2026.

Confirm:

- the concentration line retains its real missing observations;
- European AQI has the corresponding hourly gap;
- PM DAQI remains present throughout hours where at least 18 of the preceding 24 hourly means are valid;
- the first endpoint with fewer than 18 valid rolling values, if any, is blank for DAQI;
- no DAQI or European AQI value is carried into a neighbouring interval;
- the response reports `algorithm_version=aqilevels_hourly_v2`;
- PM rows report `daqi_required_observation_count=18`.

### 2. Known transition

Open a PM2.5 chart spanning the BPLE transition.

Confirm:

- the website sends only `timeseries_id=212`;
- the Worker resolves `285` and `212`;
- old rows retain physical ID `285`;
- new rows retain physical ID `212`;
- the concentration line is continuous where source data is continuous;
- no duplicate or conflicting timestamps appear;
- PM rolling context crosses the transition;
- calculated DAQI and European AQI arrive with the observation response;
- no normal blocking historical AQI request is made for the combined chunk;
- the final coloured band aligns with its final valid endpoint;
- one bounded validation event is emitted.

### 3. Normal single-member series

Confirm:

- schema-version-1 exact binding still works;
- no continuity lookup behaviour is required;
- unrelated chart and AQI values remain unchanged;
- no broad binding churn occurred.

### 4. Compatibility fallback

Disable the calculated-history feature and confirm the retained separate R2 AQI source works through the same shared chart controller, cache, AQI-source controller and renderer without a code rollback.

Existing R2 rows may remain algorithm version v1 until rebuilt. They must not be compared as ordinary matching v2 rows.

Disable continuity and confirm exact requested-timeseries behaviour is restored.

### 5. AQI source with authoritative blank intervals

On an already displayed multi-sensor chart, choose an AQI source known to contain genuine observation or rolling-sample gaps.

Confirm:

- the old AQI layer clears immediately;
- valid bands for the new source appear in one visible commit;
- uncalculable index intervals remain blank;
- valid DAQI can coexist with a blank European AQI interval;
- no chart-wide incomplete-AQI or AQI-update error is shown;
- retained observation lines are neither refetched nor repainted;
- switching away and back reuses the settled AQI cache;
- the repeated switch normally completes in about 50 milliseconds and does not repeat the same AQI network work;
- resize changes geometry only and does not create or clear AQI request ownership.

Separately force or observe one genuine AQI-only request failure and confirm it remains retryable, leaves the observation chart usable, does not use the chart-wide red error banner and is represented only by bounded diagnostics or an AQI-local unavailable state.

### 6. Shared frontend ownership

Confirm:

- Hex Map and Sensors use the same active station-chart controller and renderer modules;
- compatibility mode changes only the data client;
- one controller instance and one page-adapter listener set exist per mounted chart;
- no old inline controller also handles the same event;
- AQI-only switching does not activate full-chart loading state.

## Integrity enablement validation

Only after the transition chart succeeds:

1. run one targeted integrity dry-run for the historical rollover day;
2. confirm source mapping remains successful;
3. confirm source/R2 mismatch evidence shows source `285` and R2 `212`;
4. confirm repair is still non-executable without the explicit gate;
5. enable the TEST gate for one targeted repair;
6. perform the repair and targeted index rebuild through normal manual operations;
7. re-run integrity;
8. confirm the website still returns complete logical history while old rows now retain the correct physical identity.

The PM DAQI completeness change itself does not require an Integrity run before deployment. Any historical AQI rebuild or repair remains a separate operation.

## Acceptance criteria

Initial TEST acceptance requires:

1. one successful PM gap chart showing DAQI retained where at least 18 rolling values exist and European AQI blank at missing hourly endpoints;
2. one successful multi-member transition chart where continuity is in scope;
3. one successful ordinary single-member chart;
4. one matching or bounded actionable R2 validation event, with algorithm-version differences classified as not comparable;
5. no broad binding ETag churn;
6. no blocking stored-R2 AQI request on the calculated path;
7. correct PM context across identity transitions;
8. correct hour-ending band rendering;
9. independent observation, DAQI and European AQI availability;
10. authoritative index-specific gaps remain blank without a chart-wide user-facing warning;
11. successfully evaluated AQI intervals are reused on later source switches;
12. Hex Map and Sensors use the shared controller, cache and renderer;
13. compatibility mode uses the shared frontend architecture;
14. historical repair remains disabled until deliberately enabled;
15. no R2 writes are caused by chart requests.

## Rollback validation

Configuration rollback order:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=off
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=false
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED=false
```

A code rollback restores the archived v1 helper and station-history calculator together. Do not mix the v1 calculator with the v2 contract or validation expectations.

Confirm the website returns to the retained compatibility data client through the same shared station-chart controller and renderer. Do not rewrite corrected historical R2 identity merely to roll back chart behaviour.
