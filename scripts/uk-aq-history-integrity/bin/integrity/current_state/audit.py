"""Durable, independently queryable current-state target audit."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from typing import Any, Iterable, Mapping

TARGETS = ("timeseries", "latest_snapshot")
RETRYABLE_STATUSES = frozenset({"failed", "pending", "blocked_dependency"})

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS current_state_candidate_sets (
  integrity_run_id INTEGER NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('timeseries', 'latest_snapshot')),
  candidate_identity_sha256 TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  final_verification_identity_sha256 TEXT NOT NULL,
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
  failure_class TEXT NOT NULL CHECK (failure_class IN ('none', 'retryable', 'terminal')),
  candidate_identity_sha256 TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  outcome_counts_json TEXT NOT NULL,
  bounded_error TEXT,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT NOT NULL,
  UNIQUE (integrity_run_id, target, attempt_number),
  FOREIGN KEY (integrity_run_id) REFERENCES integrity_runs(id),
  FOREIGN KEY (linked_attempt_id) REFERENCES current_state_target_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_current_state_target_attempts_run_target
  ON current_state_target_attempts(integrity_run_id, target, attempt_number DESC);
"""


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def identity_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def ensure_audit_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)


def persist_candidate_set(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
    candidates: Iterable[Mapping[str, Any]], final_verification: Mapping[str, Any],
) -> str:
    if target not in TARGETS:
        raise ValueError(f"unsupported current-state target: {target}")
    materialized = [dict(candidate) for candidate in candidates]
    candidate_identity = identity_sha256(materialized)
    verification_identity = identity_sha256(dict(final_verification))
    conn.execute(
        """INSERT INTO current_state_candidate_sets (
          integrity_run_id, target, candidate_identity_sha256, candidate_count,
          candidates_json, final_verification_identity_sha256, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(integrity_run_id, target) DO UPDATE SET
          candidate_identity_sha256=excluded.candidate_identity_sha256,
          candidate_count=excluded.candidate_count,
          candidates_json=excluded.candidates_json,
          final_verification_identity_sha256=excluded.final_verification_identity_sha256,
          created_at_utc=excluded.created_at_utc""",
        (int(integrity_run_id), target, candidate_identity, len(materialized),
         canonical_json(materialized), verification_identity, _utc_now()),
    )
    conn.commit()
    return candidate_identity


def load_candidate_set(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
) -> dict[str, Any]:
    row = conn.execute(
        """SELECT candidate_identity_sha256, candidate_count, candidates_json,
                  final_verification_identity_sha256
           FROM current_state_candidate_sets
           WHERE integrity_run_id=? AND target=?""",
        (int(integrity_run_id), target),
    ).fetchone()
    if row is None:
        raise RuntimeError("current-state candidate evidence is missing")
    candidates = json.loads(str(row[2]))
    if not isinstance(candidates, list) or identity_sha256(candidates) != str(row[0]):
        raise RuntimeError("current-state candidate evidence identity is invalid")
    if len(candidates) != int(row[1]):
        raise RuntimeError("current-state candidate evidence count is invalid")
    return {"candidate_identity_sha256": str(row[0]), "candidate_count": int(row[1]),
            "candidates": candidates, "final_verification_identity_sha256": str(row[3])}


def latest_target_attempt(
    conn: sqlite3.Connection, *, integrity_run_id: int, target: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """SELECT id, env_name, attempt_number, invocation_kind, status,
                  failure_class, candidate_identity_sha256, candidate_count,
                  outcome_counts_json, bounded_error, started_at_utc, finished_at_utc
           FROM current_state_target_attempts
           WHERE integrity_run_id=? AND target=?
           ORDER BY attempt_number DESC LIMIT 1""",
        (int(integrity_run_id), target),
    ).fetchone()
    if row is None:
        return None
    return {"id": int(row[0]), "env_name": str(row[1]), "attempt_number": int(row[2]),
            "invocation_kind": str(row[3]), "status": str(row[4]),
            "failure_class": str(row[5]), "candidate_identity_sha256": str(row[6]),
            "candidate_count": int(row[7]), "outcome_counts": json.loads(str(row[8])),
            "bounded_error": row[9], "started_at_utc": str(row[10]),
            "finished_at_utc": str(row[11])}


def record_target_attempt(
    conn: sqlite3.Connection, *, integrity_run_id: int, env_name: str,
    target: str, invocation_kind: str, status: str,
    candidate_identity_sha256: str, candidate_count: int,
    outcome_counts: Mapping[str, Any], error: str | None = None,
    failure_class: str | None = None,
) -> dict[str, Any]:
    previous = latest_target_attempt(conn, integrity_run_id=integrity_run_id, target=target)
    attempt_number = int(previous["attempt_number"] if previous else 0) + 1
    resolved_failure_class = failure_class or (
        "none" if status in {"ok", "planned", "skipped_empty"}
        else "retryable" if status in RETRYABLE_STATUSES else "terminal"
    )
    if resolved_failure_class not in {"none", "retryable", "terminal"}:
        raise ValueError("invalid current-state target failure class")
    bounded_error = " ".join(str(error or "").split())[:500] or None
    now = _utc_now()
    cursor = conn.execute(
        """INSERT INTO current_state_target_attempts (
          integrity_run_id, linked_attempt_id, env_name, target, attempt_number,
          invocation_kind, status, failure_class, candidate_identity_sha256,
          candidate_count, outcome_counts_json, bounded_error, started_at_utc,
          finished_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (int(integrity_run_id), previous["id"] if previous else None, env_name,
         target, attempt_number, invocation_kind, status, resolved_failure_class,
         candidate_identity_sha256, int(candidate_count),
         canonical_json(dict(outcome_counts)), bounded_error, now, now),
    )
    conn.commit()
    return {"attempt_id": int(cursor.lastrowid), "attempt_number": attempt_number,
            "status": status, "failure_class": resolved_failure_class}
