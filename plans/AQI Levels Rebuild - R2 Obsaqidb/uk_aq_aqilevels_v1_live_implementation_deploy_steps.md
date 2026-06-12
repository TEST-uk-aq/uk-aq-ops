# UK AQ AQI Levels v1 - LIVE implementation deploy steps

This file is deploy-order first. It mirrors the TEST sequence after the Step 16 fixes and includes the minimum smoke checks needed before continuing.

Use it after TEST has been validated and the TEST rollout notes are final.
Do not use this file as the full validation, rollback, or investigation runbook.

## 1. Required pause

Before touching LIVE data or schedules:

1. Confirm TEST completed with `ok: true` Cloud Run backfill logs.
2. Pause LIVE AQI compute schedules.
3. Pause LIVE AQI history writers/export/prune jobs.
4. Do not pause ordinary observation ingest unless required.
5. Record pause time and operator.

```text
LIVE pause time UTC:
paused jobs/services:
operator:
```

## 2. SQL to paste into Supabase UI

Paste each file as a separate SQL run.

### 2.1 Ingest database

Apply the canonical ingest helper schema/RPC changes to the LIVE ingest database:

```text
schemas/ingest_db/uk_aq_aqilevels_schema.sql
schemas/ingest_db/uk_aq_rpc.sql
```

Required helper behavior:

```text
PM2.5 DAQI: rolling_24h_mean
PM10 DAQI: rolling_24h_mean
NO2 DAQI: hourly_mean
PM2.5 EAQI: hourly_mean
PM10 EAQI: hourly_mean
NO2 EAQI: hourly_mean
```

### 2.2 ObsAQIDB

Apply ObsAQIDB SQL in this order.

1. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`
   - Canonical ObsAQIDB schema file.
   - Applies the AQI hourly table/view changes, including the normalized AQI hourly contract.

2. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`
   - RPC and public function changes for the AQI history path.
   - Apply this after the schema file so the public RPC signatures and return shapes match the new table/view contract.

3. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_aqi_station_link_hardening.sql`
   - Focused apply file for AQI station-link hardening, rollup join fix, hourly upsert carry-through fix, and existing-table compatibility columns.
   - Apply this after the canonical schema if LIVE table/RPC state may be older than the latest TEST fixes.
   - This file is idempotent for the added columns and replaces the focused RPCs.

The focused file must include the LIVE-critical fixes discovered in TEST:

```text
timeseries_aqi_hourly add column if not exists:
  no2_hourly_mean_ugm3
  pm25_hourly_mean_ugm3
  pm10_hourly_mean_ugm3
  pm25_rolling24h_mean_ugm3
  pm10_rolling24h_mean_ugm3
  daqi_no2_index_level
  daqi_pm25_rolling24h_index_level
  daqi_pm10_rolling24h_index_level
  eaqi_no2_index_level
  eaqi_pm25_index_level
  eaqi_pm10_index_level

uk_aq_rpc_timeseries_aqi_hourly_upsert incoming_base carries:
  r.daqi_index_level
  r.eaqi_index_level
```

## 3. Worker deploy

Deploy workers after the SQL changes are in place.

1. Open the repo in GitHub Desktop.
2. Publish/deploy the AQI hourly Cloud Run worker changes for `workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts`.
3. Publish/deploy the AQI history R2 worker changes for `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`.
4. Confirm the deployed Cloud Run revision is the expected revision.

## 4. LIVE R2 deletion and historical rebuild order

Only do this after the TEST runbook has been completed and copied into the LIVE notes.

1. Confirm LIVE AQI compute and AQI history writers are paused.
2. Export a LIVE AQI R2 object inventory before deletion.
3. Mandatory operator pause before deletion.
4. Delete old LIVE AQI R2 objects from the LIVE R2 bucket only.
5. Rebuild historical AQI levels from the approved LIVE source.
6. Confirm new files are written under:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
```

7. Confirm no old files remain under:

```text
history/v1/aqilevels/day_utc=YYYY-MM-DD/...
history/v1/aqilevels/bands/v1/...
```

## 5. Manually refresh recent helper rows

