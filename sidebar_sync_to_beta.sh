#!/usr/bin/env bash
# Copy only the TEST website sidebar.js into the LIVE BETA website checkout.
# Keep TEST's shared footer, legal/licence attribution and other sidebar logic,
# but omit navigation links for features not yet promoted to LIVE beta.
#
# Dry-run by default; --apply is the only mode that changes a destination file.
# Run from anywhere:
#   ./sidebar_sync_to_beta.sh
#   ./sidebar_sync_to_beta.sh --apply
set -euo pipefail

# ── Repo paths (same local repo roots as sync_to_live.sh) ─────────────────────
TEST_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos"
LIVE_BASE="/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/LIVE UK-AQ GH Repos"

SRC="${TEST_BASE}/TEST-uk-aq.github.io"
DST="${LIVE_BASE}/LIVE-beta-uk-aq"

# ── Website feature copy switches ──────────────────────────────────────────
# false = omit that feature's sidebar navigation entry in LIVE beta.
# true  = keep the entry exactly as it appears in TEST.
# These switches control navigation ONLY. They do not copy feature pages,
# images or code, or uncomment TEST entries that are already disabled.
COPY_SENSORS=false
COPY_WHO_GUIDELINES=false
COPY_WOOD_BURNING=false
COPY_NAEI_DATA=false
COPY_RESEARCH=false
COPY_BLOG=true

APPLY=0

usage() {
  cat <<'USAGE'
Usage: ./sidebar_sync_to_beta.sh [--apply | --dry-run | -n] [-h | --help]

Copy TEST website sidebar.js to the LIVE BETA website checkout only:
  TEST-uk-aq/TEST-uk-aq.github.io -> UK-AQ/beta-uk-aq

The source file's footer, Welsh AQN/SAQN/NI licence attributions, shared
network-catalogue logic and unrelated sidebar behaviour remain unchanged.
Feature navigation entries listed near the top of this script are removed
from the destination copy when their COPY_* switch is false.

Options:
  --apply          Actually replace LIVE beta sidebar.js.
  --dry-run, -n    Preview the result without writing anything (default).
  -h, --help       Show this help.

This never edits TEST, never touches the public LIVE website, and never
commits, pushes or deploys. No other files are copied or deleted.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run|-n) APPLY=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for flag in \
  COPY_SENSORS COPY_WHO_GUIDELINES COPY_WOOD_BURNING \
  COPY_NAEI_DATA COPY_RESEARCH COPY_BLOG
do
  value="${!flag}"
  if [[ "${value}" != "true" && "${value}" != "false" ]]; then
    echo "ERROR: ${flag} must be true or false (lowercase), found: ${value}" >&2
    exit 2
  fi
done

if [[ ! -f "${SRC}/sidebar.js" || -L "${SRC}/sidebar.js" ]]; then
  echo "ERROR: TEST source sidebar.js missing or a symlink: ${SRC}/sidebar.js" >&2
  exit 1
fi
if [[ ! -d "${DST}" || ! -f "${DST}/sidebar.js" || -L "${DST}/sidebar.js" ]]; then
  echo "ERROR: LIVE beta destination/sidebar.js missing or a symlink: ${DST}" >&2
  exit 1
fi

read_cname() {
  local file="$1/CNAME"
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  tr -d '\r\n' < "${file}"
}

src_cname="$(read_cname "${SRC}" || true)"
dst_cname="$(read_cname "${DST}" || true)"
if [[ "${src_cname}" != "test-uk-aq.ukaq.co.uk" ]]; then
  echo "ERROR: source identity check failed; expected test-uk-aq.ukaq.co.uk, got ${src_cname:-<missing>}" >&2
  exit 1
fi
if [[ "${dst_cname}" != "beta.ukaq.co.uk" ]]; then
  echo "ERROR: destination identity check failed; expected beta.ukaq.co.uk, got ${dst_cname:-<missing>}" >&2
  exit 1
fi

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 1; }

echo
echo "==================================================================="
if [[ "${APPLY}" -eq 0 ]]; then
  echo " DRY RUN - NO FILES WILL BE WRITTEN"
else
  echo " APPLY - WILL REPLACE ONLY LIVE BETA sidebar.js"
fi
echo "==================================================================="
echo " Source:      ${SRC}/sidebar.js"
echo " Destination: ${DST}/sidebar.js"
echo " Public LIVE: UNTOUCHED"
echo

python3 - \
  "${SRC}/sidebar.js" "${DST}/sidebar.js" "${APPLY}" \
  "${COPY_SENSORS}" "${COPY_WHO_GUIDELINES}" \
  "${COPY_WOOD_BURNING}" "${COPY_NAEI_DATA}" "${COPY_RESEARCH}" \
  "${COPY_BLOG}" <<'PY'
