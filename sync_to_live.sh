#!/usr/bin/env bash
# Promote files from TEST UK-AQ repo clones to their LIVE counterparts using rsync.
#
# Dry-run is the default. Use --apply to write changes.
#
# Examples:
#   ./sync_to_live.sh
#   ./sync_to_live.sh ops
#   ./sync_to_live.sh ops integrity-factory
#   ./sync_to_live.sh --all
#   ./sync_to_live.sh ops --apply
set -euo pipefail

# ── Repo paths ───────────────────────────────────────────────────────────────

TEST_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos"
LIVE_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos"

repo_src() {
  case "$1" in
    ingest)            printf '%s\n' "${TEST_BASE}/TEST-uk-aq-ingest" ;;
    ops)               printf '%s\n' "${TEST_BASE}/TEST-uk-aq-ops" ;;
    schema)            printf '%s\n' "${TEST_BASE}/TEST-uk-aq-schema" ;;
    webpage)           printf '%s\n' "${TEST_BASE}/TEST-uk-aq.github.io" ;;
    pop-ingest)        printf '%s\n' "${TEST_BASE}/TEST-uk-aq-population-ingest" ;;
    integrity-factory) printf '%s\n' "${TEST_BASE}/TEST-uk-aq-integrity-factory" ;;
    *) return 1 ;;
  esac
}

repo_dst() {
  case "$1" in
    ingest)            printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-ingest" ;;
    ops)               printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-ops" ;;
    schema)            printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-schema" ;;
    webpage)           printf '%s\n' "${LIVE_BASE}/LIVE-beta-uk-aq" ;;
    pop-ingest)        printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-population-ingest" ;;
    integrity-factory) printf '%s\n' "${LIVE_BASE}/LIVE-uk-aq-integrity-factory" ;;
    *) return 1 ;;
  esac
}

ALL_REPOS=(ingest ops schema webpage pop-ingest integrity-factory)

# ── Flags / selection ────────────────────────────────────────────────────────

APPLY=0
SELECT_ALL=0
SELECTED_REPOS=()

usage() {
  cat <<'USAGE'
Usage: ./sync_to_live.sh [options] [repo ...]

Repos:
  ingest
  ops
  schema
  webpage
  pop-ingest
  integrity-factory

Options:
  --apply               Write/delete LIVE files to match TEST.
  --dry-run, -n         Explicit dry-run (the default).
  --all                 Sync all six repos.
  -h, --help            Show this help.

GitHub workflows are included like normal source files.
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

  # Secrets and environment-owned config
  --exclude='.env'
  --exclude='.env.*'
  --exclude='*.env'
  --exclude='supabase/config.toml'
  --exclude='supabase/.temp/'
  --exclude='config/uk_aq_github_env_targets.csv'
  --exclude='workers/GCP-vars/'

  # CI scanning configuration is kept environment-owned.
  --exclude='.github/codeql/'

  # Installed dependencies and generated caches
  --exclude='node_modules/'
  --exclude='.venv/'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.pytest_cache/'

  # TEST suites stay in TEST. This covers root and nested test directories,
  # plus the occasional test module stored beside production source.
  --exclude='tests/'
  --exclude='*_test.*'
  --exclude='*.test.*'
  --exclude='test_*.py'

  # Runtime, investigation and local output
  --exclude='logs/'
  --exclude='logs4GH/'
  --exclude='tmp/'
  --exclude='_codex_context/'
  --exclude='nohup.out'
  --exclude='CLI-output.txt'
  --exclude='purpleair_fetch.log'
  --exclude='workers/worker_error_logs/'
  --exclude='scripts/R2_v2_implementation/tmp_r2_manifest_rebuild_*/'
  --exclude='scripts/aqi_gaps/r2_aqi_gap_check_*/'

  # Legacy documentation is retained in TEST only.
  --exclude='system_docs_legacy/'

  # Local editor / agent state
  --exclude='.vscode/'
  --exclude='.codeql/'
  --exclude='.codex/'
  --exclude='.githooks/'
  --exclude='.DS_Store'

  # Environment-owned Pages / branding files
  --exclude='CNAME'
  --exclude='favicon.ico'
  --exclude='favicon.png'

  # TEST-side planning / local helper files
  --exclude='archive/'
  --exclude='Archive/'
  --exclude='plans/'
  --exclude='AGENTS.md'
  --exclude='README_CROSS_REPO.md'
  --exclude='requirements-dev.txt'
  --exclude='uk_aq_copy_core_to_live*'
)

# ── Sync ─────────────────────────────────────────────────────────────────────

ERRORS=0
SUCCESS_REPOS=()
FAILED_REPOS=()

