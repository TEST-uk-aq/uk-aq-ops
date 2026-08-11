#!/usr/bin/env bash

set -u
set -o pipefail

ENV_NAME="LIVE"
INTERVAL_SECONDS=0
RCLONE_REMOTE="uk_aq_dropbox"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      ENV_NAME="${2:?Missing value after --env}"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="${2:?Missing value after --interval}"
      shift 2
      ;;
    --remote)
      RCLONE_REMOTE="${2:?Missing value after --remote}"
      shift 2
      ;;
    -[0-9]*)
      INTERVAL_SECONDS="${1#-}"
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage:
  check_dropbox_backup_counts.sh [-SECONDS]
  check_dropbox_backup_counts.sh --env LIVE|CIC-Test [-SECONDS]
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$ENV_NAME" in
  LIVE|CIC-Test) ;;
  *) echo "--env must be LIVE or CIC-Test" >&2; exit 2 ;;
esac

case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*)
    echo "Interval must be a whole number of seconds" >&2
    exit 2
    ;;
esac

CHECKPOINT_REMOTE="${RCLONE_REMOTE}:${ENV_NAME}/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2.json"

show_counts() {
  local json_result

  json_result="$({
    rclone cat "$CHECKPOINT_REMOTE" | python3 -c '
import json
import sys

state = json.load(sys.stdin)
index_units = state.get("index_tree_units", {})
summary = state.get("summary", {})


def count_units(key):
    section = index_units.get(key, {}) if isinstance(index_units, dict) else {}
    units = section.get("units", {}) if isinstance(section, dict) else {}
    return len(units) if isinstance(units, dict) else 0


def summary_count(section_key, item_key):
    section = summary.get(section_key, {}) if isinstance(summary, dict) else {}
    value = section.get(item_key) if isinstance(section, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


print(json.dumps({
    "date": state.get("updated_at"),
    "observation_objects": summary_count("domain_object_count", "observations"),
    "observation_timeseries": count_units("observations_timeseries_v2"),
    "timeseries_bindings": count_units("timeseries_binding_v2"),
}, indent=2))
'
  })" || return 1

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$json_result" | jq -C .
  else
    printf '%s\n' "$json_result"
  fi
}

while true; do
  show_counts

  if [ "$INTERVAL_SECONDS" -le 0 ]; then
    break
  fi

  echo
  sleep "$INTERVAL_SECONDS"
done
