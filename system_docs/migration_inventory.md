# System documentation migration inventory

## Purpose

This file records the migration status of existing UK AQ Ops documentation into the authoritative area structure.

A document is not deleted or redirected until its current content has been reviewed and every still-valid rule has an authoritative home.

## Status meanings

- **Authoritative**: current source of truth.
- **Pending review**: still active until migrated.
- **Split planned**: current content belongs in more than one target file.
- **Redirect planned**: content has been migrated and the old path can become a short pointer.
- **Migrated/removed**: current content has an authoritative home and the previous active path no longer exists.
- **Historical**: documents retired behaviour and should move to or remain in `archive/`.
- **Stale active reference**: current documentation names a runtime path that is no longer active.

## Repository-level files

| Current file | Status | Target action |
|---|---|---|
| `README.md` | Stale active references confirmed | Rewrite later as a concise repository entry point. Remove retired Timeseries AQI Hourly and Backfill Cloud Run instructions. Link to `system_docs/README.md`. |
| `AGENTS.md` | Active agent rules | Retain. Add a link to `system_docs/README.md` when the documentation framework is approved. Do not duplicate area contracts. |
| `README_CROSS_REPO.md` | Pending review | Move stable repository ownership and boundary rules into `architecture/cross_repo_dependencies.md`; retain only a concise orientation if still useful. |
| `package.json` | Runtime inventory evidence, not documentation authority | Continue using it to confirm active entrypoints and checks. Do not copy its script list as a second behavioural contract. |

## New framework files

| File | Status | Notes |
|---|---|---|
| `system_docs/README.md` | Authoritative | Master index and reading order. |
| `system_docs/documentation_contract.md` | Authoritative | Documentation maintenance and coding-agent protocol. |
| `system_docs/repository_documentation_map.md` | Authoritative migration design | Defines the target area/file structure. |
| `system_docs/migration_inventory.md` | Authoritative migration tracker | This file. |

## Latest snapshot

| Current file | Status | Target action |
|---|---|---|
| `system_docs/uk-aq-latest-snapshot.md` | Migrated/removed | Current behaviour now lives under `system_docs/latest_snapshot/`. Do not recreate a second editable authority at the old path. |
| `workers/uk_aq_latest_snapshot_cloud_run/README.md` | Active implementation guide | Retain locally. Its all-only physical-product summary is aligned with the authoritative area. |
| `workers/uk_aq_latest_snapshot_r2_api_worker/README.md` | Active implementation guide | Retain locally. Its finite-window derivation summary is aligned with the authoritative area. |
| `system_docs/latest_snapshot/README.md` | Authoritative | Area ownership, physical/public matrix distinction, implementation status and reading order. |
| `system_docs/latest_snapshot/contract.md` | Authoritative | Latest-valid state, all-only physical products, finite derivation, cache identity and compatibility rules. |
| `system_docs/latest_snapshot/data_flow.md` | Authoritative | End-to-end pipeline from Pub/Sub through physical R2 products to derived public windows. |
| `system_docs/latest_snapshot/state_model.md` | Authoritative | State identity, eligibility, transitions and timestamp meanings. |
| `system_docs/latest_snapshot/interfaces.md` | Authoritative | Pub/Sub, state, physical R2 object, manifest and HTTP interfaces. |
| `system_docs/latest_snapshot/operations.md` | Authoritative | Runtime, configuration, schedule, deployment order, rollback and monitoring. |
| `system_docs/latest_snapshot/recovery.md` | Authoritative | State repair, physical-product regeneration and rollback. |
| `system_docs/latest_snapshot/validation.md` | Authoritative | Minimal pre-deployment checks and real TEST operational acceptance. |
| `system_docs/latest_snapshot/decisions/0001-latest-valid-observation-state.md` | Authoritative | Rationale and implementation status for consumer-side latest-valid state. |
| `system_docs/latest_snapshot/decisions/0002-finite-windows-from-all-snapshot.md` | Authoritative | Rationale for three physical `all` products and request-time finite responses. |

## Prune, retention and observs operations

| Current file | Status | Target action |
|---|---|---|
| `system_docs/uk-aq-ingestdb-prune.md` | Pending detailed review; split planned | Move prune contract into `prune_and_retention/prune_daily.md`, backup gate into `history_backup_gate.md`, R2 write details into `r2_history/observations_write_pipeline.md`, and command-heavy recovery into runbooks. |
| `system_docs/uk-aq-observs-outbox-flush-service.md` | Pending review | Migrate to `observs_operations/outbox_contract.md`, `flush_service.md`, `failure_and_replay.md` and operations. |
| `system_docs/uk-aq-observs-partition-maintenance.md` | Pending review | Migrate to `observs_operations/partition_model.md`, `partition_maintenance.md` and `prune_and_retention/observs_retention.md`. |
| `system_docs/uk-aq-aqilevels-retention.md` | Pending review | Migrate to `prune_and_retention/aqilevels_retention.md` and link to the AQI history contract. |

## R2 history, backup and integrity

