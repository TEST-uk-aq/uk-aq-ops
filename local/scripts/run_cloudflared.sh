#!/usr/bin/env bash
# Starts the Cloudflare Tunnel. Works on both Apple Silicon (/opt/homebrew)
# and Intel (/usr/local) Macs.
set -euo pipefail

for CFLARED in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
  if [[ -x "$CFLARED" ]]; then
    exec "$CFLARED" tunnel --config "$HOME/.cloudflared/config.yml" run
  fi
done

echo "cloudflared not found in /opt/homebrew/bin or /usr/local/bin" >&2
exit 1
