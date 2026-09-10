# Local dashboard MySQL cache and rolling history

This runbook covers the MacBook Pro-hosted local dashboard only. Hosted Cloudflare dashboards keep their existing cloud/API adapters and never depend on this MySQL instance.

The authoritative architecture is defined in `uk-aq-system-docs/system_docs/dashboards/local_mysql_cache.md`. MySQL contains derived, rebuildable dashboard data only. Supabase/PostgreSQL, Cloudflare/R2, the serving-generation descriptor and other documented upstream systems remain authoritative.

## Environment boundary

TEST uses `uk_aq_dashboard_test`. A later separately authorised LIVE rollout uses `uk_aq_dashboard_live`. The HTTP dashboard is SELECT-only. The background refresher has SELECT, INSERT, UPDATE and DELETE only on the dashboard cache tables. Root/admin credentials must not be inherited by either process.

The local dashboard and refresher use separate ignored files:

```text
.env.dashboard-cache.reader
.env.dashboard-cache.writer
```

with:

```dotenv
UKAQ_ENV_NAME=test
UK_AQ_DASHBOARD_MYSQL_ENABLED=true
UK_AQ_DASHBOARD_MYSQL_DATABASE=uk_aq_dashboard_test
UK_AQ_DASHBOARD_MYSQL_SOCKET=/tmp/mysql.sock
UK_AQ_DASHBOARD_MYSQL_USER=uk_aq_dashboard_test_reader
UK_AQ_DASHBOARD_MYSQL_PASSWORD=REPLACE_LOCALLY
```

The writer file uses `uk_aq_dashboard_test_writer` and its own password. Keep both mode `600`. Normal authoritative upstream credentials remain in `.env`.

## Canonical schema

The canonical TEST/LIVE-compatible DDL is:

```text
../TEST-uk-aq-schema/schemas/local_mysql/dashboard_cache.sql
```

It contains the current materialised-product table plus these rolling derived tables:

| Table | Purpose | Retention |
|---|---|---|
| `dashboard_cache` | current materialised dashboard/metric/R2/coverage products | current generation/product |
| `dashboard_sync_state` | local sync watermarks and safe status | current state |
| `daily_task_runs` | Daily Tasks history used by Latest and All runs | rolling 30 days |
| `service_egress_metrics_minute` | measured Supabase/service egress minute aggregates | rolling 30 days |
| `db_size_metrics_hourly` | IngestDB and ObsAQIDB size history | rolling 30 days |
| `schema_size_metrics_hourly` | ObsAQIDB schema-size history | rolling 30 days |
| `r2_usage_hourly` | hourly Cloudflare/R2 account-usage snapshots | rolling 30 days from deployment |
| `ingest_runs` | dispatcher/connector ingest-run history | rolling 30 days |

No observations, stations or timeseries are mirrored into this database.

## Apply the additive TEST schema

Stop the TEST cache refresher before pulling/applying a schema change so new code cannot attempt tables that do not yet exist:

```bash
launchctl bootout \
  "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard-cache.test"
```

Pull TEST Schema and TEST Ops in their respective checkouts. Before starting the runtime, validate only structural viability:

```bash
python3 -m py_compile \
  local/dashboard/server/uk_aq_dashboard_cache.py \
  local/dashboard/server/uk_aq_dashboard_cache_refresh.py \
  local/dashboard/server/uk_aq_dashboard_rolling_cache.py
```

Then apply the canonical additive DDL to the explicit TEST database:

```bash
mysqlroot --database=uk_aq_dashboard_test \
  < ../TEST-uk-aq-schema/schemas/local_mysql/dashboard_cache.sql
```

The existing `dashboard_cache` remains in place because the DDL uses `CREATE TABLE IF NOT EXISTS`; the new rolling tables are added alongside it.

## Least-privilege grants

The existing TEST reader/writer initially had privileges only on `dashboard_cache`. Grant the new tables explicitly:

