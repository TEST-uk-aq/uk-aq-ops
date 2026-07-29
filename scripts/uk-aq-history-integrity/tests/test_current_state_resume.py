#!/usr/bin/env python3
"""Focused deterministic checks for current-state audit and target-only resume."""

from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_integrity_resume_test", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CurrentStateResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.conn = MODULE.open_db(str(Path(self.temp.name) / "state.sqlite"))
        cursor = self.conn.execute(
            """INSERT INTO integrity_runs (
                 started_at_utc, env_name, profile, source_filter, from_day,
                 to_day, status, r2_history_status
               ) VALUES ('2026-07-24T00:00:00Z', 'CIC-Test', 'manual', 'sos',
                         '2026-07-24', '2026-07-24', 'fail', 'ok')"""
        )
        self.run_id = int(cursor.lastrowid)
        self.conn.execute(
            """INSERT INTO integrity_object_operations (
                 run_id, object_key, domain, operation_kind, planned,
                 remote_completed, get_verified, delete_verified, status,
                 updated_at_utc
               ) VALUES (?, ?, 'observations', 'put', 1, 1, 1, 0,
                         'get_verified', '2026-07-24T00:01:00Z')""",
            (
                self.run_id,
                "history/v2/observations/day_utc=2026-07-24/connector_id=1/"
                "pollutant_code=no2/part-00000.parquet",
            ),
        )
        self.verification = {"status": "ok", "remaining_gap_count": 0}
        self.candidate_sets = {
            "timeseries": [{
                "connector_id": 1,
                "timeseries_id": 10,
                "observed_at": "2026-07-24T12:00:00Z",
                "value": 1.0,
            }],
            "latest_snapshot": [{
                "connector_id": 1,
                "timeseries_id": 10,
                "observed_at": "2026-07-24T12:00:00Z",
                "value": 1.0,
                "value_float8_hex": "3ff0000000000000",
                "status": None,
                "pollutant_code": "no2",
            }],
        }
        self.identities = {
            target: MODULE.persist_candidate_set(
                self.conn,
                integrity_run_id=self.run_id,
                env_name="CIC-Test",
                target=target,
                candidates=candidates,
                final_verification=self.verification,
                selected_scope={
                    "scopes": [["2026-07-24", 1]],
                },
            )
            for target, candidates in self.candidate_sets.items()
        }
        self.verification_identity = MODULE.identity_sha256(self.verification)
        current = {
            "r2_history_status": "ok",
            "final_verification_identity_sha256": self.verification_identity,
            "timeseries_reconciliation_status": "ok",
            "latest_snapshot_reconciliation_status": "failed",
        }
        self.conn.execute(
            "UPDATE integrity_runs SET current_state_reconciliation_json=? WHERE id=?",
            (json.dumps(current), self.run_id),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()
        self.temp.cleanup()

    def _record(self, target: str, status: str, *, error: str | None = None) -> dict:
        evidence = MODULE.load_candidate_set(
            self.conn, integrity_run_id=self.run_id, target=target
        )
        return MODULE.record_target_attempt(
            self.conn,
            integrity_run_id=self.run_id,
            env_name="CIC-Test",
            target=target,
            invocation_kind="initial",
            status=status,
            candidate_identity_sha256=self.identities[target],
            candidate_count=len(self.candidate_sets[target]),
            candidate_observed_at_min=evidence["candidate_observed_at_min"],
            candidate_observed_at_max=evidence["candidate_observed_at_max"],
            final_verification_identity_sha256=self.verification_identity,
            outcome_counts={"candidate_count": len(self.candidate_sets[target])},
            error=error,
        )

    def _seed_24_july_pattern(self) -> None:
        self._record("timeseries", "ok")
        self._record(
            "latest_snapshot",
            "failed",
            error="expired credential",
        )

    def test_failed_default_selects_only_retryable_latest_snapshot(self) -> None:
        self._seed_24_july_pattern()
        prepared = MODULE.prepare_current_state_resume(
            self.conn,
            env_name="CIC-Test",
            run_id=self.run_id,
            requested_target="failed",
        )
        self.assertEqual(prepared["selected_targets"], ["latest_snapshot"])
        self.assertEqual(prepared["already_satisfied_targets"], ["timeseries"])
        self.assertEqual(
            prepared["previous_attempts"]["timeseries"]["status"],
            "succeeded",
        )

    def test_attempts_append_and_errors_are_bounded(self) -> None:
        first = self._record("latest_snapshot", "failed", error="x" * 800)
        second = self._record("latest_snapshot", "failed", error="second")
        self.assertEqual(first["attempt_number"], 1)
        self.assertEqual(second["attempt_number"], 2)
        rows = self.conn.execute(
            """SELECT attempt_number, status, retryable, LENGTH(bounded_error)
               FROM current_state_target_attempts
               WHERE integrity_run_id=? AND target='latest_snapshot'
               ORDER BY attempt_number""",
            (self.run_id,),
        ).fetchall()
        self.assertEqual([row[0] for row in rows], [1, 2])
        self.assertTrue(all(row[1] == "failed_retryable" for row in rows))
        self.assertTrue(all(row[2] == 1 for row in rows))
        self.assertLessEqual(rows[0][3], 500)

    def test_additive_schema_contains_recovery_evidence_columns(self) -> None:
        candidate_columns = {
            row[1] for row in self.conn.execute(
                "PRAGMA table_info(current_state_candidate_sets)"
            )
        }
        attempt_columns = {
            row[1] for row in self.conn.execute(
                "PRAGMA table_info(current_state_target_attempts)"
            )
        }
        self.assertTrue({
            "env_name",
            "candidate_observed_at_min",
            "candidate_observed_at_max",
            "final_verification_json",
            "selected_scope_identity_sha256",
            "superseded_by_run_id",
        }.issubset(candidate_columns))
        self.assertTrue({
            "retryable",
            "candidate_observed_at_min",
            "candidate_observed_at_max",
            "final_verification_identity_sha256",
            "superseded_by_attempt_id",
        }.issubset(attempt_columns))

    def test_timeseries_success_survives_retryable_latest_snapshot_failure(self) -> None:
        candidate_evidence = {
            target: MODULE.load_candidate_set(
                self.conn, integrity_run_id=self.run_id, target=target
            )
            for target in ("timeseries", "latest_snapshot")
        }
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
                scope_entries=(),
                dry_run=False,
                final_verification={"status": "ok"},
                log=logging.getLogger("independent-current-state-target-test"),
                candidate_sets=candidate_evidence,
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

    def test_selection_modes_never_repeat_successful_target(self) -> None:
        self._seed_24_july_pattern()
        for requested in ("failed", "latest_snapshot", "all"):
            with self.subTest(requested=requested):
                prepared = MODULE.prepare_current_state_resume(
                    self.conn,
                    env_name="CIC-Test",
                    run_id=self.run_id,
                    requested_target=requested,
                )
                self.assertEqual(prepared["selected_targets"], ["latest_snapshot"])
        timeseries = MODULE.prepare_current_state_resume(
            self.conn,
            env_name="CIC-Test",
            run_id=self.run_id,
            requested_target="timeseries",
        )
        self.assertEqual(timeseries["selected_targets"], [])
        self.assertEqual(timeseries["already_satisfied_targets"], ["timeseries"])

    def test_changed_final_verification_identity_blocks_before_target(self) -> None:
        self._seed_24_july_pattern()
        self.conn.execute(
            """UPDATE current_state_candidate_sets
               SET final_verification_json='{"status":"failed"}'
               WHERE integrity_run_id=? AND target='latest_snapshot'""",
            (self.run_id,),
        )
        self.conn.commit()
        with self.assertRaisesRegex(RuntimeError, "verification evidence identity"):
            MODULE.prepare_current_state_resume(
                self.conn,
                env_name="CIC-Test",
                run_id=self.run_id,
                requested_target="latest_snapshot",
            )

    def test_latest_snapshot_resume_skips_source_r2_aqi_and_timeseries(self) -> None:
        self._seed_24_july_pattern()
        response = {
            "ok": True,
            "candidate_count": 1,
            "eligible_count": 1,
            "applied_new_count": 0,
            "applied_newer_count": 0,
            "applied_same_timestamp_correction_count": 1,
            "skipped_equal_count": 0,
            "skipped_older_count": 0,
            "skipped_invalid_current_value_count": 0,
            "skipped_unsupported_pollutant_count": 0,
            "skipped_metadata_unresolved_count": 0,
            "changed_product_count": 1,
            "skipped_unchanged_product_count": 2,
            "product_success_count": 3,
            "product_failure_count": 0,
            "state_changed": True,
        }
        env = {
            "UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED": "true",
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL": (
                "https://snapshot.example.test/internal/integrity-reconcile"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE": (
                "https://snapshot.example.test"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS": "30",
        }
        with mock.patch.object(
            MODULE, "_post_cloud_run_reconciliation", return_value=response
        ) as snapshot_call, mock.patch.object(
            MODULE, "_http_post_json"
        ) as timeseries_call, mock.patch.object(
            MODULE, "run_v2_gap_backfills"
        ) as source_or_repair, mock.patch.object(
            MODULE, "run_aqi_rebuild_queue_execution"
        ) as aqi, mock.patch.object(
            MODULE, "run_canonical_apply_executor"
        ) as canonical_apply:
            result = MODULE.run_current_state_resume(
                conn=self.conn,
                env_name="CIC-Test",
                run_id_text=str(self.run_id),
                requested_target="failed",
                env=env,
                log=logging.getLogger("current-state-resume-test"),
            )
        snapshot_call.assert_called_once()
        timeseries_call.assert_not_called()
        source_or_repair.assert_not_called()
        aqi.assert_not_called()
        canonical_apply.assert_not_called()
        self.assertEqual(result["overall_status"], "ok")
        self.assertEqual(result["resume_operation_status"], "ok")
        self.assertEqual(result["target_audit_statuses"]["timeseries"], "succeeded")
        self.assertEqual(
            result["target_audit_statuses"]["latest_snapshot"], "succeeded"
        )
        self.assertFalse(result["resume"]["repeated_source_or_r2_stages"])

        with mock.patch.object(MODULE, "_post_cloud_run_reconciliation") as repeat:
            repeated = MODULE.run_current_state_resume(
                conn=self.conn,
                env_name="CIC-Test",
                run_id_text=str(self.run_id),
                requested_target="latest_snapshot",
                env=env,
                log=logging.getLogger("current-state-resume-repeat-test"),
            )
        repeat.assert_not_called()
        self.assertEqual(repeated["resume_operation_status"], "ok")
        self.assertEqual(repeated["resume"]["selected_targets"], [])


if __name__ == "__main__":
    unittest.main()
