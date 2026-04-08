# Local Dashboard Backend

This directory holds the migrated Python backend API used by the dashboard.

Primary file:

- `server/uk_aq_dashboard_local.py`
- `server/Dockerfile` (Cloud Run image build)

Run locally from repo root:

```bash
local/scripts/run_dashboard_local.sh
```

The frontend served by this backend is `dashboard/index.html`.

Hosted deployment:

- `.github/workflows/uk_aq_dashboard_backend_cloud_run_deploy.yml`
