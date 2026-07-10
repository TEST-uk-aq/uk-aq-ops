# UK AQ Cloudflare Scheduler Phase 1 Inventory

## Verdict

The plan is viable.

The fixed-schedule Cloudflare dispatcher model fits the current repo layout, but one implementation caveat needs to be carried into later phases:

- `daily_task_health` already covers the daily ops jobs that are clearly instrumented.
- `uk-aq-db-size-logger`, `uk-aq-aqilevels-retention-service`, and `uk-aq-timeseries-aqi-hourly` do not all have matching daily-task-health entries today, so the ops dispatcher will need either a minimal state extension or a service-specific due-check source for those jobs.

## Files checked

- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/README_CROSS_REPO.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/AGENTS.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/.github/workflows/uk_aq_blondon_communities_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/.github/workflows/uk_aq_blondon_nodes_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/.github/workflows/uk_aq_openaq_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/.github/workflows/uk_aq_sos_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/.github/workflows/uk_aq_observs_pubsub_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_aqilevels_retention_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/.github/workflows/uk_aq_supabase_db_dump_backup_service_deploy.yml`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_latest_snapshot_cloud_run/service_core.ts`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_latest_snapshot_cloud_run/README.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_db_size_logger_cloud_run/run_service.ts`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_prune_daily/server.mjs`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_observs_partition_maintenance_service/server.mjs`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_aqilevels_retention_service/server.mjs`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_service.ts`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/workers/uk_aq_supabase_db_dump_backup_service/README.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/system_docs/uk-aq-daily-task-health.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/system_docs/uk-aq-latest-snapshot.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/system_docs/uk-aq-timeseries-aqi-hourly.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/system_docs/uk-aq-supabase-db-dump-backup-service.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/system_docs/uk_aq_dispatcher_ingest_flow.md`
- `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ingest/system_docs/uk_aq_openaq_cloud_run.md`

## Current scheduler inventory

| Current job | Service / workflow target | Current scheduler | Proposed Phase 2+ destination | Due / recent-run source |
| --- | --- | --- | --- | --- |
| `uk-aq-blondon-communities-trigger` | `uk-aq-blondon-communities-ingest` | GCP Cloud Scheduler every 15 min | Cloudflare ingest dispatcher | `uk_aq_ingest_runs` |
| `uk-aq-blondon-nodes-trigger` | `uk-aq-blondon-nodes-ingest` | GCP Cloud Scheduler every 15 min | Cloudflare ingest dispatcher | `uk_aq_ingest_runs` |
| `uk-aq-sos-trigger` | `uk-aq-sos-ingest` | GCP Cloud Scheduler every 15 min | Cloudflare ingest dispatcher | `uk_aq_ingest_runs` |
| `uk-aq-openaq-safety-trigger` | `uk-aq-openaq-ingest` | GCP Cloud Scheduler every 30 min | Keep Cloud Tasks as the primary scheduler, Cloudflare only as safety backstop | `uk_aq_ingest_runs` plus existing OpenAQ Cloud Tasks chain |
| `uk-aq-observs-pubsub-hourly` | `uk-aq-observs-pubsub-writer` | GCP Cloud Scheduler hourly | Keep GCP/native for now | Pub/Sub pipeline state plus service logs |
| `uk-aq-latest-snapshot-every-minute` | `uk-aq-latest-snapshot-builder` | GCP Cloud Scheduler every minute | Keep GCP/native for now | In-memory in-flight guard plus Cloud Scheduler/IAM |
| `uk-aq-db-size-logger-hourly` | `uk-aq-db-size-logger` | GCP Cloud Scheduler hourly | Cloudflare ops dispatcher | Daily-task-health style run history or a small task-health extension |
| `uk-aq-prune-daily` | `uk-aq-prune-daily` | GCP Cloud Scheduler daily | Cloudflare ops dispatcher | `daily_task_health` |
| `uk-aq-observs-partition-maintenance-daily` | `uk-aq-observs-partition-maintenance-service` | GCP Cloud Scheduler daily | Cloudflare ops dispatcher | `daily_task_health` |
| `uk-aq-aqilevels-retention-daily` | `uk-aq-aqilevels-retention-service` | GCP Cloud Scheduler daily | Cloudflare ops dispatcher | Needs either a `daily_task_health` extension or a minimal dedicated due-check source |
| `uk-aq-timeseries-aqi-hourly-trigger` plus reconcile variants | `uk-aq-timeseries-aqi-hourly` | Multiple GCP Cloud Scheduler jobs | Cloudflare ops dispatcher, but only after job-mode mapping is designed | Service-specific state or `uk_aq_ingest_runs` / task-history lookup |
| `uk-aq-supabase-db-dump-backup-job-trigger` | `uk-aq-supabase-db-dump-backup-job` | GCP Cloud Scheduler for Cloud Run Job | Keep GCP/native | `daily_task_health` |

## Auth assessment

Current Cloud Run scheduler calls are protected by GCP Scheduler OIDC/IAM.

That path is not practical for Cloudflare to reuse directly. The safest later-phase approach is:

- Cloudflare Worker sends a shared dispatch header.
- Cloud Run validates that header against a secret stored in Secret Manager or env vars.
- Existing manual invocation paths stay intact.

Several services already accept trigger-mode headers, but none of the Cloud Run targets in this inventory currently enforce a dispatch secret.

## Phase 1 completion notes

This inventory is the Phase 1 deliverable.

No runtime code changed in Phase 1.
