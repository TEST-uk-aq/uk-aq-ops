# Local Dashboard Setup

Runs the UK AQ admin dashboard locally on a MacBook, replacing the Cloud Run backend.
The Cloudflare Tunnel exposes it externally, including to mobile.

## Architecture

```
Browser / Mobile
       │
Cloudflare Zero Trust (auth already configured)
       │
Cloudflare Tunnel (cloudflared on MacBook)
       ├── cic-test-uk-aq-admin.chronicillnesschannel.co.uk → localhost:8000  (test)
       └── uk-aq-admin.chronicillnesschannel.co.uk          → localhost:8001  (live)
                │                                                    │
   CIC-test-uk-aq-ops                                    LIVE-uk-aq-ops
   run_dashboard.sh (PORT=8000)                          run_dashboard.sh (PORT=8001)
   reads: CIC-test-uk-aq-ops/.env                        reads: LIVE-uk-aq-ops/.env
```

**Key point**: The Python server (`uk_aq_dashboard_api.py`) serves both the frontend HTML and all
`/api/*` routes from a single port. There is no separate frontend build step.
Before starting the server, `local/scripts/run_dashboard.sh` regenerates
`dashboard/assets/config.js` from `.env` (`UKAQ_*` browser-safe variables).

Both repos contain the same server code and their own Python venv. The scripts are identical —
only the credentials (each repo's `.env`) and port differ.

## Repo layout (per environment)

| What | Test | Live |
|---|---|---|
| Python server | `CIC-test-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py` | `LIVE-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py` |
| Dashboard HTML | `CIC-test-uk-aq-ops/dashboard/index.html` | _(served from test ops)_ |
| Python venv | `CIC-test-uk-aq-ops/.venv/` | `LIVE-uk-aq-ops/.venv/` |
| Env file | `CIC-test-uk-aq-ops/.env` | `LIVE-uk-aq-ops/.env` |
| Run script | `CIC-test-uk-aq-ops/local/scripts/run_dashboard.sh` | `LIVE-uk-aq-ops/local/scripts/run_dashboard.sh` |
| Launchd plists | `CIC-test-uk-aq-ops/local/launchd/` | `LIVE-uk-aq-ops/local/launchd/` |
| Install script | `CIC-test-uk-aq-ops/local/launchd/install_launchd.sh` | `LIVE-uk-aq-ops/local/launchd/install_launchd.sh` |
| Cloudflare tunnel config | `CIC-test-uk-aq-ops/local/cloudflared/config.yml` (template) | _(shared tunnel)_ |

---

## One-time setup

### 1. Python venv — run once per environment

Run the same steps in each repo root.

**Test:**
```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops"
python3 -m venv .venv
.venv/bin/pip install -r local/dashboard/server/requirements.txt
.venv/bin/python3 -c "import requests; print('ok')"
```

**Live:**
```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops"
python3 -m venv .venv
.venv/bin/pip install -r local/dashboard/server/requirements.txt
.venv/bin/python3 -c "import requests; print('ok')"
```

If Homebrew Python is available, substitute `python3` with `/opt/homebrew/bin/python3.13` (or whichever version).

### 2. Cloudflare Tunnel (one-time, shared by both environments)

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Authenticate (opens browser — log in with Cloudflare account)
cloudflared tunnel login

# Create a named tunnel — note the UUID printed
cloudflared tunnel create uk-aq-local

# Route both hostnames to this tunnel
cloudflared tunnel route dns uk-aq-local cic-test-uk-aq-admin.chronicillnesschannel.co.uk
cloudflared tunnel route dns uk-aq-local uk-aq-admin.chronicillnesschannel.co.uk

# Copy and edit the config template
cp local/cloudflared/config.yml ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml: replace both <TUNNEL_UUID> placeholders with the UUID above.
```

The config template is at `CIC-test-uk-aq-ops/local/cloudflared/config.yml`.

---

## Environment variables

Both dashboards read from their own repo's `.env`. The dashboard-specific vars needed in each:

| Variable | Test value | Live value |
|---|---|---|
| `SUPABASE_URL` | test ingestdb URL | live ingestdb URL |
| `SB_SECRET_KEY` | test ingestdb service role key | live ingestdb service role key |
| `OBS_AQIDB_SUPABASE_URL` | test obs_aqidb URL | live obs_aqidb URL |
| `OBS_AQIDB_SECRET_KEY` | test obs_aqidb service role key | live obs_aqidb service role key |
| `UK_AQ_DB_SIZE_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/db-size-metrics` | live worker URL |
| `UK_AQ_DB_SIZE_API_TOKEN` | token from `.env` | live token |
| `UK_AQ_R2_HISTORY_DAYS_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/r2-history-days` | live worker URL |
| `UK_AQ_R2_HISTORY_COUNTS_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/r2-history-counts` | live worker URL |
| `UK_AQ_SERVICE_EGRESS_LOOKBACK_DAYS` | `7` | `7` |
| `UK_AQ_DROPBOX_LOCAL_ROOT` | `/Users/mikehinford/Dropbox` | `/Users/mikehinford/Dropbox` |
| `UKAQ_DASHBOARD_TITLE` | Browser title/header text | Browser title/header text |
| `UKAQ_DASHBOARD_SUBTITLE` | Browser subtitle text | Browser subtitle text |

Leave live worker URLs empty if not yet deployed.

---

## Dashboard config refresh quick steps

Use this when `dashboard/assets/config.js` still shows old values (for example test labels on live).

1. Update the correct repo `.env` (`CIC-test-uk-aq-ops` for test, `LIVE-uk-aq-ops` for live).
2. Regenerate `dashboard/assets/config.js` from that repo's `.env`:

```bash
# Example: live repo
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops"
set -a
source .env
set +a
node scripts/dashboard/generate_dashboard_config.mjs
```

3. If the dashboard is launchd-managed, reload it so startup regeneration also runs with the same `.env`:

```bash
# Example: live service
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops"
./local/launchd/install_launchd.sh
```

4. Hard refresh the browser and verify:

```bash
curl -s http://127.0.0.1:8001/assets/config.js | head
```

---

## Storage Coverage Day Presence

- Ingest DB day presence in the calendar now uses exact per-day checks via
  `uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint` on ingestdb.
- A day is marked ingest-present only when the fingerprint RPC reports
  `observation_count > 0` for that UTC day.
- The previous oldest-day range inference is only used as a fallback if the
  exact ingest day check is unavailable.

---

## Dashboard Data Sources (what powers each panel)

This section describes where each panel on `dashboard/index.html` gets its data when running the local Python backend.

### Main API routes used by the dashboard page

- `GET /api/dashboard` -> main payload for connector settings, dispatcher feed, pollutant freshness, DB-size trend, and related metadata.
- `GET /api/storage_coverage` -> storage-coverage calendar payload.
- `GET /api/r2_metrics` -> on-demand R2 usage/limits refresh (used by the "Refresh R2 metrics" button).
- `GET /api/r2_connector_counts` -> R2 connector/day-count charts inside the storage-coverage panel.
- `GET /api/daily_task_runs` -> daily task run rows for the Operations card (`day=YYYY-MM-DD`, `mode=latest|all`).
- `POST /api/connectors` -> saves connector polling settings edits from the dashboard UI.
- `POST /api/dispatcher_settings` -> saves dispatcher settings edits from the dashboard UI.

### Panel-by-panel source summary

| Dashboard section | API route | Backend source tables/views/RPC/API |
|---|---|---|
| Connector Settings table | `/api/dashboard` (read), `/api/connectors` (write) | `uk_aq_core.connectors` via PostgREST `connectors` |
| Dispatcher Settings panel | `/api/dashboard` (read), `/api/dispatcher_settings` (write) | `uk_aq_core.dispatcher_settings` via PostgREST `dispatcher_settings` |
| Dispatcher Feed table | `/api/dashboard` | `uk_aq_core.uk_aq_ingest_runs` view/table (`/uk_aq_ingest_runs`) plus synthetic in-flight rows derived from `connectors.last_run_start/last_run_end` |
| PM2.5 / PM10 / NO2 freshness tables | `/api/dashboard` | `uk_aq_core.timeseries` (`last_value`, `last_value_at`, station/connector IDs) plus `phenomena`; connector metadata from `connectors`; station metadata from `stations` + `station_metadata` |
| DB Size Trend (line + stacked charts) | `/api/dashboard` | Primary: external DB-size metrics API (`UK_AQ_DB_SIZE_API_URL`) returning `db_size_metrics`, `schema_size_metrics`, `r2_domain_size_metrics`; fallback/top-up: Supabase views `uk_aq_db_size_metrics_hourly`, `uk_aq_schema_size_metrics_hourly`, `uk_aq_r2_domain_size_metrics_hourly` |
| Supabase Endpoint Egress (24h) | `/api/dashboard` | Ingest DB view `uk_aq_endpoint_egress_metrics_24h_dashboard` |
| R2 usage bars + free-tier percentages | `/api/dashboard`, `/api/r2_metrics` | Cloudflare account metrics API calls in backend (`_fetch_r2_account_metrics`) using R2/Cloudflare account token env vars |
| R2 history window label | `/api/dashboard`, `/api/r2_metrics` | Preferred: external history-days API (`UK_AQ_R2_HISTORY_DAYS_API_URL`); fallback: Supabase RPC `uk_aq_rpc_r2_history_days_by_domain`; additional fallback range RPC `uk_aq_rpc_r2_history_window` |
| Daily Tasks Latest Runs (Operations) | `/api/daily_task_runs` | ObsAQI DB view `uk_aq_ops.daily_task_runs_dashboard` (joins `uk_aq_ops.daily_task_runs` + `uk_aq_ops.daily_task_definitions`), filtered by `scheduled_for_date` and mode (`latest` or `all`) |
| Storage Coverage calendar | `/api/storage_coverage` (also optionally embedded in `/api/dashboard`) | Ingest day presence: ingestdb RPC `uk_aq_rpc_observations_hourly_fingerprint`; OBS/AQI day presence: obs_aqidb view `uk_aq_obs_aqidb_day_counts_current` (with RPC fallbacks); R2 day presence: external history-days API (or fallback `uk_aq_rpc_r2_history_days_by_domain`); Dropbox backup days: local/remote Dropbox checkpoint JSON |
| Storage Coverage R2 connector counts cards | `/api/r2_connector_counts` | External R2 history-counts API (`UK_AQ_R2_HISTORY_COUNTS_API_URL`) |

### How "Active" is determined in pollutant tables

The `Active` column in PM2.5/PM10/NO2 tables is computed from station status logic in `uk_aq_dashboard_api.py`:

- A station is **inactive** if `stations.removed_at` is not null.
- For most connectors, a non-removed station is treated as **active**.
- Special case for Breathe London primary rows (`connector_code == breathelondon` and `service_ref == breathelondon`):
  active requires truthy `station_metadata.attributes.enabled` **or** truthy `station_metadata.attributes.site_active`.
- `Active` counts only stations that both:
  - satisfy the active rule above, and
  - have at least one matching pollutant timeseries with non-null `last_value` and `last_value_at`.

Freshness buckets (`0-3`, `3-6`, `6-24`, `1-7`, `7+`) are based on `timeseries.last_value_at` recency.

---

## Cloudflare Access Session Expiry Recovery

- Dashboard API fetches (`/api/dashboard`, `/api/storage_coverage`, `/api/daily_task_runs`) can fail with browser
  `TypeError: Failed to fetch` + CORS messages when a Cloudflare Access session expires
  after the tab is dormant.
- The dashboard frontend now treats that failure pattern as an auth-expiry signal and
  triggers a top-level reload redirect so Cloudflare Access can re-authenticate.
- Redirect attempts are throttled in `sessionStorage` (10 seconds) to avoid redirect loops.
- If this still repeats continuously, verify Cloudflare Access app/session settings for both:
  - `cic-test-uk-aq-admin.chronicillnesschannel.co.uk`
  - `uk-aq-admin.chronicillnesschannel.co.uk`

---

## Install launchd services

### Test (dashboard + cloudflared tunnel)

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops"
./local/launchd/install_launchd.sh
```

Installs and starts:
- `co.uk.chronicillnesschannel.aq.dashboard.test` — Python server on port 8000
- `co.uk.chronicillnesschannel.aq.cloudflared` — tunnel (routes both domains)

### Live (dashboard only)

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops"
./local/launchd/install_launchd.sh
```

Installs and starts:
- `co.uk.chronicillnesschannel.aq.dashboard.live` — Python server on port 8001

---

## Test manually (without launchd)

```bash
# Test dashboard
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops"
./local/scripts/run_dashboard.sh
# → http://127.0.0.1:8000

# Live dashboard
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops"
PORT=8001 ./local/scripts/run_dashboard.sh
# → http://127.0.0.1:8001
```

---

## Managing services

```bash
# Check all three services are running
launchctl list | grep chronicillnesschannel

# Stop / start a service (substitute label as needed)
launchctl unload ~/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard.test.plist
launchctl load  ~/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard.test.plist

# View logs
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops/logs/dashboard_test.log"
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops/logs/dashboard_live.log"
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops/logs/cloudflared.log"
```

---

## Verification checklist

- [ ] `curl http://127.0.0.1:8000` returns dashboard HTML
- [ ] `curl http://127.0.0.1:8000/api/dashboard` returns JSON
- [ ] `curl http://127.0.0.1:8001` returns dashboard HTML (live)
- [ ] `curl http://127.0.0.1:8001/api/dashboard` returns JSON (live)
- [ ] `cloudflared tunnel --config ~/.cloudflared/config.yml run` connects without error
- [ ] `https://cic-test-uk-aq-admin.chronicillnesschannel.co.uk` loads in browser
- [ ] `https://uk-aq-admin.chronicillnesschannel.co.uk` loads in browser
- [ ] Both URLs load on mobile (Cloudflare Zero Trust auth prompt appears)
- [ ] `launchctl list | grep chronicillnesschannel` shows all three services with PID > 0
- [ ] Services survive a logout/login

---

## Cloud Run (unchanged)

The existing Cloud Run deployment is not modified. It remains as a fallback.
The Cloudflare Worker at `workers/uk_aq_dashboard_online_api_worker/` can be pointed back to Cloud Run by restoring
`DASHBOARD_UPSTREAM_BASE_URL` in the worker's environment if local hosting is unavailable.
