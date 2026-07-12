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
        return [(101, 1), (202, 1)]

    def fetchone(self):
        if "COUNT(timeseries_id)" in self.query:
            return (2,)
        if "COUNT(*)" in self.query:
            return (3,)
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
        result = {
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
            "min_timeseries_id": ts_id,
            "max_timeseries_id": ts_id,
            "timeseries_row_counts": {str(ts_id): count},
            "files": [{"key": key, "bytes": 4, "timeseries_row_counts": {str(ts_id): count}}],
            "manifest_hash": f"hash-{pollutant}",
        }
        # Add domain-specific timestamp fields
        if domain == "observations":
            result["min_observed_at_utc"] = "2026-06-11T00:00:00Z"
            result["max_observed_at_utc"] = "2026-06-11T02:00:00Z"
        elif domain == "aqilevels":
            result["min_timestamp_hour_utc"] = "2026-06-11T00:00:00Z"
            result["max_timestamp_hour_utc"] = "2026-06-11T02:00:00Z"
        return result

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
        self.assertEqual(stats["non_null_timeseries_count"], 2)
        self.assertEqual(stats["null_timeseries_count"], 1)
        self.assertEqual(stats["timeseries_row_counts"], {101: 1, 202: 1})
        self.assertEqual(stats["min_timeseries_id"], 101)
        self.assertEqual(stats["max_timeseries_id"], 202)
        self.assertTrue(stats["parquet_null_timeseries_id_rows"])
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
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
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
            "min_timestamp_utc": "2026-06-11T00:00:00+00", "max_timestamp_utc": "2026-06-11T02:00:00+00",
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

    def test_successful_empty_source_mismatch_keeps_empty_source_authoritative(self) -> None:
        successful_empty_evidence = {
            "source_partition_state": "successful_empty",
            "source_counts_present": False,
            "source_counts_available": True,
            "source_rows": 0,
            "source_timeseries_row_counts": {},
            "source_file_count": 1,
            "source_file_keys": ["source-file-key"],
            "source_skip_reason": None,
            "partition": {
                "state": "successful_empty",
                "source_counts_present": False,
                "source_counts_available": True,
                "source_rows": 0,
                "source_timeseries_row_counts": {},
                "source_file_count": 1,
                "source_file_keys": ["source-file-key"],
                "source_skip_reason": None,
            },
        }
        gap = MODULE._build_v2_source_r2_mismatch_gap(
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
            source_counts={},
            r2_counts={101: 3},
            source_partition_evidence=successful_empty_evidence,
        )
        self.assertIsNotNone(gap)
        self.assertEqual(gap["gap_type"], "source_r2_timeseries_row_mismatch")
        self.assertEqual(gap["source_rows"], 0)
        self.assertEqual(gap["r2_rows"], 3)
        self.assertEqual(gap["source_only_timeseries_ids"], [])
        self.assertEqual(gap["r2_only_timeseries_ids"], [101])
        self.assertEqual(gap["sample_missing_timeseries_ids"], [101])
        self.assertEqual(gap["source_evidence"]["source_partition_state"], "successful_empty")
        self.assertEqual(gap["source_evidence"]["source_rows"], 0)
        self.assertEqual(gap["source_evidence"]["r2_rows_for_source_timeseries"], 3)
        self.assertFalse(gap["source_evidence"]["source_counts_present"])
        self.assertTrue(gap["source_evidence"]["source_counts_available"])
        self.assertFalse(gap["source_evidence"]["partition"]["source_counts_present"])
        self.assertTrue(gap["source_evidence"]["partition"]["source_counts_available"])
        MODULE._classify_v2_gaps([gap])
        self.assertEqual(gap["fault_class"], "data fault")
        plan = MODULE.build_v2_repair_plan(observation_gaps=[gap])
        self.assertTrue(any(action["kind"] == "observation_data_repair" for action in plan))
        self.assertFalse(any(action["kind"] == "source_mapping_issue" for action in plan))

        empty_gap = MODULE._build_v2_source_r2_mismatch_gap(
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
            source_counts={},
            r2_counts={},
            source_partition_evidence=successful_empty_evidence,
        )
        self.assertIsNone(empty_gap)

        unavailable_evidence = {
            "source_partition_state": "connection_unavailable",
            "source_counts_present": False,
            "source_counts_available": False,
            "source_rows": 0,
            "source_timeseries_row_counts": {},
            "source_file_count": 0,
            "source_file_keys": [],
            "source_skip_reason": "source_connection_unavailable",
            "partition": {
                "state": "connection_unavailable",
                "source_counts_present": False,
                "source_counts_available": False,
                "source_rows": 0,
                "source_timeseries_row_counts": {},
                "source_file_count": 0,
                "source_file_keys": [],
                "source_skip_reason": "source_connection_unavailable",
            },
        }
        self.assertIsNone(MODULE._build_v2_source_r2_mismatch_gap(
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
            source_counts={},
            r2_counts={101: 3},
            source_partition_evidence=unavailable_evidence,
        ))

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

    def test_aqi_rebuild_origin_policy_keeps_fallback_and_distinguishes_dependency(self) -> None:
        self.assertTrue(
            MODULE._should_keep_aqi_rebuild(
                selected_observation_kind="observation_data_repair",
                origins=["observation_dependency"],
            )
        )
        self.assertFalse(
            MODULE._should_keep_aqi_rebuild(
                selected_observation_kind="source_mapping_issue",
                origins=["observation_dependency"],
            )
        )
        self.assertTrue(
            MODULE._should_keep_aqi_rebuild(
                selected_observation_kind=None,
                origins=["aqi_data_fault"],
            )
        )
        self.assertTrue(MODULE._should_keep_aqi_rebuild(selected_observation_kind=None, origins=[]))
        self.assertEqual(MODULE._normalize_aqi_rebuild_origins([]), ["unspecified"])
        self.assertEqual(
            MODULE._normalize_aqi_rebuild_origins(["observation_dependency", "aqi_data_fault"]),
            ["aqi_data_fault", "observation_dependency"],
        )

    def test_independent_aqi_only_rebuilds_survive_for_parquet_unreadable_and_zero_rows(self) -> None:
        for gap_type in ("parquet_unreadable", "data_partition_zero_rows"):
            with self.subTest(gap_type=gap_type):
                gap = MODULE._v2_aqi_gap(
                    gap_type,
                    day_utc="2026-06-11",
                    connector_id=1,
                    pollutant_code="pm25",
                    expected_path="manifest.json",
                )
                plan = MODULE.build_v2_repair_plan(aqi_gaps=[gap])
                aqi_actions = [action for action in plan if action["kind"] == "aqi_rebuild"]
                self.assertEqual(len(aqi_actions), 1)
                action = aqi_actions[0]
                self.assertEqual(action["aqi_rebuild_origins"], ["aqi_data_fault"])
                self.assertEqual(action["status"], "planned")
                self.assertFalse(action["executes"])
                self.assertTrue(action["data_changes_required"])
                self.assertTrue(action["requires_index_rebuild"])
                self.assertEqual(action["commands"], [])

    def test_o3_independent_aqi_fault_survives_without_observation_dependency(self) -> None:
        gap = MODULE._v2_aqi_gap(
            "parquet_unreadable",
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="o3",
            expected_path="manifest.json",
        )
        plan = MODULE.build_v2_repair_plan(aqi_gaps=[gap])
        aqi_actions = [action for action in plan if action["kind"] == "aqi_rebuild"]
        self.assertEqual(len(aqi_actions), 1)
        self.assertEqual(aqi_actions[0]["aqi_rebuild_origins"], ["aqi_data_fault"])
        self.assertEqual(aqi_actions[0]["pollutant_code"], "o3")

    def test_observation_triggered_aqi_rebuild_uses_observation_dependency_origin(self) -> None:
        gap = MODULE._v2_obs_gap(
            "data_manifest_missing",
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
        )
        plan = MODULE.build_v2_repair_plan(observation_gaps=[gap])
        aqi_actions = [action for action in plan if action["kind"] == "aqi_rebuild"]
        self.assertEqual(len(aqi_actions), 1)
        self.assertEqual(aqi_actions[0]["aqi_rebuild_origins"], ["observation_dependency"])
        self.assertEqual(aqi_actions[0]["status"], "planned")
        self.assertFalse(aqi_actions[0]["executes"])
        self.assertTrue(aqi_actions[0]["data_changes_required"])
        self.assertTrue(aqi_actions[0]["requires_index_rebuild"])

    def test_mixed_independent_and_dependent_aqi_rebuilds_merge_for_same_partition(self) -> None:
        observation_gap = MODULE._v2_obs_gap(
            "data_manifest_missing",
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
        )
        aqi_gap = MODULE._v2_aqi_gap(
            "parquet_unreadable",
            day_utc="2026-06-11",
            connector_id=1,
            pollutant_code="pm25",
            expected_path="manifest.json",
        )
        plan = MODULE.build_v2_repair_plan(observation_gaps=[observation_gap], aqi_gaps=[aqi_gap])
        aqi_actions = [action for action in plan if action["kind"] == "aqi_rebuild"]
        self.assertEqual(len(aqi_actions), 1)
        action = aqi_actions[0]
        self.assertEqual(action["aqi_rebuild_origins"], ["aqi_data_fault", "observation_dependency"])
        self.assertEqual(action["gap_types"], ["data_manifest_missing", "parquet_unreadable"])
        self.assertEqual(action["status"], "planned")
        self.assertFalse(action["executes"])
        self.assertTrue(action["data_changes_required"])
        self.assertTrue(action["requires_index_rebuild"])
        self.assertEqual(action["commands"], [])

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

    def test_required_field_helpers_accept_nulls_and_utc_equivalent_timestamps(self) -> None:
        gaps: list[dict[str, object]] = []
        MODULE._append_required_int_field_gap(
            gaps,
            gap_fn=MODULE._v2_obs_gap,
            gap_prefix="connector_manifest",
            payload={"min_timeseries_id": None},
            field="min_timeseries_id",
            day_utc="2026-06-11",
            connector_id=1,
            expected_path="manifest.json",
            expected_value=None,
        )
        MODULE._append_required_timestamp_field_gap(
            gaps,
            gap_fn=MODULE._v2_obs_gap,
            gap_prefix="connector_manifest",
            payload={"min_observed_at_utc": None},
            field="min_observed_at_utc",
            day_utc="2026-06-11",
            connector_id=1,
            expected_path="manifest.json",
            expected_value=None,
        )
        MODULE._append_required_timestamp_field_gap(
            gaps,
            gap_fn=MODULE._v2_aqi_gap,
            gap_prefix="connector_manifest",
            payload={"min_timestamp_hour_utc": "2026-06-11T01:00:00+01:00"},
            field="min_timestamp_hour_utc",
            day_utc="2026-06-11",
            connector_id=1,
            expected_path="manifest.json",
            expected_value="2026-06-11T00:00:00Z",
        )
        self.assertEqual([], gaps)

        malformed_gaps: list[dict[str, object]] = []
        MODULE._append_required_timestamp_field_gap(
            malformed_gaps,
            gap_fn=MODULE._v2_aqi_gap,
            gap_prefix="connector_manifest",
            payload={"min_timestamp_hour_utc": "not-a-timestamp"},
            field="min_timestamp_hour_utc",
            day_utc="2026-06-11",
            connector_id=1,
            expected_path="manifest.json",
            expected_value="2026-06-11T00:00:00Z",
        )
        self.assertIn(
            "connector_manifest_min_timestamp_hour_utc_schema_mismatch",
            {gap["gap_type"] for gap in malformed_gaps},
        )

    def test_parent_files_field_is_schema_mismatch(self) -> None:
        self._write_pollutant("observations", "o3", 1, 101)
        obs_connector_dir = self._partition("observations").parent
        obs_connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (obs_connector_dir / "manifest.json").write_text(json.dumps(obs_connector), encoding="utf-8")
        gaps: list[dict[str, object]] = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11",
            connector_dir=obs_connector_dir,
            day_dir=obs_connector_dir.parent,
            gaps=gaps,
            domain="observations",
        )
        connector_gap = next(gap for gap in gaps if gap["gap_type"] == "connector_manifest_schema_mismatch")
        self.assertIn("files", connector_gap["related_paths"])

        self._write_pollutant("aqilevels", "pm25", 1, 101)
        aqi_connector_dir = self._partition("aqilevels").parent
        aqi_connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["pm25"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_hour_utc": "2026-06-11T00:00:00Z",
            "max_timestamp_hour_utc": "2026-06-11T02:00:00Z",
            "files": [{"key": str((self._partition("aqilevels", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}}],
            "child_manifests": [{"pollutant_code": "pm25", "manifest_hash": "hash-pm25"}],
            "pollutant_manifests": [{"pollutant_code": "pm25", "manifest_hash": "hash-pm25"}],
        }
        (aqi_connector_dir / "manifest.json").write_text(json.dumps(aqi_connector), encoding="utf-8")
        aqi_day_dir = aqi_connector_dir.parent
        aqi_day = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_hour_utc": "2026-06-11T00:00:00Z",
            "max_timestamp_hour_utc": "2026-06-11T02:00:00Z",
            "files": "oops",
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (aqi_day_dir / "manifest.json").write_text(json.dumps(aqi_day), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.aqilevels_hourly_data_prefix,
            day_utc="2026-06-11",
            connector_dir=None,
            day_dir=aqi_day_dir,
            gaps=gaps,
            domain="aqilevels",
        )
        day_gap = next(gap for gap in gaps if gap["gap_type"] == "day_manifest_schema_mismatch")
        self.assertIn("files", day_gap["related_paths"])

    def test_healthy_observation_connector_parent(self) -> None:
        """Test that a healthy observation connector manifest passes validation."""
        child_o3 = self._write_pollutant("observations", "o3", 5, 101)
        child_pm25 = self._write_pollutant("observations", "pm25", 3, 202)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3", "pm25"],
            "row_count": 8,  # 5 + 3
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,  # 4 + 4
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("observations", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"pollutant_code": "o3", "manifest_hash": "hash-o3"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "pollutant_manifests": [
                {"pollutant_code": "o3", "manifest_hash": "hash-o3"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "manifest_hash": "connector-hash",
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        # Should have no gaps for a healthy connector
        self.assertEqual([], gaps)

    def test_healthy_observation_day_parent(self) -> None:
        """Test that a healthy observation day manifest passes validation."""
        child_o3 = self._write_pollutant("observations", "o3", 5, 101)
        child_pm25 = self._write_pollutant("observations", "pm25", 3, 202)
        connector_dir = self._partition("observations").parent
        # Create connector manifest
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3", "pm25"],
            "row_count": 8,
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("observations", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"pollutant_code": "o3", "manifest_hash": "hash-o3"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "pollutant_manifests": [
                {"pollutant_code": "o3", "manifest_hash": "hash-o3"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "manifest_hash": "connector-hash",
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")

        # Create day manifest
        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 8,
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("observations", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"connector_id": 1, "manifest_hash": "connector-hash"},
            ],
            "connector_manifests": [
                {"connector_id": 1, "manifest_hash": "connector-hash"},
            ],
            "manifest_hash": "day-hash",
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11",
            connector_dir=None,
            day_dir=day_dir,
            gaps=gaps,
            domain="observations",
        )
        # Should have no gaps for a healthy day
        self.assertEqual([], gaps)

    def test_missing_connector_row_count(self) -> None:
        """Test that missing row_count in connector manifest is detected as schema mismatch."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            # Missing row_count
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("connector_manifest_row_count_schema_mismatch", gap_types)

    def test_string_connector_file_count(self) -> None:
        """Test that string file_count in connector manifest is detected as schema mismatch."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": "1",  # String instead of int
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("connector_manifest_file_count_schema_mismatch", gap_types)

    def test_no_cross_domain_timestamp_requirement(self) -> None:
        """Test that observation domain doesn't require AQI timestamp fields."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            # No AQI timestamp fields - this should be OK for observations domain
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        # Should not have any timestamp-related gaps for observations domain
        timestamp_gaps = [gap for gap in gaps if "timestamp" in gap["gap_type"]]
        self.assertEqual([], timestamp_gaps, f"Unexpected timestamp gaps: {[gap['gap_type'] for gap in timestamp_gaps]}")

    def test_healthy_aqi_connector_parent(self) -> None:
        """Test that a healthy AQI connector manifest passes validation without observation timestamps."""
        child_pm25 = self._write_pollutant("aqilevels", "pm25", 5, 101)
        child_no2 = self._write_pollutant("aqilevels", "no2", 3, 202)
        connector_dir = self._partition("aqilevels").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["no2", "pm25"],
            "row_count": 8,
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_timestamp_hour_utc": "2026-06-11T00:00:00Z",
            "max_timestamp_hour_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("aqilevels", "no2") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("aqilevels", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"pollutant_code": "no2", "manifest_hash": "hash-no2"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "pollutant_manifests": [
                {"pollutant_code": "no2", "manifest_hash": "hash-no2"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "manifest_hash": "connector-hash",
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.aqilevels_hourly_data_prefix,
            day_utc="2026-06-11",
            connector_dir=connector_dir,
            day_dir=connector_dir.parent,
            gaps=gaps,
            domain="aqilevels",
        )
        self.assertEqual([], gaps)
        self.assertEqual([], [gap for gap in gaps if "observed_at" in gap["gap_type"]])

    def test_healthy_aqi_day_parent(self) -> None:
        """Test that a healthy AQI day manifest passes validation."""
        child_pm25 = self._write_pollutant("aqilevels", "pm25", 5, 101)
        child_no2 = self._write_pollutant("aqilevels", "no2", 3, 202)
        connector_dir = self._partition("aqilevels").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["no2", "pm25"],
            "row_count": 8,
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_timestamp_hour_utc": "2026-06-11T00:00:00Z",
            "max_timestamp_hour_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("aqilevels", "no2") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("aqilevels", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"pollutant_code": "no2", "manifest_hash": "hash-no2"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "pollutant_manifests": [
                {"pollutant_code": "no2", "manifest_hash": "hash-no2"},
                {"pollutant_code": "pm25", "manifest_hash": "hash-pm25"},
            ],
            "manifest_hash": "connector-hash",
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 8,
            "source_row_count": 8,
            "file_count": 2,
            "total_bytes": 8,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_timestamp_hour_utc": "2026-06-11T00:00:00Z",
            "max_timestamp_hour_utc": "2026-06-11T02:00:00Z",
            "files": [
                {"key": str((self._partition("aqilevels", "no2") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 5}},
                {"key": str((self._partition("aqilevels", "pm25") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"202": 3}},
            ],
            "child_manifests": [
                {"connector_id": 1, "manifest_hash": "connector-hash"},
            ],
            "connector_manifests": [
                {"connector_id": 1, "manifest_hash": "connector-hash"},
            ],
            "manifest_hash": "day-hash",
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.aqilevels_hourly_data_prefix,
            day_utc="2026-06-11",
            connector_dir=None,
            day_dir=day_dir,
            gaps=gaps,
            domain="aqilevels",
        )
        self.assertEqual([], gaps)

    def test_child_manifest_hash_missing_is_reported_for_observations_and_aqilevels(self) -> None:
        """Test that missing child manifest hashes are reported for both domains."""
        cases = (
            ("observations", "o3", 101),
            ("aqilevels", "pm25", 101),
        )
        for domain, pollutant, ts_id in cases:
            with self.subTest(domain=domain, pollutant=pollutant):
                self._write_pollutant(domain, pollutant, 1, ts_id)
                part = self._partition(domain, pollutant)
                child_manifest_path = part / "manifest.json"
                child_payload = json.loads(child_manifest_path.read_text(encoding="utf-8"))
                child_payload.pop("manifest_hash", None)
                child_manifest_path.write_text(json.dumps(child_payload), encoding="utf-8")

                connector_dir = part.parent
                connector_manifest = {
                    "manifest_kind": "connector",
                    "history_version": "v2",
                    "domain": domain,
                    "grain": "hourly" if domain == "aqilevels" else None,
                    "profile": "data" if domain == "aqilevels" else None,
                    "day_utc": "2026-06-11",
                    "connector_id": 1,
                    "pollutant_codes": [pollutant],
                    "row_count": 1,
                    "source_row_count": 1,
                    "file_count": 1,
                    "total_bytes": 4,
                    "min_timeseries_id": ts_id,
                    "max_timeseries_id": ts_id,
                    "min_observed_at_utc": "2026-06-11T00:00:00Z" if domain == "observations" else None,
                    "max_observed_at_utc": "2026-06-11T02:00:00Z" if domain == "observations" else None,
                    "min_timestamp_hour_utc": "2026-06-11T00:00:00Z" if domain == "aqilevels" else None,
                    "max_timestamp_hour_utc": "2026-06-11T02:00:00Z" if domain == "aqilevels" else None,
                    "files": [{
                        "key": str((part / "part-00000.parquet").relative_to(self.root)),
                        "bytes": 4,
                        "timeseries_row_counts": {str(ts_id): 1},
                    }],
                    "child_manifests": [{"pollutant_code": pollutant, "manifest_hash": f"hash-{pollutant}"}],
                    "pollutant_manifests": [{"pollutant_code": pollutant, "manifest_hash": f"hash-{pollutant}"}],
                    "manifest_hash": "connector-hash",
                }
                (connector_dir / "manifest.json").write_text(json.dumps(connector_manifest), encoding="utf-8")

                gaps = []
                MODULE._validate_v2_parent_hierarchy(
                    root=self.root,
                    data_prefix=(
                        self.config.observations_data_prefix
                        if domain == "observations"
                        else self.config.aqilevels_hourly_data_prefix
                    ),
                    day_utc="2026-06-11",
                    connector_dir=connector_dir,
                    day_dir=connector_dir.parent,
                    gaps=gaps,
                    domain=domain,
                )
                MODULE._classify_v2_gaps(gaps)
                gap_types = {gap["gap_type"] for gap in gaps}
                self.assertIn("data_manifest_manifest_hash_schema_mismatch", gap_types)
                self.assertTrue(
                    any(gap["fault_class"] == "pollutant manifest-only fault" for gap in gaps if gap["gap_type"] == "data_manifest_manifest_hash_schema_mismatch"),
                )
                self.assertNotIn("connector_manifest_child_manifests_child_hash_mismatch", gap_types)
                self.assertNotIn("connector_manifest_pollutant_manifests_child_hash_mismatch", gap_types)

    def test_parent_entry_manifest_hash_missing_is_reported_for_connector_and_day(self) -> None:
        """Test that missing parent child-entry hashes are reported for connector and day manifests."""
        cases = (
            ("observations", "connector", "child_manifests", "pollutant_manifests", "connector_manifest_child_manifests_manifest_hash_schema_mismatch"),
            ("observations", "day", "connector_manifests", "child_manifests", "day_manifest_connector_manifests_manifest_hash_schema_mismatch"),
            ("aqilevels", "connector", "child_manifests", "pollutant_manifests", "connector_manifest_child_manifests_manifest_hash_schema_mismatch"),
            ("aqilevels", "day", "connector_manifests", "child_manifests", "day_manifest_connector_manifests_manifest_hash_schema_mismatch"),
        )
        for domain, parent_level, missing_field, present_field, expected_gap_type in cases:
            with self.subTest(domain=domain, parent_level=parent_level):
                self._write_pollutant(domain, "o3" if domain == "observations" else "pm25", 1, 101)
                part = self._partition(domain, "o3" if domain == "observations" else "pm25")
                child_manifest = json.loads((part / "manifest.json").read_text(encoding="utf-8"))
                connector_dir = part.parent

                connector_manifest = {
                    "manifest_kind": "connector",
                    "history_version": "v2",
                    "domain": domain,
                    "grain": "hourly" if domain == "aqilevels" else None,
                    "profile": "data" if domain == "aqilevels" else None,
                    "day_utc": "2026-06-11",
                    "connector_id": 1,
                    "pollutant_codes": [child_manifest["pollutant_code"]],
                    "row_count": 1,
                    "source_row_count": 1,
                    "file_count": 1,
                    "total_bytes": 4,
                    "min_timeseries_id": 101,
                    "max_timeseries_id": 101,
                    "min_observed_at_utc": "2026-06-11T00:00:00Z" if domain == "observations" else None,
                    "max_observed_at_utc": "2026-06-11T02:00:00Z" if domain == "observations" else None,
                    "min_timestamp_hour_utc": "2026-06-11T00:00:00Z" if domain == "aqilevels" else None,
                    "max_timestamp_hour_utc": "2026-06-11T02:00:00Z" if domain == "aqilevels" else None,
                    "files": [{
                        "key": str((part / "part-00000.parquet").relative_to(self.root)),
                        "bytes": 4,
                        "timeseries_row_counts": {"101": 1},
                    }],
                    missing_field: [{"pollutant_code": child_manifest["pollutant_code"]}],
                    present_field: [{"pollutant_code": child_manifest["pollutant_code"], "manifest_hash": child_manifest["manifest_hash"]}],
                    "manifest_hash": "connector-hash",
                }
                (connector_dir / "manifest.json").write_text(json.dumps(connector_manifest), encoding="utf-8")

                day_dir = connector_dir.parent
                day_manifest = {
                    "manifest_kind": "day",
                    "history_version": "v2",
                    "domain": domain,
                    "grain": "hourly" if domain == "aqilevels" else None,
                    "profile": "data" if domain == "aqilevels" else None,
                    "day_utc": "2026-06-11",
                    "connector_ids": [1],
                    "row_count": 1,
                    "source_row_count": 1,
                    "file_count": 1,
                    "total_bytes": 4,
                    "min_timeseries_id": 101,
                    "max_timeseries_id": 101,
                    "min_observed_at_utc": "2026-06-11T00:00:00Z" if domain == "observations" else None,
                    "max_observed_at_utc": "2026-06-11T02:00:00Z" if domain == "observations" else None,
                    "min_timestamp_hour_utc": "2026-06-11T00:00:00Z" if domain == "aqilevels" else None,
                    "max_timestamp_hour_utc": "2026-06-11T02:00:00Z" if domain == "aqilevels" else None,
                    "files": [{
                        "key": str((part / "part-00000.parquet").relative_to(self.root)),
                        "bytes": 4,
                        "timeseries_row_counts": {"101": 1},
                    }],
                    "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
                    "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
                    "manifest_hash": "day-hash",
                }
                if parent_level == "day":
                    day_manifest[missing_field] = [{"connector_id": 1}]
                    day_manifest[present_field] = [{"connector_id": 1, "manifest_hash": "connector-hash"}]
                    (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
                else:
                    (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")

                gaps = []
                MODULE._validate_v2_parent_hierarchy(
                    root=self.root,
                    data_prefix=(
                        self.config.observations_data_prefix
                        if domain == "observations"
                        else self.config.aqilevels_hourly_data_prefix
                    ),
                    day_utc="2026-06-11",
                    connector_dir=connector_dir,
                    day_dir=day_dir,
                    gaps=gaps,
                    domain=domain,
                )
                if parent_level == "day":
                    MODULE._validate_v2_parent_hierarchy(
                        root=self.root,
                        data_prefix=(
                            self.config.observations_data_prefix
                            if domain == "observations"
                            else self.config.aqilevels_hourly_data_prefix
                        ),
                        day_utc="2026-06-11",
                        connector_dir=None,
                        day_dir=day_dir,
                        gaps=gaps,
                        domain=domain,
                    )
                gap_types = {gap["gap_type"] for gap in gaps}
                self.assertIn(expected_gap_type, gap_types)
                self.assertNotIn(expected_gap_type.replace("manifest_hash_schema_mismatch", "child_hash_mismatch"), gap_types)

    def test_parent_entry_stored_hash_mismatch_is_reported_for_connector_and_day(self) -> None:
        """Test that stored parent/child hash mismatches are reported for connector and day manifests."""
        cases = (
            ("observations", "connector", "child_manifests", "pollutant_manifests", "connector_manifest_child_manifests_child_hash_mismatch"),
            ("observations", "day", "connector_manifests", "child_manifests", "day_manifest_connector_manifests_child_hash_mismatch"),
            ("aqilevels", "connector", "child_manifests", "pollutant_manifests", "connector_manifest_child_manifests_child_hash_mismatch"),
            ("aqilevels", "day", "connector_manifests", "child_manifests", "day_manifest_connector_manifests_child_hash_mismatch"),
        )
        for domain, parent_level, mismatched_field, matching_field, expected_gap_type in cases:
            with self.subTest(domain=domain, parent_level=parent_level):
                self._write_pollutant(domain, "o3" if domain == "observations" else "pm25", 1, 101)
                part = self._partition(domain, "o3" if domain == "observations" else "pm25")
                child_manifest = json.loads((part / "manifest.json").read_text(encoding="utf-8"))
                connector_dir = part.parent

                connector_manifest = {
                    "manifest_kind": "connector",
                    "history_version": "v2",
                    "domain": domain,
                    "grain": "hourly" if domain == "aqilevels" else None,
                    "profile": "data" if domain == "aqilevels" else None,
                    "day_utc": "2026-06-11",
                    "connector_id": 1,
                    "pollutant_codes": [child_manifest["pollutant_code"]],
                    "row_count": 1,
                    "source_row_count": 1,
                    "file_count": 1,
                    "total_bytes": 4,
                    "min_timeseries_id": 101,
                    "max_timeseries_id": 101,
                    "min_observed_at_utc": "2026-06-11T00:00:00Z" if domain == "observations" else None,
                    "max_observed_at_utc": "2026-06-11T02:00:00Z" if domain == "observations" else None,
                    "min_timestamp_hour_utc": "2026-06-11T00:00:00Z" if domain == "aqilevels" else None,
                    "max_timestamp_hour_utc": "2026-06-11T02:00:00Z" if domain == "aqilevels" else None,
                    "files": [{
                        "key": str((part / "part-00000.parquet").relative_to(self.root)),
                        "bytes": 4,
                        "timeseries_row_counts": {"101": 1},
                    }],
                    mismatched_field: [{"pollutant_code": child_manifest["pollutant_code"], "manifest_hash": "wrong"}],
                    matching_field: [{"pollutant_code": child_manifest["pollutant_code"], "manifest_hash": child_manifest["manifest_hash"]}],
                    "manifest_hash": "connector-hash",
                }
                (connector_dir / "manifest.json").write_text(json.dumps(connector_manifest), encoding="utf-8")

                day_dir = connector_dir.parent
                day_manifest = {
                    "manifest_kind": "day",
                    "history_version": "v2",
                    "domain": domain,
                    "grain": "hourly" if domain == "aqilevels" else None,
                    "profile": "data" if domain == "aqilevels" else None,
                    "day_utc": "2026-06-11",
                    "connector_ids": [1],
                    "row_count": 1,
                    "source_row_count": 1,
                    "file_count": 1,
                    "total_bytes": 4,
                    "min_timeseries_id": 101,
                    "max_timeseries_id": 101,
                    "min_observed_at_utc": "2026-06-11T00:00:00Z" if domain == "observations" else None,
                    "max_observed_at_utc": "2026-06-11T02:00:00Z" if domain == "observations" else None,
                    "min_timestamp_hour_utc": "2026-06-11T00:00:00Z" if domain == "aqilevels" else None,
                    "max_timestamp_hour_utc": "2026-06-11T02:00:00Z" if domain == "aqilevels" else None,
                    "files": [{
                        "key": str((part / "part-00000.parquet").relative_to(self.root)),
                        "bytes": 4,
                        "timeseries_row_counts": {"101": 1},
                    }],
                    "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
                    "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
                    "manifest_hash": "day-hash",
                }
                if parent_level == "day":
                    day_manifest[mismatched_field] = [{"connector_id": 1, "manifest_hash": "wrong"}]
                    day_manifest[matching_field] = [{"connector_id": 1, "manifest_hash": "connector-hash"}]
                (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")

                gaps = []
                MODULE._validate_v2_parent_hierarchy(
                    root=self.root,
                    data_prefix=(
                        self.config.observations_data_prefix
                        if domain == "observations"
                        else self.config.aqilevels_hourly_data_prefix
                    ),
                    day_utc="2026-06-11",
                    connector_dir=connector_dir,
                    day_dir=day_dir,
                    gaps=gaps,
                    domain=domain,
                )
                if parent_level == "day":
                    MODULE._validate_v2_parent_hierarchy(
                        root=self.root,
                        data_prefix=(
                            self.config.observations_data_prefix
                            if domain == "observations"
                            else self.config.aqilevels_hourly_data_prefix
                        ),
                        day_utc="2026-06-11",
                        connector_dir=None,
                        day_dir=day_dir,
                        gaps=gaps,
                        domain=domain,
                    )
                gap_types = {gap["gap_type"] for gap in gaps}
                self.assertIn(expected_gap_type, gap_types)
                self.assertNotIn(expected_gap_type.replace("child_hash_mismatch", "manifest_hash_schema_mismatch"), gap_types)

    def test_missing_day_file_count(self) -> None:
        """Test that missing file_count in day manifest is detected as schema mismatch."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            # Missing file_count
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")

        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 1,
            "source_row_count": 1,
            # Missing file_count
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11",
            connector_dir=None,
            day_dir=day_dir,
            gaps=gaps,
            domain="observations",
        )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("day_manifest_file_count_schema_mismatch", gap_types)

    def test_missing_day_total_bytes(self) -> None:
        """Test that missing total_bytes in day manifest is detected as schema mismatch."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")

        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            # Missing total_bytes
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        gaps = []
        MODULE._validate_v2_parent_hierarchy(
            root=self.root,
            data_prefix=self.config.observations_data_prefix,
            day_utc="2026-06-11",
            connector_dir=None,
            day_dir=day_dir,
            gaps=gaps,
            domain="observations",
        )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("day_manifest_total_bytes_schema_mismatch", gap_types)

    def test_missing_pollutant_required_fields(self) -> None:
        """Test that required pollutant manifest fields are reported when absent."""
        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        base_payload = self._manifest("observations", "o3", key, 1, 101)
        stats = {
            "row_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
            "file_count": 1,
            "total_bytes": 4,
        }
        cases = [
            ("files", "data_manifest_schema_mismatch"),
            ("file_count", "data_manifest_file_count_schema_mismatch"),
            ("total_bytes", "data_manifest_total_bytes_schema_mismatch"),
            ("timeseries_row_counts", "data_manifest_schema_mismatch"),
        ]
        for field, expected_gap in cases:
            with self.subTest(field=field):
                payload = json.loads(json.dumps(base_payload))
                payload.pop(field, None)
                gaps = []
                with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
                    MODULE._append_actual_parquet_gaps(
                        gaps,
                        domain="observations",
                        day_utc="2026-06-11",
                        connector_id=1,
                        pollutant_code="o3",
                        manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                        payload=payload,
                        parquet_files=[self.root / key],
                    )
                gap_types = {gap["gap_type"] for gap in gaps}
                self.assertIn(expected_gap, gap_types)

    def test_missing_required_min_max_fields(self) -> None:
        """Test that required min/max fields are reported when absent."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("connector_manifest_min_timeseries_id_schema_mismatch", gap_types)
        self.assertIn("connector_manifest_max_timeseries_id_schema_mismatch", gap_types)

        part = self._partition("aqilevels", "pm25")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        payload = self._manifest("aqilevels", "pm25", key, 1, 101)
        payload.pop("min_timeseries_id", None)
        payload.pop("max_timeseries_id", None)
        stats = {
            "row_count": 1,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps,
                domain="aqilevels",
                day_utc="2026-06-11",
                connector_id=1,
                pollutant_code="pm25",
                manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload,
                parquet_files=[self.root / key],
            )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_manifest_min_timeseries_id_schema_mismatch", gap_types)
        self.assertIn("data_manifest_max_timeseries_id_schema_mismatch", gap_types)

    def test_missing_required_domain_timestamp_fields(self) -> None:
        """Test that required domain timestamp fields are reported when absent."""
        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        payload = self._manifest("observations", "o3", key, 1, 101)
        payload.pop("min_observed_at_utc", None)
        payload.pop("max_observed_at_utc", None)
        stats = {
            "row_count": 1,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps,
                domain="observations",
                day_utc="2026-06-11",
                connector_id=1,
                pollutant_code="o3",
                manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload,
                parquet_files=[self.root / key],
            )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_manifest_min_observed_at_utc_schema_mismatch", gap_types)
        self.assertIn("data_manifest_max_observed_at_utc_schema_mismatch", gap_types)

        part = self._partition("aqilevels", "pm25")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        payload = self._manifest("aqilevels", "pm25", key, 1, 101)
        payload.pop("min_timestamp_hour_utc", None)
        payload.pop("max_timestamp_hour_utc", None)
        stats = {
            "row_count": 1,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps,
                domain="aqilevels",
                day_utc="2026-06-11",
                connector_id=1,
                pollutant_code="pm25",
                manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload,
                parquet_files=[self.root / key],
            )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_manifest_min_timestamp_hour_utc_schema_mismatch", gap_types)
        self.assertIn("data_manifest_max_timestamp_hour_utc_schema_mismatch", gap_types)

    def test_duplicate_gaps_are_not_emitted(self) -> None:
        """Test that duplicate min/max and empty-count gaps are not emitted."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
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
        self.assertEqual(
            1,
            sum(1 for gap in gaps if gap["gap_type"] == "connector_manifest_min_timeseries_id_schema_mismatch"),
        )
        self.assertEqual(
            1,
            sum(1 for gap in gaps if gap["gap_type"] == "connector_manifest_max_timeseries_id_schema_mismatch"),
        )

        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        payload = self._manifest("observations", "o3", key, 1, 101)
        payload["timeseries_row_counts"] = {}
        payload["files"][0]["timeseries_row_counts"] = {}
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
        stats = {
            "row_count": 1,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        latest_index_path = self.root / self.config.observations_latest_index_key.strip("/")
        latest_index_path.parent.mkdir(parents=True, exist_ok=True)
        latest_index_path.write_text(json.dumps({"timeseries_row_counts": {"101": 1}}), encoding="utf-8")
        index_rel = f"{self.config.observations_timeseries_index_prefix.strip('/')}/day_utc=2026-06-11/connector_id=1/pollutant_code=o3/manifest.json"
        index_path = self.root / index_rel
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps({"timeseries_row_counts": {"101": 1}}), encoding="utf-8")
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            result = MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.root,
                config=self.config,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )
        gap_types = [gap["gap_type"] for gap in result["gaps"]]
        self.assertEqual(1, gap_types.count("data_manifest_empty_timeseries_counts"))

    def test_index_manifest_terminology_remains_unchanged(self) -> None:
        """Test that index-manifest gaps keep index terminology, not data-manifest terminology."""
        child = self._write_pollutant("observations", "o3", 1, 101)
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 1,
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "files": [
                {"key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)), "bytes": 4, "timeseries_row_counts": {"101": 1}},
            ],
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        latest_index_path = self.root / self.config.observations_latest_index_key.strip("/")
        latest_index_path.parent.mkdir(parents=True, exist_ok=True)
        latest_index_path.write_text(json.dumps({"timeseries_row_counts": {"101": 1}}), encoding="utf-8")
        index_rel = f"{self.config.observations_timeseries_index_prefix.strip('/')}/day_utc=2026-06-11/connector_id=1/pollutant_code=o3/manifest.json"
        index_path = self.root / index_rel
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps({"timeseries_row_counts": {}}), encoding="utf-8")
        stats = {
            "row_count": 1,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            result = MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.root,
                config=self.config,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )
        gap_types = [gap["gap_type"] for gap in result["gaps"]]
        self.assertIn("index_manifest_empty_timeseries_counts", gap_types)
        self.assertNotIn("data_manifest_empty_timeseries_counts", gap_types)

    def test_parquet_null_timeseries_id_rows_are_emitted_and_classified_as_data_fault(self) -> None:
        """Test that parquet null timeseries rows are emitted and classified as a data fault."""
        child = self._write_pollutant("observations", "o3", 2, 101)
        child["row_count"] = 3
        child["source_row_count"] = 3
        child["min_timeseries_id"] = 101
        child["max_timeseries_id"] = 202
        child["timeseries_row_counts"] = {"101": 1, "202": 1}
        child["files"] = [{
            "key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)),
            "bytes": 4,
            "timeseries_row_counts": {"101": 1, "202": 1},
        }]
        (self._partition("observations") / "manifest.json").write_text(json.dumps(child), encoding="utf-8")
        connector_dir = self._partition("observations").parent
        connector = {
            "manifest_kind": "connector",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_codes": ["o3"],
            "row_count": 3,
            "source_row_count": 3,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "files": [{
                "key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)),
                "bytes": 4,
                "timeseries_row_counts": {"101": 1, "202": 1},
            }],
            "child_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
            "pollutant_manifests": [{"pollutant_code": "o3", "manifest_hash": "hash-o3"}],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        day_dir = connector_dir.parent
        day_manifest = {
            "manifest_kind": "day",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_ids": [1],
            "row_count": 3,
            "source_row_count": 3,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "files": [{
                "key": str((self._partition("observations", "o3") / "part-00000.parquet").relative_to(self.root)),
                "bytes": 4,
                "timeseries_row_counts": {"101": 1, "202": 1},
            }],
            "child_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
            "connector_manifests": [{"connector_id": 1, "manifest_hash": "connector-hash"}],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day_manifest), encoding="utf-8")
        latest_index_path = self.root / self.config.observations_latest_index_key.strip("/")
        latest_index_path.parent.mkdir(parents=True, exist_ok=True)
        latest_index_path.write_text(json.dumps({"timeseries_row_counts": {"101": 1, "202": 1}}), encoding="utf-8")
        index_rel = f"{self.config.observations_timeseries_index_prefix.strip('/')}/day_utc=2026-06-11/connector_id=1/pollutant_code=o3/manifest.json"
        index_path = self.root / index_rel
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps({"timeseries_row_counts": {"101": 1, "202": 1}}), encoding="utf-8")
        stats = {
            "row_count": 3,
            "non_null_timeseries_count": 2,
            "timeseries_row_counts": {101: 1, 202: 1},
            "null_timeseries_count": 1,
            "min_timeseries_id": 101,
            "max_timeseries_id": 202,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": True,
        }
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            result = MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.root,
                config=self.config,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )
        gap_types = {gap["gap_type"] for gap in result["gaps"]}
        self.assertIn("parquet_null_timeseries_id_rows", gap_types)
        null_gap = next(gap for gap in result["gaps"] if gap["gap_type"] == "parquet_null_timeseries_id_rows")
        self.assertEqual("data fault", null_gap["fault_class"])

    def test_missing_pollutant_row_count(self) -> None:
        """Test that missing row_count in pollutant manifest is detected."""
        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        # Create pollutant manifest without row_count
        payload = {
            "manifest_kind": "pollutant",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_code": "o3",
            "pollutant_codes": ["o3"],
            # Missing row_count
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "timeseries_row_counts": {"101": 1},
            "files": [{"key": key, "bytes": 4, "timeseries_row_counts": {"101": 1}}],
        }
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")

        stats = {
            "row_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
            "file_count": 1,
            "total_bytes": 4,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps, domain="observations", day_utc="2026-06-11", connector_id=1,
                pollutant_code="o3", manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload, parquet_files=[self.root / key],
            )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_manifest_row_count_schema_mismatch", gap_types)

    def test_invalid_pollutant_row_count(self) -> None:
        """Test that invalid (string) row_count in pollutant manifest is detected."""
        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        (self.root / key).write_bytes(b"PAR1")
        # Create pollutant manifest with string row_count
        payload = {
            "manifest_kind": "pollutant",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_code": "o3",
            "pollutant_codes": ["o3"],
            "row_count": "1",  # String instead of int
            "source_row_count": 1,
            "file_count": 1,
            "total_bytes": 4,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_observed_at_utc": "2026-06-11T00:00:00Z",
            "max_observed_at_utc": "2026-06-11T02:00:00Z",
            "timeseries_row_counts": {"101": 1},
            "files": [{"key": key, "bytes": 4, "timeseries_row_counts": {"101": 1}}],
        }
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")

        stats = {
            "row_count": 1,
            "timeseries_row_counts": {101: 1},
            "null_timeseries_count": 0,
            "min_timeseries_id": 101,
            "max_timeseries_id": 101,
            "min_timestamp_utc": "2026-06-11T00:00:00+00",
            "max_timestamp_utc": "2026-06-11T02:00:00+00",
            "parquet_null_timeseries_id_rows": False,
            "file_count": 1,
            "total_bytes": 4,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps, domain="observations", day_utc="2026-06-11", connector_id=1,
                pollutant_code="o3", manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload, parquet_files=[self.root / key],
            )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_manifest_row_count_schema_mismatch", gap_types)

    def test_genuine_zero_pollutant_row_count(self) -> None:
        """Test that genuine zero row_count in a pollutant manifest is reported at the pollutant level."""
        part = self._partition("observations", "o3")
        part.mkdir(parents=True, exist_ok=True)
        key = str((part / "part-00000.parquet").relative_to(self.root))
        # Create a zero-row pollutant manifest without any parquet files.
        payload = {
            "manifest_kind": "pollutant",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": "2026-06-11",
            "connector_id": 1,
            "pollutant_code": "o3",
            "pollutant_codes": ["o3"],
            "row_count": 0,  # Genuine zero
            "source_row_count": 0,
            "file_count": 0,
            "total_bytes": 0,
            "min_timeseries_id": None,
            "max_timeseries_id": None,
            "min_observed_at_utc": None,
            "max_observed_at_utc": None,
            "timeseries_row_counts": {},
            "files": [],
        }
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")

        stats = {
            "row_count": 0,
            "timeseries_row_counts": {},
            "null_timeseries_count": 0,
            "min_timeseries_id": None,
            "max_timeseries_id": None,
            "min_timestamp_utc": None,
            "max_timestamp_utc": None,
            "parquet_null_timeseries_id_rows": False,
            "file_count": 0,
            "total_bytes": 0,
        }
        gaps = []
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            MODULE._append_actual_parquet_gaps(
                gaps, domain="observations", day_utc="2026-06-11", connector_id=1,
                pollutant_code="o3", manifest_rel=str((part / "manifest.json").relative_to(self.root)),
                payload=payload, parquet_files=[self.root / key],
        )
        gap_types = {gap["gap_type"] for gap in gaps}
        self.assertIn("data_partition_zero_rows", gap_types)
        self.assertNotIn("data_manifest_empty_timeseries_counts", gap_types)
        schema_mismatch_gaps = [gap for gap in gaps if "schema_mismatch" in gap["gap_type"]]
        self.assertEqual([], schema_mismatch_gaps, f"Unexpected schema mismatch gaps: {[gap['gap_type'] for gap in schema_mismatch_gaps]}")


if __name__ == "__main__":
    unittest.main()
