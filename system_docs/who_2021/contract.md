# WHO 2021 derived-data contract

Status: authoritative for the WHO 2021 daily, rolling-year and calendar-year calculation and publication process.

## Purpose

The WHO 2021 process creates health-guideline comparison products for GOV.UK AURN PM2.5, PM10 and NO2 observations. It is a derived-data process. It does not alter source observations, calculated DAQI products or UK legal-limit reporting.

## Source and timestamp convention

The normal daily source is Obs AQI DB for connector `1` and source network `gov_uk_aurn`.

The configured pollutant set is normally:

```text
pm25,pm10,no2
```

GOV.UK AURN observations use hour-ending timestamps. A WHO day therefore uses:

```text
observed_at > day_start
observed_at <= day_end
```

For a UTC day, this corresponds to hour-ending timestamps `01:00` through the following `00:00`.

## Daily scientific completeness

Each eligible timeseries-day MUST be assessed independently.

A daily mean is scientifically usable only when the timeseries has at least the configured number of valid hourly values. The normal minimum is 18 of 24 hours.

A value is valid for the daily calculation only when it is non-null and non-negative.

When the minimum is met, the result MUST be classified as either:

- `above_guideline`; or
- `within_guideline`.

When the minimum is not met:

- the daily mean MUST be null;
- the result MUST be `not_enough_data`;
- it MUST NOT be treated as a valid day in rolling-year or calendar-year means.

This per-timeseries rule is the scientific daily completeness control. The readiness gate is not a substitute for it.

## Operational readiness gate

The readiness gate exists only to detect a substantially incomplete recent ingest before the worker treats Obs AQI DB as the source for the newest day.

It MUST be applied separately to every configured pollutant.

For each pollutant:

1. Determine the timeseries eligible during the final six-hour window. A timeseries is eligible when it has started by the inclusive window end and has not ended before or at the exclusive window start.
2. Count the eligible timeseries with at least one non-null, non-negative observation in the final six-hour hour-ending window.
3. Compare that count with the configured minimum coverage ratio.

The final-six-hour window MUST be:

```sql
observed_at > day_end - interval '6 hours'
and observed_at <= day_end
```

For a UTC day this covers the hour-ending timestamps:

```text
19:00, 20:00, 21:00, 22:00, 23:00 and 00:00
```

The default minimum coverage ratio MUST be 0.5, or 50%.

Every configured pollutant MUST pass. A pollutant with no eligible timeseries MUST fail readiness.

The gate MUST NOT require an observation at exactly midnight. A timeseries with any valid reading inside the final six-hour window contributes once to the numerator.

The gate is deliberately weak. Passing it means the recent ingest is sufficiently present to attempt the normal daily calculation. It does not assert that every station is complete or that every daily result will meet the 18-hour rule.

## Source priority and fallback

For daily operation, source priority MUST be:

1. Obs AQI DB when the readiness gate passes;
2. exact-day R2 v2 observation fallback when readiness fails, the readiness RPC fails, the Obs AQI DB refresh fails or the database calculation returns no usable daily rows;
3. unavailable when neither source produces usable daily rows.

A failed readiness gate MUST NOT cause the worker to calculate the latest day from Obs AQI DB.

An unavailable latest day MUST NOT prevent a usable correction day from being recalculated and selected for publication.

The report MUST retain the readiness counts, percentages, source decision, fallback result and reasons for each attempted day.

## Correction day

A normal daily run MUST process both:

- the latest complete UTC day; and
- the preceding correction day.

The correction day is recalculated because late or corrected observations may change its daily results.

A prior successful run for a day MUST NOT suppress recalculation when that day is within the normal daily window.

## Rolling year

The rolling-year period MUST contain the 365 calendar days ending on `as_of_day_utc`.

A timeseries rolling-year result is usable only when it has at least the configured number of valid daily results. The normal minimum is 274 valid days.

The rolling-year product is inherently provisional because its newest daily inputs may be late, corrected or subsequently ratified. The database contract MUST NOT require an `is_final` field for rolling-year rows.

A future website view of an earlier rolling period MAY infer an appropriate provisional or ratified presentation from the period and underlying data context. That presentation rule is not stored as a rolling-year finality flag by this process.

## Calendar year

The calendar-year product uses the last complete calendar year relative to `as_of_day_utc`.

Calendar-year status MAY retain an explicit `is_final` field because it represents a closed calendar period and has different finality semantics from the continuously moving rolling year.

## Summary publication

The newest publication day MUST be the newest attempted day that produced usable daily rows from either source.

Summary refresh MUST use that publication day, not an unavailable newer day.

When enabled, derived Parquet objects MUST be written before the dated summary JSON and latest summary JSON.

The stable latest summary object remains:

```text
history/v2/who_2021/latest_who_2021.json
```

A run with no usable publication day MUST defer summary and R2 publication rather than publish an empty or misleading latest result.

## Preserved behaviour

This readiness change MUST preserve:

- the configured pollutants PM2.5, PM10 and NO2;
- the hour-ending daily window;
- the 18-valid-hour daily rule;
- the configured rolling-year valid-day rule;
- correction-day recalculation;
- exact-day R2 fallback;
- the existing WHO R2 object paths and payload schema;
- the cache-proxy and website behaviour defined by the WHO summary cache contract;
- the absence of a rolling-year `is_final` field.

## Non-goals

This contract does not:

- claim that 50% recent-window coverage is scientific completeness;
- require every eligible station to publish during the final six hours;
- alter WHO guideline values;
- alter source observations;
- alter calculated DAQI or European AQI;
- define homepage wording or layout;
- define browser or edge-cache behaviour.
