# TEST GCP billing collector — review only, not deployed

Run on the MacBook Pro. BigQuery Cloud Billing exports remain authoritative;
MySQL and the local Dropbox tree are derived and rebuildable. No Cloud Run,
Dropbox API, dashboard-triggered collection or cloud infrastructure is added.
This implementation accepts **TEST only**. LIVE activation requires separate
scope and configuration support; no LIVE account, grant, template or repository
is accessed. The canonical table DDL remains reusable for later promotion.

## Source and destination ownership

The supplied TEST source dataset is
`project-53835517-a266-48e3-8d9.gcp_billing_export`. The supplied earliest available
Standard usage date is **1 May 2026**. Keep that export project/dataset: local
copies do not replace its historical authority. Account ID, exact raw export
tables, location, existing views and export-time behaviour still require the
read-only discovery below. No GCP identity was available during implementation.

Standard feeds canonical `daily_costs`, `daily/YYYY/MM/YYYY-MM-DD.csv.gz` and
`reports/standard/`. Detailed feeds separate `resource_daily_costs`,
`detailed/daily/YYYY/MM/YYYY-MM-DD.csv.gz` and `reports/detailed/` for resource
investigation. Each has its own `sync_state` row, backfill cursor, watermark and
run evidence. Standard commands work without a successful Detailed collection.
**Never add Detailed costs to Standard totals.** Detailed contains overlapping
billing costs; resource names can be absent. Cloud Run resource reports retain
unattributed costs explicitly, rather than allocating them to invented services.

Canonical MySQL ownership is in the sibling schema repository:

- `schemas/local_mysql/gcp_billing.sql`
- `schemas/local_mysql/gcp_billing_grants_test.sql`
- `schemas/CANONICAL_APPLY_ORDER.md`

There are no pre-existing billing tables to migrate. The canonical file creates
the new tables directly; do not maintain a second Ops-local table definition.
Use MySQL **8.0.16+** for enforced CHECK constraints, JSON and InnoDB transactions.

## Configuration and credentials

Create a private runtime tree **outside Dropbox and Git**:

```text
/absolute/path/uk-aq-gcp-billing/TEST/
  config.json
  credentials/google-application-credentials.json
  credentials/mysql-password
  collector.lock
  publication.json                     # only while publication/recovery is pending
  logs/launchd.log
```

Copy `config.test.example.json` to this tree and replace every placeholder.
The example deliberately cannot run. `archive_root` is an absolute resolved
local Dropbox path ending in `Apps/github-uk-air-quality-networks/TEST/gcp_billing`.
The parent `TEST` directory is the existing UK AQ data directory. The corresponding
`LIVE/gcp_billing` directory is reserved for a separately authorised LIVE rollout;
this TEST implementation MUST NOT write there. Confirm the Dropbox root on the
MacBook Pro before setting `archive_root`. The runtime root must end in
`TEST`, be mode 700, and have no symlink aliases. Credential files must be mode
600 and resolve inside that runtime. Provision the credential files out of band;
never put them in the archive. A single terminal newline in `mysql-password` is
removed; all other password characters are preserved. MySQL uses the explicitly
configured local Unix socket, database and restricted writer account.

No new process environment variables or GitHub secrets are introduced. JSON is
local configuration, not sourced shell. Explicit credential files replace any
global switched ADC login; there is no fallback to ambient Google credentials.
The existing GitHub environment-target catalogue is therefore unchanged.
`UK_AQ_ENV_NAME` and dashboard-specific MySQL keys are deliberately not reused:
this command takes an explicit `--environment TEST`, and dashboard credentials
must not acquire billing writer privileges. Python CodeQL is already enabled.

The binding hash includes the account, source/view, environment, database,
archive root, history boundary and archive/money generation. Both MySQL state
and `archive-identity.json` pin it. A changed binding fails closed. Budget and
cadence tuning does not require a rebuild. Do not edit hashes to bypass a
mismatch. A deliberate source/archive relocation needs a reviewed migration or
an explicitly authorised isolated rebuild.

## Structural source discovery (read only; before deployment)

Using an operator-provisioned **TEST** read-only identity, inspect metadata with
`bq --project_id=project-53835517-a266-48e3-8d9 ls gcp_billing_export`, then
`bq show --format=prettyjson` for the dataset and both raw tables. Confirm:

