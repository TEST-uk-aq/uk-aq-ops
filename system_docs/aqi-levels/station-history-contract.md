# Station-history continuity and calculated AQI contract

## Authority

This is the specific authoritative contract for station-history continuity, calculated chart AQI and asynchronous stored-R2 validation.

For this station-history display path, it deliberately amends the broader source-precedence wording in [`contract.md`](contract.md), [`data-flow.md`](data-flow.md), [`interfaces.md`](interfaces.md) and [`validation.md`](validation.md).

Those broader files remain authoritative for breakpoints, averaging, canonical AQI rows, persisted AQI history, low-level R2 reads, timestamp semantics and behaviour not explicitly changed here.

The shared browser architecture, cache ownership, AQI-source controller, renderer and page-adapter boundaries are defined by [`../station_charts/contract.md`](../station_charts/contract.md). That frontend contract deliberately replaces older assumptions that chart orchestration may live directly in page inline code or in separate calculated and compatibility chart controllers.

## Purpose

The website must render one continuous station/pollutant chart even when the physical station or timeseries identity changes.

Visible AQI bands must be calculated from the same authoritative observation rows used to draw the concentration line. Stored R2 AQI remains an independent materialised result used for non-blocking validation.

## Request identity

The website continues to request one current active timeseries:

```text
connector_id
timeseries_id
pollutant
start_utc
end_utc
```

It does not send predecessor IDs, query continuity metadata or contain SOS-specific mapping rules.

## Continuity authority

The station-history Worker resolves the request through:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

Schema version 1 means exact single-timeseries behaviour.

Schema version 2 retains the exact physical top-level binding and adds the complete date-valid multi-member logical family.

The family contract is defined by [`../r2_history/continuity.md`](../r2_history/continuity.md).

## Physical and logical identity

The logical family is identified by:

```text
connector_id + uk_air_ref + pollutant_code
```

Returned rows retain the physical identity valid at the row's time:

```text
station_id
timeseries_id
```

The request identity and logical continuity key are separate response metadata. The Worker must not rewrite historical rows to the current physical ID.

## Date-valid physical selection

The Worker selects each physical member using inclusive validity dates:

```text
valid_from_day_utc <= day_utc
and
(valid_to_day_utc is null or day_utc <= valid_to_day_utc)
```

Selection covers both:

- the visible observation interval;
- any preceding context required to calculate AQI.

A gap remains incomplete. An overlap is an identity conflict. Neither may be silently hidden.

## Exact low-level history boundary

The private observations and AQI R2 APIs remain exact physical readers.

The station-history Worker may issue multiple bounded physical requests, but each low-level request contains one exact physical `timeseries_id` and returns only rows physically stored under that identity.

The low-level APIs do not follow continuity, query Supabase or relabel rows.

## Authoritative chart observation stream

The station-history Worker builds one deterministic logical observation stream from:

1. committed exact physical R2 observations;
2. recent ingest observations used only to fill R2-missing recent timestamps under the existing seam rules.

For the same exact physical timestamp, R2 observation precedence remains unchanged.

The merge must:

- sort deterministically;
- remove exact duplicates deterministically;
- retain physical identity;
- reject or explicitly mark incomplete conflicting overlapping values;
- keep required calculation context outside the visible output;
- preserve observation completeness independently from AQI completeness.

## Calculated AQI render source

When the calculated-history feature is enabled, visible station-chart AQI is calculated from the merged authoritative observation stream.

The shared implementation remains:

```text
lib/aqi/aqi_levels.mjs
```

The browser must not calculate DAQI or European AQI.

The calculated chart path must preserve:

- supported pollutants `pm25`, `pm10`, `no2`;
- current breakpoint values and inclusive upper-bound rule;
- NO2 hourly DAQI;
- PM2.5 and PM10 rolling 24-hour DAQI;
- the 18-of-24 minimum valid-hour rule for PM DAQI;
- hourly European AQI;
- independent DAQI and European AQI statuses;
- negative/invalid input exclusion;
- algorithm version `aqilevels_hourly_v2`;
- deterministic sorting and calculation.

## PM context across identity transitions

For a PM AQI endpoint `n`, the possible rolling input endpoints are:

```text
n - 23 hours, ..., n - 1 hour, n
```

At least 18 valid hourly values are required. The mean uses the available valid values only. Missing hours are not imputed.

Those observations may span two physical family members.

