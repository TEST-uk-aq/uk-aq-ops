"""Fail-closed preparation for failed-target-only current-state resume."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .audit import (
    RETRYABLE_STATUSES,
    SUCCESS_STATUSES,
    TARGETS,
    latest_target_attempt,
    load_candidate_set,
    recover_interrupted_target_attempt,
)


def parse_integrity_run_id(value: str, *, env_name: str) -> int:
    raw = str(value or "").strip()
    if ":" in raw:
        prefix, raw = raw.rsplit(":", 1)
        if prefix != env_name:
            raise RuntimeError("resume Integrity run ID environment does not match --env")
    try:
        run_id = int(raw)
    except ValueError as exc:
        raise RuntimeError("resume Integrity run ID must be numeric or <env>:<numeric>") from exc
    if run_id <= 0:
        raise RuntimeError("resume Integrity run ID must be positive")
    return run_id


def _load_run_audit(
    conn: sqlite3.Connection, *, env_name: str, run_id: int,
) -> tuple[sqlite3.Row | tuple[Any, ...], dict[str, Any]]:
    run = conn.execute(
        """SELECT env_name, r2_history_status, current_state_reconciliation_json,
                  from_day, to_day, source_filter
           FROM integrity_runs WHERE id=?""",
        (int(run_id),),
    ).fetchone()
    if run is None:
        raise RuntimeError("referenced Integrity run does not exist")
    if str(run[0]) != env_name:
        raise RuntimeError("referenced Integrity run environment does not match --env")
    if str(run[1]) != "ok":
        raise RuntimeError(
            "final verified R2 evidence is unavailable; run a new scoped Integrity operation"
        )
    try:
        reconciliation = json.loads(str(run[2] or "{}"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("current-state reconciliation audit JSON is invalid") from exc
    if not isinstance(reconciliation, dict) or reconciliation.get(
        "r2_history_status"
    ) != "ok":
        raise RuntimeError(
            "final verified R2 audit is inconsistent; run a new scoped Integrity operation"
        )
    return run, reconciliation


def _validate_r2_operation_evidence(
    conn: sqlite3.Connection, *, run_id: int,
) -> None:
    operation_count, unverified_count = conn.execute(
        """SELECT COUNT(*), SUM(CASE WHEN
             remote_completed<>1 OR
             (operation_kind='put' AND get_verified<>1) OR
             (operation_kind IN ('delete', 'delete_prefix') AND delete_verified<>1)
           THEN 1 ELSE 0 END)
           FROM integrity_object_operations
           WHERE run_id=? AND planned=1""",
        (int(run_id),),
    ).fetchone()
    if int(operation_count or 0) == 0 or int(unverified_count or 0) > 0:
        raise RuntimeError(
            "final verified R2 object evidence is inconsistent; run a new scoped Integrity operation"
        )
    superseding_r2_operation = conn.execute(
        """SELECT newer.run_id
           FROM integrity_object_operations original
           JOIN integrity_object_operations newer
             ON newer.object_key=original.object_key
            AND newer.run_id>original.run_id
            AND newer.remote_completed=1
           WHERE original.run_id=? AND original.planned=1
           ORDER BY newer.run_id DESC LIMIT 1""",
        (int(run_id),),
    ).fetchone()
    if superseding_r2_operation is not None:
        raise RuntimeError(
            "verified R2 scope was superseded by a newer Integrity apply; "
            "run a new scoped Integrity operation"
        )


def _select_targets(
    *, requested_target: str, latest: dict[str, dict[str, Any] | None],
) -> tuple[list[str], list[str]]:
    if requested_target == "failed":
        requested = list(TARGETS)
    elif requested_target == "all":
        requested = list(TARGETS)
    else:
        requested = [requested_target]
    selected: list[str] = []
    already_satisfied: list[str] = []
    for target in requested:
        attempt = latest[target]
        status = str(attempt.get("status")) if attempt else "pending"
        if status in RETRYABLE_STATUSES:
            selected.append(target)
        elif status in SUCCESS_STATUSES:
            already_satisfied.append(target)
        elif requested_target in {"failed", "all"} and status in {
            "failed_terminal", "blocked_dependency", "superseded"
        }:
            continue
        else:
            raise RuntimeError(
                f"{target} is not eligible for retry because its latest status is {status}"
            )
    return selected, already_satisfied


def prepare_current_state_resume(
    conn: sqlite3.Connection, *, env_name: str, run_id: int, requested_target: str,
) -> dict[str, Any]:
    """Prove the original R2 result and return only authorised target work."""
    if requested_target not in {"failed", "timeseries", "latest_snapshot", "all"}:
        raise RuntimeError("unsupported current-state resume target")
    run, reconciliation = _load_run_audit(
        conn, env_name=env_name, run_id=run_id
    )
    _validate_r2_operation_evidence(conn, run_id=run_id)

    evidence = {
        target: load_candidate_set(conn, integrity_run_id=run_id, target=target)
        for target in TARGETS
    }
    for target, target_evidence in evidence.items():
        evidence_env = str(target_evidence.get("env_name") or "")
        if evidence_env and evidence_env != env_name:
            raise RuntimeError(f"{target} candidate environment does not match --env")
        if target_evidence.get("superseded_by_run_id") is not None:
            raise RuntimeError(f"{target} candidate evidence has been superseded")
        verification = target_evidence.get("final_verification") or {}
        if str(verification.get("status") or "") != "ok" or int(
            verification.get("remaining_gap_count") or 0
        ) != 0:
            raise RuntimeError(
                "recorded final R2 verification is not a successful gap-free result"
            )
    verification_identities = {
        str(value["final_verification_identity_sha256"])
        for value in evidence.values()
    }
    if len(verification_identities) != 1 or reconciliation.get(
        "final_verification_identity_sha256"
    ) not in verification_identities:
        raise RuntimeError(
            "final verified R2 identity is inconsistent; run a new scoped Integrity operation"
        )
    scope_identities = {
        str(value["selected_scope_identity_sha256"])
        for value in evidence.values()
    }
    if len(scope_identities) != 1:
        raise RuntimeError("current-state selected scope evidence is inconsistent")

    latest = {
        target: recover_interrupted_target_attempt(
            conn, integrity_run_id=run_id, target=target
        )
        for target in TARGETS
    }
    for target in TARGETS:
        attempt = latest[target]
        if attempt is None:
            continue
        if str(attempt["candidate_identity_sha256"]) != str(
            evidence[target]["candidate_identity_sha256"]
        ) or str(attempt["final_verification_identity_sha256"]) != str(
            evidence[target]["final_verification_identity_sha256"]
        ):
            raise RuntimeError(f"{target} attempt evidence is inconsistent")

    selected, already_satisfied = _select_targets(
        requested_target=requested_target, latest=latest
    )
    for target in selected:
        newer_success = conn.execute(
            """SELECT integrity_run_id, id FROM current_state_target_attempts
               WHERE integrity_run_id>? AND env_name=? AND target=?
                 AND status='succeeded' AND candidate_identity_sha256=?
               ORDER BY integrity_run_id DESC, attempt_number DESC LIMIT 1""",
            (
                run_id, env_name, target,
                evidence[target]["candidate_identity_sha256"],
            ),
        ).fetchone()
        if newer_success is not None:
            conn.execute(
                """UPDATE current_state_candidate_sets
                   SET superseded_by_run_id=?
                   WHERE integrity_run_id=? AND target=?""",
                (int(newer_success[0]), int(run_id), target),
            )
            conn.commit()
            raise RuntimeError(
                f"{target} resume is superseded by a newer successful reconciliation"
            )
    return {
        "integrity_run_id": run_id,
        "env_name": env_name,
        "selected_targets": selected,
        "already_satisfied_targets": already_satisfied,
        "candidate_sets": evidence,
        "previous_attempts": latest,
        "scope": {
            "from_day": run[3],
            "to_day": run[4],
            "source": run[5],
        },
        "r2_history_status": "ok",
    }
