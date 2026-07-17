# Decision 0001: AQI timestamps are hour-ending interval endpoints

- Status: Accepted
- Date: 17 July 2026
- System area: AQI levels

## Context

UK AQ calculates one hourly DAQI and European AQI row for each supported pollutant timeseries.

The stored canonical field is named `timestamp_hour_utc`. The calculation paths use the observation at the current timestamp together with preceding observations. The retired materialised updater also described its windows explicitly as hour-end windows.

However, active consumers have drifted into treating the same timestamp as a period start:

- the AQI History R2 API exposes it as `period_start_utc` without subtracting an hour;
- station-history expected-hour selection generally uses start-inclusive, end-exclusive endpoint ranges;
- website renderers draw a row at `n` from `n` to `n + 1 hour`.

This causes the coloured DAQI and European AQI bands to extend one hour beyond the final plotted concentration value and misstates which observation hour the level represents.

A single canonical rule is required across calculation, R2 storage, APIs, station-history merging and website rendering.

## Decision

`timestamp_hour_utc`, denoted by `n`, is the endpoint of the represented hourly interval.

The authoritative relationship is:

```text
period_start_utc = n - 1 hour
period_end_utc   = n
represented interval = (period_start_utc, period_end_utc]
```

A row ending at `07:00` represents `06:00` to `07:00`.

For a requested represented interval from `S` to `E`, the required canonical endpoints are:

```text
S < n <= E
```

## Storage consequences

Existing stored `timestamp_hour_utc` values remain unchanged.

They are already the intended hour-ending timestamps. Historical AQI parquet must not be shifted by one hour merely to correct API naming or website rendering.

The current R2 `day_utc` partition continues to use the date of the endpoint timestamp.

Therefore the row representing 17 July 23:00 to 18 July 00:00 remains stored under:

```text
day_utc=2026-07-18
```

Readers must include the endpoint-day partition required to retrieve a row ending at the request end.

## API consequences

AQI interfaces must expose unambiguous period boundaries.

The preferred corrected relationship is:

```text
period_start_utc = timestamp_hour_utc - 1 hour
period_end_utc   = timestamp_hour_utc
```

The current direct projection of `timestamp_hour_utc` into `period_start_utc` is incorrect.

The interface correction must be coordinated with all active consumers. Where compatibility cannot be preserved additively, use an explicit response-contract version rather than changing the meaning silently for one consumer.

## Station-history consequences

Expected endpoint generation, gap detection, R2 selection, live calculation filtering and chunk boundaries must use the represented-interval rule:

```text
start < endpoint <= end
```

Stable-head and older-history source precedence remains unchanged.

A timestamp correction must not allow an older history chunk to replace a stable-head row or a live row to replace committed R2 history.

## Website consequences

Both active station chart renderers must draw each DAQI and European AQI row from:

```text
n - 1 hour to n
```

The right edge of the final coloured section must align with the final valid concentration endpoint where both datasets cover that endpoint.

No colour may extend to `n + 1 hour`.

Missing endpoints remain blank. A neighbouring level must not be stretched across a gap.

## Calculation consequences

The existing calculation meaning is retained:

- NO2 DAQI uses the hourly mean ending at `n`;
- PM DAQI uses the rolling 24-hour mean ending at `n`;
- European AQI uses the hourly mean ending at `n`.

For PM, the rolling endpoint set remains:

```text
n - 23 hours, ..., n - 1 hour, n
```

This decision does not change breakpoints, averaging formulas or the 24-hour completeness requirement.

## Roll-up consequences

Daily and monthly AQI roll-ups are inactive.

If they are reactivated, calendar grouping must follow the represented interval start:

```text
period_start_utc = timestamp_hour_utc - 1 hour
```

Grouping solely by endpoint date would assign the hour ending at midnight to the wrong represented calendar day or month.

## Missing-data consequences

Each AQI row represents exactly one hour.

A missing endpoint creates one missing represented interval. Readers and renderers must not:

- carry the previous index forward;
- stretch the next index backwards;
- interpolate an index level;
- hide a valid European AQI result because PM DAQI lacks rolling context.

## Alternatives considered

### Treat `timestamp_hour_utc` as the period start

Rejected because it conflicts with the existing hour-ending calculation and rolling-window design, and would continue showing AQI after the final observation endpoint.

### Shift all stored timestamps back one hour

Rejected because the stored values already identify the calculation endpoint. Shifting history would change canonical row identities, R2 partitions, manifests, indexes and overlap precedence unnecessarily.

### Keep ambiguous API naming and fix only the renderer

Rejected because range selection, gap detection and midnight partition reads would remain wrong even if the rectangles looked correct.

### Extend the final band one hour for visual continuity

Rejected because it claims an AQI level for a future interval not represented by the calculated row.

### Forward-fill or interpolate missing levels

Rejected because it converts missing calculated data into invented index coverage.

## Implementation boundary

The correction requires coordinated review across:

- `lib/aqi/aqi_levels.mjs`;
- Prune Daily AQI writing and R2 partition selection;
- the AQI History R2 API Worker;
- the station-history Worker and history chunks;
- cache and response-contract behaviour where timestamp fields change;
- `station-history-loader.js`;
- both website chart renderers;
- schema tests or comments that define hourly timestamps;
- inactive roll-up SQL before any future reactivation.

## Validation requirement

Before deployment, use only minimal structural and deterministic checks defined in [`../validation.md`](../validation.md).

Functional validation must then occur through the deployed TEST path, including a chart interval crossing UTC midnight.

## Contract impact

This decision is authoritative for all active AQI levels producers and consumers.

Future changes that alter the endpoint rule, interval closure, range selection or R2 partition interpretation require a new decision record and an update to the main behavioural contract.