- dataset location and exact billing account ID;
- Standard table `gcp_billing_export_v1_<ACCOUNT_WITH_UNDERSCORES>`;
- Detailed table `gcp_billing_export_resource_v1_<ACCOUNT_WITH_UNDERSCORES>`;
- fields used by the rendered views, including Detailed `resource.name` and
  `resource.global_name`, UTC usage start, invoice month, credits and export time;
- partitioning and estimated scan sizes; the queries intentionally do not assume
  a partition type or truncate old usage dates during correction discovery;
- whether either versioned UK AQ view already exists; inspect its definition and
  downstream users before replacing it.

With explicit `--maximum_bytes_billed` and a dry run first, query the raw
Standard table's MIN/MAX usage date, MAX export_time, distinct account IDs and
project IDs. Confirm the supplied 1 May boundary, TEST account and expected TEST
projects. Repeat for Detailed (its first available date may be later; that actual
boundary is stored independently). Do not query a LIVE account for comparison.
Record any historical discontinuity in the separate documentation handover.

Least privilege: dataset/view-scoped `roles/bigquery.dataViewer` and
`roles/bigquery.jobUser` on the explicit query project. The collector identity
needs no view/table creation, export modification or billing administration.
An administrator creates the views separately after review.

## Manual deployment commands (not executed by implementation)

All write/apply/backfill/scheduling commands below require a later deployment
authorisation. Substitute the actual checkout and private runtime paths first.
These shell variables are local conveniences, not collector environment keys:

```bash
OPS=/absolute/path/uk-aq-ops
SCHEMA=/absolute/path/uk-aq-schema
BILLING_RUNTIME=/absolute/path/uk-aq-gcp-billing/TEST
cd "$OPS"
python3 -m venv .venv-gcp-billing
.venv-gcp-billing/bin/python -m pip install -r local/gcp_billing/requirements.txt
install -d -m 700 "$BILLING_RUNTIME" "$BILLING_RUNTIME/credentials" "$BILLING_RUNTIME/logs"
install -m 600 local/gcp_billing/config.test.example.json "$BILLING_RUNTIME/config.json"
# Edit config and provision both mode-600 credential files out of band.
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment TEST --config "$BILLING_RUNTIME/config.json" \
  --runtime-root "$BILLING_RUNTIME" validate
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment TEST --config "$BILLING_RUNTIME/config.json" \
  --runtime-root "$BILLING_RUNTIME" --source all render-views > /tmp/uk-aq-billing-test-views.sql
```

`validate` and `render-views` are offline and do not read credentials or create
runtime/archive directories. Review the generated SELECTs and view DDL. The
collector compares ordered view columns/types and meaningful SQL tokens
against the rendered v1 SELECTs. Formatting, comments and case of unquoted SQL
words are ignored, but source tables, ordered columns, calculations, aliases and
literal values remain exact. Apply each reviewed CREATE VIEW statement with
an authorised administrator via `bq query --use_legacy_sql=false --location=LOCATION`.
Do not give that privilege to the collector or modify Google's export tables.

An administrator must create the explicit database and accounts, setting
passwords securely outside Git and checking existing grants for unwanted access.
Then use the local MySQL socket and an operator login path:

```bash
mysql --login-path=local-admin --execute="CREATE DATABASE uk_aq_gcp_billing_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
# Provision uk_aq_gcp_billing_test_writer@localhost and optional reader@localhost.
mysql --login-path=local-admin --database=uk_aq_gcp_billing_test < "$SCHEMA/schemas/local_mysql/gcp_billing.sql"
mysql --login-path=local-admin --database=uk_aq_gcp_billing_test < "$SCHEMA/schemas/local_mysql/gcp_billing_grants_test.sql"
```

The collector has no DDL path. Grants restrict each table, with no global or
LIVE permissions. Do not reuse an administrator credential for collection.

Billing Markdown summaries now stream canonical MySQL rows and aggregate
the complete reporting dimensions in Python, with exact integer-micro totals.
This avoids MySQL GROUP BY/ORDER BY sorting of full TEXT service/SKU descriptions
and error 1038 without enlarging a MySQL sort buffer. Reports are still built
inside the publication transaction and sorted deterministically for output.
Only the collector connection's UTC session time zone is configured; server-global
memory settings and persisted billing facts are unchanged.

Run an explicitly authorised real TEST backfill batch:

