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

The following-day `00:00` hour-ending observation is part of the target WHO day. Source selection for that boundary observation MUST therefore be correct even when the target day and following day currently live in different storage layers.

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

## Normal daily source priority and fallback

For normal daily operation, source priority MUST be:

1. Obs AQI DB when the readiness gate passes;
2. exact-day R2 v2 observation fallback when readiness fails, the readiness RPC fails, the Obs AQI DB refresh fails or the database calculation returns no usable daily rows;
3. unavailable when neither source produces usable daily rows.

A failed readiness gate MUST NOT cause the worker to calculate the latest day from Obs AQI DB.

An unavailable latest day MUST NOT prevent a usable correction day from being recalculated and selected for publication.

The report MUST retain the readiness counts, percentages, source decision, fallback result and reasons for each attempted day.

## Backfill source selection

Backfill source selection MUST follow storage authority rather than assuming that every requested day has already reached R2.

For a requested WHO day `D`:

1. The worker MUST first determine whether the top-level R2 v2 observation day manifest for `D` exists.
2. If that top-level manifest exists, validated R2 is authoritative for the target day. The worker MUST NOT replace an existing but unhealthy R2 partition with Obs AQI DB data.
3. If the top-level R2 day manifest for `D` is genuinely absent, the worker MAY use Obs AQI DB for the full WHO day when that database still contains the required observation window.
4. Source availability for the following-day boundary MUST be resolved independently because the target WHO day includes the following `00:00` hour-ending observation.
5. If `D` is read from validated R2 and the top-level R2 day manifest for `D+1` also exists, the required boundary observation MUST come through the validated R2 path.
6. If `D` is read from validated R2 but the top-level R2 day manifest for `D+1` is genuinely absent, the worker MAY obtain only the required `D+1 00:00` boundary observations from Obs AQI DB and combine them with the validated R2 target-day observations.
7. If neither storage layer can provide the complete required WHO observation window, the day MUST be reported as unavailable or failed with a clear reason. The worker MUST NOT fabricate, duplicate or silently omit the boundary observation.

Backfill processing order does not change raw observation storage authority. Reverse chronological processing MUST NOT be used as a substitute for correct source selection.

### R2 absence versus R2 integrity failure

Only failure to find the initial top-level day manifest being probed for `D` or `D+1` may be treated as an R2 source-availability condition.

The top-level observation manifest path is:

```text
history/v2/observations/day_utc=<DAY>/manifest.json
```

Once that top-level day manifest has been read successfully, R2 has declared the partition to exist. All referenced R2 content MUST then validate through the existing integrity rules.

The following MUST remain hard R2 failures and MUST NOT trigger Obs AQI DB fallback:

- invalid JSON in an existing manifest;
- manifest schema or identity failure;
- incomplete or partial coverage state;
- manifest hash mismatch;
- a connector manifest referenced by an existing parent manifest being missing;
- a pollutant manifest referenced by an existing parent manifest being missing;
- a Parquet object referenced by an existing manifest being missing;
- connector, pollutant or day identity mismatch;
- row-count, file-count or byte-count mismatch;
- Parquet hash mismatch;
- unsupported or invalid Parquet schema;
- any other existing R2 integrity or validation failure.

In short:

```text
top-level day manifest absent -> that day may not have reached R2; another source may be considered

top-level day manifest exists -> the declared R2 partition is authoritative and all referenced content must validate
```

Fallback logic MUST NOT weaken existing R2 validation.

## Backfill reporting

The report MUST make the observation source decision clear for every attempted backfill day.

It MUST distinguish at least these cases:

- full WHO day from validated R2;
- full WHO day from Obs AQI DB because the target R2 day manifest is absent;
- target day from validated R2 with the following `00:00` boundary supplied by Obs AQI DB;
- unavailable or failed source selection.

The representation MAY preserve the existing `source` field, but a mixed-source day MUST expose the boundary source explicitly or through an equally clear structured field. Report consumers must not be left to infer mixed-source behaviour from warnings or error text.

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

The newest publication day MUST be the newest attempted day that produced usable daily rows from an authorised source path.

Summary refresh MUST use that publication day, not an unavailable newer day.

When enabled, derived Parquet objects MUST be written before the dated summary JSON and latest summary JSON.

The stable latest summary object remains:

```text
history/v2/who_2021/latest_who_2021.json
```

A run with no usable publication day MUST defer summary and R2 publication rather than publish an empty or misleading latest result.

## Preserved behaviour

Implementations MUST preserve:

- the configured pollutants PM2.5, PM10 and NO2;
- the hour-ending daily window;
- the 18-valid-hour daily rule;
- the configured rolling-year valid-day rule;
- correction-day recalculation;
- normal daily Obs AQI DB readiness and exact-day R2 fallback behaviour;
- existing R2 manifest and Parquet integrity validation;
- the existing WHO R2 object paths and payload schema unless a separately approved contract change requires otherwise;
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
