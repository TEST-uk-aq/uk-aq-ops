# AQI levels data flow

## Overview

```text
Connector observations
  -> ingest observations
      -> recent station-history read
          -> shared AQI calculation
              -> recent live AQI rows

Connector observations
  -> Obs AQI observations
      -> Prune Daily Phase B
          -> shared AQI calculation or legacy materialised AQI export
              -> R2 AQI data profile
              -> R2 AQI debug profile
              -> pollutant / connector / day manifests
              -> AQI timeseries indexes

R2 AQI history
  -> private AQI History R2 API Worker
      -> private station-history Worker
          -> cache proxy
              -> website station chart
                  -> DAQI and European AQI coloured bands
```

The recent and persisted paths must produce equivalent normalized hourly semantics. They may differ in source and completeness, but they must not disagree about what timestamp `n` represents.

## Stage 1: source observations

### Inputs

AQI calculation accepts source observations whose metadata resolves to:

- `pm25`;
- `pm10`;
- `no2`.

Raw source observations remain owned by the observations system. AQI calculation reads them but does not rewrite them.

### Required source behaviour

- Negative or non-finite values do not contribute to AQI.
- Zero remains valid.
- Unsupported observed-property codes remain raw history and are ignored by calculated AQI.
- Source-provided DAQI/index observations remain separate from UK AQ calculated AQI.

## Stage 2: authoritative identity resolution

Before station-history data is returned, the requested timeseries identity is resolved through current metadata.

The authoritative identity includes:

- timeseries ID;
- connector ID;
- station ID;
- canonical pollutant code.

A request that supplies a conflicting connector, station or pollutant must fail rather than query another identity accidentally.

## Stage 3: recent direct observation read

### Component

`workers/uk_aq_station_history/src/index.mjs`

### Behaviour

The station-history Worker performs one logical recent observation read directly from ingest through the configured public RPC.

It uses the smallest supported RPC window that covers the genuinely required source interval. The retention period is a capability hint, not a claim that every series has complete data back to that boundary.

For PM AQI, the required source interval includes 23 additional endpoint hours before the first requested AQI endpoint so a 24-hour rolling mean can be calculated.

### Direct-only qualification

The recent response is ingest-only only when the direct source covers:

- the full requested observation output;
- the requested end;
- the required PM rolling context;
- all expected AQI endpoints where AQI is enabled.

Otherwise the same direct result is reused with bounded R2 sources. It must not be discarded and fetched again through a stitched public endpoint.

## Stage 4: recent on-the-fly AQI calculation

### Shared implementation

`lib/aqi/aqi_levels.mjs`

### Processing

1. Validate and deduplicate source observation rows.
2. Normalize the canonical pollutant code.
3. Aggregate valid values to hourly means.
4. Calculate PM rolling 24-hour means.
5. calculate DAQI and European AQI independently.
6. Emit normalized rows for requested canonical endpoints.

### Required endpoint rule

For a requested represented interval `S` to `E`, the output endpoints are:

```text
S < n <= E
```

The row ending at `n` represents `n - 1 hour` to `n`.

### Independent index outcomes

For PM, missing rolling context may produce:

- DAQI null with `insufficient_samples`;
- European AQI valid from the available hourly mean.

The row remains useful and must be returned with both statuses.

## Stage 5: stable R2/live AQI head

When direct ingest cannot authoritatively serve the whole recent AQI head:

1. request the bounded AQI head from the R2 AQI API;
2. normalize committed R2 rows to canonical hourly identity;
3. identify expected endpoints missing from R2;
4. read bounded R2 observations and merge them with direct ingest observations;
5. calculate live AQI only for R2-missing eligible endpoints;
6. merge rows with R2 authoritative over live calculation;
7. report overlap mismatches and all remaining gaps.

A live row must never overwrite an R2 row for the same canonical endpoint.

## Stage 6: Prune Daily AQI history creation

### Component

`workers/uk_aq_prune_daily/phase_b_history_r2.mjs`

### Current branches

The code supports two configurable branches:

1. observation-derived AQI, using the shared calculation library;
2. legacy materialised hourly AQI export through the Obs AQI RPC.

Repository workflow defaults are not proof of the deployed branch because repository variables can override them. Before changing the writer, confirm the deployed values of:

- `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED`;
- `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED`;
- `UK_AQ_R2_HISTORY_VERSION`.

This is a genuinely necessary targeted configuration check.

