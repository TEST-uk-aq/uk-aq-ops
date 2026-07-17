# R2 history

## Current authority

Read [`contract.md`](contract.md) first for the stable v2 per-timeseries binding contract.

This area currently has three completed authority groups:

- stable timeseries binding identity and routing;
- v2 history integrity detection and repair in [`integrity.md`](integrity.md);
- the active Phase B AQI writer and targeted-index gates in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

The remaining daily layout, manifest, backup, observations-write and read-API documentation is still being migrated from `system_docs_legacy/`. Do not infer that a legacy broad document overrides the completed files above.

## Binding documentation reading order

1. [`contract.md`](contract.md)
2. [`interfaces.md`](interfaces.md)
3. [`operations.md`](operations.md)
4. [`recovery.md`](recovery.md)
5. [`validation.md`](validation.md)
6. relevant files under [`decisions/`](decisions/)

## Implementation ownership

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/`
- `workers/uk_aq_aqi_history_r2_api_worker/`
- `workers/uk_aq_cache_proxy/src/station_history/`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding contract does not own daily observation or AQI coverage. The AQI write-pipeline document owns only the Phase B write and completion gates, not AQI formula or public display semantics.
