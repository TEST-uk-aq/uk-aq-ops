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
   run_dashboard_test.sh                             run_dashboard_live.sh
   sources: CIC-test-uk-aq-ops/.env.test            sources: LIVE-uk-aq Operations/.env
   Python server on port 8000                        Python server on port 8001
   serves: dashboard/ HTML + /api/* routes           serves: dashboard/ HTML + /api/* routes
```

**Key point**: The Python server (`uk_aq_dashboard_api.py`) serves both the frontend HTML and all
`/api/*` routes from a single port. There is no separate frontend build step.

**Shared code**: Both environments use the Python server and dashboard HTML from the test ops repo.
Only credentials (env files) and ports differ.

## Repo layout

| What | Where |
|---|---|
| Python server | `CIC-test-uk-aq-ops/local/dashboard/server/uk_aq_dashboard_api.py` |
| Dashboard HTML | `CIC-test-uk-aq-ops/dashboard/index.html` |
| Python venv | `CIC-test-uk-aq-ops/.venv/` |
| Test env file | `CIC-test-uk-aq-ops/.env.test` |
| Test run script | `CIC-test-uk-aq-ops/local/scripts/run_dashboard_test.sh` |
| Test launchd plists | `CIC-test-uk-aq-ops/local/launchd/` |
| Cloudflare tunnel config | `CIC-test-uk-aq-ops/local/cloudflared/config.yml` (template) |
| Live env file | `LIVE-uk-aq Operations/.env` |
| Live run script | `LIVE-uk-aq Operations/local/scripts/run_dashboard_live.sh` |
| Live launchd plist | `LIVE-uk-aq Operations/local/launchd/` |

---

## One-time setup (per machine)

### 1. Python venv

Run from the **test ops repo**. Both environments share this venv.

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"

# Find available Python 3
which python3 && python3 --version

# If Homebrew Python exists use it (e.g. 3.13 or 3.14):
/opt/homebrew/bin/python3.13 -m venv .venv   # adjust version as needed
# OR if only system python3:
python3 -m venv .venv

# Install the only required package
.venv/bin/pip install requests

# Verify
.venv/bin/python3 -c "import requests; print('ok')"
```

If Homebrew is not installed:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install python@3.13
/opt/homebrew/bin/python3.13 -m venv .venv
.venv/bin/pip install requests
```

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
# Edit ~/.cloudflared/config.yml:
#   Replace both occurrences of <TUNNEL_UUID> with the UUID from the step above.
```

The config template is at `local/cloudflared/config.yml` in the test ops repo.

---

## Test environment setup

### Fill in `.env.test`

Located at `CIC-test-uk-aq-ops/.env.test`. Copy values from `.env` (which is already the test env):

| Variable | Source |
|---|---|
| `SUPABASE_URL` | copy from `.env` |
| `SB_SECRET_KEY` | copy from `.env` |
| `OBS_AQIDB_SUPABASE_URL` | copy from `.env` |
| `OBS_AQIDB_SECRET_KEY` | copy from `.env` |
| `UK_AQ_DB_SIZE_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/db-size-metrics` |
| `UK_AQ_DB_SIZE_API_TOKEN` | copy from `.env` — also covers the R2 history token (cascades) |
| `UK_AQ_R2_HISTORY_DAYS_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/r2-history-days` |
| `UK_AQ_R2_HISTORY_COUNTS_API_URL` | `https://uk-aq-db-r2-metrics-api.cic-test.workers.dev/v1/r2-history-counts` |
| `UK_AQ_DROPBOX_LOCAL_ROOT` | `/Users/mikehinford/Dropbox` |
| `DASHBOARD_UPSTREAM_BEARER_TOKEN` | leave empty (run script clears it anyway) |

### Test manually

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
./local/scripts/run_dashboard_test.sh
# → http://127.0.0.1:8000
curl http://127.0.0.1:8000/api/dashboard
```

### Install test launchd services (dashboard + cloudflared)

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops"
./local/launchd/install_launchd.sh
```

Installs and starts:
- `co.uk.chronicillnesschannel.aq.dashboard.test` — Python server on port 8000
- `co.uk.chronicillnesschannel.aq.cloudflared` — tunnel (routes both domains)

---

## Live environment setup

### Fill in live env vars

The live environment uses `LIVE-uk-aq Operations/.env` directly.

Add these dashboard-specific vars to that file (they are not there by default):

```bash
# Append to LIVE-uk-aq Operations/.env
UK_AQ_DB_SIZE_API_URL=https://<live-worker-name>.workers.dev/v1/db-size-metrics
UK_AQ_DB_SIZE_API_TOKEN=<live api token>
UK_AQ_R2_HISTORY_DAYS_API_URL=https://<live-worker-name>.workers.dev/v1/r2-history-days
UK_AQ_R2_HISTORY_COUNTS_API_URL=https://<live-worker-name>.workers.dev/v1/r2-history-counts
UK_AQ_DROPBOX_LOCAL_ROOT=/Users/mikehinford/Dropbox
```

> The live worker URLs and token will differ from test. Check the live ops Cloudflare dashboard
> or the live wrangler.toml for the deployed worker name.

### Test manually

```bash
"./Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq Operations/local/scripts/run_dashboard_live.sh"
# → http://127.0.0.1:8001
curl http://127.0.0.1:8001/api/dashboard
```

### Install live launchd service

```bash
cd "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq Operations"
./local/launchd/install_launchd_live.sh
```

Installs:
- `co.uk.chronicillnesschannel.aq.dashboard.live` — Python server on port 8001

> The cloudflared tunnel service is installed once from the test ops repo and routes both domains.
> You do not need to install it again for live.

---

## Managing services

```bash
# Check all three services are running
launchctl list | grep chronicillnesschannel

# Stop a service
launchctl unload ~/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard.test.plist

# Start a service
launchctl load ~/Library/LaunchAgents/co.uk.chronicillnesschannel.aq.dashboard.test.plist

# View logs
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops/logs/dashboard_test.log"
tail -f "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/LIVE UK AQ Networks/LIVE-uk-aq Operations/logs/dashboard_live.log"
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
