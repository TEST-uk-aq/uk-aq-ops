# R2-first AQI Pass 1 migration report

> **Historical migration report.** This file records rollout and review evidence from 14 July 2026. It is not the current behavioural authority. Stable Phase B AQI history requirements are defined in [`../../system_docs/r2_history/aqi_history_write_pipeline.md`](../../system_docs/r2_history/aqi_history_write_pipeline.md).

## Outcome

Pass 1 introduced the observation-derived R2 v2 AQI write path while retaining rollback-safe defaults. It also added an optional live AQI fallback calculated from observations for recent gaps.

The migration established these principal outcomes:

- Phase B can freeze a bounded observation source for the target scope;
- permanent v2 AQI data and debug objects are written from observations;
- connector, day and pollutant manifests are validated before prune readiness;
- targeted AQI indexes and affected timeseries metadata are required before `history_done=true`;
- unrelated older latest-index day summaries are preserved;
- the live AQI Worker can fill eligible recent gaps from observations without using the materialised calculated-AQI fallback;
- committed R2 AQI remains authoritative over live calculation;
- R2 observations take precedence over overlapping ingest observations;
- partial observation responses keep the AQI response incomplete and uncacheable.

## Rollback-safe defaults at migration time

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS=250000
UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES=268435456
```

Exactly one Phase B writer mode was required. Both-enabled and both-disabled configurations failed closed.

## Important migration decisions

### Supported source

A target connector/day required supported target-day PM2.5, PM10 or NO2 rows before it was treated as an AQI calculation source. Previous-day PM context alone did not qualify the target day.

A connector/day with no supported source remained a successful `no_supported_aqi_source` state and did not require fake Parquet objects.

### PM context

PM2.5 and PM10 calculation could request 23 hours of older R2 observation context. NO2 did not use that PM rolling context.

### Index safety

Phase B used the targeted v2 index updater rather than a target-day-filtered full rebuild. The updater preserved unrelated day summaries and changed only affected pollutant indexes and timeseries metadata.

A stale object that merely existed in R2 was not sufficient. Completion required current manifest identity and hash, canonical index identity, row and file counts, complete file coverage and populated timeseries row counts.

### Empty and stale output handling

A canonical empty connector state superseded older connector state without writing fake Parquet files. Targeted index processing removed or made stale pollutant indexes and metadata non-authoritative.

### Idempotency

Valid data and manifests could remain after a later gate failed. A retry was expected to be idempotent and to avoid duplicate objects or loss of unrelated days.

## TEST rollout sequence recorded by the migration

1. Deploy safe defaults and verify legacy behaviour.
2. Enable observation-derived Phase B for one controlled eligible day.
3. Verify data, debug output, manifests, targeted indexes, PM context, prune readiness and retry behaviour.
4. Configure the observations R2 API and enable live fallback.
5. Verify PM2.5, PM10 and NO2 precedence, completeness and website bands.
6. Roll back by re-enabling the legacy writer and disabling live fallback if required.

## Final review status

The final code review recorded local deterministic coverage for the calculation, targeted-index and fake-R2 paths, but explicitly required normal TEST operational validation after deployment.

This report is retained to explain the migration sequence and original rollout state. Current implementation work must follow the authoritative system document rather than copying settings or status claims from this historical report.
