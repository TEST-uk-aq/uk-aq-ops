# Binding and station-history interfaces

## Private binding route

The observations R2 API exposes authenticated:

```text
GET /v1/timeseries-binding?timeseries_id=<id>
```

It returns the exact stable binding object stored at:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

The route does not add daily observation or AQI coverage.

## Supported binding response versions

Consumers must support:

- schema version 1: exact physical binding only;
- schema version 2: the same exact physical top-level binding plus a validated nested `continuity` family.

A consumer must not reject a schema-version-1 binding merely because continuity support is enabled. Absence of `continuity` means retain exact single-timeseries behaviour.

## Schema-version-2 continuity response

The nested section contains:

```text
schema_version
source
continuity_key
site_ref
uk_air_ref
pollutant_code
members
```

Each member contains:

```text
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
```

The response must preserve the requested binding's exact physical identity at the top level. The logical family must not replace or relabel it.

## Station-history routes

The private station-history Worker exposes:

```text
GET /v1/station-series
GET /v1/observations-history
GET /v1/aqi-history
```

The website normally reaches these through the public cache API routes. Public route naming may differ, but it must preserve the behaviour defined here.

`/v1/station-series` returns the recent stable head.

`/v1/observations-history` returns an older requested range and is the normal historical route after calculated AQI is enabled.

`/v1/aqi-history` is the exact stored-R2-AQI route. After the calculated-AQI cutover, the normal website loader must not use it. It remains available for validation, diagnostics and temporary rollback.

## Requested response parts

Station-history requests must support independently requesting visible observations and calculated AQI:

```text
include_observations=true|false
include_aqi=true|false
```

The website must send these explicitly. A compatibility default may be retained for older callers, but new website behaviour must not depend on an implicit default.

A request with both values false is invalid.

The calculated-history feature flag means that calculated AQI is available and permitted. It must not force AQI calculation for a request that sets `include_aqi=false`.

Required combinations are:

```text
primary AQI source:
  include_observations=true
  include_aqi=true

secondary observation load:
  include_observations=true
  include_aqi=false

secondary AQI prefetch:
  include_observations=false
  include_aqi=true
```

For an AQI-only response, the Worker still reads the observation rows required for calculation, but it must not transfer duplicate visible observation rows to the website.

The Worker and website must not assume that request-local Worker memory survives between requests. Cross-request cache reuse is permitted, but correctness must not depend on a previous request having populated Worker memory.

## Combined observation and calculated-AQI response

When both response parts are requested, one station-history request returns:

```text
continuity
identity
source diagnostics
observations
aqi
```

The Worker must:

1. resolve the exact requested binding;
2. validate the supplied connector and pollutant;
3. select date-valid physical continuity members;
4. read each required physical observation segment once within that request;
5. merge the physical observation rows deterministically;
6. calculate AQI from that same merged observation set;
7. return visible observations and calculated AQI together.

The normal calculated response must not read stored R2 AQI. Stored R2 AQI is validation evidence, not the normal response source.

For the requested visible interval, the response ranges must align:

```text
observations output: requested visible start to requested visible end
AQI output:         requested visible start to requested visible end
```

PM2.5 and PM10 calculation may require up to 23 preceding hours of hidden observation context. That context:

- is selected through the same date-valid continuity family;
- is used only for calculation and completeness;
- must not be returned as visible observation rows outside the requested interval;
- must not extend the displayed chart range.

## Independent completeness

The response must preserve independent state for each requested output:

```text
observations.enabled
observations.response_complete
observations.has_gap
observations.partial_reasons

aqi.enabled
aqi.response_complete
aqi.has_gap
aqi.partial_reasons
```

Missing AQI context must not falsely mark otherwise complete visible observations as incomplete.

The website may render complete observations while leaving an incomplete calculated-AQI interval blank. It must not invent AQI coverage or fill gaps from stored AQI silently.

An absent AQI row because source observations are missing, invalid or insufficient for the required calculation is a valid blank chart interval. It is not by itself evidence that the request was not fetched or that the AQI service failed. Calculation status and missing-reason diagnostics must remain available where the response provides them.

## Website initial-load priority

For selected sensors, the required user-visible priority is:

1. Request the primary AQI source sensor with observations and calculated AQI together.
2. Render that sensor's observations and AQI as soon as its newest response is eligible to commit.
3. Request and render observation data for the second selected sensor.
4. Request and render observation data for the third and fourth selected sensors in the same way.
5. Prefetch calculated AQI for the second sensor without rendering it.
6. Prefetch calculated AQI for the third and fourth sensors without rendering it.

