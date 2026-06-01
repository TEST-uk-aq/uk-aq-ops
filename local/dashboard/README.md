# Local Dashboard Backend

This directory holds the migrated Python backend API used by the dashboard.

Primary file:

- `server/uk_aq_dashboard_api.py`
- `server/Dockerfile` (optional container build)

Run locally from repo root:

```bash
local/scripts/run_dashboard_local.sh
```

The frontend served by this backend is `dashboard/index.html`.

Legacy note:

- dashboard Cloud Run deploy workflow is retired and archived at:
  - `archive/2026-04-21_dashboard-backend-cloud-run-retired/uk_aq_dashboard_backend_cloud_run_deploy.yml`
