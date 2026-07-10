# Deploy to Live: UK-AQ System

## Overview

This runbook covers two deployment modes:

- **Mode 1 – Blank Deploy**: live system is empty; full fresh deployment copying all data and code from test
- **Mode 2 – Sync Update**: live system is running; apply schema migrations and code changes without touching observation data

The live system is initially deployed behind Cloudflare Zero Trust at `uk-aq-beta.chronicillnesschannel.co.uk`. When promoted to public, it will move to `chronicillnesschannel.co.uk/uk-aq`.

**How the public URL switch works:** The GitHub org has `chronicillnesschannel.co.uk` as its Pages domain via the root repo. The live webpage repo is named `uk-aq`, so GitHub Pages automatically serves it at `chronicillnesschannel.co.uk/uk-aq/` once the custom domain is removed. To go public: remove the custom domain from the `uk-aq` repo in GitHub Pages settings (delete the CNAME file or clear the custom domain field) — the slug takes over immediately. No base-path issues: the app has no hardcoded root-absolute paths (`/api/`, `/assets/` etc.) so the sub-path works without code changes.

---

## Infrastructure Map

| Layer | Test | Live |
|---|---|---|
| Supabase core DB (ingestdb) | `nmgierafoeuxfkkscrln` | New project (provisioned in Phase 0) |
| Supabase obs_aqidb | `izumkxuxseyojjsmnapi` | New project (provisioned in Phase 0) |
| Cloudflare R2 | Separate Cloudflare account, test bucket names | Separate Cloudflare account, live bucket names |
| Cloudflare cache proxy | Same Cloudflare account; worker name includes `test` | Same Cloudflare account; worker name includes `LIVE` |
| GCP | `astute-lyceum-484111-k5` | Separate live GCP project |
| Dropbox root | `/CIC-Test` | `/Live` |
| GitHub repos | `CIC-test-uk-aq*` | `LIVE-uk-aq-*` |

---

## Versioning

Each repo has a `VERSION` file at its root (format: `MAJOR.MINOR.PATCH`, e.g. `1.0.0`).

How it gets used:
- Cloud Run Docker image tags: `$(cat VERSION)-$(git rev-parse --short HEAD)`
- Cloudflare workers: version injected into `wrangler.toml` binding before deploy
- Edge functions: `UK_AQ_APP_VERSION` set as Supabase secret at deploy time
- Git: tag each live commit with `v$(cat VERSION)` after deploy

**To bump the version:** edit the `VERSION` file in each repo, commit, and tag.

---

## Related Docs (existing)

- `system_docs/deploy_into_live/populate-live-core-db-from-test.md` — prerequisites and FK order for core DB import
- `system_docs/deploy_into_live/populate-empty-r2-from-dropbox.md` — R2 restore from Dropbox backup (alternative to R2-to-R2 copy)

---

---

# Mode 1: Blank Deploy

Use when the live system is empty and has no data. Do the phases in order.

---

## Phase 0 — Infrastructure Provisioning

All manual steps. Complete before running any code.

### 0.1 Create live Supabase core project (ingestdb)
- In Supabase dashboard: create new project (e.g. `uk-aq-live-core`)
- Region: `eu-west-1` (to match test)
- Note: project ref, project URL, `sb_publishable_*` key, `sb_secret_*` key, DB URL

### 0.2 Create live Supabase obs_aqidb project
- New project (e.g. `uk-aq-live-obsaqidb`)
- Region: `eu-west-1`
- Note: project ref, project URL, both keys, DB URL

### 0.3 Create live R2 bucket
- Same Cloudflare account as test R2
- New bucket (e.g. `uk-aq-history-live`)
- Create R2 API token (read+write) scoped to this bucket
- Note: bucket name, endpoint URL, access key ID, secret access key

### 0.4 Create live GCP project

**Live GCP project ID:** `project-44502c75-19dc-456a-800` (GCP-generated; 30-char max)
**Region:** `europe-west2`

This is a **separate** GCP project from test (`astute-lyceum-484111-k5`). All resources below must be created from scratch.

**Enable APIs:**
```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com \
  pubsub.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project=project-44502c75-19dc-456a-800
```

**Create service accounts:**
```bash
PROJECT=project-44502c75-19dc-456a-800
for SA in \
  github-actions-deploy-uk-aq \
  uk-aq-openaq-job \
  uk-aq-scomm-job \
  uk-aq-breathelondon-job \
  uk-aq-sos-job \
  uk-aq-observs-outbox-flusher \
  uk-aq-observs-pubsub-job \
  uk-aq-ops-job \
  uk-aq-scheduler-invoker; do
  gcloud iam service-accounts create $SA --project=$PROJECT
done
```

