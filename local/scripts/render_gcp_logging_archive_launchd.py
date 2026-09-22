#!/usr/bin/env python3
"""Render the TEST logging-archive launchd plist with XML-safe paths."""

from __future__ import annotations

import argparse
from pathlib import Path
import plistlib


def substitute(value: object, repo_root: str) -> object:
    if isinstance(value, str):
        return value.replace("__REPO_ROOT__", repo_root)
    if isinstance(value, list):
        return [substitute(item, repo_root) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, repo_root) for key, item in value.items()}
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    repo_root = str(args.repo_root.expanduser().resolve())
    with args.template.open("rb") as stream:
        rendered = substitute(plistlib.load(stream), repo_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as stream:
        plistlib.dump(rendered, stream, fmt=plistlib.FMT_XML, sort_keys=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
