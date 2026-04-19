# UK AQ GCP Cost Reduction Checklist

This checklist is for immediate Cloud Run/Scheduler cost control without changing ingest cadence below 1 minute.

## 1) Deploy low-risk dashboard reductions first

1. Deploy `Deploy UK AQ Dashboard Backend Cloud Run Service`.
2. Deploy `Deploy UK AQ Ops Dashboard API Worker`.
3. Verify Worker cache headers on read routes:
   - `X-UKAQ-Worker-Cache: HIT|MISS|BYPASS`
4. Verify dashboard still works with `Force Refresh` and `Refresh R2 metrics`.

## 2) Validate spend impact (same day)

1. Billing report: group by service, compare `Cloud Run` daily cost before/after deploy.
2. Cloud Run metrics: request count and container instance time for `uk-aq-dashboard-backend`.
3. Confirm no increase in error rate on `/api/dashboard` and `/api/r2_metrics`.
4. Secret Manager: verify `Secret Manager Secret Access Operations` drops after deploy
   (optional secrets are now only mounted when configured).

## 3) Pause non-essential scheduler jobs (only where safe)

Use this only for jobs that have another primary scheduler or non-critical purpose.

```bash
PROJECT_ID="astute-lyceum-484111-k5"
REGION="europe-west2"

# Example: DB-size logger (safe when local pg_cron is primary)
gcloud scheduler jobs pause uk-aq-db-size-logger-hourly \
  --project "$PROJECT_ID" \
  --location "$REGION"
```

Re-enable:

```bash
gcloud scheduler jobs resume uk-aq-db-size-logger-hourly \
  --project "$PROJECT_ID" \
  --location "$REGION"
```

## 4) Do not pause without explicit owner check

- `uk-aq-sos-trigger`
- `uk-aq-openaq-safety-trigger`
- `uk-aq-breathelondon-trigger`
- `uk-aq-scomm-trigger`

These support connector ingest reliability and can affect data freshness if paused.

## 5) One-week follow-up

1. Keep dashboard backend at `max-instances=1`.
2. If Cloud Run remains high, migrate high-traffic read routes fully to Worker cache-first logic.
3. Keep write/admin paths on Cloud Run.
