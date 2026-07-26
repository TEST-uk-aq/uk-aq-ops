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

Network fetching and visual rendering are separate concerns.

The website must:

1. build missing work newest first;
2. launch a bounded set of requests in parallel immediately;
3. allow requests to complete in any order;
4. hold out-of-order completions in an ordered settlement buffer;
5. commit and render each stream from most recent to oldest;
6. coalesce repeated commits to no more than one chart repaint per animation frame where practical.

The website must not wait for the newest chunk to finish before launching older chunks. The ordered settlement buffer, not serial network fetching, provides the newest-to-oldest rendering guarantee.

Example completion order:

```text
chunk 2 completes
chunk 1 completes
chunk 0 completes
```

Required commit order:

```text
chunk 0
chunk 1
chunk 2
```

Once chunk 0 completes, already-finished contiguous chunks may be committed immediately in sequence.

All station-history work must share a bounded global fetch cap. Per-stream concurrency limits may be used, but their combined activity must not exceed that cap.

## Cache contract

The website keeps observation and calculated-AQI coverage separately for each authoritative sensor identity, connector, pollutant and range.

Secondary calculated AQI may be retained in cache without being rendered. Selecting that sensor as the AQI source must use the cached AQI immediately when its requested range is complete.

A cached observation range does not by itself prove that calculated AQI is cached. AQI completeness includes any required hidden context and must be tracked independently.

Requests must use stable URLs and parameters for normal traffic so Cloudflare caching can serve warm hits. Cache-buster parameters are limited to diagnostics and explicit forced refreshes.

## AQI source switching

When the user chooses a different selected sensor for AQI bands, the website must:

1. leave all observation lines and retained chart layers in place;
2. immediately remove the previous sensor's AQI bands so stale bands are never shown under the new selection;
3. show an intentionally blank/loading AQI band area for approximately 200 milliseconds;
4. after that brief transition, render the new sensor's cached AQI if ready;
5. otherwise keep the AQI area blank/loading until the required calculated response arrives;
6. never refetch retained observation lines solely because the AQI source changed.

The approximately 200 millisecond blank state is a user-interface transition, not a data delay requirement. It confirms that the selected AQI source changed and prevents the previous sensor's bands appearing to belong to the new sensor.

When complete AQI is already cached, the transition should normally finish in about 200 milliseconds. When it is not cached, normal loading state continues until accurate data is available.

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

There is no active fallback to the retired cumulative R2 metadata route.
