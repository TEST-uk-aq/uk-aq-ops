#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
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
    def test_backup_gate_passes_when_required_tasks_succeeded(self) -> None:
        payload = {
            "backup_ready": True,
            "tasks": [
                {"task_key": "r2_backup_inventory", "status": "succeeded", "completed_at": "2026-07-11T01:00:00Z"},
                {"task_key": "r2_history_dropbox_sync", "status": "succeeded", "completed_at": "2026-07-11T02:00:00Z"},
            ],
        }
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["r2_backup_inventory", "r2_history_dropbox_sync"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertTrue(result["backup_ready"])
        self.assertEqual(result["backup_completed_at"], "2026-07-11T02:00:00Z")

    def test_backup_gate_blocks_before_scan_when_backup_not_ready(self) -> None:
        payload = {"backup_ready": False, "blocked_reason": "task_not_succeeded", "tasks": []}
        with mock.patch("urllib.request.urlopen", return_value=DummyResponse(payload)):
            result = MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                task_keys=["r2_backup_inventory"],
                scheduled_for_date="2026-07-11",
                integrity_started_at_utc="2026-07-11T03:00:00Z",
            )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "task_not_succeeded")

    def test_manual_stale_backup_override_proceeds_and_is_recorded(self) -> None:
        result = MODULE.check_dropbox_backup_ready(
            supabase_url=None,
            service_role_key=None,
            task_keys=["r2_history_dropbox_sync"],
            scheduled_for_date="2026-07-11",
            integrity_started_at_utc="2026-07-11T03:00:00Z",
            allow_stale_dropbox=True,
        )
        self.assertTrue(result["backup_ready"])
        self.assertTrue(result["allow_stale_dropbox"])
        self.assertEqual(result["blocked_reason"], "allow_stale_dropbox_override")

    def test_repair_plan_queues_aqi_only_for_aqi_enabled_pollutants(self) -> None:
        plan = MODULE.build_v2_repair_plan(observation_gaps=[
            {"gap_type": "source_r2_timeseries_row_mismatch", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "pm10"},
            {"gap_type": "source_r2_timeseries_row_mismatch", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"},
        ])
        aqi = [a for a in plan if a["kind"] == "aqi_rebuild"]
        self.assertEqual(len(aqi), 1)
        self.assertEqual(aqi[0]["pollutant_code"], "pm10")

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
        self.assertEqual([a["kind"] for a in plan], ["observation_connector_manifest_repair", "observation_index_repair"])


if __name__ == "__main__":
    unittest.main()
