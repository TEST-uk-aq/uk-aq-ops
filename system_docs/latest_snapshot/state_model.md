# Latest snapshot state model

## State purpose

The latest-state object is a compact current-value index used to build the three physical pollutant `window=all` snapshots.

It is not raw history and MUST NOT preserve every received observation.

It retains at most one current valid observation for each `(connector_id, timeseries_id)` identity. Public finite windows are derived later by the R2 API Worker and do not create separate state.

The authoritative state remains the R2 object. A container-local cached copy is only a validated optimisation and is not a second state store.

## Persistent object

Default key:

```text
latest_snapshots_state/v1/latest_state.json
```

Top-level shape:

```json
{
  "schema_version": 1,
  "updated_at": "2026-07-16T12:00:00.000Z",
  "entries": []
}
```

Entry shape:

```json
{
  "connector_id": 1,
  "timeseries_id": 360,
  "observed_at": "2026-07-16T08:00:00.000Z",
  "value": 21.793,
  "value_float8_hex": null,
  "status": null,
  "ingested_at": "2026-07-16T08:01:00.000Z"
}
```

The state schema remains version `1`.

## Identity

```text
state_key = connector_id + ":" + timeseries_id
```

Both identifiers must be positive integers. Timeseries identifiers are not assumed to be globally unique across connectors.

## State-entry eligibility

An entry may exist only when:

- the message is structurally valid;
- metadata resolves the timeseries to a supported matrix pollutant;
- the value is numeric and finite;
- the value is greater than or equal to zero;
- any pollutant-specific maximum is satisfied.

A state entry must never represent a missing, negative, sentinel or rejected outlier value.

## Transition table

| Existing state | Incoming observation | Required result |
|---|---|---|
| None | New valid value | Create state |
| None | Invalid value | Keep no state |
| Older valid state | Newer valid value | Replace state |
| Newer valid state | Older valid value | Keep existing state |
| Valid state | Newer invalid value | Keep existing state unchanged |
| Valid state | Older invalid value | Keep existing state unchanged |
| Valid state | Same-time invalid value | Keep existing state unchanged |
| Valid state | Same-time valid value | Preserve current same-time tie-break behaviour |

## Runtime ordering

The current builder:

1. loads the previous physical manifest through the durable-object path;
2. loads existing state through the durable-object path;
3. loads or refreshes metadata before pulling messages;
4. resolves decoded rows to observed properties and supported matrix pollutants;
5. applies the latest-current-value eligibility policy;
6. passes only eligible rows to state application;
7. writes changed state to R2 before updating any local cached copy;
8. acknowledges handled messages only after durable state handling.

Value eligibility therefore runs before timestamp ordering can replace state.

Primary ordering uses `observed_at`. When valid rows share the same `observed_at`, the existing `ingested_at` tie-break behaviour remains in force.

## Timestamp meanings

- `observed_at` in state is the source timestamp of the retained valid observation.
- `last_value_at` in the public row is the same timestamp exposed under the v2 API name.
- The builder does not store a separate timestamp for each public finite window.
- The R2 API Worker uses `last_value_at` to determine whether the retained row is inside a requested finite window.

## Worked example: Manchester Piccadilly PM2.5

Initial state:

```text
08:00  value=21.793  valid
```

Incoming message:

```text
09:00  value=-99  invalid pollutant value
```

Required result:

```text
retained state observed_at=08:00
retained state value=21.793
09:00 message handled and acknowledged
```

Snapshot consequences:

- the physical `window=all` object retains the 08:00 row;
- the invalid 09:00 value is never emitted as `last_value`;
- the invalid value does not refresh apparent recency;
- finite public responses include the 08:00 row only while its own `last_value_at` remains within the requested cutoff.

A later valid observation replaces state normally.

## Multiple observations in one pull run

Incoming rows may contain several observations for the same identity.

The final state must be the newest eligible valid row according to the existing ordering rules, regardless of message order.

Example:

```text
08:00  21.793 valid
09:00  -99    invalid
10:00  18.4   valid
```

Final state must be `10:00, 18.4`.

## Invalid-only identities

When all received rows for an identity are invalid and no prior valid state exists:

- no state entry is created;
- no physical snapshot row is generated;
- messages are acknowledged after successful handling;
- raw observation systems retain the source rows.

## Pre-fix or poisoned state

Normal runtime now prevents invalid rows from entering or replacing state.

State created before that fix may still require explicit recovery if a later valid observation has not already replaced it. The current runtime does not search backwards through raw history during each scheduled run.

Use the recovery process in [`recovery.md`](recovery.md) when an existing state object is suspected to contain invalid or otherwise poisoned entries.

## Deterministic serialisation

State entries are sorted by:

1. `connector_id`;
2. `timeseries_id`.

Object keys are stable-sorted before JSON output. State is written only when its SHA-256 differs from the existing object.

Skipping an invalid row must not alter the retained entry, `ingested_at`, `updated_at` or object hash when no other state transition occurs.

A local cache hit returns the exact durable bytes previously validated against R2. It must therefore produce the same state map and existing-object hash as an R2 GET.

## Metadata cache state

The core metadata cache is a separate durable R2 object:

```text
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

It contains current lookup rows for connectors, networks, stations, timeseries, phenomena and observed properties. It is not part of latest observation state identity and must not be merged into `latest_state.json`.

A local cached copy does not change the metadata-cache schema, R2 key or freshness interval. The contained `generated_at` remains authoritative for deciding when the metadata must be refreshed.

## Transient container-local cache

When enabled, the builder may store validated local copies of:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots_state/v1/core_metadata_cache_v2.json
latest_snapshots/v2/manifest.json
```

Default local directory:

```text
/tmp/uk-aq-latest-snapshot-cache
```

For each R2 key, the local cache stores:

- a body file whose filename stem is the SHA-256 of the full R2 key;
- a JSON sidecar with schema version `1`, the full R2 key, R2 ETag and body SHA-256.

This is transient process-adjacent state only:

- it may survive successive child processes in the same warm Cloud Run container;
- it disappears when the container is replaced;
- it is not read without local integrity checks and current R2 ETag validation;
- it is never a repair or bootstrap source;
- deleting it is always safe;
- disabling it requires no migration.

A local write failure must not alter durable state, acknowledgement ordering, manifest contents or build success.

## State-size safety

The hard maximum remains 500,000 entries. Invalid-only identities must not consume state entries.

## State and cache telemetry

State reporting distinguishes:

- applied new valid state;
- applied newer valid state;
- skipped older valid row;
- skipped duplicate valid row;
- skipped invalid current value;
- skipped unsupported pollutant;
- skipped unresolved metadata.

The completed job summary also reports local-cache counters for:

- disabled reads;
- cold misses;
- warm hits;
- R2 fingerprint mismatches;
- corrupt local entries;
- validation errors;
- local write failures;
- entries skipped because no R2 ETag was available.

Additional reason detail may be added without changing the public contract, provided it does not introduce a second eligibility or durability policy.
