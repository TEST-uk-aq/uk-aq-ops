# History integrity

The v2 history integrity runner validates local/Dropbox history mirrors and plans or executes repairs against live R2 when repair mode is enabled.

## Backup readiness gate

Scheduled runs should call `uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(date, timestamptz, text[])` before scanning. The RPC reads `uk_aq_ops.daily_task_runs` through a `SECURITY DEFINER` function and returns `backup_ready`, `blocked_reason`, `backup_completed_at`, and per-task `tasks` JSON. Execution is revoked from `PUBLIC` and granted to `service_role`.

Required task keys are the R2 backup inventory generation task and the R2 history Dropbox sync task configured by the deployment environment. The gate requires the latest run for each requested task key on the scheduled UTC date to have status `succeeded` with `completed_at_utc` at or before the integrity start time. A later failed/running run blocks even if an earlier run succeeded.

## V2 hierarchy validation

Observation and AQI `history/v2/.../data` validation now checks leaf pollutant manifests and validates existing connector/day parent manifests field-by-field. Connector parent representations are checked independently: `pollutant_codes`, `child_manifests`, `pollutant_manifests`, and pollutant codes inferable from `files`. Day parent representations are checked independently: `connector_ids`, `child_manifests`, `connector_manifests`, and connector IDs inferable from `files`.

New field-specific gap types include `connector_manifest_pollutant_codes_missing_child`, `connector_manifest_child_manifests_missing_child`, `connector_manifest_pollutant_manifests_missing_child`, `connector_manifest_files_missing_child`, and matching stale-child variants. Day manifests emit corresponding `day_manifest_*` gap types.

Pollutant manifests distinguish `data_manifest_file_count_mismatch`, `data_manifest_total_bytes_mismatch`, `data_manifest_timeseries_row_count_mismatch`, `data_manifest_unlisted_parquet`, `data_manifest_listed_parquet_missing`, and `data_manifest_duplicate_file_key` instead of reporting file-count faults as row-count mismatches.

## Repair and verification status

Repair summaries distinguish planned actions, execution, and post-repair verification. Action states are `planned_only`, `executed`, `skipped_unchanged`, `succeeded`, `failed`, and `blocked_dependency`. Live-R2 verification metrics are reported as `live_r2_verifications_attempted`, `live_r2_verifications_ok`, and `live_r2_verifications_failed` when write-capable repair paths are used.

Observation data repair must complete and verify before AQI rebuilds are queued. AQI rebuilds are queued only for observation data repairs involving AQI-eligible pollutants from the connector mapping snapshot; manifest-only observation repairs do not trigger AQI data rebuilds. AQI debug validation remains optional unless `--require-aqi-debug` is supplied.

## Deployment

Apply schema in this order:

1. `schema_copy/uk_aq_daily_task_health_schema.sql`
2. `schema_copy/uk_aq_obs_aqi_db_ops_rpcs.sql`

Required grant:

```sql
GRANT EXECUTE ON FUNCTION uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(date, timestamptz, text[]) TO service_role;
```