from pathlib import Path
import difflib
import os
import re
import stat
import sys
import tempfile

source, destination = Path(sys.argv[1]), Path(sys.argv[2])
apply = sys.argv[3] == "1"
features = (
    ("Sensors", "/sensors/", sys.argv[4] == "true"),
    ("WHO Guidelines", "/who-guidelines/", sys.argv[5] == "true"),
    ("Wood Burning", "/wood-burning/", sys.argv[6] == "true"),
    ("NAEI Data", "/naei-data/", sys.argv[7] == "true"),
    ("Research", "/research/", sys.argv[8] == "true"),
    ("Blog", "/blog/", sys.argv[9] == "true"),
)

source_lines = source.read_text(encoding="utf-8").splitlines(keepends=True)
destination_text = destination.read_text(encoding="utf-8")

# Fail closed if TEST's nav structure has changed. Only lines in the NAV
# configuration are eligible for removal; legal/footer references are not.
nav_starts = [
    i for i, line in enumerate(source_lines)
    if re.match(r"^\s*const NAV\s*=\s*\[", line)
]
if len(nav_starts) != 1:
    sys.exit(f"ERROR: expected one 'const NAV = [' in {source}, found {len(nav_starts)}")
nav_start = nav_starts[0]
nav_ends = [
    i for i in range(nav_start + 1, len(source_lines))
    if re.match(r"^\s*const HOME_ITEM\s*=\s*\{", source_lines[i])
]
if len(nav_ends) != 1:
    sys.exit(f"ERROR: expected one HOME_ITEM after NAV in {source}, found {len(nav_ends)}")
nav_end = nav_ends[0]

removed_indices = set()
replacement_lines = {}
for name, route, copy in features:
    marker = f"href: '{route}'"
    matches = [
        i for i in range(nav_start, nav_end)
        if marker in source_lines[i]
    ]
    if len(matches) != 1:
        sys.exit(
            f"ERROR: expected exactly one {name} nav line ({route}) in TEST; "
            f"found {len(matches)}. No changes made."
        )
    if copy:
        status = "KEEP as in TEST"
    else:
        index = matches[0]
        line = source_lines[index]
        if name == "Blog" and re.match(r"^\s*\*/", line):
            # The TEST Blog item immediately follows a closing block-comment
            # marker for the disabled YouTube item. Keep the closing marker
            # even when COPY_BLOG=false, or the rest of sidebar.js is commented out.
            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            replacement_lines[index] = line[:line.index("*/") + 2] + newline
        else:
            removed_indices.add(index)
        status = "REMOVE from beta"
    print(f"  {name:17} {status}")

result = "".join(
    replacement_lines.get(i, line)
    for i, line in enumerate(source_lines)
    if i not in removed_indices
)
if result == destination_text:
    print("\nNo content change: LIVE beta sidebar.js already matches the selected policy.")
    sys.exit(0)

old_lines = destination_text.splitlines(keepends=True)
new_lines = result.splitlines(keepends=True)
diff = difflib.unified_diff(
    old_lines, new_lines,
    fromfile="LIVE beta/sidebar.js (current)",
    tofile="LIVE beta/sidebar.js (proposed)",
    n=3,
)
max_diff_lines = 120
print("\nPreview of destination changes (first 120 diff lines):")
for index, line in enumerate(diff):
    if index >= max_diff_lines:
        print("... diff truncated; use git diff after --apply for full details.")
        break
    print(line, end="" if line.endswith("\n") else "\n")

if not apply:
    print("\nDRY RUN COMPLETE: source and destination unchanged.")
    print("Run ./sidebar_sync_to_beta.sh --apply to write LIVE beta sidebar.js.")
    sys.exit(0)

# Write the fully checked output atomically in the same destination directory.
# Preserve the existing destination file's permissions.
fd, temporary = tempfile.mkstemp(
    prefix=".sidebar-sync-to-beta-", suffix=".tmp", dir=destination.parent
)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.write(result)
    os.chmod(temporary, stat.S_IMODE(destination.stat().st_mode))
    os.replace(temporary, destination)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)

if destination.read_text(encoding="utf-8") != result:
    sys.exit("ERROR: destination verification failed after write.")
print("\nAPPLY COMPLETE: updated LIVE beta sidebar.js only.")
print("Review with: git -C <LIVE-beta-uk-aq-path> diff -- sidebar.js")
print("No commit, push or deployment was performed.")
PY
