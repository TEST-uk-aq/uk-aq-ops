from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
integrity = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = integrity
SPEC.loader.exec_module(integrity)


class V2RepairPlanningTest(unittest.TestCase):
    def test_observation_index_gap_plans_index_only_without_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            part = root / "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25"
            part.mkdir(parents=True)
            parquet = part / "part-00000.parquet"
            parquet.write_bytes(b"parquet")
            (part / "manifest.json").write_text(
                json.dumps(
                    {
                        "history_version": "v2",
                        "domain": "observations",
                        "day_utc": "2026-06-11",
                        "connector_id": "6",
                        "pollutant_code": "pm25",
                        "row_count": 1,
                        "files": [{"key": "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25/part-00000.parquet"}],
                    }
                ),
                encoding="utf-8",
            )

            result = integrity.run_v2_observations_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            index_gap = next(g for g in result["gaps"] if g["gap_type"] == "index_manifest_missing")
            self.assertEqual(index_gap["suggested_repair"]["kind"], "rebuild_v2_observations_index_only")
            self.assertEqual(index_gap["suggested_repair"]["commands"], [])
            self.assertIn("command contract remains unresolved", index_gap["suggested_repair"]["notes"])

    def test_missing_v2_observations_with_local_v1_plans_confirmed_builder_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            (root / "history/v1/observations/day_utc=2026-06-11/connector_id=6").mkdir(parents=True)
            (root / cfg.observations_latest_index_key).parent.mkdir(parents=True)
            (root / cfg.observations_latest_index_key).write_text("{}", encoding="utf-8")

            result = integrity.run_v2_observations_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
            repair = gap["suggested_repair"]
            self.assertEqual(repair["kind"], "v1_dropbox_to_v2_observations_backfill_plan")
            self.assertEqual(repair["commands"][0][0:2], ["node", "scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs"])
            self.assertIn("--write-r2", repair["commands"][0])
            self.assertIn("_index_v2 rebuild command is not listed", repair["notes"])
            self.assertTrue(gap["source_evidence"]["v1_local_dropbox_present"])

    def test_missing_v2_aqi_with_v2_observations_present_plans_aqi_rebuild_without_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            (root / "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25").mkdir(parents=True)
            (root / cfg.aqilevels_latest_index_key).parent.mkdir(parents=True)
            (root / cfg.aqilevels_latest_index_key).write_text("{}", encoding="utf-8")

            result = integrity.run_v2_aqilevels_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
            repair = gap["suggested_repair"]
            self.assertEqual(repair["kind"], "v2_aqi_hourly_rebuild_from_v2_observations_plan")
            self.assertEqual(repair["commands"], [])
            self.assertTrue(gap["source_evidence"]["v2_observations_present"])
            self.assertIn("commands require confirmation", repair["notes"])


if __name__ == "__main__":
    unittest.main()
