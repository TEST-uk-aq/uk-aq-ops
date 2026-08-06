# AQI levels system area

## Purpose

This directory is the authoritative documentation for UK AQ calculated hourly AQI levels.

The system calculates UK DAQI and European AQI for supported pollutant timeseries, persists closed historical values to R2, calculates station-chart AQI from the same observations used for the concentration line, and retains stored R2 AQI as a non-blocking validation artefact.

Raw observations remain authoritative source data and are owned by the observations system.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`station-history-contract.md`](station-history-contract.md) for continuity-aware chart rendering and stored-R2 validation
3. [`../station_charts/README.md`](../station_charts/README.md) for shared frontend ownership
4. [`../station_charts/contract.md`](../station_charts/contract.md) for browser modules, cache, AQI-source switching, renderer and page adapters
5. [`data-flow.md`](data-flow.md)
6. [`state-model.md`](state-model.md)
7. [`interfaces.md`](interfaces.md)
8. [`operations.md`](operations.md)
9. [`recovery.md`](recovery.md)
10. [`validation.md`](validation.md)
11. [`station-history-validation.md`](station-history-validation.md)
12. relevant records under [`decisions/`](decisions/)

For R2 physical/logical identity and binding publication, also read:

- [`../r2_history/contract.md`](../r2_history/contract.md);
- [`../r2_history/continuity.md`](../r2_history/continuity.md);
- [`../r2_history/interfaces.md`](../r2_history/interfaces.md);
- [`../r2_history/operations.md`](../r2_history/operations.md).

## Specific-contract precedence

[`station-history-contract.md`](station-history-contract.md) is the specific approved contract for the station-chart data path.

It deliberately changes one previous broad rule:

- stored R2 AQI remains authoritative persisted history and validation evidence;
- when calculated historical chart AQI is enabled, visible bands use AQI calculated from the same authoritative observations used for the line;
- stored R2 AQI validation runs asynchronously and does not replace, delay or redraw the chart;
- the retained separate foreground R2 AQI path is a feature-flag compatibility fallback.

Where older wording in the broad contract, data flow, interfaces or validation files says committed R2 AQI must win visible station-history overlaps, this specific station-history contract governs the new calculated-response path.

[`../station_charts/contract.md`](../station_charts/contract.md) governs the website architecture that consumes this data. It requires one shared controller, cache, AQI-source controller and renderer, with the compatibility source behind the same client boundary rather than a second chart implementation.

All unrelated AQI rules remain unchanged.

## Implementation ownership

This area governs:

