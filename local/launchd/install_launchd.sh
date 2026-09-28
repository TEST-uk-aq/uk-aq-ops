#!/usr/bin/env bash
# Installs (or reloads) the test dashboard, dashboard cache refresher, and cloudflared launchd services.
# Run once after setting up .env, dashboard cache env files, and ~/.cloudflared/config.yml.
# The live dashboard is installed separately from the LIVE-uk-aq-ops repo.
set -euo pipefail

PLIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOGS_DIR="$(cd "$PLIST_DIR/../.." && pwd)/logs"
MYSQL_LABEL="com.oracle.oss.mysql.mysqld"
MYSQL_PLIST="/Library/LaunchDaemons/${MYSQL_LABEL}.plist"

mysql_launchdaemon_preflight() {
  if [[ ! -f "$MYSQL_PLIST" ]]; then
    echo "ERROR: Oracle MySQL LaunchDaemon plist is missing: $MYSQL_PLIST" >&2
    echo "Install/repair the existing Oracle MySQL system service before installing dashboard LaunchAgents." >&2
    return 1
  fi
  if ! plutil -lint "$MYSQL_PLIST" >/dev/null; then
    echo "ERROR: Oracle MySQL LaunchDaemon plist is invalid: $MYSQL_PLIST" >&2
    return 1
  fi

  local label program owner group mode
  label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$MYSQL_PLIST" 2>/dev/null || true)"
  program="$(/usr/libexec/PlistBuddy -c 'Print :Program' "$MYSQL_PLIST" 2>/dev/null || true)"
  owner="$(stat -f '%Su' "$MYSQL_PLIST")"
  group="$(stat -f '%Sg' "$MYSQL_PLIST")"
  mode="$(stat -f '%OLp' "$MYSQL_PLIST")"
  if [[ "$label" != "$MYSQL_LABEL" ]]; then
    echo "ERROR: Oracle MySQL LaunchDaemon Label is '$label'; expected '$MYSQL_LABEL'." >&2
    return 1
  fi
  if [[ "$owner" != "root" || "$group" != "wheel" ]]; then
    echo "ERROR: $MYSQL_PLIST must be owned by root:wheel (found $owner:$group)." >&2
    return 1
  fi
  if (( (8#$mode & 0022) != 0 )); then
    echo "ERROR: $MYSQL_PLIST must not be group/world writable (mode $mode)." >&2
    return 1
  fi
  if [[ -z "$program" || ! -x "$program" ]]; then
    echo "ERROR: Oracle MySQL LaunchDaemon Program is not executable: ${program:-'(unset)'}" >&2
    return 1
  fi

  if ! launchctl print "system/$MYSQL_LABEL" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: Oracle MySQL is not registered in the system launchd domain.

Do not make the dashboard LaunchAgents start MySQL. Run this one-time system repair manually:
  sudo /usr/local/mysql/support-files/mysql.server stop
  sudo launchctl enable system/$MYSQL_LABEL
  sudo launchctl bootstrap system $MYSQL_PLIST
  sudo launchctl kickstart -k system/$MYSQL_LABEL

Then verify:
  sudo launchctl print-disabled system | grep '$MYSQL_LABEL'
  sudo launchctl print system/$MYSQL_LABEL
  /usr/local/mysql/bin/mysqladmin --protocol=socket --socket=/tmp/mysql.sock ping
  ls -l /tmp/mysql.sock

Re-run $0 only after the system service is registered.
EOF
    return 1
  fi

  if [[ ! -S /tmp/mysql.sock ]]; then
    echo "ERROR: Oracle MySQL LaunchDaemon is registered but /tmp/mysql.sock is absent." >&2
    echo "Inspect with: sudo launchctl print system/$MYSQL_LABEL" >&2
    echo "Start it with: sudo launchctl kickstart -k system/$MYSQL_LABEL" >&2
    return 1
  fi
}

mysql_launchdaemon_preflight

mkdir -p "$AGENTS_DIR" "$LOGS_DIR"

PLISTS=(
  co.uk.chronicillnesschannel.aq.dashboard.test.plist
  co.uk.chronicillnesschannel.aq.dashboard-cache.test.plist
  co.uk.chronicillnesschannel.aq.cloudflared.plist
)

for plist in "${PLISTS[@]}"; do
  label="${plist%.plist}"
  src="$PLIST_DIR/$plist"
  dest="$AGENTS_DIR/$plist"

  # Unload first if already loaded (ignore errors if not loaded).
  launchctl unload "$dest" 2>/dev/null || true

  cp "$src" "$dest"
  launchctl load "$dest"
  echo "Loaded: $label"
done

echo ""
echo "Services installed. Check status:"
echo "  launchctl list | grep chronicillnesschannel"
echo ""
echo "View logs:"
echo "  tail -f $LOGS_DIR/dashboard_test.log"
echo "  tail -f $LOGS_DIR/dashboard_cache_test.log"
echo "  tail -f $LOGS_DIR/cloudflared.log"
