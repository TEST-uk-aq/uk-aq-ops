# Cloudflare Worker account and deployment audit

> **Historical audit, partly resolved.** This report records the repository state on 19 May 2026 and is not an active deployment contract. Use the current workflow and the future `system_docs/monitoring/` contract for present behaviour.

- Audit date: 19 May 2026
- Original repository context: `Chronic-Illness-Channel/uk-aq-ops`
- Audited component: `uk_aq_db_r2_metrics_api`

## Original finding

At the time of the audit, the DB/R2 metrics Worker workflow used the domain/cache Cloudflare credential family and a generic Worker name. TEST-side changes could therefore redeploy a Worker in the account selected by the repository-level credentials.

The audited workflow had:

- `push` and `workflow_dispatch` triggers;
- shared-file path filters that could be touched by unrelated R2 work;
- no GitHub Actions `environment:` scope;
- no target-account preflight;
- no TEST/LIVE naming assertion;
- a generic default Worker name.

The main risk was configuration coupling rather than the Wrangler working directory. The workflow explicitly selected its working directory and Worker name, but the configured account, credentials and name could still identify the wrong environment.

## Current disposition

Inspection on 17 July 2026 shows that the active workflow now includes:

- dedicated DB/R2 metrics credential variable names;
- `UK_AQ_DB_R2_METRICS_TARGET_ENV`;
- a guard that requires a TEST-style Worker name for a TEST target and rejects a TEST-style name for a LIVE target;
- an explicit masked deploy-target summary;
- required `UK_AQ_R2_HISTORY_VERSION` validation.

The original risk is therefore **partly resolved**.

The following concerns remain visible in the current workflow:

- there is still no GitHub Actions `environment:` job scope;
- shared R2 files remain in the automatic trigger paths;
- the default Worker name is still generic;
- the target-environment naming guard is effective only when `UK_AQ_DB_R2_METRICS_TARGET_ENV` is set;
- generic `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` values are preferred before the dedicated fallback names.

## Historical recommendations

The audit recommended:

1. separate TEST and LIVE Worker names;
2. separate or clearly scoped Cloudflare credentials;
3. a target-account and environment preflight;
4. narrower automatic triggers where practical;
5. explicit environment protection for sensitive deployments;
6. removal of ambiguous generic credential fallbacks after migration.

Some of these recommendations have been implemented, while others remain open design choices.

## Current evidence paths

- `.github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml`
- `workers/uk_aq_db_size_metrics_api_worker/`
- `config/uk_aq_github_env_targets.csv`
- `local/dashboard/server/uk_aq_dashboard_api.py`

This file is retained as historical evidence of the deployment-isolation problem. It MUST NOT be used as a current list of workflow line numbers or current environment values.
