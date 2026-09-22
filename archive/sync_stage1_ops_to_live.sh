#!/usr/bin/env bash
set -euo pipefail

# Stage 1 TEST -> LIVE OPS promotion.
#
# Copies only:
#   1. current production/generation-aware files required by LIVE while
#      UK_AQ_R2_HISTORY_VERSION remains v2; and
#   2. reviewed production v3 migration/cutover tooling that may remain dormant
#      until the later LIVE v2 -> v3 migration.
#
# Deliberately does NOT copy:
#   - candidate/prototype Workers or candidate deploy workflows;
#   - TEST-only integrity launchers/env examples;
#   - retired tooling moved to archive/;
#   - optional/ad-hoc diagnostic and repair utilities;
#   - local patch artefacts;
#   - repository README/.gitignore housekeeping changes.
#
# Default mode is dry-run. Use --apply to copy into the local LIVE working tree.
# This script never deletes destination files and performs no Git operations.

MODE="dry-run"

usage() {
  cat <<'EOF'
Usage:
  ./sync_stage1_ops_to_live.sh
  ./sync_stage1_ops_to_live.sh --apply

Environment override:
  LIVE_OPS_DIR=/path/to/LIVE-uk-aq-ops ./sync_stage1_ops_to_live.sh [--apply]

Default LIVE destination:
  /Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos/LIVE-uk-aq-ops

The script modifies only the local LIVE working tree. It does not git add,
commit, push, create a branch, or create a pull request.
EOF
}

case "${1:-}" in
  "")
    ;;
  --apply)
    MODE="apply"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown argument: ${1}" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ $# -gt 1 ]]; then
  echo "Too many arguments." >&2
  usage >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || {
  echo "ERROR: git is not available on PATH." >&2
  exit 1
}
command -v rsync >/dev/null 2>&1 || {
  echo "ERROR: rsync is not available on PATH." >&2
  exit 1
}

SOURCE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$SOURCE_ROOT" ]]; then
  echo "ERROR: Run this from inside TEST-uk-aq/uk-aq-ops." >&2
  exit 1
fi

SOURCE_ORIGIN="$(git -C "$SOURCE_ROOT" remote get-url origin 2>/dev/null || true)"
case "$SOURCE_ORIGIN" in
  *TEST-uk-aq/uk-aq-ops*|*TEST-uk-aq:uk-aq-ops*)
    ;;
  *)
    echo "ERROR: Source origin is not TEST-uk-aq/uk-aq-ops." >&2
    echo "       origin=${SOURCE_ORIGIN:-<missing>}" >&2
    exit 1
    ;;
esac

DEST_ROOT="${LIVE_OPS_DIR:-/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos/LIVE-uk-aq-ops}"

if [[ ! -d "$DEST_ROOT/.git" ]]; then
  echo "ERROR: LIVE destination is not a Git working tree:" >&2
  echo "       $DEST_ROOT" >&2
  exit 1
fi

DEST_ORIGIN="$(git -C "$DEST_ROOT" remote get-url origin 2>/dev/null || true)"
case "$DEST_ORIGIN" in
  *UK-AQ/uk-aq-ops*|*UK-AQ:uk-aq-ops*)
    ;;
  *)
    echo "ERROR: Destination origin is not UK-AQ/uk-aq-ops." >&2
    echo "       origin=${DEST_ORIGIN:-<missing>}" >&2
    exit 1
    ;;
esac

