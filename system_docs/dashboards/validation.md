# Dashboard validation

## Pre-deployment structural checks

Run only checks needed to establish that the dashboard artefacts and configuration are structurally viable:

```bash
node --check scripts/dashboard/generate_dashboard_config.mjs
npm --prefix workers/uk_aq_dashboard_online_api_worker run check
```

Also confirm that:

- `dashboard/assets/config.js` contains no secret values;
- the configured administrative hostname belongs to the configured zone;
- direct mode has its required Supabase URL and key;
- `UK_AQ_R2_HISTORY_VERSION` has an accepted value;
- all documented local entrypoints exist before they are advertised.

## TEST operational validation

Functional validation happens after deployment through real TEST operation.

Confirm that:

1. the hosted page loads through Cloudflare Zero Trust;
2. compatibility `/api/*` requests succeed on the same hostname;
3. the main dashboard, storage coverage and R2 connector count panels display current TEST data or explicit unavailable warnings;
4. connector and dispatcher writes remain confined to TEST;
5. the station snapshot v2 routes return station and row data independently for observations and AQI;
6. cache bypass parameters obtain a fresh response where supported;
7. no service key, bearer token or R2 credential appears in page source or browser responses;
8. the local dashboard starts from `local/scripts/run_dashboard.sh` and uses the TEST `.env` and port.

A missing optional upstream must produce a visible partial or unavailable state, not fabricated data.
