#!/bin/bash
set -euo pipefail

NORMAL_SERVICE="${1:-}"
AUTHORITY_GENERATION="${2:-}"
OVERRIDE="${3:-}"

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  printf 'Usage: %s NORMAL_SERVICE AUTHORITY_GENERATION [OVERRIDE]\n' "$0" >&2
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

case "$AUTHORITY_GENERATION" in
  v2) EXPECTED_SERVICE="$NORMAL_SERVICE" ;;
  v3) EXPECTED_SERVICE="$CANDIDATE_SERVICE" ;;
  *)
    printf 'Invalid UK_AQ_R2_HISTORY_INDEX_VERSION authority: %s\n' "$AUTHORITY_GENERATION" >&2
    exit 1
    ;;
esac

case "$OVERRIDE" in
  '') RESOLVED_SERVICE="$EXPECTED_SERVICE" ;;
  "$EXPECTED_SERVICE") RESOLVED_SERVICE="$OVERRIDE" ;;
  "$NORMAL_SERVICE"|"$CANDIDATE_SERVICE")
    printf 'Rejected STATION_HISTORY Service Binding override %s: persistent authority %s requires %s\n' \
      "$OVERRIDE" "$AUTHORITY_GENERATION" "$EXPECTED_SERVICE" >&2
    exit 1
    ;;
  *)
    printf 'Rejected STATION_HISTORY Service Binding override: %s\n' "$OVERRIDE" >&2
    exit 1
    ;;
esac

printf '%s\n' "$RESOLVED_SERVICE"
