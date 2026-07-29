"""Fail-closed preparation for failed-target-only current-state resume."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .audit import TARGETS, latest_target_attempt, load_candidate_set


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


def prepare_current_state_resume(
    conn: sqlite3.Connection, *, env_name: str, run_id: int, requested_target: str,
) -> dict[str, Any]:
    """Prove the original R2 result and return only authorised target work."""
    if requested_target not in {"failed", "timeseries", "latest_snapshot", "all"}:
        raise RuntimeError("unsupported current-state resume target")
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
    if not isinstance(reconciliation, dict) or reconciliation.get("r2_history_status") != "ok":
        raise RuntimeError(
            "final verified R2 audit is inconsistent; run a new scoped Integrity operation"
        )
    unverified_operations = int(conn.execute(
        """SELECT COUNT(*) FROM integrity_object_operations
           WHERE run_id=? AND planned=1 AND (
             remote_completed<>1 OR
             (operation_kind='put' AND get_verified<>1) OR
             (operation_kind IN ('delete', 'delete_prefix') AND delete_verified<>1)
           )""",
        (int(run_id),),
    ).fetchone()[0])
    if unverified_operations:
        raise RuntimeError(
            "final verified R2 object evidence is inconsistent; run a new scoped Integrity operation"
        )
    superseding_r2_operation = conn.execute(
        """SELECT 1
           FROM integrity_object_operations original
           JOIN integrity_object_operations newer
             ON newer.object_key=original.object_key
            AND newer.operation_kind=original.operation_kind
            AND newer.run_id>original.run_id
            AND newer.remote_completed=1
           WHERE original.run_id=? AND original.planned=1
           LIMIT 1""",
        (int(run_id),),
    ).fetchone()
    if superseding_r2_operation is not None:
        raise RuntimeError(
            "verified R2 scope was superseded by a newer Integrity apply; run a new scoped Integrity operation"
        )

    evidence = {target: load_candidate_set(
        conn, integrity_run_id=run_id, target=target
    ) for target in TARGETS}
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
    latest = {target: latest_target_attempt(
        conn, integrity_run_id=run_id, target=target
    ) for target in TARGETS}
    if requested_target == "all":
        selected = list(TARGETS)
    elif requested_target in TARGETS:
        selected = [requested_target]
    else:
        selected = [
            target for target in TARGETS
            if latest[target] is None
            or str(latest[target]["status"]) in {"failed", "pending", "blocked_dependency"}
        ]
    if not selected:
        raise RuntimeError("no failed or pending current-state target requires resume")
    for target in selected:
        newer_success = conn.execute(
            """SELECT 1 FROM current_state_target_attempts
               WHERE integrity_run_id>? AND env_name=? AND target=? AND status='ok'
                 AND candidate_identity_sha256=? LIMIT 1""",
            (run_id, env_name, target, evidence[target]["candidate_identity_sha256"]),
        ).fetchone()
        if newer_success is not None:
            raise RuntimeError(
                f"{target} resume is superseded by a newer successful reconciliation"
            )
    return {
        "integrity_run_id": run_id,
        "env_name": env_name,
        "selected_targets": selected,
        "candidate_sets": evidence,
        "previous_attempts": latest,
        "scope": {"from_day": run[3], "to_day": run[4], "source": run[5]},
        "r2_history_status": "ok",
    }
