# Manual LIVE promotion: GCP Billing collector

**No LIVE repository changes are made by ChatGPT.** The shared collector is
maintained in TEST Ops and its database schema in TEST Schema. Copy only
these active files into the matching LIVE repositories, retaining their
relative paths.

## Exact source file list

**TEST Ops `TEST-uk-aq/uk-aq-ops` → LIVE Ops `UK-AQ/uk-aq-ops`**

```text
local/gcp_billing/collector.py
local/gcp_billing/configuration.py
local/gcp_billing/publication.py
local/gcp_billing/queries.py
local/gcp_billing/reports.py
local/gcp_billing/render_launchd.py
local/gcp_billing/requirements.txt
local/gcp_billing/config.example.env
local/gcp_billing/README.live.md
local/launchd/co.uk.ukaq.gcp-billing.plist.template
```

**TEST Schema `TEST-uk-aq/uk-aq-schema` → LIVE Schema `UK-AQ/uk-aq-schema`**

```text
schemas/local_mysql/gcp_billing.sql
schemas/local_mysql/gcp_billing_grants_live.sql
```

**Do not copy any source-code archives to LIVE.** Exclude `archive/`,
`system_docs_legacy/`, `ref_docs/`, `__pycache__`, TEST-specific launchd
templates, `config.test.example.json`, actual `config.json`,
`.env.gcp_billing`, legacy `.env`, credentials, logs, billing data and
MySQL dumps. Do not copy whole TEST directories. Commit and push to LIVE
yourself after reviewing the selected file changes. The LIVE repository root
has its own independently completed `.env.gcp_billing`, synced by Dropbox
but never copied from TEST or committed to Git.

The **billing-data archive** in the local Dropbox
`Apps/github-uk-air-quality-networks/LIVE/gcp_billing` is separate from
source-code archives and remains part of the agreed collector contract.

## Environment-specific repository-root .env.gcp_billing

Create a mode-700 private runtime at
`~/.local/share/uk-aq-gcp-billing/LIVE`, outside Dropbox and Git, **for
credentials, logs, collector state and publication recovery only**.
Copy `local/gcp_billing/config.example.env` to
`<LIVE Ops root>/.env.gcp_billing` (mode 600) and replace all placeholders.
This configuration file is stored in the Dropbox-synchronised LIVE Ops
checkout, not in Git. Confirm that `.gitignore` excludes it with
`git check-ignore .env.gcp_billing`; never use `git add -f`.
Only non-secret configuration belongs in it. Its absolute filesystem paths
must be valid **on the MacBook Pro**, where the collector runs, even though
Dropbox also syncs the file to the MacBook Air. For LIVE, the values include:

```dotenv
UK_AQ_BILLING_ENVIRONMENT=LIVE
UK_AQ_BILLING_QUERY_PROJECT=project-a09d920d-8343-4273-8b9
UK_AQ_BILLING_DATASET=project-a09d920d-8343-4273-8b9.gcp_billing_export_eu
UK_AQ_BILLING_LOCATION=EU
UK_AQ_BILLING_BILLING_ACCOUNT_ID=01CB61-CE171F-1ECBB9
UK_AQ_BILLING_EARLIEST_USAGE_DATE=REPLACE_WITH_VERIFIED_MINIMUM_DATE
UK_AQ_BILLING_ARCHIVE_ROOT="/REPLACE_WITH_LOCAL_DROPBOX_ROOT/Apps/github-uk-air-quality-networks/LIVE/gcp_billing"
UK_AQ_BILLING_MYSQL_DATABASE=uk_aq_gcp_billing_live
UK_AQ_BILLING_MYSQL_USER=uk_aq_gcp_billing_live_writer
UK_AQ_BILLING_MYSQL_SOCKET=/REPLACE_WITH_LOCAL_MYSQL_SOCKET
UK_AQ_BILLING_OVERLAP_SECONDS=7200
UK_AQ_BILLING_SETTLING_SECONDS=120
UK_AQ_BILLING_MAXIMUM_BYTES_BILLED=1073741824
UK_AQ_BILLING_MAXIMUM_RUN_BYTES=8589934592
UK_AQ_BILLING_MAXIMUM_DAYS_PER_BATCH=14
UK_AQ_BILLING_RUN_HISTORY_LIMIT=200
```

