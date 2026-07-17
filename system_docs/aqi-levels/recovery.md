# AQI levels recovery

## Purpose

This document defines how to recover calculated hourly AQI data, manifests and indexes without changing authoritative raw observation history or inventing coverage.

Recovery follows the dependency order:

```text
source observations
  -> AQI data and debug parquet
      -> pollutant manifests
          -> connector manifests
              -> day manifests
                  -> AQI indexes
                      -> API and website validation
```

## Recovery source of truth

The authoritative calculation source is the accepted raw observation history for the affected timeseries and interval, together with authoritative metadata and the shared AQI contract.

A recovery source must provide enough preceding PM context to calculate each targeted rolling 24-hour DAQI endpoint.

Do not use the following as sole calculation authority when AQI history may be wrong:

- existing AQI parquet rows;
- existing AQI manifests or indexes;
- website chart points;
- cache-proxy responses;
- daily or monthly AQI roll-ups;
- source-provided index observations;
- a live calculation that lacks the required R2 observation context.

## Recovery scope

Prefer the narrowest complete scope that can restore consistency:

1. one timeseries and endpoint range where tooling supports it;
2. one pollutant, connector and day;
3. one connector and day;
4. a bounded multi-day range;
5. broad rebuild only when evidence shows it is required.

A targeted repair must still rebuild every parent manifest affected by the changed child set.

## Required calculation semantics

For each canonical endpoint `n`:

1. resolve timeseries, station, connector and pollutant identity;
2. obtain valid source observations;
3. reject negative and non-finite values without changing raw history;
4. build the hourly mean ending at `n`;
5. for PM, obtain the preceding 23 endpoint hours and require 24 valid hourly values for DAQI;
6. calculate DAQI and European AQI independently;
7. preserve status and missing-reason fields;
8. write the same canonical endpoint to data and debug profiles;
9. treat `n` as the end of `(n - 1 hour, n]`.

A recovery must not shift stored endpoints merely to make an existing renderer look correct.

## Existing recovery areas

Current implementation and repair tooling includes:

- `workers/uk_aq_backfill_local/run_job.ts`;
- `scripts/uk_aq_backfill_local.sh`;
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`;
- `scripts/uk-aq-history-integrity/`;
- AQI manifest and index builders shared with Prune Daily.

Before using a path, confirm that it supports the deployed R2 history version and the required v2 data/debug profile contract.

Do not use archived worker implementations as write authorities.

## Safe recovery sequence

### 1. Identify the fault class

Classify the issue before writing:

- source observation fault;
- AQI calculation fault;
- missing or incorrect AQI parquet;
- data/debug profile mismatch;
- pollutant manifest fault;
- connector manifest fault;
- day manifest fault;
- index fault;
- API range/projection fault;
- website rendering fault.

Do not rebuild AQI data for a renderer-only defect.

Do not change website code for a missing committed R2 object.

### 2. Preserve before-state evidence

Record or preserve:

- affected R2 object keys;
- object etags or hashes;
- relevant manifest bodies;
- index bodies;
- API response completeness and partial reasons;
- source observation counts and timestamps;
- bounded samples of affected AQI rows.

Do not expose credentials or copy unrelated raw data into reports.

### 3. Produce a report-only proposal

Before write mode, the recovery path should report:

- target days, connectors, pollutants and timeseries;
- authoritative source row count;
- PM context range;
- proposed data/debug row counts;
- current and proposed object keys;
- current and proposed hashes;
- parent manifests that must change;
- indexes that must change;
- unchanged objects that will be skipped;
- missing dependencies that block the write.

The proposal must be deterministic for identical sources.

### 4. Rebuild AQI data and debug together

Where calculated rows are wrong or missing:

- rebuild both v2 profiles from the same normalized rows;
- keep their canonical keys aligned;
- preserve independent DAQI and European AQI statuses;
- verify the stored endpoint and represented interval;
- do not suppress valid European AQI because PM DAQI lacks context.

A data-only rebuild that leaves required debug history stale is incomplete.

### 5. Rebuild manifests bottom-up

After parquet changes:

1. rebuild the affected pollutant manifest from actual final parquet;
2. rebuild the connector manifest from the complete final pollutant-manifest set;
3. rebuild the day manifest from the complete final connector-manifest set.

A day manifest is above connector scope. Never rebuild it from only the targeted connector's local child subset.

Parent writes must be guarded against child changes between planning and write verification.

### 6. Rebuild indexes after manifests

Indexes are rebuilt only after the final manifest hierarchy is verified.

For v2 AQI data, update:

- the scoped `aqilevels_hourly_data_timeseries` indexes;
- stable bindings remain a separate core-snapshot reconciliation concern;
- any higher-level deterministic index required by the active read path.

Index payloads must remain byte-stable where their source manifests did not change.

### 7. Validate the private AQI API

For the repaired scope, confirm:

- required index resolution succeeds;
- no broad fallback scan occurs;
- R2 rows are returned as source `r2`;
- endpoint counts match the expected `start < n <= end` set;
- DAQI and European AQI statuses match debug evidence;
- `response_complete` is true only where coverage is proven;
- object and scan budgets are not exceeded.

### 8. Validate station history

Confirm:

- R2 remains authoritative in overlaps;
- recent live rows fill only genuinely missing endpoints;
- older chunks do not replace stable-head rows;
- AQI and observation completeness remain independent;
- no seam gap is hidden by merging.

### 9. Validate the website

Confirm each repaired row ending at `n` colours only:

```text
n - 1 hour to n
```

The final colour must end at the final valid endpoint. Missing hours remain blank.

## Timestamp-only interface correction

When stored AQI data is correct but an API or renderer treats the endpoint as a period start:

- do not rewrite parquet timestamps;
- correct the API projection and clients coherently;
- add explicit period boundaries or a versioned equivalent;
- update expected endpoint range checks;
- clear or version only the affected response caches through normal deployment mechanisms;
- validate R2 row identity remains unchanged.

## Midnight and partition recovery

A request ending at midnight needs the AQI row whose endpoint is that midnight.

Because current R2 day partitioning follows the endpoint date, recovery and validation must inspect the new endpoint day's partition.

Example:

```text
represented interval: 17 July 23:00 to 18 July 00:00
endpoint partition: day_utc=2026-07-18
```

Do not report the final interval missing before checking the endpoint-day partition.

## Rollback

If a data or metadata repair produces unexpected results:

1. stop further writes;
2. restore preserved affected objects where safe and complete;
3. restore child objects before their parent manifests;
4. rebuild or restore indexes to match the restored manifest hierarchy;
5. verify private API completeness;
6. retain the proposal, verification results and hashes for diagnosis.

Do not roll back or rewrite raw observations as part of AQI rollback.

For a code-only timestamp projection change, roll back the coordinated API, station-history and website revisions together. Do not leave producers and consumers on conflicting timestamp semantics.

## Repair-tool contract

Any new or amended AQI repair tool must:

- default to report-only mode;
- require an explicit write flag;
- support a bounded target scope;
- use the shared AQI calculation contract;
- include required PM context;
- write data and debug consistently;
- rebuild manifests before indexes;
- read the complete final child set for parent manifests;
- verify live R2 bytes after writes;
- skip byte-identical outputs;
- avoid archive code paths;
- never alter authoritative raw observation history;
- produce exact post-write validation instructions.

## Inactive roll-up recovery

Do not rebuild daily or monthly AQI roll-ups as part of normal hourly AQI recovery.

Their updater is inactive and their current timestamp grouping is not the accepted calendar contract.

Reactivation or rebuild requires a separate approved plan and decision record.
