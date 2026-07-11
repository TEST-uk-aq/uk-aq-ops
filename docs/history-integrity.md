# UK-AQ history integrity operations

## Daily order and backup gate

Routine scheduled integrity runs must run after the R2 history backup inventory and the Dropbox history sync:

1. `r2_backup_inventory`
2. `r2_history_dropbox_sync`
3. `uk-aq-history-integrity`

For non-manual profiles, integrity queries Supabase daily task health through the narrow RPC named by `UK_AQ_HISTORY_INTEGRITY_BACKUP_READINESS_RPC` (default `uk_aq_rpc_daily_task_backup_readiness`). The default required task keys are configured by `UK_AQ_HISTORY_INTEGRITY_BACKUP_TASK_KEYS` and default to `r2_backup_inventory,r2_history_dropbox_sync`.

The gate requires all configured tasks for today's UTC `scheduled_for_date` to have succeeded before the integrity run started. If the gate is not ready, the run stops with status `blocked_backup_not_ready` before scanning the Dropbox mirror. Manual operators can pass `--allow-stale-dropbox`; the override is recorded in JSON and Markdown summaries.

## Check source and repair target

Integrity scans the local Dropbox `R2_history_backup` mirror as the routine check source. Repairs target live R2 through the existing backfill, index and manifest writers. Post-repair validation must read the changed scope from live R2 rather than trusting the already-scanned Dropbox mirror.

## v2 manifest hierarchy

V2 observations are partitioned as:

```text
history/v2/observations/
  day_utc=YYYY-MM-DD/
    manifest.json
    connector_id=N/
      manifest.json
      pollutant_code=<code>/
        manifest.json
        part-*.parquet
```

V2 AQI hourly data uses the equivalent hierarchy under:

```text
history/v2/aqilevels/hourly/data/
```

The optional AQI hourly debug hierarchy lives under `history/v2/aqilevels/hourly/debug/`. It is checked only when `--check-aqi-debug` is enabled, and missing debug partitions are errors only with `--require-aqi-debug`.

## Parent/child failure mode

A valid pollutant partition can exist with valid parquet and a valid pollutant `manifest.json`, while the parent connector manifest omits that pollutant. The 2026-05-17 connector 1 O3 case had a valid `pollutant_code=o3` child, but the connector manifest listed only `no2`, `pm10` and `pm25`. The index builder discovered pollutants through the incomplete parent manifest, so the downstream O3 index was missing. Integrity now reports `connector_manifest_missing_pollutant_child` for the parent-child inconsistency before treating the downstream index as the primary problem.

## Gap classes

Observation/AQI pollutant partition gaps include missing or invalid pollutant manifests, missing listed parquet files, actual `part-*.parquet` files omitted from the pollutant manifest, duplicate file keys and row-count inconsistencies.

Connector manifest gaps include:

- `connector_manifest_missing_pollutant_child`
- `connector_manifest_stale_pollutant_child`
- `connector_manifest_child_hash_mismatch`
- `connector_manifest_row_count_mismatch`
- `connector_manifest_file_count_mismatch`
- `connector_manifest_total_bytes_mismatch`

Day manifest gaps include:

- `day_manifest_missing_connector_child`
- `day_manifest_stale_connector_child`
- `day_manifest_child_hash_mismatch`
- `day_manifest_row_count_mismatch`
- `day_manifest_file_count_mismatch`
- `day_manifest_total_bytes_mismatch`

Index gaps remain separate from manifest hierarchy gaps, so an index rebuild is not treated as a substitute for repairing an incomplete connector or day manifest.

## Repair sequencing

The repair plan is built before writes and coalesces work in this order:

1. observation data or pollutant manifest repair;
2. observation connector manifest rebuild from all actual valid live-R2 pollutant children;
3. observation day manifest rebuild from all actual valid live-R2 connector children;
4. observation index and metadata repair;
5. AQI rebuilds only for AQI-enabled pollutants (`pm25`, `pm10`, `no2`);
6. AQI connector/day manifest repair;
7. AQI index and metadata repair;
8. live-R2 post-repair verification.

O3 is not AQI-enabled in the current AQI history/index helpers, so an O3 manifest-only observation repair does not queue an AQI data rebuild.

## Check-only, dry-run and stale backup override

`--check-only` and `--dry-run` preserve no-write behavior. They still produce findings and an ordered repair plan. `--allow-stale-dropbox` bypasses the scheduled-run backup gate and is intended only for explicit manual recovery or diagnostics; summaries make the override visible.

## Summary metrics

Summaries include backup readiness fields, counts of checked observation/AQI pollutant, connector and day manifests, manifest gap totals, index gap counts and repair-plan action tables. Post-repair live-R2 verification metrics are reserved for repair executions that amend live R2.
