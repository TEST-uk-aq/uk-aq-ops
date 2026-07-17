# AQI levels behavioural contract

## Authority

This file is the authoritative behavioural contract for UK AQ calculated hourly AQI levels.

Implementation files, worker-local READMEs, plans, tests and archives MUST conform to this contract unless an intentional contract change is approved and documented in the same branch or pull request.

## Purpose

The AQI levels system converts eligible pollutant observations into deterministic hourly UK DAQI and European AQI rows for historical storage and website display.

It is a derived interpretation layer. It MUST NOT replace, rewrite or suppress authoritative raw observation history.

## Scope

The active product is:

- pollutants: `pm25`, `pm10`, `no2`;
- grain: hourly;
- indices: UK DAQI and European AQI;
- output: normalized per-timeseries, per-pollutant hourly rows;
- historical persistence: R2 AQI levels history;
- recent values: calculated on demand where committed R2 AQI is not yet available;
- website use: coloured hourly DAQI and European AQI bands.

Daily and monthly AQI roll-ups are not currently active products.

## Definitions

### Source observation

An observation retained by the wider observations system. Its identity, timestamp and value are source data.

### Canonical AQI endpoint

`timestamp_hour_utc`, denoted by `n`, is the end of the represented hourly interval.

### Represented interval

For one AQI row:

```text
period_start_utc = timestamp_hour_utc - 1 hour
period_end_utc   = timestamp_hour_utc
interval         = (period_start_utc, period_end_utc]
```

### Canonical AQI row identity

The logical identity is:

```text
(timeseries_id, pollutant_code, timestamp_hour_utc)
```

The Obs AQI database primary key may omit `pollutant_code` because one timeseries is required to resolve to one canonical pollutant. That storage optimisation MUST NOT permit one timeseries to change pollutant identity silently.

## Supported pollutants

Only these canonical codes are AQI-calculation inputs:

- `pm25`;
- `pm10`;
- `no2`.

Other observed-property codes remain eligible for raw observation history but MUST NOT be inserted into calculated AQI levels as one of these pollutants through fuzzy or fallback matching.

Source-provided index observations such as `pm25index`, `pm10index` and `no2index` remain raw source observations. They are not substitutes for UK AQ calculated AQI rows.

## Source-value eligibility

An observation may contribute to calculated AQI only when:

1. its timeseries, station, connector and pollutant identity resolve;
2. the value is numeric and finite;
3. the value is greater than or equal to zero;
4. the timestamp is parseable;
5. it is not rejected by an existing source-quality rule applied before AQI calculation.

Zero is valid.

Negative and non-finite values MUST NOT contribute to hourly means, rolling means or AQI levels. Their raw observation rows remain untouched.

## Hourly aggregation

Observations assigned to one canonical hour are averaged to form `hourly_mean_ugm3`.

The active implementation assumes supported source observations are already expressed at the expected hourly timestamp. Arbitrary sub-hour timestamps MUST NOT be assigned by floor or ceiling without a documented source-timestamp decision.

Before changing bucket assignment, verify the timestamp convention for every active supported connector. This is a targeted source-contract check, not a reason to change the AQI endpoint rule.

## Averaging rules

### UK DAQI

- NO2 uses the hourly mean ending at `n`.
- PM2.5 uses the rolling 24-hour mean ending at `n`.
- PM10 uses the rolling 24-hour mean ending at `n`.

For PM, the rolling input contains the hourly values whose endpoints are:

```text
n - 23 hours, ..., n - 1 hour, n
```

A PM DAQI result is valid only when all 24 required hourly values are available. Fewer than 24 valid hours produces:

```text
daqi_calculation_status = insufficient_samples
daqi_index_level = null
daqi_missing_reason = insufficient_rolling_24h_hours
```

### European AQI

NO2, PM2.5 and PM10 use the hourly mean ending at `n`.

