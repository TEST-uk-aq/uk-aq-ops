#!/usr/bin/env bash
# Installs (or reloads) the three launchd services into ~/Library/LaunchAgents.
# Run this once after setting up .env.test, .env.live, and ~/.cloudflared/config.yml.
set -euo pipefail

PLIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOGS_DIR="$(cd "$PLIST_DIR/../.." && pwd)/logs"

mkdir -p "$AGENTS_DIR" "$LOGS_DIR"

PLISTS=(
  co.uk.chronicillnesschannel.aq.dashboard.test.plist
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
echo "  tail -f $LOGS_DIR/dashboard_live.log"
echo "  tail -f $LOGS_DIR/cloudflared.log"
