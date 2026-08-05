#!/usr/bin/env python3
"""Dispatch UK AQ WHO 2021 GitHub Actions runs one month at a time.

The repository is read from UK_AQ_GITHUB_REPO, normally supplied by the
currently sourced CIC-Test or LIVE environment.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

DEFAULT_WORKFLOW = "uk_aq_who_2021_daily.yml"
DEFAULT_REF = "main"
DEFAULT_POLL_SECONDS = 15
RUN_URL_RE = re.compile(r"https://github\.com/[^/]+/[^/]+/actions/runs/(\d+)")


class RunnerError(RuntimeError):
    """Raised for a controlled runner failure."""


@dataclass(frozen=True, order=True)
class MonthWindow:
    month: str
    start_day_utc: str
    end_day_utc: str


@dataclass
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: Optional[datetime] = None) -> str:
    current = value or utc_now()
    return current.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_month(value: str) -> MonthWindow:
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        raise argparse.ArgumentTypeError(
            f"Invalid month {value!r}; expected YYYY-MM"
        )

    try:
        parsed = datetime.strptime(value, "%Y-%m")
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Invalid calendar month {value!r}"
        ) from exc

    year = parsed.year
    month_number = parsed.month
    last_day = calendar.monthrange(year, month_number)[1]
    start = date(year, month_number, 1)
    end = date(year, month_number, last_day)

    return MonthWindow(
        month=value,
        start_day_utc=start.isoformat(),
        end_day_utc=end.isoformat(),
    )


def month_range(first: MonthWindow, last: MonthWindow) -> List[MonthWindow]:
    first_key = tuple(map(int, first.month.split("-")))
    last_key = tuple(map(int, last.month.split("-")))
    if first_key > last_key:
        raise RunnerError("--from-month must not be later than --to-month")

    result: List[MonthWindow] = []
    year, month_number = first_key
    end_year, end_month = last_key

    while (year, month_number) <= (end_year, end_month):
        result.append(parse_month(f"{year:04d}-{month_number:02d}"))
        if month_number == 12:
            year += 1
            month_number = 1
        else:
            month_number += 1

    return result


def selected_months(args: argparse.Namespace) -> List[MonthWindow]:
    if args.months:
        # Sort chronologically and remove duplicates.
        return sorted({parse_month(value) for value in args.months})

    if args.from_month is None and args.to_month is None:
        raise RunnerError(
            "Select months with --months, or use --from-month and --to-month"
        )

    if args.from_month is None or args.to_month is None:
        raise RunnerError("--from-month and --to-month must be supplied together")

    return month_range(parse_month(args.from_month), parse_month(args.to_month))


def validate_complete_months(months: Iterable[MonthWindow]) -> None:
    today = utc_now().date()
    current_month = (today.year, today.month)

    invalid = []
    for item in months:
        year, month_number = map(int, item.month.split("-"))
        if (year, month_number) >= current_month:
            invalid.append(item.month)

    if invalid:
        joined = ", ".join(invalid)
        raise RunnerError(
            "This monthly runner only accepts complete calendar months. "
            f"Current or future month supplied: {joined}"
        )


def run_command(
    command: Sequence[str],
    *,
    check: bool = True,
    timeout: Optional[int] = None,
) -> CommandResult:
    try:
        completed = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RunnerError(f"Command not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RunnerError(
            f"Command timed out: {' '.join(command)}"
        ) from exc

    result = CommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout.strip(),
        stderr=completed.stderr.strip(),
    )

    if check and result.returncode != 0:
        details = result.stderr or result.stdout or "No command output"
        raise RunnerError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n{details}"
        )

    return result


def gh(repo: str, args: Sequence[str], *, check: bool = True) -> CommandResult:
    return run_command(["gh", *args, "--repo", repo], check=check)


def gh_json(repo: str, args: Sequence[str]) -> Any:
    result = gh(repo, args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RunnerError(
            "GitHub CLI returned invalid JSON for: "
            f"gh {' '.join(args)} --repo {repo}\n{result.stdout}"
        ) from exc


def recent_run_ids(repo: str, workflow: str, ref: str) -> Set[int]:
    payload = gh_json(
        repo,
        [
            "run",
            "list",
            "--workflow",
            workflow,
            "--event",
            "workflow_dispatch",
            "--branch",
            ref,
            "--limit",
            "50",
            "--json",
            "databaseId",
        ],
    )
    return {
        int(item["databaseId"])
        for item in payload
        if item.get("databaseId") is not None
    }


def parse_run_id_from_dispatch_output(output: str) -> Optional[int]:
    match = RUN_URL_RE.search(output)
    if not match:
        return None
    return int(match.group(1))


def find_new_run(
    repo: str,
    workflow: str,
    ref: str,
    previous_ids: Set[int],
    dispatch_started_at: datetime,
    timeout_seconds: int = 90,
) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds

    while time.monotonic() < deadline:
        payload = gh_json(
            repo,
            [
                "run",
                "list",
                "--workflow",
                workflow,
                "--event",
                "workflow_dispatch",
                "--branch",
                ref,
                "--limit",
                "20",
                "--json",
                "databaseId,number,createdAt,status,conclusion,url,displayTitle,headBranch",
            ],
        )

        candidates: List[Dict[str, Any]] = []
        for item in payload:
            raw_id = item.get("databaseId")
            if raw_id is None or int(raw_id) in previous_ids:
                continue

            created_text = item.get("createdAt")
            if created_text:
                created = datetime.fromisoformat(created_text.replace("Z", "+00:00"))
                # Allow for small clock differences between the local machine
                # and GitHub while still ignoring clearly older runs.
                if created < dispatch_started_at - timedelta(seconds=60):
                    continue

            candidates.append(item)

        if candidates:
            candidates.sort(
                key=lambda item: item.get("createdAt") or "",
                reverse=True,
            )
            return candidates[0]

        time.sleep(3)

    raise RunnerError(
        "The workflow dispatch was accepted, but its GitHub run ID could not "
        "be identified within 90 seconds. Check the repository Actions page."
    )


def view_run(repo: str, run_id: int) -> Dict[str, Any]:
    return gh_json(
        repo,
        [
            "run",
            "view",
            str(run_id),
            "--json",
            (
                "databaseId,number,status,conclusion,url,displayTitle,workflowName,"
                "createdAt,startedAt,updatedAt"
            ),
        ],
    )


def wait_for_run_available(
    repo: str,
    run_id: int,
    timeout_seconds: int = 60,
) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error: Optional[RunnerError] = None

    while time.monotonic() < deadline:
        try:
            return view_run(repo, run_id)
        except RunnerError as exc:
            last_error = exc
            time.sleep(2)

    if last_error is not None:
        raise RunnerError(
            f"GitHub returned run ID {run_id}, but the run could not be read "
            f"within {timeout_seconds} seconds. Last error: {last_error}"
        ) from last_error

    raise RunnerError(f"GitHub run {run_id} did not become readable")


def dispatch_month(
    repo: str,
    workflow: str,
    ref: str,
    month: MonthWindow,
    run_mode: str,
) -> Dict[str, Any]:
    previous_ids = recent_run_ids(repo, workflow, ref)
    dispatch_started_at = utc_now()

    command = [
        "workflow",
        "run",
        workflow,
        "--ref",
        ref,
        "--raw-field",
        f"run_mode={run_mode}",
        "--raw-field",
        "trigger_mode=manual",
        "--raw-field",
        f"start_day_utc={month.start_day_utc}",
        "--raw-field",
        f"end_day_utc={month.end_day_utc}",
        "--raw-field",
        "refresh_summaries=mode_default",
        "--raw-field",
        "publish_json=false",
        "--raw-field",
        "write_parquet=false",
    ]

    result = gh(repo, command)
    combined_output = "\n".join(
        part for part in (result.stdout, result.stderr) if part
    )
    run_id = parse_run_id_from_dispatch_output(combined_output)

    if run_id is not None:
        run = wait_for_run_available(repo, run_id)
    else:
        run = find_new_run(
            repo,
            workflow,
            ref,
            previous_ids,
            dispatch_started_at,
        )
        run_id = int(run["databaseId"])

    run["databaseId"] = run_id
    run["dispatchOutput"] = combined_output or None
    run["dispatchedAt"] = utc_iso(dispatch_started_at)
    return run


def wait_for_run(
    repo: str,
    run_id: int,
    poll_seconds: int,
) -> Dict[str, Any]:
    last_status: Optional[str] = None

    while True:
        run = view_run(repo, run_id)
        status = str(run.get("status") or "unknown")
        conclusion = run.get("conclusion")

        if status != last_status:
            suffix = f", conclusion={conclusion}" if conclusion else ""
            run_number = run.get("number")
            if run_number is not None:
                label = f"GitHub run #{run_number} (ID {run_id})"
            else:
                label = f"GitHub run ID {run_id}"
            print(f"  {label}: status={status}{suffix}", flush=True)
            last_status = status

        if status == "completed":
            return run

        time.sleep(poll_seconds)


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Dispatch WHO 2021 GitHub Actions runs sequentially, one complete "
            "calendar month at a time."
        )
    )
    parser.add_argument(
        "--months",
        nargs="+",
        metavar="YYYY-MM",
        help="Specific months to run, for example: --months 2025-01 2025-03",
    )
    parser.add_argument(
        "--from-month",
        metavar="YYYY-MM",
        help="First month in an inclusive continuous range",
    )
    parser.add_argument(
        "--to-month",
        metavar="YYYY-MM",
        help="Last month in an inclusive continuous range",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Dispatch each workflow with run_mode=dry_run instead of backfill",
    )
    parser.add_argument(
        "--repo",
        help="Override UK_AQ_GITHUB_REPO",
    )
    parser.add_argument(
        "--workflow",
        default=DEFAULT_WORKFLOW,
        help=f"Workflow file or name (default: {DEFAULT_WORKFLOW})",
    )
    parser.add_argument(
        "--ref",
        default=DEFAULT_REF,
        help=f"Git ref containing the workflow (default: {DEFAULT_REF})",
    )
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=DEFAULT_POLL_SECONDS,
        help=f"Run status polling interval (default: {DEFAULT_POLL_SECONDS})",
    )
    parser.add_argument(
        "--log-dir",
        default="logs/who_2021",
        help="Directory for the JSON run record (default: logs/who_2021)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.months and (args.from_month or args.to_month):
            raise RunnerError(
                "Use either --months or --from-month/--to-month, not both"
            )

        months = selected_months(args)
        if not months:
            raise RunnerError("No months were selected")
        validate_complete_months(months)

        if args.poll_seconds < 3:
            raise RunnerError("--poll-seconds must be at least 3")

        repo = args.repo or os.environ.get("UK_AQ_GITHUB_REPO")
        if not repo:
            raise RunnerError(
                "UK_AQ_GITHUB_REPO is not set. Source the CIC-Test or LIVE "
                "environment, or supply --repo OWNER/REPO."
            )
        if not re.fullmatch(r"[^/\s]+/[^/\s]+", repo):
            raise RunnerError(
                f"Invalid repository {repo!r}; expected OWNER/REPO"
            )

        if shutil.which("gh") is None:
            raise RunnerError("GitHub CLI 'gh' is not installed or not on PATH")

        # This also confirms that the token can read the repository and workflow.
        gh(
            repo,
            [
                "workflow",
                "view",
                args.workflow,
                "--yaml",
                "--ref",
                args.ref,
            ],
        )

        run_mode = "dry_run" if args.dry_run else "backfill"
        timestamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
        log_path = Path(args.log_dir) / f"who_2021_months_{timestamp}.json"

        state: Dict[str, Any] = {
            "startedAt": utc_iso(),
            "finishedAt": None,
            "status": "running",
            "repository": repo,
            "workflow": args.workflow,
            "ref": args.ref,
            "runMode": run_mode,
            "triggerMode": "manual",
            "fixedInputs": {
                "refresh_summaries": "mode_default",
                "publish_json": "false",
                "write_parquet": "false",
            },
            "selectedMonths": [item.month for item in months],
            "runs": [],
        }
        atomic_write_json(log_path, state)

        print("WHO 2021 monthly workflow runner")
        print(f"Repository:  {repo}")
        print(f"Workflow:    {args.workflow}")
        print(f"Git ref:     {args.ref}")
        print(f"Run mode:    {run_mode}")
        print(f"Months:      {', '.join(item.month for item in months)}")
        print(f"Run record:  {log_path}")
        print()

        for index, month in enumerate(months, start=1):
            print(
                f"[{index}/{len(months)}] Dispatching {month.month} "
                f"({month.start_day_utc} to {month.end_day_utc})...",
                flush=True,
            )

            record: Dict[str, Any] = {
                "month": month.month,
                "startDayUtc": month.start_day_utc,
                "endDayUtc": month.end_day_utc,
                "dispatchStartedAt": utc_iso(),
                "runId": None,
                "runNumber": None,
                "url": None,
                "status": "dispatching",
                "conclusion": None,
                "completedAt": None,
            }
            state["runs"].append(record)
            atomic_write_json(log_path, state)

            dispatched = dispatch_month(
                repo,
                args.workflow,
                args.ref,
                month,
                run_mode,
            )
            run_id = int(dispatched["databaseId"])
            run_number = dispatched.get("number")
            if run_number is not None:
                run_number = int(run_number)
            record.update(
                {
                    "runId": run_id,
                    "runNumber": run_number,
                    "url": dispatched.get("url"),
                    "status": dispatched.get("status") or "queued",
                    "displayTitle": dispatched.get("displayTitle"),
                    "githubCreatedAt": dispatched.get("createdAt"),
                    "dispatchOutput": dispatched.get("dispatchOutput"),
                }
            )
            atomic_write_json(log_path, state)

            if run_number is not None:
                print(f"  Run #:  #{run_number}")
            print(f"  Run ID: {run_id}")
            if record["url"]:
                print(f"  URL:    {record['url']}")

            completed = wait_for_run(repo, run_id, args.poll_seconds)
            conclusion = completed.get("conclusion")
            record.update(
                {
                    "status": completed.get("status"),
                    "conclusion": conclusion,
                    "runNumber": completed.get("number") or record.get("runNumber"),
                    "url": completed.get("url") or record.get("url"),
                    "githubStartedAt": completed.get("startedAt"),
                    "githubUpdatedAt": completed.get("updatedAt"),
                    "completedAt": utc_iso(),
                }
            )
            atomic_write_json(log_path, state)

            if conclusion != "success":
                state["status"] = "failed"
                state["failedMonth"] = month.month
                state["finishedAt"] = utc_iso()
                atomic_write_json(log_path, state)
                raise RunnerError(
                    f"WHO 2021 run failed for {month.month}: "
                    f"conclusion={conclusion!r}, URL={record.get('url')}"
                )

            print(f"  {month.month} succeeded.\n", flush=True)

        state["status"] = "success"
        state["finishedAt"] = utc_iso()
        atomic_write_json(log_path, state)
        print(f"All {len(months)} month(s) succeeded.")
        print(f"Run record: {log_path}")
        return 0

    except KeyboardInterrupt:
        print(
            "\nInterrupted locally. Any GitHub workflow already dispatched will "
            "continue unless cancelled separately.",
            file=sys.stderr,
        )
        return 130
    except RunnerError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
