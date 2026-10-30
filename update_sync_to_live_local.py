#!/usr/bin/env python3
"""Safely patch the user's existing local TEST Ops sync_to_live.sh.

Only changes rsync checksum/timestamp handling and protects site-notice.toml.
It does not modify website code, navigation switches, or destination checkouts.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def main() -> None:
    if len(sys.argv) > 2:
        sys.exit('Usage: python3 update_sync_to_live_local.py [path/to/sync_to_live.sh]')

    src = Path(sys.argv[1] if len(sys.argv) == 2 else './sync_to_live.sh').expanduser().resolve()
    if src.name != 'sync_to_live.sh' or not src.is_file() or src.is_symlink():
        sys.exit(f'ERROR: expected a regular sync_to_live.sh file: {src}')
    if not (src.parent / 'AGENTS.md').is_file():
        sys.exit('ERROR: expected to run against the local TEST Ops repository containing AGENTS.md.')

    original = src.read_text(encoding='utf-8')
    if 'LIVE-beta-uk-aq' not in original or '--checksum' not in original:
        sys.exit('ERROR: this does not look like the expected TEST-to-LIVE-beta checksum sync script.')

    # Find the actual rsync argument array, not an unrelated documentation/example.
    array_open = list(re.finditer(r'(?m)^[ \t]*(?:local[ \t]+)?rsync_args=\([ \t]*$', original))
    if len(array_open) != 1:
        sys.exit(f'ERROR: expected one rsync_args=( array; found {len(array_open)}.')
    start = array_open[0].end()
    close = re.search(r'(?m)^[ \t]*\)[ \t]*$', original[start:])
    if not close:
        sys.exit('ERROR: could not locate the end of the rsync_args array.')
    end = start + close.start()
    args = original[start:end]
    checksums = list(re.finditer(r'(?m)^([ \t]*)--checksum[ \t]*$', args))
    if len(checksums) != 1:
        sys.exit(f'ERROR: expected one --checksum in rsync_args; found {len(checksums)}.')
    if re.search(r'(?m)^[ \t]*--no-times[ \t]*$', args):
        timestamp_change = False
    else:
        m = checksums[0]
        args = args[:m.end()] + '\n' + m.group(1) + '--no-times' + args[m.end():]
        timestamp_change = True
    updated = original[:start] + args + original[end:]

    # Add this exclude in the website-specific promotion block, not other repo types.
    sync_anchor = updated.find('sync_repo()')
    if sync_anchor < 0:
        sys.exit('ERROR: expected sync_repo() function not found.')
    from_sync = updated[sync_anchor:]
    website_blocks = list(re.finditer(r'(?m)^[ \t]*website\)[ \t]*$', from_sync))
    if len(website_blocks) != 1:
        sys.exit(f'ERROR: expected one website) case in sync_repo; found {len(website_blocks)}.')
    website_start = sync_anchor + website_blocks[0].end()
    case_end = re.search(r'(?m)^[ \t]*;;[ \t]*$', updated[website_start:])
    if not case_end:
        sys.exit('ERROR: could not locate end of website) case.')
    website_end = website_start + case_end.start()
    website = updated[website_start:website_end]
    exclude = "--exclude='/site-notice.toml'"
    if exclude in updated:
        exclusion_change = False
    else:
        opener = list(re.finditer(r'(?m)^([ \t]*)rsync_args\+=\([ \t]*$', website))
        if len(opener) != 1:
            sys.exit(f'ERROR: expected one website rsync_args+=( array; found {len(opener)}.')
        m = opener[0]
        website = website[:m.end()] + '\n' + m.group(1) + '  ' + exclude + website[m.end():]
        updated = updated[:website_start] + website + updated[website_end:]
        exclusion_change = True

    if not timestamp_change and not exclusion_change:
        print('No changes needed: --checksum, --no-times and site-notice exclusion already configured.')
        return

    # Only fast structural verification; do not run the promotion script.
    checked = subprocess.run(['bash', '-n'], input=updated, text=True, capture_output=True)
    if checked.returncode != 0:
        sys.exit(f'ERROR: patched shell failed syntax validation:\n{checked.stderr}')

    archive = src.parent / 'archive' / '2026-10-30' / 'sync_to_live.sh'
    if archive.exists():
        if archive.read_bytes() != src.read_bytes():
            sys.exit(f'ERROR: today\'s archive already exists and differs: {archive}. No changes made.')
    else:
        archive.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, archive)
        print(f'Preserved original TEST Ops script: {archive}')

    fd, tmp_name = tempfile.mkstemp(prefix='.sync_to_live_update_', dir=src.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as fout:
            fout.write(updated)
        os.chmod(tmp_name, src.stat().st_mode & 0o777)
        os.replace(tmp_name, src)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)

    print(f'Updated TEST Ops local script: {src}')
    print('  --checksum: kept (compare file contents)')
    print('  --no-times: ' + ('added' if timestamp_change else 'already present'))
    print("  --exclude='/site-notice.toml': " + ('added' if exclusion_change else 'already present'))
    print('  Sidebar.js promotion logic and all other exclusions remain unchanged.')
    print('  bash -n: passed. No sync was run; no LIVE beta files were changed.')
    print('Next: ./sync_to_live.sh website  (dry run)')


if __name__ == '__main__':
    main()