```bash
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment TEST --config "$BILLING_RUNTIME/config.json" \
  --runtime-root "$BILLING_RUNTIME" --source standard backfill
# Repeat the same command until standard sync_state.watermark_at is non-null.
# Then backfill Detailed independently, replacing --source standard with detailed.
```

Each batch covers at most `maximum_days_per_batch` calendar dates (default 7),
including empty days. The initial source scan pins an export-time cutoff and
actual history bounds; successful batches advance only the cursor, with a null
watermark until the complete initial history has published. Repeating after a
failure resumes at the previous successful cursor. `backfill` refuses a source
already completed; it never resets state silently.

After both backfills, a normal invocation is:

```bash
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment TEST --config "$BILLING_RUNTIME/config.json" \
  --runtime-root "$BILLING_RUNTIME" --source all incremental
```

Default source is Standard. With `all`, a Detailed failure does not undo or
block a successful Standard commit. Exit status is nonzero if any selected
source fails. A pending publication journal stops further publication until
recovery resolves it. Use separate source commands to operate Standard while
Detailed initial loading is still in progress.

To regenerate lost/corrupt daily files or rebuild a bounded selected period
from BigQuery, after backfill completion:

```bash
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment TEST --config "$BILLING_RUNTIME/config.json" \
  --runtime-root "$BILLING_RUNTIME" --source standard refresh \
  --start 2026-05-01 --end 2026-05-07
```

Refresh recomputes complete dates and all that source's summaries, preserving
its watermark. It is not a delta import. Split wider recovery into bounded date
ranges. Never restore a differing Dropbox result over BigQuery authority.

## Publication, corrections and recovery

Incremental detection selects all usage dates whose export_time is in the
inclusive overlap window (default two hours) through a settling cutoff (default
two minutes). It has **no recent usage-date floor**, so an old-day correction is
found. Each date is fully recomputed through that same fixed export cutoff.
A replay deletes/replaces the complete local day, including formerly present
groups; it never adds an assumed cost delta. The watermark is monotonic and
independent per source. Corrections to the export are expected as newly exported
rows; silent upstream mutation without advancing export_time requires explicit
refresh/reconciliation. This is not claimed to be captured by incremental scans.

All source queries for the unit finish before any day is replaced. A single
MySQL transaction replaces the batch and generates its summaries from that same
transactional view. Files are staged adjacent to their destinations, flushed,
and atomically renamed individually. Exact previous files are retained in
hidden backups until the database decision is durable. The private runtime
journal records intent before renames. MySQL's named lock serialises all TEST
billing collectors even if different runtime directories are accidentally used;
a local flock also prevents overlapping invocations.

Required `_sync/YYYY/MM/<run-id>.json` evidence is published with status
`published_pending_database_commit` before SQL commit. It includes source,
account, prior/resulting watermark, dates, counts and content SHA-256 for daily
files and reports. The MySQL success record and watermark commit together only
after all these files exist. A success annotation of that evidence occurs after
commit. If interrupted, the next invocation checks `sync_runs`: a committed run
keeps its files and finalises success; an uncommitted run restores previous
files and marks the interrupted attempt failed. A lost connection during commit
is resolved by the database decision, never by assuming failure. If the database
is unavailable, the journal is retained and collection stops safely.

There is no cross-filesystem/database distributed transaction. During renames,
Dropbox readers may briefly see mixed generations or prepared evidence. After a
hard interruption they may see files ahead of MySQL until the next recovery.
Individual files are atomic; full-source cross-file atomic visibility is not
promised. Do not delete a pending journal/backups or rerun using another runtime.
The schema uses strict SQL mode so oversized source text fails rather than
silently truncating canonical identities. Raw exception strings and credentials
are excluded from logs, sync metadata and archives; failures use bounded codes.

## Costs, formats and reports

Every BigQuery query is estimated with a dry run, then submitted with
`maximum_bytes_billed`. `maximum_run_bytes` limits the total reservation across
both sources, including BigQuery minimum billing rounding. Default caps are
1 GiB/query and 8 GiB/invocation; tune downward after discovery estimates. A cap
failure leaves the source watermark/cursor unchanged. Automatic whole-query job
retry is disabled. The export-time discovery may scan history: this deliberate
correctness tradeoff is protected by the caps. Query cache remains enabled for
real execution. Do not add an ingestion/usage partition filter that can hide
late corrections. Long incremental lists are never silently truncated; if caps
prevent completion, inspect estimates and explicitly approve a budget adjustment.

