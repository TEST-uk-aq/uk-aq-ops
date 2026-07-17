# System documentation migration inventory

## Purpose

This file records the migration status of existing UK AQ Ops documentation into the authoritative area structure.

A document is not deleted or redirected until its current content has been reviewed and every still-valid rule has an authoritative home.

## Status meanings

- **Authoritative**: current source of truth.
- **Pending review**: still active evidence until migrated.
- **Split planned**: current content belongs in more than one target file.
- **Redirect planned**: content has been migrated and the old path can become a short pointer.
- **Migrated/removed**: current content has an authoritative home and the previous active path no longer exists.
- **Historical**: documents retired behaviour or a point-in-time investigation.
- **Stale active reference**: current documentation names a runtime path that is no longer active.

## Documentation roots

| Path | Status | Notes |
|---|---|---|
| `system_docs/` | Authoritative | Sole active system-documentation root. |
| `system_docs_legacy/` | Historical or pending migration evidence | Superseded broad documents and dated reports. These do not override completed area contracts. |
| `docs/` | Migrated/removed | All eight files were reviewed, corrected where necessary, moved into authoritative areas or retained as dated legacy reports. The directory must not be recreated. |

## Repository-level files

| Current file | Status | Target action |
|---|---|---|
| `README.md` | Stale active references confirmed | Rewrite later as a concise repository entry point. Remove retired Timeseries AQI Hourly and Backfill Cloud Run instructions. Link to `system_docs/README.md`. |
| `AGENTS.md` | Active agent rules | Retain. Link to `system_docs/README.md` when next edited. Do not duplicate area contracts. |
| `README_CROSS_REPO.md` | Pending review | Move stable repository ownership and boundary rules into `architecture/cross_repo_dependencies.md`; retain only a concise orientation if still useful. |
| `package.json` | Runtime inventory evidence, not documentation authority | Continue using it to confirm active entrypoints and checks. It currently names dashboard wrapper scripts that are absent from the active tree; do not copy those entries into authoritative documentation. |

## Framework files

| File | Status | Notes |
|---|---|---|
| `system_docs/README.md` | Authoritative | Master index and reading order. |
| `system_docs/documentation_contract.md` | Authoritative | Documentation maintenance and coding-agent protocol. |
| `system_docs/repository_documentation_map.md` | Authoritative migration design | Defines the target area/file structure. |
| `system_docs/migration_inventory.md` | Authoritative migration tracker | This file. |

## Former `docs/` files

| Previous file | Status | Authoritative or retained destination |
|---|---|---|
| `docs/architecture.md` | Migrated/removed | Split across `system_docs/dashboards/README.md`, `hosted_dashboard.md`, `local_dashboard.md` and `station_snapshot.md`. |
| `docs/config.md` | Migrated/removed | Current configuration moved to `system_docs/dashboards/operations.md` and the relevant architecture files. |
| `docs/deployment.md` | Migrated/removed | Current hosted and local operations moved to `system_docs/dashboards/operations.md`; stale missing wrapper commands and ports were not retained. |
| `docs/geo_pcon_la_r2_shards.md` | Migrated/removed | Split across `system_docs/geography/boundary_shards.md`, `source_versions.md`, `operations.md` and `validation.md`. |
| `docs/postcode_lookup.md` | Migrated/removed | Split across `system_docs/geography/postcode_lookup.md`, `source_versions.md`, `operations.md` and `validation.md`; cache-purge behaviour was corrected to match the active uploader. |
| `docs/history-integrity.md` | Migrated/removed | Current v2 contract moved to `system_docs/r2_history/integrity.md`; the personal checkout path was removed from the system contract. |
| `docs/cloudflare-worker-account-deploy-audit.md` | Historical | Retained as `system_docs_legacy/reports/2026-05-19-cloudflare-worker-account-deploy-audit.md` with a current partly-resolved status note. |
| `docs/r2_first_aqi_migration_report_2026-07-14.md` | Historical | Retained as `system_docs_legacy/reports/2026-07-14-r2-first-aqi-pass-1.md`; stable current writer rules moved to `system_docs/r2_history/aqi_history_write_pipeline.md`. |

## Latest snapshot

