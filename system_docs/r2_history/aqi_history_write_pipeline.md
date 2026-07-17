# AQI history write pipeline

## Purpose

This document records the current required behaviour of the R2 v2 AQI history writer used by Prune Daily Phase B. It extracts the stable runtime contract from the completed R2-first AQI migration report without retaining the rollout narrative as a second authority.

## Scope

This file covers permanent v2 AQI data and debug objects, their manifests and the targeted indexes required before history completion. Calculation formulas and public read behaviour are owned by their respective AQI and API components.

## Source precedence

For live read fallback, where enabled:

```text
committed R2 AQI > live-calculated AQI > no row
```

For observation inputs used by live calculation:

```text
R2 observations > ingest observations for the same observation identity
```

An existing committed R2 AQI row remains authoritative even when its index values are null or its calculation status is `insufficient_samples`.

## Writer selection

Exactly one Phase B AQI writer mode MUST be enabled:

- observation-derived AQI; or
- the legacy AQI RPC export.

Both enabled and both disabled are invalid and must fail closed.

The rollback-safe configuration may keep observation-derived writing disabled until intentionally enabled in an environment.

## Observation-derived write contract

When observation-derived writing is enabled, Phase B MUST:

1. freeze a bounded observation source for the target scope;
2. calculate only supported PM2.5, PM10 and NO2 AQI products;
3. include 23 older hours of PM observation context where required for the rolling 24-hour calculation;
4. write canonical v2 AQI data and debug outputs;
5. write or replace connector and day manifests;
6. build the required targeted pollutant indexes;
7. update only affected timeseries metadata and the target-day latest summary;
8. verify the current manifest identity, hash, row counts, file coverage and timeseries row counts;
9. set `history_done=true` only after every required gate succeeds.

Adopting an existing observation manifest must not bypass AQI output, debug output, manifest or index verification.

## No-supported-source state

A target connector/day with no supported PM2.5, PM10 or NO2 rows is a successful `no_supported_aqi_source` state.

It MUST publish the canonical empty connector state required by the current writer and MUST NOT create fake Parquet files. Older stale pollutant indexes or metadata must not remain authoritative after that empty state is committed.

Previous-day PM context alone does not make the target day a supported AQI source.

## Index safety

The writer uses the established targeted v2 updater. It MUST NOT run a target-day-filtered full rebuild that drops unrelated days.

The targeted update must:

- start from the existing global latest payload;
- replace or insert only the affected day summary;
- preserve unrelated older days;
- update only affected pollutant indexes and timeseries metadata;
- use byte-stable put-if-changed behaviour;
- verify that every required index refers to the current pollutant manifest and hash.

Object existence alone is not sufficient evidence. Warnings, missing generated indexes, unreadable payloads or source-manifest mismatches block completion.

## Idempotency and failure

Valid objects may remain after a later gate fails so that a retry can complete without duplicating data. Rewriting the same canonical state must be idempotent.

If supported target-day rows exist but normalisation unexpectedly produces no AQI rows, the writer must fail closed rather than publish a successful empty result.

## Completeness propagation

When live fallback consumes an incomplete observation response, the AQI response remains incomplete and uncacheable even if the available observations can produce some calculated rows.

## Validation policy

Local deterministic checks may establish structural viability and the targeted-update contract. Functional acceptance requires a controlled TEST Phase B operation after deployment, including a normal retry and verification that unrelated days remain unchanged.

The dated implementation report is retained under `system_docs_legacy/reports/` as historical rollout evidence, not as the current contract.
