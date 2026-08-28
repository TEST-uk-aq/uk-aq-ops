#!/bin/bash
set -euo pipefail

NORMAL_SERVICE="${1:-}"
OVERRIDE="${2:-}"

if [ "$#" -gt 2 ]; then
  printf 'Usage: %s NORMAL_SERVICE [OVERRIDE]\n' "$0" >&2
  exit 2
fi

case "$NORMAL_SERVICE" in
  ''|*[!a-z0-9-]*|-*|*-|*-v3-candidate)
    printf 'Invalid stable station-history Worker identity: %s\n' "$NORMAL_SERVICE" >&2
    exit 1
    ;;
esac

CANDIDATE_SERVICE="${NORMAL_SERVICE}-v3-candidate"
[ "${#CANDIDATE_SERVICE}" -le 63 ] || {
  printf 'Derived station-history candidate Worker identity is too long.\n' >&2
  exit 1
}

case "$OVERRIDE" in
  '') RESOLVED_SERVICE="$NORMAL_SERVICE" ;;
  "$NORMAL_SERVICE"|"$CANDIDATE_SERVICE") RESOLVED_SERVICE="$OVERRIDE" ;;
  *)
    printf 'Rejected STATION_HISTORY Service Binding override: %s\n' "$OVERRIDE" >&2
    exit 1
    ;;
esac

printf '%s\n' "$RESOLVED_SERVICE"
