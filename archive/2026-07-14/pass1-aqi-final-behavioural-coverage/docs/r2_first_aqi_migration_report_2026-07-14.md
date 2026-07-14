# R2-first AQI Pass 1 migration report (2026-07-14)

## Summary

PR #6 completes the Pass 1 architecture for R2-first AQI generation while retaining rollback-safe defaults. Phase B can stage a bounded NDJSON frozen observation source, write permanent v2 AQI data and debug outputs, publish connector/day manifests, and require the AQI timeseries indexes before prune readiness. The live AQI Worker can fill missing recent v2 AQI rows from observations without calling the materialised calculated-AQI fallback when `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true`.

## Source precedence

- AQI response precedence is: R2 AQI > live-calculated AQI > no row.
- Observation merge precedence for live calculation is: R2 observations > ingest observations.
- Existing R2 AQI rows remain authoritative even when DAQI/EAQI values are null or calculation status is `insufficient_samples`.

## Phase B source and gates

- `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false` and `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true` are the rollback-safe defaults.
- Exactly one Phase B AQI writer must be enabled. Both-disabled and both-enabled configurations fail closed during runtime configuration validation.
- In observation-derived AQI mode, adoption of an existing observations manifest is skipped with an explicit reason so it cannot bypass AQI output, debug output, manifests, and index verification.
- A connector/day with no supported PM2.5, PM10 or NO2 source remains a successful `no_supported_aqi_source` state and does not require fake empty Parquet files.
- Before `history_done=true`, Phase B verifies observation manifests, AQI data/debug manifests, and required AQI timeseries index manifests.

## Live fallback contract

- Configure `UK_AQ_OBSERVS_HISTORY_R2_API_URL` with the active TEST observations R2 API endpoint before Stage 3 validation. This should be supplied from the existing GitHub repository variable of the same name; this PR only wires the variable and does not create or set it.
- The URL may be a Worker root (`https://example.workers.dev`) or a full endpoint (`https://example.workers.dev/v1/observations`). The AQI Worker normalizes both to `/v1/observations` without duplicating paths.
- When live fallback is enabled, missing `UK_AQ_OBSERVS_HISTORY_R2_API_URL` fails closed at deploy/runtime.
- PM2.5 and PM10 R2 observation reads include 23 hours of rolling context before the oldest eligible AQI output hour; ingest observation reads remain bounded by ingest retention. NO2 does not add the PM context.
- R2 observation API completeness metadata (`response_complete`, `has_gap`, `coverage_state`, `partial_reasons`, `coverage`) is propagated. Partial upstream observation scans make AQI responses incomplete and uncacheable.

## Rollout defaults

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_ROWS=250000
UK_AQ_PHASE_B_OBSERVATION_SNAPSHOT_MAX_BYTES=268435456
```

## TEST rollout

1. Safe default deploy: keep the defaults above and verify legacy behaviour remains unchanged.
2. Phase B validation: set `UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true` and `UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false`; run one controlled eligible target day and verify frozen source counts, observations, AQI data/debug Parquet, manifests, indexes, PM prior-day context, `no_supported_aqi_source`, prune gate, and idempotent retry.
3. Live fallback: set `UK_AQ_OBSERVS_HISTORY_R2_API_URL=<active TEST observations endpoint>` and `UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true`; test PM2.5, PM10, and NO2; verify R2 precedence, live fill, PM context, R2 observation precedence, ingest fill, partial-scan no-store behaviour, and website bands.
4. Rollback: set Phase B calculation false, legacy RPC true, and live fallback false. No destructive database rollback is expected.

## Remaining Pass 2 work

Consumer migration remains out of scope for this PR. Do not begin Pass 2 until Pass 1 TEST validation is complete.

## Final index-safety update

- Phase B no longer uses a target-day filtered full rebuild for AQI v2 indexes. It calls the established targeted updater for `history/v2/aqilevels/hourly/data` with `timeseriesMetadataMode="targeted"` and strict missing-timeseries-count enforcement.
- The targeted updater starts from the existing global latest payload, replaces or inserts only the requested day summary, and writes through the existing byte-stable `r2PutObjectIfChanged()` contract. Older unrelated day summaries in `history/_index_v2/aqilevels_hourly_data_timeseries_latest.json` are preserved.
- Targeted metadata updates are limited to the affected AQI pollutant indexes returned by the current target-day build, so Phase B does not rebuild every historical AQI or observations index and does not rebuild all timeseries metadata per day.
- The prune gate now verifies each required target-day connector/pollutant index against the current pollutant manifest. It reads both the current pollutant manifest and index payload, checks canonical identity (`history_version`, `domain`, `grain`, `profile`, `day_utc`, `connector_id`, `pollutant_code`), source identity (`pollutant_manifest_key` and `pollutant_manifest_hash`), row/file counts, complete file coverage, and populated `timeseries_row_counts`.
- A stale object that merely exists in R2 is insufficient. Phase B fails if the current targeted build omits a required pollutant index, reports warnings, fails targeted metadata update, cannot read the generated index payload, or finds a source-manifest hash mismatch.
- AQI data, debug output, day manifests, targeted AQI index update, targeted metadata update, and current-source index verification are ordered before prune readiness. Any blocking failure keeps `history_done=false`; valid AQI Parquet/manifests may remain in place for idempotent retry and are not duplicated by retry.
- `no_supported_aqi_source` remains an explicit successful state and does not require fake AQI indexes.

## Manual TEST validation details

### Stage 1 — safe defaults

Deploy with:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

Verify the legacy RPC AQI export path and existing AQI Worker responses are unchanged.

### Stage 2 — observation-derived Phase B

Deploy with:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

Run one controlled eligible day and verify frozen source counts, observation output, AQI data/debug output, connector and day manifests, target-day AQI pollutant indexes, preservation of all older global latest-index days, targeted timeseries metadata for affected series only, current pollutant `manifest_hash` values in index payloads, PM prior-day context, `history_done`, prune gate readiness, and idempotent retry after deleting or corrupting one target-day index.

### Stage 3 — live fallback

Deploy with:

```text
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=true
UK_AQ_OBSERVS_HISTORY_R2_API_URL=<active TEST observations endpoint>
```

Test representative PM2.5, PM10 and NO2 series. Confirm R2 AQI wins overlaps, missing recent AQI is calculated from observations, R2 observations win ingest overlaps, distinct ingest rows fill missing observation keys, PM receives exactly 23 hours of older R2 context, partial observations responses remain incomplete and `no-store`, and website DAQI/EAQI bands render.

### Stage 4 — rollback

Set:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=false
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=true
UK_AQ_AQI_LIVE_OBSERVATION_FALLBACK_ENABLED=false
```

No destructive database rollback is expected, and no Supabase AQI objects should be removed as part of this Pass 1 rollback.