REQUIRED_NOW=(
  ".github/workflows/uk_aq_cache_proxy_deploy.yml"
  ".github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml"
  ".github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml"
  ".github/workflows/uk_aq_db_r2_metrics_api_worker_deploy.yml"
  ".github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml"
  ".github/workflows/uk_aq_observs_history_dashboard_workers_deploy.yml"
  ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml"
  ".github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml"
  ".github/workflows/uk_aq_prune_daily.yml"
  ".github/workflows/uk_aq_r2_core_snapshot.yml"
  ".github/workflows/uk_aq_r2_history_dropbox_backup.yml"
  ".github/workflows/uk_aq_r2_history_restore_from_dropbox.yml"
  ".github/workflows/uk_aq_station_history_deploy.yml"
  ".github/workflows/uk_aq_who_2021_daily.yml"
  "VERSION_ops"
  "cloudflare/scheduler/README.md"
  "cloudflare/scheduler/migrations/0003_worker_http_target.sql"
  "cloudflare/scheduler/scripts/sync_jobs.py"
  "cloudflare/scheduler/worker.mjs"
  "config/uk_aq_github_env_targets.csv"
  "dashboard/assets/daily_task_refresh_patch.js"
  "dashboard/assets/media.css"
  "dashboard/assets/media.js"
  "dashboard/assets/storage_coverage_patch.js"
  "dashboard/index.html"
  "local/dashboard/server/requirements.txt"
  "local/dashboard/server/uk_aq_dashboard_api.py"
  "local/dashboard/server/uk_aq_dashboard_api_core.py"
  "local/dashboard/server/uk_aq_dashboard_cache.py"
  "local/dashboard/server/uk_aq_dashboard_cache_refresh.py"
  "local/dashboard/server/uk_aq_dashboard_direct_r2_patch.py"
  "local/dashboard/server/uk_aq_dashboard_history_generation.py"
  "local/dashboard/server/uk_aq_dashboard_media_proxy.py"
  "local/dashboard/server/uk_aq_dashboard_rolling_cache.py"
  "local/scripts/run_dashboard.sh"
  "package-lock.json"
  "package.json"
  "scripts/backup_r2/build_backup_inventory.mjs"
  "scripts/backup_r2/build_history_backup_task_summary.mjs"
  "scripts/backup_r2/lib/hierarchical_backup_v2.mjs"
  "scripts/backup_r2/lib/hierarchical_timeseries_binding_pack_sync_v1.mjs"
  "scripts/backup_r2/lib/observation_binding_publication_lock.mjs"
  "scripts/backup_r2/lib/observation_history_generation_bindings.mjs"
  "scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs"
  "scripts/backup_r2/lib/timeseries_binding_pack_inventory_v1.mjs"
  "scripts/backup_r2/lib/timeseries_binding_pack_restore_v1.mjs"
  "scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs"
  "scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs"
  "scripts/backup_r2/lib/uk_aq_integrity_core_snapshot_identity.mjs"
  "scripts/backup_r2/migrate_hierarchical_checkpoint_generation.mjs"
  "scripts/backup_r2/publish_timeseries_binding_backup_packs.mjs"
  "scripts/backup_r2/restore_history_from_dropbox.mjs"
  "scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs"
  "scripts/backup_r2/sync_history_to_dropbox.mjs"
  "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs"
  "scripts/backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs"
  "scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs"
  "scripts/backup_r2/uk_aq_refresh_timeseries_binding_source_hierarchy.mjs"
  "scripts/backup_r2/uk_aq_run_locked_history_backup.mjs"
  "scripts/mbpro_scheduler_watchdog/README.md"
  "scripts/mbpro_scheduler_watchdog/install_launchagent.sh"
  "scripts/mbpro_scheduler_watchdog/status_launchagent.sh"
  "scripts/mbpro_scheduler_watchdog/uk.co.ukaq.scheduler-watchdog.plist.template"
  "scripts/mbpro_scheduler_watchdog/uk_aq_scheduler_watchdog.py"
  "scripts/mbpro_scheduler_watchdog/uninstall_launchagent.sh"
  "scripts/mbpro_scheduler_watchdog/watchdog.env.example"
  "scripts/mbpro_scheduler_watchdog/watchdog_launchagent_common.sh"
  "scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs"
  "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs"
  "scripts/report_daily_task_health.mjs"
  "scripts/uk-aq-history-integrity/bin/integrity/runtime.py"
  "scripts/uk-aq-history-integrity/bin/integrity/timeseries_binding_provider.py"
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v2.sh"
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py"
  "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh"
  "scripts/uk-aq-history-integrity/deploy-bin/uk-aq-history-integrity-sos-light-v2.sh"
  "scripts/uk-aq-history-integrity/dev-scripts/integrity-run-monthly-LIVE.sh"
  "scripts/uk-aq-history-integrity/dev-scripts/integrity-run-monthly.sh"
  "scripts/uk-aq-history-integrity/dev-scripts/uk-aq-package-latest-integrity-run.py"
  "scripts/who_2021/run_who_2021_months.py"
  "workers/shared/r2_sigv4.mjs"
  "workers/shared/uk_aq_connector_day_gate.mjs"
  "workers/shared/uk_aq_observation_content_hash.mjs"
  "workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs"
  "workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs"
  "workers/shared/uk_aq_observation_history_generation.mjs"
  "workers/shared/uk_aq_observation_history_index_v3.mjs"
  "workers/shared/uk_aq_observation_history_operational_writer_v3.mjs"
  "workers/shared/uk_aq_observation_history_random_access_v3.mjs"
  "workers/shared/uk_aq_observation_history_reader_v3.mjs"
  "workers/shared/uk_aq_observation_history_schema.mjs"
  "workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs"
  "workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs"
  "workers/shared/uk_aq_observation_history_target_writer.mjs"
  "workers/shared/uk_aq_observation_history_writer_limits_v3.mjs"
  "workers/shared/uk_aq_r2_checksum_publication.mjs"
  "workers/shared/uk_aq_r2_history_canonical.mjs"
  "workers/shared/uk_aq_r2_history_index.mjs"
  "workers/shared/uk_aq_r2_history_profile.mjs"
  "workers/shared/uk_aq_r2_history_writer.mjs"
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs"
  "workers/uk_aq_cache_proxy/resolve_station_history_service.sh"
  "workers/uk_aq_cache_proxy/src/entry.ts"
  "workers/uk_aq_cache_proxy/src/index.ts"
  "workers/uk_aq_cache_proxy/src/media_public_route.ts"
  "workers/uk_aq_cache_proxy/src/media_public_route_check.ts"
  "workers/uk_aq_cache_proxy/src/who_daily_series_route.ts"
  "workers/uk_aq_cache_proxy/wrangler.toml"
  "workers/uk_aq_dashboard_online_api_worker/README.md"
  "workers/uk_aq_dashboard_online_api_worker/package-lock.json"
  "workers/uk_aq_dashboard_online_api_worker/package.json"
  "workers/uk_aq_dashboard_online_api_worker/src/index.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/history_generation.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/r2_metrics_service.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_http_enrichment.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/lib/upstream.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/routes/compat.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/routes/media.ts"
  "workers/uk_aq_dashboard_online_api_worker/src/routes/status.ts"
  "workers/uk_aq_db_size_metrics_api_worker/README.md"
  "workers/uk_aq_db_size_metrics_api_worker/history_days_enrichment.mjs"
  "workers/uk_aq_db_size_metrics_api_worker/worker.mjs"
  "workers/uk_aq_db_size_metrics_api_worker/wrangler.toml.example"
  "workers/uk_aq_latest_snapshot_cloud_run/Dockerfile"
  "workers/uk_aq_latest_snapshot_cloud_run/run_job.ts"
  "workers/uk_aq_observs_history_r2_api_worker/README.md"
  "workers/uk_aq_observs_history_r2_api_worker/package-lock.json"
  "workers/uk_aq_observs_history_r2_api_worker/package.json"
  "workers/uk_aq_observs_history_r2_api_worker/worker.mjs"
  "workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs"
  "workers/uk_aq_observs_history_r2_api_worker/wrangler.toml"
  "workers/uk_aq_prune_daily/job.mjs"
  "workers/uk_aq_prune_daily/pg_source_egress_diagnostic.mjs"
  "workers/uk_aq_prune_daily/phase_b_history_r2.mjs"
  "workers/uk_aq_prune_daily/server.mjs"
  "workers/uk_aq_station_history/README.md"
  "workers/uk_aq_station_history/src/calculated_history.mjs"
  "workers/uk_aq_station_history/src/history_chunks.mjs"
  "workers/uk_aq_station_history/src/index.mjs"
  "workers/uk_aq_station_history/src/limits.mjs"
  "workers/uk_aq_station_history/src/r2_observations.mjs"
  "workers/uk_aq_who_2021_daily/r2_objects.ts"
  "workers/uk_aq_who_2021_daily/r2_observations.ts"
)

