#!/usr/bin/env bash
# Syncs test repos to their live counterparts on the local machine using rsync.
# Usage: ./scripts/sync_to_live.sh [--dry-run]
set -euo pipefail

# ── Repo paths ───────────────────────────────────────────────────────────────

AQ_BASE="/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks"
LIVE_BASE="${AQ_BASE}/LIVE UK AQ Networks"

TEST_INGEST="${AQ_BASE}/CIC-test-uk-aq-ingest"
TEST_OPS="${AQ_BASE}/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops"
TEST_SCHEMA="${AQ_BASE}/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema"
TEST_WEBPAGE="${AQ_BASE}/CIC-UK-AQ Webpage/CIC-test-uk-aq-webpage"
TEST_POP_INGEST="${AQ_BASE}/CIC-Test-uk-aq-Population-Ingest/CIC-Test-uk-population-ingest"

LIVE_INGEST="${LIVE_BASE}/LIVE-uk-aq-ingest"
LIVE_OPS="${LIVE_BASE}/LIVE-uk-aq-ops"
LIVE_SCHEMA="${LIVE_BASE}/LIVE-uk-aq-schema"
LIVE_WEBPAGE="${LIVE_BASE}/LIVE-uk-aq-webpage"
LIVE_POP_INGEST="${LIVE_BASE}/LIVE-uk-aq-population-ingest"

# ── Flags ────────────────────────────────────────────────────────────────────

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=1
fi

# ── Exclusion list ───────────────────────────────────────────────────────────

EXCLUDES=(
  # Git metadata
  --exclude='.git/'

  # CI scanning config (environment-specific)
  --exclude='.github/codeql/'

  # Secrets and environment config
  --exclude='.env'
  --exclude='*.env'
  --exclude='.env.*'
  --exclude='supabase/config.toml'
  --exclude='supabase/.temp/'

  # Installed dependencies and build artefacts
  --exclude='node_modules/'
  --exclude='.venv/'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.pytest_cache/'

  # Runtime and local output files
  --exclude='logs/'
  --exclude='tmp/'
  --exclude='nohup.out'
  --exclude='CLI-output.txt'
  --exclude='purpleair_fetch.log'
  --exclude='workers/worker_error_logs/'

  # Scripts that reference test-specific paths
  --exclude='scripts/sync_to_live.sh'

  --exclude='.github/workflows/supabase_edge_deploy.yml'
  --exclude='system_docs/uk_aq_edge_functions.md'
  --exclude='system_docs/uk_aq_github_actions.md'

  # Ops management docs (test-env specific)
  --exclude='env-vars-master.csv'
  --exclude='R2 History structure.csv'
  --exclude='R2 Manifest-Index-Inventory cheat sheet.csv'
  --exclude='*.numbers'

  # Local machine setup (contain hardcoded test paths)
  --exclude='local/launchd/'

  # IDE and local tooling
  --exclude='.vscode/'
  --exclude='.codeql/'
  --exclude='.codex/'
  --exclude='.githooks/'
  --exclude='.DS_Store'

  # GitHub Pages domain (different per environment)
  --exclude='CNAME'

  # Test-env only directories
  --exclude='archive/'
  --exclude='plans/'

  # Test-env only files
  --exclude='AGENTS.md'
  --exclude='README_CROSS_REPO.md'
  --exclude='requirements-dev.txt'
  --exclude='uk_aq_copy_core_to_live*'

  # Website favicon images (different between live and test)
  --exclude='favicon.ico'
  --exclude='favicon.png'
  
  # Dashboard config
  --exclude='dashboard/assets/config.js'
 
  --exclude='*.zip'
  
  --exclude='dev-blog/'
  --exclude='uk_aq_inject_project_ref.mjs'
  --exclude='index.html''
)

# ── Sync function ─────────────────────────────────────────────────────────────

ERRORS=0

sync_repo() {
  local label="$1"
  local src="$2"
  local dst="$3"

  echo ""
  echo "── ${label} ──────────────────────────────────────"
  echo "   src: ${src}"
  echo "   dst: ${dst}"
  echo ""

  if [[ ! -d "${src}" ]]; then
    echo "   ERROR: source repo not found: ${src}" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi
  if [[ ! -d "${dst}" ]]; then
    echo "   ERROR: destination repo not found: ${dst}" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi

  local rsync_args=(-av --delete "${EXCLUDES[@]}")
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    rsync_args+=(--dry-run)
  fi

  rsync "${rsync_args[@]}" "${src}/" "${dst}/"
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo ""
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "==================================================================="
  echo " DRY RUN — no files will be written"
  echo "==================================================================="
fi

sync_repo "ingest"  "${TEST_INGEST}"  "${LIVE_INGEST}"
sync_repo "ops"     "${TEST_OPS}"     "${LIVE_OPS}"
sync_repo "schema"  "${TEST_SCHEMA}"  "${LIVE_SCHEMA}"
sync_repo "webpage" "${TEST_WEBPAGE}" "${LIVE_WEBPAGE}"
sync_repo "pop-ingest" "${TEST_POP_INGEST}" "${LIVE_POP_INGEST}"

echo ""
echo "==================================================================="
if [[ "${ERRORS}" -gt 0 ]]; then
  echo " COMPLETED WITH ${ERRORS} ERROR(S)"
  echo "==================================================================="
  exit 1
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  echo " DRY RUN COMPLETE — run without --dry-run to apply changes"
  echo "==================================================================="
else
  echo " SYNC COMPLETE"
  echo "==================================================================="
fi
