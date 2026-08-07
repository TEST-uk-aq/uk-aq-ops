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

## Authoritative source manifest hierarchy

The physical binding objects remain flat and immutable-by-identity under:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

To make source discovery incremental without listing every physical object on every consumer run, the binding publication path also maintains an authoritative source manifest hierarchy:

```text
history/_index_v2/timeseries_binding/_manifests/root.json
history/_index_v2/timeseries_binding/_manifests/range=000000-000999.json
history/_index_v2/timeseries_binding/_manifests/range=001000-001999.json
...
```

The range size is fixed at 1,000 timeseries IDs and uses the same stable numeric boundaries as the Dropbox backup inventory/state hierarchy.

Each range manifest records the complete current physical binding set for that range, including at least:

```text
timeseries_id
relative_path
sha256
size
```

It may also record source metadata such as the current R2 MD5/ETag when useful for verification or safe hash reuse. Metadata-only values must not determine the substantive `source_range_hash`.

Each range has a stable `source_range_hash` derived only from the sorted current physical binding identities in that range. The root records every current range, its manifest key, range hash and unit count, plus one stable `source_root_hash` derived from those range identities.

The hierarchy represents the complete physical binding prefix, including retained stale binding objects. A binding reported as stale by reconciliation remains part of the source hierarchy for as long as the physical object remains in R2. The source hierarchy must never silently make an existing physical binding disappear merely because it is no longer in the current core snapshot.

The normal operational maintainer is the v2 core-snapshot binding publication chain: `reconcileR2HistoryV2TimeseriesBindings()` first completes and verifies physical binding reconciliation, then `uk_aq_refresh_timeseries_binding_source_hierarchy.mjs` immediately publishes or confirms the corresponding source range/root hierarchy. The core-snapshot workflow must not treat a v2 binding publication as operationally complete without running that hierarchy refresh after a successful non-dry-run snapshot.

A future direct caller of `reconcileR2HistoryV2TimeseriesBindings()` that writes physical binding objects must also invoke the source-hierarchy refresh before treating its binding publication as complete. The physical reconciliation already performs complete prefix discovery when its authoritative source fingerprint changes; the subsequent hierarchy refresh may perform its own complete listing only on that binding-publication path, never on routine backup inventory reads.

When the source hierarchy is first bootstrapped, existing verified backup-inventory SHA-256 identities may be adopted when current R2 metadata proves the corresponding physical object is unchanged. On later hierarchy refreshes, existing source-range identities may be reused under the same metadata rule. Otherwise the physical binding must be read and hashed before its source-range identity is published.

Changed physical binding objects affect only their fixed range manifests and the source root. Unchanged range manifest bytes must remain unchanged and must not be rewritten merely because another range changed.

Publication ordering is mandatory:

1. complete and verify required physical binding writes;
2. build/write every changed range manifest;
3. verify those range manifests where a write occurred;
4. write the source root last.

The source root must never advance to a range hash that has not been published successfully. A failed or partial reconciliation/publication chain must leave the previous valid root authoritative.

An explicit rebuild/bootstrap operation may enumerate the complete physical binding prefix to create or independently verify this hierarchy. That expensive operation is exceptional, not the normal consumer path.

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

The source range/root manifests obey the same byte-stability rule: unchanged physical binding content must produce unchanged range and root bytes.

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

The source manifest hierarchy must additionally fail closed if:

- a range identity does not match its fixed 1,000-ID boundary;
- one physical binding appears in more than one range;
- a range manifest hash does not match its current units;
- the root references a missing or contradictory range manifest;
- a physical binding that is known to exist cannot be assigned a trustworthy content identity.

## Retired index

The retired cumulative object:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

is not read, written, backed up or exposed by active services.

Binding reconciliation never deletes stale binding objects automatically. It reports them separately.

A binding or continuity publication failure must not invalidate an otherwise completed core snapshot, but it must be reported and must prevent consumers from claiming continuity that was not published successfully.
