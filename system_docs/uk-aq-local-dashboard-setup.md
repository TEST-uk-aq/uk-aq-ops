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
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
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
| `UK_AQ_DROPBOX_LOCAL_ROOT` | `/Users/mikehinford/Dropbox` | `/Users/mikehinford/Dropbox` |
| `UKAQ_DASHBOARD_TITLE` | Browser title/header text | Browser title/header text |
| `UKAQ_DASHBOARD_SUBTITLE` | Browser subtitle text | Browser subtitle text |

Leave live worker URLs empty if not yet deployed.

---

## Install launchd services

### Test (dashboard + cloudflared tunnel)

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
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
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
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
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/logs/dashboard_test.log"
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq-ops/logs/dashboard_live.log"
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/logs/cloudflared.log"
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
The Cloudflare Worker at `api/worker/` can be pointed back to Cloud Run by restoring
`DASHBOARD_UPSTREAM_BASE_URL` in the worker's environment if local hosting is unavailable.