**Grant roles** (adjust per SA as required — this is the test pattern):
- `uk-aq-*-job` SAs: `roles/run.invoker`, `roles/secretmanager.secretAccessor`, `roles/pubsub.publisher` (where applicable)
- `uk-aq-observs-pubsub-job`: also `roles/pubsub.subscriber`
- `uk-aq-ops-job`: also `roles/cloudscheduler.admin`, `roles/run.admin`
- `github-actions-deploy-uk-aq`: `roles/run.admin`, `roles/artifactregistry.writer`, `roles/secretmanager.admin`, `roles/iam.serviceAccountUser`, `roles/cloudscheduler.admin`, `roles/pubsub.admin`

**Create Artifact Registry repo:**
```bash
gcloud artifacts repositories create uk-aq \
  --repository-format=docker \
  --location=europe-west2 \
  --project=project-44502c75-19dc-456a-800
```

**Create Pub/Sub topic and subscription** (can use same names as test — separate project, no collision):
```bash
gcloud pubsub topics create uk-aq-observs-observations \
  --project=project-44502c75-19dc-456a-800
gcloud pubsub subscriptions create uk-aq-observs-observations-sub \
  --topic=uk-aq-observs-observations \
  --ack-deadline=600 \
  --project=project-44502c75-19dc-456a-800
```

**Set up Workload Identity Federation for GitHub Actions:**
```bash
# Create pool
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --project=project-44502c75-19dc-456a-800

# Create OIDC provider (--attribute-condition is required by GCP)
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="attribute.repository_owner == 'mikehinford'" \
  --project=project-44502c75-19dc-456a-800

# Bind deploy SA to the live ingest GitHub repo
PROJECT_NUMBER=$(gcloud projects describe project-44502c75-19dc-456a-800 --format="value(projectNumber)")
gcloud iam service-accounts add-iam-policy-binding \
  github-actions-deploy-uk-aq@project-44502c75-19dc-456a-800.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/mikehinford/LIVE-uk-aq-ingest" \
  --project=project-44502c75-19dc-456a-800
```

The `GCP_WORKLOAD_IDENTITY_PROVIDER` GitHub variable is the full provider resource name in this format:
`projects/{PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider`

For this project (number `432607103288`):
```
projects/432607103288/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

**Cloud Run service names** can be identical to test (`uk-aq-openaq-ingest` etc.) — separate project means no collision.

### 0.5 Create live Dropbox folder
- Create `/LIVE` in Dropbox (or equivalent)
- This will be the value of `UK_AQ_DROPBOX_ROOT` in live envs

### 0.6 Set up live GitHub repos
- Create remote GitHub repos for:
  - `LIVE-uk-aq-ingest`
  - `LIVE-uk-aq-ops`
  - `LIVE-uk-aq-schema`
  - `LIVE-uk-aq-webpage`
- Link remotes to the local live dirs (see Phase 1)

### 0.7 Confirm beta URL is active
- `uk-aq-beta.chronicillnesschannel.co.uk` is already configured with Cloudflare Zero Trust
- Confirm DNS routes to the live Cloudflare cache proxy worker once deployed in Phase 7

### 0.8 Create Cloudflare Turnstile widget for live domain

The Turnstile site key is domain-scoped — the test widget will return error `110200` (invalid site key) on any other domain. A new widget must be created for the live domain.

1. Go to Cloudflare dashboard → **Turnstile** → Add widget
2. Name: e.g. `uk-aq-live`
3. Domains: add `uk-aq-beta.chronicillnesschannel.co.uk` (and `chronicillnesschannel.co.uk` for future public URL)
4. Widget type: **Managed**
5. Note the **Site Key** (public) and **Secret Key** (private)

These are used in two places:
- **Site key** → `UK_AQ_TURNSTILE_SITE_KEY` secret in the live **webpage** GitHub repo (injected into HTML at build time by `pages.yml`)
- **Secret key** → `UK_AQ_TURNSTILE_SECRET_KEY` secret in the live **ingest** GitHub repo (used by the cache proxy worker to verify tokens server-side)

---

## Phase 1 — Live Repo Setup

Sync code from test repos to live local dirs, then push to GitHub.

### 1.1 rsync test → live for each repo

Run from the `LIVE UK AQ Networks/` parent directory. Adjust paths as needed.

```bash
BASE="/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks"
EXCL='--exclude=.git --exclude=.env* --exclude=.venv --exclude=node_modules --exclude=archive --exclude=tmp --exclude=__pycache__ --exclude=*.pyc'

# Ingest
rsync -av $EXCL "$BASE/CIC-test-uk-aq-ingest/" "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ingest/"

# Ops
rsync -av $EXCL "$BASE/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops/" "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ops/"

# Schema
rsync -av $EXCL "$BASE/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/" "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-schema/"

# Webpage
rsync -av $EXCL "$BASE/CIC UK-AQ Webpage/CIC-test-uk-aq/" "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-webpage/"
```

### 1.2 Create VERSION files (initial: 1.0.0)

```bash
for DIR in "LIVE-uk-aq-ingest" "LIVE-uk-aq-ops" "LIVE-uk-aq-schema" "LIVE-uk-aq-webpage"; do
  echo "1.0.0" > "$BASE/LIVE UK AQ Networks/$DIR/VERSION"
