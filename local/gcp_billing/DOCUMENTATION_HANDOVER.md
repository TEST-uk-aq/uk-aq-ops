# Chat-mode documentation handover — TEST GCP billing

Prepared 14 October 2026. This is an implementation handover, **not** an
authoritative contract change or evidence of deployment/acceptance.
No file in `uk-aq-system-docs` was edited.

## Behaviour and contract boundary

The existing `system_docs/gcp_billing/contract.md` and September plan reserve
Standard for normal financial reporting and allow Detailed for separate
resource investigations. The requested implementation keeps that boundary:
Standard totals never depend on or add Detailed rows. The new Detailed path is
an explicitly separate investigation extension; document its concrete schema,
archives, independent export-time watermark and resource report semantics before
activation. Do not describe Detailed as a replacement or additional charge to
Standard. If policy intends Detailed to become normal authoritative reporting,
that would require an intentional contract revision; this implementation does
not do that.

Record the following implemented semantics in the billing area when appropriate:

- Canonical `daily_costs` and separate `resource_daily_costs`; no environment
  columns. The source-kind metadata key separates independent cursors, watermarks
  and attempts. MySQL is derived, never the upstream authority.
- Full affected-day recomputation at a fixed export-time cutoff, inclusive
  two-hour export overlap by default, and no recent-usage-date filter hiding old
  corrections. Source mutation without a new export_time requires explicit
  refresh, as incremental detection cannot observe it.
- Per-row BIGNUMERIC half-away-from-zero rounding to signed currency micros;
  credits round individually, net = gross + signed credits. Names and nullable
  upstream project/resource identities are retained; CSV has explicit null flags.
- CSV gzip is the single pinned archive generation. The existing standalone local
  runtime has no supported Parquet writer; no Arrow dependency is introduced.
- Required daily/report/prepared-evidence files publish before the SQL watermark
  decision. Renames are atomic per file; a local journal plus committed sync_runs
  decision recovers interruption. Full cross-file/database atomic visibility is
  not promised. Success evidence is annotated only after commit and is repaired
  on restart; a failed run never appends a success record.
- All-history daily/monthly (usage and invoice separately)/service/SKU summaries;
  separate Detailed Cloud Run daily resource/SKU report with explicit unattributed
  rows. Currency groups are never mixed. Initial-backfill reports are partial
  until the relevant watermark is non-null. Recent costs remain provisional.
- Bounded initial date batches, history discovery and retained earliest actual
  source date, source binding hashes, refresh commands, safe failure codes and
  bounded MySQL run history. Billing facts and Dropbox archives are not pruned.
- Per-query dry-run reservation and maximum_bytes_billed plus invocation-wide
  budget. Actual jobs are capped at their reservation, which is retained even if
  their result is unavailable. No automatic whole-query job replay. No Cloud Run
  infrastructure or dashboard trigger.

## Files and ownership

`uk-aq-schema`:

- `schemas/local_mysql/gcp_billing.sql`: canonical desired MySQL state (four
  InnoDB tables, signed BIGINT micros, logical hash keys, reporting indexes).
- `schemas/local_mysql/gcp_billing_grants_test.sql`: explicit per-table TEST
  writer and optional reader grants, no DDL/global/LIVE grants or secrets.
- `schemas/CANONICAL_APPLY_ORDER.md`: separate local MySQL creation route. No
  duplicate migration is needed for a domain without pre-existing tables.

`uk-aq-ops`:

- `local/gcp_billing/{collector,configuration,queries,publication,reports}.py`:
  collector, offline view renderer, binding/isolation, recovery and summaries.
- `local/gcp_billing/config.test.example.json`, `requirements.txt`: explicit local
  config and standalone pinned direct dependencies. No GitHub env keys added;
  environment-target catalogue unchanged. Existing CodeQL already scans Python.
- `local/gcp_billing/render_launchd.py` and
  `local/launchd/co.uk.ukaq.gcp-billing.test.plist.template`:
  render-only daily 13:00 MacBook Pro TEST job (`RunAtLoad=false`).
- `local/gcp_billing/README.md`: manual commands, discovery, budgets, format,
  grants, recovery, rollout, rollback and real TEST acceptance.

All active code is new; no existing implementation required a pre-change archive
snapshot. No authoritative documentation, LIVE repo, cloud resource, database or
Dropbox runtime was changed.

## Source discovery and deployment implications

User-supplied TEST dataset:
`project-53835517-a266-48e3-8d9.gcp_billing_export`.
User-supplied earliest available usage date: **1 May 2026**.
The runtime requires that boundary for Standard and records Detailed's actual
boundary independently (it may start later). Keep the export project/dataset to
preserve history. Do not claim upstream history before 1 May.

No GCP identity was configured in this workspace, so account ID, table names,
location, view existence, actual export-time behaviour, partitioning and expected
TEST project presence were **not remotely verified**. The example requires those
values and refuses unresolved placeholders. The operator runbook lists bounded,
read-only metadata/discovery steps. Resolve them before deployment; do not infer
an account from the historical May investigation or access LIVE for comparison.

MySQL 8.0.16+ with an explicit local socket/database and restricted writer is
required. Google credentials and MySQL password live in a private mode-700 TEST
runtime outside Git/Dropbox; credential files are mode 600. The command accepts
TEST only. A later LIVE rollout requires separately authorised implementation
and config/grants/templates after TEST acceptance, not an edited environment flag.
Stable normalising view DDL is rendered for administrator review/apply; the
collector itself has no cloud mutation or schema apply path. No view was created.

## Structural evidence and remaining acceptance

Before deployment, checked Python syntax, CLI argument structure, JSON and plist
parsing/rendering, pinned SDK installation/import/configuration API shape, MySQL
CREATE TABLE SQL parsing, BigQuery view/aggregate/query shape, collector/schema
column agreement, TEST-only grant scope and Git whitespace. SQL parser support
for MySQL GRANT is incomplete; grants receive a separate explicit scope/shape
review rather than a false parser-success claim. No MySQL server or BigQuery
execution was used. No synthetic fixtures, new automated test suite, cloud
functional checks or broad repository suites were added/run.

After separately authorised deployment, use real TEST operations to establish
history coverage, repeat-run idempotency, Standard service/SKU reconciliation,
Detailed resource attribution/reconciliation independently, late correction
refresh, archive/MySQL convergence, failure recovery and no LIVE writes. Do not
claim natural correction/failure acceptance until observed. Keep the billing
area's future/not-deployed status until the deployment/acceptance evidence exists.

Exact apply/backfill/refresh/render commands and rollback notes are in the Ops
README. Implementation stops at working-branch commits and review PRs targeting
main; merging, schema application, views, backfills, Dropbox writes and launchd
activation are outside the current authorisation.


## Environment-neutral promotion preparation (14/10/2026)

The TEST collector now takes explicit TEST or LIVE source and target boundaries,
with either existing private config.json or literal private .env input.
Environment-specific BigQuery job labels, MySQL locks, archive evidence and
report headings derive from configuration; source/account/view and archive
identity checks are retained. The generic launchd template renders a separate
13:00 service per environment, while the installed TEST plist is unchanged.

The TEST Schema repo now includes `gcp_billing_grants_live.sql` for manual
promotion alongside the unchanged canonical `gcp_billing.sql`. The exact
source copy list and private LIVE configuration are in `README.live.md`.
Only TEST repositories were changed. No source archives are to be copied into
LIVE. The separate LIVE Dropbox *billing-data archive* remains a required
part of the original billing contract. No LIVE backfill or remote apply ran.