```sql
GRANT SELECT ON uk_aq_dashboard_test.dashboard_sync_state TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.daily_task_runs TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.service_egress_metrics_minute TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.db_size_metrics_hourly TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.schema_size_metrics_hourly TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.r2_usage_hourly TO 'uk_aq_dashboard_test_reader'@'localhost';
GRANT SELECT ON uk_aq_dashboard_test.ingest_runs TO 'uk_aq_dashboard_test_reader'@'localhost';

GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.dashboard_sync_state TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.daily_task_runs TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.service_egress_metrics_minute TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.db_size_metrics_hourly TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.schema_size_metrics_hourly TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.r2_usage_hourly TO 'uk_aq_dashboard_test_writer'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON uk_aq_dashboard_test.ingest_runs TO 'uk_aq_dashboard_test_writer'@'localhost';
```

Do not replace these with database-wide grants. `dashboard_cache` keeps its existing reader/writer grants.

## Rolling collection behaviour

The background refresher runs independently of the browser.

- Dashboard current summary: every 5 minutes. Its recent ingest-run input is first synchronised into rolling `ingest_runs` using a `created_at` watermark with overlap.
- Daily task runs: every 5 minutes. Initial collection hydrates the retained window; later runs use an `updated_at` watermark with overlap. Latest and All runs are both served from the same local relational rows.
- Service egress: every 5 minutes. Recent mutable minute buckets are re-read with overlap and upserted rather than repeatedly downloading the dashboard's whole graph window.
- DB-size and schema-size metrics: hourly, with at least two recent hours re-read and upserted. Normal chart rendering reads MySQL.
- R2 account usage: hourly. The Cloudflare fetch remains asynchronous to the browser and each successful result is persisted as an hourly local point.
- Storage coverage/calendar: retains its existing six-hour materialised cadence and serving-generation rules. Its **Refresh** button creates an environment-local request identity and returns promptly; the browser uses short status polls while the writer associates a post-acceptance rebuild with that identity. On success the browser reads the newly published MySQL product. The existing calendar and last successful snapshot remain visible/in place if that update fails or times out.

Retention pruning happens only inside a successful sync transaction. A failed upstream read must not erase the previously successful local history.

## Daily Tasks Refresh

For a selected day inside the 30-day retained window, the Daily Tasks Refresh action performs a complete authoritative source read for that day through the writer process, reconciles that day's `daily_task_runs` rows, then returns the requested Latest or All runs view from MySQL. The HTTP process remains SELECT-only.

Latest and All runs are therefore display modes over the same local rows. Latest is derived locally per task rather than relying on a previously cached source rank. A selected day outside local retention uses the existing direct authoritative route.

## R2 latency

Normal local R2 account-usage rendering is served from MySQL after a successful hourly background fetch, so a slow Cloudflare response no longer needs to delay the browser. `r2_usage_hourly` also preserves a recent local trend across dashboard/refresher restarts.

Persisting R2 usage does not make the actual Cloudflare API request faster. It moves that latency out of normal page rendering. The storage calendar's explicit Refresh has separate generation-selected history/Dropbox/coverage behaviour and does not refresh R2 account usage or other dashboard products.

## First real TEST operation after schema apply

After the schema and grants are applied, run one foreground refresh:

```bash
local/scripts/run_dashboard.sh --cache-refresh --once
```

This is the first functional acceptance operation, not a pre-deployment test. On success, inspect the rolling tables and sync state, then reinstall/start the background LaunchAgent:

```bash
cp local/launchd/co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist \
  "$HOME/Library/LaunchAgents/"

launchctl bootstrap \
  "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist"

launchctl kickstart -k \
  "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard.test"
```

Real TEST acceptance should confirm: warm local reads report `local_mysql`; Daily Tasks Latest and All runs use the retained relational cache; Daily Tasks Refresh causes a source reconciliation and writer log entry; incremental sync watermarks advance without repeatedly downloading full history windows; DB/schema/egress charts read local history; R2 normal rendering stays fast even when the Cloudflare collector is slow; failed collection retains prior successful local data; and the hosted dashboard remains independent of the Pro/MySQL runtime.

No LIVE database or runtime change is authorised by this runbook.
