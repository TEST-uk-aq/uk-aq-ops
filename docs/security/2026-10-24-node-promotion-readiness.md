# TEST-to-LIVE promotion readiness — 24 October 2026

No LIVE change or promotion is approved. Structural security corrections in TEST do not establish deployment or operational acceptance. All comparisons use current pinned GitHub sources, not the older workspace checkouts. Never promote archives or replace newer LIVE application code with an older TEST version. Recompare current LIVE main and the accepted TEST commit immediately before any operator promotion.

Inspected source identities:

- `test-ingest`: `214d5dc055e1df907f3ba8930fd312d8a2266891`
- `test-ops`: `376082edd724e02f3f826753556f93574a2368e4`
- `live-ingest`: `3c7ac962b1761691c40dab8494abaaf37a0bf59d`
- `live-ops`: `daf9ba6660e3c415cb00581d2e1bae348ddaa4bf`

The 12 LIVE Node-20 workflow selections map one-to-one to existing TEST files that already selected Node 24. This patch adds the exact 24.22.1 floor. Node-24 embedded actions had already been upgraded in TEST; actual bundled runner patch identity is still unverified. No file is currently recommended for promotion without the real TEST evidence below.

| LIVE file | Corresponding TEST file | Security correction in TEST | Other complete-file differences / supporting review |
|---|---|---|---|
| `UK-AQ/uk-aq-ingest/.github/workflows/uk_aq_stations_daily.yml` | `TEST-uk-aq/uk-aq-ingest/.github/workflows/uk_aq_stations_daily.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences. Existing Node health/discovery entrypoints have identical Git blob identities. Retain all Python stages, polling recovery and warning isolation. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_chart_metrics.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_chart_metrics.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; Node entrypoint blob is identical. Preserve timeout/report upload. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_dropbox_prune_raw.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_dropbox_prune_raw.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences. Preserve Python pruning controls and Node health reporting. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_observs_partition_maintenance.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_observs_partition_maintenance.yml` | Previously major 24; proposed exact 24.22.1 | Additional history-generation env/validation differences: TEST requires UK_AQ_R2_HISTORY_VERSION; LIVE supplies an observations-prefix mapping. Approve configuration/application alignment separately. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; browser config generator blob is identical. Preserve configured account/project, browser-safe output and dashboard-provider compatibility. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_prune_daily.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_prune_daily.yml` | Previously major 24; proposed exact 24.22.1 | BLOCKED: pre-existing literal UK_AQ_ENV_NAME=TEST, JSONgen credentials/flags and validation are absent in LIVE. TEST job.mjs also changes operation run identity to UUID. Review the complete Prune/shared writer dependency and schema/configuration set with the existing safety/activation contracts. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_r2_core_snapshot.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_r2_core_snapshot.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; snapshot entrypoint blob is identical. Retain protected core/binding publication, locks and root ordering. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; locked-backup entrypoint and global-lock wrapper blobs are identical. Retain pack default, source-generation selection, checkpoint and stale-pruning protections. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_r2_history_inventory_generation_migration.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_r2_history_inventory_generation_migration.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences. Existing LIVE-labelled target/configuration remains: do not dispatch this TEST workflow as acceptance evidence; use an independently reviewed TEST-targeted procedure if needed. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` | Previously major 24; proposed exact 24.22.1 | Workflow differs only in runtime/action references, but TEST restore script adds verification-overlay imports/domain/recovery absent in LIVE. If promoting that application version, include workers/shared/uk_aq_observation_verification_overlay.mjs and its reviewed dependency/configuration set. The unchanged workflow selects its existing three domain inputs; generic restore is not full-system recovery authority. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_supabase_db_dump_backup.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_supabase_db_dump_backup.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; job entrypoint blob is identical. Preserve PostgreSQL 17 client, concurrent databases, Dropbox layout/retention and health/failure handling. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_who_2021_daily.yml` | `TEST-uk-aq/uk-aq-ops/.github/workflows/uk_aq_who_2021_daily.yml` | Previously major 24; proposed exact 24.22.1 | Only runtime/action-reference differences; main.ts/upload_report.ts blobs are identical. Deno remains a separate deferred runtime issue. Preserve correction day, source authority, calendar reuse and publication order. |

| `UK-AQ/uk-aq-ingest/workers/uk_aq_sensorcommunity_cloud_run/Dockerfile` | Same TEST path | Previously 24-slim; proposed 24.22.1-slim plus fail-closed build assertion | LIVE selects 20-slim and lacks the additional metrics COPY source. Complete build set below is mandatory; egress instrumentation has separate acceptance/configuration implications. |
| `UK-AQ/uk-aq-ops/Dockerfile` | Same TEST path | TEST already selects 24-alpine; retained without new enforcement because no tracked active consumer was found | Complete compared file differs only in FROM 20→24. External/manual consumers unverified. Do not promote/rebuild this inactive wiring for appearance; enforce a patched floor before any future supported use. |

## Sensor.Community complete-file set

1. `workers/uk_aq_sensorcommunity_cloud_run/Dockerfile`
2. `workers/uk_aq_sensorcommunity_cloud_run/Dockerfile.dockerignore`
3. `workers/uk_aq_sensorcommunity_cloud_run/index.mjs`
4. `workers/uk_aq_sensorcommunity_cloud_run/run_service.mjs` (identical TEST/LIVE blob)
5. `workers/uk_aq_sensorcommunity_cloud_run/service_egress_metrics.mjs` (absent in LIVE)
6. `supabase/functions/_shared/ingestdb_observation_writer.mjs` (identical TEST/LIVE blob)
7. `.github/workflows/uk_aq_scomm_cloud_run_deploy.yml`

The build context is repository root, with the worker's Dockerfile-specific ignore rules admitting all four COPY sources. There is no root .dockerignore or .gcloudignore in the inspected Ingest source. The application uses Node builtins and the copied modules, with no container npm install. The existing layout correctly resolves the index module's relative shared import to /supabase/functions/_shared/. No files are removed.

TEST index.mjs already adds service egress collection, PostgREST labels/bypass and final flush; its environment name defaults to TEST when UKAQ_ENV_NAME is missing. The TEST deployment workflow already adds metrics environment/secret setup and an environment-name default. Promotion must require explicit correct LIVE configuration and acceptance of those unrelated additions. This patch does not introduce or expand them. A Dockerfile-only promotion would fail on the missing module; an index-only promotion would fail on its missing import.

The chosen patch tag retains Debian bookworm-slim and amd64/arm64v8/ppc64le support according to official source metadata. Tags and OS package layers can be republished: --pull and plain build output establish selected base identity; the assertion establishes actual Node patch/arch; RepoDigests output establishes the pushed application identity. Record the actual serving revision's digest/traffic as separate deployment evidence. No immutable registry digest or running image was observed in this task.

## Supporting application/lock files

For a workflow-only promotion whose only non-Node differences are action references, retain existing LIVE application files and independently establish their Node-24 compatibility; this task does not authorize copying TEST manifests, locks or whole implementation trees merely to align versions. TEST and LIVE Ops root package.json/package-lock.json differ, and Ingest root lockfiles differ. Identical entrypoint blob identity is not proof that all imported shared dependencies are identical.

Review the workflow's existing entrypoint and dependency closure with its applicable contract: chart `workers/uk_aq_chart_metrics/job.mjs`; health `scripts/report_daily_task_health.mjs`; partitions `workers/uk_aq_observs_partition_maintenance_service/job.mjs`; Prune `workers/uk_aq_prune_daily/{job,server}.mjs` plus phase-B/shared writer/lock modules; core `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`; backup `scripts/backup_r2/uk_aq_run_locked_history_backup.mjs` and `scripts/operations/uk_aq_with_observations_global_operation_lock.mjs` plus backup libraries; restore `scripts/backup_r2/restore_history_from_dropbox.mjs`; migration `scripts/backup_r2/migrate_backup_inventory_generation.mjs`; database dump `workers/uk_aq_supabase_db_dump_backup_service/{job,core,health}.mjs`; WHO `workers/uk_aq_who_2021_daily/{main,upload_report}.ts`; Pages `scripts/dashboard/generate_dashboard_config.mjs`, dashboard/ and station_snapshot/. No application promotion closure is approved by this runtime-only PR. Prune and restore require a separately reviewed complete implementation set if their newer TEST application code is included.

Additional changed workflow files are enumerated in 2026-10-24-node-modified-files.csv: exact pins also replace remaining Node 22 and implicit PATH selections within the same two repositories. The new explicit selections precede all direct Node/npm/npx, Wrangler and Supabase consumers. TEST-only JSONgen workflows have no LIVE counterpart and are not a promotion set. The additional complete-file comparisons below cover every remaining affected LIVE workflow; they do not confer promotion approval.

## Required real TEST evidence and current blockers

- Every affected execution: source commit/run URL, selected 24.22.1 from setup logs, actual node --version/process.execPath, npm/tool version where relevant, hosted runner version and independently observed runner action-host Node patch. setup-node cannot prove action-host patching. Do not assert >=24.22.1 for the runner's bundled node24 without evidence.
- Sensor.Community: successful build assertion, base manifest and final image digests, serving Cloud Run revision/digest/traffic, then a normal real ingest with unchanged writes/dispatch/health/egress behaviour.
- Daily Stations: normal TEST workflow; restored polling, retained references and source-isolation warnings remain correct.
- Prune and partition retention: independently authorized real TEST operation under existing paused/activation state, valid lock lifecycle, reports and unchanged gates; deletion only with its separate authorization. Dry run alone does not establish deletion acceptance.
- Core/backup: normal controlled TEST snapshot/backup; generation and lock scope, exact binding/root/checkpoint ordering, packed bindings and failure propagation remain intact.
- Restore/migration: only an independently authorized bounded TEST recovery/migration procedure. Do not run the retained LIVE-targeted inventory workflow. Generic restore is not complete system recovery evidence.
- Database backup: existing scheduled/manual TEST backup of configured databases, expected dump chunks/layout/retention and success/failure task health.
- WHO: existing TEST daily operation, correction day and rolling/calendar decisions, report/artifact and publication order. Deno patching remains outstanding in its own batch.
- Dashboard/Worker/tooling: existing authorized deployment workflow and representative authenticated TEST request; required provider-before-consumer order and browser-secret exclusion remain intact.

Operational acceptance has not occurred. Remaining blockers include the existing TEST-only Prune identity/JSONgen wiring, Sensor metrics/application differences, partition configuration differences, unverified action-host patches, missing registry/deployment identities and deferred Deno/runtime dependency findings. Do not enable paused jobs or apply new resource settings as a side effect of validating this patch.

## Remaining affected LIVE workflows and TEST-only files

Each row maps the same relative file under the named LIVE repository to `TEST-uk-aq` in the corresponding repository. All proposed TEST selections are 24.22.1. Exact TEST runtime fixes are complete; real TEST evidence remains required for every row.

| LIVE repository / workflow | Existing LIVE selection | Other complete-file differences and supporting files / evidence |
|---|---|---|
| `UK-AQ/uk-aq-ingest/.github/workflows/uk_aq_cloudflare_scheduler_ingest_config_sync.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained checkout/Python references only. Retain existing scheduler jobs.toml, sync_jobs.py and Wrangler config; validate existing gated sync path. |
| `UK-AQ/uk-aq-ingest/.github/workflows/uk_aq_cloudflare_scheduler_ingest_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain complete scheduler worker/config/migrations and secret wiring; observe authorized TEST scheduler deployment/dispatch. |
| `UK-AQ/uk-aq-ingest/.github/workflows/uk_aq_observs_edge_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained checkout/Supabase action references only. Retain Supabase config/function source and existing CLI version/configuration; observe authorized TEST function deployment. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain the complete Worker source/shared imports and its existing Wrangler configuration, bindings and secret mappings; use the existing authorized TEST deployment and representative authenticated request. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_blog_feed_worker_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain the complete Worker source/shared imports and its existing Wrangler configuration, bindings and secret mappings; use the existing authorized TEST deployment and representative authenticated request. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_cache_proxy_deploy.yml` → same TEST path | 22 | Only Node selection and maintained action references differ. Retain cache Worker/shared history config and approved bound upstreams; verify existing TEST cached/history routes. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` → same TEST path | implicit PATH / action host | TEST also verifies deployment-managed worker_http_url values. Requires compatible cloudflare/scheduler/jobs.toml, scripts/sync_jobs.py and remote schema; no remote sync during PR validation. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml` → same TEST path | implicit PATH / action host | TEST also binds the existing Media email Worker HTTP secret. Requires approved scheduler worker/config/schema and secret mapping; do not silently add that operational capability through runtime promotion. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain the complete Worker source/shared imports and its existing Wrangler configuration, bindings and secret mappings; use the existing authorized TEST deployment and representative authenticated request. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup plus maintained action references; existing Deno/app/deploy steps are otherwise the same. Retain root package/lock for npm type resolution and the worker-local Deno Docker context. Validate the normal TEST snapshot; Deno remains a separate batch. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain the complete Worker source/shared imports and its existing Wrangler configuration, bindings and secret mappings; use the existing authorized TEST deployment and representative authenticated request. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` → same TEST path | 22 | Only application Node selection differs. Retain repository runtime lock, Worker package/lock/Wrangler config/shared reader and existing provider deployment order; accept through existing TEST deployment and authenticated read. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml` → same TEST path | 22 | TEST adds a main-push trigger limited to the Media route/workflow, absent in LIVE. Other differences are the runtime selection. Requires complete dashboard Worker package/lock/config and provider-before-consumer ordering; independently approve the new trigger. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml` → same TEST path | implicit PATH / action host | New explicit Node setup and maintained action references only. Retain the complete Worker source/shared imports and its existing Wrangler configuration, bindings and secret mappings; use the existing authorized TEST deployment and representative authenticated request. |
| `UK-AQ/uk-aq-ops/.github/workflows/uk_aq_station_history_deploy.yml` → same TEST path | 22 | Only Node selection and maintained Wrangler action reference differ. Retain station-history Worker/shared modules/history config; verify authorized TEST chart/history request. |

These changed TEST Ops workflows have no LIVE counterpart and must not be included in a security promotion set:

- `.github/workflows/uk_aq_jsongen.yml`
- `.github/workflows/uk_aq_jsongen_prune_consumer_readonly.yml`
- `.github/workflows/uk_aq_jsongen_prune_first_operation_preflight.yml`
- `.github/workflows/uk_aq_jsongen_prune_reader_readiness.yml`
- `.github/workflows/uk_aq_jsongen_prune_stage_d_readiness.yml`
- `.github/workflows/uk_aq_jsongen_r2_readonly_check.yml`
- `.github/workflows/uk_aq_jsongen_signer_bundle_r2_transport.yml`
- `.github/workflows/uk_aq_jsongen_signer_deploy.yml`
- `.github/workflows/uk_aq_jsongen_signer_intents_readonly.yml`
- `.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml`
- `.github/workflows/uk_aq_v3_reader_version_urls.yml`
