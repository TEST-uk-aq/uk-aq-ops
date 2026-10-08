#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import plistlib
import re
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

ALLOWED_ENVIRONMENTS = ("TEST", "LIVE")
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
DEFAULT_LAUNCHD_JOB_COUNT = 8
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


def resolve_ops_repo_root(environment: str) -> tuple[Path | None, str | None]:
    selector_path = PROJECT_ROOT / "env" / f"{environment}.env"
    try:
        selector_text = selector_path.read_text(encoding="utf-8")
    except OSError as error:
        return None, f"Unable to read repository selector {selector_path}: {error}"

    values: list[str] = []
    for raw_line in selector_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            return None, f"Invalid repository selector line in {selector_path}: {raw_line!r}"
        key, raw_value = line.split("=", 1)
        if key.strip() != "UK_AQ_OPS_REPO_ROOT":
            return None, (
                f"Repository selector {selector_path} contains unsupported key "
                f"{key.strip()!r}"
            )

        value = raw_value.strip()
        if " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"}:
            value = value[1:-1]
        if not value:
            return None, f"UK_AQ_OPS_REPO_ROOT is empty in {selector_path}"
        values.append(value)

    if len(values) != 1:
        return None, (
            f"Repository selector {selector_path} must contain exactly one "
            "UK_AQ_OPS_REPO_ROOT assignment"
        )

    repo_root = Path(values[0])
    if not repo_root.is_absolute():
        return None, f"UK_AQ_OPS_REPO_ROOT must be absolute: {repo_root}"
    try:
        repo_root = repo_root.resolve(strict=True)
    except OSError as error:
        return None, f"Unable to resolve selected repository {repo_root}: {error}"
    if not repo_root.is_dir():
        return None, f"Selected repository is not a directory: {repo_root}"
    return repo_root, None


def run_command(args: list[str], *, cwd: Path) -> str:
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
        )
    except Exception as error:
        return f"Command failed to run: {error}\n"
    return completed.stdout or ""


