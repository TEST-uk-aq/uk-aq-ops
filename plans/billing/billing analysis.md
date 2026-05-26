No code/config files were changed. This was investigation-only.

## UK AQ GCP Cost Report (As of May 26, 2026)

### Executive summary
- You have **real but manageable cost risk**.
- Biggest cost driver in your historical real data is **Cloud Run** (compute + egress), not Pub/Sub or BigQuery.
- You are already using a low-cost pattern (backend/scheduled + Cloudflare/R2 delivery), but:
  - Scheduler job count and Secret Manager versions create predictable baseline charges.
  - Old project still has active billable footprint and is likely your biggest immediate savings opportunity.

---

## 1) New project inventory (`project-53835517-a266-48e3-8d9`)

### Cloud Run
12 services deployed, all with low-cost settings:
- `maxScale=1`
- `minScale` unset (effectively 0)
- `concurrency=1`
- small CPU/memory in most services
- no `allUsers` invoker found

### Cloud Scheduler
14 jobs in `europe-west2`:
- 13 enabled, 1 paused (`uk-aq-openaq-safety-trigger`)
- approx trigger volume when enabled set runs: ~72,960 invocations/month

### Pub/Sub
- Topic: `uk-aq-observs-observations`
- Subscriptions:
  - `uk-aq-observs-observations-sub`
  - `uk-aq-latest-snapshot-sub`

### Other
- Cloud Tasks queue: `uk-aq-openaq-trigger-queue`
- Artifact Registry repo: `uk-aq-cic-test1` (~482.7 MB)
- Secret Manager: 13 secrets (1 version each currently)
- Eventarc: disabled
- Cloud Functions: disabled
- Cloud Build triggers: none listed
- Logging sinks: default only
- Buckets: none listed

---

## 2) Runtime flow (cost-relevant)

1. Scheduler invokes Cloud Run services with OIDC service accounts.
2. Ingest services call external APIs (OpenAQ, Sensor Community, UK-AIR SOS, Breathe London).
3. Ingest publishes observations to Pub/Sub.
4. `uk-aq-observs-pubsub-writer` consumes base subscription.
5. `uk-aq-latest-snapshot-builder` consumes dedicated subscription and writes to R2.
6. Ops services do prune/retention/backup/partition/timeseries tasks (DB + R2 + Dropbox paths).

Cost implications:
- Frequent Scheduler runs drive Cloud Run request/CPU/memory/log volume.
- Cloud Run outbound to internet/non-GCP storage can generate egress charges.
- R2/Dropbox writes are egress from GCP.

---

## 3) Free-tier posture (new project)

| Service | Current posture | Likely status |
|---|---|---|
| Cloud Run | Good scale-to-zero settings | Probably free-to-low-cost, but depends on runtime + egress |
| Cloud Scheduler | 14 jobs | Likely billable (beyond 3 free jobs/account) |
| Pub/Sub | Small topology (1 topic, 2 subs) | Probably free/very low |
| Cloud Tasks | Single queue | Probably free/very low |
| Artifact Registry | Near 0.5 GB | Watch (may cross free threshold soon) |
| Secret Manager | 13 active versions | Likely small billable amount |
| BigQuery | No active export/usage seen in new project | Probably free |

---

## 4) Old project billing evidence: `astute-lyceum-484111-k5`

### Access and project status
- Account switched successfully to `cic-test2@sleepercar.co.uk`.
- Billing enabled and attached to billing account `015035-52C6FD-10F756`.

### Billing export
- Dataset exists: `gcp_billing_export` (in old project, `europe-west2`)
- Tables:
  - `gcp_billing_export_v1_015035_52C6FD_10F756` (partitioned daily)
  - `gcp_billing_export_resource_v1_015035_52C6FD_10F756` (partitioned daily)
- Table sizes are small (~50 MB and ~64 MB), so storage/query cost risk from export itself is low.
- BigQuery transfer config found: `Pricing BigQuery Transfer`, **disabled**.

### Old project active resources
- Cloud Run services: 13
- Scheduler jobs: 14 (**all paused**, but paused jobs still bill)
- Pub/Sub: 1 app topic + container-analysis topics
- Cloud Tasks queue: 1
- Artifact Registry repo: ~4.6 GB
- Secret Manager: 20 secrets, ~337 versions total

