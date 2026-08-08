#!/usr/bin/env bash
# Promote files from TEST UK-AQ repo clones to their LIVE counterparts using rsync.
#
# Dry-run is the default. Use --apply to write changes.
#
# Examples:
#   ./scripts/sync_to_live.sh
#   ./scripts/sync_to_live.sh ops
#   ./scripts/sync_to_live.sh ops integrity-factory
#   ./scripts/sync_to_live.sh --all --include-workflows
#   ./scripts/sync_to_live.sh ops --apply
set -euo pipefail

# ── Repo paths ───────────────────────────────────────────────────────────────

TEST_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos"
LIVE_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos"

repo_src() {
  case "$1" in
    ingest)            printf '%s\n' "${TEST_BASE}/TEST-uk-aq-ingest" ;;
    ops)               printf '%s\n' "${TEST_BASE}/TEST-uk-aq-ops" ;;
    schema)            printf '%s\n' "${TEST_BASE}/TEST-uk-aq-schema" ;;
    webpage)           printf '%s\n' "${TEST_BASE}/TEST-uk-aq" ;;
    pop-ingest)        printf '%s\n' "${TEST_BASE}/TEST-uk-population-ingest" ;;
    integrity-factory) printf '%s\n' "${TEST_BASE}/TEST-uk-aq-integrity-factory" ;;
    *) return 1 ;;
  esac
}

repo_dst() {
  case "$1" in
    ingest)            printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-ingest" ;;
    ops)               printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-ops" ;;
    schema)            printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-schema" ;;
    webpage)           printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq" ;;
    pop-ingest)        printf '%s\n' "${LIVE_BASE}/LIVE-uk-population-ingest" ;;
    integrity-factory) printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-integrity-factory" ;;
    *) return 1 ;;
  esac
}

ALL_REPOS=(ingest ops schema webpage pop-ingest integrity-factory)

# ── Flags / selection ────────────────────────────────────────────────────────

APPLY=0
INCLUDE_WORKFLOWS=0
SELECT_ALL=0
SELECTED_REPOS=()

usage() {
  cat <<'USAGE'
Usage: ./scripts/sync_to_live.sh [options] [repo ...]

Repos:
  ingest
  ops
  schema
  webpage
  pop-ingest
  integrity-factory

Options:
  --apply               Write changes. Without this flag the script is a dry-run.
  --dry-run, -n         Explicit dry-run (the default).
  --all                 Sync all six repos.
  --include-workflows   Include .github/workflows/ in the promotion.
  -h, --help            Show this help.

If no repo is supplied, all six repos are selected.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --dry-run|-n)
      APPLY=0
      ;;
    --include-workflows)
      INCLUDE_WORKFLOWS=1
      ;;
    --all)
      SELECT_ALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    ingest|ops|schema|webpage|pop-ingest|integrity-factory)
      SELECTED_REPOS+=("$1")
      ;;
    *)
      echo "Unknown option or repo: $1" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "${SELECT_ALL}" -eq 1 || "${#SELECTED_REPOS[@]}" -eq 0 ]]; then
  SELECTED_REPOS=("${ALL_REPOS[@]}")
fi

# De-duplicate repo selection while preserving order.
UNIQUE_REPOS=()
for candidate in "${SELECTED_REPOS[@]}"; do
  seen=0
  for existing in "${UNIQUE_REPOS[@]:-}"; do
    if [[ "${candidate}" == "${existing}" ]]; then
      seen=1
      break
    fi
  done
  if [[ "${seen}" -eq 0 ]]; then
    UNIQUE_REPOS+=("${candidate}")
  fi
done
SELECTED_REPOS=("${UNIQUE_REPOS[@]}")

# ── Exclusions ───────────────────────────────────────────────────────────────

