# WHO independent storage implementation record

Authority: system-docs `d799c1daf5da84187c012c474694132a53e26aed`.

## Active files changed

- `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `.github/workflows/uk_aq_who_2021_daily.yml`
- `config/uk_aq_github_env_targets.csv`
- `docs/runbooks/who-2021-storage-cutover.md`
- `scripts/who_2021/dataset.mjs`
- `tests/who_2021_dataset.test.mjs`
- `workers/shared/uk_aq_who_2021_storage.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/README.md`
- `workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/wrangler.toml`
- `workers/uk_aq_who_2021_daily/README.md`
- `workers/uk_aq_who_2021_daily/main.ts`
- `workers/uk_aq_who_2021_daily/report.ts`
- `workers/uk_aq_who_2021_daily/who_2021_daily_core.ts`
- `workers/uk_aq_who_2021_daily/who_2021_daily_core_test.ts`
- `workers/uk_aq_who_2021_daily/who_2021_parquet.ts`
- `workers/uk_aq_who_2021_daily/who_2021_parquet_test.ts`

## Exact pre-change archives

- `archive/2026-11-01/.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`
- `archive/2026-11-01/.github/workflows/uk_aq_who_2021_daily.yml`
- `archive/2026-11-01/config/uk_aq_github_env_targets.csv`
- `archive/2026-11-01/workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs`
- `archive/2026-11-01/workers/uk_aq_observs_history_r2_api_worker/wrangler.toml`
- `archive/2026-11-01/workers/uk_aq_who_2021_daily/main.ts`
- `archive/2026-11-01/workers/uk_aq_who_2021_daily/report.ts`
- `archive/2026-11-01/workers/uk_aq_who_2021_daily/who_2021_daily_core.ts`
- `archive/2026-11-01/workers/uk_aq_who_2021_daily/who_2021_parquet.ts`

## Validation

- Frozen `deno.lock` type check: publisher and report uploader passed.
- Existing WHO core/Parquet deterministic checks: 13 passed, 0 failed.
- `node tests/who_2021_dataset.test.mjs`: 3 passed, 0 failed. Covers source/config scoping, snapshot completion-last, changed-source/corrupt-destination failure preserving selector, approved isolated restore validation, and source-key-separated reader caching even with identical ETags. No network/data operation occurred in these mocked checks.
- Node syntax checks and side-effect-free dataset imports in Node and Deno passed.
- Both changed Actions YAML files parsed; Wrangler TOML parsed with explicit old-root configuration.
- Paired Schema SQL files and migration parsed with pglast, including changed PL/pgSQL bodies; canonical RPC bodies match. No SQL execution.
- Whitespace checks passed; source snapshots verified against the base revision.

The original Parquet test used JSR assertions, unavailable under this environment's network policy. It now uses the same native Node assertion dependency as the core tests; the tests ran successfully with type checking. No speculative/broad suite was run.

See [operator handover](who-2021-storage-cutover.md) for every deployment/operational phase, required variables and limitations. The required-root RPC transition must occur under writer exclusion before this caller runs. Missing explicit prefix, missing backup credentials or missing writer-exclusion confirmation prevents enabled publication. The migration/copy/restore utilities are never invoked automatically at deployment. Normal publication only invokes its owned dataset snapshot after successful R2 publication.

Known bounds: 10,000 objects, 8 MiB/object, 64 MiB total; encoded HTTP objects and embedded WHO-output reference transforms fail closed. Backup retries create a new immutable snapshot generation; copy retries reconcile the same approved unchanged plan. Restore writes only to a generated isolated TEST prefix. No deletion or serving-overwrite command exists. Actual snapshot, copy, restore, flags, bucket/lifecycle, scientific/public behaviour and cache cut-over acceptance remain pending authorised TEST operation.

No deployments, migration applies, workflow dispatches, WHO jobs, Prune, JSONgen, remote R2/Dropbox/database/Cloudflare mutations, schedule or retention changes, AQI retirement, LIVE changes or authoritative system-doc edits were performed.