DORMANT_V3=(
  "scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs"
  "scripts/backup_r2/lib/observation_history_migration_concurrency.mjs"
  "scripts/backup_r2/lib/observation_history_migration_gcp.mjs"
  "scripts/backup_r2/lib/observation_history_migration_v3.mjs"
  "scripts/backup_r2/lib/observation_history_migration_worker.mjs"
  "scripts/backup_r2/lib/observation_history_migration_worker_pool.mjs"
  "scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs"
  "scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs"
  "scripts/backup_r2/uk_aq_apply_sos_light_v3_proposal.mjs"
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs"
  "scripts/backup_r2/uk_aq_observation_history_migration_v3_gcp.mjs"
  "scripts/index_v3_migration/capture_v2_runtime_authority.mjs"
  "scripts/index_v3_migration/diagnose_index_v3_source_hierarchy_drift.sh"
  "scripts/index_v3_migration/diagnose_index_v3_source_root_identity.sh"
  "scripts/index_v3_migration/index_v3_capture_operator_evidence.mjs"
  "scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.mjs"
  "scripts/index_v3_migration/index_v3_controlled_phase_b_acceptance.sh"
  "scripts/index_v3_migration/index_v3_controlled_phase_b_source_freeze.mjs"
  "scripts/index_v3_migration/index_v3_cutover_generation_evidence.mjs"
  "scripts/index_v3_migration/index_v3_historical_post_cutover_verify.sh"
  "scripts/index_v3_migration/index_v3_operator_evidence.mjs"
  "scripts/index_v3_migration/index_v3_post_cutover_verify.sh"
  "scripts/index_v3_migration/index_v3_preflight.sh"
  "scripts/index_v3_migration/index_v3_steady_state_post_write_verify.mjs"
  "scripts/index_v3_migration/index_v3_steady_state_post_write_verify.sh"
  "scripts/index_v3_migration/operator_execution.mjs"
  "scripts/index_v3_migration/recovery_journal_authority.mjs"
  "scripts/index_v3_migration/recovery_post_migration_root_evidence.mjs"
  "scripts/index_v3_migration/rollback_executor_authority.mjs"
  "scripts/index_v3_migration/v2_runtime_artifact.mjs"
  "scripts/index_v3_migration/v2_runtime_recovery.mjs"
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.py"
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.sh"
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py"
  "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill_v3.sh"
  "scripts/uk-aq-history-integrity/deploy-bin/uk-aq-history-integrity-sos-light-v3.sh"
)


