# Dashboard operations

## Browser-safe configuration

Generate `dashboard/assets/config.js` with:

```bash
node scripts/dashboard/generate_dashboard_config.mjs
```

Supported browser-safe inputs are:

- `UKAQ_ENV_NAME`
- `UKAQ_API_BASE_URL`
- `UKAQ_DASHBOARD_TITLE`
- `UKAQ_DASHBOARD_SUBTITLE`
- `UKAQ_DEFAULT_REFRESH_SECONDS`
- `UKAQ_CONFIG_OUT_PATH`

No secret may be written into the generated file.

## Local operation

Create the repository virtual environment and install the local backend requirements before first use. Start the active local dashboard with:

```bash
local/scripts/run_dashboard.sh
```

The script reads the repository `.env`. TEST and LIVE operations must be run from their respective checkout.

## Hosted Pages deployment

Workflow:

```text
.github/workflows/uk_aq_ops_dashboard_pages_deploy.yml
```

The workflow:

1. generates browser-safe configuration;
2. assembles `dashboard/` and `station_snapshot/` into the Pages artefact;
3. deploys the artefact to the configured Cloudflare Pages project.

Primary deployment values are:

- `UK_AQ_CF_ACCOUNT_ID_UKAQ`
- `UK_AQ_CF_API_TOKEN_UKAQ`
- `UK_AQ_OPS_DASHBOARD_PAGES_PROJECT`

The workflow currently allows documented domain-credential fallbacks. Those fallbacks are deployment behaviour and must not be changed casually.

## Dashboard API Worker deployment

Workflow:

```text
.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml
```

It type-checks the Worker, validates the hostname and R2 history version, prepares the environment-specific Wrangler configuration, deploys the Worker, applies non-empty secrets, and deploys again with the final secret state.

Key routing values are:

- `UK_AQ_OPS_ADMIN_ZONE_NAME`
- `UK_AQ_OPS_ADMIN_HOSTNAME`
- `UK_AQ_OPS_DASHBOARD_API_WORKER_NAME`

Direct mode requires `SUPABASE_URL` and `SB_SECRET_KEY`. Other data-source credentials are optional only where the relevant dashboard feature can safely report unavailable data.

## Manual external setup

The repository cannot create every external control automatically. Operators may need to configure:

- the Cloudflare Pages custom domain;
- the `/api/*` Worker route;
- the Cloudflare Zero Trust application and policy;
- Worker secrets and GitHub variables;
- the local Cloudflare Tunnel credentials and DNS routes.

## Rollback

A hosted rollback should restore the previous Pages and Worker deployments together when their API compatibility changed. A local rollback should restore the previous repository revision and restart the relevant local service.
