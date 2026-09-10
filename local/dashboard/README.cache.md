# Local dashboard cache and shared history authority

The implementation has been committed and deployed, but still requires real TEST
acceptance. No database, Worker deployment or launchd registration is performed
by this README.

## Separation

The stable observations-history service exposes authenticated
`GET /v1/history-generation`. Both Python and Cloudflare dashboard backends use it
as the serving-generation authority. They ignore independently deployed dashboard
`UK_AQ_R2_HISTORY_VERSION` values. No browser or MySQL row chooses a version.

Only the Mac dashboard uses MySQL. The hosted Worker keeps its existing cloud/API
adapters and existing direct/upstream mode selection. This work introduces no
hosted MySQL client, credentials, binding, proxy through the Mac, or refresh
service. The existing optional upstream mode is not required and is not enabled
by this work. Normal hosted direct mode needs no Mac availability.

The API descriptor uses the existing `x-uk-aq-upstream-auth` secret. The dashboard
Worker deploy workflow maps the existing `UK_AQ_EDGE_UPSTREAM_SECRET` GitHub secret
to its already named observations API token. Configure the existing
`UK_AQ_OBSERVS_HISTORY_R2_API_URL` to the **stable** service, never a candidate.
The local client accepts `UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN`, or the same existing
`UK_AQ_EDGE_UPSTREAM_SECRET`. No new history selector is introduced.

## TEST setup (manual, not executed)

1. Deploy the stable observations-history Worker containing the descriptor first,
   using `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` through
   its existing authorised deployment process. Its normal selector must already
   represent the serving generation. Do not change selectors merely to deploy
   this endpoint. Verify the authenticated descriptor returns the expected v3
   generation and `Cache-Control: no-store` on TEST.