### Actual observed costs (from billing export)
- Last 7 days: **£2.8060**
- Last 30 days: **£10.3006**
- Last 60/90 days: **£11.9211**

Last 30 days by service:
- Cloud Run: **£8.0476**
- Secret Manager: **£1.2717**
- Cloud Scheduler: **£0.7529**
- Artifact Registry: **£0.2272**
- Cloud Storage: **£0.0012**
- BigQuery / PubSub / Tasks / Logging: **£0.0** in this window

Cloud Run SKU details (last 30):
- CPU request-based: largest component
- Memory request-based: smaller
- Network egress SKUs: meaningful (~£1.74 combined)

BigQuery billing-export cost:
- Effectively **£0.00** in observed data window.

---

## 5) Cost risk assessment

### Biggest risks
1. **Cloud Run usage + egress** (largest proven cost source)
2. **Old project still incurring recurring charges**
3. **Scheduler job count** (charged per job even when paused)
4. **Secret Manager version accumulation**
5. **Artifact Registry storage creep**

### Lower risks right now
- Pub/Sub and Cloud Tasks (observed as near-zero)
- BigQuery billing export itself (currently tiny footprint and no meaningful billed cost)

---

## 6) Projected future cost savings (high-level model)

Using your old project’s real 30-day baseline (£10.30/month) as the anchor.

| Recommendation | Expected monthly saving | Why this is high/medium/low impact |
|---|---:|---|
| Fully retire old project runtime footprint (if no longer needed) | **~£8–£10/month** | Removes most Cloud Run + Scheduler + Secret Manager + Artifact storage from old project |
| Keep public traffic off GCP (Cloudflare/R2-first), reduce direct Cloud Run egress | **~£0.8–£1.4/month** | Old data shows non-trivial Cloud Run network egress component |
| Reduce non-essential Cloud Run invocations/retries (without changing required 1-min polling where needed) | **~£1–£2.5/month** | CPU/memory request-based costs were largest SKU |
| Scheduler job consolidation (14 -> near 3 where feasible) | **~£0.5–£0.8/month** | Directly reduces per-job charges |
| Secret Manager version hygiene (destroy stale active versions) | **~£0.3–£1.2/month** | Old project shows version storage cost accumulation |
| Artifact Registry cleanup policy | **~£0.1–£0.3/month** | Small but steady |

### Biggest savings levers
- `#1` Decommissioning old project resources
- `#2` Reducing Cloud Run compute/egress
- `#3` Secret version cleanup over time

---

## 7) Final recommendation

### Verdict
- For the **new project alone**, you are likely in **low monthly cost territory**, but not guaranteed zero.
- For your **overall situation**, there is **real cost leakage** because the old project is still billing and Cloud Run is active there.

### Top 5 checks first
1. Confirm old project is still needed at all.
2. Check old project Cloud Run request sources (who is still calling it).
3. Review old project Secret Manager version sprawl and destroy stale versions.
4. Apply Artifact Registry cleanup policies (old + new).
5. Verify new project Cloud Run billable time and egress in Billing Reports by SKU.

### Top 5 near-zero-cost actions
1. Retire old project runtime stack (if migration is complete).
2. Keep new project Cloud Run min instances at 0 (already good) and avoid anonymous invoker.
3. Limit high-frequency jobs to only what is operationally necessary.
4. Add retry/loop safeguards for Cloud Tasks/PubSub consumers.
5. Keep R2/Cloudflare delivery path as default for public data access.

---

## Sources
- Cloud Run pricing: https://cloud.google.com/run/pricing  
- Cloud Scheduler pricing: https://cloud.google.com/scheduler/pricing  
- Pub/Sub pricing: https://cloud.google.com/pubsub/pricing  
- Cloud Tasks pricing: https://cloud.google.com/tasks/pricing  
- Artifact Registry pricing: https://cloud.google.com/artifact-registry/pricing  
- Cloud Build pricing: https://cloud.google.com/build/pricing  
- Secret Manager pricing: https://cloud.google.com/secret-manager/pricing  
- BigQuery pricing: https://cloud.google.com/bigquery/pricing  
- Free-tier overview: https://docs.cloud.google.com/free/docs/free-cloud-features