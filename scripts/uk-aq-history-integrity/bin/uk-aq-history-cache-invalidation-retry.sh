#!/usr/bin/env bash
# Uses the same trusted TEST repository .env as the Integrity operator runner.
set -euo pipefail
SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P -- "${SCRIPT_DIR}/../../.." && pwd -P)"
case "${REPO_ROOT}" in */archive/*) echo 'Archive execution is forbidden.' >&2; exit 3;; esac
test -f "${REPO_ROOT}/.env" || { echo 'Missing TEST repository .env.' >&2; exit 3; }
exec "${UK_AQ_HISTORY_INTEGRITY_PYTHON:-python3}" "${SCRIPT_DIR}/uk-aq-history-cache-invalidation-retry.py" --env-file "${REPO_ROOT}/.env" "$@"
