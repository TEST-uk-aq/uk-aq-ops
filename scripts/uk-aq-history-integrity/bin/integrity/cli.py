"""Side-effect-free CLI composition for the additive current-state resume mode."""

from __future__ import annotations

import argparse


def add_current_state_resume_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--resume-current-state-run-id", default=None,
        help="Resume current-state targets for an existing verified Integrity run.",
    )
    parser.add_argument(
        "--resume-current-state-target", default="failed",
        choices=["failed", "timeseries", "latest_snapshot", "all"],
        help="Current-state target to resume (default: failed only).",
    )


def validate_current_state_resume_arguments(
    parser: argparse.ArgumentParser, args: argparse.Namespace,
) -> None:
    if not args.resume_current_state_run_id:
        return
    if args.run_backfill or args.check_only or args.dry_run:
        parser.error(
            "--resume-current-state-run-id cannot be combined with repair, check-only or dry-run"
        )
    if args.repair_pollutants:
        parser.error("current-state resume does not accept --repair-pollutants")
    if args.profile != "manual" or args.from_day or args.to_day:
        parser.error("current-state resume does not accept profile or date selection")

