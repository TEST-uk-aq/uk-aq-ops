# PM DAQI 75% completeness and index-specific missing hours

## Status

Accepted

## Date

2026-08-06

## Decision

PM2.5 and PM10 DAQI continue to use a true rolling 24-hour window ending at each canonical AQI endpoint `n`.

The possible hourly endpoints remain:

```text
n - 23 hours, ..., n - 1 hour, n
```

A PM DAQI result is valid when at least 18 of those 24 possible hourly means are valid and available.

The rolling mean is calculated from the available valid hourly means only. Missing hours are not interpolated, carried forward or assigned a replacement concentration.

The normalised PM DAQI counts are:

```text
daqi_source_observation_count   = valid hourly means used
daqi_required_observation_count = 18
```

European AQI remains an hourly product. It requires the valid hourly mean at endpoint `n` and does not use the PM rolling window.

Therefore, at a PM endpoint where the hourly observation is missing:

- European AQI is `missing_input` with a null index level;
- PM DAQI may remain `ok` when at least 18 valid hourly values exist in the rolling window;
- PM DAQI is `insufficient_samples` when fewer than 18 valid hourly values exist.

No result is carried forward or backward. Missing output is index-specific.

The shared implementation remains:

```text
lib/aqi/aqi_levels.mjs
```

Station-history calculation, Prune Daily AQI creation, and any Integrity or rebuild path that creates AQI through the shared helper must use this same behaviour.

The algorithm version is changed to:

```text
aqilevels_hourly_v2
```

## Context

The previous implementation required all 24 hourly values. A short observation gap therefore removed PM DAQI for every subsequent rolling window containing either missing hour, even when data capture remained above 75%.

It also only created AQI candidate rows at endpoints with an hourly observation. This prevented a valid rolling PM DAQI result from being represented at a missing hourly endpoint, despite sufficient data elsewhere in the rolling window.

European AQI must not be changed to a rolling calculation. Its gap at a missing hourly observation is correct and must remain visible.

## Consequences

- A two-hour PM observation gap can leave a two-hour European AQI gap while PM DAQI remains continuous when the rolling source count is at least 18.
- PM DAQI becomes unavailable at a rolling source count of 17 or fewer.
- Existing `aqilevels_hourly_v1` R2 rows are not directly comparable with newly calculated `aqilevels_hourly_v2` rows.
- Stored-R2 validation must classify a v1/v2 algorithm difference as `not_comparable_algorithm_version`, not as an ordinary AQI mismatch.
- Historical v1 AQI remains unchanged until a separately approved rebuild is run.
- No schema, cache-proxy route, Prune Daily-specific calculation or Integrity-specific calculation is introduced.
- Raw observations remain unchanged.
- DAQI and European AQI remain independently reportable and independently blank where appropriate.

## Implementation

The shared helper:

- retains the 24-hour rolling window;
- requires 18 valid hourly means for PM DAQI;
- creates bounded PM hourly calculation candidates across missing endpoints;
- emits a missing-endpoint row only when PM DAQI is valid;
- leaves the hourly European AQI input and level null at that endpoint;
- reports algorithm version `aqilevels_hourly_v2`.

The station-history Worker supplies the requested visible endpoint range to the shared helper so eligible missing PM endpoints can be returned to the chart.

## Validation

Pre-deployment validation is deliberately focused:

1. 18 valid PM hours produce DAQI status `ok`.
2. 17 valid PM hours produce `insufficient_samples`.
3. A two-hour PM observation gap retains eligible DAQI rows.
4. European AQI remains `missing_input` and null for those two missing hourly endpoints.
5. European AQI returns to `ok` at the next valid hourly observation.

Functional validation must then use the deployed TEST station-history path and a real chart containing a short PM observation gap.