Views convert each raw cost/credit using BIGNUMERIC, multiplying by 1,000,000
and ROUND half away from zero, then INT64. Credits are rounded individually
before aggregation; net is the sum of gross micros and signed credit micros.
Google's original floating representation cannot be made more precise than the
export, but all derived persisted arithmetic uses integers. Overflow fails the
unit. Canonical CSV contains integer strings, UTF-8 dimensions, explicit null
flags, UTC timestamps and all readable reporting fields. `dimension_hash` is an
internal MySQL key, not a replacement for readable dimensions. Gzip uses fixed
mtime, and hash order is deterministic (refresh timestamps record each refresh).
CSV gzip was chosen over Parquet to avoid adding Arrow to the standalone local
runtime; the existing local collector has no Parquet dependency. The format is
pinned in the binding generation; do not change it without migration planning.

Readable Markdown summaries include:

- daily totals by currency;
- usage-calendar-month and invoice-month totals, separately;
- all-history service and service/SKU costs, including gross, credits and net;
- Detailed Cloud Run daily individual-resource/SKU costs, with project and invoice
  month, including explicit missing resource attribution.

All currencies remain separate. Reports are regenerated from their own table
inside each publication transaction, so old-day corrections update historical
month/service/resource summaries too. Reports may contain only partially loaded
history until initial backfill completes: check `sync_state.backfill_next_date`,
`backfill_last_date` and non-null watermark. Recent usage is always provisional.
MySQL retains the latest configured number of run records per source (default
200); cost facts and Dropbox daily/sync files are not pruned. Rotate the local
launchd log with the existing Mac operator log policy; it contains only compact
one-line statuses, never source rows or SDK exception payloads.

## Daily scheduling at 13:00 (only after TEST acceptance)

Render the template; rendering does not install or enable it:

```bash
.venv-gcp-billing/bin/python local/gcp_billing/render_launchd.py \
  --repo-root "$OPS" --runtime-root "$BILLING_RUNTIME" \
  --python "$OPS/.venv-gcp-billing/bin/python" > /tmp/co.uk.chronicillnesschannel.aq.gcp-billing.test.plist
plutil -lint /tmp/co.uk.chronicillnesschannel.aq.gcp-billing.test.plist
```

It invokes `--source all incremental` daily at 13:00 in the MacBook Pro's
configured local time zone (Europe/London expected), with `RunAtLoad=false`.
This TEST-specific cadence is an operator-approved exception to the future
billing contract's recommended hourly interval; it does not change source
watermarks, overlap or late-correction handling. Only after separate authorisation,
install the rendered file to the user's LaunchAgents and bootstrap `gui/<uid>`.
Installation/loading was **not** performed here.

## Real TEST acceptance after authorised deployment

Use normal real TEST billing, without synthetic traffic or speculative suites:

1. Verify both backfills cover their actual available history; Standard begins
   1 May 2026. Compare selected actual days and currencies, service/SKU totals and
   invoice periods with each separate BigQuery view using the same cutoff/micros.
2. Observe normal daily collection and a repeat run: facts do not duplicate,
   each source's watermark advances independently, and reports/archive days agree
   with MySQL. Inspect the null flags and integer fields without a float parser.
3. Observe a naturally arriving late export/correction and confirm the complete
   old day and its monthly/service/resource reports are replaced. Do not fabricate
   billable traffic or pretend this is accepted before a real example arrives.
4. If a real failure occurs, verify prior files/data survive or recover on the
   next invocation and its watermark/cursor did not skip unpublished data.
5. Inspect actual MySQL grants and all paths/source identities to confirm TEST
   writes have no LIVE destination; Detailed is never added to Standard totals.

## Rollback

Stop the TEST job with `launchctl bootout gui/<uid> <installed-plist>` if enabled.
Preserve the runtime journal and archives. Restore the reviewed previous code;
finish or inspect recovery with the matching binding before another collector
publishes. The new tables have no prior billing schema to restore; leave them
intact for investigation. Removing tables/history is a separate destructive
operation, not rollback. A lost MySQL domain is rebuilt from the canonical schema
and BigQuery using a newly reviewed archive/rebuild destination; an existing
nonempty archive cannot silently be rebound. Never discard the export project.

See `DOCUMENTATION_HANDOVER.md` for the separate Chat-mode system-doc update.
