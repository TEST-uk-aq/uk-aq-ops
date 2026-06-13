# AQI Levels V1 Implementation Audit - 2026-06-13

## Scope

Audited the TEST runbook, LIVE deploy notes, active workers, local rebuild scripts,
R2 backup/restore tooling, and system documentation for the normalized AQI levels
history structure.

Canonical target:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
history_schema_name=aqilevels_hourly
history_schema_version=1
grain=hourly
writer_version=parquet-wasm-zstd-v1
```

## Result

Status after fixes: implementation is aligned for TEST repeat and LIVE repeat,
provided the normalized `workers/uk_aq_backfill_local/run_job.ts` revision is used
for historical rebuilds before deploy/run.

The main runtime mismatch found during audit was the local backfill writer used by
`r2_history_obs_to_aqilevels`: it already targeted the hourly prefix but still
serialized the older compact AQI parquet metadata and columns. That path is now
aligned with the prune/export writer and AQI R2 API reader.

## Findings And Fixes

### 1. Local AQI rebuild writer still used old compact parquet contract

Files:

- `workers/uk_aq_backfill_local/run_job.ts`

Before fix:

- `history_schema_name=aqilevels`
- `history_schema_version=2`
- `writer_version=parquet-wasm-zstd-v2`
- compact fields only: `hourly_mean_ugm3`, `rolling24h_mean_ugm3`,
  `daqi_index_level`, `eaqi_index_level`

Fix:

- switched metadata to `aqilevels_hourly`, schema version `1`, grain `hourly`,
  writer `parquet-wasm-zstd-v1`
- writes normalized `daqi_input_*` and `eaqi_input_*` fields
- preserves compatibility mean/index fields for older diagnostics
- updated `r2_history_obs_to_aqilevels` and local targeted AQI paths to emit the
  same normalized row contract

### 2. LIVE deploy notes needed explicit LIVE repeat checks

Files:

- `plans/AQI Levels Rebuild - R2 Obsaqidb/uk_aq_aqilevels_v1_live_implementation_deploy_steps.md`

Fix:

- added audit status and normalized-writer preflight
- added required LIVE config/workflow checklist
- added DuckDB validation checkpoint for rebuilt parquet metadata/columns
- added Dropbox backup command and post-sync checks
- clarified that repeat cleanup must check both current hourly output and legacy
  non-hourly/band-cache AQI paths

### 3. TEST runbook delete checklist omitted current hourly output

Files:

- `plans/AQI Levels Rebuild - R2 Obsaqidb/uk_aq_aqilevels_v1_test_implementation_runbook.md`

Fix:

- added `history/v1/aqilevels/hourly/day_utc=*` and
  `history/v1/aqilevels/hourly/bands/v1/**` to the AQI cleanup list
- kept older non-hourly paths so repeat runs can remove stale legacy objects too

### 4. System documentation had stale AQI layout details

Files:

- `system_docs/uk-aq-r2-history-layout.md`
- `system_docs/uk-aq-backfill-local.md`

Fix:

- documented normalized AQI parquet metadata and 36-column writer order
- documented AQI connector/day manifests under
  `history/v1/aqilevels/hourly/...`
- documented AQI API response fields derived from normalized parquet rows
- documented `aqilevels_only` local backfill output scope and metadata

### 5. Dropbox backup committed connector units are correct as observations-only

Files inspected:

- `scripts/backup_r2/lib/inventory.mjs`
- `scripts/backup_r2/build_backup_inventory.mjs`
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
- `.github/workflows/uk_aq_r2_history_dropbox_backup.yml`

Conclusion:

`COMMITTED_CONNECTOR_UNIT_KEYS` should remain observations-only. AQI levels are
copied as complete day/connector folder units under:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/
```

AQI latest/index objects are also copied by the existing index and index-tree
units:

```text
history/_index/aqilevels_latest.json
history/_index/aqilevels_timeseries_latest.json
history/_index/aqilevels_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

There is no separate committed AQI connector unit outside those AQI day-folder
and index-tree units, so adding AQI to `COMMITTED_CONNECTOR_UNIT_KEYS` would be
misleading rather than protective.

## Verified Active Paths

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
  - writes normalized AQI parquet under `history/v1/aqilevels/hourly`
  - emits `aqilevels_hourly`, version `1`, grain `hourly`
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`
  - reads normalized AQI parquet fields
  - defaults to `history/v1/aqilevels/hourly`
- `workers/shared/uk_aq_r2_history_index.mjs`
  - supports AQI latest and AQI timeseries index manifests
- `scripts/backup_r2/build_backup_inventory.mjs`
  - discovers AQI day units from `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX`, defaulting
    to `history/v1/aqilevels/hourly`
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
  - copies AQI day units and AQI index-tree units

## Residual Notes

- The local observation-to-AQI rebuild can derive normalized fields from older
  compatibility values when the source rows do not already contain normalized
  DAQI/EAQI fields. For PM DAQI rows, the derived source count is limited by the
  available historical inputs in that path. The AQI index value remains the same
  as the existing compatibility value.
- `computed_at_utc` and `updated_at` remain nullable for locally rebuilt R2
  history rows when source rows do not provide those timestamps. This avoids
  adding run-time churn to historical parquet.

## Verification Commands

```bash
deno check workers/uk_aq_backfill_local/run_job.ts
npm test -- tests/phase_b_history_r2.test.mjs tests/uk_aq_r2_history_backup_inventory.test.mjs tests/uk_aq_r2_history_index.test.mjs tests/uk_aq_rebuild_r2_day_manifest_from_connectors.test.mjs
```