def launchd_job_status(label: str) -> dict[str, object]:
    """Collect bounded, non-sensitive launchctl state for a local job."""
    target = f"gui/{os.getuid()}/{label}"
    result: dict[str, object] = {"target": target}
    if sys.platform != "darwin":
        result["availability"] = "requires_macos"
        return result
    try:
        completed = subprocess.run(
            ["/bin/launchctl", "print", target],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        result["availability"] = f"query_failed: {type(error).__name__}"
        return result

    if completed.returncode != 0:
        result["availability"] = "not_registered_or_unavailable"
        return result

    result["availability"] = "registered"
    # Do not package raw launchctl output: it can contain environment values
    # and full command-line arguments. Capture only useful scalar job status.
    permitted = {
        "state": "state",
        "active count": "active_count",
        "runs": "runs",
        "last exit code": "last_exit_code",
        "pid": "pid",
    }
    for line in completed.stdout.splitlines():
        match = re.fullmatch(
            r"\s*(state|active count|runs|last exit code|pid)\s*=\s*(.*?)\s*",
            line,
        )
        if match:
            key = permitted[match.group(1)]
            value = match.group(2)
            if key in {"active_count", "runs", "last_exit_code", "pid"}:
                if value.isdecimal():
                    result[key] = int(value)
            else:
                result[key] = value
    return result


def launchd_run_matches(log_path: Path, run_names: set[str]) -> list[str]:
    """Associate a launchd stdout log with selected Integrity run IDs."""
    if not run_names or not log_path.is_file() or log_path.is_symlink():
        return []
    try:
        with log_path.open("rb") as handle:
            header = handle.read(512 * 1024)
    except OSError:
        return []
    return sorted(name for name in run_names if name.encode("utf-8") in header)


def main() -> int:
    args = parse_args()

    if args.runs < 1 or args.runs > 10:
        raise SystemExit("--runs must be between 1 and 10")
    if args.max_file_mb < 1 or args.max_file_mb > 500:
        raise SystemExit("--max-file-mb must be between 1 and 500")

    environment = args.env
    ops_repo_root, ops_repo_root_error = resolve_ops_repo_root(environment)
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

        # launchd writes the wrapper's combined stdout/stderr outside Dropbox.
        # Include recent local logs, including descriptive --log-file names.
        local_logs_root = state_root / "logs"
        if local_logs_root.is_dir():
            recent_local_logs = newest_paths(
                (
                    path
                    for path in local_logs_root.rglob("*")
                    if path.is_file()
                    and (path.suffix.lower() in DIAGNOSTIC_SUFFIXES
                         or path.name.lower() in {"stdout", "stderr"})
                ),
                DEFAULT_EXTRA_LOG_COUNT,
            )
            for candidate in recent_local_logs:
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

        # Capture launchd job status without copying raw .plist or launchctl
        # output. Both can contain command-line arguments or secrets.
        # Recent jobs are included even when they failed before creating tmp.
        launchd_jobs: list[dict[str, object]] = []
        launchd_root = state_root / "launchd"
        selected_run_names = {
            run_root.name for run_root in run_roots
            if run_root.name.startswith("run-")
        }
        if launchd_root.is_dir():
            recent_plists = newest_paths(
                (
                    path for path in launchd_root.glob("co.uk.ukaq.integrity.*.plist")
                    if path.is_file() and not path.is_symlink()
                ),
                DEFAULT_LAUNCHD_JOB_COUNT,
            )
            for plist_path in recent_plists:
                try:
                    if plist_path.stat().st_size > 1024 * 1024:
                        raise ValueError("plist exceeds 1 MiB")
                    with plist_path.open("rb") as handle:
                        job = plistlib.load(handle)
                    if not isinstance(job, dict):
                        raise ValueError("plist is not a dictionary")
                    label = job.get("Label")
                    if (
                        not isinstance(label, str)
                        or label != plist_path.stem
                        or not label.startswith(
                            f"co.uk.ukaq.integrity.{environment.lower()}."
                        )
                    ):
                        raise ValueError("unexpected launchd job label")
                except (OSError, ValueError, TypeError) as error:
                    skipped.append({
                        "path": str(plist_path),
                        "reason": f"invalid_launchd_job: {error}",
                    })
                    continue

                program_arguments = job.get("ProgramArguments")
                log_path: Path | None = None
                if (
                    isinstance(program_arguments, list)
                    and len(program_arguments) >= 8
                    and program_arguments[5] == "uk-aq-integrity-launchd"
                    and isinstance(program_arguments[6], str)
                ):
                    candidate = Path(program_arguments[6])
                    if candidate.is_absolute():
                        log_path = candidate
                        # Also handles --log-file paths outside state/logs.
                        copy_diagnostic(log_path)

                environment_variables = job.get("EnvironmentVariables")
                if not isinstance(environment_variables, dict):
                    environment_variables = {}
                launchd_jobs.append({
                    "label": label,
                    "definition_path": str(plist_path),
                    "log_path": str(log_path) if log_path else None,
                    "matching_selected_runs": (
                        launchd_run_matches(log_path, selected_run_names)
                        if log_path is not None else []
                    ),
                    "working_directory": job.get("WorkingDirectory"),
                    "run_at_load": job.get("RunAtLoad"),
                    "keep_alive": job.get("KeepAlive"),
                    "configured_path": environment_variables.get("PATH"),
                    "status": launchd_job_status(label),
                })

        launchd_status_path = archive_state_root / "launchd" / "job-status.json"
        launchd_status_path.parent.mkdir(parents=True, exist_ok=True)
        launchd_status_path.write_text(
            json.dumps({
                "captured_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                "environment": environment,
                "selected_run_names": sorted(selected_run_names),
                "note": (
                    "Raw plist and launchctl print output are excluded because "
                    "they may expose command-line arguments or environment values."
                ),
                "jobs": launchd_jobs,
            }, indent=2) + "\n",
            encoding="utf-8",
        )

        # Include launch scripts that help explain which flags/environment ran.
        launcher_candidates = [
            PROJECT_ROOT / "bin" / "uk-aq-history-integrity-sos-light-v2.sh",
            PROJECT_ROOT / "bin" / "uk-aq-history-integrity-sos-light-local-wrapper-v3.sh",
            PROJECT_ROOT / "bin" / "uk-aq-history-integrity-sos-light-v3.sh",
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
        if ops_repo_root is None:
            git_state_text = (
                "Selected ops repository\n"
                "-----------------------\n"
                f"{ops_repo_root_error or 'Unavailable'}\n"
            )
        else:
            git_state_text = (
                "Selected ops repository\n"
                "-----------------------\n"
                f"{ops_repo_root}\n\n"
                "git rev-parse HEAD\n"
                "------------------\n"
                f"{run_command(['git', 'rev-parse', 'HEAD'], cwd=ops_repo_root)}\n"
                "git branch --show-current\n"
                "-------------------------\n"
                f"{run_command(['git', 'branch', '--show-current'], cwd=ops_repo_root)}\n"
                "git status --short\n"
                "------------------\n"
                f"{run_command(['git', 'status', '--short'], cwd=ops_repo_root)}\n"
            )
        git_state_path.write_text(git_state_text, encoding="utf-8")

        manifest = {
            "schema_version": 1,
            "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "environment": environment,
            "project_root": str(PROJECT_ROOT),
            "ops_repo_root": str(ops_repo_root) if ops_repo_root is not None else None,
            "ops_repo_root_error": ops_repo_root_error,
            "state_root": str(state_root),
            "dropbox_root": str(dropbox_root),
            "dropbox_logs_root": str(logs_root),
            "dropbox_reports_root": str(reports_root),
            "selected_tmp_run_roots": [str(path) for path in run_roots],
            "launchd_jobs_inspected": len(launchd_jobs),
            "launchd_status_archive_path": f"state/{environment}/launchd/job-status.json",
            "included_file_count": len(included),
            "included_files": included,
            "skipped_files": skipped,
            "notes": [
                "Only diagnostic text/JSON/CSV/Markdown files were considered.",
                "Parquet files, SQLite databases, env files, and obvious credential/token files were excluded.",
                "Recent Dropbox, local Integrity and launchd logs were added in addition to the selected tmp run root.",
                "Recent launchd job status and non-sensitive configuration details are in state/<ENV>/launchd/job-status.json.",
                "Raw launchd plists and launchctl output were excluded to avoid disclosing command-line arguments.",
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
