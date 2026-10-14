#!/usr/bin/env python3
"""Render the daily 13:00 TEST launchd template to stdout; never install or load it."""
import argparse
import plistlib
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--repo-root', type=Path, required=True)
p.add_argument('--runtime-root', type=Path, required=True)
p.add_argument('--python', type=Path, required=True)
a = p.parse_args()
if not all(x.is_absolute() for x in (a.repo_root, a.runtime_root, a.python)) or a.runtime_root.name != 'TEST':
    p.error('absolute paths and a TEST runtime root are required')
template = Path(__file__).resolve().parents[1] / 'launchd/co.uk.ukaq.gcp-billing.test.plist.template'
value = plistlib.loads(template.read_bytes())
replacements = {'__PYTHON__': str(a.python), '__REPO_ROOT__': str(a.repo_root),
                '__RUNTIME_ROOT__': str(a.runtime_root)}
def render(item):
    if isinstance(item, str):
        for key, value in replacements.items():
            item = item.replace(key, value)
    elif isinstance(item, list):
        item = [render(x) for x in item]
    elif isinstance(item, dict):
        item = {key: render(value) for key, value in item.items()}
    return item
print(plistlib.dumps(render(value)).decode(), end='')