Steps 3 and 4 may run concurrently within the global limit. Their observation work must have priority over background AQI prefetch.

The purpose of secondary AQI prefetch is to make a later AQI-source switch immediate or nearly immediate, including on a 90-day chart.

For historical ranges, the same priority applies per chunk:

```text
highest priority: primary combined observation + AQI chunks
next priority:    secondary observation chunks
lowest priority:  secondary calculated-AQI-only prefetch chunks
```

A secondary AQI prefetch chunk becomes eligible after its matching observation chunk has been accepted into the website cache. It may use spare concurrency immediately, but it must not displace queued primary combined work or secondary observation work.

## Parallel fetching and ordered settlement

Network fetching, cache settlement and visible rendering are separate concerns.

For normal progressive station-history work, the website must:

1. build missing work newest first;
2. launch a bounded set of requests in parallel immediately;
3. allow requests to complete in any order;
4. hold out-of-order completions in an ordered settlement buffer;
5. commit and render each normal progressive stream from most recent to oldest;
6. coalesce repeated visible commits to no more than one chart repaint per animation frame where practical.

The normal progressive rule applies to initial chart loading, observation-line loading, range extension and any other operation not explicitly covered by the AQI source-switching exception below.

The website must not wait for the newest chunk to finish before launching older chunks. The ordered settlement buffer, not serial network fetching, provides the newest-to-oldest settlement guarantee.

Example completion order:

```text
chunk 2 completes
chunk 1 completes
chunk 0 completes
```

Required settlement order:

```text
chunk 0
chunk 1
chunk 2
```

Once chunk 0 completes, already-finished contiguous chunks may be settled immediately in sequence.

AQI-only work for a user-initiated AQI source switch is an explicit visible-rendering exception. Its chunks still use bounded parallel fetching and ordered settlement, but they must be settled into cache or transition staging without repainting the visible AQI layer after each chunk. The visible AQI layer is committed once when the current source-switch transition reaches a terminal state as defined under **AQI source switching**.

All station-history work must share a bounded global fetch cap. Per-stream concurrency limits may be used, but their combined activity must not exceed that cap.

## Cache contract

The website keeps observation and calculated-AQI state separately for each authoritative sensor identity, connector, pollutant and range.

For calculated AQI, browser state must distinguish:

```text
response completeness and diagnostics
request settlement and retry eligibility
available calculated AQI rows
```

A complete successful AQI response is settled for its requested interval.

A terminal AQI response that successfully evaluated the requested interval may also be settled for request planning when missing AQI values are authoritative consequences of source-observation gaps, invalid excluded inputs or insufficient calculation samples, including incomplete PM rolling context. The website must cache all valid AQI rows, retain the partial and missing-reason diagnostics, and leave the affected chart intervals blank. It must not label that response complete.

A settled terminal partial interval must not be repeatedly refetched solely because some AQI rows are absent. Selecting or reselecting that sensor as the AQI source must reuse the settled cache, including its authoritative blank intervals.

A request, service, parsing, identity or physical-read failure remains unsettled and retryable. Cancellation, scan-budget exhaustion or another response condition that does not establish an authoritative result for the requested interval also remains unsettled and retryable.

Secondary calculated AQI may be retained in cache without being rendered. Selecting that sensor as the AQI source must use settled cached AQI immediately after the required source-change transition.

A cached observation range does not by itself prove that calculated AQI is settled. AQI request settlement includes any required hidden context and must be tracked independently.

The website must not display a user-facing incomplete or error message solely because a settled AQI interval contains authoritative blank hours. An error message is reserved for an actual request, service or identity failure that prevents accurate settlement.

Requests must use stable URLs and parameters for normal traffic so Cloudflare caching can serve warm hits. Cache-buster parameters are limited to diagnostics and explicit forced refreshes.

## AQI source switching

When the user chooses a different selected sensor for AQI bands, the website must treat the operation as one atomic visible AQI-layer transition:

