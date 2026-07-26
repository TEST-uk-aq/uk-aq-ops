# Stable v2 timeseries binding contract

## Authority

The authoritative stable binding object is:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

The top level always represents one exact physical timeseries identity. It is not a daily coverage index and must never be used to hide or rewrite historical physical identity.

The detailed continuity rules are defined in [`continuity.md`](continuity.md). That document is part of this contract.

## Physical binding fields

Every binding contains only stable physical identity/routing fields:

```text
schema_version
history_version
index_kind
timeseries_id
connector_id
pollutant_code
station_id              optional positive integer
phenomenon_id           optional positive integer
observed_property_id    optional positive integer
```

The physical fields are derived from an authoritative committed `history/v2/core/day_utc=<day>` snapshot after that snapshot has been written and verified.

## Schema version 1

Schema version 1 is the exact-only binding contract.

It contains no continuity section. Existing single-member bindings may remain schema version 1 and byte-identical. They must not be rewritten merely to make all objects use one schema version.

## Schema version 2

Schema version 2 retains the same exact physical top-level fields and adds one optional nested:

```text
continuity
```

Schema version 2 is used only when an authoritative logical site/pollutant family has more than one physical member.

The nested section is a runtime materialised copy of validated rows derived from the service-only continuity view backed by `uk_aq_raw.sos_station_timeseries_site_refs` and canonical core identity.

Every member binding in the same family contains the same deterministic continuity payload. Starting from any current or historical family `timeseries_id` must therefore resolve the complete family.

## Continuity identity

The logical continuity key is:

```text
connector_id + uk_air_ref + pollutant_code
```

Example:

```text
1:UKA00574:pm25
```

`site_ref` is retained and validated as corroborating identity, but it is not part of the continuity key. A corrected site code must not unnecessarily change the logical key.

## Churn and byte-stability rules

Binding objects must contain no:

```text
generated_at
updated_at
run_id
source_snapshot_at
refresh timestamp
match distance
raw payload
daily observation coverage
daily AQI coverage
```

Equivalent substantive input must produce byte-identical JSON.

Continuity members must be sorted by:

1. `valid_from_day_utc`;
2. `timeseries_id`.

Property ordering and null handling must be deterministic. An R2 PUT must be skipped when the proposed body is byte-identical to the existing object.

A monthly bridge refresh with unchanged substantive identities, references and validity dates must produce no binding changes and no Dropbox-backup ETag churn.

`station_ref` and `timeseries_ref` are permitted inside continuity members. A genuine change to either may rewrite the small affected family. Broad unrelated binding churn is not permitted.

## Validation and fail-closed rules

Before publishing schema version 2, the builder must establish that:

- every member has the same connector, UK-AIR identity and pollutant;
- non-null `site_ref` values agree;
- every member has positive station and timeseries IDs;
- the top-level timeseries appears exactly once in the member list;
- no member intervals overlap;
- there is no more than one open-ended current member;
- one physical timeseries does not belong to two different families;
- ambiguous or contradictory bridge evidence is rejected rather than guessed.

A gap between validity intervals is retained as a gap. The builder must not invent coverage.

## Retired index

The retired cumulative object:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

is not read, written, backed up or exposed by active services.

Binding reconciliation never deletes stale binding objects automatically. It reports them separately.

A binding or continuity publication failure must not invalidate an otherwise completed core snapshot, but it must be reported and must prevent consumers from claiming continuity that was not published successfully.
