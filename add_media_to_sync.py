#!/usr/bin/env python3
"""Add TEST Media -> LIVE Media as a guarded local sync_to_live.sh option.

Run from the TEST-uk-aq-ops directory. Does not run rsync or modify LIVE.
The original TEST-only script is archived once per day before replacement.
"""

from datetime import date
from pathlib import Path
import os
import shutil
import stat
import subprocess
import sys
import tempfile

script = Path.cwd() / "sync_to_live.sh"
if not script.is_file():
    sys.exit("ERROR: Run this from the TEST-uk-aq-ops directory containing sync_to_live.sh")

original = script.read_text(encoding="utf-8")

# Existing safety contract: this updater only supports the known guarded local
# script, and refuses unexpected layouts instead of modifying them by guesswork.
for invariant in (
    "set -euo pipefail",
    "--delete-delay",
    "--exclude='archive/'",
    "--exclude='AGENTS.md'",
    "--exclude='.git/'",
    "if [[ \"${APPLY}\" -eq 0 ]]; then",
):
    if invariant not in original:
        sys.exit(f"ERROR: Existing sync safety rule missing: {invariant!r}; no changes made")

if "    media)            printf '%s\\n' \"${TEST_BASE}/TEST-uk-aq-media\" ;;" in original:
    sys.exit("Media is already configured; no changes made")

changes = [
    (
        "    ops)               printf '%s\\n' \"${TEST_BASE}/TEST-uk-aq-ops\" ;;",
        "    ops)               printf '%s\\n' \"${TEST_BASE}/TEST-uk-aq-ops\" ;;\n"
        "    media)             printf '%s\\n' \"${TEST_BASE}/TEST-uk-aq-media\" ;;",
    ),
    (
        "    ops)               printf '%s\\n' \"${LIVE_BASE}/LIVE-uk-aq-ops\" ;;",
        "    ops)               printf '%s\\n' \"${LIVE_BASE}/LIVE-uk-aq-ops\" ;;\n"
        "    media)             printf '%s\\n' \"${LIVE_BASE}/LIVE-uk-aq-media\" ;;",
    ),
    (
        "ALL_REPOS=(ingest ops schema website pop-ingest integrity-factory)",
        "ALL_REPOS=(ingest ops schema website pop-ingest integrity-factory media)",
    ),
    (
        "Repos:\n  ingest\n  ops\n  schema",
        "Repos:\n  ingest\n  ops\n  media\n  schema",
    ),
    (
        "--all                 Sync all six repos.",
        "--all                 Sync all seven repos.",
    ),
    (
        "If no repo is supplied, all six repos are selected.",
        "If no repo is supplied, all seven repos are selected.",
    ),
    (
        "    ingest|ops|schema|website|pop-ingest|integrity-factory)",
        "    ingest|ops|media|schema|website|pop-ingest|integrity-factory)",
    ),
    (
        '  if rsync "${rsync_args[@]}" "${src}/" "${dst}/"; then\n'
        '    if ! clean_live_docs "${label}" "${dst}"; then\n'
        '      echo "   ERROR [${label}]: LIVE documentation cleanup failed" >&2\n'
        '      mark_failure "${label}"\n'
        '      return\n'
        '    fi',
        '  if rsync "${rsync_args[@]}" "${src}/" "${dst}/"; then\n'
        '    # Media LIVE retains its operational docs; excluding docs from rsync\n'
        '    # must not result in a separate destructive docs cleanup.\n'
        '    if [[ "${label}" != "media" ]]; then\n'
        '      if ! clean_live_docs "${label}" "${dst}"; then\n'
        '        echo "   ERROR [${label}]: LIVE documentation cleanup failed" >&2\n'
        '        mark_failure "${label}"\n'
        '        return\n'
        '      fi\n'
        '    fi',
    ),
    (
        "    pop-ingest|integrity-factory)\n      # No extra repo-specific exclusions at present.\n      ;;",
        "    media)\n"
        "      rsync_args+=(\n"
        "        # The current Media checkouts contain different account-specific\n"
        "        # Wrangler settings (notably D1 IDs). Keep those files LOCAL to\n"
        "        # each environment until a generic deployment-time config is used.\n"
        "        --exclude='wrangler.jsonc'\n"
        "        --exclude='wrangler.toml'\n"
        "        --exclude='wrangler.deploy.toml'\n"
        "\n"
        "        # Wrangler's machine-local state and local development credentials.\n"
        "        --exclude='.wrangler/'\n"
        "        --exclude='.dev.vars*'\n"
        "      )\n"
        "      ;;\n"
        "    pop-ingest|integrity-factory)\n"
        "      # No extra repo-specific exclusions at present.\n"
        "      ;;",
    ),
]

updated = original
for before, after in changes:
    count = updated.count(before)
    if count != 1:
        sys.exit(f"ERROR: Expected one matching section, found {count}: {before[:90]!r}; no changes made")
    updated = updated.replace(before, after, 1)

# Parse the proposed replacement without executing it or touching LIVE.
temporary = None
try:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix=".sync_to_live_media_",
        suffix=".sh", dir=script.parent, delete=False
    ) as handle:
        temporary = Path(handle.name)
        handle.write(updated)
    result = subprocess.run(["bash", "-n", str(temporary)], capture_output=True, text=True)
    if result.returncode:
        sys.exit("ERROR: Updated script failed bash syntax check; nothing replaced:\n" + result.stderr)

    # TEST archives are reference only, never transferred to LIVE by rsync.
    archive = script.parent / "archive" / date.today().isoformat() / "sync_to_live.sh"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        shutil.copy2(script, archive)
    else:
        print(f"Existing daily TEST archive preserved: {archive}")

    os.chmod(temporary, stat.S_IMODE(script.stat().st_mode))
    os.replace(temporary, script)
    temporary = None
finally:
    if temporary is not None:
        temporary.unlink(missing_ok=True)

print("Media added to sync_to_live.sh; bash syntax check passed.")
print("No LIVE files were modified and rsync was NOT executed.")
print("Next: ./sync_to_live.sh --help")
print("Then: ./sync_to_live.sh media  (dry-run only)")
print("Review the dry-run before choosing any --apply operation.")
