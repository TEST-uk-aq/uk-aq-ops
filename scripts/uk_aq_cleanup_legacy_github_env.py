#!/usr/bin/env python3
"""
List/delete legacy GitHub vars/secrets that were renamed during OBS_AQIDB hard-cut.

Default mode is dry-run (list only). Use --apply to actually delete.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from pathlib import Path


DEFAULT_TARGETS_FILE = "config/uk_aq_github_env_targets.csv"

# Legacy keys that were hard-cut to OBS_AQIDB naming.
LEGACY_RENAMED_KEYS = {
    "HISTORY_SUPABASE_URL",
    "HISTORY_SUPABASE_DB_URL",
    "HISTORY_SUPABASE_PROJECT_REF",
    "HISTORY_PUBLISHABLE_DEFAULT_KEY",
    "HISTORY_SECRET_KEY",
    "HISTORY_SECRET_KEY_SECRET_NAME",
    "HISTORY_RPC_SCHEMA",
    "HISTORY_READ_SCHEMA",
    "HISTORY_SCHEMA",
    "UK_AQ_HISTORY_DB_LABEL",
}


def should_use_login_auth() -> bool:
    """Prefer `gh auth login` credentials over GH_TOKEN/GITHUB_TOKEN if available."""
    env = os.environ.copy()
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    probe = subprocess.run(
        ["gh", "auth", "status"],
        check=False,
        text=True,
        capture_output=True,
        env=env,
    )
    return probe.returncode == 0


def gh_env(use_login_auth: bool) -> dict[str, str]:
    env = os.environ.copy()
    if use_login_auth:
        env.pop("GH_TOKEN", None)
        env.pop("GITHUB_TOKEN", None)
    return env


def run_capture(cmd: list[str], *, use_login_auth: bool) -> str:
    proc = subprocess.run(
        cmd,
        check=True,
        text=True,
        capture_output=True,
        env=gh_env(use_login_auth),
    )
    return proc.stdout


def detect_repo(explicit_repo: str | None, *, use_login_auth: bool) -> str:
    if explicit_repo:
        return explicit_repo
    return run_capture(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        use_login_auth=use_login_auth,
    ).strip()


def load_target_keys(targets_file: Path) -> set[str]:
    if not targets_file.exists():
        raise FileNotFoundError(f"Targets file not found: {targets_file}")
    keys: set[str] = set()
    with targets_file.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return keys
        for row in reader:
            key = (row.get("key") or "").strip()
            target = (row.get("target") or "").strip().lower()
            if not key or target in {"", "local"}:
                continue
            keys.add(key)
    return keys


def fetch_names(repo: str, kind: str, *, use_login_auth: bool) -> set[str]:
    if kind not in {"variable", "secret"}:
        raise ValueError(f"Unsupported kind: {kind}")
    cmd = ["gh", kind, "list", "--repo", repo, "--json", "name"]
    try:
        output = run_capture(cmd, use_login_auth=use_login_auth)
        rows = json.loads(output)
        return {str(row.get("name") or "").strip() for row in rows if row.get("name")}
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").lower()
        # Fallback for older gh versions that may not support --json on `variable list`.
        if "unknown flag" in stderr and "--json" in stderr:
            plain = run_capture(
                ["gh", kind, "list", "--repo", repo],
                use_login_auth=use_login_auth,
            )
            names: set[str] = set()
            for line in plain.splitlines():
                token = line.strip().split()[0] if line.strip() else ""
                if token:
                    names.add(token)
            return names
        raise


def delete_key(repo: str, kind: str, key: str, *, use_login_auth: bool) -> None:
    subprocess.run(
        ["gh", kind, "delete", key, "--repo", repo],
        check=True,
        env=gh_env(use_login_auth),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List/delete legacy GitHub vars/secrets renamed to OBS_AQIDB keys.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="GitHub repo in owner/name format (default: infer from current checkout).",
    )
    parser.add_argument(
        "--targets-file",
        default=DEFAULT_TARGETS_FILE,
        help=f"Targets CSV path (default: {DEFAULT_TARGETS_FILE}).",
    )
    parser.add_argument(
        "--include-aggdaily-label",
        action="store_true",
        help="Also include UK_AQ_AGGDAILY_DB_LABEL as a deletion candidate.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete candidates (default: dry-run list only).",
    )
    args = parser.parse_args()

    use_login_auth = should_use_login_auth()
    repo = detect_repo(args.repo, use_login_auth=use_login_auth)
    targets_file = Path(args.targets_file)

    legacy_keys = set(LEGACY_RENAMED_KEYS)
    if args.include_aggdaily_label:
        legacy_keys.add("UK_AQ_AGGDAILY_DB_LABEL")

    target_keys = load_target_keys(targets_file)
    repo_vars = fetch_names(repo, "variable", use_login_auth=use_login_auth)
    repo_secrets = fetch_names(repo, "secret", use_login_auth=use_login_auth)

    delete_vars = sorted((repo_vars - target_keys) & legacy_keys)
    delete_secrets = sorted((repo_secrets - target_keys) & legacy_keys)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] repo={repo}")
    print(f"targets_file={targets_file}")
    print(f"auth_mode={'gh-auth' if use_login_auth else 'env-token'}")
    print(f"delete_candidate_variables={len(delete_vars)}")
    for key in delete_vars:
        print(f"  VAR {key}")
    print(f"delete_candidate_secrets={len(delete_secrets)}")
    for key in delete_secrets:
        print(f"  SECRET {key}")

    if not args.apply:
        return 0

    for key in delete_vars:
        delete_key(repo, "variable", key, use_login_auth=use_login_auth)
        print(f"deleted VAR {key}")
    for key in delete_secrets:
        delete_key(repo, "secret", key, use_login_auth=use_login_auth)
        print(f"deleted SECRET {key}")

    print("cleanup complete")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"command failed: {' '.join(exc.cmd)}", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr.strip(), file=sys.stderr)
        return_code = exc.returncode if isinstance(exc.returncode, int) else 1
        raise SystemExit(return_code)
