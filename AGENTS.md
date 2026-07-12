# Agent Notes

## Main Repo

- `TEST-uk-aq-ops` is the main repo for this project and the default starting point for cross-repo work.
- Filesystem location: `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops`.

- `codeql-noarchive` in this repo currently scans `actions` and `javascript-typescript` only.
- If Python source files are added outside `archive/`, update `.github/workflows/codeql-noarchive.yml` to include `python` in the language matrix.
- When working on mirrored CIC-Test scripts, change the file in the current CIC-Test repo once and keep the sibling CIC-Test repo copy in sync.
- Do not inspect or modify any `LIVE` repo unless the user explicitly asks.
- Live propagation to the sibling live ops copy is handled by the sync script/workflow process outside this repo. Do not manually update the live ops copy unless the user explicitly asks for that repo to be changed.

## Codex operating mode
Default mode is code-only implementation.
Codex should:
- make focused code, schema, documentation, and test edits requested by the task;
- run only fast, local, non-destructive checks needed to verify the edit;
- provide a clear manual validation and deployment plan;
- include exact SQL, gcloud, wrangler, GitHub Actions, and Supabase commands for the user to run manually.
Codex must not, unless explicitly asked:
- run SQL against live/test Supabase databases;
- apply migration files;
- deploy Cloud Run services, Workers, or GitHub Actions workflows;
- run backfills, reconciliations, bulk jobs, or long-running data jobs;
- run broad external API fetches;
- repeatedly inspect cloud logs;
- make operational changes in GCP, Supabase, Cloudflare, R2, Dropbox, or GitHub settings.
When database or deployment work is needed, Codex should stop after producing:
1. files changed,
2. tests run,
3. exact manual commands,
4. expected outputs,
5. rollback notes,
6. post-deploy validation checklist.

## Permission levels
Unless the prompt says otherwise, use Level 1.
### Level 1 — Code only
Edit files and run small local/static tests. Do not touch external services or databases.
### Level 2 — Local validation
Level 1 plus local-only scripts/tests that do not call Supabase, GCP, Cloudflare, R2, Dropbox, or external APIs.
### Level 3 — Assisted operations
Prepare SQL, deploy commands, and validation commands, but do not run them.
### Level 4 — Execute operations
Only when explicitly requested in the prompt. May run database, deployment, or cloud commands.

## Backup Policy

- The Phase B observations backup is mandatory in this project.
- Never suggest disabling, skipping, or reducing Phase B backup coverage to lower egress or cost.
- Egress optimizations must preserve full backup integrity and intended backup behavior.

## Archive Execution Policy

- Archive paths are retired for active execution.
- Active scripts, workers, services, and runner-path defaults must only target non-archive paths.
- Do not add archive fallbacks for active runtime code paths.

### Pre-change Archive Requirement

* Before making a substantial or high-risk code change, archive the current version of every file that is expected to be changed.
* Archive copies must be placed under a dated directory inside `archive/`, using today’s date in `YYYY-MM-DD` format.
* Preserve the original relative path of each archived file inside that dated archive directory where practical, so the archived copy can be traced back to its source location.
* If additional files are discovered during the work and need to be changed, archive those files before changing them.
* A file only needs to be archived once per calendar day. If the same file has already been archived in today’s archive directory, do not create another duplicate archive copy for that file.
* Archive copies are for reference and rollback only. Do not wire archive paths into active runtime code, tests, scripts, workers, services, or default runner paths.
* Do not modify archived copies after they have been created, except to correct an accidental archive-path mistake before the main code change proceeds.


## Schema Placement Policy

- Canonical SQL DDL belongs in the schema repo (`/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-schema/schemas/...`), not only in ops worker directories.
- If ops introduces or changes Obs AQI tables, the change must also be reflected in:
  - `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql` (main Obs AQI schema), and
  - a schema-repo SQL file under `schemas/obs_aqi_db/` when a targeted apply file is needed.

## Source DAQI/index observations

- Do not treat source-provided DAQI/index observation rows as disposable derived noise. They are retained source observations and are used for later comparison against UK AQ calculated DAQI/AQI outputs.
- Breathe London source-provided index observation codes currently use `pm25index`, `pm10index`, and `no2index`. These rows belong in Supabase observations and R2 `history/v2/observations` when included by the v2 observations allow-list.
- Keep these source observations distinct from UK AQ calculated AQI/DAQI hourly output, which belongs under the separate aqilevels history paths.
- Weather/metadata-style observations such as humidity, pressure, and temperature are not automatically equivalent to source DAQI/index observations and may be excluded from public/history observations unless explicitly required.

## Environment Sync

- This repo has an env sync script: `scripts/uk_aq_sync_github_secrets.sh`.
- The script syncs `.env` keys to GitHub and packages `.env.supabase` into GitHub secret `SUPABASE_SECRETS_ENV`; ingest Supabase edge deploy workflows apply that payload via `supabase secrets set`.

## Implementation Reporting

- When changing code, schema, workflows, or config, always include clear implementation steps in the response.
- Implementation steps must state what changed, which files were changed, and any required apply/deploy/run commands.
- If no code changes were made, state that explicitly.

## R2/Cloudflare Cache Cost Policy

- For AQI history served via R2 + Cloudflare, assume cost is primarily driven by R2 operation counts (especially Class B reads) and Worker request volume, not R2 bandwidth egress.
- Prefer stable request URLs/params for normal traffic so Cloudflare cache can return warm-cache hits.
- Use cache-buster/version params only for diagnostics, forced-refresh actions, or explicit bypass-cache testing.
- When evaluating performance/cost changes, check cache-hit behavior (`CF-Cache-Status`) and distinguish cache-hit traffic from origin-fetch traffic.

## R2 History Index Byte-Stability Policy

- Payloads written by `workers/shared/uk_aq_r2_history_index.mjs` (the R2 history index manifests under `history/_index/...`) must be byte-identical run-to-run when the underlying source data has not changed.
- Every field — `generated_at`, key ordering, number formatting, optional fields — must be derived from the source manifests, never from wall-clock time, run IDs, or other run-scoped state.
- Why: any byte change rotates the R2 etag, which invalidates the etag-skip baseline in `scripts/backup_r2/build_backup_inventory.mjs`. A blanket churn forces the next inventory build to re-read every changed manifest (hours of `rclone cat` round-trips) and the Dropbox sync to re-upload every one (hours more, plus Dropbox write-rate throttling). Commit `2aa79d5` (2026-05-17) is the reference incident — moving `generated_at` to data-driven fixed it but produced a one-time multi-hour transition cost.
- When editing the index builder: treat byte-stability as load-bearing. If you add a new field, source it from the manifests; if you need a timestamp, derive it from `max(source.backed_up_at_utc)` or similar.
- If you have to make a non-data-driven change, expect and call out the one-time inventory + Dropbox sync cost in the PR description.

## Search Tool Preference
- Prefer `grep` for text search and file discovery; do not use `rg` unless explicitly requested.
