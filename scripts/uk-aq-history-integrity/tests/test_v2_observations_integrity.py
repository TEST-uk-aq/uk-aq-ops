#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
        self.parquet_reader = mock.patch.object(
            MODULE,
            "_read_parquet_partition_stats",
            side_effect=self._mock_parquet_stats,
        )
        self.parquet_reader.start()

    def tearDown(self) -> None:
        self.parquet_reader.stop()
        self.tmp.cleanup()

    def _mock_parquet_stats(self, files) -> tuple[dict, None]:
        paths = [str(path) for path in files]
        joined = " ".join(paths)
        day = "2026-06-11"
        for path in paths:
            for part in Path(path).parts:
                if part.startswith("day_utc="):
                    day = part.split("=", 1)[1]
                    break
        if "connector_id=6" in joined:
            counts = {301: 1}
        elif "connector_id=1" in joined:
            counts = {201: 1}
        elif "pollutant_code=o3" in joined:
            counts = {102: 1}
        else:
            counts = {101: 3}
        return {
            "row_count": sum(counts.values()),
            "timeseries_row_counts": counts,
            "min_timeseries_id": min(counts),
            "max_timeseries_id": max(counts),
            "min_timestamp_utc": f"{day}T00:00:00+00",
            "max_timestamp_utc": f"{day}T02:00:00+00",
        }, None

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
                "manifest_kind": "pollutant", "history_version": "v2", "domain": "observations",
                "grain": None, "profile": None, "day_utc": day,
                "connector_id": 7, "pollutant_code": "pm25", "row_count": 3,
                "source_row_count": 3, "file_count": 1, "total_bytes": 4,
                "min_timeseries_id": 101, "max_timeseries_id": 101,
                "min_observed_at_utc": "2026-06-11T00:00:00+00",
                "max_observed_at_utc": "2026-06-11T02:00:00+00",
                "timeseries_row_counts": {"101": 3},
                "files": [{"key": key, "bytes": 4, "timeseries_row_counts": {"101": 3}}],
                "manifest_hash": f"observations-{day}-connector-7-pm25-hash",
            }), encoding="utf-8")
        if index:
            idx = self._index(day=day)
            idx.mkdir(parents=True, exist_ok=True)
            (idx / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"101": 3}}), encoding="utf-8")
        if latest:
            latest_path = self.root / "history/_index_v2/observations_timeseries_latest.json"
            latest_path.parent.mkdir(parents=True, exist_ok=True)
            latest_path.write_text(json.dumps({"latest": day}), encoding="utf-8")

    def _write_parent_manifests(self, day: str = "2026-06-11") -> None:
        day_dir = self.root / f"history/v2/observations/day_utc={day}"
        connector_payloads = []
        for connector_dir in sorted(p for p in day_dir.glob("connector_id=*") if p.is_dir()):
            children = []
            for pollutant_dir in sorted(p for p in connector_dir.glob("pollutant_code=*") if p.is_dir()):
                manifest_path = pollutant_dir / "manifest.json"
                if not manifest_path.is_file():
                    continue
                try:
                    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    children.append(payload)
            connector_id = int(connector_dir.name.split("=", 1)[1])
            files = [entry for child in children for entry in child.get("files", [])]
            min_ids = [int(child["min_timeseries_id"]) for child in children if isinstance(child.get("min_timeseries_id"), int)]
            max_ids = [int(child["max_timeseries_id"]) for child in children if isinstance(child.get("max_timeseries_id"), int)]
            min_times = [str(child["min_observed_at_utc"]) for child in children if child.get("min_observed_at_utc")]
            max_times = [str(child["max_observed_at_utc"]) for child in children if child.get("max_observed_at_utc")]
            connector_payload = {
                "manifest_kind": "connector", "history_version": "v2", "domain": "observations",
                "grain": None, "profile": None, "day_utc": day, "connector_id": connector_id,
                "pollutant_codes": [child["pollutant_code"] for child in children],
                "row_count": sum(child.get("row_count", 0) for child in children),
                "source_row_count": sum(child.get("source_row_count", 0) for child in children),
                "file_count": sum(child.get("file_count", 0) for child in children),
                "total_bytes": sum(child.get("total_bytes", 0) for child in children),
                "min_timeseries_id": min(min_ids) if min_ids else None,
                "max_timeseries_id": max(max_ids) if max_ids else None,
                "min_observed_at_utc": min(min_times) if min_times else None,
                "max_observed_at_utc": max(max_times) if max_times else None,
                "files": files,
                "child_manifests": [{"pollutant_code": child["pollutant_code"], "manifest_hash": child.get("manifest_hash")} for child in children],
                "pollutant_manifests": [{"pollutant_code": child["pollutant_code"], "manifest_hash": child.get("manifest_hash")} for child in children],
                "manifest_hash": f"observations-{day}-connector-{connector_id}-hash",
            }
            (connector_dir / "manifest.json").write_text(json.dumps(connector_payload), encoding="utf-8")
            connector_payloads.append(connector_payload)
        files = [entry for child in connector_payloads for entry in child.get("files", [])]
        min_ids = [int(child["min_timeseries_id"]) for child in connector_payloads if isinstance(child.get("min_timeseries_id"), int)]
        max_ids = [int(child["max_timeseries_id"]) for child in connector_payloads if isinstance(child.get("max_timeseries_id"), int)]
        min_times = [str(child["min_observed_at_utc"]) for child in connector_payloads if child.get("min_observed_at_utc")]
        max_times = [str(child["max_observed_at_utc"]) for child in connector_payloads if child.get("max_observed_at_utc")]
        day_payload = {
            "manifest_kind": "day", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day,
            "connector_ids": [child["connector_id"] for child in connector_payloads],
            "row_count": sum(child.get("row_count", 0) for child in connector_payloads),
            "source_row_count": sum(child.get("source_row_count", 0) for child in connector_payloads),
            "file_count": sum(child.get("file_count", 0) for child in connector_payloads),
            "total_bytes": sum(child.get("total_bytes", 0) for child in connector_payloads),
            "min_timeseries_id": min(min_ids) if min_ids else None,
            "max_timeseries_id": max(max_ids) if max_ids else None,
            "min_observed_at_utc": min(min_times) if min_times else None,
            "max_observed_at_utc": max(max_times) if max_times else None,
            "files": files,
            "child_manifests": [{"connector_id": child["connector_id"], "manifest_hash": child.get("manifest_hash")} for child in connector_payloads],
            "connector_manifests": [{"connector_id": child["connector_id"], "manifest_hash": child.get("manifest_hash")} for child in connector_payloads],
            "manifest_hash": f"observations-{day}-day-hash",
        }
        day_dir.mkdir(parents=True, exist_ok=True)
        (day_dir / "manifest.json").write_text(json.dumps(day_payload), encoding="utf-8")

    def _run(self, from_day: str = "2026-06-11", to_day: str = "2026-06-11", *, refresh_parents: bool = True) -> dict:
        if refresh_parents:
            for day in {from_day, to_day}:
                day_dir = self.root / f"history/v2/observations/day_utc={day}"
                if day_dir.is_dir():
                    self._write_parent_manifests(day)
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


    def test_v2_repair_plan_uses_uk_air_csv_without_v1_fallback(self) -> None:
        day = "2026-06-11"
        v1_dir = self.root / f"history/v1/observations/day_utc={day}/connector_id=7"
        v1_dir.mkdir(parents=True)

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root,
            config=self.config,
            from_day=day,
            to_day=day,
            allowed_connector_ids={7},
            source_scope={"source": "sos", "connector_ids": [7], "scope": "source"},
        )

        gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
        repair = gap["suggested_repair"]
        self.assertEqual(repair["kind"], "uk_air_csv_to_v2_observations_backfill_required")
        self.assertEqual(repair["executes"], False)
        self.assertEqual(repair["operator_action_required"], False)
        self.assertEqual(repair["commands"], [])
        self.assertNotIn("v1", json.dumps(repair).lower())
        self.assertNotIn("dropbox", json.dumps(repair).lower())

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
        (part6 / "manifest.json").write_text(json.dumps({
            "manifest_kind": "pollutant", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day, "connector_id": 6,
            "pollutant_code": "pm25", "files": [{"key": key6, "bytes": 4, "timeseries_row_counts": {"301": 1}}], "file_count": 1,
            "total_bytes": 4, "row_count": 1, "source_row_count": 1,
            "min_timeseries_id": 301, "max_timeseries_id": 301,
            "min_observed_at_utc": "2026-06-07T00:00:00+00", "max_observed_at_utc": "2026-06-07T02:00:00+00",
            "timeseries_row_counts": {"301": 1},
            "manifest_hash": f"observations-{day}-connector-6-pm25-hash",
        }), encoding="utf-8")
        idx6 = self._index(day=day, connector=6, pollutant="pm25")
        idx6.mkdir(parents=True, exist_ok=True)
        (idx6 / "manifest.json").write_text(json.dumps({"timeseries_row_counts": {"301": 1}}), encoding="utf-8")
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/observations/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({
            "manifest_kind": "pollutant", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day,
            "connector_id": 1, "pollutant_code": "o3", "row_count": 1,
            "source_row_count": 1, "file_count": 1, "total_bytes": 4,
            "min_timeseries_id": 201, "max_timeseries_id": 201,
            "min_observed_at_utc": "2026-06-07T00:00:00+00", "max_observed_at_utc": "2026-06-07T02:00:00+00",
            "timeseries_row_counts": {"201": 1},
            "files": [{"key": key1, "bytes": 4, "timeseries_row_counts": {"201": 1}}],
            "manifest_hash": f"observations-{day}-connector-1-o3-hash",
        }), encoding="utf-8")
        self._write_parent_manifests(day)

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={6},
            source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["checked_partitions"], 1)
        self.assertFalse(any(g.get("connector_id") == 1 for g in result["gaps"]))
        self.assertEqual(result["source_scope"]["connector_ids"], [6])

    def test_source_scoped_sos_reports_connector_1_missing_index(self) -> None:
        day = "2026-06-07"
        self._write_healthy(day=day)
        part1 = self._partition(day=day, connector=1, pollutant="o3")
        part1.mkdir(parents=True, exist_ok=True)
        key1 = f"history/v2/observations/day_utc={day}/connector_id=1/pollutant_code=o3/part-00000.parquet"
        (self.root / key1).write_bytes(b"PAR1")
        (part1 / "manifest.json").write_text(json.dumps({"files": [{"key": key1}], "row_count": 1, "timeseries_row_counts": {"201": 1}}), encoding="utf-8")
        (part1 / "manifest.json").write_text(json.dumps({
            "manifest_kind": "pollutant", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day,
            "connector_id": 1, "pollutant_code": "o3", "row_count": 1,
            "source_row_count": 1, "file_count": 1, "total_bytes": 4,
            "min_timeseries_id": 201, "max_timeseries_id": 201,
            "min_observed_at_utc": "2026-06-07T00:00:00+00", "max_observed_at_utc": "2026-06-07T02:00:00+00",
            "timeseries_row_counts": {"201": 1},
            "files": [{"key": key1, "bytes": 4, "timeseries_row_counts": {"201": 1}}],
        }), encoding="utf-8")

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
        (part1 / "manifest.json").write_text(json.dumps({
            "manifest_kind": "pollutant", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day,
            "connector_id": 1, "pollutant_code": "o3", "row_count": 1,
            "source_row_count": 1, "file_count": 1, "total_bytes": 4,
            "min_timeseries_id": 201, "max_timeseries_id": 201,
            "min_observed_at_utc": "2026-06-07T00:00:00+00", "max_observed_at_utc": "2026-06-07T02:00:00+00",
            "timeseries_row_counts": {"201": 1},
            "files": [{"key": key1, "bytes": 4, "timeseries_row_counts": {"201": 1}}],
        }), encoding="utf-8")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            source_scope={"source": "all", "connector_ids": None, "scope": "all"},
        )

        self.assertIn("index_manifest_missing", self._gap_types(result))
        self.assertIsNone(result["source_scope"]["connector_ids"])

    def test_source_scoped_missing_day_dir_emits_connector_specific_gap(self) -> None:
        day = "2026-06-08"
        latest_path = self.root / "history/_index_v2/observations_timeseries_latest.json"
        latest_path.parent.mkdir(parents=True, exist_ok=True)
        latest_path.write_text(json.dumps({"latest": day}), encoding="utf-8")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={6},
            source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
        )

        gaps = [g for g in result["gaps"] if g["gap_type"] == "day_dir_missing"]
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["connector_id"], 6)
        self.assertTrue(gaps[0]["expected_path"].endswith(f"day_utc={day}/connector_id=6"))

    def test_source_scoped_missing_connector_dir_emits_connector_specific_gap(self) -> None:
        day = "2026-06-08"
        latest_path = self.root / "history/_index_v2/observations_timeseries_latest.json"
        latest_path.parent.mkdir(parents=True, exist_ok=True)
        latest_path.write_text(json.dumps({"latest": day}), encoding="utf-8")
        (self.root / f"history/v2/observations/day_utc={day}").mkdir(parents=True, exist_ok=True)

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root, config=self.config, from_day=day, to_day=day,
            allowed_connector_ids={6},
            source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
        )

        gaps = [g for g in result["gaps"] if g["gap_type"] == "connector_dir_missing"]
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["connector_id"], 6)
        self.assertTrue(gaps[0]["expected_path"].endswith(f"day_utc={day}/connector_id=6"))

    def test_connector_manifest_reports_missing_child_manifest_even_when_pollutant_code_present(self) -> None:
        self._write_healthy(manifest=False)
        o3 = self._partition(pollutant="o3")
        o3.mkdir(parents=True, exist_ok=True)
        key = "history/v2/observations/day_utc=2026-06-11/connector_id=7/pollutant_code=o3/part-00000.parquet"
        (self.root / key).write_bytes(b"PAR1")
        (o3 / "manifest.json").write_text(json.dumps({
            "history_version": "v2", "domain": "observations", "day_utc": "2026-06-11",
            "connector_id": 7, "pollutant_code": "o3", "row_count": 1,
            "source_row_count": 1, "file_count": 1,
            "timeseries_row_counts": {"102": 1}, "files": [{"key": key}],
        }), encoding="utf-8")
        connector_manifest = self._partition().parent / "manifest.json"
        connector_manifest.write_text(json.dumps({
            "history_version": "v2", "domain": "observations", "day_utc": "2026-06-11",
            "connector_id": 7, "pollutant_codes": ["pm25", "o3"],
            "child_manifests": [{"pollutant_code": "pm25", "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/pollutant_code=pm25/manifest.json"}],
            "pollutant_manifests": [{"pollutant_code": "pm25", "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/pollutant_code=pm25/manifest.json"}],
            "files": [{"pollutant_code": "pm25", "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/pollutant_code=pm25/part-00000.parquet"}],
        }), encoding="utf-8")

        result = self._run(refresh_parents=False)

        self.assertIn("connector_manifest_child_manifests_missing_child", self._gap_types(result))
        self.assertIn("connector_manifest_pollutant_manifests_missing_child", self._gap_types(result))
        self.assertIn("connector_manifest_files_missing_child", self._gap_types(result))

    def test_day_manifest_reports_missing_connector_representation_independently(self) -> None:
        self._write_healthy(manifest=False)
        conn8 = self.root / "history/v2/observations/day_utc=2026-06-11/connector_id=8"
        conn8.mkdir(parents=True, exist_ok=True)
        (conn8 / "manifest.json").write_text(json.dumps({
            "history_version": "v2", "domain": "observations", "day_utc": "2026-06-11",
            "connector_id": 8, "pollutant_codes": [], "child_manifests": [],
            "pollutant_manifests": [], "files": [],
        }), encoding="utf-8")
        day_manifest = self._partition().parent.parent / "manifest.json"
        day_manifest.write_text(json.dumps({
            "history_version": "v2", "domain": "observations", "day_utc": "2026-06-11",
            "connector_ids": [7, 8],
            "child_manifests": [{"connector_id": 7, "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/manifest.json"}],
            "connector_manifests": [{"connector_id": 7, "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/manifest.json"}],
            "files": [{"connector_id": 7, "key": "history/v2/observations/day_utc=2026-06-11/connector_id=7/pollutant_code=pm25/part-00000.parquet"}],
        }), encoding="utf-8")

        result = self._run(refresh_parents=False)

        self.assertIn("day_manifest_child_manifests_missing_child", self._gap_types(result))
        self.assertIn("day_manifest_connector_manifests_missing_child", self._gap_types(result))
        self.assertIn("day_manifest_files_missing_child", self._gap_types(result))

    def test_pollutant_manifest_distinguishes_file_count_and_unlisted_parquet(self) -> None:
        self._write_healthy()
        extra = self._partition() / "part-extra.parquet"
        extra.write_bytes(b"PAR1")
        manifest_path = self._partition() / "manifest.json"
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["file_count"] = 99
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        result = self._run()

        self.assertIn("data_manifest_file_count_mismatch", self._gap_types(result))
        self.assertIn("data_manifest_unlisted_parquet", self._gap_types(result))
        self.assertNotIn("row_count_mismatch", self._gap_types(result))
        self.assertIn("repair_plan", result)
        self.assertTrue(any(step["kind"] == "observation_pollutant_manifest_repair" for step in result["repair_plan"]))


class V2ObservationMalformedLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = MODULE.resolve_history_path_config("v2", {})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_connector_level_part_file_without_pollutant_partitions_fails(self) -> None:
        connector = self.root / "history/v2/observations/day_utc=2026-06-08/connector_id=6"
        connector.mkdir(parents=True, exist_ok=True)
        (connector / "manifest.json").write_text(json.dumps({"connector_id": 6}), encoding="utf-8")
        (connector / "part-00000.parquet").write_bytes(b"PAR1")

        result = MODULE.run_v2_observations_integrity_checks(
            r2_history_root=self.root,
            config=self.config,
            from_day="2026-06-08",
            to_day="2026-06-08",
        )
        gap_types = {g["gap_type"] for g in result["gaps"]}
        self.assertEqual(result["status"], "fail")
        self.assertIn("unexpected_connector_level_part_file", gap_types)
        self.assertIn("missing_pollutant_partitions", gap_types)


if __name__ == "__main__":
    unittest.main()