### Observation-derived source window

For each target day and connector, the v2 writer freezes observations covering the preceding day and target day so PM rolling context is available.

It writes only target-day AQI endpoint rows to the target AQI partition.

### Required equivalence

Regardless of branch, the written row at endpoint `n` must have the same averaging, breakpoint, status and interval semantics as a recent on-the-fly row at `n`.

## Stage 7: v2 R2 profiles

### Data profile

The data profile contains fields required for bounded public AQI history reads:

- identity;
- canonical endpoint;
- DAQI and European AQI levels;
- calculation statuses;
- missing reasons.

### Debug profile

The debug profile contains diagnostic calculation inputs and counts in addition to the public levels and statuses.

The debug profile is required operational evidence. It is not a second calculation authority.

### Commit hierarchy

For each profile, child objects and manifests are built before their parents:

```text
parquet parts
  -> pollutant manifest
      -> connector manifest
          -> day manifest
```

Parent manifests must be built from the complete final child set, not from a partial connector subset.

## Stage 8: AQI indexes

### Component

`workers/shared/uk_aq_r2_history_index.mjs`

The public data profile is indexed by day, connector, pollutant and timeseries so API requests do not need broad manifest or parquet scans.

Index generation must:

- use committed manifest content;
- retain deterministic key ordering and values;
- derive timestamps from source manifests rather than wall-clock run time;
- skip writes when the byte-identical index already exists;
- update v2 timeseries metadata where targeted changes affect coverage.

Missing or invalid required indexes must produce partial read behaviour, not an unbounded fallback scan.

## Stage 9: private AQI History R2 API

### Component

`workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`

### Behaviour

The Worker:

- requires private upstream authentication;
- validates scope, grain, pollutant, identity and range;
- reads committed AQI R2 history through required indexes;
- may use configured recent fallback behaviour where explicitly enabled;
- keeps R2 authoritative in overlaps;
- enforces object, parquet, row-group, chunk and elapsed-time budgets;
- returns structured partial diagnostics when coverage is uncertain;
- never treats loose parquet files as committed history.

### Timestamp projection

Stored `timestamp_hour_utc` is the canonical endpoint.

The public response must expose unambiguous period semantics:

```text
period_start_utc = timestamp_hour_utc - 1 hour
period_end_utc   = timestamp_hour_utc
```

The current projection of `timestamp_hour_utc` directly into `period_start_utc` is a known discrepancy to correct through a coordinated interface change.

## Stage 10: private station-history Worker

### Component

`workers/uk_aq_station_history/`

The Worker has no public route. It is reachable only through the cache proxy Service Binding.

It provides:

- a combined station-series head;
- immutable or mutable older AQI chunks;
- independent older observation chunks.

AQI and observation coverage remain separate. A missing AQI segment must not erase valid observation data, and an observation issue must not silently certify AQI completeness.

Older history extends backwards only. An older chunk is not allowed to replace an already accepted stable-head AQI row.

## Stage 11: cache proxy

The cache proxy owns browser authentication, CORS, public cache behaviour and stale-response policy.

It forwards to the private station-history Service Binding when the relevant feature flags are enabled.

Complete recent station-series responses may use the short configured cache lifetime. Partial or gap-bearing responses must remain non-cacheable unless a separately documented stale-fallback policy applies.

## Stage 12: website loader and renderer

### Loader

`station-history-loader.js` merges the current authoritative head and older history without allowing older chunks to overwrite the head.

It must preserve both DAQI and European AQI values for each canonical endpoint.

### Renderer

Both station-chart renderers must draw each index row from:

```text
n - 1 hour  ->  n
```

The final coloured section ends at the final valid endpoint. Empty hours remain blank.

## Midnight example

For an AQI endpoint:

```text
n = 2026-07-18T00:00:00Z
```

The represented interval is:

```text
2026-07-17T23:00:00Z to 2026-07-18T00:00:00Z
```

The current R2 storage partition is the endpoint day:

```text
day_utc=2026-07-18
```

A chart request ending at `2026-07-18T00:00:00Z` must include that endpoint row, even though most of the represented interval belongs to 17 July.

## Failure and gap propagation

At every stage:

- missing source context remains visible as a calculation status or gap;
- missing committed manifests remain visible as incomplete R2 coverage;
- scan-budget stops remain visible as partial responses;
- source disagreement is reported;
- the website must not fill a gap by extending colour from a neighbouring hour.