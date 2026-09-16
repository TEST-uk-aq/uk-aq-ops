#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_NAME="2026-09-16_retired_index_v3_experiments_and_legacy_aqi_tools"
MODE="dry-run"

usage() {
  cat <<'EOF'
Usage:
  ./archive_retired_index_v3_tooling.sh
  ./archive_retired_index_v3_tooling.sh --apply

Default is a dry run. --apply performs the moves.

The script:
  - must be run inside TEST-uk-aq/uk-aq-ops;
  - moves only the explicitly listed retired paths;
  - preserves each path beneath archive/<dated-description>/;
  - never deletes or overwrites an existing archive destination;
  - does not git add, commit, push, create branches, or create PRs.
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

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "Not inside a Git repository." >&2
  exit 1
fi

cd "$REPO_ROOT"

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
  *TEST-uk-aq/uk-aq-ops*|*TEST-uk-aq:uk-aq-ops*)
    ;;
  *)
    echo "Refusing to run: origin does not look like TEST-uk-aq/uk-aq-ops." >&2
    echo "origin: ${ORIGIN_URL:-<missing>}" >&2
    exit 1
    ;;
esac

ARCHIVE_DIR="archive/${ARCHIVE_NAME}"

# These are intentionally limited to tooling that has been superseded:
# - candidate/prototype layouts used while designing the final index-v3 implementation;
# - the historical in-place/Dropbox v3 migration wrapper;
# - the old candidate measurement CLI;
# - TEST-only persisted AQI-v2 rebuild tooling, now superseded by calculated AQI.
SOURCES=(
  "scripts/index_v3_aligned_candidate"
  "scripts/index_v3_leaf_fanout_candidate"
  "scripts/index_v3_physical_candidate"
  "scripts/index_v3_physical_candidate_1024"
  "scripts/index_v3_physical_leaf_candidate"
  "scripts/index_v3_prototype"
  "scripts/index_v3_migration/index_v3_migration.sh"
  "scripts/index_v3_migration/measure_observation_history_v3_candidate.mjs"
  "scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs"
  "scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh"
)

echo "Repository:  $REPO_ROOT"
echo "Origin:      $ORIGIN_URL"
echo "Archive dir: $ARCHIVE_DIR"
echo "Mode:        $MODE"
echo

if [[ -e "$ARCHIVE_DIR" ]]; then
  echo "Refusing to run: archive destination already exists:" >&2
  echo "  $ARCHIVE_DIR" >&2
  exit 1
fi

missing=0
collision=0

for src in "${SOURCES[@]}"; do
  if [[ ! -e "$src" ]]; then
    echo "MISSING: $src" >&2
    missing=1
    continue
  fi

  dest="$ARCHIVE_DIR/$src"
  if [[ -e "$dest" ]]; then
    echo "COLLISION: $dest" >&2
    collision=1
  fi
done

if [[ "$missing" -ne 0 || "$collision" -ne 0 ]]; then
  echo >&2
  echo "Preflight failed. Nothing was moved." >&2
  exit 1
fi

echo "Planned moves:"
for src in "${SOURCES[@]}"; do
  printf '  %s\n    -> %s/%s\n' "$src" "$ARCHIVE_DIR" "$src"
done

echo
if [[ "$MODE" == "dry-run" ]]; then
  echo "DRY RUN ONLY: no files were changed."
  echo
  echo "Run again with --apply to perform these moves."
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"

for src in "${SOURCES[@]}"; do
  dest="$ARCHIVE_DIR/$src"
  mkdir -p "$(dirname "$dest")"
  mv "$src" "$dest"
done

cat > "$ARCHIVE_DIR/README.md" <<'EOF'
# Retired index-v3 experiments and legacy AQI tools

Archived: 16/09/2026

This archive contains implementation experiments and superseded operator tooling
that are no longer part of the current UK AQ runtime or the planned LIVE
index-v3 migration path.

Archived groups:

- `scripts/index_v3_aligned_candidate/`
- `scripts/index_v3_leaf_fanout_candidate/`
- `scripts/index_v3_physical_candidate/`
- `scripts/index_v3_physical_candidate_1024/`
- `scripts/index_v3_physical_leaf_candidate/`
- `scripts/index_v3_prototype/`

These directories were candidate/prototype layouts used while developing the
final observation-history v3 architecture.

Also archived:

- `scripts/index_v3_migration/index_v3_migration.sh`
  - Historical in-place/Dropbox recovery wrapper.
  - Superseded by the active side-by-side Node migration CLI:
    `scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs`.

- `scripts/index_v3_migration/measure_observation_history_v3_candidate.mjs`
  - Measurement utility for the superseded candidate implementation.

- `scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs`
- `scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh`
  - TEST-only persisted AQI-v2 rebuild tooling from the retired stored-AQI path.
  - Current visible AQI is calculated from authoritative observations.

The current generation-aware runtime, side-by-side v2-to-v3 migration tooling,
LIVE-capable operator tooling, current TEST repair tooling, and current migration
documentation remain in their active locations.
EOF

echo
echo "Archive move complete."
echo "Nothing has been staged or committed."
echo
echo "Review with:"
echo "  git status --short"
echo "  git diff --stat"
echo "  find \"$ARCHIVE_DIR\" -maxdepth 4 -type f | sort"
