# UK AQ Ops repository documentation map

## Purpose

This document defines the target authoritative documentation structure for the active `uk-aq-ops` repository.

It is an architecture and migration map. Individual area contracts become authoritative only when their area directory is completed and listed as authoritative in `system_docs/README.md`.

## Analysis basis

The initial map was derived from:

- active entrypoints and checks in `package.json`;
- current worker and workflow paths;
- the root `README.md`;
- `AGENTS.md`;
- existing flat files under `system_docs/`;
- recent archive and retirement history;
- direct inspection of the latest-snapshot implementation.

Before migrating any later area, its current code, workflows, tests and existing documents must still be inspected in detail.

## Important current finding

The root README contains retired runtime references.

It still describes these as active:

- `workers/uk_aq_timeseries_aqi_hourly_cloud_run/`;
- `workers/uk_aq_backfill_cloud_run/`;
- their related local-run and workflow instructions.

The current non-archive runtime paths are absent. They must not be used as active documentation sources.

This confirms the need for an authoritative active-system index separate from historical plans and archives.

## Target top-level structure

```text
system_docs/
  README.md
  documentation_contract.md
  repository_documentation_map.md
  migration_inventory.md

  architecture/
  latest_snapshot/
  r2_history/
  prune_and_retention/
  observs_operations/
  aqi/
  cache_proxy/
  backup_and_recovery/
  scheduling/
  monitoring/
  dashboards/
  geography/
  shared/
```

Command-heavy procedures may later move to a root `runbooks/` directory. Area `operations.md` files should explain operational behaviour and link to those runbooks rather than duplicating long command sequences.

Plans remain under `plans/`. Retired material remains under `archive/`.

## 1. Architecture

Target directory:

```text
system_docs/architecture/
```

### `README.md`

Repository architecture overview and reading order.

Must identify:

- active system areas;
- which repository owns each responsibility;
- active versus retired components;
- authoritative cross-area documents.

### `repository_scope.md`

Defines what belongs in ops rather than ingest, schema or website repositories.

Must cover:

- Cloud Run operational services;
- Cloudflare Workers owned by ops;
- R2 operational products;
- backup, retention, repair and monitoring;
- canonical SQL ownership in the schema repository;
- boundaries with connector ingestion and website presentation.

### `system_boundaries.md`

Defines component and data-product boundaries.

Must distinguish:

- raw observations;
- current values;
- AQI and WHO derived products;
- R2 history;
- public APIs;
- operational metrics;
- local dashboards.

### `data_semantics.md`

Defines shared meanings used by more than one area, including:

- `observed_at`;
- latest received observation;
- latest valid value;
- `last_value_at`;
- UTC day versus Europe/London operational day;
- raw versus derived data;
- connector and timeseries identity.

Area-specific rules must link here rather than redefining shared terms inconsistently.

### `environments.md`

Defines TEST and LIVE separation, deployment naming, R2 bucket selection and environment-variable ownership.

It must preserve the rule that LIVE is not changed unless explicitly requested.

### `cross_repo_dependencies.md`

Maps required dependencies on:

- `uk-aq-ingest`;
- `uk-aq-schema`;
- website repository;
- Cloudflare, GCP, Supabase, R2 and Dropbox resources.

### `decisions/`

Repository-level decisions only. Area-specific decisions stay in their area.

## 2. Latest snapshot

Target directory:

```text
system_docs/latest_snapshot/
```

This area has been created first.

Files:

- `README.md`: ownership, reading order and current defect;
- `contract.md`: latest-valid state and public compatibility invariants;
- `data_flow.md`: Pub/Sub to state to R2 API to website;
- `state_model.md`: identity, eligibility and transition rules;
- `interfaces.md`: message, state, object and HTTP shapes;
- `operations.md`: schedule, runtime and monitoring;
- `recovery.md`: poisoned-state repair and rollback;
- `validation.md`: focused checks and TEST acceptance;
- `decisions/0001-latest-valid-observation-state.md`.

The old flat `system_docs/uk-aq-latest-snapshot.md` should be archived and replaced by a short redirect after review.

## 3. R2 history

Target directory:

```text
system_docs/r2_history/
```

### `README.md`

Area overview covering observations, AQI-level history, core snapshots, indexes and read APIs.

### `contract.md`

Shared R2 history invariants:

- committed manifest authority;
- immutable committed parts where applicable;
- raw versus derived domains;
- version selection;
- no archive fallback;
- deterministic and byte-stable index behaviour.

### `layout.md`

Canonical key layout for:

- `history/v2/core`;
- `history/v2/observations`;
- AQI-level hourly data;
- manifests;
- staging and operational prefixes;
- indexes.

This file should absorb the authoritative parts of `system_docs/uk-aq-r2-history-layout.md`.

### `observations_write_pipeline.md`

