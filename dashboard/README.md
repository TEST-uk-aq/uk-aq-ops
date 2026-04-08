# UK AQ Ops Dashboard Front End

Static dashboard front end for GitHub Pages.

## Structure

- `index.html` - main single-page dashboard UI migrated from ingest local dashboard.
- `assets/dropbox-icon.svg` - icon asset used in storage coverage panels.
- `assets/config.js` - browser-safe runtime config generated per environment.

## Runtime config

`assets/config.js` is generated from environment variables.

Generate locally:

```bash
node scripts/dashboard/generate_dashboard_config.mjs
```

Relevant variables:

- `UKAQ_ENV_NAME`
- `UKAQ_API_BASE_URL`
- `UKAQ_DASHBOARD_TITLE`
- `UKAQ_DASHBOARD_SUBTITLE`
- `UKAQ_DEFAULT_REFRESH_SECONDS`