| Current file | Status | Target action |
|---|---|---|
| `system_docs_legacy/uk-aq-latest-snapshot.md` | Historical | Current behaviour lives under `system_docs/latest_snapshot/`. Do not recreate a second editable authority. |
| `workers/uk_aq_latest_snapshot_cloud_run/README.md` | Active implementation guide | Retain locally. Its all-only products, warm-cache variables and run-report modes are aligned with the authoritative area. |
| `workers/uk_aq_latest_snapshot_cloud_run/local_r2_cache.ts` | Active implementation | Current focused helper for disposable ETag-validated local copies. Behaviour is governed by `system_docs/latest_snapshot/`. |
| `workers/uk_aq_latest_snapshot_r2_api_worker/README.md` | Active implementation guide | Retain locally. Its finite-window derivation summary is aligned with the authoritative area. |
| `system_docs/latest_snapshot/README.md` | Authoritative | Area ownership, physical/public matrix distinction, durable authority, warm cache, report policy, implementation status and reading order. |
| `system_docs/latest_snapshot/contract.md` | Authoritative | Latest-valid state, durable authority, local-cache validation, run-report modes, all-only products, finite derivation and compatibility rules. |
| `system_docs/latest_snapshot/data_flow.md` | Authoritative | End-to-end pipeline from Pub/Sub through durable R2/local-cache handling and physical products to derived public windows. |
| `system_docs/latest_snapshot/state_model.md` | Authoritative | State identity, eligibility, transitions, timestamp meanings and separation from transient local cache files. |
| `system_docs/latest_snapshot/interfaces.md` | Authoritative | Pub/Sub, state, local sidecar, physical R2 object, manifest, run-report and HTTP interfaces. |
| `system_docs/latest_snapshot/operations.md` | Authoritative | Runtime, configuration, warm-cache handling, report modes, schedule, deployment, rollback and monitoring. |
| `system_docs/latest_snapshot/recovery.md` | Authoritative | State repair, local-cache fault handling, report-policy rollback, physical-product regeneration and architecture rollback. |
| `system_docs/latest_snapshot/validation.md` | Authoritative | Minimal pre-deployment checks and real TEST acceptance for state, cache, reports and public output. |
| `system_docs/latest_snapshot/decisions/0001-latest-valid-observation-state.md` | Authoritative | Rationale and implementation status for consumer-side latest-valid state. |
| `system_docs/latest_snapshot/decisions/0002-finite-windows-from-all-snapshot.md` | Authoritative | Rationale for three physical `all` products and request-time finite responses. |
| `system_docs/latest_snapshot/decisions/0003-warm-local-cache-and-run-report-policy.md` | Authoritative | Rationale for ETag-validated `/tmp` copies and failures-by-default run reports. |

## Dashboards

| Current source | Status | Target action |
|---|---|---|
| `system_docs/dashboards/` | Authoritative | Hosted dashboard, local dashboard, station snapshot, data sources, operations and validation are current. |
| `system_docs_legacy/uk-aq-local-dashboard-setup.md` | Historical/superseded | Unique current details were incorporated into the dashboard area. Retain as legacy evidence until the wider legacy cleanup. |
| `workers/uk_aq_dashboard_online_api_worker/README.md` | Active implementation guide | Retain and keep aligned with the area contract. |

## Geography and postcode products

| Current source | Status | Target action |
|---|---|---|
| `system_docs/geography/` | Authoritative | Postcode lookup, boundary shards, source versions, operations and validation are current. |
| `system_docs_legacy/uk-aq-postcode-lookup-r2-api-worker.md` | Historical/superseded | Exact-route material is covered by the new area and Worker-local README. Retain as legacy evidence until wider cleanup. |
| `workers/uk_aq_postcode_lookup_r2_api_worker/README.md` | Active implementation guide | Retain and link to the authoritative area when next edited. |

## Prune, retention and observs operations

| Current file | Status | Target action |
|---|---|---|
| `system_docs_legacy/uk-aq-ingestdb-prune.md` | Pending detailed review; split planned | Move prune contract into `prune_and_retention/prune_daily.md`, backup gate into `history_backup_gate.md`, R2 write details into `r2_history/observations_write_pipeline.md`, and command-heavy recovery into runbooks. |
| `system_docs_legacy/uk-aq-observs-outbox-flush-service.md` | Pending review | Migrate to `observs_operations/outbox_contract.md`, `flush_service.md`, `failure_and_replay.md` and operations. |
| `system_docs_legacy/uk-aq-observs-partition-maintenance.md` | Pending review | Migrate to `observs_operations/partition_model.md`, `partition_maintenance.md` and `prune_and_retention/observs_retention.md`. |
| `system_docs_legacy/uk-aq-aqilevels-retention.md` | Pending review | Migrate to `prune_and_retention/aqilevels_retention.md` and link to the AQI history contract. |

## R2 history, backup and integrity

