# AQI levels system area

## Purpose

This directory is the authoritative documentation for UK AQ calculated hourly AQI levels.

The system calculates UK DAQI and European AQI levels for supported pollutant timeseries, serves recent values through the station-history path, persists closed historical values to R2, and supplies the coloured AQI bands used by the website station charts.

It is a derived product. Raw observations remain authoritative source data and are owned by the observations system.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`data-flow.md`](data-flow.md)
3. [`state-model.md`](state-model.md)
4. [`interfaces.md`](interfaces.md)
5. [`operations.md`](operations.md)
6. [`recovery.md`](recovery.md)
7. [`validation.md`](validation.md)
8. Relevant records under [`decisions/`](decisions/)

## Implementation ownership

This area governs the behaviour of the active AQI code in this repository:

- `lib/aqi/aqi_levels.mjs`;
- `workers/uk_aq_station_history/`;
- `workers/uk_aq_aqi_history_r2_api_worker/`;
- the AQI parts of `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- the AQI parts of `workers/shared/uk_aq_r2_history_index.mjs`;
- AQI rebuild and repair paths under `workers/uk_aq_backfill_local/`, `scripts/backup_r2/` and `scripts/uk-aq-history-integrity/`;
- `.github/workflows/uk_aq_station_history_deploy.yml`;
- `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`;
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`;
- the station-history boundaries in `workers/uk_aq_cache_proxy/src/index.ts`.

The canonical Obs AQI database schema is maintained in the schema repository at:

- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`.

Website consumers governed by this contract include:

- `station-history-loader.js`;
- `hex_map/index.html`;
- `sensors/index.html`.

Those files are outside this repository, but changes to their AQI interpretation must conform to this contract.

## Active matrix

- Pollutants: `pm25`, `pm10`, `no2`
- Grain: hourly
- Indices: UK DAQI and European AQI
- DAQI PM averaging: rolling 24-hour mean
- DAQI NO2 averaging: hourly mean
- European AQI averaging: hourly mean
- R2 history version: configured explicitly as `v1` or `v2`; TEST currently requires an explicit repository variable
- Current website product: hourly coloured bands aligned with hourly concentration values

Other observed-property codes remain valid raw observations but are not calculated AQI pollutants unless this contract is deliberately expanded.

## Active runtime paths

### Recent and mixed station history

`uk-aq-station-history` reads recent observations directly from ingest, uses R2 observations where needed, calculates R2-missing recent AQI rows with the shared AQI library, and keeps R2 AQI authoritative for overlapping canonical hours.

### Persisted historical AQI

Prune Daily Phase B writes hourly AQI history to R2. In v2, the public data profile and the diagnostic debug profile are separate object families with manifests. Targeted indexes make timeseries reads bounded.

### Read path

The private AQI History R2 API Worker reads committed R2 history and returns normalized hourly rows. The private station-history Worker combines those rows with recent calculated values and exposes the result to the cache proxy through a Service Binding.

## Inactive schema objects

The schema still contains daily and monthly AQI roll-up tables and a refresh RPC. The Cloud Run service that used to maintain those roll-ups was archived on 13 July 2026 and its deployment workflow was removed.

Therefore:

- hourly AQI is the active calculated product;
- daily and monthly AQI roll-ups are not an active or authoritative runtime product;
- old daily or monthly rows may exist but must be treated as potentially stale;
- any reactivation requires an explicit contract decision and corrected calendar-period timestamp handling.

## Mandatory timestamp rule

For an AQI value whose canonical timestamp is `n`:

```text
period_start_utc = n - 1 hour
period_end_utc   = n
represented interval = (period_start_utc, period_end_utc]
```

The coloured section for a row ending at `07:00` represents `06:00` to `07:00`. It must not represent `07:00` to `08:00` and must not extend beyond the final plotted concentration timestamp.

See [`decisions/0001-hour-ending-aqi-intervals.md`](decisions/0001-hour-ending-aqi-intervals.md).

## Known implementation discrepancies at document creation

As of 17 July 2026, the following active code does not fully conform to the timestamp rule:

- both website chart renderers place the AQI value at `n` into the visual slot starting at `n`;
- the AQI History R2 API exposes the stored endpoint timestamp under the name `period_start_utc` without subtracting one hour;
- station-history expected-hour and range checks generally use start-inclusive, end-exclusive endpoint selection rather than `start < n <= end`;
- daily and monthly roll-up SQL groups by the endpoint date, although those roll-ups are currently inactive;
- on-the-fly normalization floors arbitrary observation timestamps to the hour, which is safe only when supported source observations already use exact hour-ending timestamps.

This documentation records the required behaviour before the coordinated implementation correction so future work can be checked against an explicit contract.

## Documentation boundary

Older broad AQI, R2 layout, Prune Daily and backfill documents may still contain useful implementation history. They are not allowed to override this directory's behavioural contract.

Retired services and archived implementations must not be mixed into current operating instructions.