done
```

### 1.3 Create live .env files

Copy test `.env` as a starting template, then update **all** environment-specific values:

Key values to change from test to live:
- `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SB_SECRET_KEY`, `SB_PUBLISHABLE_DEFAULT_KEY`, `SUPABASE_DB_URL` → live ingestdb values
- `OBS_AQIDB_SUPABASE_URL`, `OBS_AQIDB_SUPABASE_PROJECT_REF`, `OBS_AQIDB_SECRET_KEY`, `OBS_AQIDB_DB_URL` → live obs_aqidb values
- `GCP_PROJECT_ID`, `GCP_*_SERVICE_ACCOUNT` → live GCP values
- R2 bucket name + credentials → live R2 values
- `UK_AQ_DROPBOX_ROOT` → `/LIVE`
- `UK_AQ_CACHE_ALLOWED_ORIGINS` → live domain(s)
- Any secrets (tokens, API keys for new accounts) → live values

### 1.4 Find and update hardcoded test references

```bash
# Search for strings that reference test-specific identifiers
grep -r "CIC-Test\|cic-test\|nmgierafoeuxfkkscrln\|izumkxuxseyojjsmnapi" \
  "$BASE/LIVE UK AQ Networks/" --include="*.ts" --include="*.js" --include="*.py" \
  --include="*.yml" --include="*.toml" -l
```

Update any hardcoded test Supabase project refs, test bucket names, or test worker names found.

### 1.5 Set live webpage GitHub repo secrets (before first push)

The `pages.yml` workflow fires on every push to main and fails immediately if these secrets are absent. Set them in the live **webpage** repo before the first push.

Go to GitHub → `LIVE-uk-aq-webpage` → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | live ingestdb project ref (from Phase 0.1) |
| `SB_PUBLISHABLE_DEFAULT_KEY` | live ingestdb publishable key |
| `UK_AQ_TURNSTILE_SITE_KEY` | live Turnstile **site key** (from Phase 0.8) |
| `UK_AQ_AQI_HISTORY_BASE_URL` | `https://uk-aq-beta.chronicillnesschannel.co.uk/api/aq/aqi-history` |

### 1.6 Init git and push each live repo

```bash
for DIR in "LIVE-uk-aq-ingest" "LIVE-uk-aq-ops" "LIVE-uk-aq-schema" "LIVE-uk-aq-webpage"; do
  cd "$BASE/LIVE UK AQ Networks/$DIR"
  git init
  git add .
  git commit -m "Initial live beta deploy v0.1.0"
  git remote add origin <LIVE_GITHUB_REMOTE_URL>
  git push -u origin main
done
```

### 1.7 Sync GitHub secrets and variables (ingest/ops repos)

Use the sync script (ops repo) to push all env vars to GitHub:
```bash
cd "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ops"
./scripts/uk_aq_sync_github_secrets.sh
```

The mapping reference is `config/uk_aq_github_env_targets.csv`.

> **Note:** This script covers the ingest and ops repos. The webpage repo secrets (`UK_AQ_TURNSTILE_SITE_KEY`, `SUPABASE_PROJECT_REF`, `SB_PUBLISHABLE_DEFAULT_KEY`) are set manually — see Phase 1.5 above.

---

## Phase 2 — Schema Deploy

Apply full schema SQL to both live Supabase projects. No migrations needed — blank DB.

### 2.1 Deploy ingestdb schema

```bash
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_core_schema.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_raw_schema.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_aqilevels_schema.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_rpc.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_ops_schema.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_public_views.sql
psql $LIVE_SUPABASE_DB_URL < schemas/ingest_db/uk_aq_security.sql
```

> **Note:** `uk_aq_public` must exist in ingestdb (not just obs_aqidb) because it is listed in the PostgREST exposed schemas. If it is missing, PostgREST cannot build its schema cache and returns `PGRST002` for all requests.

### 2.2 Deploy obs_aqidb schema

```bash
psql $LIVE_OBS_AQIDB_DB_URL < schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql
```

### 2.2a Verify PostgREST schema exposure for obs_aqidb

The Operations dashboard daily task card reads `uk_aq_ops.daily_task_runs_dashboard` through PostgREST.  
If PostgREST does not expose `uk_aq_ops`, requests fail with `PGRST106` (`Invalid schema: uk_aq_ops`) even when the view exists.

1. In Supabase UI (live obs_aqidb): Data API -> Settings -> Exposed schemas
   Ensure both `uk_aq_public` and `uk_aq_ops` are exposed, then save.

2. Check effective `authenticator` PostgREST config overrides:

```sql
select
  d.datname,
  r.rolname,
  s.setconfig
from pg_db_role_setting s
join pg_roles r on r.oid = s.setrole
left join pg_database d on d.oid = s.setdatabase
where r.rolname = 'authenticator';
```