| Current file | Status | Target action |
|---|---|---|
| `system_docs/r2_history/contract.md` and binding companions | Authoritative | Stable v2 per-timeseries binding contract. |
| `system_docs/r2_history/integrity.md` | Authoritative | Current v2 hierarchy validation, repair planning, backup gate and repair execution contract. |
| `system_docs/r2_history/aqi_history_write_pipeline.md` | Authoritative | Current Phase B AQI v2 writer, targeted-index and completion-gate contract. |
| `system_docs_legacy/uk-aq-r2-history-layout.md` | Pending review; split planned | Migrate canonical keys to `r2_history/layout.md`, manifests to `manifests.md`, index rules to `indexes.md`, and domain-specific write/read behaviour to their owning files. |
| `system_docs_legacy/uk-aq-r2-history-dropbox-backup.md` | Pending review; split planned | Migrate backup behaviour to `backup_and_recovery/r2_dropbox_backup.md`, inventory details to `r2_inventory.md`, and restore details to `r2_restore.md`. |
| older legacy integrity files | Historical/superseded for completed rules | The current contract is `system_docs/r2_history/integrity.md`; retain only unique historical detail during later legacy cleanup. |
| `system_docs_legacy/uk-aq-r2-core-snapshot.md` | Pending review | Migrate to `r2_history/core_snapshots.md` and backup references to `backup_and_recovery/core_snapshot_backup.md`. |
| `system_docs_legacy/uk_aq_scripts.md` | Broad catalogue; split planned | Replace with a concise script index maintained by ownership area. Move each script's behaviour to its owning area and local README. |

## AQI and WHO

| Current file | Status | Target action |
|---|---|---|
| `system_docs/r2_history/aqi_history_write_pipeline.md` | Authoritative for Phase B history writes | Does not replace the future AQI formula, read API or WHO area contracts. |
| `system_docs_legacy/uk-aq-timeseries-aqi-hourly.md` | Historical or stale active reference | The current non-archive runtime path is absent. Review for decisions still used by the replacement architecture, then retain as retired implementation only. |
| WHO 2021 daily system documentation | Pending discovery/review | Create `aqi/who_2021_daily.md`, separating daily status from year-summary proposals. |
| AQI R2 API Worker documents | Pending review | Place public/read contract under `aqi/aqi_history.md` or a dedicated `aqi/read_api.md`, with one authoritative home only. |

## Cache proxy

| Current file | Status | Target action |
|---|---|---|
| `system_docs_legacy/uk-aq-cache-proxy.md` | Pending detailed review; split planned | Migrate to `cache_proxy/contract.md`, `routes.md`, `caching.md`, `sessions.md`, `errors.md`, `operations.md` and `validation.md`. Area-specific upstream contracts stay in their own areas. |
| `workers/uk_aq_cache_proxy/README.md` if present | Pending review | Retain as local implementation guide and link to the authoritative cache-proxy area. |

## Monitoring and scheduling

| Current source | Status | Target action |
|---|---|---|
| DB size logger documentation | Pending discovery/review | Migrate to `monitoring/db_size_logger.md`. |
| DB/R2 metrics API documentation | Pending discovery/review | Migrate current behaviour to `monitoring/db_r2_metrics_api.md`; the dated 2026-05-19 audit is historical evidence only. |
| daily task health documentation | Pending discovery/review | Migrate shared record contract to `shared/task_health_contract.md` and operational interpretation to `monitoring/daily_task_health.md`. |
| `.github/workflows/*.yml` schedule descriptions in root README and legacy docs | Conflicting and partly stale | Build `scheduling/schedule_matrix.md` from current workflows, Cloud Scheduler configuration and Cloudflare scheduler config. Each task must have one named active scheduler. |
| `cloudflare/scheduler/` local documentation | Pending review | Migrate stable behaviour to `scheduling/cloudflare_scheduler.md`; keep implementation details local. |

## Shared modules

| Current source | Status | Target action |
|---|---|---|
| `workers/shared/r2_sigv4.mjs` | Active shared runtime | Document cross-area timeout, signing and error contract in `shared/r2_access.md`. |
| `workers/shared/uk_aq_r2_history_index.mjs` | Active load-bearing runtime | Put product semantics in `r2_history/indexes.md` and reusable API expectations in `shared/r2_history_indexes.md`. Preserve byte-stability rules. |
| `workers/shared/uk_aq_observation_property_code.mjs` | Active shared runtime | Document code-normalisation ownership in `shared/observed_property_codes.md`. |
| `workers/shared/daily_task_health.mjs` | Active shared runtime | Document record shape in `shared/task_health_contract.md`. |

## Recommended migration order

1. Latest snapshot, completed and current.
2. Dashboards and geography, completed and current.
3. Architecture and shared data semantics.
4. Remaining R2 history layout, manifests and indexes.
5. Prune daily and deletion gates.
6. Observs outbox and partition operations.
7. Active AQI and WHO architecture, explicitly separating retired services.
8. Cache proxy.
9. Backup and recovery.
10. Scheduling and task health.
11. Monitoring.
12. Root README and local README cleanup after all active areas have authoritative homes.

## Safety rule

Do not mass-move or remove legacy documentation before the owning area has been analysed.

For each migration:

1. inspect current runtime code and workflows;
2. inspect existing checks and current documents;
3. identify contradictions and retired references;
4. write the authoritative area files;
5. preserve dated reports or unique historical evidence where required;
6. remove the previous active path only after review;
7. update this inventory and `system_docs/README.md`.