Documents how prune Phase B or successor processes produce committed observation history.

### `aqi_history_write_pipeline.md`

Documents the active AQI-level history writer only. Retired hourly services must be clearly historical.

### `manifests.md`

Defines connector manifests, day manifests, commit meaning, hashes, row counts and adoption rules.

### `indexes.md`

Defines index families, build inputs, latest pointers and byte-stability requirements.

Must incorporate the load-bearing rules currently in `AGENTS.md`.

### `core_snapshots.md`

Documents core metadata snapshot production, required tables, cadence and consumers.

### `observations_read_api.md`

Owns the contract for `workers/uk_aq_observs_history_r2_api_worker/`.

### `aqi_read_api.md`

May instead live under `aqi/` if the AQI area is judged the clearer authority. It must have one home only.

### `integrity.md`

Defines integrity checks, expected evidence and the difference between warnings, repairable defects and blocking failures.

### `operations.md`, `recovery.md`, `validation.md`

Normal operation, rebuild and TEST validation.

### `decisions/`

R2 versioning, pollutant partitioning, manifest authority and index stability decisions.

## 4. Prune and retention

Target directory:

```text
system_docs/prune_and_retention/
```

### `README.md`

Overview of deletion safety across ingest and Obs AQI databases.

### `prune_daily.md`

Owns `workers/uk_aq_prune_daily/` and documents:

- Phase A parity and repair;
- Phase B history export;
- delete gating;
- batch and runtime bounds;
- dry-run semantics.

This should absorb current authoritative material from `system_docs/uk-aq-ingestdb-prune.md`.

### `history_backup_gate.md`

Defines exactly what evidence is required before source deletion.

### `observs_retention.md`

Documents retention through partition maintenance and committed-history checks.

### `aqilevels_retention.md`

Owns `workers/uk_aq_aqilevels_retention_service/` and replaces the flat retention document.

### `staging_cleanup.md`

Defines safe cleanup of incomplete or expired staging objects.

### `operations.md`, `recovery.md`, `validation.md`

Normal schedules, blocked deletion diagnosis, repair and TEST checks.

## 5. Observs operations

Target directory:

```text
system_docs/observs_operations/
```

### `README.md`

Overview of ingest outbox delivery and Obs AQI database maintenance.

### `outbox_contract.md`

Defines claim, delivery, receipt, retry and resolution semantics.

### `flush_service.md`

Owns `workers/uk_aq_observs_outbox_flush_service/` and replaces the flat service document.

### `partition_model.md`

Defines daily partitions, default partition, hot/cold index policy and parent-table expectations.

### `partition_maintenance.md`

Owns `workers/uk_aq_observs_partition_maintenance_service/`.

### `failure_and_replay.md`

Defines partial delivery, duplicate safety, replay and recovery.

### `operations.md` and `validation.md`

Schedules, monitoring and TEST checks.

## 6. AQI and WHO derived products

Target directory:

```text
system_docs/aqi/
```

### `README.md`

Active AQI and WHO component map, with retired services explicitly excluded.

### `contract.md`

Defines raw pollutant eligibility, hourly inputs and separation from source-provided index observations.

### `pollutant_eligibility.md`

One authoritative definition for which pollutant values may enter calculations.

This is distinct from retaining raw source observations.

### `hourly_generation.md`

Documents the active hourly AQI generation path only. If generation has moved to proxy-time or database RPCs, that must replace retired Cloud Run descriptions.

### `rolling_calculations.md`

Defines rolling 24-hour PM behaviour and any other rolling products.

### `aqi_history.md`

Defines AQI-level R2 history production and read behaviour.

### `who_2021_daily.md`

Owns the active WHO daily service and its table/RPC outputs.

### `year_summaries.md`

Future or active calendar-year, rolling-year and year-to-date products, separated from daily logic.

### `retention.md`, `recovery.md`, `validation.md`

Derived-data lifecycle and repair.

### `decisions/`

Index calculation and source-versus-calculated AQI decisions.

## 7. Cache proxy

Target directory:

```text
system_docs/cache_proxy/
```

### `README.md`

Proxy purpose and upstream ownership map.

### `contract.md`

Authentication, session, fail-closed and response-preservation rules.

### `routes.md`

One table of external routes, upstreams and owning system areas.

### `caching.md`

Cache keys, TTL classes, stale behaviour, bypass controls and cost-sensitive invariants.

### `sessions.md`

Session start/end and access controls.

### `errors.md`

Stable public errors and upstream contract mismatch behaviour.

### `operations.md` and `validation.md`

Deployment ordering, diagnostics and cache-hit validation.

This area should absorb `system_docs/uk-aq-cache-proxy.md` after detailed review.

## 8. Backup and recovery

Target directory:

```text
system_docs/backup_and_recovery/
```

### `README.md`

Backup products, authorities and restore order.

