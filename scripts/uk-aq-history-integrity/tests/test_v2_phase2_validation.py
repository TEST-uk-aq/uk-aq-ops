#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_phase2", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeDuckDbConnection:
    def __init__(self) -> None:
        self.query = ""
        self.closed = False

    def execute(self, query, _params):
        self.query = query
        return self

    def fetchall(self):
        if self.query.startswith("DESCRIBE"):
            return [("timeseries_id",), ("observed_at_utc",), ("value",)]
        return [(101, 2), (202, 1)]

    def fetchone(self):
        return ("2026-06-11 00:00:00+00", "2026-06-11 02:00:00+00")

    def close(self):
        self.closed = True


class V2Phase2ValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = MODULE.resolve_history_path_config("v2", {})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _partition(self, domain: str, pollutant: str = "o3") -> Path:
        prefix = (
            "history/v2/observations"
            if domain == "observations"
            else "history/v2/aqilevels/hourly/data"
        )
        return self.root / f"{prefix}/day_utc=2026-06-11/connector_id=1/pollutant_code={pollutant}"

    def _manifest(self, domain: str, pollutant: str, key: str, count: int, ts_id: int) -> dict:
        return {
            "manifest_kind": "pollutant",
            "history_version": "v2",
            "domain": domain,
            "grain": "hourly" if domain == "aqilevels" else None,
            "profile": "data" if domain == "aqilevels" else None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_code": pollutant,
            "pollutant_codes": [pollutant],
            "row_count": count,
            "source_row_count": count,
            "file_count": 1,
            "total_bytes": 4,
            "timeseries_row_counts": {str(ts_id): count},
            "files": [{"key": key, "bytes": 4, "timeseries_row_counts": {str(ts_id): count}}],
            "manifest_hash": f"hash-{pollutant}",
        }

    def _write_pollutant(self, domain: str, pollutant: str = "o3", count: int = 1, ts_id: int = 101) -> dict:
        part = self._partition(domain, pollutant)
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        payload = self._manifest(domain, pollutant, key, count, ts_id)
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
        return payload

    def test_duckdb_reader_returns_actual_timeseries_counts(self) -> None:
        parquet = self.root / "part.parquet"
        parquet.write_bytes(b"PAR1")
        connection = FakeDuckDbConnection()
        fake_duckdb = types.SimpleNamespace(connect=lambda **_kwargs: connection)
        with (
            mock.patch.object(MODULE.importlib.util, "find_spec", return_value=object()),
            mock.patch.dict(sys.modules, {"duckdb": fake_duckdb}),
        ):
            stats, error = MODULE._read_parquet_partition_stats([parquet])
        self.assertIsNone(error)
        self.assertEqual(stats["row_count"], 3)
        self.assertEqual(stats["timeseries_row_counts"], {101: 2, 202: 1})
        self.assertEqual(stats["min_timeseries_id"], 101)
        self.assertEqual(stats["max_timeseries_id"], 202)
        self.assertTrue(connection.closed)

    def test_missing_connector_and_day_manifests_are_reported_for_both_domains(self) -> None:
        for domain in ("observations", "aqilevels"):
            self._write_pollutant(domain)
            gaps = []
            part = self._partition(domain)
            MODULE._validate_v2_parent_hierarchy(
                root=self.root,
                data_prefix=(
                    self.config.observations_data_prefix
                    if domain == "observations"
                    else self.config.aqilevels_hourly_data_prefix
                ),
                day_utc="2026-06-11",
                connector_dir=part.parent,
                day_dir=part.parent.parent,
                gaps=gaps,
                domain=domain,
            )
            MODULE._validate_v2_parent_hierarchy(
                root=self.root,
                data_prefix=(
                    self.config.observations_data_prefix
                    if domain == "observations"
                    else self.config.aqilevels_hourly_data_prefix
                ),
                day_utc="2026-06-11",
                connector_dir=None,
                day_dir=part.parent.parent,
                gaps=gaps,
                domain=domain,
            )
            self.assertIn("connector_manifest_missing", {gap["gap_type"] for gap in gaps})
            self.assertIn("day_manifest_missing", {gap["gap_type"] for gap in gaps})

    def test_connector_validation_runs_once_with_multiple_pollutants(self) -> None:
        self._write_pollutant("observations", "o3", 1, 101)
        self._write_pollutant("observations", "no2", 1, 202)
        connector_dir = self._partition("observations").parent
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11",
            connector_dir=connector_dir,
            day_dir=connector_dir.parent,
            gaps=gaps,
            domain="observations",
        )
        missing = [gap for gap in gaps if gap["gap_type"] == "connector_manifest_missing"]
        self.assertEqual(len(missing), 1)

    def test_parent_aggregates_zero_values_and_child_hashes_are_validated(self) -> None:
        child = self._write_pollutant("observations", "o3", 0, 101)
        child["timeseries_row_counts"] = {}
        child["files"] = []
        child["file_count"] = 0
        child["total_bytes"] = 0
        (self._partition("observations") / "manifest.json").write_text(json.dumps(child), encoding="utf-8")
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": "2026-06-11", "connector_id": 1,
            "pollutant_codes": ["o3"], "row_count": 0, "source_row_count": 0,
            "file_count": 0, "total_bytes": 0, "files": [],
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "wrong"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root, data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11", connector_dir=connector_dir,
            day_dir=connector_dir.parent, gaps=gaps, domain="observations",
        )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("connector_manifest_child_manifests_child_hash_mismatch", gap_types)
        self.assertNotIn("connector_manifest_row_count_mismatch", gap_types)
        self.assertNotIn("connector_manifest_file_count_mismatch", gap_types)
        self.assertNotIn("connector_manifest_total_bytes_mismatch", gap_types)

    def test_manifest_count_matching_source_still_fails_when_parquet_differs(self) -> None:
        payload = self._manifest("observations", "pm25", "part.parquet", 3, 101)
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=({
            "row_count": 2, "timeseries_row_counts": {101: 2},
            "min_timeseries_id": 101, "max_timeseries_id": 101,
            "min_timestamp_utc": None, "max_timestamp_utc": None,
        }, None)):
            MODULE._append_actual_parquet_gaps(
                gaps, domain="observations", day_utc="2026-06-11", connector_id=1,
                pollutant_code="pm25", manifest_rel="manifest.json", payload=payload,
                parquet_files=[self.root / "part.parquet"],
            )
        self.assertIn("data_manifest_row_count_mismatch", {gap["gap_type"] for gap in gaps})
        self.assertIn("data_manifest_timeseries_row_count_mismatch", {gap["gap_type"] for gap in gaps})

    def test_source_and_r2_only_rows_are_both_classified_as_data_faults(self) -> None:
        gap = MODULE._build_v2_source_r2_mismatch_gap(
            day_utc="2026-06-11", connector_id=1, pollutant_code="pm25",
            expected_path="manifest.json", source_counts={101: 3, 202: 1},
            r2_counts={101: 2, 303: 4},
        )
        self.assertEqual(gap["source_only_timeseries_ids"], [202])
        self.assertEqual(gap["r2_only_timeseries_ids"], [303])
        MODULE._classify_v2_gaps([gap])
        self.assertEqual(gap["fault_class"], "data fault")

    def test_unreadable_parquet_is_a_data_fault(self) -> None:
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(None, "InvalidInputException:bad parquet")):
            MODULE._append_actual_parquet_gaps(
                gaps, domain="observations", day_utc="2026-06-11", connector_id=1,
                pollutant_code="o3", manifest_rel="manifest.json", payload=None,
                parquet_files=[self.root / "bad.parquet"],
            )
        MODULE._classify_v2_gaps(gaps)
        self.assertEqual(gaps[0]["gap_type"], "parquet_unreadable")
        self.assertEqual(gaps[0]["fault_class"], "data fault")

    def test_valid_o3_parquet_missing_manifest_is_manifest_only_and_never_queues_aqi(self) -> None:
        gaps = [MODULE._v2_obs_gap(
            "data_manifest_missing", day_utc="2026-06-11", connector_id=1,
            pollutant_code="o3", expected_path="manifest.json",
        )]
        gaps[0]["parquet_readable"] = True
        MODULE._classify_v2_gaps(gaps)
        plan = MODULE.build_v2_repair_plan(observation_gaps=gaps)
        self.assertEqual(gaps[0]["fault_class"], "pollutant manifest-only fault")
        self.assertTrue(any(action["kind"] == "observation_pollutant_manifest_repair" for action in plan))
        self.assertFalse(any(action["kind"] == "observation_data_repair" for action in plan))
        self.assertFalse(any(action["kind"] == "aqi_rebuild" for action in plan))
        self.assertTrue(all(action["status"] == "planned" for action in plan))
        self.assertTrue(all(action["executes"] is False for action in plan))
        self.assertTrue(all("data_changes_required" in action for action in plan))

    def test_phase2_validation_does_not_modify_history_files(self) -> None:
        self._write_pollutant("observations", "o3", 1, 101)
        self._write_pollutant("aqilevels", "pm25", 1, 202)
        before = {
            str(path.relative_to(self.root)): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        stats = {
            "row_count": 1, "timeseries_row_counts": {101: 1},
            "min_timeseries_id": 101, "max_timeseries_id": 101,
            "min_timestamp_utc": None, "max_timestamp_utc": None,
        }
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.root, config=self.config,
                from_day="2026-06-11", to_day="2026-06-11",
            )
            MODULE.run_v2_aqilevels_integrity_checks(
                r2_history_root=self.root, config=self.config,
                from_day="2026-06-11", to_day="2026-06-11",
            )
        after = {
            str(path.relative_to(self.root)): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
