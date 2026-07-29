#!/usr/bin/env python3
"""Focused deterministic check for independent target audit and resume selection."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_integrity_resume_test", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CurrentStateResumeTests(unittest.TestCase):
    def test_failed_default_selects_only_failed_target_with_intact_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            conn = MODULE.open_db(str(Path(directory) / "state.sqlite"))
            cursor = conn.execute(
                """INSERT INTO integrity_runs (
                     started_at_utc, env_name, profile, status, r2_history_status
                   ) VALUES ('2026-07-24T00:00:00Z', 'CIC-Test', 'manual', 'fail', 'ok')"""
            )
            run_id = int(cursor.lastrowid)
            conn.execute(
                """INSERT INTO integrity_object_operations (
                     run_id, object_key, domain, operation_kind, planned,
                     remote_completed, get_verified, delete_verified, status,
                     updated_at_utc
                   ) VALUES (?, ?, 'observations', 'put', 1, 1, 1, 0,
                             'get_verified', '2026-07-24T00:01:00Z')""",
                (run_id, "history/v2/observations/data/day_utc=2026-07-24/connector_id=1/pollutant_code=no2/part-00000.parquet"),
            )
            verification = {"status": "ok", "remaining_gap_count": 0}
            candidate_sets = {
                "timeseries": [{"connector_id": 1, "timeseries_id": 10,
                                "observed_at": "2026-07-24T12:00:00Z", "value": 1.0}],
                "latest_snapshot": [{"connector_id": 1, "timeseries_id": 10,
                                     "observed_at": "2026-07-24T12:00:00Z", "value": 1.0,
                                     "value_float8_hex": "3ff0000000000000",
                                     "status": None, "pollutant_code": "no2"}],
            }
            identities = {
                target: MODULE.persist_candidate_set(
                    conn, integrity_run_id=run_id, target=target,
                    candidates=candidates, final_verification=verification,
                )
                for target, candidates in candidate_sets.items()
            }
            current = {
                "r2_history_status": "ok",
                "final_verification_identity_sha256": MODULE.identity_sha256(verification),
                "timeseries_reconciliation_status": "ok",
                "latest_snapshot_reconciliation_status": "failed",
            }
            conn.execute(
                "UPDATE integrity_runs SET current_state_reconciliation_json=? WHERE id=?",
                (json.dumps(current), run_id),
            )
            MODULE.record_target_attempt(
                conn, integrity_run_id=run_id, env_name="CIC-Test",
                target="timeseries", invocation_kind="initial", status="ok",
                candidate_identity_sha256=identities["timeseries"],
                candidate_count=1, outcome_counts={"candidate_count": 1},
            )
            MODULE.record_target_attempt(
                conn, integrity_run_id=run_id, env_name="CIC-Test",
                target="latest_snapshot", invocation_kind="initial", status="failed",
                candidate_identity_sha256=identities["latest_snapshot"],
                candidate_count=1, outcome_counts={}, error="expired credential",
            )
            prepared = MODULE.prepare_current_state_resume(
                conn, env_name="CIC-Test", run_id=run_id,
                requested_target="failed",
            )
            self.assertEqual(prepared["selected_targets"], ["latest_snapshot"])
            self.assertEqual(prepared["previous_attempts"]["timeseries"]["status"], "ok")
            self.assertEqual(
                prepared["candidate_sets"]["latest_snapshot"]["candidates"],
                candidate_sets["latest_snapshot"],
            )
            conn.close()


if __name__ == "__main__":
    unittest.main()
