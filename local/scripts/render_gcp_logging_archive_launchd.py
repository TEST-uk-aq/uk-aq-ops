#!/usr/bin/env python3
"""Render one environment-specific launchd job from the shared template."""

from __future__ import annotations

import argparse
from pathlib import Path
import plistlib


def substitute(value: object, replacements: dict[str, str]) -> object:
    if isinstance(value, str):
        for marker, replacement in replacements.items():
            value = value.replace(marker, replacement)
        return value
    if isinstance(value, list):
        return [substitute(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, replacements) for key, item in value.items()}
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--environment", choices=("TEST", "LIVE"), required=True)
    parser.add_argument("--ingest-env-file", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True,
                        help="parent containing the TEST and LIVE runtime directories")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    replacements = {
        "__REPO_ROOT__": str(args.repo_root.expanduser().resolve()),
        "__INGEST_ENV_FILE__": str(args.ingest_env_file.expanduser().resolve()),
        "__RUNTIME_ROOT__": str(args.runtime_root.expanduser().resolve()),
        "__ENV_LOWER__": args.environment.lower(),
        "__ENV__": args.environment,
    }
    with args.template.open("rb") as stream:
        rendered = substitute(plistlib.load(stream), replacements)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as stream:
        plistlib.dump(rendered, stream, fmt=plistlib.FMT_XML, sort_keys=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