1. leave all observation lines and retained non-AQI chart layers in place;
2. create or advance a source-switch transition token identifying the selected sensor, requested range and current load generation;
3. immediately remove the previous sensor's AQI bands so stale bands are never shown under the new selection;
4. show an intentionally blank/loading AQI band area for approximately 50 milliseconds;
5. if calculated AQI for the new source and requested range is already settled in cache, including any authoritative blank intervals, render that cached result once after the brief transition;
6. otherwise keep the AQI area blank/loading while unsettled AQI work is fetched using the existing bounded concurrency, priority and ordered-settlement rules;
7. settle each valid response into AQI cache or transition staging while preserving independent response-completeness, request-settlement, gap and partial-reason metadata;
8. do not repaint the visible AQI layer as individual AQI chunks settle for that transition;
9. regard the transition as terminal only when all AQI requests planned for the current selected source and requested range have completed, failed, been cancelled or been made obsolete;
10. when the current transition reaches a terminal state with the target range settled, commit the new source's available AQI bands to the visible AQI layer once;
11. leave every hour without a valid calculated AQI value blank, including hours with missing observations, invalid excluded inputs or insufficient rolling samples;
12. do not show a user-facing incomplete or error message solely because settled AQI contains those authoritative blank intervals;
13. show an AQI update error only when an actual request, service or identity failure prevents accurate settlement, and leave that failed interval retryable;
14. never mix AQI points from the previous and new source in one visible AQI layer;
15. never show the previous sensor's bands under the newly selected sensor;
16. invalidate the visible commit of an older transition when the user changes AQI source again, changes the requested range or starts a newer incompatible load generation;
17. allow valid obsolete responses to improve their own sensor's cache where safe, but never allow an obsolete response or transition token to become visible;
18. never refetch or repaint retained observation lines solely because the AQI source changed.

The atomic requirement applies to the visible AQI-layer commit, not to network execution. Missing chunks should continue to fetch in parallel and settle newest-to-oldest. The website must not implement this behaviour by serialising requests, adding an arbitrary long delay or recalculating AQI in browser code.

The approximately 50 millisecond blank state is a user-interface transition, not a minimum network delay. It confirms that the selected AQI source changed and prevents the previous sensor's bands appearing to belong to the new sensor.

When the selected range is already settled in AQI cache, the transition should normally finish in about 50 milliseconds even when the cached result contains authoritative blank intervals. A first uncached or genuinely retryable range may take longer while required network work completes. Once that range settles, later switches must reuse it rather than repeating the same work.

This exception does not remove progressive rendering from initial chart loading, observation loading, range extension or background secondary AQI prefetch. It applies only to changing the AQI source on an already displayed chart.

## Runtime continuity routing

Normal station-history routing is:

1. receive requested `connector_id`, `timeseries_id`, pollutant and range;
2. fetch the exact stable binding;
3. validate supplied connector and pollutant against the physical binding;
4. validate and use the nested family when present;
5. select date-valid physical members for the visible range and any AQI-context range;
6. issue bounded exact requests to low-level observation history APIs;
7. merge only inside the private station-history Worker;
8. calculate AQI from the merged observations when requested;
9. return only the response parts requested by the website.

The website sends only one current timeseries ID for each sensor. It does not receive a separate public continuity API and does not query Supabase continuity data directly.

## Exact low-level API boundary

The observations and AQI R2 APIs continue to interpret `timeseries_id` physically.

They return only rows stored under the requested physical ID. They do not follow the continuity family and do not call Supabase to discover related IDs.

The station-history Worker may call the exact observations R2 API for multiple physical members and merge them logically. The low-level API itself remains exact.

## Stored AQI validation

Calculated AQI validation against stored R2 AQI is asynchronous and must not delay or replace the normal website response.

Validation may compare immutable calculated intervals with `/v1/aqi-history`, log mismatches and produce diagnostics. It must not cause the website to display stored AQI in preference to calculated AQI.

After the TEST comparison period is complete, calculated AQI remains enabled and normal validation may be reduced or disabled without changing the website response contract.

## Failure behaviour

The binding route and station-history consumer must fail closed or return an explicitly incomplete response when:

- schema version 2 is malformed;
- the top-level timeseries is absent from the family;
- connector, pollutant or UK-AIR identity conflicts;
- member intervals overlap;
- one physical timeseries appears in more than one family;
- a required member cannot be read;
- physical segments produce conflicting rows for one timestamp;
- required AQI context is incomplete;
- a requested response part cannot be produced accurately.

A gap between valid members remains a reported gap.

An incomplete response may still establish authoritative blank AQI intervals when the missing values are caused by genuine source-data or calculation-sample gaps. That does not convert the response to complete, but it may make the interval settled and reusable under the cache contract above.

There is no active fallback to the retired cumulative R2 metadata route.