2. For hosted TEST, run `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
   after the descriptor is available. Its only new deployment requirement is the
   stable API URL/authentication mapping above. There is no hosted MySQL setup.
3. From this TEST Ops checkout, install Python dependencies:

   ```bash
   .venv/bin/python3 -m pip install -r local/dashboard/server/requirements.txt
   ```

4. Using a local MySQL administrator, explicitly create the TEST database and
   canonical table. These are manual commands, not a startup migration:

   ```bash
   mysql --user=root --password -e 'CREATE DATABASE IF NOT EXISTS uk_aq_dashboard_test CHARACTER SET utf8mb4;'
   mysql --user=root --password --database=uk_aq_dashboard_test < ../TEST-uk-aq-schema/schemas/local_mysql/dashboard_cache.sql
   ```

   Provision fresh restricted users in an interactive admin session. If either
   user already exists, review its existing grants rather than replacing it.
   `IDENTIFIED BY RANDOM PASSWORD` returns the generated passwords: keep them
   private and place each only in its corresponding local environment file.

   ```sql
   CREATE USER 'uk_aq_dashboard_test_reader'@'localhost' IDENTIFIED BY RANDOM PASSWORD;
   CREATE USER 'uk_aq_dashboard_test_writer'@'localhost' IDENTIFIED BY RANDOM PASSWORD;
   GRANT SELECT ON uk_aq_dashboard_test.dashboard_cache TO 'uk_aq_dashboard_test_reader'@'localhost';
   GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.dashboard_cache TO 'uk_aq_dashboard_test_writer'@'localhost';
   SHOW GRANTS FOR 'uk_aq_dashboard_test_reader'@'localhost';
   SHOW GRANTS FOR 'uk_aq_dashboard_test_writer'@'localhost';
   ```

   Neither user may have global privileges or grants on another environment.
   The application additionally validates the explicit database against
   `UKAQ_ENV_NAME`, the checkout and the required reader/writer username.

5. Create two separate files in the Ops repository (both ignored by Git):
   `.env.dashboard-cache.reader` and `.env.dashboard-cache.writer`. Copy the
   non-secret structure below, changing USER and PASSWORD for each process:

   ```dotenv
   UKAQ_ENV_NAME=test
   UK_AQ_DASHBOARD_MYSQL_ENABLED=true
   UK_AQ_DASHBOARD_MYSQL_DATABASE=uk_aq_dashboard_test
   UK_AQ_DASHBOARD_MYSQL_SOCKET=/absolute/path/to/actual/mysql.sock
   UK_AQ_DASHBOARD_MYSQL_USER=uk_aq_dashboard_test_reader
   UK_AQ_DASHBOARD_MYSQL_PASSWORD=REPLACE_LOCALLY
   ```

   The writer file uses `uk_aq_dashboard_test_writer` and its own generated
   password. Find the actual server socket using the administrator's MySQL
   configuration; the runtime requires an explicit local Unix socket and does
   not connect over TCP. Set permissions:

   ```bash
   chmod 600 .env.dashboard-cache.reader .env.dashboard-cache.writer
   ```

   Existing authoritative upstream credentials remain in the normal `.env`.
   Do not place the MySQL writer credentials there: the HTTP server must load
   only the reader file. The refresher branch runs before browser config
   generation, so it does not rewrite dashboard assets.

6. For an authorised first foreground refresh:

   ```bash
   local/scripts/run_dashboard.sh --cache-refresh --once
   ```

   Expect a success line for each of the five products and matching rows in
   `uk_aq_dashboard_test.dashboard_cache`. A failure must leave the prior payload
   and successful timestamps unchanged; it records `refresh_failed` metadata.
   `--once` is a real upstream/MySQL operation, not a structural test.

7. Register the TEST refresher with launchd, after checking the checked-in paths:

   ```bash
   mkdir -p logs "$HOME/Library/LaunchAgents"
   cp local/launchd/co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist "$HOME/Library/LaunchAgents/"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist"
   ```

   Restart the existing local TEST dashboard through its normal launchd service
   after installing the reader configuration. No new hosted service is involved.

## Products and behaviour

- Dashboard operational summary: 5 minutes, using the existing IngestDB builder.
- Metric context and DB trends: 5 minutes, using existing metrics/egress adapters.
- Storage coverage: existing six-hour cadence and 06:00 UTC checkpoint boundary.
- R2 account usage/history window: 1 hour, retaining internal source caches.
- Today's latest task summary: 60 seconds.

Each product runs independently; a slow coverage call does not block the summary
thread. Publication is transactional, bounded to 8 MiB and a fixed product set.
Explicit upstream errors/partial required payloads are not successful refreshes.
Last-success JSON survives refresh failures; errors are stored only as safe codes.
Source timestamps are retained rather than rewritten as if upstream data were new.

`/api/dashboard`, `/api/storage_coverage`, `/api/r2_metrics` and default
`/api/daily_task_runs` use these products. DB trends are part of metric context.
`/api/r2_connector_counts` remains direct because it is parameterized; station
snapshots/history, non-default task queries, Dropbox mtime and all authoritative
control writes also remain direct. No observation row mirror is created.

A stale matching row returns immediately with `local_cache` metadata; the main
status line notes stale cached data. A missing row or unavailable MySQL uses the
existing authoritative builders directly, labels the fallback, and requests a
background refresh. Invalid environment/database/user configuration fails closed.
The reader never persists the fallback. Force Refresh coalesces per-product
refresh markers; the existing result may be shown while the background job runs.
Successful connector/dispatcher mutations expedite the summary without redirecting
those mutations into MySQL.

On a newly resolved v3 descriptor, v2 cache rows cannot satisfy a read. Refresher
products are keyed by generation and revalidate authority before publication.
The local descriptor has a maximum 15-second in-process lifetime; failure to
revalidate invalidates it rather than selecting an old MySQL generation. Hosted
requests resolve the descriptor before their existing payload caches. Existing
hosted cache identities now include generation; this is cutover invalidation,
not a new hosted persistence architecture.

The native v3 day/index layout is consumed through the generation-aware metrics
API. Optional local physical verification uses only an explicitly configured
`UK_AQ_R2_HISTORY_DIRECT_RCLONE_ROOT` remote/bucket identity; its `history/vN`
component follows the descriptor. Successful physical checks intersect committed
observation days, never union uncommitted directories into calendar success.
Without this optional configuration the selected history API remains the source.
V3 Dropbox paths use `generation=v3` and validate checkpoint `observation_generation`;
`backup_version=v2` is an intentional retained backup format identifier.

R2 account usage remains account-wide. Historical domain-byte trend rows have no
generation identity in the existing upstream schema; v3 responses suppress these
unattributed rows and expose a warning. They must not be labelled v3 simply because
a dashboard selector changed. Optional retired AQI data remains explicitly legacy
v2 in metrics; there is no v3 calculated-AQI history product.

## TEST acceptance and recovery

After deployment verify: warm local requests return `local_mysql` without cloud
collection; independent refresh timestamps advance at the intended cadence;
force/mutation signals expedite refresh; a failed refresh retains last-success
JSON and marks it stale; missing MySQL uses labelled direct fallback; generation
mismatch/unavailable authority cannot be reported as current cached history.
Check the hosted dashboard with the Mac/refresher unavailable: direct cloud reads
must still work and report the same canonical generation. Measure real warm-page
and storage-calendar latency; static checks do not prove the speed improvement.

Cache recovery is upstream rebuild. A fresh database uses the canonical DDL; no
bespoke backup is required. Explicitly deleting product rows requests a rebuild
on the next process start/miss. Do not truncate/drop databases as an incidental
repair. To disable acceleration, stop the TEST refresher and set enabled=false in
the reader file, then restart the local dashboard. History authority remains the
stable descriptor. Restore the pre-change code only as a coordinated dashboard/API
rollback; code archives are reference-only and never runtime fallbacks.

No LIVE database/runtime changes are part of this work. Later promotion uses the
same schema/code with explicitly separate LIVE credentials/database after TEST
acceptance. The observations global-operation lock identity is unchanged.

Driver compatibility was checked against [PyMySQL's supported Python/MySQL versions](https://pymysql.readthedocs.io/en/latest/user/installation.html).
Canonical DDL uses MySQL's [native JSON type](https://dev.mysql.com/doc/refman/8.4/en/json.html), InnoDB transactions and explicit constraints.

## Review surface

Ops changes: stable observation Worker descriptor; hosted `history_generation.ts`,
`direct.ts`, `upstream.ts`, metrics/coverage adapters, compatibility/status routes
and Worker deployment mapping; local history client, cache reader/writer,
refresher, shared core/coverage wiring, requirements, startup script and TEST
refresher plist; frontend stale status; local environment example and runbook.
Pre-change code snapshots are under `archive/2026-09-10/` and are never executed.

Schema changes: `schemas/local_mysql/dashboard_cache.sql` and canonical apply
order in TEST Schema. Contract changes: dashboard cache/data sources/local/hosted/
operations/router, local MySQL contract/router, R2 descriptor/router, and schema
repository ownership in TEST System Docs.

The local-versus-hosted follow-up found no hosted MySQL implementation to remove.
It makes the separation explicit in this runbook, the hosted Worker README and
active hosted/cache contracts. No hosted MySQL credentials, configuration,
bindings or deployment requirements were removed because none had been added.

## Structural validation completed

Python AST parsing and imports passed for all local dashboard modules. PyMySQL
resolved cleanly and imported from a temporary wheel under the existing Python
3.14 environment; it has not been installed into the runtime environment. The
canonical DDL parsed as MySQL CREATE TABLE, and its products/columns match the
reader/writer SQL. This is not a MySQL apply or server acceptance result.

The hosted TypeScript check, observation Worker syntax, frontend inline-script
syntax, launchd plist parsing, startup/workflow shell parsing, workflow YAML,
shared descriptor field consistency, hosted MySQL-isolation audit, active-doc
links and all three repositories' `git diff --check` passed. Worker request API
usage was checked against the current Cloudflare references/types. No speculative
functional suite was added or run; no database/cloud/launchd runtime was changed.

## Exact changed-file inventory

This is the combined uncommitted implementation/review surface, excluding the
reference-only code snapshots under Ops `archive/2026-09-10/`.

### TEST Ops

- `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
- `.gitignore`
- `dashboard/index.html`
- `local/dashboard/README.cache.md`
- `local/dashboard/cache-env.example`
- `local/dashboard/server/requirements.txt`
- `local/dashboard/server/uk_aq_dashboard_api.py`
- `local/dashboard/server/uk_aq_dashboard_api_core.py`
- `local/dashboard/server/uk_aq_dashboard_cache.py`
- `local/dashboard/server/uk_aq_dashboard_cache_refresh.py`
- `local/dashboard/server/uk_aq_dashboard_direct_r2_patch.py`
- `local/dashboard/server/uk_aq_dashboard_history_generation.py`
- `local/launchd/co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist`
- `local/scripts/run_dashboard.sh`
- `workers/uk_aq_dashboard_online_api_worker/README.md`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/history_generation.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/r2_metrics_service.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_http_enrichment.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/lib/upstream.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/routes/compat.ts`
- `workers/uk_aq_dashboard_online_api_worker/src/routes/status.ts`
- `workers/uk_aq_observs_history_r2_api_worker/README.md`
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`

### TEST Schema

- `schemas/CANONICAL_APPLY_ORDER.md`
- `schemas/local_mysql/dashboard_cache.sql`

### TEST System Docs

- `system_docs/dashboards/README.md`
- `system_docs/dashboards/data_sources.md`
- `system_docs/dashboards/hosted_dashboard.md`
- `system_docs/dashboards/local_dashboard.md`
- `system_docs/dashboards/local_mysql_cache.md`
- `system_docs/dashboards/operations.md`
- `system_docs/local_mysql/README.md`
- `system_docs/local_mysql/contract.md`
- `system_docs/r2_history/README.md`
- `system_docs/r2_history/generation_descriptor_contract.md`
- `system_docs/schema-repository-structure-contract.md`
