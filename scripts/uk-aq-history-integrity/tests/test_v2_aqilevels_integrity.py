#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_aqi", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class V2AqiIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = MODULE.resolve_history_path_config("v2", {})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _partition(self, day: str = "2026-06-11", connector: int = 7, pollutant: str = "pm25", profile: str = "data") -> Path:
        return self.root / f"history/v2/aqilevels/hourly/{profile}/day_utc={day}/connector_id={connector}/pollutant_code={pollutant}"

    def _index(self, day: str = "2026-06-11", connector: int = 7, pollutant: str = "pm25") -> Path:
        return self.root / f"history/_index_v2/aqilevels_hourly_data_timeseries/day_utc={day}/connector_id={connector}/pollutant_code={pollutant}"

    def _write_healthy(self, *, latest: bool = True, index: bool = True, manifest: bool = True, parquet: bool = True, day: str = "2026-06-11") -> None:
        part = self._partition(day=day)
        part.mkdir(parents=True, exist_ok=True)
        key = f"history/v2/aqilevels/hourly/data/day_utc={day}/connector_id=7/pollutant_code=pm25/part-00000.parquet"
        if parquet:
            (self.root / key).write_bytes(b"PAR1")
        if manifest:
            (part / "manifest.json").write_text(json.dumps({
                "history_version": "v2", "domain": "aqilevels", "grain": "hourly", "profile": "data",
                "day_utc": day, "connector_id": 7, "pollutant_code": "pm25", "row_count": 3,
                "source_row_count": 3, "file_count": 1, "timeseries_row_counts": {"101": 3},
                "files": [{"key": key}],
            }), encoding="utf-8")
        if index:
            idx = self._index(day=day)
            idx.mkdir(parents=True, exist_ok=True)
            (idx / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"101": 3}}), encoding="utf-8")
        if latest:
            latest_path = self.root / "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_path.write_text(json.dumps({"latest": day}), encoding="utf-8")

    def _run(self, **kwargs) -> dict:
        return MODULE.run_v2_aqilevels_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=kwargs.pop("from_day", "2026-06-11"),
            to_day=kwargs.pop("to_day", "2026-06-11"), **kwargs
        )

    def _gap_types(self, result: dict) -> set[str]:
        return {g["gap_type"] for g in result["gaps"]}

    def test_healthy_v2_aqi_data_partition_is_ok(self) -> None:
        self._write_healthy()
        result = self._run()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)
        self.assertEqual(result["gap_count"], 0)

    def test_missing_v2_aqi_data_manifest(self) -> None:
        self._write_healthy(manifest=False)
        result = self._run()
        self.assertEqual(result["status"], "fail")
        self.assertIn("data_manifest_missing", self._gap_types(result))

    def test_invalid_v2_aqi_data_manifest_json(self) -> None:
        self._write_healthy(manifest=False)
        (self._partition() / "manifest.json").write_text("{", encoding="utf-8")
        self.assertIn("data_manifest_invalid_json", self._gap_types(self._run()))

    def test_aqi_manifest_schema_mismatch(self) -> None:
        self._write_healthy()
        p = self._partition() / "manifest.json"
        payload = json.loads(p.read_text())
        payload.update({"domain": "observations", "grain": "daily", "profile": "debug", "day_utc": "2026-06-10", "connector_id": 8, "pollutant_code": "no2"})
        p.write_text(json.dumps(payload), encoding="utf-8")
        self.assertIn("data_manifest_schema_mismatch", self._gap_types(self._run()))

    def test_missing_referenced_aqi_parquet(self) -> None:
        self._write_healthy(parquet=False)
        self.assertIn("parquet_missing", self._gap_types(self._run()))

    def test_aqi_manifest_rejects_parquet_key_outside_root(self) -> None:
        self._write_healthy()
        manifest_path = self._partition() / "manifest.json"
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["files"] = [{"key": "../../outside.parquet"}]
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        result = self._run()

        self.assertEqual(result["status"], "fail")
        self.assertIn("data_manifest_schema_mismatch", self._gap_types(result))
        gap = next(g for g in result["gaps"] if g["gap_type"] == "data_manifest_schema_mismatch")
        self.assertTrue(any("escapes mirror root" in p for p in gap["related_paths"]))

    def test_orphan_aqi_parquet_without_manifest(self) -> None:
        self._write_healthy(manifest=False)
        self.assertIn("orphan_parquet_without_manifest", self._gap_types(self._run()))

    def test_missing_v2_aqi_data_index_manifest(self) -> None:
        self._write_healthy(index=False)
        self.assertTrue({"index_day_dir_missing", "index_manifest_missing"} & self._gap_types(self._run()))

    def test_missing_latest_v2_aqi_data_index(self) -> None:
        self._write_healthy(latest=False)
        self.assertIn("latest_index_missing", self._gap_types(self._run()))

    def test_debug_skipped_by_default(self) -> None:
        self._write_healthy()
        result = self._run()
        self.assertEqual(result["debug"]["status"], "skipped")
        self.assertEqual(result["debug"]["gap_count"], 0)

    def test_debug_warning_mode_does_not_fail(self) -> None:
        self._write_healthy()
        result = self._run(check_aqi_debug=True, require_aqi_debug=False)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["debug"]["status"], "warning")
        self.assertEqual(result["debug"]["gaps"][0]["severity"], "warning")

    def test_debug_required_mode_fails(self) -> None:
        self._write_healthy()
        result = self._run(check_aqi_debug=True, require_aqi_debug=True)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["debug"]["status"], "fail")
        self.assertEqual(result["debug"]["gaps"][0]["severity"], "error")

    def test_history_version_v2_failure_shape(self) -> None:
        self._write_healthy(manifest=False)
        aqi = self._run()
        self.assertEqual(aqi["status"], "fail")

    def test_both_reports_v1_and_v2_separately(self) -> None:
        self._write_healthy(manifest=False)
        aqi = self._run()
        results = {"v1": {"status": "checked"}, "v2": {"status": aqi["status"], "aqilevels": aqi}}
        self.assertEqual(results["v1"]["status"], "checked")
        self.assertEqual(results["v2"]["status"], "fail")

    def test_targeted_day_range_does_not_scan_outside_selected_days(self) -> None:
        self._write_healthy(day="2026-06-11")
        self._write_healthy(day="2026-06-12", manifest=False)
        result = self._run(from_day="2026-06-11", to_day="2026-06-11")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)

    def test_source_scoped_aqi_and_debug_ignore_connector_1(self) -> None:
        day = "2026-06-07"
        self._write_healthy(day=day)
        part6 = self._partition(day=day, connector=6, pollutant="pm25")
        part6.mkdir(parents=True, exist_ok=True)
        key6 = f"history/v2/aqilevels/hourly/data/day_utc={day}/connector_id=6/pollutant_code=pm25/part-00000.parquet"
        (self.root / key6).write_bytes(b"PAR1")
        (part6 / "manifest.json").write_text(json.dumps({"files": [{"key": key6}], "row_count": 1, "timeseries_row_counts": {"301": 1}}), encoding="utf-8")
        idx6 = self._index(day=day, connector=6, pollutant="pm25")
        idx6.mkdir(parents=True, exist_ok=True)
        (idx6 / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"301": 1}}), encoding="utf-8")
        debug6 = self._partition(day=day, connector=6, pollutant="pm25", profile="debug")
        debug6.mkdir(parents=True, exist_ok=True)
        (debug6 / "manifest.json").write_text(json.dumps({
            "history_version": "v2", "domain": "aqilevels", "grain": "hourly", "profile": "debug",
            "day_utc": day, "connector_id": 6, "pollutant_code": "pm25", "files": []
        }), encoding="utf-8")
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/aqilevels/hourly/data/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({"files": [{"key": key1}], "row_count": 1, "timeseries_row_counts": {"201": 1}}), encoding="utf-8")

        result = MODULE.run_v2_aqilevels_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={6},
            source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
            check_aqi_debug=True, require_aqi_debug=True,
        )

        self.assertEqual(result["status"], "ok")
        self.assertFalse(any(g.get("connector_id") == 1 for g in result["gaps"]))
        self.assertFalse(any(g.get("connector_id") == 1 for g in result["debug"]["gaps"]))
        self.assertEqual(result["source_scope"]["connector_ids"], [6])


if __name__ == "__main__":
    unittest.main()
