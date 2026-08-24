#!/usr/bin/env python3
"""Focused checks for normal current-state reconciliation and reporting."""

from __future__ import annotations

from contextlib import redirect_stderr
import hashlib
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
               ) VALUES ('2026-07-29T00:00:00Z', 'TEST', 'manual', 'sos',
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
               ) VALUES ('TEST', '2026-07-29', 1, 'sos', ?, ?, ?, ?, ?,
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

    def _dedicated_partition_entry(
        self,
        *,
        day_utc: str,
        pollutant_code: str,
        rows: list[dict[str, object]],
        status: str = "ok",
    ) -> dict[str, object]:
        identity = (
            f"day_utc={day_utc}/connector_id=1/"
            f"pollutant_code={pollutant_code}"
        )
        directory = Path(self.temp.name) / identity
        directory.mkdir(parents=True, exist_ok=True)
        rows_bytes = json.dumps(
            rows, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        evidence = {
            "enumeration_complete": True,
            "day_utc": day_utc,
            "connector_id": 1,
            "requested_pollutant_set": [pollutant_code],
            "canonical_rows_sha256": hashlib.sha256(rows_bytes).hexdigest(),
            "canonical_rows_bytes": len(rows_bytes),
            "total_rows": len(rows),
            "blocked_row_count": 0,
        }
        evidence_bytes = json.dumps(
            evidence, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        evidence_path = directory / "source-evidence.json"
        rows_path = directory / "obs_history_rows.json"
        evidence_path.write_bytes(evidence_bytes)
        rows_path.write_bytes(rows_bytes)
        return {
            "day_utc": day_utc,
            "connector_id": 1,
            "pollutant_code": pollutant_code,
            "status": status,
            "partition_source_evidence": {
                "identity": identity,
                "day_utc": day_utc,
                "connector_id": 1,
                "pollutant_code": pollutant_code,
                "evidence_path": str(evidence_path),
                "evidence_sha256": hashlib.sha256(evidence_bytes).hexdigest(),
                "rows_path": str(rows_path),
                "rows_sha256": hashlib.sha256(rows_bytes).hexdigest(),
            },
        }

    def _dedicated_multi_pollutant_entries(self) -> list[dict[str, object]]:
        def row(
            timeseries_id: int, pollutant_code: str, observed_at: str, value: float,
        ) -> dict[str, object]:
            return {
                "timeseries_id": timeseries_id,
                "station_id": timeseries_id + 1000,
                "pollutant_code": pollutant_code,
                "observed_at": observed_at,
                "value": value,
                "verification_status": "Verified",
            }

        entries = [
            self._dedicated_partition_entry(
                day_utc="2026-06-01", pollutant_code="no2",
                rows=[row(101, "no2", "2026-06-01T10:00:00Z", 10.0)],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-01", pollutant_code="o3",
                rows=[row(301, "o3", "2026-06-01T10:00:00Z", 30.0)],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-01", pollutant_code="pm10",
                rows=[row(201, "pm10", "2026-06-01T10:00:00Z", 20.0)],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-01", pollutant_code="pm25",
                rows=[
                    row(401, "pm25", "2026-06-01T10:00:00Z", 5.0),
                    row(402, "pm25", "2026-06-01T09:00:00Z", 4.0),
                ],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-02", pollutant_code="no2",
                rows=[row(101, "no2", "2026-06-02T11:00:00Z", 11.0)],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-02", pollutant_code="o3",
                rows=[row(301, "o3", "2026-06-02T11:00:00Z", 31.0)],
            ),
            self._dedicated_partition_entry(
                day_utc="2026-06-02", pollutant_code="pm10", rows=[],
            ),
            # PM2.5 remains last. Timeseries 402's latest raw row is negative,
            # so Latest Snapshot must retain its earlier eligible row.
            self._dedicated_partition_entry(
                day_utc="2026-06-02", pollutant_code="pm25",
                rows=[
                    row(401, "pm25", "2026-06-02T11:00:00Z", 6.0),
                    row(402, "pm25", "2026-06-02T12:00:00Z", -1.0),
                ],
            ),
        ]
        entries.extend([
            {
                "day_utc": "2026-06-02",
                "connector_id": 1,
                "pollutant_code": "no2",
                "status": "skipped_all_unmapped",
                "outcome": "all_groups_excluded_no_authoritative_binding",
            },
            {
                "day_utc": "2026-06-02",
                "connector_id": 1,
                "pollutant_code": "pm10",
                "status": "guard_failed",
            },
        ])
        return entries

    def test_resume_cli_options_are_absent(self) -> None:
        for option, value in (
            ("--resume-current-state-run-id", "229"),
            ("--resume-current-state-target", "failed"),
        ):
            with self.subTest(option=option), redirect_stderr(StringIO()) as stderr:
                with self.assertRaises(SystemExit) as raised:
                    MODULE.parse_args(["--env", "TEST", option, value])
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
                env_name="TEST",
                integrity_run_id=f"TEST:{self.run_id}",
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
            "env": "TEST",
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

    def test_dedicated_candidates_union_verified_pollutants_and_compact(self) -> None:
        derived = MODULE._dedicated_sos_current_state_candidates(
            partition_entries=self._dedicated_multi_pollutant_entries(),
            env={},
        )

        self.assertEqual(len(derived["raw_candidates"]), 5)
        self.assertEqual(
            derived["timeseries_candidate_audit"]["candidates_by_pollutant"],
            {"no2": 1, "o3": 1, "pm10": 1, "pm25": 2},
        )
        self.assertEqual(len(derived["latest_snapshot_candidates"]), 4)
        self.assertEqual(
            derived["latest_snapshot_candidate_audit"][
                "candidates_by_pollutant"
            ],
            {"no2": 1, "pm10": 1, "pm25": 2},
        )
        self.assertEqual(
            derived["latest_snapshot_candidate_audit"][
                "ineligible_rows_excluded_by_reason"
            ],
            {"negative_value": 1},
        )
        self.assertEqual(
            derived["latest_snapshot_candidate_audit"][
                "latest_raw_ineligible_earlier_candidate_selected"
            ],
            1,
        )
        snapshot_402 = next(
            row for row in derived["latest_snapshot_candidates"]
            if row["timeseries_id"] == 402
        )
        raw_402 = next(
            row for row in derived["raw_candidates"]
            if row["timeseries_id"] == 402
        )
        self.assertEqual(snapshot_402["observed_at"], "2026-06-01T09:00:00.000Z")
        self.assertEqual(snapshot_402["value"], 4.0)
        self.assertEqual(raw_402["observed_at"], "2026-06-02T12:00:00.000Z")
        self.assertEqual(raw_402["value"], -1.0)
        evidence_audit = derived["evidence_audit"]
        self.assertEqual(evidence_audit["verified_partition_evidence_count"], 8)
        self.assertEqual(
            evidence_audit["verified_partitions_by_pollutant"],
            {"no2": 2, "o3": 2, "pm10": 2, "pm25": 2},
        )
        self.assertEqual(evidence_audit["authoritative_no_data_partitions"], 1)
        self.assertEqual(evidence_audit["skipped_all_unmapped_partitions"], 1)
        self.assertEqual(evidence_audit["skipped_failed_or_unverified_partitions"], 1)

    def test_dedicated_targets_submit_independently_without_state_gates(self) -> None:
        entries = self._dedicated_multi_pollutant_entries()
        submitted: dict[str, list[dict[str, object]]] = {}

        def timeseries_rpc(**kwargs):
            candidates = list(kwargs["body"]["p_candidates"])
            submitted["timeseries"] = candidates
            return [{
                "candidate_count": len(candidates),
                "updated_newer_count": 0,
                "updated_same_timestamp_correction_count": 1,
                "skipped_equal_count": 0,
                # The owner reports the other candidates older than its state;
                # submission still occurred and cannot gate Latest Snapshot.
                "skipped_older_count": len(candidates) - 1,
                "missing_timeseries_count": 0,
                "failed_count": 0,
            }]

        def latest_owner(**kwargs):
            candidates = list(kwargs["body"]["candidates"])
            submitted["latest_snapshot"] = candidates
            return {
                "ok": True,
                "candidate_count": len(candidates),
                "eligible_count": len(candidates),
                "applied_new_count": 0,
                "applied_newer_count": 0,
                "applied_same_timestamp_correction_count": 1,
                "skipped_equal_count": 0,
                "skipped_older_count": len(candidates) - 1,
                "skipped_invalid_current_value_count": 0,
                "skipped_unsupported_pollutant_count": 0,
                "skipped_metadata_unresolved_count": 0,
                "changed_product_count": 0,
                "skipped_unchanged_product_count": 3,
                "product_success_count": 3,
                "product_failure_count": 0,
                "state_changed": True,
                "manifest_key": "latest_snapshots/v2/manifest.json",
            }

        env = {
            "UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED": "true",
            "SUPABASE_URL": "https://ingest.example.test",
            "SB_SECRET_KEY": "test-key",
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL": (
                "https://snapshot.example.test/internal/integrity-reconcile"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE": (
                "https://snapshot.example.test"
            ),
        }
        with mock.patch.object(
            MODULE, "_http_post_json", side_effect=timeseries_rpc
        ), mock.patch.object(
            MODULE, "_post_cloud_run_reconciliation", side_effect=latest_owner
        ):
            result = MODULE.run_current_state_reconciliation(
                conn=self.conn,
                env_name="TEST",
                integrity_run_id=f"TEST:{self.run_id}",
                env=env,
                scope_entries=[],
                dedicated_partition_entries=entries,
                dry_run=False,
                final_verification={"status": "ok", "remaining_gap_count": 0},
                log=logging.getLogger("dedicated-current-state-test"),
            )

        self.assertEqual(result["candidate_count"], 5)
        self.assertEqual(result["latest_snapshot_candidate_count"], 4)
        self.assertEqual(len(submitted["timeseries"]), 5)
        self.assertEqual(len(submitted["latest_snapshot"]), 4)
        self.assertNotIn(
            301,
            {int(row["timeseries_id"]) for row in submitted["latest_snapshot"]},
        )
        self.assertEqual(result["timeseries_reconciliation_status"], "ok")
        self.assertEqual(result["latest_snapshot_reconciliation_status"], "ok")
        self.assertEqual(result["overall_status"], "ok")
        self.assertEqual(
            result["timeseries"]["updated_same_timestamp_correction_count"], 1
        )
        self.assertEqual(
            result["latest_snapshot"][
                "applied_same_timestamp_correction_count"
            ],
            1,
        )
        self.assertEqual(
            result["timeseries_candidate_audit"]["rpc_submitted_count"], 5
        )
        self.assertEqual(
            result["latest_snapshot_candidate_audit"][
                "owner_service_submitted_count"
            ],
            4,
        )


if __name__ == "__main__":
    unittest.main()
