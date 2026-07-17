# ADR 0001: latest state retains the latest valid pollutant observation

- Status: Accepted and implemented
- Decision date: 16 July 2026
- Implemented on TEST: 17 July 2026
- Area: latest snapshot

## Context

The UK AQ observation stream can contain source sentinel or invalid pollutant values such as `-99`.

Those rows must remain in raw observation storage because they represent what the source supplied and may be useful for diagnostics, comparison and future interpretation.

The previous Latest Snapshot builder accepted any structurally valid finite numeric value into per-timeseries state. Pollutant eligibility was applied later while public rows were built.

That ordering allowed a newer `-99` row to replace a previous valid value. The later filter removed the new state row from public output, but the preceding valid row had already been lost. The timeseries therefore disappeared even from `window=all`.

## Decision

Latest Snapshot state is latest valid pollutant state, not latest raw observation state.

For the current pollutants, a value is eligible when it:

- is numeric and finite;
- is greater than or equal to zero;
- satisfies the existing PM upper-bound rules.

A decoded invalid observation:

- remains available to raw observation consumers;
- is handled by the dedicated Latest Snapshot consumer;
- does not create or replace latest state;
- is acknowledged after successful handling;
- does not refresh the retained valid timestamp.

The shared publisher remains unchanged. Filtering occurs in the Latest Snapshot consumer because the shared topic also serves raw observation consumers.

Source-row validation remains as defence in depth.

## Implementation

The builder now:

1. loads or refreshes metadata before pulling messages;
2. resolves decoded rows to observed properties and supported pollutants;
3. applies the central latest-current-value policy;
4. passes only eligible rows to state application;
5. persists state before acknowledging successfully handled decoded messages.

The state schema and identity remain unchanged.

## Consequences

### Positive

- The website retains the most recent usable value during a source sentinel period.
- The physical `window=all` object does not lose a timeseries merely because the newest raw row is invalid.
- Finite windows reflect the age of the last valid value.
- Raw observation history remains complete.
- The public v2 interface does not change.

### Negative

- Latest state and raw observation recency intentionally diverge.
- State created before the fix may require repair or a newer valid observation.
- The builder requires metadata before state replacement.
- Telemetry must distinguish invalid-value skips from malformed messages and service failures.

## Alternatives considered

### Filter invalid rows before publishing to Pub/Sub

Rejected because the shared observation topic also supplies raw consumers. This could prevent invalid source rows reaching `observs` and R2 raw history.

### Store the latest raw row and search backwards during every build

Rejected because the state object is a compact latest-value index. Repeated raw-history searches would add complexity, latency and read cost to the every-minute builder.

### Store both latest raw and latest valid rows in the same state object

Not required for the website contract. Raw recency belongs to raw history or connector checkpoint systems. A second state meaning would increase schema and maintenance complexity.

### Convert invalid values to null in state

Rejected because a null latest state still loses the preceding valid value.

### Rely only on a future valid observation

Rejected as the sole recovery mechanism because a timeseries may remain invalid or silent for an extended period.

## Compatibility constraints

This decision did not authorise changes to:

- raw observation storage;
- the shared publisher;
- latest snapshot v2 fields;
- network metadata behaviour;
- public window labels;
- API routes;
- scheduling or Cloud Run resource settings;
- AQI and WHO derived products;
- connector `timeseries.last_value` or checkpoint logic in other repositories.

Physical snapshot ownership and finite-window derivation are governed separately by ADR 0002.

## Validation outcome

The implementation was deployed to TEST and confirmed through normal scheduled operation and the website path. Ongoing validation is defined in [`../validation.md`](../validation.md).