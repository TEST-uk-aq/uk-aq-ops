#!/usr/bin/env bash

watchdog_load_identity() {
  local config_file="${1:-}"
  local raw_environment=""

  case "$config_file" in
    /*) ;;
    *)
      echo "Watchdog configuration path must be absolute." >&2
      return 1
      ;;
  esac

  if [ -z "$config_file" ] || [ ! -f "$config_file" ]; then
    echo "Watchdog configuration file is required." >&2
    return 1
  fi
  if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
    echo "A valid user HOME is required." >&2
    return 1
  fi

  raw_environment="$(
    awk '
      {
        line = $0
        sub(/\r$/, "", line)
        if (line ~ /^[[:space:]]*($|#)/) next
        separator = index(line, "=")
        if (!separator) next
        key = substr(line, 1, separator - 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
        if (key != "UKAQ_ENV_NAME") next
        value = substr(line, separator + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        count += 1
        environment = value
      }
      END {
        if (count != 1 || environment == "") exit 1
        print environment
      }
    ' "$config_file"
  )" || {
    echo "Configuration must contain exactly one non-empty UKAQ_ENV_NAME." >&2
    return 1
  }

  WATCHDOG_ENVIRONMENT="$(printf '%s' "$raw_environment" | tr '[:lower:]' '[:upper:]')"
  case "$WATCHDOG_ENVIRONMENT" in
    TEST) WATCHDOG_ENVIRONMENT_SUFFIX="test" ;;
    LIVE) WATCHDOG_ENVIRONMENT_SUFFIX="live" ;;
    *)
      echo "UKAQ_ENV_NAME must be TEST or LIVE." >&2
      return 1
      ;;
  esac

  WATCHDOG_LABEL="uk.co.ukaq.${WATCHDOG_ENVIRONMENT_SUFFIX}-scheduler-watchdog"
  WATCHDOG_SUPPORT_DIR="${HOME}/Library/Application Support/UK AQ/scheduler-watchdog-${WATCHDOG_ENVIRONMENT_SUFFIX}"
  WATCHDOG_INSTALL_DIR="${WATCHDOG_SUPPORT_DIR}/bin"
  WATCHDOG_LOG_DIR="${HOME}/Library/Logs/UK AQ/scheduler-watchdog-${WATCHDOG_ENVIRONMENT_SUFFIX}"
  WATCHDOG_PLIST_PATH="${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
}

watchdog_print_identity() {
  printf 'Environment: %s\n' "$WATCHDOG_ENVIRONMENT"
  printf 'LaunchAgent: %s\n' "$WATCHDOG_LABEL"
  printf 'Support directory: %s\n' "$WATCHDOG_SUPPORT_DIR"
  printf 'Install directory: %s\n' "$WATCHDOG_INSTALL_DIR"
  printf 'Log directory: %s\n' "$WATCHDOG_LOG_DIR"
  printf 'Plist: %s\n' "$WATCHDOG_PLIST_PATH"
}