The raw export table identifiers are derived from the explicit billing
account. Source account, query project/dataset, MySQL database/writer, archive
location and runtime path are validated; source binding hashes fail closed
on subsequent changes. A repository-root `.env.gcp_billing` must resolve
to the same Ops checkout as the collector code and cannot be a symlink.
Do not reuse TEST credentials, databases or data.

Google credentials and local MySQL writer password remain separate
mode-600 files inside `LIVE/credentials/`:
`google-application-credentials.json` and `mysql-password`. Keep
credentials and private runtime out of Git and Dropbox. The Dropbox-synchronised
`.env.gcp_billing` deliberately contains **no service-account private key,
MySQL password or other credentials**.

## Source verification before writes

The EU dataset was created and Standard/Detailed exports enabled on
14/10/2026, but the two tables had not appeared in the screenshot at that time.
Wait for and confirm:

```text
gcp_billing_export_v1_01CB61_CE171F_1ECBB9
gcp_billing_export_resource_v1_01CB61_CE171F_1ECBB9
```

Check raw schemas, account/project IDs, dataset region,
`MIN(DATE(usage_start_time, 'UTC'))` and `MAX(export_time)` from BigQuery
read-only metadata/discovery. Configure the **observed** earliest Standard
usage date, not an assumed 01/09/2026. Detailed may begin later.

With separately authorised LIVE BigQuery reader permissions, create the two
normalising views through an administrator, not the collector. Provision
`uk_aq_gcp_billing_live` and its restricted user(s), apply canonical
`gcp_billing.sql` with that database selected and apply
`gcp_billing_grants_live.sql` after users exist. No cross-environment
grants. Do not start collection/backfill until the actual exports are
sufficiently populated and sources/grants have been checked.

## Offline structural commands from LIVE Ops

After installing the pinned requirements in a local `.venv-gcp-billing`:

```bash
BILLING_RUNTIME="$HOME/.local/share/uk-aq-gcp-billing/LIVE"
python3 -m py_compile local/gcp_billing/{collector,configuration,publication,queries,reports,render_launchd}.py
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment LIVE --env-file "$PWD/.env.gcp_billing" \
  --runtime-root "$BILLING_RUNTIME" validate
.venv-gcp-billing/bin/python local/gcp_billing/collector.py \
  --environment LIVE --env-file "$PWD/.env.gcp_billing" \
  --runtime-root "$BILLING_RUNTIME" --source all render-views \
  > /tmp/uk-aq-billing-live-views.sql
```

Both `validate` and `render-views` are offline and do not apply SQL.

After separate LIVE approval and successful historical backfills, render
the schedule without installing it:

```bash
.venv-gcp-billing/bin/python local/gcp_billing/render_launchd.py \
  --repo-root "$PWD" --runtime-root "$BILLING_RUNTIME" \
  --python "$PWD/.venv-gcp-billing/bin/python" \
  --environment LIVE --env-file "$PWD/.env.gcp_billing" \
  > /tmp/co.uk.ukaq.gcp-billing.live.plist
plutil -lint /tmp/co.uk.ukaq.gcp-billing.live.plist
```

The shared template renders `co.uk.ukaq.gcp-billing.live`, daily
13:00, `RunAtLoad=false`, `--source all incremental` and LIVE-only logs.
It does not install, bootstrap or run launchd. TEST's installed plist and
private config.json are unchanged. Nothing in this preparation runs a
LIVE BigQuery query, MySQL mutation, backfill or collector.