The Worker must combine the date-valid physical observations into one logical stream before calculating AQI. It must not calculate each member independently and lose rolling context at the transition.

Context may contribute to calculation but must not be returned as a visible observation or AQI point outside the requested output interval.

## Canonical timestamp and rendering

`timestamp_hour_utc`, denoted `n`, remains the canonical interval endpoint.

```text
period_start_utc = n - 1 hour
period_end_utc   = n
represented interval = (period_start_utc, period_end_utc]
```

For requested represented interval `S` to `E`, return endpoints:

```text
S < n <= E
```

The website draws each DAQI and European AQI band from `n - 1 hour` to `n`.

Missing output is index-specific. At a PM endpoint with no hourly observation:

- European AQI is missing and its band remains blank;
- PM DAQI may remain valid when at least 18 of the 24 rolling hourly values are available;
- PM DAQI is missing when fewer than 18 valid rolling hours are available.

A valid band for one index must not be stretched into a neighbouring hour and must not be removed merely because the other index is unavailable. The final coloured band for each index ends at its final valid endpoint and must not extend one hour beyond that endpoint.

A missing AQI value caused by absent observations, excluded invalid inputs or insufficient calculation samples is normal blank output. It must not be stretched across neighbouring hours, replaced from stored AQI or presented as a user-facing error solely because no band can be calculated for that hour.

## Combined response contract

The station-series response must contain independently complete sections equivalent to:

```json
{
  "schema_version": 2,
  "request": {
    "connector_id": 1,
    "requested_timeseries_id": 212,
    "pollutant": "pm25",
    "start_utc": "2026-01-01T00:00:00.000Z",
    "end_utc": "2026-07-01T00:00:00.000Z"
  },
  "continuity": {
    "enabled": true,
    "continuity_key": "1:UKA00574:pm25",
    "site_ref": "BPLE",
    "uk_air_ref": "UKA00574",
    "members": []
  },
  "observations": {
    "rows": [],
    "response_complete": true,
    "has_gap": false,
    "gap_ranges": [],
    "source_segments": []
  },
  "aqi": {
    "enabled": true,
    "calculation_source": "calculated_from_observations",
    "algorithm_version": "aqilevels_hourly_v2",
    "rows": [],
    "response_complete": true,
    "has_gap": false,
    "gap_ranges": [],
    "required_context_start_utc": "2025-12-31T01:00:00.000Z",
    "output_start_utc": "2026-01-01T00:00:00.000Z",
    "output_end_utc": "2026-07-01T00:00:00.000Z"
  }
}
```

The exact field arrangement may follow established Worker conventions, but these meanings are contract-bearing.

Every returned observation and calculated AQI row retains its actual physical timeseries and station identity.

## Foreground source precedence

For the calculated-history station-chart path:

1. authoritative merged observations are the visible line source;
2. AQI calculated from those exact observations is the visible band source;
3. stored R2 AQI does not replace, delay or redraw the visible bands;
4. a calculation gap remains a visible gap;
5. HTTP 200 does not by itself mean complete observation or AQI coverage.

This is the approved exception to the older rule that committed R2 AQI wins visible station-history overlaps.

The older separate foreground R2 AQI path remains a compatibility data source only while the calculated-history feature is disabled or an older response contract is received. It must use the same shared browser controller, cache, AQI-source controller and renderer.

## Stored R2 AQI validation

Stored R2 AQI remains an independently materialised validation artefact.

After preparing the foreground response, the Worker schedules validation through the Cloudflare execution context, normally:

```text
ctx.waitUntil(...)
```

Validation must not delay or alter the response.

It must compare the calculated row against the stored row whose physical timeseries is date-valid for that hour.

Comparable row identity is:

```text
connector_id
timeseries_id
pollutant_code
timestamp_hour_utc
```

Compare `algorithm_version` first. A version mismatch is:

```text
not_comparable_algorithm_version
```

It is not an ordinary AQI mismatch.

Compare exact discrete fields:

```text
daqi_index_level
eaqi_index_level
daqi_calculation_status
eaqi_calculation_status
daqi_missing_reason
eaqi_missing_reason
daqi_input_averaging_code
eaqi_input_averaging_code
daqi_source_observation_count
daqi_required_observation_count
eaqi_source_observation_count
eaqi_required_observation_count
hourly_sample_count
```

Compare numeric inputs using an explicit tolerance that permits only storage serialisation noise. The provisional maximum is:

```text
0.000001 µg/m³
```