ALL_FILES=("${REQUIRED_NOW[@]}" "${DORMANT_V3[@]}")

# Structural preflight: exact source files must exist and lists must not overlap.
declare -A SEEN=()
missing=0
duplicate=0
for path in "${ALL_FILES[@]}"; do
  if [[ -n "${SEEN[$path]:-}" ]]; then
    echo "ERROR: Duplicate allow-list entry: $path" >&2
    duplicate=1
  fi
  SEEN["$path"]=1

  if [[ ! -f "$SOURCE_ROOT/$path" ]]; then
    echo "ERROR: Missing source file: $path" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 || "$duplicate" -ne 0 ]]; then
  echo "Preflight failed. Nothing was copied." >&2
  exit 1
fi

DEST_STATUS="$(git -C "$DEST_ROOT" status --porcelain --untracked-files=normal)"
if [[ "$MODE" == "apply" && -n "$DEST_STATUS" ]]; then
  echo "ERROR: LIVE destination working tree is not clean." >&2
  echo "Review/commit/stash its existing changes before applying this promotion:" >&2
  printf '%s\n' "$DEST_STATUS" >&2
  exit 1
fi

echo "==================================================================="
if [[ "$MODE" == "dry-run" ]]; then
  echo " DRY RUN - no files will be written"
else
  echo " APPLY MODE - files will be copied into the local LIVE working tree"
fi
echo "==================================================================="
echo
echo "Source:      $SOURCE_ROOT"
echo "Source repo: $SOURCE_ORIGIN"
echo "Destination: $DEST_ROOT"
echo "LIVE repo:   $DEST_ORIGIN"
echo
echo "Required now on LIVE/v2: ${#REQUIRED_NOW[@]} files"
echo "Dormant until v3 work:   ${#DORMANT_V3[@]} files"
echo "Total allow-list:        ${#ALL_FILES[@]} files"
echo

LIST_FILE="$(mktemp "${TMPDIR:-/tmp}/uk-aq-stage1-ops-files.XXXXXX")"
trap 'rm -f "$LIST_FILE"' EXIT
printf '%s\0' "${ALL_FILES[@]}" > "$LIST_FILE"

cd "$SOURCE_ROOT"

RSYNC_ARGS=(
  -a
  -R
  -c
  -i
  --from0
  --files-from="$LIST_FILE"
)

if [[ "$MODE" == "dry-run" ]]; then
  RSYNC_ARGS+=(--dry-run)
fi

# No --delete is intentionally used.
rsync "${RSYNC_ARGS[@]}" ./ "$DEST_ROOT/"

echo
echo "==================================================================="
if [[ "$MODE" == "dry-run" ]]; then
  echo " DRY RUN COMPLETE - nothing was copied"
  echo " Run again with --apply after reviewing the itemised changes."
else
  echo " COPY COMPLETE - local LIVE working tree only"
  echo
  echo "Review:"
  git -C "$DEST_ROOT" status --short
fi
echo "==================================================================="
echo
echo "IMPORTANT:"
echo "  Do not commit/push the LIVE changes until LIVE repository variables and"
echo "  secrets have been reviewed. Several copied workflows deploy on push to main."
echo
echo "  In particular keep the observation authority on:"
echo "    UK_AQ_R2_HISTORY_VERSION=v2"
echo
echo "  and prepare the Media settings before deployment:"
echo "    UK_AQ_MEDIA_PUBLIC_URL"
echo "    UK_AQ_MEDIA_ADMIN_URL"
echo "    UK_AQ_MEDIA_ADMIN_TOKEN"
echo
echo "No files were deleted. No Git staging, commit or push was performed."
