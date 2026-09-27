#!/usr/bin/env bash
# Promote the LIVE beta website checkout to the public LIVE website checkout.
#
# Source:      UK-AQ/beta-uk-aq      (beta.ukaq.co.uk)
# Destination: UK-AQ/uk-aq.github.io (ukaq.co.uk)
#
# Dry-run is the default. Use --apply to write changes.
#
# Examples:
#   ./beta_sync_to_live.sh
#   ./beta_sync_to_live.sh --apply
set -euo pipefail

LIVE_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos"
SRC="${LIVE_BASE}/LIVE-beta-uk-aq"
DST="${LIVE_BASE}/LIVE-uk-aq.github.io"

APPLY=0

usage() {
  cat <<'USAGE'
Usage: ./beta_sync_to_live.sh [options]

Promotes the LIVE beta website repo to the public LIVE website repo:
  UK-AQ/beta-uk-aq -> UK-AQ/uk-aq.github.io
  beta.ukaq.co.uk  -> ukaq.co.uk

Options:
  --apply               Write/delete public LIVE website files to match beta.
  --dry-run, -n         Explicit dry-run (the default).
  -h, --help            Show this help.

GitHub workflows and the beta notice are included like normal website files.
The public LIVE CNAME and favicon files are preserved.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --dry-run|-n)
      APPLY=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: beta website source repo not found: ${SRC}" >&2
  exit 1
fi

if [[ ! -d "${DST}" ]]; then
  echo "ERROR: public LIVE website destination repo not found: ${DST}" >&2
  exit 1
fi

read_cname() {
  local repo_path="$1"
  if [[ ! -f "${repo_path}/CNAME" ]]; then
    return 1
  fi
  tr -d '\r\n' < "${repo_path}/CNAME"
}

SRC_CNAME="$(read_cname "${SRC}" || true)"
DST_CNAME="$(read_cname "${DST}" || true)"

if [[ "${SRC_CNAME}" != "beta.ukaq.co.uk" ]]; then
  echo "ERROR: source CNAME safety check failed." >&2
  echo "Expected: beta.ukaq.co.uk" >&2
  echo "Found:    ${SRC_CNAME:-<missing>}" >&2
  exit 1
fi

if [[ "${DST_CNAME}" != "ukaq.co.uk" ]]; then
  echo "ERROR: destination CNAME safety check failed." >&2
  echo "Expected: ukaq.co.uk" >&2
  echo "Found:    ${DST_CNAME:-<missing>}" >&2
  exit 1
fi

rsync_args=(
  -av
  --checksum
  --delete-delay
  --itemize-changes
  --human-readable
  --omit-dir-times
  --prune-empty-dirs

  # Repository metadata and local/generated content.
  --exclude='.git/'
  --exclude='.DS_Store'
  --exclude='.env'
  --exclude='.env.*'
  --exclude='*.env'
  --exclude='node_modules/'
  --exclude='.pages-site/'
  --exclude='logs/'

  # Public LIVE owns these values/files.
  --exclude='CNAME'
  --exclude='favicon.ico'
  --exclude='favicon.png'
)

if [[ "${APPLY}" -eq 0 ]]; then
  rsync_args+=(--dry-run)
fi

echo
echo "==================================================================="
if [[ "${APPLY}" -eq 0 ]]; then
  echo " DRY RUN MODE - no public LIVE website files will be changed"
else
  echo " APPLY MODE - PUBLIC LIVE WEBSITE FILES MAY BE WRITTEN OR DELETED"
fi
echo "==================================================================="
echo " WEBSITE ROUTE: LIVE BETA -> PUBLIC LIVE"
echo " Source:      ${SRC}"
echo "              beta.ukaq.co.uk (UK-AQ/beta-uk-aq)"
echo " Destination: ${DST}"
echo "              ukaq.co.uk (UK-AQ/uk-aq.github.io)"
echo " GitHub workflows: INCLUDED"
echo " Beta notice: INCLUDED"
echo " Preserved LIVE-owned files: CNAME, favicon.ico, favicon.png"
echo

if ! rsync "${rsync_args[@]}" "${SRC}/" "${DST}/"; then
  echo
  echo "ERROR: beta -> public LIVE website rsync failed." >&2
  if [[ "${APPLY}" -eq 1 ]]; then
    echo "WARNING: the public LIVE checkout may be partially modified. Review the rsync output and retry after correcting the error." >&2
  fi
  exit 1
fi

echo
echo "==================================================================="
if [[ "${APPLY}" -eq 0 ]]; then
  echo " DRY RUN COMPLETE - nothing was transferred, written or deleted"
  echo " Add --apply to promote beta to the public LIVE website checkout"
else
  echo " CONFIRMED: beta website sync to public LIVE applied successfully"
fi
echo "==================================================================="
