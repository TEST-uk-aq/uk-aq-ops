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
  check_dropbox_backup.sh [-SECONDS]
  check_dropbox_backup.sh --env LIVE|CIC-Test [-SECONDS]
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
  rclone cat "$CHECKPOINT_REMOTE" | python3 -c '
import json
import sys

state = json.load(sys.stdin)
index_units = state.get("index_tree_units", {})


def count_units(key):
    section = index_units.get(key, {})
    units = section.get("units", {}) if isinstance(section, dict) else {}
    return len(units) if isinstance(units, dict) else 0

print(json.dumps({
    "date": state.get("updated_at"),
    "observation_timeseries": count_units("observations_timeseries_v2"),
    "timeseries_bindings": count_units("timeseries_binding_v2"),
}, indent=2))
'
}

while true; do
  show_counts

  if [ "$INTERVAL_SECONDS" -le 0 ]; then
    break
  fi

  echo
  sleep "$INTERVAL_SECONDS"
done
