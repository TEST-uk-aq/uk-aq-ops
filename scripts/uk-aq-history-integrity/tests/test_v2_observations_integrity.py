#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_v2", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class V2ObservationsIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = MODULE.resolve_history_path_config("v2", {})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _partition(self, day: str = "2026-06-11", connector: int = 7, pollutant: str = "pm25") -> Path:
        return self.root / f"history/v2/observations/day_utc={day}/connector_id={connector}/pollutant_code={pollutant}"

    def _index(self, day: str = "2026-06-11", connector: int = 7, pollutant: str = "pm25") -> Path:
        return self.root / f"history/_index_v2/observations_timeseries/day_utc={day}/connector_id={connector}/pollutant_code={pollutant}"

    def _write_healthy(self, *, latest: bool = True, index: bool = True, manifest: bool = True, parquet: bool = True, day: str = "2026-06-11") -> None:
        part = self._partition(day=day)
        part.mkdir(parents=True, exist_ok=True)
        key = f"history/v2/observations/day_utc={day}/connector_id=7/pollutant_code=pm25/part-00000.parquet"
        if parquet:
            (self.root / key).write_bytes(b"PAR1")
        if manifest:
            (part / "manifest.json").write_text(json.dumps({
                "history_version": "v2", "domain": "observations", "day_utc": day,
                "connector_id": 7, "pollutant_code": "pm25", "row_count": 3,
                "source_row_count": 3, "file_count": 1,
                "timeseries_row_counts": {"101": 3}, "files": [{"key": key}],
            }), encoding="utf-8")
        if index:
            idx = self._index(day=day)
            idx.mkdir(parents=True, exist_ok=True)
            (idx / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"101": 3}}), encoding="utf-8")
        if latest:
            latest_path = self.root / "history/_index_v2/observations_timeseries_latest.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_path.write_text(json.dumps({"latest": day}), encoding="utf-8")

    def _run(self, from_day: str = "2026-06-11", to_day: str = "2026-06-11") -> dict:
        return MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=from_day, to_day=to_day
        )

    def _gap_types(self, result: dict) -> set[str]:
        return {g["gap_type"] for g in result["gaps"]}

    def test_healthy_partition_is_ok(self) -> None:
        self._write_healthy()
        result = self._run()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)
        self.assertEqual(result["gap_count"], 0)

    def test_missing_data_manifest_fails(self) -> None:
        self._write_healthy(manifest=False)
        result = self._run()
        self.assertEqual(result["status"], "fail")
        self.assertIn("data_manifest_missing", self._gap_types(result))

    def test_invalid_data_manifest_json(self) -> None:
        self._write_healthy(manifest=False)
        (self._partition() / "manifest.json").write_text("{", encoding="utf-8")
        self.assertIn("data_manifest_invalid_json", self._gap_types(self._run()))

    def test_missing_referenced_parquet(self) -> None:
        self._write_healthy(parquet=False)
        self.assertIn("parquet_missing", self._gap_types(self._run()))

    def test_observations_manifest_rejects_parquet_key_outside_root(self) -> None:
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

    def test_orphan_parquet_without_manifest(self) -> None:
        self._write_healthy(manifest=False)
        self.assertIn("orphan_parquet_without_manifest", self._gap_types(self._run()))

    def test_missing_index_manifest(self) -> None:
        self._write_healthy(index=False)
        self.assertIn("index_manifest_missing", self._gap_types(self._run()))

    def test_missing_latest_index(self) -> None:
        self._write_healthy(latest=False)
        self.assertIn("latest_index_missing", self._gap_types(self._run()))

    def test_v2_failure_not_top_level_ok_shape(self) -> None:
        self._write_healthy(manifest=False)
        obs = self._run()
        result = {"v2": {"status": obs["status"], "observations": obs}}
        self.assertEqual(result["v2"]["status"], "fail")

    def test_both_keeps_v2_failure_separate(self) -> None:
        self._write_healthy(manifest=False)
        obs = self._run()
        results = {"v1": {"status": "checked"}, "v2": {"status": obs["status"], "observations": obs}}
        self.assertEqual(results["v1"]["status"], "checked")
        self.assertEqual(results["v2"]["status"], "fail")


    def test_v1_to_v2_repair_command_is_marked_non_executing_write_risk(self) -> None:
        day = "2026-06-11"
        v1_dir = self.root / f"history/v1/observations/day_utc={day}/connector_id=7"
        v1_dir.mkdir(parents=True)

        result = self._run(day, day)

        gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
        repair = gap["suggested_repair"]
        self.assertEqual(repair["kind"], "v1_dropbox_to_v2_observations_backfill_plan")
        self.assertEqual(repair["executes"], False)
        self.assertEqual(repair["operator_action_required"], True)
        self.assertEqual(repair["write_risk"], "writes_to_r2_if_operator_runs_command")
        command = repair["commands"][0]
        self.assertIn("--write-r2", command)
        self.assertIn("--replace", command)
        self.assertIn("operator review", repair["notes"])

    def test_targeted_day_range_does_not_scan_outside_days(self) -> None:
        self._write_healthy(day="2026-06-11")
        self._write_healthy(day="2026-06-12", manifest=False)
        result = self._run("2026-06-11", "2026-06-11")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)

    def test_source_scoped_openaq_ignores_connector_1_missing_index(self) -> None:
        day = "2026-06-07"
        self._write_healthy(day=day)
        part6 = self._partition(day=day, connector=6, pollutant="pm25")
        part6.mkdir(parents=True, exist_ok=True)
        key6 = f"history/v2/observations/day_utc={day}/connector_id=6/pollutant_code=pm25/part-00000.parquet"
        (self.root / key6).write_bytes(b"PAR1")
        (part6 / "manifest.json").write_text(json.dumps({"files": [{"key": key6}], "row_count": 1, "timeseries_row_counts": {"301": 1}}), encoding="utf-8")
        idx6 = self._index(day=day, connector=6, pollutant="pm25")
        idx6.mkdir(parents=True, exist_ok=True)
        (idx6 / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"301": 1}}), encoding="utf-8")
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/observations/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({
            "history_version": "v2", "domain": "observations", "day_utc": day,
            "connector_id": 1, "pollutant_code": "o3", "row_count": 1,
            "source_row_count": 1, "file_count": 1,
            "timeseries_row_counts": {"201": 1}, "files": [{"key": key1}],
        }), encoding="utf-8")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={6},
            source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)
        self.assertFalse(any(g.get("connector_id") == 1 for g in result["gaps"]))
        self.assertEqual(result["source_scope"]["connector_ids"], [6])

    def test_source_scoped_uk_air_sos_reports_connector_1_missing_index(self) -> None:
        day = "2026-06-07"
        self._write_healthy(day=day)
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/observations/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({"files": [{"key": key1}], "row_count": 1, "timeseries_row_counts": {"201": 1}}), encoding="utf-8")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={1},
        )

        self.assertIn("index_manifest_missing", self._gap_types(result))
        self.assertTrue(any(g.get("connector_id") == 1 for g in result["gaps"]))

    def test_all_scope_reports_connector_1_missing_index(self) -> None:
        day = "2026-06-07"
        self._write_healthy(day=day)
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/observations/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({"files": [{"key": key1}], "row_count": 1, "timeseries_row_counts": {"201": 1}}), encoding="utf-8")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            source_scope={"source": "all", "connector_ids": None, "scope": "all"},
        )

        self.assertIn("index_manifest_missing", self._gap_types(result))
        self.assertIsNone(result["source_scope"]["connector_ids"])


if __name__ == "__main__":
    unittest.main()
