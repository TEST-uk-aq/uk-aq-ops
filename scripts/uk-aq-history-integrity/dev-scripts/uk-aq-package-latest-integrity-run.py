#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path("/Users/mikehinford/uk-aq-history-integrity")
DROPBOX_APPS_ROOT = Path(
    "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks"
)

ALLOWED_ENVIRONMENTS = ("CIC-Test", "LIVE")
DIAGNOSTIC_SUFFIXES = {".log", ".txt", ".json", ".jsonl", ".csv", ".md"}
SENSITIVE_NAME_PARTS = (
    "secret",
    "credential",
    "credentials",
    "access_key",
    "private_key",
    "private-key",
    "token",
)
DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
DEFAULT_EXTRA_LOG_COUNT = 30
DEFAULT_REPORT_COUNT = 10


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Package the latest UK AQ Integrity diagnostic files into a ZIP "
            "in the environment's Dropbox root."
        )
    )
    parser.add_argument(
        "--env",
        required=True,
        choices=ALLOWED_ENVIRONMENTS,
        help="Integrity environment to package.",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=1,
        help=(
            "Number of newest tmp run directories to include. "
            "Default: 1. Use 2 if a later batch has already started."
        ),
    )
    parser.add_argument(
        "--max-file-mb",
        type=int,
        default=50,
        help="Maximum size of any single included file. Default: 50 MB.",
    )
    return parser.parse_args()


def is_diagnostic_file(path: Path, max_file_bytes: int) -> tuple[bool, str | None]:
    if not path.is_file() or path.is_symlink():
        return False, "not_regular_file"

    lower_name = path.name.lower()
    if lower_name == ".env" or lower_name.endswith(".env"):
        return False, "environment_file_excluded"
    if any(part in lower_name for part in SENSITIVE_NAME_PARTS):
        return False, "sensitive_filename_excluded"

    if path.suffix.lower() not in DIAGNOSTIC_SUFFIXES and lower_name not in {
        "stdout",
        "stderr",
    }:
        return False, "non_diagnostic_extension"

    try:
        size = path.stat().st_size
    except OSError:
        return False, "stat_failed"

    if size > max_file_bytes:
        return False, f"larger_than_{max_file_bytes}_bytes"

    return True, None


def newest_paths(paths: Iterable[Path], limit: int) -> list[Path]:
    existing = []
    for path in paths:
        try:
            if path.exists():
                existing.append(path)
        except OSError:
            continue
    return sorted(
        existing,
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:limit]


def find_tmp_run_roots(tmp_root: Path, count: int) -> list[Path]:
    if not tmp_root.is_dir():
        raise FileNotFoundError(f"Integrity tmp directory does not exist: {tmp_root}")

    child_directories = [
        path
        for path in tmp_root.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ]
    if child_directories:
        return newest_paths(child_directories, count)

    # Some run layouts place diagnostics directly in tmp.
    return [tmp_root]


def run_command(args: list[str]) -> str:
    try:
        completed = subprocess.run(
            args,
            cwd=PROJECT_ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
        )
    except Exception as error:
        return f"Command failed to run: {error}\n"
    return completed.stdout or ""


