# Decision 0002: Hourly AQI is the only active AQI levels product

- Status: Accepted
- Date: 17 July 2026
- System area: AQI levels

## Context

The Obs AQI database schema contains:

- `uk_aq_aqilevels.timeseries_aqi_hourly`;
- `uk_aq_aqilevels.timeseries_aqi_daily`;
- `uk_aq_aqilevels.timeseries_aqi_monthly`;
- an RPC that refreshes daily and monthly roll-ups from hourly rows.

The previous `uk-aq-timeseries-aqi-hourly` Cloud Run service called the roll-up refresh RPC. That service was archived on 13 July 2026 and its deployment workflow was removed.

The current runtime instead calculates recent hourly AQI through the station-history Worker and persists closed hourly AQI history through Prune Daily and R2.

The continued presence of daily and monthly schema objects could otherwise lead future changes to assume that those roll-ups are current, complete or operationally required.

## Decision

Hourly AQI is the only active and authoritative calculated AQI levels product.

The active product includes:

- normalized hourly rows;
- recent on-the-fly hourly calculation;
- committed hourly R2 history;
- hourly DAQI and European AQI website bands.

Daily and monthly AQI roll-ups are inactive.

Their schema objects may remain for compatibility or future design work, but their rows must be treated as potentially stale and non-authoritative.

## Operational consequences

Normal AQI health checks, Prune Daily validation, R2 integrity, station-history completeness and website acceptance criteria are based on hourly AQI.

Operators must not expect daily or monthly tables to advance and must not treat their age as a failure of the active AQI pipeline.

No active scheduler, Cloud Run service or Worker is required to refresh them.

## Interface consequences

Active website and API interfaces must read hourly AQI rows or products derived directly from those rows at request time.

They must not use the inactive daily or monthly tables as a fallback for missing hourly history.

Documentation must not describe those roll-ups as available current summaries.

## Recovery consequences

Hourly AQI repair does not include refreshing daily or monthly roll-ups.

A repair tool must not call the roll-up refresh RPC as an incidental side effect unless a separate approved operation explicitly targets reactivation or historical study of those tables.

## Schema consequences

This decision does not require immediate deletion of the daily and monthly schema objects.

Retaining inactive schema is acceptable provided:

- it is clearly documented as inactive;
- no current runtime silently depends on it;
- old rows are not represented as current;
- schema changes do not accidentally reactivate updates.

Removing the objects later requires a separate schema review because external or archived tools may still reference them.

## Reactivation requirements

Daily or monthly AQI becomes active only after an explicit approved decision and implementation plan covering:

1. the product purpose and consumers;
2. calendar-period timestamp semantics;
3. grouping by represented interval start rather than endpoint date;
4. completeness thresholds;
5. late-arriving observation corrections;
6. recalculation and invalidation windows;
7. source-of-truth and rebuild behaviour;
8. API and cache contracts;
9. schedule, cost and operational ownership;
10. TEST deployment validation.

Reactivating the previous updater unchanged is not acceptable because its calendar grouping follows `timestamp_hour_utc` date and does not implement the accepted hour-ending interval contract at midnight boundaries.

## Alternatives considered

### Treat the schema objects as implicitly active

Rejected because no current deployed updater has been identified and old rows can be stale.

### Remove the tables immediately

Rejected for this documentation-only change because deletion is a schema and compatibility decision, not required to define the active product.

### Refresh roll-ups from Prune Daily automatically

Rejected because it would create a new active product without agreed consumers, completeness rules, timestamp grouping or operational ownership.

### Use stale roll-ups as a website fallback

Rejected because aggregate stale data cannot replace missing canonical hourly rows or identify hourly coloured-band intervals.

## Validation requirement

Current AQI changes must verify only the active hourly product unless they explicitly propose roll-up reactivation.

A future reactivation must update:

- [`../README.md`](../README.md);
- [`../contract.md`](../contract.md);
- [`../state-model.md`](../state-model.md);
- [`../interfaces.md`](../interfaces.md);
- [`../operations.md`](../operations.md);
- [`../recovery.md`](../recovery.md);
- [`../validation.md`](../validation.md);
- this decision through a superseding decision record.

## Contract impact

Future plans and implementations must not cite the mere existence of daily or monthly tables as evidence that daily or monthly AQI is active.