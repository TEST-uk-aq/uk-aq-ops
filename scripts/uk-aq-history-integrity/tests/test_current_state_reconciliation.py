#!/usr/bin/env python3
"""Focused checks for normal current-state reconciliation and reporting."""

from __future__ import annotations

from contextlib import redirect_stderr
import importlib.util
from io import StringIO
import json
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_integrity_current_state_test", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CurrentStateReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.conn = MODULE.open_db(str(Path(self.temp.name) / "state.sqlite"))
        cursor = self.conn.execute(
            """INSERT INTO integrity_runs (
                 started_at_utc, env_name, profile, source_filter, from_day,
                 to_day, status, r2_history_status
               ) VALUES ('2026-07-29T00:00:00Z', 'CIC-Test', 'manual', 'sos',
                         '2026-07-29', '2026-07-29', 'fail', 'ok')"""
        )
        self.run_id = int(cursor.lastrowid)
        canonical_rows = [{
            "connector_id": 1,
            "timeseries_id": 10,
            "observed_at": "2026-07-29T12:00:00Z",
            "value": 1.0,
            "pollutant_code": "no2",
        }]
        canonical_rows_json = json.dumps(
            canonical_rows, sort_keys=True, separators=(",", ":")
        )
        evidence_identity = MODULE.identity_sha256(["2026-07-29", 1])
        self.conn.execute(
            """INSERT INTO source_connector_day_evidence (
                 env_name, day_utc, connector_id, source_adapter,
                 source_file_identities_sha256, source_evidence_input_sha256,
                 canonical_rows_sha256, canonical_rows_bytes, evidence_sha256,
                 evidence_json, canonical_rows_json, created_at_utc
               ) VALUES ('CIC-Test', '2026-07-29', 1, 'sos', ?, ?, ?, ?, ?,
                         '{}', ?, '2026-07-29T00:01:00Z')""",
            (
                evidence_identity,
                evidence_identity,
                MODULE.identity_sha256(canonical_rows),
                len(canonical_rows_json.encode("utf-8")),
                evidence_identity,
                canonical_rows_json,
            ),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        self.temp.cleanup()

    def test_resume_cli_options_are_absent(self) -> None:
        for option, value in (
            ("--resume-current-state-run-id", "229"),
            ("--resume-current-state-target", "failed"),
        ):
            with self.subTest(option=option), redirect_stderr(StringIO()) as stderr:
                with self.assertRaises(SystemExit) as raised:
                    MODULE.parse_args(["--env", "CIC-Test", option, value])
            self.assertEqual(raised.exception.code, 2)
            self.assertIn("unrecognized arguments", stderr.getvalue())

    def test_normal_targets_are_independent_and_keep_audit_identities(self) -> None:
        timeseries_response = [{
            "candidate_count": 1,
            "updated_newer_count": 1,
            "updated_same_timestamp_correction_count": 0,
            "skipped_equal_count": 0,
            "skipped_older_count": 0,
            "missing_timeseries_count": 0,
            "failed_count": 0,
        }]
        env = {
            "UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED": "true",
            "SUPABASE_URL": "https://ingest.example.test",
            "SB_SECRET_KEY": "test-key",
            "UK_AQ_INTEGRITY_TIMESERIES_RECONCILIATION_RPC": "test_rpc",
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL": (
                "https://snapshot.example.test/internal/integrity-reconcile"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE": (
                "https://snapshot.example.test"
            ),
        }
        with mock.patch.object(
            MODULE, "_http_post_json", return_value=timeseries_response
        ), mock.patch.object(
            MODULE,
            "_post_cloud_run_reconciliation",
            side_effect=RuntimeError("expired credential"),
        ):
            result = MODULE.run_current_state_reconciliation(
                conn=self.conn,
                env_name="CIC-Test",
                integrity_run_id=f"CIC-Test:{self.run_id}",
                env=env,
                scope_entries=[{"day_utc": "2026-07-29", "connector_id": 1}],
                dry_run=False,
                final_verification={"status": "ok", "remaining_gap_count": 0},
                log=logging.getLogger("normal-current-state-test"),
            )

        self.assertEqual(result["r2_history_status"], "ok")
        self.assertEqual(result["timeseries_reconciliation_status"], "ok")
        self.assertEqual(result["latest_snapshot_reconciliation_status"], "failed")
        self.assertEqual(result["overall_status"], "failed")
        self.assertEqual(result["target_audit_statuses"]["timeseries"], "succeeded")
        self.assertEqual(
            result["target_audit_statuses"]["latest_snapshot"],
            "failed_retryable",
        )
        self.assertIn(
            "Latest Snapshot reconciliation failed: expired credential",
            result["failures"],
        )
        candidate_rows = self.conn.execute(
            """SELECT target, candidate_identity_sha256, candidate_count
               FROM current_state_candidate_sets
               WHERE integrity_run_id=? ORDER BY target""",
            (self.run_id,),
        ).fetchall()
        self.assertEqual(
            [(row[0], row[2]) for row in candidate_rows],
            [("latest_snapshot", 1), ("timeseries", 1)],
        )
        self.assertTrue(all(len(str(row[1])) == 64 for row in candidate_rows))
        attempts = self.conn.execute(
            """SELECT target, invocation_kind, status, bounded_error
               FROM current_state_target_attempts
               WHERE integrity_run_id=? ORDER BY target""",
            (self.run_id,),
        ).fetchall()
        self.assertEqual(
            [(row[0], row[1], row[2]) for row in attempts],
            [
                ("latest_snapshot", "initial", "failed_retryable"),
                ("timeseries", "initial", "succeeded"),
            ],
        )
        self.assertEqual(attempts[0][3], "expired credential")

        markdown = MODULE.format_summary_md({
            "env": "CIC-Test",
            "profile": "manual",
            "source": "sos",
            "started_at_utc": "2026-07-29T00:00:00Z",
            "status": "fail",
            "dry_run": False,
            "check_only": False,
            "run_backfill": True,
            "db_path": str(Path(self.temp.name) / "state.sqlite"),
            "log_path": str(Path(self.temp.name) / "integrity.log"),
            "current_state_reconciliation": result,
            "metrics": {},
        })
        self.assertIn("Timeseries status: ok", markdown)
        self.assertIn("Latest Snapshot status: failed", markdown)
        self.assertIn("expired credential", markdown)
        self.assertIn("start a new appropriately scoped Integrity run", markdown)


if __name__ == "__main__":
    unittest.main()
