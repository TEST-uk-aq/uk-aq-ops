# WHO output-prefix implementation record

Authority: TEST system-docs `4c873cf18260698cc42faf1123665059b878be06`.
This replaces the earlier SQL/snapshot design in Ops PR #162.

## Final scope

- Shared required `UK_AQ_WHO_2021_R2_PREFIX` validation, no implicit root.
- Publisher-only translation of validated legacy SQL Parquet output keys; all
  destination validation, comparisons, logical hashes, PUTs and reported keys use
  the translated batch. Explicit old-root configuration preserves current keys.
- Configured dated/latest JSON paths and diagnostic templates, with unchanged
  Parquet-before-dated-JSON-before-latest publication and scientific rows.
- Existing authenticated summary reader uses the same root and includes its full
  physical source key in its existing cache identity. Public routes/behaviour stay.
- Minimal Actions/Worker configuration: the WHO workflow gains **one env entry**;
  deployment wiring validates/passes the same variable. No schedule, mode,
  concurrency, database, credential, health or report-upload changes.

The unchanged SQL RPC retains its six arguments and legacy key templates. No
`p_output_prefix`, new interface, grant change, SQL definition or migration belongs
to this Ops change. **Schema PR #18 is superseded and should be closed without
merging.** It was left unchanged, and the Schema repository was not modified in
this task. This Ops PR has no Schema PR dependency.

Removed: `scripts/who_2021/dataset.mjs`, its snapshot/bootstrap/copy/restore
framework and `tests/who_2021_dataset.test.mjs`; mandatory backup exclusion flag,
post-publication backup call, Dropbox credential preconditions added for that
backup, and dataset-backup report/status fields. `report.ts` is byte-identical to
the pre-PR baseline, and the existing Dropbox processing-report uploader is
unchanged. No new dependency or backup system replaces the removed framework.
Normal canonical observation backup, Prune, JSONgen and DAQI/EAQI are untouched.

## Active changes relative to the PR base

- `workers/shared/uk_aq_who_2021_storage.mjs`
- `workers/uk_aq_who_2021_daily/main.ts`
- `workers/uk_aq_who_2021_daily/who_2021_daily_core.ts`
- `workers/uk_aq_who_2021_daily/who_2021_parquet.ts`
- `workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs`
- `.github/workflows/uk_aq_who_2021_daily.yml`
- `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `workers/uk_aq_observs_history_r2_api_worker/wrangler.toml`
- `config/uk_aq_github_env_targets.csv`
- Existing `who_2021_daily_core_test.ts` and `who_2021_parquet_test.ts`
- WHO publisher/reader README additions and these two runbook/record documents.

## Archives and validation

The eight still-relevant original pre-change copies under `archive/2026-11-01/`
are retained unchanged: the two affected workflows, configuration catalogue,
reader route/Wrangler, and publisher main/core/Parquet files. Today's original
copies are reused, not overwritten or supplemented with second daily copies.
The unnecessary `report.ts` archive addition is removed because that active file
no longer changes. No archive is used at runtime.

Structural checks: frozen-lock Deno type check of publisher/report uploader;
existing WHO core and Parquet deterministic checks (including identity mapping,
all three translated datasets, unchanged row payloads and rejected unexpected
SQL keys); Node syntax for shared resolver/reader; Actions YAML and explicit-root
Wrangler parsing; exact original-archive verification and whitespace/diff scope.
Results: 13 existing tests passed, 0 failed; frozen-lock type checks, Node
syntax/prefix checks, two Actions YAML files and old/new-root TOML checks passed.
Workflow comparison proves that only the prefix environment entry changed; report
generation/uploader and eight archives match their pre-PR bytes. No speculative
suite or operational acceptance run was introduced.

No implementation blocker is known. Before deployment, provision the explicit
old-root variable and verify the installed RPC remains six-argument; no schema
apply is required. Subsequent copy and reader/publisher switch need separate
approval and fresh object evidence. The [short cut-over procedure](who-2021-storage-cutover.md)
uses existing R2 tools and retains originals. Historical regeneration availability
must be established before any later approved retirement; it is not an exact-byte
backup claim.

No deployment, operational workflow, WHO run/backfill, database SQL, R2/Dropbox/
Cloudflare mutation, setting/schedule/retention change, LIVE work or authoritative
system-doc edit was performed. TEST Prune remains disabled.