- `lib/aqi/aqi_levels.mjs`;
- `workers/uk_aq_station_history/`;
- `workers/uk_aq_aqi_history_r2_api_worker/`;
- `workers/uk_aq_observs_history_r2_api_worker/` where used by station history;
- the AQI parts of `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- the AQI and binding parts of `workers/shared/uk_aq_r2_history_index.mjs`;
- AQI rebuild and repair paths under `workers/uk_aq_backfill_local/`, `scripts/backup_r2/` and `scripts/uk-aq-history-integrity/`;
- `.github/workflows/uk_aq_station_history_deploy.yml`;
- `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`;
- the station-history boundaries in `workers/uk_aq_cache_proxy/src/index.ts` and related modules.

The canonical Obs AQI database schema remains in:

```text
TEST-uk-aq/uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql
```

Website consumers governed by this AQI contract include:

- shared modules under `station_chart/`;
- the Hex Map station-chart adapter;
- the Sensors station-chart adapter;
- `station-history-loader.js` only while it remains a migration facade;
- any other active chart consumer discovered during implementation.

The frontend module boundaries and page ownership are defined by [`../station_charts/contract.md`](../station_charts/contract.md).

Those files are outside this repository, but their AQI interpretation must conform to this area.

## Active matrix

- Pollutants: `pm25`, `pm10`, `no2`
- Grain: hourly
- Indices: UK DAQI and European AQI
- Algorithm version: `aqilevels_hourly_v2`
- DAQI PM averaging: rolling 24-hour mean
- DAQI PM minimum valid hours: 18 of 24
- DAQI NO2 averaging: hourly mean
- European AQI averaging: hourly mean
- Canonical timestamp: hour endpoint
- Represented interval: `(n - 1 hour, n]`
- R2 history: persisted physical-timeseries AQI history
- Station-chart render source when enabled: calculated from the chart observation stream
- Stored R2 AQI role on that path: asynchronous validation
- Current website product: hourly coloured DAQI and European AQI bands aligned with concentration endpoints

Other observed-property codes remain valid raw observations but are not calculated AQI pollutants unless this contract is deliberately expanded.

## Active runtime paths

### Station-history request

The website sends one current active timeseries ID. The private station-history Worker resolves the exact R2 binding.

A schema-version-2 binding may contain a multi-member date-valid continuity family. The Worker selects physical members for the requested and PM-context ranges, while the website remains continuity-unaware.

### Authoritative observation stream

Committed exact physical R2 observations remain authoritative for matching timestamps. Recent ingest observations fill only R2-missing recent timestamps under the existing seam contract.

The Worker merges date-valid physical segments into one deterministic logical observation stream while preserving physical row identity.

### Calculated visible AQI

When enabled, the shared AQI library calculates DAQI and European AQI from that merged observation stream.

For PM, the preceding 23 endpoint hours may cross a physical timeseries transition. Calculation happens after logical merging so the transition does not reset rolling context.

PM DAQI uses the available valid hourly means when at least 18 of the 24 rolling hours are present. A missing hourly PM observation therefore leaves European AQI blank for that endpoint but does not automatically remove a valid rolling DAQI result.

Observations and calculated AQI are returned together.

### Stored R2 AQI validation

Stored R2 AQI remains independently materialised history.

After preparing the foreground response, the Worker compares calculated and stored immutable rows through background execution. Validation never changes the visible chart and never writes corrections.

### Persisted historical AQI

Prune Daily Phase B and any future Integrity or rebuild path that creates AQI use the same shared helper. They therefore inherit the 18-of-24 PM DAQI threshold, index-specific missing-hour output and `aqilevels_hourly_v2` algorithm version without a separate calculation implementation.

The v2 data and debug profiles and their manifests/indexes remain operational evidence and repair targets.

### Low-level read path

The private observations and AQI R2 APIs remain exact physical-timeseries readers. They do not resolve logical continuity.

## Inactive schema objects

Daily and monthly AQI roll-up tables and refresh SQL remain inactive and potentially stale.

They must not be treated as current products. Reactivation requires a separate contract decision and correct represented-period calendar handling.

## Mandatory timestamp rule

For endpoint `n`:

```text
period_start_utc = n - 1 hour
period_end_utc   = n
represented interval = (period_start_utc, period_end_utc]
```

A row ending at `07:00` colours `06:00` to `07:00`.

It must not colour `07:00` to `08:00`, extend through an index-specific missing hour or continue beyond the final valid endpoint for that index.

## Continuity and identity rule

Logical chart continuity does not change persisted physical row identity.

A historical row remains associated with the station and timeseries valid for its date. The request identity, logical continuity key and physical row identity are distinct.

The continuity key is:

```text
connector_id + uk_air_ref + pollutant_code
```

`site_ref` is retained and validated but is not part of the key.

## Feature-flag rollback

The implementation must retain independent controls for:

```text
continuity resolution
calculated historical AQI rendering
stored-R2 validation mode and sampling
historical identity repair execution
```

Disabling calculated rendering returns the shared website controller to the retained separate R2 AQI compatibility client. It must not activate a second frontend controller or renderer. Disabling continuity returns station history to exact requested-timeseries behaviour.

## Documentation boundary

Older broad AQI, R2-layout, Prune Daily and backfill documents may contain useful history. They do not override the active contracts in this directory, `system_docs/r2_history/` and `system_docs/station_charts/`.

Codex and other coding agents must read these files but must not edit `system_docs/`. Implementation differences must be reported to ChatGPT for post-implementation documentation review.