| Current file | Status | Target action |
|---|---|---|
| `system_docs/uk-aq-r2-history-layout.md` | Pending review; split planned | Migrate canonical keys to `r2_history/layout.md`, manifests to `manifests.md`, index rules to `indexes.md`, and domain-specific write/read behaviour to their owning files. |
| `system_docs/uk-aq-r2-history-dropbox-backup.md` | Pending review; split planned | Migrate backup behaviour to `backup_and_recovery/r2_dropbox_backup.md`, inventory details to `r2_inventory.md`, and restore details to `r2_restore.md`. |
| `system_docs/uk-aq-r2-history-integrity.md` or equivalent current integrity files | Pending discovery/review | Migrate behavioural evidence rules to `r2_history/integrity.md`; move command procedures to runbooks. |
| `system_docs/uk-aq-r2-core-snapshot.md` | Pending review | Migrate to `r2_history/core_snapshots.md` and backup references to `backup_and_recovery/core_snapshot_backup.md`. |
| `system_docs/uk_aq_scripts.md` | Broad catalogue; split planned | Replace with a concise script index generated or maintained by ownership area. Move each script's behaviour to its owning area and local README. Avoid one giant behavioural catalogue. |

## AQI and WHO

| Current file | Status | Target action |
|---|---|---|
| `system_docs/uk-aq-timeseries-aqi-hourly.md` | Historical or stale active reference | The current non-archive runtime path is absent. Review for decisions still used by the replacement architecture, then archive as retired implementation. Do not present its service as active. |
| `system_docs/uk-aq-backfill-cloud-run.md` | Historical or stale active reference | The current non-archive runtime path is absent. Preserve useful recovery history, but move current rebuild behaviour to the active AQI/R2 history areas. |
| WHO 2021 daily system documentation | Pending discovery/review | Create `aqi/who_2021_daily.md`, separating daily status from year summary proposals. |
| AQI R2 API worker documents | Pending review | Place public/read contract under `aqi/aqi_history.md` or a dedicated `aqi/read_api.md`, with one authoritative home only. |

## Cache proxy

| Current file | Status | Target action |
|---|---|---|
| `system_docs/uk-aq-cache-proxy.md` | Pending detailed review; split planned | Migrate to `cache_proxy/contract.md`, `routes.md`, `caching.md`, `sessions.md`, `errors.md`, `operations.md` and `validation.md`. Area-specific upstream contracts stay in their own areas. |
| `workers/uk_aq_cache_proxy/README.md` if present | Pending review | Retain as local implementation guide and link to the authoritative cache-proxy area. |

## Monitoring and dashboards

| Current file | Status | Target action |
|---|---|---|
| DB size logger documentation | Pending discovery/review | Migrate to `monitoring/db_size_logger.md`. |
| DB/R2 metrics API documentation | Pending discovery/review | Migrate to `monitoring/db_r2_metrics_api.md`. |
| daily task health documentation | Pending discovery/review | Migrate shared record contract to `shared/task_health_contract.md` and operational interpretation to `monitoring/daily_task_health.md`. |
| dashboard and station snapshot documentation | Pending review | Split into `dashboards/hosted_dashboard.md`, `local_dashboard.md`, `station_snapshot.md` and `data_sources.md`. Keep retired Cloud Run dashboard paths archive-only. |

## Scheduling

| Current source | Status | Target action |
|---|---|---|
| `.github/workflows/*.yml` descriptions in root README and flat docs | Conflicting and partly stale | Build `scheduling/schedule_matrix.md` from current workflows, Cloud Scheduler configuration and Cloudflare scheduler config. Each task must have one named active scheduler. |
| `cloudflare/scheduler/` local documentation | Pending review | Migrate stable behaviour to `scheduling/cloudflare_scheduler.md`; keep implementation details local. |

## Geography and postcode products

| Current source | Status | Target action |
|---|---|---|
| Postcode scripts and worker READMEs | Pending review | Create `geography/postcode_lookup.md`, `source_versions.md`, `operations.md` and `validation.md`. |
| Geography shard scripts and notes | Pending review | Create `geography/boundary_shards.md`, `source_versions.md`, `operations.md` and `validation.md`. |

## Shared modules

| Current source | Status | Target action |
|---|---|---|
| `workers/shared/r2_sigv4.mjs` | Active shared runtime | Document cross-area timeout, signing and error contract in `shared/r2_access.md`. |
| `workers/shared/uk_aq_r2_history_index.mjs` | Active load-bearing runtime | Put product semantics in `r2_history/indexes.md` and reusable API expectations in `shared/r2_history_indexes.md`. Preserve byte-stability rules. |
| `workers/shared/uk_aq_observation_property_code.mjs` | Active shared runtime | Document code normalisation ownership in `shared/observed_property_codes.md`. |
| `workers/shared/daily_task_health.mjs` | Active shared runtime | Document record shape in `shared/task_health_contract.md`. |

## Recommended migration order

1. Latest snapshot, completed and current.
2. Architecture and shared data semantics.
3. R2 history layout, manifests and indexes.
4. Prune daily and deletion gates.
5. Observs outbox and partition operations.
6. Active AQI and WHO architecture, explicitly separating retired services.
7. Cache proxy.
8. Backup and recovery.
9. Scheduling and task health.
10. Monitoring and dashboards.
11. Geography and postcode products.
12. Root README and local README cleanup after all active areas have authoritative homes.

## Safety rule

Do not mass-move or remove flat documentation before the owning area has been analysed.

For each migration:

1. inspect current runtime code and workflows;
2. inspect existing tests and current documents;
3. identify contradictions and retired references;
4. write the authoritative area files;
5. archive the previous document when required;
6. replace the old path with a redirect only after review;
7. update this inventory and `system_docs/README.md`.