After the historical rebuild and before Cloud Run backfill, manually refresh helper rows in the LIVE ingest database for the downtime/recent window.

Run against LIVE ingest DB:

```sql
select *
from uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_helper_upsert(
  p_hour_end_start_exclusive => '<pause_start_hour_utc>'::timestamptz,
  p_hour_end_end_inclusive => '<restart_hour_utc>'::timestamptz,
  p_timeseries_ids => null,
  p_reference_hour_end_utc => '<restart_hour_utc>'::timestamptz
);
```

Expected:

```text
source_rows > 0
rows_upserted > 0 or clean no-op if already refreshed
timeseries_hours_changed equals rows_upserted
```

Do not use Cloud Run `reconcile_short` or `reconcile_deep` for this step unless the operator explicitly wants Cloud Run to refresh helper rows. Current Cloud Run behavior:

```text
backfill: reads existing helper rows; does not refresh helper rows
sync_hourly: does not refresh helper rows
reconcile_short: refreshes helper rows
reconcile_deep: refreshes helper rows
```

## 6. Cloud Run recent backfill

Run a small LIVE smoke backfill first.

```json
{
  "trigger_mode": "manual",
  "run_mode": "backfill",
  "from_hour_utc": "<smoke_start_hour_utc>",
  "to_hour_utc": "<smoke_end_hour_utc>"
}
```

Expected smoke log:

```text
ok: true
error: null
source_rows > 0
rows_upserted > 0
station_link_null_rows = 0
station_link_mismatched_rows = 0
helper_refresh_source_rows = null
helper_refresh_rows_upserted = null
```

Then run the full downtime/recent LIVE backfill:

```json
{
  "trigger_mode": "manual",
  "run_mode": "backfill",
  "from_hour_utc": "<pause_start_hour_utc>",
  "to_hour_utc": "<restart_hour_utc>"
}
```

Record:

```text
smoke run timestamp UTC:
smoke source_rows:
smoke rows_upserted:
full run timestamp UTC:
full source_rows:
full rows_upserted:
full daily_rows_upserted:
full monthly_rows_upserted:
```

## 7. LIVE R2 Dropbox backup after rebuild

Before the first post-rebuild LIVE Dropbox backup, confirm the backup inventory and workflow use:

```text
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX=history/v1/aqilevels/hourly
UK_AQ_R2_HISTORY_INDEX_PREFIX=history/_index
UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH=history/_index/backup_inventory_v1.json
```

The Dropbox sync copies changed or missing inventory units, but it does not remove stale old-layout files. For LIVE, do not leave stale old AQI files in the active Dropbox backup tree.

Before the first post-rebuild LIVE AQI Dropbox sync:

1. Archive the old active LIVE Dropbox folder `history/v1/aqilevels` to a dated archive location outside the active backup tree.
2. Rebuild the R2 backup inventory from LIVE R2 with `--domain aqilevels --full-rebuild`.
3. Run the inventory-driven Dropbox sync with `--domain aqilevels --max-days-per-run 0`.
4. Confirm the active Dropbox backup contains files under `history/v1/aqilevels/hourly`.
5. Confirm the active Dropbox backup has no old AQI files outside `/hourly/`.

```bash
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX="history/v1/aqilevels/hourly" \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2_live:uk-aq-history-live" \
  --domain aqilevels \
  --index-prefix "history/_index" \
  --full-rebuild \
  --report-out "tmp/r2_backup_inventory_aqilevels_after_rebuild_LIVE.json"
```

## 8. Restart LIVE AQI schedules

After SQL, historical rebuild, helper refresh, Cloud Run backfill, and validation:

1. Restart LIVE AQI compute schedule.
2. Restart retention/cleanup if updated.
3. Restart export/prune jobs that write AQI history.
4. Confirm no job writes old layout objects.
5. Monitor the next scheduled AQI cycle.

Record:

```text
job/service:
restart time UTC:
new schedule/setting:
operator:
first successful run id:
```

## 9. Keep this file current

When TEST changes the deploy order or adds another SQL file, update this note before using it for LIVE.

If TEST discovers a better order, this file should mirror that order exactly.