Validation records separately:

- calculated row missing in R2;
- stored row missing in calculated output;
- overlapping value/status mismatch;
- mutable or incomplete exclusion;
- algorithm-version exclusion.

## Validation execution boundary

Only immutable and sufficiently complete ranges may be compared.

A validation timeout, R2 read failure, mismatch or algorithm-version difference:

- does not fail the chart request;
- does not alter visible AQI;
- does not trigger an automatic repair;
- is recorded through bounded diagnostics.

Emit one bounded summary event per validated chunk and, when mismatches exist, one bounded detail event with a limited hour sample.

Do not log entire observation or AQI histories.

## Website consumer

The website must consume this data through the shared station-chart architecture in [`../station_charts/contract.md`](../station_charts/contract.md).

The shared controller and clients must:

- keep sending one current timeseries ID;
- consume observations and calculated AQI from the combined response;
- render each combined chunk progressively except where the atomic AQI source-switch contract explicitly suppresses incremental AQI repainting;
- stop the normal separate historical AQI request when the new response is available and enabled;
- retain the compatibility data source for older or disabled responses behind the same client interface;
- never wait for background validation;
- never redraw because validation completes;
- preserve bounded abort, stale fallback, cache and progressive loading behaviour;
- bump the browser storage/cache contract when incompatible cache semantics change;
- distinguish response completeness from whether a successful requested interval is settled for browser source-switch planning;
- reuse successfully evaluated AQI intervals on later source switches even when their valid output contains blank hours;
- avoid a user-facing incomplete or chart-wide AQI error for partial, blank or unfamiliar AQI diagnostic values;
- keep AQI-only transport, parsing, identity and replacement failures local to the AQI layer while the observation chart remains usable;
- use one controller, cache, AQI-source controller and renderer across Hex Map, Sensors and compatibility mode.

The browser must not expose continuity mechanics as a requirement to users.

## Completeness and browser settlement

Observation and AQI completeness remain independent.

A response must be partial or incomplete when any required condition is unresolved, including:

- missing continuity member;
- validity gap;
- overlapping conflicting members;
- missing exact physical R2 index context;
- scan-budget exhaustion;
- fewer than 18 valid hourly values for a required PM rolling endpoint;
- unresolved source seam;
- malformed binding identity.

A partial response must not be cached or labelled as complete.

Browser request planning nevertheless uses a separate settlement decision.

A calculated AQI response is settled for its requested browser range when:

- the HTTP request succeeded;
- the response is parseable;
- the authoritative identity is valid;
- the AQI section has the required structural shape;
- no unsafe replacement conflict exists.

It may remain incomplete and retain all gap, partial, calculation-status and missing-reason diagnostics.

Missing AQI values remain blank. A previously unseen calculation status, missing reason or partial reason is bounded diagnostic evidence and does not by itself make an otherwise usable successful response a browser hard failure.

A successfully evaluated AQI interval must not be repeatedly refetched solely because blank hours or unfamiliar diagnostics exist. It must not produce a chart-wide user-facing AQI warning or error.

A network, HTTP, parsing, identity or unsafe replacement-conflict failure does not establish authoritative browser settlement. It remains retryable. When the observation chart remains usable, it may produce an AQI-local unavailable state but not the page-wide red chart error banner.

## Feature flags

The implementation must provide controls equivalent to:

```text
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT
```

Validation modes are:

```text
off
all
sample
```

Safe repository defaults remain disabled unless established TEST conventions require otherwise.

The features must not be enabled automatically in LIVE as part of the TEST implementation.

Disabling calculated rendering switches the shared station-chart controller to the compatibility data client. It must not activate a second frontend controller or renderer.

## Integrity repair dependency

Historical physical-identity correction must remain disabled until this station-history contract is deployed and operationally confirmed.

Once confirmed, integrity may correct R2 observations and AQI to the date-valid physical identity while the website continues requesting the current family member.

Repair gating is defined in the R2 history and Integrity contracts.

## Explicit non-goals

This contract does not:

- make stored R2 AQI disposable;
- recreate AQI rows in Supabase;
- let chart requests write R2;
- change AQI breakpoints;
- add pollutants;
- make low-level R2 APIs continuity-aware;
- make the browser query continuity metadata;
- introduce a second public calculation route;
- activate daily or monthly AQI roll-ups;
- add a second browser chart controller for compatibility mode;
- enable historical identity repair in LIVE.
