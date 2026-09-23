# Dashboards

## Scope

This area is authoritative for the UK AQ Ops administrative dashboard estate:

- hosted dashboard: Cloudflare Pages plus the dashboard API Worker;
- local dashboard: the shared front end plus the Mac Python compatibility backend;
- Station Snapshot: separate front end and API route family within the same estate;
- Media editorial/admin: one Media page with internal Articles, AI Titles, Runs and Sources mini-pages.

Hosted and local delivery MUST preserve the shared `/api/*` compatibility contract unless an intentional contract change is documented here.

The local and hosted dashboards deliberately use different acceleration paths. The local MacBook Pro-hosted dashboard may use a persistent local MySQL read/cache layer; the hosted Cloudflare dashboard continues to use its cloud/API adapters and edge caching. Both MUST preserve the same authority rules and history-generation semantics.

Media is a specific exception where normal editorial/admin reads and all mutations remain authoritative in Media D1 through authenticated `media-admin`; a local/MySQL Media mirror is not required for the normal editorial page. See the Media dashboard contract.

## Task routes

Read only the route needed for the task.

- **Shared local/hosted architecture boundary:** [`architecture_contract.md`](architecture_contract.md).
- **Media editorial/admin page, Articles/AI Titles/Runs/Sources, filters/sorts, source/author-rule editing and Add Source:** [`media_dashboard_contract.md`](media_dashboard_contract.md), together with the applicable contracts under [`../media/`](../media/).
- **Media article preview/editor presentation, removal of the global Desktop/Carousel/Mobile selector and the exact 360px homepage-mobile title-fit preview:** [`media_dashboard_article_preview_contract.md`](media_dashboard_article_preview_contract.md), together with [`media_dashboard_contract.md`](media_dashboard_contract.md).
- **Current Media dashboard corrections for manual Approved -> Bluesky opt-in exposure, bulk Approved eligibility/idempotency, source-specific default-image presentation and `DD/MM/YYYY` card dates:** [`media_dashboard_bluesky_preview_corrections_contract.md`](media_dashboard_bluesky_preview_corrections_contract.md), together with the applicable Media Bluesky/preview/source contracts.
- **R2 history-generation authority and automatic v2/v3 selection:** [`../r2_history/generation_descriptor_contract.md`](../r2_history/generation_descriptor_contract.md).
- **History Integrity v2/v3 dry-run task status, `FINISHED`/`FAILED` plus the independent `DRY RUN` pill:** [`history_integrity_dry_run_status_contract.md`](history_integrity_dry_run_status_contract.md), together with [`../r2_history/integrity_dry_run_reporting_contract.md`](../r2_history/integrity_dry_run_reporting_contract.md) for backend semantics.
- **Finished daily-task runs carrying structured warnings, including Daily Stations SOS isolation, and the additive yellow `WARNING` pill:** [`daily_task_warning_status_contract.md`](daily_task_warning_status_contract.md). Producer-specific permission and warning content remain owned by the relevant producer contract.
- **Local MySQL dashboard cache/read model:** [`local_mysql_cache.md`](local_mysql_cache.md), together with [`../local_mysql/contract.md`](../local_mysql/contract.md) for the cross-cutting MacBook Pro MySQL rules.
- **Hosted architecture, Worker/direct/upstream mode or trust boundary:** [`hosted_dashboard.md`](hosted_dashboard.md). Add [`data_sources.md`](data_sources.md) for route/source semantics and [`operations.md`](operations.md) for deployment/configuration.
- **Local runtime, Mac backend, ports or Cloudflare Tunnel:** [`local_dashboard.md`](local_dashboard.md). Add `data_sources.md` only for compatibility route/source semantics and `operations.md` for start-up/configuration.
- **Station Snapshot routes, selection or observation/AQI independence:** [`station_snapshot.md`](station_snapshot.md). Add the hosted/local document only when that delivery path is also changing.
- **Dashboard route, panel or upstream-source meaning:** [`data_sources.md`](data_sources.md).
- **Supabase egress panel:** [`../monitoring/README.md`](../monitoring/README.md) and [`../monitoring/egress_dashboard_contract.md`](../monitoring/egress_dashboard_contract.md). Monitoring owns measurement/attribution meaning; dashboards own delivery and presentation integration.
- **Deployment/configuration:** [`operations.md`](operations.md) plus the relevant hosted/local document.
- **Validation:** read the relevant behavioural document first, then [`validation.md`](validation.md). Egress-specific acceptance remains in the monitoring area.

Pre-deployment checks are limited to structural viability and genuinely necessary targeted checks. Functional validation occurs through real TEST operation after deployment.

## Ownership

Current implementation is under:

- `dashboard/` and `station_snapshot/`;
- `local/dashboard/server/` and `local/station_snapshot/server/`;
- `local/scripts/run_dashboard.sh` and `local/cloudflared/`;
- `workers/uk_aq_dashboard_online_api_worker/`;
- the dashboard Pages and API Worker deployment workflows.

Worker-local READMEs are implementation guides. Active cross-component behavioural authority is under `system_docs/`.

Retired dashboard Cloud Run paths and removed wrapper scripts are historical only and MUST NOT be presented as supported runtime entry points.
