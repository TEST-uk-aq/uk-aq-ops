# Cloudflare Worker Account/Deploy Audit (uk_aq_db_r2_metrics_api)

Date: 2026-05-19
Repo audited: `Chronic-Illness-Channel/uk-aq-ops`

## Executive Summary

The `uk_aq_db_r2_metrics_api` deploy workflow is currently wired to the **domain/cache Cloudflare credential pair** (`UK_AQ_DOMAIN_CLOUDFLARE_*`), not a dedicated DB/R2 worker credential pair.

Because of that, TEST-side work in this repo can redeploy the same worker name (`uk-aq-db-r2-metrics-api`) into the main/domain account when:

- a commit lands on `main` touching workflow path filters, or
- someone manually runs `workflow_dispatch`.

There are no environment guardrails (no GitHub `environment:` blocks, no branch/env assertions, no target-account preflight checks).

This is consistent with the observed behavior: LIVE DB/R2 metrics worker gets unexpectedly redeployed, then dashboard warns about stale external DB metrics until redeployed with expected settings.

## Current Deploy Map

| Worker / Flow | Workflow | Trigger | Worker Name Source | Cloudflare Credential Source | Working Dir | Deploy Command |
|---|---|---|---|---|---|---|
| DB/R2 metrics API | `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml` | `push` to `main` (path-filtered) + `workflow_dispatch` | `vars.UK_AQ_DB_R2_METRICS_API_WORKER_NAME` (default `uk-aq-db-r2-metrics-api`) | `vars.UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` + `secrets.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN` | `workers/uk_aq_db_size_metrics_api_worker` | `wrangler deploy --name <worker>` |
| Cache proxy (shared/main) | `.github/workflows/uk_aq_cache_proxy_deploy.yml` | `push` to `main` (path-filtered) + `workflow_dispatch` | `vars.UK_AQ_CACHE_WORKER_NAME` | `vars.UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` + `secrets.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN` (legacy fallback `UK_AQ_CACHE_*`) | `workers/uk_aq_cache_proxy` | `wrangler deploy --name <worker>` |
| Observs/AQI/Latest/Postcode R2 workers | corresponding `*_r2_api_worker_deploy.yml` | `push` to `main` + `workflow_dispatch` | worker-specific vars | generally `UK_AQ_R2_CLOUDFLARE_*` (postcode has fallbacks) | worker dir | `wrangler deploy --name <worker>` |

## Key Evidence (File References)

- DB/R2 metrics workflow uses domain credentials:
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:22)
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:23)
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:43)
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:44)

- DB/R2 metrics workflow trigger paths include shared files (can be touched by unrelated work):
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:8)
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:9)
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:10)

- DB worker default name is generic/non-env-specific in code:
  - [uk_aq_db_r2_metrics_api_worker_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml:21)
  - [wrangler.toml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_db_size_metrics_api_worker/wrangler.toml:1)

- Cache workflow uses same domain credentials family:
  - [uk_aq_cache_proxy_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_cache_proxy_deploy.yml:20)
  - [uk_aq_cache_proxy_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_cache_proxy_deploy.yml:21)

- No environment scoping in these workflows (no `environment:` job key).

- Target map includes ambiguous/generic Cloudflare keys alongside split keys:
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:16)
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:17)
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:18)
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:19)
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:150)
  - [uk_aq_github_env_targets.csv](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/config/uk_aq_github_env_targets.csv:151)

- Dashboard backend will derive history endpoints from DB-size API base if explicit history URLs are unset:
  - [uk_aq_dashboard_api.py](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py:69)
  - [uk_aq_dashboard_api.py](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py:360)
  - [uk_aq_dashboard_api.py](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py:373)

## Recent Run Evidence (GitHub Actions)

From `gh run list` / `gh run view --log` for `Deploy uk_aq_db_r2_metrics_api Worker`:

- Run `25993377774` (`2026-05-17`, event `push`, commit title: “Integrity and new dropbox backup with inventory build.”) deployed `uk-aq-db-r2-metrics-api` from this workflow.
- The linked commit (`d92d44b...`) touched `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml` and shared worker files, satisfying path filters.
- Manual run `26117527985` (`2026-05-19`, event `workflow_dispatch`) also deployed same worker name using domain credential variables.

