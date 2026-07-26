# Binding interfaces

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

## Supported response versions

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

## Runtime routing

Normal station-history routing is:

1. receive requested `connector_id`, `timeseries_id`, pollutant and range;
2. fetch the exact stable binding;
3. validate supplied connector and pollutant against the physical binding;
4. validate and use the nested family when present;
5. select date-valid physical members for the visible and AQI-context ranges;
6. issue bounded exact requests to low-level history APIs;
7. merge only inside the private station-history Worker.

The website sends only one current timeseries ID. It does not receive a separate public continuity API and does not query Supabase continuity data directly.

## Exact low-level API boundary

The observations and AQI R2 APIs continue to interpret `timeseries_id` physically.

They return only rows stored under the requested physical ID. They do not follow the continuity family and do not call Supabase to discover related IDs.

## Failure behaviour

The binding route and station-history consumer must fail closed or return an explicitly incomplete response when:

- schema version 2 is malformed;
- the top-level timeseries is absent from the family;
- connector, pollutant or UK-AIR identity conflicts;
- member intervals overlap;
- one physical timeseries appears in more than one family;
- a required member cannot be read;
- physical segments produce conflicting rows for one timestamp.

A gap between valid members remains a reported gap.

There is no active fallback to the retired cumulative R2 metadata route.