### `r2_dropbox_backup.md`

Manifest-aware R2 history backup and checkpoints.

### `r2_inventory.md`

Inventory generation, etag skipping and byte-stability dependencies.

### `r2_restore.md`

Restore sequencing, verification and non-overwrite rules.

### `supabase_db_dump.md`

Owns `workers/uk_aq_supabase_db_dump_backup_service/`.

### `core_snapshot_backup.md`

Clarifies whether core snapshots are primary data products, backup inputs or both.

### `disaster_recovery.md`

Cross-system restore order and authority.

### `validation.md`

Evidence required before a backup is considered usable.

## 9. Scheduling

Target directory:

```text
system_docs/scheduling/
```

### `README.md`

Authoritative schedule ownership map.

### `cloudflare_scheduler.md`

Owns `cloudflare/scheduler/` and its configuration sync.

### `gcp_scheduler.md`

Cloud Run scheduler jobs, invocation identity and attempt deadlines.

### `github_actions.md`

Workflow-triggered recurring and manual operations.

### `schedule_matrix.md`

One current table containing:

- task;
- active scheduler;
- cadence;
- timezone;
- target;
- owner;
- fallback or paused status.

This prevents the same task being documented as scheduled by both an active and retired mechanism.

### `operations.md` and `validation.md`

Sync, drift detection and TEST validation.

## 10. Monitoring

Target directory:

```text
system_docs/monitoring/
```

### `README.md`

Operational signal and dashboard map.

### `daily_task_health.md`

Owns the shared daily task health contract and active producers/consumers.

### `db_size_logger.md`

Owns `workers/uk_aq_db_size_logger_cloud_run/`.

### `db_r2_metrics_api.md`

Owns the active database and R2 metrics API Worker.

### `alerts_and_failures.md`

Defines which conditions are warnings, partial successes or failures.

### `operations.md` and `validation.md`

Expected cadence, retention and dashboard checks.

## 11. Dashboards

Target directory:

```text
system_docs/dashboards/
```

### `README.md`

Hosted and local dashboard architecture.

### `hosted_dashboard.md`

Static front end and hosted API Worker.

### `local_dashboard.md`

Local server and launch scripts.

### `station_snapshot.md`

Station snapshot front end, API and compatibility behaviour.

### `data_sources.md`

Authoritative source for every displayed panel and freshness field.

### `operations.md` and `validation.md`

Local startup, hosted deployment and data checks.

Retired dashboard Cloud Run and older worker paths remain archive-only.

## 12. Geography and postcodes

Target directory:

```text
system_docs/geography/
```

### `README.md`

Geography product and consumer map.

### `postcode_lookup.md`

Build, upload and R2 API contract for postcode lookup.

### `boundary_shards.md`

PCON and LA lookup shard structure and versioning.

### `source_versions.md`

ONSPD and boundary source versions, compatibility and update policy.

### `validation.md`

Hex-map and station lookup validation.

### `operations.md`

Rebuild and upload sequence.

## 13. Shared components

Target directory:

```text
system_docs/shared/
```

### `README.md`

Shared module ownership and consumers.

### `r2_access.md`

Owns the shared SigV4 and timeout behaviour.

### `r2_history_version.md`

Version parsing, deprecated-variable rejection and default selection.

### `r2_history_indexes.md`

Shared index builder API, with the detailed product contract linked from `r2_history/indexes.md`.

### `observed_property_codes.md`

Canonical code normalisation and mapping responsibilities.

### `task_health_contract.md`

Shared task-health record format.

### `logging_and_errors.md`

Structured event naming, partial-success reporting and safe error details.

Shared documentation must describe only truly cross-area behaviour. Area rules must not be moved here merely to reduce file count.

## Documents outside `system_docs`

### Root `README.md`

Should become a concise repository entry point containing:

- repository purpose;
- active component summary generated from the authoritative index;
- local setup links;
- link to `system_docs/README.md`;
- no long duplicated service contracts;
- no retired runtime instructions.

### `AGENTS.md`

Should retain coding-agent operating rules and link to `system_docs/README.md` as the behavioural authority.

It should not duplicate each area's contract.

### Worker-local READMEs

Should contain:

- local implementation orientation;
- development entrypoint;
- local environment details;
- link to the authoritative area contract.

### `plans/`

Future work only. Plans must not be cited as current runtime behaviour after implementation.

### `archive/`

Historical reference only. Active docs must not instruct runtime code to use archive paths.

## Migration rule

Each flat existing system document must be reviewed line by line before migration and assigned one of:

- retain temporarily;
- split into area files;
- merge into an existing authoritative file;
- convert to a runbook;
- archive as historical;
- replace with a redirect;
- remove only after all current content has an authoritative home.

The detailed per-file result is recorded in `migration_inventory.md` as each area is analysed.
