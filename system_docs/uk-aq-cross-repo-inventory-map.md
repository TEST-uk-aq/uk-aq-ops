# UK AQ Cross-Repo Inventory Map

Last updated: 2026-04-23

## Repository Roles

- Main orchestrator repo: `CIC-test-uk-aq-ops`
- Canonical schema repo: `CIC-test-uk-aq-schema` (`schemas/` is source of truth)
- Ops runtime repo: `CIC-test-uk-aq-ops`
- Web UI repo: `CIC-test-uk-aq`
- Population ingest repo: `CIC-Test-uk-population-ingest`

## 1) Ingest Repo (`CIC-test-uk-aq-ingest`)

### Edge Functions (`supabase/functions/*/index.ts`)

- `ingest_sos`
- `ingest_openaq`
- `ingest_breathelondon`
- `ingest_erg_laqn`
- `ingest_sensorcommunity`
- `uk_aq_dispatch_polls`
- `uk_aq_egress_monitor`
- `uk_aq_latest`
- `uk_aq_timeseries`
- `uk_aq_stations`
- `uk_aq_stations_chart`
- `uk_aq_station_snapshot`
- `uk_aq_pcon_hex`
- `uk_aq_la_hex`

### Ingest Script Entrypoints (`scripts/*/*ingest*.py`)

- `scripts/sos/sos_ingest.py`
- `scripts/breathelondon/breathelondon_ingest.py`
- `scripts/erg_laqn/erg_laqn_ingest.py`
- `scripts/sensorcommunity/sensorcommunity_ingest.py`
- `scripts/gov_uk_waqn/gov_uk_waqn_ingest.py`

### Cloud Run Worker Dirs (ingest side)

- `workers/uk_aq_sos_cloud_run/`
- `workers/uk_aq_openaq_cloud_run/`
- `workers/uk_aq_blondon_communities_cloud_run/`
- `workers/uk_aq_sensorcommunity_cloud_run/`
- `workers/uk_aq_observs_pubsub_cloud_run/`

### Key Workflows (`.github/workflows/`)

- `supabase_edge_deploy.yml`
- `uk_aq_observs_edge_deploy.yml`
- `uk_aq_ingest_poller_deploy.yml`
- `uk_aq_sos_cloud_run_deploy.yml`
- `uk_aq_openaq_cloud_run_deploy.yml`
- `uk_aq_blondon_communities_cloud_run_deploy.yml`
- `uk_aq_scomm_cloud_run_deploy.yml`
- `uk_aq_egress_monitor.yml`
- `uk_aq_observs_egress_monitor.yml`
- `supabase-keepalive.yml`

## 2) Ops Repo (`CIC-test-uk-aq-ops`)

### Cloud Run Services (`workers/*/server.mjs`)

- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_observs_outbox_flush_service/server.mjs`
- `workers/uk_aq_observs_partition_maintenance_service/server.mjs`
- `workers/uk_aq_aqilevels_retention_service/server.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/server.mjs`

### TypeScript Run Services (`workers/*/run_service.ts`)

- `workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts`
- `workers/uk_aq_db_size_logger_cloud_run/run_service.ts`
- `workers/uk_aq_who_2021_daily_cloud_run/run_service.ts`

### Cloudflare Workers (`workers/*/worker.mjs`)

- `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`
- `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs`

### Key Workflows (`.github/workflows/`)

- `uk_aq_prune_daily_cloud_run_deploy.yml`
- `uk_aq_observs_partition_maintenance_cloud_run_deploy.yml`
- `uk_aq_aqilevels_retention_cloud_run_deploy.yml`
- `uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml`
- `uk_aq_db_size_logger_cloud_run_deploy.yml`
- `uk_aq_who_2021_daily_cloud_run_deploy.yml`
- `uk_aq_observs_history_r2_api_worker_deploy.yml`
- `uk_aq_aqi_history_r2_api_worker_deploy.yml`
- `uk_aq_db_r2_metrics_api_worker_deploy.yml`
- `uk_aq_cache_proxy_deploy.yml`
- `uk_aq_r2_history_dropbox_backup.yml`
- `uk_aq_r2_core_snapshot.yml`
- `uk_aq_r2_history_restore_from_dropbox.yml`

## 3) Schema Repo (`CIC-test-uk-aq-schema`)

### Ingest DB Canonical DDL (`schemas/ingest_db/`)

- `uk_aq_core_schema.sql`
- `uk_aq_raw_schema.sql`
- `uk_aq_pop_schema.sql`
- `uk_aq_public_views.sql`
- `uk_aq_rpc.sql`
- `ingest_db_ops_rpcs.sql`
- `uk_aq_aqilevels_schema.sql`
- `uk_aq_ops_schema.sql`
- `uk_aq_security.sql`
- `main_db_dualwrite_bootstrap.sql`

### Obs/AQI DB Canonical DDL (`schemas/obs_aqi_db/`)

- `uk_aq_obs_aqi_db_schema.sql`
- `uk_aq_obs_aqi_db_ops_rpcs.sql`
- `uk_aq_obs_aqi_db_dualwrite_bootstrap.sql`
- `uk_aq_backfill_ops_obs_aqi.sql`
- `uk_aq_core_mirror_rpcs.sql`
- `uk_aq_obs_aqidb_chart_load_metrics.sql`
- `uk_aq_obs_aqidb_day_counts_current.sql`
- `uk_aq_station_connector_lookup_view.sql`
- `uk_aq_timeseries_lifecycle_columns.sql`

### Current Migrations (`schemas/migrations/`)

- `2026-03-13_obs_aqidb_day_counts_current.sql`

## 4) Web Repo (`CIC-test-uk-aq`)

### Primary UI Pages

- `index.html`
- `uk_aq_stations_chart.html`
- `uk_aq_hex_map.html`

### Active/Test Pages

- `uk_aq_sensors_map.html`
- `uk_aq_history_r2_vs_supabase_test.html`
- `uk_aq_history_r2_cache_test.html`
- `hex_map_test.html`
- `hex_map_test1.html`
- `hex_map_test2.html`
- `hex_map_test3.html`
- `hex_map_test_met1.html`

### Build/Config Helper

- `scripts/uk_aq_inject_project_ref.mjs`

## 5) Population Repo (`CIC-Test-uk-population-ingest`)

### Edge Functions (`supabase/functions/*/index.ts`)

- `uk_aq_population`
- `uk_population_catalogue_load`
- `uk_population_external_ingest`
- `nomis_monthly_check`

### Script Entrypoints (`scripts/*.py`)

- `scripts/nomis_discover.py`
- `scripts/nomis_auth_check.py`
- `scripts/nomis_ingest.py`
- `scripts/nrs_ingest.py`
- `scripts/nisra_ingest.py`
- `scripts/uk_population_catalogue_load.py`

### Workflows (`.github/workflows/`)

- `supabase_edge_deploy.yml`
- `nomis_monthly_check.yml`
- `nomis_ingest.yml`

## Cross-Repo Touchpoints (Most Important)

- Web read path: `CIC-test-uk-aq` -> cache/API routes and edge functions in `CIC-test-uk-aq-ingest`, plus population edge function in `CIC-Test-uk-population-ingest`.
- Write path: ingest/population repos write to tables, views, and RPCs defined in `CIC-test-uk-aq-schema`.
- History/retention/backups: runtime ops execute from `CIC-test-uk-aq-ops` against schema-defined objects.
- Recommended change sequence: schema changes first, then ingest/ops runtime updates, then web behavior validation.