3. If a `datname='postgres'` row exists and `pgrst.db_schemas` does not include `uk_aq_ops`, update it:

```sql
alter role authenticator in database postgres
set pgrst.db_schemas = 'public,uk_aq_public,uk_aq_ops';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```

4. Validate from PostgREST using a service-role key and `Accept-Profile: uk_aq_ops` against:
   `/rest/v1/daily_task_runs_dashboard?select=run_id&limit=1`

Do not add `ALTER ROLE ... pgrst.db_schemas` statements to schema SQL files. Keep this as deployment/runbook configuration.

### 2.3 Verify

```sql
-- Run against live ingestdb
\dt uk_aq_core.*
\dt uk_aq_raw.*

-- Run against live obs_aqidb
\dt uk_aq_public.*
\dt uk_aq_observs.*
\dt uk_aq_aqilevels.*
```

Compare table counts to test. All tables should be present with no data.

### 2.4 Record bootstrap schema version

```sql
-- Run against both live DBs (if schema_migrations table exists)
INSERT INTO schema_migrations (version, applied_at, description)
VALUES ('1.0.0', now(), 'Initial live deploy from test schema');
```

---

## Phase 3 — Core DB Population

Copy `uk_aq_core` metadata from test to live, preserving all PKs.

**Prerequisite:** Keep `connectors.poll_enabled = false` throughout. Do not start any ingest until Phase 8.

See also: `system_docs/deploy_into_live/populate-live-core-db-from-test.md`

### 3.1–3.5 Run the copy script

Uses `psql \copy` (CSV) — works through the Supabase session pooler without requiring a direct DB connection. Handles export, import, `poll_enabled = false`, sequence reset, and validation in one pass.

**Required env vars:**
- `SUPABASE_DB_URL` — test ingestdb (source); already set in `.env`
- `LIVE_INGESTDB_SUPABASE_DB_URL` — live ingestdb pooler URL (dest)

```bash
# From ops repo root:
scripts/uk_aq_copy_core_to_live.sh

# To also copy uk_aq_raw.sos_station_uk_air_refs (station→UK Air ID mapping):
scripts/uk_aq_copy_core_to_live.sh --include-station-refs

# Dry-run (export only, no writes to live):
scripts/uk_aq_copy_core_to_live.sh --dry-run
```

**uk_aq_raw tables — what to copy and what to skip:**
- `sos_station_uk_air_refs`: copy with `--include-station-refs` (preserves station→UK Air ID mapping; avoids re-running station matching on first ingest)
- All `*_checkpoints` tables: skip — start empty, ingest rebuilds them
- `sos_site_register`, `laqn_site_register`: skip — repopulated from source on first ingest run
- `observation_rpc_metrics_minute`, `error_logs`: skip — operational/logs, start fresh

**obs_aqidb tables — no direct copy needed:**
- `uk_aq_public.*` mirror tables: populated by running `schemas/obs_aqi_db/uk_aq_core_mirror_rpcs.sql` against live obs_aqidb after this phase (see Phase 3.6 below)
- `uk_aq_observs.observations`: starts empty — populated by Phase 4 R2 restore + ongoing ingest
- `uk_aq_aqilevels.*`: starts empty — recomputed by the AQI hourly job once ingest is live

### 3.6 Populate obs_aqidb mirror tables

After the core copy completes, first deploy the mirror RPC functions to live obs_aqidb (these are what the sync script calls to write into obs_aqidb):

```bash
psql $LIVE_OBS_AQIDB_DB_URL < schemas/obs_aqi_db/uk_aq_core_mirror_rpcs.sql
```

Then run the sync script to copy `uk_aq_core.*` data from live ingestdb into live obs_aqidb. Run from the live ingest repo root with live env vars loaded:

```bash
# From LIVE-uk-aq-ingest repo root
SRC_SUPABASE_URL=$SUPABASE_URL \
SRC_SECRET_KEY=$SB_SECRET_KEY \
DST_SUPABASE_URL=$OBS_AQIDB_SUPABASE_URL \
DST_SECRET_KEY=$OBS_AQIDB_SECRET_KEY \
python3 scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py
```

Alternatively, trigger via `uk_aq_stations_daily.yml` → Run workflow on the live ingest repo (the workflow runs the same script with the same env vars).

Then verify:
```sql
-- Run against live obs_aqidb
SELECT count(*) FROM uk_aq_core.stations;
SELECT count(*) FROM uk_aq_core.timeseries;
SELECT count(*) FROM uk_aq_core.connectors;
```

Row counts should match live ingestdb `uk_aq_core` counts.

> **Important:** `uk_aq_core.timeseries` in obs_aqidb must be populated before the AQI hourly worker runs. The `timeseries_aqi_hourly` table has a FK to `uk_aq_core.timeseries(id)` — if the mirror is empty, every AQI insert will fail with a FK constraint violation.

---

## Phase 4 — R2 History Copy

