#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_backup_gate", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DummyResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class BackupGateAndRepairPlanTests(unittest.TestCase):
    def _finished_payload(self, *, finished_at: str = "2026-07-11T02:00:00Z") -> dict:
        return {
            "backup_ready": True,
            "blocked_reason": None,
            "backup_completed_at": finished_at,
            "tasks": [
                {
                    "task_key": "ops.r2_history_dropbox_backup",
                    "status": "Finished",
                    "finished_at": finished_at,
                },
            ],
        }

    def test_backup_gate_passes_when_required_tasks_succeeded(self) -> None:
        payload = self._finished_payload()
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertTrue(result["backup_ready"])
        self.assertEqual(result["backup_completed_at"], "2026-07-11T02:00:00Z")

    def test_backup_gate_rpc_request_contract(self) -> None:
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return DummyResponse(self._finished_payload())

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co/",
                service_role_key="secret-token",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )

        request = captured["request"]
        headers = {key.lower(): value for key, value in request.header_items()}
        body = json.loads(request.data.decode("utf-8"))
        self.assertTrue(result["backup_ready"])
        self.assertEqual(
            request.full_url,
            "https://example.supabase.co/rest/v1/rpc/uk_aq_rpc_daily_task_backup_readiness",
        )
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            body,
            {
                "p_scheduled_for_date": "2026-07-11",
                "p_integrity_started_at_utc": "2026-07-11T03:00:00Z",
                "p_task_keys": ["ops.r2_history_dropbox_backup"],
            },
        )
        self.assertEqual(headers["accept-profile"], "uk_aq_public")
        self.assertEqual(headers["content-profile"], "uk_aq_public")
        self.assertEqual(headers["apikey"], "secret-token")
        self.assertEqual(headers["authorization"], "Bearer secret-token")

    def test_backup_gate_resolves_obs_aqidb_credentials(self) -> None:
        url, key = MODULE.resolve_backup_gate_credentials(
            {
                "OBS_AQIDB_SUPABASE_URL": "https://obs.example/",
                "OBS_AQIDB_SECRET_KEY": "obs-secret",
                "SUPABASE_URL": "https://ingest.example",
                "SUPABASE_SERVICE_ROLE_KEY": "ingest-secret",
            }
        )
        self.assertEqual(url, "https://obs.example")
        self.assertEqual(key, "obs-secret")

    def test_backfill_env_is_loaded_before_backup_credential_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / "backfill.env"
            env_path.write_text(
                'OBS_AQIDB_SUPABASE_URL="https://obs-from-file.example"\n'
                'OBS_AQIDB_SECRET_KEY="file-secret"\n',
                encoding="utf-8",
            )
            required = {name: f"value-{name}" for name in MODULE.REQUIRED_ENV_VARS}
            required["UK_AQ_BACKFILL_ENV_FILE"] = str(env_path)
            with mock.patch.dict(MODULE.os.environ, required, clear=True):
                MODULE.load_env_or_die()
                url, key = MODULE.resolve_backup_gate_credentials()
        self.assertEqual(url, "https://obs-from-file.example")
        self.assertEqual(key, "file-secret")

    def test_backfill_obs_credentials_override_existing_obs_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / "backfill.env"
            env_path.write_text(
                'OBS_AQIDB_SUPABASE_URL="https://authoritative-obs.example"\n'
                'OBS_AQIDB_SECRET_KEY="authoritative-secret"\n',
                encoding="utf-8",
            )
            url, key = MODULE.resolve_backup_gate_credentials(
                {
                    "UK_AQ_BACKFILL_ENV_FILE": str(env_path),
                    "OBS_AQIDB_SUPABASE_URL": "https://stale-process.example",
                    "OBS_AQIDB_SECRET_KEY": "stale-secret",
                }
            )
        self.assertEqual(url, "https://authoritative-obs.example")
        self.assertEqual(key, "authoritative-secret")

    def test_missing_credentials_block_without_http_request(self) -> None:
        with mock.patch("urllib.request.urlopen") as urlopen:
            result = MODULE.check_dropbox_backup_ready(
                supabase_url=None,
                service_role_key=None,
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "supabase_credentials_unavailable")
        urlopen.assert_not_called()

    def test_empty_task_keys_block_without_http_request(self) -> None:
        with mock.patch("urllib.request.urlopen") as urlopen:
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=[],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "no_required_backup_task_keys_configured")
        urlopen.assert_not_called()

    def test_rpc_http_failure_blocks_safely(self) -> None:
        with mock.patch("urllib.request.urlopen", side_effect=OSError("unavailable")):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertTrue(result["blocked_reason"].startswith("daily_task_health_query_failed:"))

    def test_unexpected_rpc_response_shape_blocks_safely(self) -> None:
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse({"backup_ready": True})):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "daily_task_health_query_returned_unexpected_shape")

    def test_latest_unsuccessful_task_blocks(self) -> None:
        payload = self._finished_payload()
        payload["backup_ready"] = False
        payload["blocked_reason"] = "latest_task_not_finished"
        payload["tasks"][0]["status"] = "Failed"
        payload["tasks"][0]["blocked_reason"] = "latest_task_not_finished"
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "latest_task_not_finished")

    def test_task_finished_after_integrity_start_blocks(self) -> None:
        payload = self._finished_payload(finished_at="2026-07-11T04:00:00Z")
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "task_finished_after_integrity_start")

    def test_readiness_sql_matches_real_daily_task_contract_and_canonical_copy(self) -> None:
        ops_sql_path = MODULE_PATH.parents[1] / "sql" / "uk_aq_rpc_daily_task_backup_readiness.sql"
        schema_sql_path = (
            MODULE_PATH.parents[4]
            / "TEST-uk-aq-schema"
            / "schemas"
            / "obs_aqi_db"
            / "uk_aq_rpc_daily_task_backup_readiness.sql"
        )
        ops_sql = ops_sql_path.read_text(encoding="utf-8")
        schema_sql = schema_sql_path.read_text(encoding="utf-8")
        self.assertEqual(ops_sql, schema_sql)
        self.assertIn("v_latest.status <> 'Finished'", ops_sql)
        self.assertIn("v_latest.finished_at", ops_sql)
        self.assertIn("ORDER BY r.attempt DESC, r.updated_at DESC", ops_sql)
        self.assertIn("SET search_path = pg_catalog, uk_aq_public", ops_sql)
        self.assertNotIn("v_latest.started_at_utc", ops_sql)
        self.assertNotIn("v_latest.completed_at_utc", ops_sql)
        self.assertNotIn("status <> 'succeeded'", ops_sql)

    def test_backup_gate_blocks_before_scan_when_backup_not_ready(self) -> None:
        payload = {"backup_ready": False, "blocked_reason": "task_not_succeeded", "tasks": []}
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["ops.r2_history_dropbox_backup"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "task_not_succeeded")

    def test_manual_stale_backup_override_proceeds_and_is_recorded(self) -> None:
        result = MODULE.check_dropbox_backup_ready(
            supabase_url=None,
            service_role_key=None,
            task_keys=["ops.r2_history_dropbox_backup"],
            scheduled_for_date="2026-07-11",
            integrity_started_at_utc="2026-07-11T03:00:00Z",
            allow_stale_dropbox=True,
        )
        self.assertTrue(result["backup_ready"])
        self.assertTrue(result["allow_stale_dropbox"])
        self.assertEqual(result["blocked_reason"], "allow_stale_dropbox_override")

    def test_scheduled_main_stops_before_dropbox_preflight_when_gate_blocks(self) -> None:
        args = SimpleNamespace(
            env="CIC-Test",
            profile="daily",
            source="all",
            from_day=None,
            to_day=None,
            history_version="v2",
            verbose=False,
            dry_run=False,
            check_only=True,
            run_backfill=False,
            allow_stale_dropbox=False,
        )
        env = {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": "/tmp/logs",
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": "/tmp/reports",
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": "/tmp/integrity.sqlite3",
        }
        blocked = {
            "backup_gate_checked": True,
            "backup_ready": False,
            "allow_stale_dropbox": False,
            "blocked_reason": "latest_task_not_finished",
        }
        with (
            mock.patch.object(MODULE, "parse_args", return_value=args),
            mock.patch.object(MODULE, "load_env_or_die", return_value=env),
            mock.patch.object(MODULE, "resolve_history_version_mode", return_value="v2"),
            mock.patch.object(MODULE, "expand_history_versions", return_value=("v2",)),
            mock.patch.object(MODULE, "resolve_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "serialize_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "setup_logging", return_value=Path("/tmp/test.log")),
            mock.patch.object(MODULE, "_resolve_daily_task_health_config", return_value={"enabled": False, "strict": False}),
            mock.patch.object(MODULE, "run_scheduled_backup_gate", return_value=blocked),
            mock.patch.object(MODULE, "run_preflight_or_die") as preflight,
            mock.patch.object(MODULE, "write_reports") as write_reports,
        ):
            exit_code = MODULE.main([])
        self.assertEqual(exit_code, 2)
        preflight.assert_not_called()
        write_reports.assert_called_once()

    def test_repair_plan_queues_aqi_only_for_aqi_enabled_pollutants(self) -> None:
        plan = MODULE.build_v2_repair_plan(observation_gaps=[
            {"gap_type": "source_r2_timeseries_row_mismatch", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "pm10", "source_evidence": {"source_partition_state": "successful_non_empty"}},
            {"gap_type": "source_r2_timeseries_row_mismatch", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "no2", "source_evidence": {"source_partition_state": "successful_non_empty"}},
            {"gap_type": "source_r2_timeseries_row_mismatch", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3", "source_evidence": {"source_partition_state": "successful_non_empty"}},
        ])
        aqi = [a for a in plan if a["kind"] == "aqi_rebuild"]
        self.assertEqual({a["pollutant_code"] for a in aqi}, {"pm10", "no2"})
        self.assertTrue(all(a["status"] == "planned" for a in aqi))
        self.assertTrue(all(a["executes"] is False for a in aqi))
        self.assertTrue(all(a["data_changes_required"] is True for a in aqi))
        self.assertFalse(any(a["pollutant_code"] == "o3" for a in aqi))

    def test_manifest_only_repair_does_not_queue_unnecessary_aqi_rebuild(self) -> None:
        plan = MODULE.build_v2_repair_plan(observation_gaps=[
            {"gap_type": "connector_manifest_missing_pollutant_child", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"},
        ])
        self.assertFalse(any(a["kind"] == "aqi_rebuild" for a in plan))
        self.assertTrue(any(a["kind"] == "observation_connector_manifest_repair" for a in plan))

    def test_check_only_plan_shape_makes_no_writes_by_construction(self) -> None:
        plan = MODULE.build_v2_repair_plan(observation_gaps=[
            {"gap_type": "connector_manifest_missing_pollutant_child", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"},
            {"gap_type": "index_manifest_missing", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"},
        ])
        self.assertEqual([a["kind"] for a in plan], ["observation_index_repair", "observation_connector_manifest_repair"])

    def test_source_unavailable_gap_routes_to_operator_review(self) -> None:
        gaps = [
            {
                "gap_type": "data_manifest_missing",
                "day_utc": "2026-05-17",
                "connector_id": 1,
                "pollutant_code": "o3",
                "source_evidence": {"source_partition_state": "counts_unavailable"},
            },
            {
                "gap_type": "data_manifest_file_count_mismatch",
                "day_utc": "2026-05-17",
                "connector_id": 1,
                "pollutant_code": "o3",
                "parquet_readable": True,
                "source_evidence": {"source_partition_state": "successful_non_empty"},
            },
        ]
        MODULE._classify_v2_gaps(gaps)
        plan = MODULE.build_v2_repair_plan(observation_gaps=gaps)
        self.assertEqual([a["kind"] for a in plan], ["source_mapping_issue"])
        self.assertTrue(all(a["status"] == "planned" for a in plan))
        self.assertTrue(all(a["executes"] is False for a in plan))
        self.assertFalse(any(a["kind"] == "observation_pollutant_manifest_repair" for a in plan))
        self.assertFalse(any(a["kind"] == "aqi_rebuild" for a in plan))

    def test_manifest_only_gap_remains_manifest_only_for_o3(self) -> None:
        gap = MODULE._v2_obs_gap(
            "data_manifest_missing",
            day_utc="2026-05-17",
            connector_id=1,
            pollutant_code="o3",
            expected_path="manifest.json",
        )
        gap["parquet_readable"] = True
        gap["source_evidence"] = {"source_partition_state": "successful_non_empty"}
        MODULE._classify_v2_gaps([gap])
        plan = MODULE.build_v2_repair_plan(observation_gaps=[gap])
        self.assertTrue(any(a["kind"] == "observation_pollutant_manifest_repair" for a in plan))
        self.assertFalse(any(a["kind"] == "aqi_rebuild" for a in plan))
        self.assertFalse(any(a["kind"] == "source_mapping_issue" for a in plan))
        self.assertTrue(all(a["status"] == "planned" for a in plan))
        self.assertTrue(all(a["executes"] is False for a in plan))

    def test_manifest_only_repair_precedes_index_only_for_same_partition(self) -> None:
        gaps = [
            MODULE._v2_obs_gap(
                "data_manifest_file_count_mismatch",
                day_utc="2026-05-17",
                connector_id=1,
                pollutant_code="o3",
                expected_path="manifest.json",
            ),
            MODULE._v2_obs_gap(
                "index_manifest_missing",
                day_utc="2026-05-17",
                connector_id=1,
                pollutant_code="o3",
                expected_path="index.json",
            ),
        ]
        gaps[0]["parquet_readable"] = True
        gaps[0]["source_evidence"] = {"source_partition_state": "successful_non_empty"}
        MODULE._classify_v2_gaps(gaps)
        plan = MODULE.build_v2_repair_plan(observation_gaps=gaps)
        self.assertEqual([a["kind"] for a in plan], ["observation_pollutant_manifest_repair"])
        self.assertTrue(all(a["status"] == "planned" for a in plan))
        self.assertTrue(all(a["executes"] is False for a in plan))
        self.assertFalse(any(a["kind"] == "observation_index_repair" for a in plan))
        self.assertFalse(any(a["kind"] == "aqi_rebuild" for a in plan))

    def test_pm10_data_fault_keeps_aqi_rebuild_planned_non_executing(self) -> None:
        gaps = [
            {
                "gap_type": "source_r2_timeseries_row_mismatch",
                "day_utc": "2026-05-17",
                "connector_id": 1,
                "pollutant_code": "pm10",
                "source_evidence": {"source_partition_state": "successful_non_empty"},
            },
            {
                "gap_type": "data_manifest_file_count_mismatch",
                "day_utc": "2026-05-17",
                "connector_id": 1,
                "pollutant_code": "pm10",
                "parquet_readable": True,
                "source_evidence": {"source_partition_state": "successful_non_empty"},
            },
            {
                "gap_type": "data_manifest_missing",
                "day_utc": "2026-05-17",
                "connector_id": 1,
                "pollutant_code": "pm10",
                "source_evidence": {"source_partition_state": "counts_unavailable"},
            },
        ]
        MODULE._classify_v2_gaps(gaps)
        plan = MODULE.build_v2_repair_plan(observation_gaps=gaps)
        self.assertTrue(any(a["kind"] == "observation_data_repair" for a in plan))
        self.assertTrue(any(a["kind"] == "aqi_rebuild" for a in plan))
        self.assertFalse(any(a["kind"] == "observation_pollutant_manifest_repair" for a in plan))
        self.assertFalse(any(a["kind"] == "source_mapping_issue" for a in plan))
        self.assertTrue(all(a["status"] == "planned" for a in plan))
        self.assertTrue(all(a["executes"] is False for a in plan))
        self.assertTrue(all(a.get("data_changes_required") is True for a in plan if a["kind"] == "aqi_rebuild"))
        self.assertFalse(any(a["kind"] == "source_mapping_issue" for a in plan))

    def test_parent_connector_and_day_manifest_scopes_remain_separate(self) -> None:
        plan = MODULE.build_v2_repair_plan(observation_gaps=[
            {"gap_type": "connector_manifest_missing", "day_utc": "2026-05-17", "connector_id": 1},
            {"gap_type": "day_manifest_missing", "day_utc": "2026-05-17", "connector_id": 1},
        ])
        self.assertIn("observation_connector_manifest_repair", [a["kind"] for a in plan])
        self.assertIn("observation_day_manifest_repair", [a["kind"] for a in plan])
        self.assertTrue(all(a["status"] == "planned" for a in plan))
        self.assertTrue(all(a["executes"] is False for a in plan))


if __name__ == "__main__":
    unittest.main()
