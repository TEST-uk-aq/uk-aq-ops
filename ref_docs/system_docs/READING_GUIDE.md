# UK AQ cross-area reading guide

## Purpose

Use this guide only when a task crosses a known system boundary or when an area `README.md` explicitly points here.

For a normal bounded task, begin with [`SYSTEM_OVERVIEW.md`](SYSTEM_OVERVIEW.md) and the primary area's own `README.md`. The area README selects the smallest current contract set. Do not replace that selective route with an older fixed reading chain from this guide.

This file is routing only. Linked contracts remain the behavioural authority.

## Public website UI and station charts

For public page shell, navigation, mobile/responsive layout or page-level presentation, start with [`website_ui/README.md`](website_ui/README.md) and follow the route for the affected component.

Add [`station_charts/README.md`](station_charts/README.md) only when the task enters shared station-chart behaviour rather than the surrounding page.

## Public website deployment and UI

For Pages artefact construction, content hashing or browser asset identity, start with [`website_deployment/README.md`](website_deployment/README.md).

Add [`website_ui/README.md`](website_ui/README.md) only when deployment work also changes public page structure or presentation. HTML/Cloudflare cache-policy changes require their own explicit contract decision rather than being inferred from asset hashing.

## Supabase egress monitoring and dashboards

For application-side Supabase egress measurement, naming, aggregation or persistence, start with [`monitoring/README.md`](monitoring/README.md) and follow its collector/instrumentation route.

When the administrative egress panel is also in scope, add:

- [`monitoring/egress_dashboard_contract.md`](monitoring/egress_dashboard_contract.md)
- [`dashboards/README.md`](dashboards/README.md)

Monitoring owns measurement and attribution semantics. Dashboards own dashboard delivery and integration. Do not load monitoring interfaces, data flow, operations and validation unless the selected monitoring route actually requires them.

## Shared schema and database promotion

For Supabase/PostgreSQL database objects, RPC signatures, canonical schema files, existing-database migrations or runtime code that depends on a changed database contract, start with:

1. [`schema-repository-structure-contract.md`](schema-repository-structure-contract.md)
2. [`schema-source-contract.md`](schema-source-contract.md)
3. the relevant canonical owner file under `uk-aq-schema/schemas/`
4. the relevant existing-database migration under `uk-aq-schema/schemas/migrations/` when the target database already exists.

Use [`shared-schema-repo.md`](shared-schema-repo.md) when repository-wide schema context is genuinely needed rather than as a default extra read.

`uk-aq-schema/schemas/migrations/` is the sole active migration root. Material under `pending_existing_db_upgrades/` requires a separate environment-specific decision before execution. Repository synchronisation promotes source only; it does not apply database migrations.

Pre-deployment checks remain structural and narrowly targeted. Functional acceptance occurs through real TEST operation after deployment.

## Local MySQL plus a domain owner

For MacBook Pro local-MySQL naming, TEST/LIVE isolation, permissions or instance-wide source-of-truth rules, start with [`local_mysql/README.md`](local_mysql/README.md).

Add the domain owner's active contract only when defining what that domain stores, how it refreshes, or whether its local state is derived or authoritative. Do not treat local MySQL as a second authority for data owned by Supabase, BigQuery, R2 or another subsystem unless a narrower domain contract explicitly changes that ownership.

## WHO 2021 and public summary delivery

For WHO calculation, readiness, daily correction, rolling/calendar products or WHO source selection, start with [`who_2021/README.md`](who_2021/README.md) and follow its task route.

Add [`cache_proxy/who-summary-contract.md`](cache_proxy/who-summary-contract.md) only when the public WHO-summary route, authenticated history-reader boundary, cache behaviour or browser fallback is also in scope.

Do not automatically load WHO interfaces and operations for calculation-only work.

## R2 history, Integrity and station history

Start with [`r2_history/README.md`](r2_history/README.md). It owns task-specific routing for:

- canonical observation history and index v3;
- stable timeseries binding and continuity;
- current History Integrity and SOS historical repair;
- Prune Daily Phase B history publication and deletion safety;
- current-state reconciliation.

When station-history AQI is in scope, add the relevant route from [`aqi-levels/README.md`](aqi-levels/README.md). When browser chart behaviour is in scope, add [`station_charts/README.md`](station_charts/README.md).

When R2 history Dropbox inventory/checkpoint or restore behaviour is in scope, add [`backup_and_recovery/README.md`](backup_and_recovery/README.md) and follow its R2-backup route.

Do not preload every R2-history contract for an R2 task.

## History Integrity dry-run reporting and dashboard presentation

For v2/v3 History Integrity dry-run result semantics, start with [`r2_history/integrity_dry_run_reporting_contract.md`](r2_history/integrity_dry_run_reporting_contract.md).

When the Operations dashboard Daily Tasks presentation is also in scope, add [`dashboards/history_integrity_dry_run_status_contract.md`](dashboards/history_integrity_dry_run_status_contract.md).

R2 history owns execution, proposed-state and live-state semantics. Dashboards own the `FINISHED`/`FAILED` plus independent `DRY RUN` presentation. The dashboard must not infer data-health semantics independently.

## Connector ingest plus historical repair

For connector ingestion, discovery or current acquisition behaviour, start with [`ingest/README.md`](ingest/README.md).

Add [`r2_history/README.md`](r2_history/README.md) only when the task also changes historical source evidence, Integrity repair, Prune Daily publication, timeseries reconciliation or R2 history behaviour.

For SOS, use the SOS-specific routes selected by those two area READMEs rather than loading every ingest and Integrity contract.

## Latest Snapshot plus Integrity reconciliation

For normal Latest Snapshot production or consumers, start with [`latest_snapshot/README.md`](latest_snapshot/README.md).

For a historical repair that may alter current timeseries freshness, begin with the relevant current-Integrity route in [`r2_history/README.md`](r2_history/README.md) and add the Latest Snapshot reconciliation document named by that route.

## Current Integrity versus future Integrity Factory

Current `uk-aq-history-integrity` detection, repair, SOS-light and reconciliation behaviour is routed through [`r2_history/README.md`](r2_history/README.md).

Use [`integrity_factory/README.md`](integrity_factory/README.md) only for the agreed future dedicated Factory architecture. The Factory contract is future implementation authority and does not supersede current History Integrity by implication.

## Backup and recovery

For R2 history Dropbox backup, Supabase logical backup or restore/recovery behaviour, start with [`backup_and_recovery/README.md`](backup_and_recovery/README.md).

Add the producing system's area contract only when the task changes the producer/backup boundary rather than backup operation alone.

## Drafts and proposed systems

Files under [`plans/drafts/`](../plans/drafts/) are non-authoritative and are not part of normal coding-agent reading.

Read a draft only when the user explicitly names it for review, promotion or implementation. Accepted draft-only behaviour must be promoted into the appropriate active contract before it can constrain current implementation.

## Legacy and archive material

`system_docs_legacy/`, archive paths and historical plans are not normal reading sources and must not override active current-runtime or explicitly labelled future implementation contracts.

Inspect historical material only when the task specifically requires provenance, migration history or recovery of a superseded decision.