This confirms redeploys occurred from normal repo activity, not only explicit “LIVE deploy” actions.

## Findings

### Confirmed issues

1. **Credential coupling issue**
- `uk_aq_db_r2_metrics_api` deploy uses `UK_AQ_DOMAIN_CLOUDFLARE_*` credentials (same family used by cache/domain workers), not dedicated DB/R2 worker credentials.

2. **No environment isolation in workflow execution**
- No GitHub Actions `environment:` key; workflows use repo-level vars/secrets directly.
- If this repo’s main branch is used for TEST development, pushes can redeploy resources tied to whatever credentials are configured.

3. **Trigger scope can fire from non-DB-metrics changes**
- Path filters include shared files (`workers/shared/r2_sigv4.mjs`, `workers/shared/uk_aq_r2_history_index.mjs`) and workflow file itself.

4. **Default worker naming is not environment-safe**
- Default `UK_AQ_DB_R2_METRICS_API_WORKER_NAME` is `uk-aq-db-r2-metrics-api`.
- No built-in guard to ensure TEST deploy names contain `test` or LIVE deploy names match production naming policy.

### Likely issues

1. **TEST activity could redeploy LIVE worker**
- If repo-level `UK_AQ_DOMAIN_CLOUDFLARE_*` points at main account and worker name is shared/live, TEST commits or manual dispatch can update LIVE worker code/secrets.

2. **Potential stale data after accidental redeploy**
- If deployed worker secrets/vars point to different Supabase project than expected, dashboard may receive stale/mismatched external DB-size windows and fallback warnings.

### Things that look safe

1. **Working directories are explicit and correct**
- DB/R2 workflow deploys from `workers/uk_aq_db_size_metrics_api_worker`.

2. **Deploy name is explicit via `--name`**
- Not relying solely on wrangler default name at deploy time.

### Unknowns requiring manual GitHub checks

1. In GitHub repo `uk-aq-ops`, verify current values/mappings (without exposing them):
- `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`
- `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`
- `UK_AQ_DB_R2_METRICS_API_WORKER_NAME`
- `UK_AQ_DB_SIZE_API_URL` (where consumed by dashboard backend)

2. Confirm whether TEST and LIVE are expected to be isolated by:
- separate repos (`CIC-test-uk-aq-ops` vs `LIVE-uk-aq-ops`), or
- one repo + branch/env rules.

3. If one repo is used for both, check whether branch protections prevent TEST commits on `main`.

## Direct Answers to Requested Questions

1. **Which workflow deploys DB/R2 metrics worker?**
- `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml`

2. **What triggers it?**
- `push` to `main` with path filters and `workflow_dispatch`.
- No schedule, no tags.

3. **Can TEST workflow route deploy LIVE worker?**
- Yes, if TEST activity occurs in this repo/main and credentials/worker name point to LIVE resources.

4. **Can LIVE workflow be triggered by TEST changes?**
- Yes, in a shared branch/repo model (`main` push + matching paths).

5. **Are worker names distinct between LIVE and TEST?**
- Not guaranteed by workflow. Default is shared name `uk-aq-db-r2-metrics-api`.

6. **Are wrangler environment names distinct (`--env test/prod`)?**
- No. No `--env` is used for this workflow.

7. **Are account IDs pulled from clearly separate secrets?**
- For this workflow: no. It uses `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` (variable) + domain token.

8. **Is shared cache account reused where it should not be?**
- For your stated desired model (TEST DB/R2 worker in separate account): yes, DB/R2 metrics workflow currently reuses domain/main credentials.

9. **Any ambiguous env vars?**
- Yes: generic `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` exist in target maps and are used by at least one worker workflow.
- Also split naming (`DOMAIN`, `R2`, `CACHE`) is inconsistent across workflows/docs.

10. **Missing explicit `--env test`/`--env production`?**
- Yes, none used.