Copy observation history from test R2 to live R2, then regenerate the core snapshot and rebuild indexes.

See also: `system_docs/deploy_into_live/populate-empty-r2-from-dropbox.md` (alternative: restore from Dropbox)

### 4.1 Configure rclone remotes (one-time setup)

Create two rclone remotes — one for test R2, one for live R2:

```bash
rclone config create uk_aq_r2_test s3 \
  provider=Cloudflare \
  access_key_id=<TEST_R2_ACCESS_KEY> \
  secret_access_key=<TEST_R2_SECRET_KEY> \
  endpoint=<TEST_R2_ENDPOINT>

rclone config create uk_aq_r2_live s3 \
  provider=Cloudflare \
  access_key_id=<LIVE_R2_ACCESS_KEY> \
  secret_access_key=<LIVE_R2_SECRET_KEY> \
  endpoint=<LIVE_R2_ENDPOINT>
```

### 4.2 Dry run first (one day)

```bash
rclone copy \
  uk_aq_r2_test:uk-aq-history-cic-test/history/v1/observations \
  uk_aq_r2_live:uk-aq-history-live/history/v1/observations \
  --include "day_utc=YYYY-MM-DD/**" \
  --dry-run --progress
```

Verify the expected files would be copied.

Note - rclone transfers files based on the file size and last modified time to determine whether a file needs to be copied or updated. (Deletes if not in source too.)

### 4.3 Copy observations and aqilevels

```bash
rclone copy \
  uk_aq_r2_test:uk-aq-history-cic-test/history/v1/observations \
  uk_aq_r2_live:uk-aq-history-live/history/v1/observations \
  --progress --transfers 8

rclone copy \
  uk_aq_r2_test:uk-aq-history-cic-test/history/v1/aqilevels/hourly \
  uk_aq_r2_live:uk-aq-history-live/history/v1/aqilevels/hourly \
  --progress --transfers 8
```

Do **not** copy `_index` files from test — they are environment-specific and will be rebuilt below.

### 4.4 Generate live core snapshot from live DB

Run against the live R2 bucket using live env vars:

```bash
cd "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ops"
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --report-out ./tmp/core_snapshot_live_$(date +%Y%m%d).json
```

### 4.5 Rebuild live index files

```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs --domain both
```

### 4.6 Validate

```bash
# Confirm day manifests exist
rclone ls uk_aq_r2_live:uk-aq-history-live/history/v1/observations/ | grep manifest | tail -5

# Confirm index files written
rclone ls uk_aq_r2_live:uk-aq-history-live/history/_index/
```

Check that `observations_latest.json`, `aqilevels_latest.json`, and `observations_timeseries_latest.json` are present.

---

## Phase 5 — Edge Functions Deploy

### 5.1 Link live Supabase project

```bash
cd "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ingest"
supabase link --project-ref <LIVE_INGESTDB_PROJECT_REF>
```

### 5.2 Set Supabase secrets

```bash
supabase secrets set --env-file .env.supabase
```

Also set `UK_AQ_APP_VERSION=$(cat VERSION)`.

### 5.3 Deploy all edge functions

Trigger the `supabase_edge_deploy.yml` workflow manually on the live ingest repo, or run locally:

```bash
supabase functions deploy --no-verify-jwt ingest_sos
supabase functions deploy --no-verify-jwt ingest_breathelondon
supabase functions deploy --no-verify-jwt ingest_sensorcommunity
supabase functions deploy --no-verify-jwt ingest_openaq
supabase functions deploy --no-verify-jwt ingest_erg_laqn
supabase functions deploy --no-verify-jwt uk_aq_latest
supabase functions deploy --no-verify-jwt uk_aq_stations_chart
supabase functions deploy --no-verify-jwt uk_aq_la_hex
supabase functions deploy --no-verify-jwt uk_aq_pcon_hex
supabase functions deploy --no-verify-jwt uk_aq_stations
supabase functions deploy --no-verify-jwt uk_aq_timeseries
supabase functions deploy --no-verify-jwt uk_aq_egress_monitor
supabase functions deploy --no-verify-jwt uk_aq_dispatch_polls
supabase functions deploy --no-verify-jwt uk_aq_cache_token
```

### 5.4 Verify

Check Supabase dashboard → Edge Functions. Each function should show a recent deploy timestamp.

---

## Phase 6 — Cloud Run Services Deploy

Deploy in the order shown — ops services first, ingest services last.

### 6.1 Configure live GCP project (one-time)

Complete Phase 0.4 before this step. Then add the following to the **LIVE-uk-aq-ingest** GitHub repo secrets and variables.

