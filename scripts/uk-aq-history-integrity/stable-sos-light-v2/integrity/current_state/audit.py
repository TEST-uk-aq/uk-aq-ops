"""Durable, independently queryable current-state target audit."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from typing import Any, Iterable, Mapping

TARGETS = ("timeseries", "latest_snapshot")
TARGET_STATUSES = frozenset({
    "pending",
    "running",
    "succeeded",
    "failed_retryable",
    "failed_terminal",
    "blocked_dependency",
    "skipped_not_applicable",
    "superseded",
})
RETRYABLE_STATUSES = frozenset({"failed_retryable", "pending"})

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS current_state_candidate_sets (
  integrity_run_id INTEGER NOT NULL,
  env_name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('timeseries', 'latest_snapshot')),
  candidate_identity_sha256 TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  candidate_observed_at_min TEXT,
  candidate_observed_at_max TEXT,
  candidates_json TEXT NOT NULL,
  final_verification_identity_sha256 TEXT NOT NULL,
  final_verification_json TEXT NOT NULL,
  selected_scope_identity_sha256 TEXT NOT NULL,
  selected_scope_json TEXT NOT NULL,
  superseded_by_run_id INTEGER,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (integrity_run_id, target),
  FOREIGN KEY (integrity_run_id) REFERENCES integrity_runs(id)
);
CREATE TABLE IF NOT EXISTS current_state_target_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integrity_run_id INTEGER NOT NULL,
  linked_attempt_id INTEGER,
  env_name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('timeseries', 'latest_snapshot')),
  attempt_number INTEGER NOT NULL,
  invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('initial', 'resume')),
  status TEXT NOT NULL,
  retryable INTEGER NOT NULL,
  failure_class TEXT NOT NULL CHECK (failure_class IN ('none', 'retryable', 'terminal')),
  candidate_identity_sha256 TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  candidate_observed_at_min TEXT,
  candidate_observed_at_max TEXT,
  final_verification_identity_sha256 TEXT NOT NULL,
  outcome_counts_json TEXT NOT NULL,
  bounded_error TEXT,
  superseded_by_attempt_id INTEGER,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  UNIQUE (integrity_run_id, target, attempt_number),
  FOREIGN KEY (integrity_run_id) REFERENCES integrity_runs(id),
  FOREIGN KEY (linked_attempt_id) REFERENCES current_state_target_attempts(id),
  FOREIGN KEY (superseded_by_attempt_id) REFERENCES current_state_target_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_current_state_target_attempts_run_target
  ON current_state_target_attempts(integrity_run_id, target, attempt_number DESC);
"""


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _bounded_error(value: object) -> str | None:
    detail = " ".join(str(value or "").split())
    return detail[:500] or None


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def identity_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _ensure_columns(
    conn: sqlite3.Connection, table: str, columns: Mapping[str, str],
) -> None:
    existing = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def ensure_audit_schema(conn: sqlite3.Connection) -> None:
    """Apply the additive SQLite schema, including upgrades from branch previews."""
    conn.executescript(SCHEMA_SQL)
    _ensure_columns(conn, "current_state_candidate_sets", {
        "env_name": "TEXT NOT NULL DEFAULT ''",
        "candidate_observed_at_min": "TEXT",
        "candidate_observed_at_max": "TEXT",
        "final_verification_json": "TEXT NOT NULL DEFAULT '{}'",
        "selected_scope_identity_sha256": "TEXT NOT NULL DEFAULT ''",
        "selected_scope_json": "TEXT NOT NULL DEFAULT '{}'",
        "superseded_by_run_id": "INTEGER",
    })
    _ensure_columns(conn, "current_state_target_attempts", {
        "retryable": "INTEGER NOT NULL DEFAULT 0",
        "candidate_observed_at_min": "TEXT",
        "candidate_observed_at_max": "TEXT",
        "final_verification_identity_sha256": "TEXT NOT NULL DEFAULT ''",
        "superseded_by_attempt_id": "INTEGER",
    })
    conn.execute(
        """UPDATE current_state_target_attempts
           SET status = CASE
                 WHEN status='ok' THEN 'succeeded'
                 WHEN status='failed' AND failure_class='terminal'
                   THEN 'failed_terminal'
                 WHEN status='failed' THEN 'failed_retryable'
                 WHEN status='planned' THEN 'pending'
                 WHEN status='skipped_empty' THEN 'skipped_not_applicable'
                 ELSE status
               END,
               retryable = CASE
                 WHEN status IN ('failed', 'failed_retryable', 'planned', 'pending')
                   AND failure_class<>'terminal' THEN 1
                 ELSE 0
               END"""
    )
    conn.execute(
        """UPDATE current_state_target_attempts
           SET final_verification_identity_sha256 = COALESCE((
             SELECT candidate.final_verification_identity_sha256
             FROM current_state_candidate_sets candidate
             WHERE candidate.integrity_run_id=current_state_target_attempts.integrity_run_id
               AND candidate.target=current_state_target_attempts.target
           ), '')
           WHERE final_verification_identity_sha256=''"""
    )
    conn.commit()


