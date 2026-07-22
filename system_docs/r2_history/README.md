# R2 history

## Current authority

Read [`contract.md`](contract.md) first for the stable v2 per-timeseries binding contract.

This area currently has four completed authority groups:

- stable timeseries binding identity and routing;
- v2 history integrity detection and repair in [`integrity.md`](integrity.md);
- scheduled Integrity daily date selection in [`daily_profile_selection.md`](daily_profile_selection.md);
- the active Phase B AQI writer, PM rolling-context source split and targeted-index gates in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

The remaining broader daily layout, manifest, backup, observations-write and read-API documentation is still being migrated from `system_docs_legacy/`. Do not infer that a legacy broad document overrides the completed files above.

## AQI writer source boundary

For the current observation-derived Phase B AQI path:

- target-day observations are frozen from IngestDB and remain the source for target-day R2 observations and target-day AQI input;
- only the preceding 23 hourly PM2.5 and PM10 aggregates are read from ObsAQIDB as calculation context;
- context rows are never written into the target-day observation partition or emitted as previous-day AQI output;
- incomplete, truncated or out-of-retention context reads fail closed and keep pruning blocked.

The exact RPC, pagination, retention, diagnostics and recovery contract is defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

## Binding documentation reading order

1. [`contract.md`](contract.md)
2. [`interfaces.md`](interfaces.md)
3. [`operations.md`](operations.md)
4. [`recovery.md`](recovery.md)
5. [`validation.md`](validation.md)
6. relevant files under [`decisions/`](decisions/)

For scheduled Integrity date selection, also read [`daily_profile_selection.md`](daily_profile_selection.md).

For Phase B AQI writes, also read [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

## Integrity repair execution scope

A complete connector-day Integrity repair remains pollutant-scoped. The selected pollutant set passes unchanged to the shared source-to-R2 worker, which filters adapter bindings before mapping guards while retaining complete connector-day source evidence. Complete connector-day mode must not use a timeseries-ID filter.

UK-AIR CSV heading decisions are maintained in the Integrity SQLite source-label registry. The registry is authoritative for approved SOS heading-to-pollutant decisions, while core mappings are consistency checks when present. A mapped decision requires an explicit expected unit. Each SOS repair receives one UTF-8 content-hashed and exact-file-hashed JSON snapshot for detector and proposal stages; non-SOS connectors do not load it. Unknown headings are treated as review, skipped and reported rather than broadening repair scope. Section-level unit evidence is independent of target-day rows, so zero target-day values do not require a target-day unit cell. Only approved mappings for `pm25`, `pm10`, `no2` and observation-only `o3` enter canonical processing. Operational validation runs only through `uk-aq-history-integrity.sh` on the dedicated Integrity machine, not on a development laptop with online-only Dropbox files.

## Implementation ownership

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/`
- `workers/uk_aq_aqi_history_r2_api_worker/`
- `workers/uk_aq_cache_proxy/src/station_history/`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `lib/aqi/aqi_levels.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding contract does not own daily observation or AQI coverage. The daily-profile selection contract owns scheduled Integrity date selection. The AQI write-pipeline document owns Phase B source selection, calculation boundaries, write and completion gates, but not public display semantics.