**GitHub Secrets** (repo settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SB_SECRET_KEY` | live Supabase service role key |
| `OBS_AQIDB_SECRET_KEY` | live obs_aqidb service role key |
| `OPENAQ_API_KEY` | live OpenAQ API key (different from test) |
| `BLONDON_COMMUNITIES_API_KEY` | same as test |
| `SB_UK_AQ_CRON_SECRET` | same as test |
| `DROPBOX_APP_KEY` | same as test |
| `DROPBOX_APP_SECRET` | same as test |
| `DROPBOX_REFRESH_TOKEN` | same as test |
| `CLOUDFLARE_API_TOKEN` | live CF token |
| `CLOUDFLARE_ACCOUNT_ID` | `e71024ada0d00539a056e80ffe095df3` |
| `SB_PUBLISHABLE_DEFAULT_KEY` | live Supabase publishable key |
| `SUPABASE_SECRETS_ENV` | contents of live `.env.supabase` |
| `GCP_SA_KEY` | live GCP SA key JSON (if not using WIF) |
| `UK_AQ_TURNSTILE_SECRET_KEY` | live Turnstile **secret key** (from Phase 0.8) — used by cache proxy worker to verify tokens |

**GitHub Variables** (repo settings → Secrets and variables → Variables):

| Variable | Live value |
|---|---|
| `GCP_PROJECT_ID` | `project-44502c75-19dc-456a-800` |
| `GCP_REGION` | `europe-west2` |
| `GCP_ARTIFACT_REPO` | `uk-aq` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/432607103288/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT` | `github-actions-deploy-uk-aq@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `SUPABASE_URL` | `https://wdbmpleeesfqnwgaaned.supabase.co` |
| `OBS_AQIDB_SUPABASE_URL` | `https://iirrazgwghsqorhsxfbh.supabase.co` |
| `UK_AQ_DROPBOX_ROOT` | `/LIVE` |
| `GCP_OPENAQ_JOB_SERVICE_ACCOUNT` | `uk-aq-openaq-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `GCP_SCOMM_JOB_SERVICE_ACCOUNT` | `uk-aq-scomm-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `GCP_BLONDON_COMMUNITIES_JOB_SERVICE_ACCOUNT` | existing `uk-aq-breathelondon-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` identity |
| `GCP_SOS_JOB_SERVICE_ACCOUNT` | `uk-aq-sos-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `GCP_OBSERVS_PUBSUB_SERVICE_ACCOUNT` | `uk-aq-observs-pubsub-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `GCP_OPS_JOB_SERVICE_ACCOUNT` | `uk-aq-ops-job@project-44502c75-19dc-456a-800.iam.gserviceaccount.com` |
| `GCP_OBSERVS_PUBSUB_TOPIC` | `uk-aq-observs-observations` |

**Workflow files to copy from test repo** (values come from secrets/vars — no edits needed):
- `uk_aq_openaq_cloud_run_deploy.yml`
- `uk_aq_scomm_cloud_run_deploy.yml`
- `uk_aq_blondon_communities_cloud_run_deploy.yml`
- `uk_aq_sos_cloud_run_deploy.yml`
- `uk_aq_observs_pubsub_cloud_run_deploy.yml`
- `uk_aq_ingest_poller_deploy.yml`
- `supabase_edge_deploy.yml`
- `uk_aq_observs_edge_deploy.yml`

### 6.2 Deploy ops Cloud Run services (from LIVE-uk-aq-ops)

Trigger each workflow via GitHub Actions → Run workflow, in this order:

1. `uk_aq_observs_outbox_flush_service_cloud_run_deploy.yml`
2. `uk_aq_observs_partition_maintenance_cloud_run_deploy.yml`
3. `uk_aq_db_size_logger_cloud_run_deploy.yml`
4. `uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml`
5. `uk_aq_prune_daily_cloud_run_deploy.yml`
6. `uk_aq_backfill_cloud_run` (deploy workflow)
7. `uk_aq_supabase_db_dump_backup_service_deploy.yml`

### 6.3 Deploy ingest Cloud Run services (from LIVE-uk-aq-ingest)

1. `uk_aq_blondon_communities_cloud_run_deploy.yml`
2. `uk_aq_sos_cloud_run_deploy.yml`
3. `uk_aq_openaq_cloud_run_deploy.yml`
4. `uk_aq_scomm_cloud_run_deploy.yml`

### 6.4 Set up Cloud Schedulers

Each service has a Cloud Scheduler trigger. Verify they are created by the deploy workflows, or create manually to match test configuration.

### 6.5 Verify

Check Google Cloud Console → Cloud Run. All services should show a green status. Check initial logs for startup errors.

---

## Phase 7 — Cloudflare Workers Deploy

### 7.1 Deploy cache proxy (live — no "test" in name)

```bash
cd "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ops/workers/uk_aq_cache_proxy"
# Update wrangler.toml: set live worker name (without "test" suffix)
# Set UK_AQ_CACHE_ALLOWED_ORIGINS to live domains
wrangler deploy
```

Or trigger via `uk_aq_cache_proxy_deploy.yml` with live secrets.

### 7.2 Deploy R2 API workers

Deploy in any order:
- `uk_aq_observs_history_r2_api_worker` (observations history)
- `uk_aq_aqi_history_r2_api_worker` (AQI history)
- `uk_aq_db_r2_metrics_api_worker` (DB/R2 metrics)
- `uk_aq_ops_dashboard_api_worker` (ops dashboard)

Each has a corresponding deploy workflow.

### 7.3 Update Cloudflare Zero Trust

Confirm `uk-aq-beta.chronicillnesschannel.co.uk` is configured to route through the live cache proxy worker (not the test one).

### 7.4 Verify

```bash
# Health check — should return JSON
curl -I https://uk-aq-beta.chronicillnesschannel.co.uk
```

---

## Phase 8 — Enable Ingest and Go-Live

### 8.1 Enable connectors

```sql
UPDATE uk_aq_core.connectors SET poll_enabled = true;
```

Or enable selectively by connector_code to roll out gradually.

### 8.2 Trigger a manual ingest run for each connector

Use `uk_aq_dispatch_polls` edge function or trigger each ingest edge function directly.

### 8.3 Check ingest is producing rows

```sql
SELECT connector_code, status, started_at, rows_written
FROM uk_aq_raw.uk_aq_ingest_runs
ORDER BY started_at DESC
LIMIT 20;
```

All connectors should show recent rows.

### 8.4 Check error logs

```sql
SELECT * FROM uk_aq_core.uk_aq_error_logs
ORDER BY created_at DESC LIMIT 20;
```

No unexpected errors.

### 8.5 Run stations daily workflow

Trigger `uk_aq_stations_daily.yml` manually to sync station metadata and mirror to obs_aqidb.

### 8.6 Test the website

Open `uk-aq-beta.chronicillnesschannel.co.uk` (Zero Trust login required).
Verify: map loads, stations show, data appears for recent days.

### 8.7 Confirm Phase B backup is enabled

```bash
# Verify UK_AQ_R2_HISTORY_PHASE_B_ENABLED=true in live env
grep PHASE_B "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ops/.env"
```

---

## Mode 1 Verification Checklist

Run these checks before calling the blank deploy complete:

- [ ] Both live Supabase projects have all expected schemas and tables
- [ ] Row counts for connectors / stations / timeseries match test
- [ ] Connector IDs, station IDs, timeseries IDs in live match test exactly
- [ ] Identity sequences advanced past max(id) on all tables
- [ ] R2 live bucket has day manifests for at least the last 30 days
- [ ] `history/_index` files present and readable: `observations_latest.json`, `aqilevels_latest.json`, `observations_timeseries_latest.json`
- [ ] `history/v1/core` snapshot written from live DB
- [ ] All 14 edge functions deployed and show recent deploy timestamp
- [ ] All Cloud Run services deployed and green in GCP console
- [ ] All Cloudflare workers deployed (cache proxy using live name)
- [ ] Ingest producing `uk_aq_ingest_runs` rows for each connector
- [ ] No spike in error logs
- [ ] Website at `uk-aq-beta.chronicillnesschannel.co.uk` loads and shows data
- [ ] `UK_AQ_R2_HISTORY_PHASE_B_ENABLED=true` confirmed in live
- [ ] Live repos tagged `v1.0.0` in git

---

## Switching to public URL (chronicillnesschannel.co.uk/uk-aq)

When promoting from beta (`uk-aq-beta.chronicillnesschannel.co.uk`) to the public sub-path:

1. **Update `UK_AQ_AQI_HISTORY_BASE_URL`** in `LIVE-uk-aq-webpage` GitHub secrets:
   - Change from: `https://uk-aq-beta.chronicillnesschannel.co.uk/api/aq/aqi-history`
   - Change to: `https://chronicillnesschannel.co.uk/api/aq/aqi-history`

2. **Update `UK_AQ_CACHE_ALLOWED_ORIGINS`** in the live ingest repo secrets to include `https://chronicillnesschannel.co.uk`.

3. **Add the public domain to the Turnstile widget** (Cloudflare dashboard → Turnstile → edit widget → add `chronicillnesschannel.co.uk`).

4. **Remove the custom domain** from `LIVE-uk-aq-webpage` GitHub Pages settings (delete the CNAME or clear the custom domain field). The `/uk-aq` sub-path takes over immediately.

5. **Redeploy the cache proxy** (trigger `uk_aq_cache_proxy_deploy.yml`) so the updated allowed origins take effect.

6. **Re-run the `pages.yml` workflow** on `LIVE-uk-aq-webpage` to rebuild GitHub Pages with the updated `UK_AQ_AQI_HISTORY_BASE_URL` injected into the HTML.

---
---

# Mode 2: Sync Update

Use when the live system is running and you need to promote test changes to live.

Does **not** touch observation data. Only schema, code, config, and service deployments.

---

## Step A — Prepare and Bump Version

1. Confirm all test changes are committed and tested
2. Note all changes since the last live deploy (use `git log` against the last deploy tag)
3. Identify which services need redeployment
4. Update the `VERSION` file in the relevant test repos (e.g. `1.0.0` → `1.1.0`)
5. Commit and tag: `git tag v1.1.0 && git push --tags`

---

## Step B — Schema Migrations

Only needed if schema has changed since the last live deploy.

### B.1 Identify new migration files

Check `schemas/migrations/` in the schema repo for SQL files added since the last deploy. Files are named `YYYYMMDD_NNN_description.sql` — sort by filename to get apply order.

```bash
cd "$BASE/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/migrations"
ls -1 *.sql | sort
```

Compare against what was already applied in live (check tracking table or previous deploy notes).

### B.2 Apply each new migration in order

For each new file, note whether it applies to `ingestdb`, `obs_aqidb`, or both (the filename or a header comment should indicate this):

```bash
# Example: apply to live ingestdb
psql $LIVE_SUPABASE_DB_URL < 20260501_001_add_new_table.sql

# Example: apply to live obs_aqidb
psql $LIVE_OBS_AQIDB_DB_URL < 20260501_002_obs_aqidb_update.sql
```

### B.3 Record applied migrations

Update the schema version tracking table or document which migrations were applied and when.

### B.4 Verify

Spot-check that new tables/columns exist and existing queries still work.

---

## Step C — Code Sync

1. rsync test repos → live repos (same exclusions as Mode 1):

```bash
rsync -av --exclude=.git --exclude='.env*' --exclude=.venv \
  --exclude=node_modules --exclude=archive --exclude=tmp \
  "$BASE/CIC-test-uk-aq-ingest/" "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ingest/"
```

Repeat for ops, schema, webpage repos as needed.

2. After rsync, review the diff in git:
   ```bash
   cd "$BASE/LIVE UK AQ Networks/LIVE-uk-aq-ingest"
   git diff --stat
   ```

3. Check for new env vars that need adding to live `.env` and `.env.supabase`
4. Bump `VERSION` in the live repo to match test
5. Commit: `git add . && git commit -m "Sync from test v1.1.0"`
6. Re-run GitHub secrets sync if any new secrets:
   ```bash
   ./scripts/uk_aq_sync_github_secrets.sh
   ```

---

## Step D — Service Redeploy

Only redeploy what changed. Use `git diff HEAD~1` to see changed files, then match to services:

| Changed area | Action |
|---|---|
| `supabase/functions/**` | Trigger `supabase_edge_deploy.yml` |
| `workers/uk_aq_prune_daily/**` | Trigger `uk_aq_prune_daily_cloud_run_deploy.yml` |
| `workers/uk_aq_observs_outbox_flush_service/**` | Trigger outbox flush deploy workflow |
| `workers/uk_aq_cache_proxy/**` | Trigger `uk_aq_cache_proxy_deploy.yml` |
| `workers/uk_aq_observs_history_r2_api_worker/**` | Trigger observs history worker deploy |
| Any GCP worker | Trigger its `*_cloud_run_deploy.yml` |
| Any Cloudflare worker | Trigger its deploy workflow |
| `config/uk_aq_github_env_targets.csv` | Run `uk_aq_sync_github_secrets.sh` |

Trigger each deploy workflow via GitHub Actions → Run workflow on the live repo.

If edge function secrets changed, also run:
```bash
supabase secrets set --env-file .env.supabase
supabase secrets set UK_AQ_APP_VERSION=$(cat VERSION)
```

---

## Step E — Verification

- [ ] Schema migrations applied without errors
- [ ] No broken FK constraints or missing table errors
- [ ] Redeployed services start cleanly (check Cloud Run / Cloudflare worker logs)
- [ ] Ingest continues to produce `uk_aq_ingest_runs` rows for all connectors
- [ ] No increase in error log rate vs pre-update baseline
- [ ] Egress metrics unchanged or improved
- [ ] `VERSION` file in live repos matches intended release
- [ ] Live repos tagged with `v$(cat VERSION)` in git

---

## Migration File Convention

New migration SQL files added to `schemas/migrations/` must follow this naming:

```
YYYYMMDD_NNN_short_description.sql
```

- `YYYYMMDD` — date the migration was authored
- `NNN` — three-digit sequence number for same-day ordering (001, 002, …)
- Description should indicate target DB: prefix with `ingest_` or `obs_aqidb_`

Examples:
```
20260501_001_ingest_add_station_flags.sql
20260501_002_obs_aqidb_add_hourly_rollup.sql
```

Each migration file should have a one-line header comment:
```sql
-- Target: ingestdb | obs_aqidb | both
-- Description: brief summary
```

---

## Rollback Notes

- **Schema migrations**: test migrations on a test DB clone before applying to live. Keep a backup from `uk_aq_supabase_db_dump_backup_service` before applying.
- **R2 history**: Phase B backup to Dropbox runs continuously — restore from Dropbox if R2 is corrupted.
- **Code**: each live repo is git-tracked; revert and re-push to roll back a bad deploy.
- **Observation data**: never manually modify observation data during a sync update.