COMMON_EXCLUDES=(
  # Git metadata
  --exclude='.git/'

  # Secrets and local environment config
  --exclude='.env'
  --exclude='.env.*'
  --exclude='supabase/config.toml'
  --exclude='supabase/.temp/'

  # Installed dependencies and generated caches
  --exclude='node_modules/'
  --exclude='.venv/'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.pytest_cache/'

  # Runtime and local output
  --exclude='logs/'
  --exclude='tmp/'
  --exclude='nohup.out'
  --exclude='CLI-output.txt'
  --exclude='purpleair_fetch.log'
  --exclude='workers/worker_error_logs/'

  # Local editor / agent state
  --exclude='.vscode/'
  --exclude='.codeql/'
  --exclude='.codex/'
  --exclude='.githooks/'
  --exclude='.DS_Store'

  # TEST-side planning / local helper files
  --exclude='archive/'
  --exclude='plans/'
  --exclude='AGENTS.md'
  --exclude='README_CROSS_REPO.md'
  --exclude='requirements-dev.txt'
  --exclude='uk_aq_copy_core_to_live*'
)

repo_excludes() {
  local repo="$1"
  REPO_EXCLUDES=()

  if [[ "${INCLUDE_WORKFLOWS}" -eq 0 ]]; then
    REPO_EXCLUDES+=(--exclude='.github/workflows/')
  fi

  case "${repo}" in
    ops)
      REPO_EXCLUDES+=(
        --exclude='scripts/sync_to_live.sh'
        --exclude='env-vars-master.csv'
        --exclude='env-vars-master*.numbers'
        --exclude='local/launchd/'
        --exclude='dashboard/assets/config.js'
      )
      ;;
    ingest)
      # TEST-only OpenAQ LIVE -> TEST mirror components.
      REPO_EXCLUDES+=(
        --exclude='supabase/functions/uk_aq_sync_openaq_from_live/'
        --exclude='system_docs/table_info/uk_aq_openaq_live_sync_state.md'
        --exclude='system_docs/uk_aq_edge_functions.md'
        --exclude='system_docs/uk_aq_github_actions.md'
        --exclude='config/uk_aq_github_env_targets.csv'
        --exclude='schemas/ingest_db/uk_aq_openaq_live_sync_test.sql'
      )
      ;;
    webpage)
      REPO_EXCLUDES+=(
        --exclude='CNAME'
        --exclude='favicon.ico'
        --exclude='favicon.png'
      )
      ;;
    schema|pop-ingest|integrity-factory)
      ;;
  esac
}

# ── Sync ─────────────────────────────────────────────────────────────────────

ERRORS=0

sync_repo() {
  local label="$1"
  local src dst
  src="$(repo_src "${label}")"
  dst="$(repo_dst "${label}")"

  echo
  echo "── ${label} ──────────────────────────────────────"
  echo "   src: ${src}"
  echo "   dst: ${dst}"
  echo

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

  repo_excludes "${label}"

  local rsync_args=(
    -av
    --checksum
    --delete-delay
    --itemize-changes
    --human-readable
    "${COMMON_EXCLUDES[@]}"
    "${REPO_EXCLUDES[@]}"
  )

  if [[ "${APPLY}" -eq 0 ]]; then
    rsync_args+=(--dry-run)
  fi

  rsync "${rsync_args[@]}" "${src}/" "${dst}/"
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo
if [[ "${APPLY}" -eq 0 ]]; then
  echo "==================================================================="
  echo " DRY RUN - no files will be written or deleted"
  echo "==================================================================="
else
  echo "==================================================================="
  echo " APPLY MODE - LIVE repo files may be written or deleted"
  echo "==================================================================="
fi

if [[ "${INCLUDE_WORKFLOWS}" -eq 1 ]]; then
  echo " GitHub workflows: INCLUDED"
else
  echo " GitHub workflows: EXCLUDED (use --include-workflows to include)"
fi

echo " Repos: ${SELECTED_REPOS[*]}"

for repo in "${SELECTED_REPOS[@]}"; do
  sync_repo "${repo}"
done

echo
echo "==================================================================="
if [[ "${ERRORS}" -gt 0 ]]; then
  echo " COMPLETED WITH ${ERRORS} ERROR(S)"
  echo "==================================================================="
  exit 1
elif [[ "${APPLY}" -eq 0 ]]; then
  echo " DRY RUN COMPLETE - add --apply to make these changes"
  echo "==================================================================="
else
  echo " SYNC COMPLETE"
  echo "==================================================================="
fi
