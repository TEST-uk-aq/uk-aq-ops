# R2 timeseries continuity contract

## Purpose

This document defines how one logical monitoring-site/pollutant history is represented when its physical SOS station or timeseries identity changes.

It governs:

- the service-only Supabase continuity view;
- schema-version-2 `timeseries_binding` objects;
- station-history selection of date-valid physical members;
- the boundary between logical chart continuity and exact physical R2 identity;
- integrity classification and repair gating for historical rollovers.

## Source authority

The canonical bridge source is:

```text
uk_aq_raw.sos_station_timeseries_site_refs
```

The bridge is derived from:

1. UK-AIR AURN site evidence, including `uk_air_ref`, `site_ref` and site dates;
2. validated SOS station matching;
3. canonical pollutant mapping;
4. canonical station and timeseries rows;
5. date sequencing using site dates and physical timeseries end state.

There is no single external official source that directly maps a UK-AIR ID to UK AQ `station_id` or `timeseries_id`. The bridge is the system's derived authoritative relationship and must retain enough provenance in Supabase for review.

## Logical key

The logical family key is:

```text
connector_id + uk_air_ref + pollutant_code
```

Example:

```text
1:UKA00574:pm25
```

`site_ref` is a corroborating field. It is not part of the key because a corrected site code should not unnecessarily create a new logical family or R2 key.

A family with conflicting non-null `site_ref` values is invalid and must fail closed.

## Service-only view

A dedicated `uk_aq_public` view must expose validated continuity rows to service-role consumers. The final name follows schema conventions; the intended interface is equivalent to:

```text
uk_aq_public.uk_aq_timeseries_continuity
```

It exposes one row per physical family member, including:

```text
connector_id
continuity_key
site_ref
uk_air_ref
pollutant_code
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
is_current
station_match_method
station_match_distance_m
timeseries_match_method
source_snapshot_at
```

The view must:

- use `security_invoker = true` where supported;
- be readable only by the required service role;
- not be granted to `anon` or `authenticated`;
- not expose raw payloads;
- preserve match provenance for bounded diagnostics;
- remain a plain view unless a measured need justifies materialisation;
- produce deterministic family keys and date intervals.

The view is the authoritative continuity source. The R2 binding section is its runtime materialised copy.

## R2 representation: approved Option 1

Continuity is embedded inside the existing object:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

Do not create a separate `timeseries_continuity` R2 prefix for this implementation.

The top level remains the exact physical binding. A multi-member family adds:

```json
{
  "schema_version": 2,
  "history_version": "v2",
  "index_kind": "timeseries_binding",
  "timeseries_id": 212,
  "connector_id": 1,
  "station_id": 7479,
  "pollutant_code": "pm25",
  "continuity": {
    "schema_version": 1,
    "source": "sos_station_timeseries_site_refs",
    "continuity_key": "1:UKA00574:pm25",
    "site_ref": "BPLE",
    "uk_air_ref": "UKA00574",
    "pollutant_code": "pm25",
    "members": [
      {
        "station_id": 248,
        "station_ref": "3916",
        "timeseries_id": 285,
        "timeseries_ref": "97",
        "valid_from_day_utc": "2013-11-14",
        "valid_to_day_utc": "2026-05-17"
      },
      {
        "station_id": 7479,
        "station_ref": "10539",
        "timeseries_id": 212,
        "timeseries_ref": "1965",
        "valid_from_day_utc": "2026-05-18",
        "valid_to_day_utc": null
      }
    ]
  }
}
```

The binding for timeseries `285` contains the same nested family but keeps `285` and station `248` as its exact top-level physical identity.

## Materialisation scope

Only genuine multi-member families require schema version 2.

Single-member exact bindings remain schema version 1 unless a separate approved requirement needs enrichment. This avoids a broad one-time rewrite and reduces ongoing R2 and Dropbox backup churn.

When a previously single-member family gains a successor, only the affected family member bindings are upgraded.

## Stable payload fields

The nested R2 continuity section may contain only stable operational fields:

```text
schema_version
source
continuity_key
site_ref
uk_air_ref
pollutant_code
members[].station_id
members[].station_ref
members[].timeseries_id
members[].timeseries_ref
members[].valid_from_day_utc
members[].valid_to_day_utc
```

It must not contain refresh-sensitive provenance such as source snapshot time, row `updated_at`, run ID, generation time, match distance or raw payload.

Those fields remain available from the Supabase view and underlying bridge for diagnostics.

## Date semantics

Validity dates are inclusive:

```text
valid_from_day_utc <= day_utc
and
(valid_to_day_utc is null or day_utc <= valid_to_day_utc)
```

A request range is split only where member validity changes.

A gap between members remains a real incomplete interval. It is not permission to extend the previous member or begin the next member early.

An overlap is invalid. The runtime must not choose one member silently.

## Runtime resolution

The station-history Worker receives one requested `timeseries_id`.

It must:

1. read the exact binding;
2. validate its physical connector and pollutant against supplied request fields;
3. use `continuity.members` when present;
4. otherwise use the exact top-level binding only;
5. select members overlapping the requested observation range and any required AQI context range;
6. call low-level R2 APIs with exact physical IDs;
7. preserve physical identity on returned rows;
8. expose logical family and physical segment diagnostics separately.

The website does not resolve continuity and does not need to know predecessor IDs.

## Low-level R2 API boundary

The observations and AQI history R2 APIs remain exact physical readers.

A call for timeseries `285` returns only rows physically stored as `285`. A call for `212` returns only rows physically stored as `212`.

They must not:

- reinterpret a requested ID as a logical family;
- fetch continuity from Supabase;
- silently add predecessor or successor IDs;
- alter row identity in the response.

Logical orchestration belongs only to station history.

## Observation merging

Physical segments are merged into one logical chart stream only after each segment has passed exact identity and range checks.

Required behaviour:

- deterministic timestamp ordering;
- deterministic duplicate removal for identical rows;
- hard failure or explicit incomplete response when overlapping members produce conflicting values at one timestamp;
- no physical identity rewriting;
- no displayed context rows outside the requested visible range;
- no gap filling.

## Integrity interaction

Integrity must classify a date-invalid R2 family member separately from a genuinely unknown ID.

Example for BPLE PM2.5 on 2026-01-01:

```text
source/date-valid: 285
R2/date-invalid same family: 212
```

This is a bridge-known historical identity rollover mismatch. It is not unavailable source mapping.

Integrity should expose the ordinary physical source/R2 mismatch evidence:

```text
285 source rows present, R2 rows missing
212 source rows absent, R2 rows present
```

Repair execution remains gated until continuity-aware station history is deployed and confirmed in TEST.

Unknown IDs, multiple-family membership, overlapping validity, conflicting site identity or other ambiguity remain fail-closed.

## Publication and update ordering

For an affected multi-member family:

1. read and validate the authoritative view rows;
2. build the deterministic complete family;
3. build every affected member binding proposal;
4. compare proposed bytes with existing objects;
5. write only changed member objects;
6. verify written bytes;
7. report unchanged, changed, new, invalid and stale counts.

Partial family publication must be treated as a publication defect. Consumers must not claim continuity from a missing or internally inconsistent family.

## Backup and churn contract

The active backup category remains:

```text
timeseries_binding_v2
```

No new continuity backup category is introduced.

Byte stability is load-bearing because unnecessary ETag changes cause R2 inventory rereads and Dropbox reuploads.

A source refresh that does not change stable identity, reference or validity fields must produce zero changed binding objects.

A genuine change rewrites only the small affected family. Broad rewrites caused by timestamps, field-order changes or refresh metadata are contract violations.

## Explicit non-goals

This contract does not:

- create a `station_binding` index;
- create a separate R2 continuity prefix;
- make the website continuity-aware;
- change the physical identity stored in R2 rows;
- make low-level history APIs logical-family readers;
- add new pollutants;
- infer continuity for non-SOS connectors without authoritative evidence;
- automatically enable historical identity repair in LIVE.
