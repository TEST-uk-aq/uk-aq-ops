# R2 history binding index

Read [`contract.md`](contract.md) first, then the linked interface, operations,
recovery and validation documents. This area owns the v2 stable per-timeseries
identity/routing binding; it does not own daily observation or AQI coverage.

Implementation ownership:

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- `workers/uk_aq_observs_history_r2_api_worker/`;
- `workers/uk_aq_aqi_history_r2_api_worker/`;
- `workers/uk_aq_cache_proxy/src/station_history/`;
- `scripts/backup_r2/` and `scripts/uk-aq-history-integrity/`.
