# Latest snapshot state model

## State purpose

The latest-state object is a compact current-value index used to build the website snapshot matrix.

It is not raw history and MUST NOT preserve every received observation.

It retains at most one current valid observation for each `(connector_id, timeseries_id)` identity.

## Persistent object

Default key:

```text
latest_snapshots_state/v1/latest_state.json
```

Current top-level shape:

```json
{
  "schema_version": 1,
  "updated_at": "2026-07-16T12:00:00.000Z",
  "entries": []
}
```

Current entry shape:

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

The invalid-value fix does not require a state schema change.

## Identity

```text
state_key = connector_id + ":" + timeseries_id
```

Both identifiers must be positive integers.

Timeseries identifiers are not assumed to be globally unique across connectors.

## State-entry eligibility

An entry may exist only when:

- the message is structurally valid;
- the metadata resolves the timeseries to a supported matrix pollutant;
- the numeric value is finite;
- the pollutant value is greater than or equal to zero;
- any existing pollutant-specific maximum is satisfied.

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

## Timestamp ordering

Primary ordering uses `observed_at`.

The current implementation uses `ingested_at` as the tie-breaker when `observed_at` is equal. This behaviour is outside the negative-value defect and must remain unchanged unless separately reviewed.

Value eligibility must be evaluated before timestamp comparison can allow replacement.

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

- `window=all`: the 08:00 row remains present.
- finite windows: the 08:00 row remains present only while 08:00 is inside that window.
- the invalid 09:00 value is never emitted as `last_value`.
- the invalid 09:00 value does not refresh the row's apparent age.

Next incoming message:

```text
10:00  value=18.4  valid
```

Required result:

```text
state observed_at=10:00
state value=18.4
```

## Multiple observations in one pull run

Incoming rows may contain several observations for the same identity.

The result must be the newest eligible valid row according to the existing ordering rules, regardless of message order.

Example:

```text
08:00  21.793 valid
09:00  -99    invalid
10:00  18.4   valid
```

Final state must be `10:00, 18.4`.

An invalid row between two valid rows must not interrupt progression to the newer valid row.

## Invalid-only identities

When all received rows for an identity are invalid and no prior valid state exists:

- no state entry is created;
- no snapshot row is generated;
- messages are acknowledged after successful handling;
- raw observation systems remain responsible for retaining the source rows.

## Loaded legacy or poisoned state

Normal state loading currently validates identity and timestamps but does not have enough metadata at load time to classify every value.

The implementation fix must consider existing poisoned entries already stored in R2.

Two acceptable mechanisms are:

1. filter loaded state against metadata and value eligibility before snapshot generation and before reserialising state; or
2. perform a one-off authoritative state repair and ensure normal runtime prevents recurrence.

The chosen recovery method must be documented in `operations.md` and validated on TEST.

Silently relying only on a future valid observation is not sufficient for immediate website restoration when poisoned entries already exist.

## Deterministic serialisation

State entries are sorted by:

1. `connector_id`;
2. `timeseries_id`.

Object keys are stable-sorted before JSON output.

The state object is written only when its SHA-256 differs from the existing object.

Skipping an invalid row must not alter `ingested_at`, `updated_at` or the object hash when no other state change occurred.

## Metadata cache state

The core metadata cache is a separate object:

```text
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

It includes current lookup rows for:

- connectors;
- networks;
- stations;
- timeseries;
- phenomena;
- observed properties.

It is not part of the latest observation state identity and must not be merged into `latest_state.json`.

## State-size safety

The current hard maximum is 500,000 state entries.

The invalid-value fix must not change that limit.

Invalid-only identities must not consume state entries.

## State telemetry

State-application reporting should distinguish at least:

- applied new valid state;
- applied newer valid state;
- skipped older valid row;
- skipped duplicate valid row;
- skipped invalid current value.

A more detailed reason split may be added without changing the public snapshot contract, provided it does not introduce a second validity policy.
