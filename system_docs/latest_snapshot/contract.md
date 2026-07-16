# Latest snapshot behavioural contract

## Authority

This file is the authoritative behavioural contract for the latest-snapshot system.

Implementation files, worker-local READMEs, plans and archives MUST conform to this contract unless an intentional contract change is approved and documented in the same branch or pull request.

## Purpose

The latest-snapshot system provides deterministic, cacheable website data representing the latest valid pollutant observation for each eligible timeseries.

It is a current-state product. It is not the authoritative raw observation record.

## Scope

The current matrix is:

- pollutants: `pm25`, `pm10`, `no2`;
- windows: `3h`, `6h`, `1d`, `7d`, `all`;
- network group: `all`;
- output contract: `v2`.

## Definitions

### Raw observation

A source observation received by the wider UK AQ ingestion system. Raw observations may include sentinel, invalid, outlier or otherwise unusable values and remain part of source history.

### Valid current pollutant value

A value eligible to become the latest public current value for a pollutant timeseries.

For the current matrix, the value MUST:

1. be numeric and finite;
2. be greater than or equal to `0`;
3. satisfy any existing pollutant-specific upper bound.

The existing upper-bound behaviour MUST be preserved unless a separate approved decision changes it:

- PM2.5: maximum `500`;
- PM10: maximum `600`;
- NO2: no additional upper bound is currently configured in this component.

Zero is a valid pollutant value.

A negative pollutant value, including `-99`, is not a valid current pollutant value.

### Latest valid state

The single retained latest valid observation for one `(connector_id, timeseries_id)` identity.

## Required invariants

### Raw-data separation

- The observation publisher MUST continue publishing raw observations needed by raw observation consumers.
- The latest-snapshot system MUST use its dedicated Pub/Sub subscription and MUST NOT consume the raw writer's subscription.
- The latest-snapshot validity rule MUST NOT prevent invalid or sentinel rows from reaching raw `observations`, `observs` or R2 observation history.
- Invalid current values MUST be rejected by this consumer, not removed from the shared raw observation stream.

### State identity

- State identity MUST remain `(connector_id, timeseries_id)`.
- A valid observation for one connector/timeseries MUST NOT replace state for another identity.

### State creation and replacement

- A valid observation MUST create state when no state exists for its identity.
- A newer valid observation MUST replace an older valid state row.
- An older valid observation MUST NOT replace newer valid state.
- A newer invalid observation MUST NOT create state.
- A newer invalid observation MUST NOT replace existing valid state.
- An invalid observation with the same timestamp as valid state MUST NOT replace it.
- The previous valid state row MUST remain unchanged until a newer valid observation is received.
- Existing same-timestamp valid-row tie-breaking behaviour using `ingested_at` MUST remain unchanged unless separately approved.

### Message acknowledgement

- Malformed messages that cannot be decoded into the required observation identity and timestamp MAY be acknowledged as malformed according to existing behaviour.
- Decoded valid and invalid observation messages MUST be acknowledged after their state handling has completed successfully.
- An invalid value that is deliberately skipped for current state is still a successfully handled message and MUST NOT be left for endless redelivery.
- If state persistence fails, decoded message acknowledgement MUST NOT move ahead of the failed state handling.

### State persistence

- State MUST remain stored at the configured latest-state key, currently `latest_snapshots_state/v1/latest_state.json`.
- The invalid-value fix MUST NOT change the persisted state object shape solely to implement value eligibility.
- The state file MUST contain only entries eligible to act as latest current values for the supported pollutant matrix.
- State writes SHOULD remain hash-gated so unchanged state does not produce unnecessary R2 writes.

### Metadata eligibility

Existing metadata behaviour MUST remain unchanged:

- timeseries metadata must resolve through the core metadata cache;
- the timeseries must resolve to its station, connector, phenomenon and observed property as required by the v2 row contract;
- public network identity must resolve through `station.network_id -> networks.id`;
- missing required station or network metadata is counted and skipped;
- networks with `public_display_enabled=false` are skipped;
- the existing station geography requirement remains in force;
- connector-derived network fallbacks MUST NOT be introduced.

### Window behaviour

- Window eligibility MUST use the `observed_at` timestamp of the retained valid state row.
- A newer invalid observation MUST NOT make the retained valid row appear newer.
- A newer invalid observation MUST NOT remove a retained valid row from `window=all`.
- For finite windows, the retained valid row appears only while its own timestamp is within that window.
- `window=all` includes every metadata-eligible retained valid state row regardless of age.

### Snapshot objects

- Snapshot keys MUST remain deterministic for `(network_group, pollutant, window)`.
- Snapshot payloads MUST remain stable-JSON serialised and hash-gated.
- Unchanged payloads MUST continue skipping object writes.
- A failed matrix key MUST preserve its previous manifest entry when one exists.
- The invalid-value fix MUST NOT alter sorting, cursor derivation or matrix generation except where rows previously disappeared because invalid state replaced valid state.

### Public v2 contract

The invalid-value fix MUST NOT change:

- the `latest_snapshots/v2` prefix;
- the manifest path;
- the query parameter names or accepted values;
- the cache-proxy route;
- response field names;
- field meanings;
- network field shape;
- connector provenance fields;
- the `X-UK-AQ-Snapshot-Contract: v2` requirement;
- fail-closed behaviour for non-v2 standard paths.

## Explicit non-goals

A latest-snapshot invalid-value fix MUST NOT:

- delete or rewrite raw observation history;
- stop invalid observations being published to the shared raw observation topic;
- change AQI or WHO calculation logic;
- change `timeseries.last_value` or connector checkpoint logic in another repository;
- add new pollutants or windows;
- change station display-name formatting;
- change network assignment or visibility rules;
- change cache TTLs, routes or authentication;
- change Cloud Scheduler frequency, concurrency, timeout or retry configuration;
- refactor unrelated shared R2 code;
- repair all historical state products without an explicit recovery step.

## Known implementation discrepancy

At the time this contract was created, `applyRowsToState()` accepted any decoded finite numeric value before pollutant metadata and value eligibility were evaluated. `buildSourceRows()` applied outlier filtering only after state had already been replaced.

That implementation does not conform to the state creation and replacement rules above and is the targeted defect to correct.

## Contract-change rule

Any future change to value eligibility, state identity, replacement ordering, v2 row fields, window semantics or failure behaviour requires:

1. an update to this contract;
2. an update or new decision record;
3. targeted deterministic checks;
4. post-deployment validation on TEST.