def _candidate_timestamp_bounds(
    candidates: Iterable[Mapping[str, Any]],
) -> tuple[str | None, str | None]:
    timestamps = sorted({
        str(candidate.get("observed_at") or "").strip()
        for candidate in candidates
        if str(candidate.get("observed_at") or "").strip()
    })
    return (
        timestamps[0] if timestamps else None,
        timestamps[-1] if timestamps else None,
    )


def persist_candidate_set(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
    candidates: Iterable[Mapping[str, Any]], final_verification: Mapping[str, Any],
    env_name: str = "", selected_scope: Mapping[str, Any] | None = None,
) -> str:
    """Persist immutable target candidates and their final-R2 proof."""
    if target not in TARGETS:
        raise ValueError(f"unsupported current-state target: {target}")
    materialized = [dict(candidate) for candidate in candidates]
    verification = dict(final_verification)
    scope = dict(selected_scope or {})
    candidate_identity = identity_sha256(materialized)
    verification_identity = identity_sha256(verification)
    scope_identity = identity_sha256(scope)
    observed_min, observed_max = _candidate_timestamp_bounds(materialized)
    existing = conn.execute(
        """SELECT candidate_identity_sha256, candidate_count, candidates_json,
                  final_verification_identity_sha256, final_verification_json,
                  selected_scope_identity_sha256, selected_scope_json
           FROM current_state_candidate_sets
           WHERE integrity_run_id=? AND target=?""",
        (int(integrity_run_id), target),
    ).fetchone()
    expected = (
        candidate_identity,
        len(materialized),
        canonical_json(materialized),
        verification_identity,
        canonical_json(verification),
        scope_identity,
        canonical_json(scope),
    )
    if existing is not None:
        if tuple(existing) != expected:
            raise RuntimeError(
                f"immutable current-state candidate evidence changed for {target}"
            )
        return candidate_identity
    conn.execute(
        """INSERT INTO current_state_candidate_sets (
          integrity_run_id, env_name, target, candidate_identity_sha256,
          candidate_count, candidate_observed_at_min, candidate_observed_at_max,
          candidates_json, final_verification_identity_sha256,
          final_verification_json, selected_scope_identity_sha256,
          selected_scope_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            int(integrity_run_id), env_name, target, candidate_identity,
            len(materialized), observed_min, observed_max,
            canonical_json(materialized), verification_identity,
            canonical_json(verification), scope_identity, canonical_json(scope),
            _utc_now(),
        ),
    )
    conn.commit()
    return candidate_identity


def load_candidate_set(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
) -> dict[str, Any]:
    row = conn.execute(
        """SELECT env_name, candidate_identity_sha256, candidate_count,
                  candidate_observed_at_min, candidate_observed_at_max,
                  candidates_json, final_verification_identity_sha256,
                  final_verification_json, selected_scope_identity_sha256,
                  selected_scope_json, superseded_by_run_id
           FROM current_state_candidate_sets
           WHERE integrity_run_id=? AND target=?""",
        (int(integrity_run_id), target),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"current-state {target} candidate evidence is missing")
    try:
        candidates = json.loads(str(row[5]))
        final_verification = json.loads(str(row[7]))
        selected_scope = json.loads(str(row[9]))
    except json.JSONDecodeError as exc:
        raise RuntimeError("current-state candidate evidence JSON is invalid") from exc
    if not isinstance(candidates, list) or identity_sha256(candidates) != str(row[1]):
        raise RuntimeError("current-state candidate evidence identity is invalid")
    if len(candidates) != int(row[2]):
        raise RuntimeError("current-state candidate evidence count is invalid")
    if not isinstance(final_verification, dict) or identity_sha256(
        final_verification
    ) != str(row[6]):
        raise RuntimeError("final R2 verification evidence identity is invalid")
    if not isinstance(selected_scope, dict) or identity_sha256(
        selected_scope
    ) != str(row[8]):
        raise RuntimeError("current-state selected-scope identity is invalid")
    observed_min, observed_max = _candidate_timestamp_bounds(candidates)
    if observed_min != row[3] or observed_max != row[4]:
        raise RuntimeError("current-state candidate timestamp bounds are invalid")
    return {
        "env_name": str(row[0]),
        "candidate_identity_sha256": str(row[1]),
        "candidate_count": int(row[2]),
        "candidate_observed_at_min": row[3],
        "candidate_observed_at_max": row[4],
        "candidates": candidates,
        "final_verification_identity_sha256": str(row[6]),
        "final_verification": final_verification,
        "selected_scope_identity_sha256": str(row[8]),
        "selected_scope": selected_scope,
        "superseded_by_run_id": int(row[10]) if row[10] is not None else None,
    }


def latest_target_attempt(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """SELECT id, env_name, attempt_number, invocation_kind, status,
                  retryable, failure_class, candidate_identity_sha256,
                  candidate_count, candidate_observed_at_min,
                  candidate_observed_at_max,
                  final_verification_identity_sha256, outcome_counts_json,
                  bounded_error, superseded_by_attempt_id, started_at_utc,
                  finished_at_utc
           FROM current_state_target_attempts
           WHERE integrity_run_id=? AND target=?
           ORDER BY attempt_number DESC LIMIT 1""",
        (int(integrity_run_id), target),
    ).fetchone()
    if row is None:
        return None
    try:
        outcomes = json.loads(str(row[12]))
    except json.JSONDecodeError as exc:
        raise RuntimeError("current-state target outcome audit is invalid") from exc
    return {
        "id": int(row[0]),
        "env_name": str(row[1]),
        "attempt_number": int(row[2]),
        "invocation_kind": str(row[3]),
        "status": str(row[4]),
        "retryable": bool(row[5]),
        "failure_class": str(row[6]),
        "candidate_identity_sha256": str(row[7]),
        "candidate_count": int(row[8]),
        "candidate_observed_at_min": row[9],
        "candidate_observed_at_max": row[10],
        "final_verification_identity_sha256": str(row[11]),
        "outcome_counts": outcomes,
        "bounded_error": row[13],
        "superseded_by_attempt_id": (
            int(row[14]) if row[14] is not None else None
        ),
        "started_at_utc": str(row[15]),
        "finished_at_utc": str(row[16]) if row[16] is not None else None,
    }


def start_target_attempt(
    conn: sqlite3.Connection, *, integrity_run_id: int, env_name: str,
    target: str, candidate_identity_sha256: str,
    candidate_count: int, candidate_observed_at_min: str | None,
    candidate_observed_at_max: str | None,
    final_verification_identity_sha256: str,
) -> dict[str, Any]:
    """Append and durably mark a target attempt before its side effect."""
    if target not in TARGETS:
        raise ValueError(f"unsupported current-state target: {target}")
    previous = latest_target_attempt(
        conn, integrity_run_id=integrity_run_id, target=target
    )
    attempt_number = int(previous["attempt_number"] if previous else 0) + 1
    now = _utc_now()
    finished_column = next(
        row for row in conn.execute(
            "PRAGMA table_info(current_state_target_attempts)"
        ) if str(row[1]) == "finished_at_utc"
    )
    initial_finished_at = now if bool(finished_column[3]) else None
    cursor = conn.execute(
        """INSERT INTO current_state_target_attempts (
          integrity_run_id, linked_attempt_id, env_name, target, attempt_number,
          invocation_kind, status, retryable, failure_class,
          candidate_identity_sha256, candidate_count,
          candidate_observed_at_min, candidate_observed_at_max,
          final_verification_identity_sha256, outcome_counts_json,
          bounded_error, started_at_utc, finished_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 'none', ?, ?, ?, ?, ?, '{}',
                  NULL, ?, ?)""",
        (
            int(integrity_run_id), previous["id"] if previous else None,
            env_name, target, attempt_number, "initial",
            candidate_identity_sha256, int(candidate_count),
            candidate_observed_at_min, candidate_observed_at_max,
            final_verification_identity_sha256, now, initial_finished_at,
        ),
    )
    conn.commit()
    return {
        "attempt_id": int(cursor.lastrowid),
        "attempt_number": attempt_number,
        "status": "running",
        "retryable": False,
        "failure_class": "none",
    }


def finish_target_attempt(
    conn: sqlite3.Connection, *, attempt_id: int, status: str,
    outcome_counts: Mapping[str, Any], error: str | None = None,
) -> dict[str, Any]:
    """Complete one running attempt without altering previous attempts."""
    if status not in TARGET_STATUSES - {"running"}:
        raise ValueError(f"invalid current-state target status: {status}")
    row = conn.execute(
        "SELECT attempt_number, status FROM current_state_target_attempts WHERE id=?",
        (int(attempt_id),),
    ).fetchone()
    if row is None:
        raise RuntimeError("current-state target attempt is missing")
    if str(row[1]) != "running":
        raise RuntimeError("current-state target attempt is already complete")
    retryable = status in RETRYABLE_STATUSES
    failure_class = (
        "retryable" if retryable
        else "terminal" if status in {"failed_terminal", "blocked_dependency"}
        else "none"
    )
    conn.execute(
        """UPDATE current_state_target_attempts
           SET status=?, retryable=?, failure_class=?, outcome_counts_json=?,
               bounded_error=?, finished_at_utc=?
           WHERE id=? AND status='running'""",
        (
            status, int(retryable), failure_class,
            canonical_json(dict(outcome_counts)), _bounded_error(error),
            _utc_now(), int(attempt_id),
        ),
    )
    conn.commit()
    return {
        "attempt_id": int(attempt_id),
        "attempt_number": int(row[0]),
        "status": status,
        "retryable": retryable,
        "failure_class": failure_class,
    }


def record_target_attempt(
    conn: sqlite3.Connection, *, integrity_run_id: int, env_name: str,
    target: str, status: str,
    candidate_identity_sha256: str, candidate_count: int,
    outcome_counts: Mapping[str, Any], error: str | None = None,
    failure_class: str | None = None,
    candidate_observed_at_min: str | None = None,
    candidate_observed_at_max: str | None = None,
    final_verification_identity_sha256: str = "",
) -> dict[str, Any]:
    """Compatibility helper for callers that already have a complete result."""
    mapped_status = {
        "ok": "succeeded",
        "failed": (
            "failed_terminal" if failure_class == "terminal" else "failed_retryable"
        ),
        "planned": "pending",
        "skipped_empty": "skipped_not_applicable",
        "skipped_not_applicable": "skipped_not_applicable",
        "blocked_dependency": "blocked_dependency",
    }.get(status, status)
    started = start_target_attempt(
        conn,
        integrity_run_id=integrity_run_id,
        env_name=env_name,
        target=target,
        candidate_identity_sha256=candidate_identity_sha256,
        candidate_count=candidate_count,
        candidate_observed_at_min=candidate_observed_at_min,
        candidate_observed_at_max=candidate_observed_at_max,
        final_verification_identity_sha256=final_verification_identity_sha256,
    )
    return finish_target_attempt(
        conn,
        attempt_id=int(started["attempt_id"]),
        status=mapped_status,
        outcome_counts=outcome_counts,
        error=error,
    )