11. **Any wrong working directory?**
- No evidence found; DB/R2 workflow working directory is correct.

12. **Any reliance on wrangler top-level defaults that may point LIVE?**
- Deploy command explicitly uses `--name`, and account comes from workflow input. Main risk is wrong workflow credential/name values, not wrangler default account.

13. **Could GitHub env/secret fallback cause cross-target deploy?**
- Yes. No job-level `environment:` scoping means repo-level vars/secrets are always used.

14. **Could dashboard/API URL point to shared LIVE worker?**
- Yes if `UK_AQ_DB_SIZE_API_URL` is set that way in runtime vars/secrets.
- Also if history URLs are unset, backend derives them from `UK_AQ_DB_SIZE_API_URL` origin.

15. **Protections preventing TEST from updating LIVE Cloudflare resources?**
- None found in workflow logic (no branch/env guardrails, no account/name preflight enforcement).

## Timeline Hypothesis (How TEST work could redeploy LIVE worker)

1. TEST-related commit landed on `main` touching files matched by DB/R2 workflow path filters (including shared files/workflow YAML).
2. `uk_aq_db_r2_metrics_api_worker_deploy.yml` auto-ran on `push`.
3. Workflow used `UK_AQ_DOMAIN_CLOUDFLARE_*` credentials and deployed `uk-aq-db-r2-metrics-api` (shared/live name/account context).
4. Worker code/secrets changed unexpectedly for LIVE expectations.
5. LIVE dashboard external DB-size API checks detected stale/lagging windows and switched to Supabase direct fallback with warnings.
6. Manual LIVE redeploy restored expected worker state.

## Recommended Fixes

### Priority 0 (Immediate safety)

1. Remove automatic `push` deploy for DB/R2 metrics worker (temporarily), keep `workflow_dispatch` only until safeguards are in place.
2. Set explicit worker name vars now:
- LIVE: `uk-aq-db-r2-metrics-api`
- TEST: `cic-test-uk-aq-db-r2-metrics-api`

### Priority 1 (Credential separation + guardrails)

1. Introduce dedicated DB/R2 worker credentials (no domain/cache reuse):
- `UK_AQ_DB_R2_METRICS_CLOUDFLARE_ACCOUNT_ID`
- `UK_AQ_DB_R2_METRICS_CLOUDFLARE_API_TOKEN`

2. Add workflow preflight checks (fail-fast):
- TEST deploy must target worker name containing `test`/`cic-test`.
- LIVE deploy must run only from `main` and expected GitHub environment.
- Prevent TEST account + LIVE worker-name combinations and vice versa.

3. Add explicit job `environment:` and split env secrets:
- `environment: test` vs `environment: live`.

4. Add concurrency guard per worker+env:
- e.g., `concurrency: uk-aq-db-r2-metrics-${{ inputs.target_env || 'live' }}`

### Priority 2 (Consistency and observability)

1. Add deployment summary output (masked):
- target env
- worker name
- account-id prefix/suffix mask
- git SHA
- timestamp

2. Tighten path filters:
- keep worker-specific paths only; remove shared libs unless truly required.

3. Standardize credential naming across workers:
- avoid generic `CLOUDFLARE_*` for multi-account resources.

## Suggested Minimal Patch Plan (non-breaking migration)

1. Update DB/R2 workflow to read new dedicated vars, with temporary fallback to old names for one migration window.
2. Add `workflow_dispatch` input `target_env` (`test|live`) and validate target combos.
3. Keep existing worker name var but enforce env-safe naming via preflight.
4. After validation in both envs, remove fallback to old `UK_AQ_DOMAIN_*` names.

## Manual Verification Checklist After Fix

1. Trigger TEST deploy manually; verify only test worker name/version changes.
2. Trigger LIVE deploy manually; verify only live worker name/version changes.
3. Confirm dashboard TEST `UK_AQ_DB_SIZE_API_URL` points to test worker host.
4. Confirm dashboard LIVE `UK_AQ_DB_SIZE_API_URL` points to live worker host.
5. Confirm no `push` from non-release/test work can mutate LIVE worker.