European AQI is independent of PM DAQI rolling-window completeness. A row may therefore contain a valid European AQI level while its PM DAQI level is null because fewer than 24 rolling hours are available.

A valid European AQI result MUST NOT be suppressed solely because DAQI is unavailable.

## Breakpoint boundary rule

Breakpoints use an inclusive upper bound. Where consecutive bands meet at value `x`, `x` belongs to the lower-numbered level and the next level starts immediately above `x`.

A value below zero or without a matching breakpoint produces no index level.

## UK DAQI breakpoints

### NO2 hourly mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 67` |
| 2 | `67 < value <= 134` |
| 3 | `134 < value <= 200` |
| 4 | `200 < value <= 267` |
| 5 | `267 < value <= 334` |
| 6 | `334 < value <= 400` |
| 7 | `400 < value <= 467` |
| 8 | `467 < value <= 534` |
| 9 | `534 < value <= 600` |
| 10 | `value > 600` |

### PM2.5 rolling 24-hour mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 11` |
| 2 | `11 < value <= 23` |
| 3 | `23 < value <= 35` |
| 4 | `35 < value <= 41` |
| 5 | `41 < value <= 47` |
| 6 | `47 < value <= 53` |
| 7 | `53 < value <= 58` |
| 8 | `58 < value <= 64` |
| 9 | `64 < value <= 70` |
| 10 | `value > 70` |

### PM10 rolling 24-hour mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 16` |
| 2 | `16 < value <= 33` |
| 3 | `33 < value <= 50` |
| 4 | `50 < value <= 58` |
| 5 | `58 < value <= 66` |
| 6 | `66 < value <= 75` |
| 7 | `75 < value <= 83` |
| 8 | `83 < value <= 91` |
| 9 | `91 < value <= 100` |
| 10 | `value > 100` |

## European AQI breakpoints

### NO2 hourly mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 10` |
| 2 | `10 < value <= 25` |
| 3 | `25 < value <= 60` |
| 4 | `60 < value <= 100` |
| 5 | `100 < value <= 150` |
| 6 | `value > 150` |

### PM2.5 hourly mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 5` |
| 2 | `5 < value <= 15` |
| 3 | `15 < value <= 50` |
| 4 | `50 < value <= 90` |
| 5 | `90 < value <= 140` |
| 6 | `value > 140` |

### PM10 hourly mean, µg/m³

| Level | Range |
|---:|---|
| 1 | `0 <= value <= 15` |
| 2 | `15 < value <= 45` |
| 3 | `45 < value <= 120` |
| 4 | `120 < value <= 195` |
| 5 | `195 < value <= 270` |
| 6 | `value > 270` |

## Calculation statuses

The normalized status vocabulary is:

- `ok`;
- `insufficient_samples`;
- `missing_input`;
- `unsupported_pollutant`.

DAQI and European AQI statuses are independent fields.

A null index level MUST be accompanied by an appropriate status and, where available, a stable missing reason. Null is data, not permission for a reader to invent or carry forward a level.

## Time and range invariants

### Endpoint selection

For a requested represented interval from `S` to `E`, the required canonical AQI endpoints are:

```text
S < timestamp_hour_utc <= E
```

This ensures the first returned row colours `S` to `S + 1 hour`, and the final returned row ends at `E`.

### No forward extension

A row ending at `n` MUST NOT colour, claim coverage for, or be carried into any time after `n`.

The final coloured AQI section must end at the final valid AQI endpoint. It must align with the final plotted concentration value where both products cover the same endpoint.

### Missing hours

A missing hour remains blank. Readers and renderers MUST NOT:

- stretch the previous level into the missing hour;
- stretch a later level backwards across the gap;
- infer a level from visual continuity;
- treat a missing DAQI level as permission to discard a valid European AQI level.

### UTC day storage

The existing R2 `day_utc` partition is based on the date of `timestamp_hour_utc`, which is the endpoint date.

