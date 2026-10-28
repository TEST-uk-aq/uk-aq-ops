# Local Dashboard Backend

This directory holds the migrated Python backend API used by the dashboard.

Primary file:

- `server/uk_aq_dashboard_api.py`
- `server/Dockerfile` (optional container build)

Run locally from repo root:

```bash
local/scripts/run_dashboard.sh
```

The frontend served by this backend is `dashboard/index.html`.

Legacy note:

- dashboard Cloud Run deploy workflow is retired and archived at:
  - `archive/2026-04-21_dashboard-backend-cloud-run-retired/uk_aq_dashboard_backend_cloud_run_deploy.yml`

## Local Accounts Access configuration

The local `/api/accounts/*` backend verifies the `Cf-Access-Jwt-Assertion` JWT
against Cloudflare Access signing keys. It requires these two TEST-only,
backend environment settings in this checkout's `.env`, which is loaded by
`local/scripts/run_dashboard.sh`:

- `UK_AQ_LOCAL_ACCOUNTS_ACCESS_ISSUER`: in Cloudflare Zero Trust, copy the
  team's Access issuer origin, for example the origin formed from the displayed
  team name and `cloudflareaccess.com`. Use the exact HTTPS origin with no path.
- `UK_AQ_LOCAL_ACCOUNTS_ACCESS_AUD`: in Zero Trust, open the existing **local
  dashboard** Access application, choose **Configure**, then under **Additional
  settings** copy its **Application Audience (AUD) Tag**. Do not use the hosted
  dashboard application's tag.

Cloudflare's [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
documents the team issuer origin and the Application Audience tag location.

Set both values only in this checkout's `.env`; do not put them in browser
configuration, shared code, committed templates, or `UK_AQ_OPS_ADMIN_HOSTNAME`.
That existing hostname remains the hosted dashboard setting. Until both values
are valid, private Accounts requests fail closed with
`ACCOUNTS_AUTH_NOT_CONFIGURED`. The local listener, remotely managed Tunnel,
hosted dashboard, and other local APIs do not use these settings.