mark_failure() {
  local label="$1"
  ERRORS=$((ERRORS + 1))
  FAILED_REPOS+=("${label}")
}

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
    echo "   ERROR [${label}]: source repo not found: ${src}" >&2
    mark_failure "${label}"
    return
  fi
  if [[ ! -d "${dst}" ]]; then
    echo "   ERROR [${label}]: destination repo not found: ${dst}" >&2
    mark_failure "${label}"
    return
  fi

  # Build the rsync argument list here rather than expanding a separate empty
  # array. macOS ships Bash 3.2, where `set -u` can treat an empty array
  # expansion as an unbound variable.
  local rsync_args=(
    -av
    --checksum
    --delete-delay
    --itemize-changes
    --human-readable
    "${COMMON_EXCLUDES[@]}"
  )

  case "${label}" in
    ops)
      rsync_args+=(
        # This promotion tool belongs in TEST, not LIVE.
        --exclude='sync_to_live.sh'

        # Environment/local-machine owned files.
        --exclude='env-vars-master.csv'
        --exclude='env-vars-master*.numbers'
        --exclude='local/launchd/'
        --exclude='dashboard/assets/config.js'

        # Scheduler configuration contains LIVE/TEST repo identity, enablement
        # choices and a different D1 database ID in each environment.
        --exclude='cloudflare/scheduler/jobs.toml'
        --exclude='cloudflare/scheduler/wrangler.toml'

        # Postcode lookup is intentionally held back until its LIVE Cloudflare
        # resources and variables are configured on the ukaq.co.uk account.
        --exclude='.github/workflows/uk_aq_postcode_lookup_r2_api_worker_deploy.yml'
        --exclude='workers/uk_aq_postcode_lookup_r2_api_worker/'
        --exclude='workers/shared/postcode_lookup.mjs'
        --exclude='scripts/postcodes/'
        --exclude='scripts/geography/*postcode*'
        --exclude='docs/*postcode*'
        --exclude='system_docs/geography/postcode_lookup.md'
      )
      ;;
    ingest)
      rsync_args+=(
        # Scheduler configuration contains environment-specific repo identity,
        # enablement choices and a different D1 database ID.
        --exclude='cloudflare/scheduler/jobs.toml'
        --exclude='cloudflare/scheduler/wrangler.toml'

        # TEST-only OpenAQ LIVE -> TEST mirror components.
        --exclude='supabase/functions/uk_aq_sync_openaq_from_live/'
        --exclude='system_docs/table_info/uk_aq_openaq_live_sync_state.md'
        --exclude='.github/workflows/supabase_edge_deploy.yml'
        --exclude='system_docs/uk_aq_edge_functions.md'
        --exclude='system_docs/uk_aq_github_actions.md'
        --exclude='schemas/ingest_db/uk_aq_openaq_live_sync_test.sql'
      )
      ;;
    schema|webpage|pop-ingest|integrity-factory)
      # No extra repo-specific exclusions at present.
      ;;
  esac

  if [[ "${APPLY}" -eq 0 ]]; then
    rsync_args+=(--dry-run)
  fi

  if rsync "${rsync_args[@]}" "${src}/" "${dst}/"; then
    SUCCESS_REPOS+=("${label}")
  else
    echo "   ERROR [${label}]: rsync failed" >&2
    mark_failure "${label}"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo
if [[ "${APPLY}" -eq 0 ]]; then
  echo "==================================================================="
  echo " DRY RUN MODE - no files will be written, transferred or deleted"
  echo "==================================================================="
else
  echo "==================================================================="
  echo " APPLY MODE - LIVE repo files may be written, transferred or deleted"
  echo "==================================================================="
fi

echo " GitHub workflows: INCLUDED"
echo " Repos: ${SELECTED_REPOS[*]}"

for repo in "${SELECTED_REPOS[@]}"; do
  sync_repo "${repo}"
done

echo
echo "==================================================================="
if [[ "${APPLY}" -eq 0 ]]; then
  echo " MODE: DRY RUN"
  echo " CONFIRMED: nothing was transferred, written or deleted."
else
  echo " MODE: APPLY"
  if [[ "${#SUCCESS_REPOS[@]}" -gt 0 ]]; then
    echo " CONFIRMED: LIVE sync was applied for: ${SUCCESS_REPOS[*]}"
  fi
fi

if [[ "${ERRORS}" -gt 0 ]]; then
  echo " FAILED REPOS (${ERRORS}): ${FAILED_REPOS[*]}"
  if [[ "${APPLY}" -eq 1 ]]; then
    echo " APPLY MODE COMPLETED WITH ERRORS: successful repos were synced; failed repos were not."
  else
    echo " DRY RUN COMPLETED WITH ERRORS: no files were transferred despite the errors."
  fi
  echo "==================================================================="
  exit 1
fi

if [[ "${APPLY}" -eq 0 ]]; then
  echo " DRY RUN COMPLETE - add --apply to make these changes"
else
  echo " SYNC COMPLETE - all selected repos were applied successfully"
fi
echo "==================================================================="
