# UK AQ R2 History Phase 0 Consumer Inventory

## Consumer Matrix

| File | Runtime / Job | Role | Destructive? | Current Version Selector | Current Default / Override | Paths Used | Deployment Workflow | Trigger Coverage | Migration Phase |
|---|---|---|---|---|---|---|---|---|---|
| `workers/shared/uk_aq_r2_history_version.mjs` | Node.js Shared | Parser | No | Canonical env var parser | Rejects split vars | N/A | N/A | Needs to be added to all consumer workflow triggers | Phase 1 |
| `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` | Node.js (Cloud Run) | Write | No | `resolvePhaseBHistoryWritePrefixes()` reads `UK_AQ_R2_HISTORY_VERSION` | Defaults to v1 paths | `history/v1/*`, `history/v2/*` | `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml` | Currently prune files | Phase 3 |
| `workers/uk_aq_observs_history_r2_api_worker/worker.mjs` | Cloudflare Worker | Read | No | `UK_AQ_R2_HISTORY_VERSION` | Override by query param `?read_version` | `history/v1/observations`, `history/v2/observations`, `history/_index`, `history/_index_v2` | `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` | Currently observs API files | Phase 2 |
| `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` | Cloudflare Worker | Read | No | `UK_AQ_R2_HISTORY_VERSION` | Override by query param `?read_version` | `history/v1/aqilevels/hourly`, `history/v2/aqilevels/hourly/data`, `history/_index`, `history/_index_v2` | `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml` | Currently aqi API files | Phase 2 |
| `workers/shared/uk_aq_r2_history_index.mjs` | Node.js Shared | Builder | No | Returns both v1/v2 paths based on script context | Varies by caller | `history/_index`, `history/_index_v2` | N/A | Needs to be in backup/index builder triggers | Phase 2 |
| `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` | Node.js Script | Write | No | `UK_AQ_R2_HISTORY_INDEX_VERSION` | Defaults to v1 | `history/_index`, `history/_index_v2` | Backup workflow | Backup workflow files | Phase 2 |
| `scripts/backup_r2/build_backup_inventory.mjs` & `inventory.mjs` | Node.js Script | Read/Write | No | `UK_AQ_R2_HISTORY_VERSION` | Hardcoded domain-to-version mapping | `history/v1/*`, `history/v2/*` | `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | Backup workflow files | Phase 3 |
| `scripts/uk_aq_backfill_local.sh` / `run_job.ts` | Shell / Deno | Write | No | Canonical version but with specific prefix vars | Overrides for v2 prefixes | `history/v1/*`, `history/v2/*` | Local / Manual | N/A | Phase 3 |
| `workers/uk_aq_observs_partition_maintenance_service/server.mjs` | Node.js (Cloud Run) | Delete | Yes | `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX` | Forced by workflow mapping to v2 | `history/v2/observations` | `.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml` | Currently partition maintenance files | Phase 4 |
| `workers/uk_aq_aqilevels_retention_service/server.mjs` | Node.js (Cloud Run) | Delete | Yes | `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` | Defaults to `history/v1/aqilevels/hourly` | `history/v1/aqilevels/hourly` | `.github/workflows/uk_aq_aqilevels_retention_cloud_run_deploy.yml` | Currently aqilevels retention files | Phase 4 |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` | Python / Shell | Read | No | Hardcoded in env files or CLI args | TEST/LIVE envs use `history/v1/core` | `history/v1/core`, `history/v2/core`, etc. | Local / CI runner | N/A | Phase 5 |
| `workers/uk_aq_db_size_logger_cloud_run/run_job.ts` | Deno (Cloud Run) | Read | No | `UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX`, `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` | Defaults to v1 paths | `history/v1/observations`, `history/v1/aqilevels/hourly` | `.github/workflows/uk_aq_db_size_logger_cloud_run_deploy.yml` | Currently db_size_logger files | Phase 2 |
| `workers/uk_aq_db_size_metrics_api_worker/worker.mjs` | Cloudflare Worker | Read | No | `UK_AQ_R2_HISTORY_VERSION` | Defaults to v1; allows overrides via specific prefix vars | `history/_index/*`, `history/v1/*`, `history/_index_v2/*`, `history/v2/*` | `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml` | Currently db_size_metrics_api files | Phase 2 |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts` | Cloudflare Worker | Read | No | `UK_AQ_R2_HISTORY_VERSION` | Defaults to v1 paths based on regex | `history/v1/` referenced in regex | `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml` | Currently dashboard API files | Phase 2 |
| `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts` | Deno (Cloud Run) | Write | No | `UK_AQ_LATEST_SNAPSHOT_CORE_METADATA_PREFIX` | Defaults to `history/v2/core` | `history/v2/core` | `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml` | Currently latest_snapshot files | Phase 3 |
| `cloudflare/workflow-scheduler/worker.js` | Cloudflare Worker | Pass-through | No | `UK_AQ_R2_HISTORY_VERSION` | Validates v1/v2, passes to jobs | N/A | N/A | N/A | Phase 6 |

## Direct Path Literals Allowed / Unrelated
- `workers/uk_aq_who_2021_daily_cloud_run/who_2021_daily_core.ts` uses `history/v2/who_2021/`. This is an unrelated API/schema version string for WHO statistics, not part of the `UK_AQ_R2_HISTORY_VERSION` R2 shared layout profile migration.
- `TEST-uk-aq-root.github.io/index.html` (root website) consumes APIs, not R2 history paths directly.
- `TEST-uk-aq-schema` schemas (e.g., `uk_aq_obs_aqi_db_schema.sql`) contain index / partitioning paths and docs, but no direct active reads/writes of R2 history.
- `TEST-uk-aq-ingest` does not contain R2 history prefix consumers (verified via audit).

## Silent v1 Fallback and Prefix Mix Risks
- **`workers/uk_aq_aqilevels_retention_service/server.mjs`**: Defaults directly to `history/v1/aqilevels/hourly` if `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` is omitted.
- **`workers/uk_aq_db_size_logger_cloud_run/run_job.ts`**: Defaults to `history/v1/observations` and `history/v1/aqilevels/hourly` if specific prefix variables are missing.
- **`workers/uk_aq_db_size_metrics_api_worker/worker.mjs`**: Defaults to `history/v1/...` if version variable mapping is incomplete or fallback logic executes.
- **`scripts/backup_r2/uk_aq_build_r2_history_index.mjs`**: Relies on `UK_AQ_R2_HISTORY_INDEX_VERSION` and silently defaults to v1.
- **`scripts/uk-aq-history-integrity/env/LIVE.env.example`** (and CIC-Test): Hardcode `history/v1/core`.

## Redeployment Requirements
The following services must be redeployed when the shared profile changes (e.g. updating `UK_AQ_R2_HISTORY_VERSION`):
- `uk-aq-prune-daily`
- `uk-aq-observs-history-r2-api`
- `uk-aq-aqi-history-r2-api`
- `uk-aq-db-size-metrics-api-worker`
- `uk-aq-dashboard-online-api-worker`
- `uk-aq-r2-history-dropbox-backup` (subsequent workflow runs will use new config)
- `uk-aq-observs-partition-maintenance-service`
- `uk-aq-aqilevels-retention-service`