def main() -> int:
    args = parse_args()

    if args.runs < 1 or args.runs > 10:
        raise SystemExit("--runs must be between 1 and 10")
    if args.max_file_mb < 1 or args.max_file_mb > 500:
        raise SystemExit("--max-file-mb must be between 1 and 500")

    environment = args.env
    state_root = PROJECT_ROOT / "state" / environment
    tmp_root = state_root / "tmp"
    dropbox_root = (
        DROPBOX_APPS_ROOT / environment / "uk-aq-history-integrity"
    )
    logs_root = dropbox_root / "logs"
    reports_root = dropbox_root / "reports"

    if not state_root.is_dir():
        raise SystemExit(f"Integrity state directory does not exist: {state_root}")

    dropbox_root.mkdir(parents=True, exist_ok=True)

    run_roots = find_tmp_run_roots(tmp_root, args.runs)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_environment = environment.replace("-", "_").lower()
    zip_path = (
        dropbox_root
        / f"uk-aq-integrity-diagnostics-{safe_environment}-{timestamp}.zip"
    )

    max_file_bytes = args.max_file_mb * 1024 * 1024
    included: list[dict[str, object]] = []
    skipped: list[dict[str, str]] = []
    copied_sources: set[Path] = set()

    with tempfile.TemporaryDirectory(
        prefix="uk-aq-integrity-diagnostics-"
    ) as temporary_directory:
        staging_root = Path(temporary_directory) / "bundle"
        archive_state_root = staging_root / "state" / environment
        archive_state_root.mkdir(parents=True, exist_ok=True)

        def copy_diagnostic(source: Path) -> None:
            try:
                resolved_source = source.resolve()
            except OSError:
                skipped.append({"path": str(source), "reason": "resolve_failed"})
                return

            if resolved_source in copied_sources:
                return

            allowed, reason = is_diagnostic_file(source, max_file_bytes)
            if not allowed:
                skipped.append({"path": str(source), "reason": reason or "excluded"})
                return

            try:
                relative = source.relative_to(state_root)
                destination = archive_state_root / relative
            except ValueError:
                try:
                    relative = source.relative_to(dropbox_root)
                    destination = (
                        staging_root
                        / "dropbox"
                        / environment
                        / "uk-aq-history-integrity"
                        / relative
                    )
                except ValueError:
                    try:
                        relative = source.relative_to(PROJECT_ROOT)
                        destination = staging_root / "project" / relative
                    except ValueError:
                        destination = staging_root / "external" / source.name

            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            copied_sources.add(resolved_source)

            stat = source.stat()
            included.append(
                {
                    "source": str(source),
                    "archive_path": str(destination.relative_to(staging_root)),
                    "bytes": stat.st_size,
                    "modified_at_utc": dt.datetime.fromtimestamp(
                        stat.st_mtime, tz=dt.timezone.utc
                    ).isoformat(),
                }
            )

        # Copy all useful diagnostic files from the selected tmp run root(s).
        for run_root in run_roots:
            for candidate in run_root.rglob("*"):
                copy_diagnostic(candidate)

        # Include recent wrapper and Integrity logs, including monthly batch logs.
        if logs_root.is_dir():
            recent_logs = newest_paths(
                (
                    path
                    for path in logs_root.rglob("*")
                    if path.is_file()
                    and (
                        path.suffix.lower() in DIAGNOSTIC_SUFFIXES
                        or path.name.lower() in {"stdout", "stderr"}
                    )
                ),
                DEFAULT_EXTRA_LOG_COUNT,
            )
            for candidate in recent_logs:
                copy_diagnostic(candidate)

        # Include recent reports if the project keeps them outside tmp.
        if reports_root.is_dir():
            recent_reports = newest_paths(
                (
                    path
                    for path in reports_root.rglob("*")
                    if path.is_file()
                    and path.suffix.lower() in DIAGNOSTIC_SUFFIXES
                ),
                DEFAULT_REPORT_COUNT,
            )
            for candidate in recent_reports:
                copy_diagnostic(candidate)

        # Include launch scripts that help explain which flags/environment ran.
        launcher_candidates = [
            PROJECT_ROOT / "bin" / "uk-aq-history-integrity.sh",
            *sorted((PROJECT_ROOT / "bin").glob("*monthly*.sh")),
        ]
        for candidate in launcher_candidates:
            if candidate.is_file():
                destination = staging_root / "project" / "bin" / candidate.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(candidate, destination)
                stat = candidate.stat()
                included.append(
                    {
                        "source": str(candidate),
                        "archive_path": str(destination.relative_to(staging_root)),
                        "bytes": stat.st_size,
                        "modified_at_utc": dt.datetime.fromtimestamp(
                            stat.st_mtime, tz=dt.timezone.utc
                        ).isoformat(),
                    }
                )

        git_state_path = staging_root / "project" / "git-state.txt"
        git_state_path.parent.mkdir(parents=True, exist_ok=True)
        git_state_path.write_text(
            "git rev-parse HEAD\n"
            "------------------\n"
            f"{run_command(['git', 'rev-parse', 'HEAD'])}\n"
            "git status --short\n"
            "------------------\n"
            f"{run_command(['git', 'status', '--short'])}\n",
            encoding="utf-8",
        )

        manifest = {
            "schema_version": 1,
            "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "environment": environment,
            "project_root": str(PROJECT_ROOT),
            "state_root": str(state_root),
            "dropbox_root": str(dropbox_root),
            "dropbox_logs_root": str(logs_root),
            "dropbox_reports_root": str(reports_root),
            "selected_tmp_run_roots": [str(path) for path in run_roots],
            "included_file_count": len(included),
            "included_files": included,
            "skipped_files": skipped,
            "notes": [
                "Only diagnostic text/JSON/CSV/Markdown files were considered.",
                "Parquet files, SQLite databases, env files, and obvious credential/token files were excluded.",
                "Recent Dropbox logs and reports were added in addition to the selected local tmp run root.",
            ],
        }
        (staging_root / "bundle-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )

        (staging_root / "README.txt").write_text(
            "UK AQ Integrity diagnostic bundle\n"
            "=================================\n\n"
            f"Environment: {environment}\n"
            f"Created UTC: {manifest['created_at_utc']}\n"
            f"Selected tmp run roots: {', '.join(manifest['selected_tmp_run_roots'])}\n\n"
            "This bundle contains diagnostic files only. It deliberately excludes "
            "Parquet data, SQLite databases, env files, and files with obvious "
            "credential or token names.\n",
            encoding="utf-8",
        )

        with zipfile.ZipFile(
            zip_path,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as archive:
            for candidate in sorted(staging_root.rglob("*")):
                if candidate.is_file():
                    archive.write(
                        candidate,
                        arcname=candidate.relative_to(staging_root),
                    )

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"Created: {zip_path}")
    print(f"Included diagnostic files: {len(included)}")
    print(f"ZIP size: {size_mb:.2f} MB")
    print("Wait for Dropbox to finish syncing, then create a public link to this ZIP.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        raise SystemExit(130)
