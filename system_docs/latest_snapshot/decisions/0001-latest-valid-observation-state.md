# ADR 0001: latest state retains the latest valid pollutant observation

- Status: Accepted
- Date: 16 July 2026
- Area: latest snapshot

## Context

The UK AQ observation stream can contain source sentinel or invalid pollutant values such as `-99`.

Those rows must remain in raw observation storage because they represent what the source supplied and may be useful for diagnostics, comparison and future interpretation.

The latest-snapshot builder previously accepted any structurally valid finite numeric value into its per-timeseries state. Pollutant outlier filtering occurred later when public snapshot rows were built.

This ordering allowed a newer `-99` row to replace a previous valid value. The later filter then removed the state row from public output. Because only one state row was retained, the previous valid value was no longer available, so the timeseries disappeared even from `window=all`.

## Decision

The latest-snapshot state is defined as latest valid pollutant state, not latest raw observation state.

For current snapshot pollutants, a value is eligible when it:

- is numeric and finite;
- is greater than or equal to zero;
- satisfies the existing PM upper-bound rules.

A decoded invalid observation:

- remains available to raw observation consumers;
- is handled by the dedicated latest-snapshot consumer;
- does not create or replace latest state;
- is acknowledged after successful handling;
- does not refresh the retained valid timestamp.

The shared observation publisher remains unchanged. Filtering occurs in the latest-snapshot consumer because the shared topic also serves raw observation consumers.

Source-row validation remains in place as defence in depth.

## Consequences

### Positive

- The website retains the most recent usable value during a source sentinel period.
- `window=all` no longer loses a timeseries merely because its newest raw row is invalid.
- Finite windows reflect the age of the last valid value rather than the invalid source timestamp.
- Raw observation history remains complete.
- The public v2 interface does not need to change.

### Negative

- Latest state and raw observation recency intentionally diverge.
- Existing poisoned state requires repair or a newer valid observation before it becomes correct.
- The builder must have enough metadata to classify an observation before state replacement.
- Operational telemetry should distinguish invalid-value skips from malformed messages and service failures.

## Alternatives considered

### Filter invalid rows before publishing to Pub/Sub

Rejected because the shared observation topic also supplies raw observation consumers. This could prevent invalid source rows reaching `observs` and R2 raw history.

### Store the latest raw row and search backwards during every snapshot build

Rejected because the current state object is designed as a compact latest-value index. Searching raw history for every invalid state row would add complexity, latency and additional read costs to the minute-by-minute builder.

### Store both latest raw and latest valid rows in the same state object

Not required for the immediate website contract. Raw recency belongs to raw history or connector checkpoint systems. Adding a second state meaning would increase schema and maintenance complexity.

### Convert invalid values to null in state

Rejected because a null latest state still loses the previous valid value and can make the timeseries disappear.

### Let a future valid observation self-heal state

Insufficient as the sole remedy because some timeseries may remain invalid or silent for an extended period. An explicit repair path is required for existing poisoned state.

## Compatibility constraints

This decision does not authorise changes to:

- raw observation storage;
- the shared publisher;
- latest snapshot v2 fields;
- R2 object paths;
- network metadata behaviour;
- window labels;
- API routes;
- cache behaviour;
- scheduling or Cloud Run resource settings;
- AQI and WHO derived-product logic;
- connector `timeseries.last_value` or checkpoint logic in other repositories.

Those areas require their own contracts and decisions.

## Follow-up

- Amend the latest-snapshot state application logic.
- Add focused deterministic transition checks.
- Repair existing poisoned latest state.
- Validate the website path on TEST.
- Address connector current-value and checkpoint semantics in a later cross-repository phase plan.