Therefore a represented interval ending at midnight is stored under the new endpoint day. Readers selecting `S < n <= E` MUST include any endpoint-day partition needed to retrieve the row ending at `E`.

Repartitioning existing R2 history by period-start date is not required by this contract.

## Source precedence

For the same canonical AQI row identity:

1. committed R2 AQI is authoritative;
2. recent live calculation fills only R2-missing eligible endpoints;
3. a live row MUST NOT overwrite a committed R2 row;
4. overlap disagreement must be reported, not silently resolved in favour of live calculation.

For source observations used by live calculation:

1. R2 observations are authoritative for the same exact timestamp;
2. ingest observations fill R2-missing recent timestamps;
3. duplicates are deterministically deduplicated.

## Completeness and partial responses

- AQI completeness and observation completeness remain separate.
- DAQI availability and European AQI availability remain separately reportable.
- A response with gaps, scan-budget exhaustion, source uncertainty or unresolved identity must be marked incomplete or partial.
- Partial responses MUST use non-cacheable behaviour where the active interface defines it.
- A client MUST NOT treat HTTP 200 alone as proof of complete AQI history.

## R2 history invariants

For v2 AQI history:

- the `data` profile is the bounded public read profile;
- the `debug` profile preserves calculation inputs and diagnostic counts;
- both profiles must have their required pollutant, connector and day manifests;
- committed manifests, not loose parquet discovery, define readable history;
- timeseries indexes must be derived from final committed manifests and remain byte-stable when source manifests have not changed;
- unchanged index payloads must not be rewritten solely because a job ran again.

Prune Daily observation deletion remains gated by the observation-history gate. AQI export failure is an AQI-history defect and repair target; it does not silently redefine the observation deletion gate.

## Website rendering invariants

For each index row ending at `n`:

- the coloured rectangle starts at `n - 1 hour`;
- the coloured rectangle ends at `n`;
- the marker or concentration endpoint at `n` aligns with the right edge of the rectangle;
- the renderer clips to the requested chart interval;
- the final rectangle does not extend to `n + 1 hour`;
- DAQI and European AQI use the same time boundaries even though their values may differ.

## Daily and monthly roll-ups

Daily and monthly roll-up tables and refresh SQL remain in the schema but are inactive.

They MUST NOT be described as current, complete or authoritative.

If reactivated, calendar grouping must use the represented interval's start date:

```text
period_start_utc = timestamp_hour_utc - 1 hour
```

Grouping solely by the endpoint date is not acceptable because the hour ending at midnight belongs to the preceding represented calendar hour.

## Explicit non-goals

A timestamp or rendering correction MUST NOT, unless separately approved:

- change breakpoint values;
- add pollutants;
- alter raw observation history;
- alter source-provided index observations;
- change R2 source precedence;
- change the shared hourly/rolling calculation formulas;
- make daily or monthly roll-ups active;
- weaken identity resolution;
- turn partial responses into complete responses;
- remove diagnostic `debug` history;
- broaden R2 scans when required indexes are missing;
- hand-edit historical parquet or website cache entries.

## Known implementation discrepancies

At the time this contract was created:

- website renderers treated `n` as the visual period start;
- the R2 API projected `timestamp_hour_utc` into a field named `period_start_utc` without transformation;
- station-history expected endpoints used start-inclusive, end-exclusive range generation;
- inactive roll-up SQL grouped on the endpoint date;
- on-the-fly aggregation floored arbitrary source timestamps to the hour.

These behaviours do not override this contract.

## Contract-change rule

Any future change to pollutant support, breakpoint boundaries, averaging windows, endpoint semantics, row identity, R2 precedence, completeness, data/debug profiles, website interval rendering or roll-up activation requires:

1. an update to this contract;
2. an update or new decision record;
3. structural review of every active producer and consumer;
4. minimal targeted checks;
5. post-deployment validation through real TEST operation.