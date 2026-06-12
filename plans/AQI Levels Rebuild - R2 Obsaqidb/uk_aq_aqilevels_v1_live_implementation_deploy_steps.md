# UK AQ AQI Levels v1 - LIVE implementation deploy steps

This file is deploy-order only.

Use it after TEST has been validated and the TEST rollout notes are final.
Do not use this file for validation, rollback, or investigation.

## 1. SQL to paste into Supabase UI

Paste each file as a separate SQL run, in this order.

1. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`
   - Canonical ObsAQIDB schema file.
   - Applies the AQI hourly table/view changes, including the normalized AQI hourly contract.

2. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`
   - RPC and public function changes for the AQI history path.
   - Apply this after the schema file so the public RPC signatures and return shapes match the new table/view contract.

3. `schemas/obs_aqi_db/uk_aq_obs_aqi_db_aqi_station_link_hardening.sql`
   - Focused apply file for the AQI station-link hardening and rollup join fix.
   - Use this only if you are applying the focused patch path instead of the full schema file.
   - Do not paste this after step 1 unless you intentionally want to re-run the same hardening change.

## 2. Worker deploy

Deploy the AQI history R2 worker after the SQL changes are in place.

1. Open the repo in GitHub Desktop.
2. Publish the worker changes for `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`.
3. Deploy the worker through the normal project release path.

## 3. LIVE R2 deletion and rebuild order

Only do this after the TEST runbook has been completed and copied into the LIVE notes.

1. Pause LIVE AQI compute and AQI history writers.
2. Export a LIVE AQI R2 object inventory before deletion.
3. Delete old LIVE AQI R2 objects from the LIVE R2 bucket only.
4. Rebuild historical AQI levels from the approved LIVE source.
5. Confirm new files are written under:

```text
history/v1/aqilevels/hourly/day_utc=YYYY-MM-DD/connector_id=<id>/part-00000.parquet
```

6. Confirm no old files remain under:

```text
history/v1/aqilevels/day_utc=YYYY-MM-DD/...
history/v1/aqilevels/bands/v1/...
```

## 4. LIVE R2 Dropbox backup after rebuild

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


2.

UK_AQ_R2_HISTORY_AQILEVELS_PREFIX="history/v1/aqilevels/hourly" \
node scripts/backup_r2/build_backup_inventory.mjs \
  --source-root "uk_aq_r2_live:uk-aq-history-live" \
  --domain aqilevels \
  --index-prefix "history/_index" \
  --full-rebuild \
  --report-out "tmp/r2_backup_inventory_aqilevels_after_rebuild_LIVE.json"


## 5. Keep this file current

When TEST changes the deploy order or adds another SQL file, update this note before using it for LIVE.

If TEST discovers a better order, this file should mirror that order exactly.
