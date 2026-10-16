#!/usr/bin/env python3
"""Render a TEST/LIVE daily 13:00 launchd job; never install or load it."""
import argparse
import plistlib
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--repo-root', type=Path, required=True)
p.add_argument('--runtime-root', type=Path, required=True)
p.add_argument('--python', type=Path, required=True)
p.add_argument('--environment', choices=['TEST', 'LIVE'], default='TEST')
config = p.add_mutually_exclusive_group()
config.add_argument('--config', type=Path, help='Existing TEST config.json')
config.add_argument('--env-file', type=Path,
                    help='Repo-root .env.gcp_billing (or legacy private runtime .env)')
a = p.parse_args()
if not all(x.is_absolute() for x in (a.repo_root, a.runtime_root, a.python)):
    p.error('absolute repo, runtime and Python paths are required')
if a.runtime_root.name != a.environment:
    p.error('runtime directory must end in the selected environment')
if a.environment == 'LIVE' and not a.env_file:
    p.error('LIVE launchd requires an explicit --env-file (never a TEST config.json)')
config_path = a.env_file or a.config or a.runtime_root / 'config.json'
repo_root = a.repo_root.resolve()
if not config_path.is_absolute():
    p.error('configuration must be an absolute path')
if a.env_file and config_path.name == '.env.gcp_billing':
    if config_path.resolve() != repo_root / '.env.gcp_billing' or config_path.is_symlink():
        p.error('repository .env.gcp_billing must be in --repo-root, not a symlink')
elif not config_path.resolve().is_relative_to(a.runtime_root):
    p.error('private config.json or .env must be inside --runtime-root')
template = Path(__file__).resolve().parents[1] / 'launchd/co.uk.ukaq.gcp-billing.plist.template'
value = plistlib.loads(template.read_bytes())
replacements = {
    '__PYTHON__': str(a.python),
    '__REPO_ROOT__': str(a.repo_root),
    '__RUNTIME_ROOT__': str(a.runtime_root),
    '__ENVIRONMENT__': a.environment,
    '__ENV_LOWER__': a.environment.lower(),
    '__CONFIG_OPTION__': '--env-file' if a.env_file else '--config',
    '__CONFIG_PATH__': str(config_path),
}


def render(item):
    if isinstance(item, str):
        for key, replacement in replacements.items():
            item = item.replace(key, replacement)
    elif isinstance(item, list):
        item = [render(x) for x in item]
    elif isinstance(item, dict):
        item = {key: render(value) for key, value in item.items()}
    return item


print(plistlib.dumps(render(value)).decode(), end='')
