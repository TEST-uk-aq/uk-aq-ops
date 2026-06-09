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

## 3. Keep this file current

When TEST changes the deploy order or adds another SQL file, update this note before using it for LIVE.

If TEST discovers a better order, this file should mirror that order exactly.
