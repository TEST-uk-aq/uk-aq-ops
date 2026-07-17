# AQI levels state model

## Purpose

The active AQI product is a set of normalized hourly derived rows. It is not a mutable latest-value state object and it is not raw observation history.

This document defines the identity, timestamp, calculation-status and source-precedence state associated with one hourly AQI row.

## Canonical row identity

The logical key is:

```text
(timeseries_id, pollutant_code, timestamp_hour_utc)
```

Required identity invariants:

- `timeseries_id` is a positive integer;
- `pollutant_code` is one of `pm25`, `pm10`, `no2`;
- `timestamp_hour_utc` is an exact UTC hour endpoint;
- connector and station metadata must agree with the authoritative timeseries identity;
- one canonical row may exist per logical key in a merged response.

The Obs AQI database table uses `(timeseries_id, timestamp_hour_utc)` as its primary key. This relies on the invariant that one timeseries resolves to one pollutant. Pollutant drift for an existing timeseries is an identity defect, not a normal update.

## Timestamp state

For a canonical endpoint `n`:

```text
timestamp_hour_utc = n
period_start_utc   = n - 1 hour
period_end_utc     = n
```

The represented interval is:

```text
(period_start_utc, period_end_utc]
```

`timestamp_hour_utc` must never be interpreted as a forward-looking period start.

## Example

```json
{
  "timeseries_id": 3742,
  "station_id": 812,
  "connector_id": 6,
  "pollutant_code": "pm25",
  "timestamp_hour_utc": "2026-07-17T07:00:00.000Z",
  "daqi_index_level": 2,
  "eaqi_index_level": 3
}
```

This row colours:

```text
06:00 to 07:00
```

It does not colour `07:00` to `08:00`.

## Calculation sub-states

DAQI and European AQI each have independent state:

```text
input value
averaging code
source observation count
required observation count
calculation status
missing reason
index level
```

A row is not all-or-nothing. Examples include:

| DAQI state | European AQI state | Required interpretation |
|---|---|---|
| `ok` | `ok` | Both bands available |
| `insufficient_samples` | `ok` | European AQI available; DAQI blank |
| `missing_input` | `missing_input` | No band for either index |
| `ok` | `missing_input` | DAQI available; European AQI blank |

A reader must inspect the two index fields independently.

## DAQI state transitions for PM

For each PM endpoint `n`:

1. collect valid hourly means ending at `n - 23h` through `n`;
2. count available hourly values;
3. when count is 24, calculate the rolling mean and lookup the DAQI level;
4. when count is below 24, retain the hourly row but set DAQI to `insufficient_samples`;
5. calculate European AQI independently from the hourly mean at `n`.

A newly available preceding context hour may change a recent PM DAQI row from `insufficient_samples` to `ok`. This is why recent AQI remains mutable for the configured mutable horizon.

## NO2 state

NO2 DAQI and European AQI both use the hourly mean ending at `n`, with different breakpoint tables.

A valid hourly NO2 input normally yields both levels from the same input value.

## Source row deduplication

Source observation deduplication uses exact observation identity before hourly aggregation.

Required behaviour:

- exact duplicate source timestamps do not create duplicate hourly samples;
- R2 observation rows replace ingest rows for the same exact timestamp in a merged calculation source;
- invalid values are excluded before aggregation;
- different valid samples assigned to the same canonical hour contribute to that hour's mean only when the source timestamp convention supports that assignment.

## Hourly-row merge precedence

For the same canonical AQI key:

| Existing source | Incoming source | Required retained row |
|---|---|---|
| None | Live calculated | Live calculated |
| None | R2 | R2 |
| Live calculated | R2 | R2 |
| R2 | Live calculated | R2 |
| R2 | Conflicting R2 duplicate | Mark conflict or fail the affected response |
| Stable head | Older history chunk | Stable head |

R2 precedence is load-bearing. It prevents a mutable recalculation from silently rewriting committed history at read time.

## Stable-head state

The station-history Worker divides a request into a bounded recent head and optional older chunks.

The recent head may contain:

- committed R2 rows;
- live-calculated rows for R2-missing eligible endpoints.

Once accepted for one load:

- the head is authoritative for its own interval;
- older chunks extend backwards only;
- older chunks do not replace head rows;
- a later fresh head request may replace the previous head within the newly requested head interval.

## Completeness state

AQI responses use explicit completeness state rather than assuming that returned rows cover every expected hour.

Relevant state includes:

- `response_complete`;
- `has_gap`;
- `coverage_state`;
- `partial_reasons`;
- per-source coverage intervals;
- scan-budget stop reasons;
- DAQI and European AQI availability diagnostics.

Expected endpoint generation must follow:

```text
request start < endpoint <= request end
```

A response is not complete merely because its row count is non-zero.

## R2 persistence profiles

### Data profile

The v2 data profile contains the public hourly state needed by the read path:

- identity;
- endpoint;
- DAQI and European AQI levels;
- calculation statuses;
- missing reasons.

### Debug profile

The v2 debug profile additionally contains:

- input values;
- averaging codes;
- source and required counts;
- hourly sample count;
- algorithm version;
- calculation timestamp.

The two profiles must describe the same canonical AQI keys and index outcomes. Debug data must not contain a second independently calculated result.

## Manifest state

R2 commit state is hierarchical:

```text
parquet object
  -> pollutant manifest
      -> connector manifest
          -> day manifest
```

A row is readable historical AQI only when the required committed manifest hierarchy exists.

Loose parquet objects are not committed state.

A parent manifest must represent every final child in its scope. A connector-scoped repair must not rebuild a day manifest from only that connector's children.

## Index state

AQI data indexes are derived state.

They must be reproducible from committed manifests and parquet metadata. They must not introduce row counts, timeseries coverage or timestamps that are absent from their sources.

An index object is unchanged when its source-derived bytes are unchanged, even if it was regenerated by a later run.

## R2 endpoint-day partition

The current partition key `day_utc` follows the date of `timestamp_hour_utc`.

Example:

```text
endpoint: 2026-07-18T00:00:00Z
partition: day_utc=2026-07-18
represented interval: 2026-07-17T23:00:00Z to 2026-07-18T00:00:00Z
```

This storage rule and the represented calendar interval are intentionally different concepts.

## Daily and monthly roll-up state

The following schema objects may still contain rows:

- `uk_aq_aqilevels.timeseries_aqi_daily`;
- `uk_aq_aqilevels.timeseries_aqi_monthly`.

Their previous updater is inactive. Their contents are therefore not current state and must not be used as an authoritative website or API source.

Any future activation needs a separate state contract covering:

- calendar grouping by `period_start_utc`;
- completeness requirements;
- late-arriving corrections;
- rebuild and invalidation behaviour.

## Algorithm version

The shared normalized row currently uses:

```text
aqilevels_hourly_v1
```

An algorithm-version change is required when calculation semantics change. Renaming a field or correcting an API projection without changing levels may require a response-contract version instead of an algorithm version.

## State invariants summary

- A row at `n` ends at `n`.
- R2 wins over live for the same row.
- Missing remains missing.
- DAQI and European AQI availability are independent.
- A partial source never becomes complete through merging unless every expected endpoint and required context is proven.
- Historical readability requires committed manifests and required indexes.
- Inactive roll-ups are not current state.