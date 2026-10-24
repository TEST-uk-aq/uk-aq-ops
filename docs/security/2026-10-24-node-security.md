# Node.js October 2026 security remediation — 24 October 2026

Status: proposed TEST repository changes; deployment and real operational acceptance remain outstanding.

The repository change is configuration only. No application source, dependency manifest/lock, secret, variable, schedule, permission, concurrency group, lock, timeout, deletion guard, failure handler or data-writing command is changed. All 60 current workflow files were parsed, and parsed before/after comparisons prove that the only workflow changes are exact Node selections, the 12 new setup steps and the Sensor.Community build flags/digest output. No operational workflow, service, database or cloud mutation was run.

The official October bulletin requires Node 24.22.1 / 22.23.4. Operational workflows now select exact 24.22.1; no Node 22 compatibility exception was needed. Exact setup-node requests cannot silently select an earlier patch: download/cache failure fails the setup step. Setup logs supply the selected version. Advance these pins together after reviewing later supported security releases; they do not automatically follow newer patches.

New setup steps reuse the verified actions/setup-node v7.0.0 commit 820762786026740c76f36085b0efc47a31fe5020 and disable automatic package-manager caching. Existing action references and cache settings are retained. The pinned action and the referenced checkout, Python, artifact, cache, CodeQL, Google and Wrangler action definitions declare node24; Supabase is composite, with pinned nested setup-node/setup-bun. setup-node does not select action-host Node. Actual hosted-runner bundled Node patch and runner identity remain operational evidence requirements. Node-24 actions require a compatible runner (at least 2.327.1 for the reviewed Node-24 migration); current jobs use ubuntu-latest.

All 25 existing Node 22/24 selections and nine additional jobs using implicit Node/npm/npx or Wrangler now select 24.22.1. These extra configurations are in the requested Ops repository and close the same runtime exposure; they are not an expansion into other repositories. No dependency upgrades are needed: root locks and the two dashboard/history Worker toolchain locks admit Node 24 for Linux amd64. Their optional @img/sharp-win32-ia32@0.35.4 Node ^20.9.0 declaration is excluded by its Windows/ia32 platform selectors and is deferred to a Windows-tooling review.

The retained root Dockerfile is not referenced by any current workflow. Active container builds explicitly select the two worker-local Deno Dockerfiles. No root-image build/deploy configuration or supported current root-image operator procedure was found in the inspected README/Prune instructions and tracked deployment paths. External/manual consumers remain unverified. Leave node:24-alpine unchanged and do not rebuild or delete it; if an external consumer is established, add the security floor before reuse.

All 11 LIVE Node-20 workflow counterparts were already Node 24 in TEST. Most complete workflows differ from LIVE only in runtime/action references. Prune Daily additionally carries existing JSONgen settings and literal UK_AQ_ENV_NAME=TEST; it is blocked for unchanged LIVE promotion. Partition maintenance changes the history-generation configuration/validation. Restore application source in TEST includes verification-overlay support absent in LIVE. Those differences are not approved by this runtime patch. The inventory-generation migration still contains LIVE-labelled configuration: do not run it for TEST acceptance or change its target in this task.

After separate authorization, use existing normal TEST operations for chart metrics, raw retention, partition maintenance, Prune, core snapshot, history backup, database backup, WHO and dashboard deployment. Preserve all current paused/activation states and lock/deletion safeguards. Start destructive paths with their existing dry-run inputs, then obtain separately approved real-operation evidence. Do not manufacture data or run a migration merely to test a version. Check task-health lifecycle, reports/artifacts and existing failure semantics. Generic restore remains limited recovery authority; use only an approved bounded TEST recovery exercise.

Changed configuration files:

| File | Before | After |
|---|---|---|
| `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_blog_feed_worker_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_cache_proxy_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_chart_metrics.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_dropbox_prune_raw.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_consumer_readonly.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_first_operation_preflight.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_reader_readiness.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_prune_stage_d_readiness.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_r2_readonly_check.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_bundle_r2_transport.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_jsongen_signer_intents_readonly.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_observs_partition_maintenance.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml` | runner PATH / action host | 24.22.1 |
| `.github/workflows/uk_aq_prune_daily.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_core_snapshot.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_dropbox_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_inventory_generation_migration.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_station_history_deploy.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_supabase_db_dump_backup.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml` | 24 | 24.22.1 |
| `.github/workflows/uk_aq_v3_reader_version_urls.yml` | 22 | 24.22.1 |
| `.github/workflows/uk_aq_who_2021_daily.yml` | 24 | 24.22.1 |

Structural validation: 60 YAML parses; 39 changed workflow semantic comparisons; 38 exact runtime selections in execution order; all four Sensor Docker COPY sources/ignore rules; syntax checks for four Sensor modules and the runtime assertion; the actual development-host 24.19.0 is rejected by that assertion. No application tests, install scripts, Docker build or functional operations were run. No archive is required for these low-risk configuration-only edits; no application code changed.

Rollback: revert this repository commit through a reviewed TEST branch. Do not restore an unsupported runtime into operation. A Cloud Run rollback requires a previously accepted patched immutable image/revision. Reverting workflow source does not undo already performed data operations or migrations. Keep all existing history/backup recovery contracts and activation decisions.

Documentation handover for ChatGPT in Chat mode: record the exact selected runtime floor, image assertion and required digest/runner evidence if current deployment documentation is updated. No authoritative system_docs file is modified and no schema or environment-key change is required.

Sources: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases ; TEST System Docs merged PR #3 and its companion 3,045-row CSV; current pinned GitHub source and upstream action.yml definitions. Current deployment acceptance is not inferred from source versions.
