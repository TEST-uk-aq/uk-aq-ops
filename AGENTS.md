# Agent Notes

- `codeql-noarchive` in this repo currently scans `actions` and `javascript-typescript` only.
- If Python source files are added outside `archive/`, update `.github/workflows/codeql-noarchive.yml` to include `python` in the language matrix.
- When working on mirrored CIC-Test scripts, change the file in the current CIC-Test repo once and keep the sibling CIC-Test repo copy in sync.
- Do not inspect or modify any `LIVE` repo unless the user explicitly asks.

## Backup Policy

- The Phase B observations backup is mandatory in this project.
- Never suggest disabling, skipping, or reducing Phase B backup coverage to lower egress or cost.
- Egress optimizations must preserve full backup integrity and intended backup behavior.

## Archive Execution Policy

- Archive paths are retired for active execution.
- Active scripts, workers, services, and runner-path defaults must only target non-archive paths.
- Do not add archive fallbacks for active runtime code paths.

## Schema Placement Policy

- Canonical SQL DDL belongs in the schema repo (`.../CIC-test-uk-aq-schema/schemas/...`), not only in ops worker directories.
- If ops introduces or changes Obs AQI tables, the change must also be reflected in:
  - `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql` (main Obs AQI schema), and
  - a schema-repo SQL file under `schemas/obs_aqi_db/` when a targeted apply file is needed.

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
