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
7. all active website consumers of `station-history-loader.js`;
8. the current integrity repair-planning and execution gates;
9. the current browser cache contract and separate AQI request fallback;
10. the current R2 AQI algorithm-version and comparison fields.

These are targeted structural checks, not a pre-deployment operational test programme.

## Minimal local checks

Run only:

- syntax/type checks for changed JavaScript, TypeScript and MJS files;
- a Cloudflare Worker build or dry-run check;
- schema migration and workflow parsing checks;
- the smallest existing focused binding test;
- one targeted continuity boundary regression only if required to protect a high-risk selection rule;
- one directly relevant existing response parser or AQI comparator check when already present.

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

- 24 valid hourly means ending at `n` produce DAQI status `ok`;
- 23 valid hourly means produce DAQI `insufficient_samples`;
- a valid hourly mean at `n` may still produce European AQI `ok`;
- the physical transition itself must not reset logical rolling context.

### Missing hour

A missing endpoint remains uncoloured. Neither neighbouring AQI value may span it.

## Stored-R2 validation cases

For each immutable comparable hour:

1. resolve the physical timeseries valid for that hour;
2. compare the calculated row with stored R2 AQI under that physical ID;
3. compare algorithm version before values;
4. compare exact discrete fields;
5. apply only the approved numeric tolerance;
6. report missing and mismatched rows separately.

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

1. Apply the service-only continuity view.
2. Deploy schema-version-2 binding producer and readers with continuity disabled.
3. Run binding reconciliation dry-run.
4. Confirm family-scoped proposed churn.
5. Write and verify changed TEST binding objects.
6. Deploy station-history compatibility support.
7. Deploy the website combined-response consumer.
8. Enable continuity.
9. Enable calculated historical AQI.
10. Enable validation mode `all`.
11. Keep historical identity repair disabled.

## Real TEST operational validation

### 1. Known transition

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
- the final coloured band aligns with the final concentration endpoint;
- one bounded validation event is emitted.

### 2. Normal single-member series

Confirm:

- schema-version-1 exact binding still works;
- no continuity lookup behaviour is required;
- chart and AQI values remain unchanged except for the approved combined-response/rendering change;
- no broad binding churn occurred.

### 3. Compatibility fallback

Disable the calculated-history feature and confirm the retained separate R2 AQI path works without a code rollback.

Disable continuity and confirm exact requested-timeseries behaviour is restored.

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

## Acceptance criteria

Initial TEST acceptance requires:

1. one successful multi-member transition chart;
2. one successful ordinary single-member chart;
3. one matching or bounded actionable R2 validation event;
4. no broad binding ETag churn;
5. no blocking stored-R2 AQI request on the calculated path;
6. correct PM context across the identity transition;
7. correct hour-ending band rendering;
8. independent observation and AQI completeness;
9. historical repair still disabled until deliberately enabled;
10. no R2 writes caused by chart requests.

## Rollback validation

Configuration rollback order:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=off
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=false
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED=false
```

Confirm the website returns to the retained compatibility path. Do not rewrite corrected historical R2 identity merely to roll back chart behaviour.
