#!/usr/bin/env python3
"""History-version path handling tests for uk-aq-history-integrity."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HistoryVersionPathTests(unittest.TestCase):
    def test_default_history_version_is_v1(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(MODULE.resolve_history_version_mode(Namespace(history_version=None)), "v1")

    def test_env_history_version_fallback(self) -> None:
        with patch.dict(os.environ, {"UK_AQ_R2_HISTORY_INTEGRITY_VERSION": "both"}, clear=True):
            self.assertEqual(MODULE.resolve_history_version_mode(Namespace(history_version=None)), "both")

    def test_both_expands_to_v1_and_v2(self) -> None:
        self.assertEqual(MODULE.expand_history_versions("both"), ["v1", "v2"])

    def test_v1_path_defaults(self) -> None:
        config = MODULE.resolve_history_path_config("v1", {})
        self.assertEqual(config.observations_data_prefix, "history/v1/observations")
        self.assertEqual(config.aqilevels_hourly_data_prefix, "history/v1/aqilevels/hourly")
        self.assertEqual(config.observations_timeseries_index_prefix, "history/_index/observations_timeseries")
        self.assertEqual(config.aqilevels_timeseries_index_prefix, "history/_index/aqilevels_timeseries")
        self.assertTrue(config.checks_implemented)

    def test_v2_path_defaults(self) -> None:
        config = MODULE.resolve_history_path_config("v2", {})
        self.assertEqual(config.observations_data_prefix, "history/v2/observations")
        self.assertEqual(config.aqilevels_hourly_data_prefix, "history/v2/aqilevels/hourly/data")
        self.assertEqual(config.aqilevels_hourly_debug_prefix, "history/v2/aqilevels/hourly/debug")
        self.assertEqual(config.observations_timeseries_index_prefix, "history/_index_v2/observations_timeseries")
        self.assertEqual(config.aqilevels_timeseries_index_prefix, "history/_index_v2/aqilevels_hourly_data_timeseries")
        self.assertTrue(config.checks_implemented)

    def test_executed_script_resolves_v2_core_preflight_path(self) -> None:
        env = {
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT": "/tmp/R2_history_backup",
            "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT": "/tmp/R2_history_backup/history/v1/core",
        }
        self.assertEqual(MODULE.resolve_core_history_version_for_mode("v2"), "v2")
        self.assertEqual(MODULE.resolve_core_snapshot_prefix("v2", env), "history/v2/core")
        self.assertEqual(
            MODULE.resolve_core_snapshot_root("v2", env),
            "/tmp/R2_history_backup/history/v2/core",
        )

    def test_v2_uses_shared_env_overrides(self) -> None:
        env = {
            "UK_AQ_R2_HISTORY_INDEX_V2_PREFIX": "custom/_index_v2",
            "UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX": "custom/v2/observations",
            "UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX": "custom/v2/aqi/data",
        }
        config = MODULE.resolve_history_path_config("v2", env)
        self.assertEqual(config.observations_data_prefix, "custom/v2/observations")
        self.assertEqual(config.aqilevels_hourly_data_prefix, "custom/v2/aqi/data")
        self.assertEqual(config.observations_timeseries_index_prefix, "custom/_index_v2/observations_timeseries")
        self.assertEqual(config.aqilevels_timeseries_index_prefix, "custom/_index_v2/aqilevels_hourly_data_timeseries")

    def test_backfill_env_file_loads_shared_history_vars_without_overriding_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / "backfill.env"
            env_path.write_text(
                "UK_AQ_R2_HISTORY_VERSION=v2\n"
                "UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX=from-file/v2/observations\n"
                "UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX=from-file/v2/aqi/data\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "UK_AQ_BACKFILL_ENV_FILE": str(env_path),
                    "UK_AQ_R2_HISTORY_VERSION": "v1",
                },
                clear=True,
            ):
                result = MODULE.load_backfill_env_file_if_set()
                self.assertTrue(result["loaded"])
                self.assertEqual(os.environ["UK_AQ_R2_HISTORY_VERSION"], "v1")
                self.assertEqual(
                    os.environ["UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX"],
                    "from-file/v2/observations",
                )
                self.assertIn("UK_AQ_R2_HISTORY_VERSION", result["shared_history_keys"])
                self.assertIn("UK_AQ_R2_HISTORY_VERSION", result["skipped_existing_keys"])

    def test_open_db_adds_history_version_columns_for_persistent_history_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "integrity.sqlite"
            conn = MODULE.open_db(str(db_path))
            try:
                cross_check_columns = {
                    row[1] for row in conn.execute("PRAGMA table_info(cross_checks)")
                }
                queue_columns = {
                    row[1] for row in conn.execute("PRAGMA table_info(aqi_rebuild_queue)")
                }
            finally:
                conn.close()
            self.assertIn("history_version", cross_check_columns)
            self.assertIn("history_version", queue_columns)
            self.assertIn("domain", queue_columns)
            self.assertIn("profile", queue_columns)
            self.assertIn("pollutant_code", queue_columns)
            self.assertIn("source_observations_version", queue_columns)

    def test_invalid_history_version_rejects(self) -> None:
        with self.assertRaises(ValueError):
            MODULE.expand_history_versions("v3")
        with self.assertRaises(ValueError):
            MODULE.resolve_history_version_mode(Namespace(history_version="latest"))

    def test_report_metadata_includes_checked_versions_and_v2_not_healthy(self) -> None:
        summary = {
            "env": "CIC-Test",
            "profile": "manual",
            "started_at_utc": "2026-06-20T00:00:00Z",
            "finished_at_utc": "2026-06-20T00:01:00Z",
            "status": "ok",
            "source": "all",
            "from_day": "2026-06-11",
            "to_day": "2026-06-11",
            "dry_run": False,
            "check_only": True,
            "run_backfill": False,
            "db_path": ":memory:",
            "log_path": "test.log",
            "history_integrity_schema_version": 2,
            "history_version_mode": "both",
            "checked_versions": ["v1", "v2"],
            "site_read_version": "v2",
            "history_path_configs": MODULE.serialize_history_path_configs(
                MODULE.resolve_history_path_configs("both", {})
            ),
            "cross_check": {
                "ran": True,
                "cross_checks_total": 0,
                "additional_history_versions": {
                    "v2": {"status": "not_implemented_phase1"},
                },
            },
        }
        markdown = MODULE.format_summary_md(summary)
        self.assertIn("## R2 Cross-check — v1", markdown)
        self.assertIn("## R2 Cross-check — v2", markdown)
        self.assertIn("V2 observations checks: implemented", markdown)
        self.assertIn("## v1/v2 comparison", markdown)
        self.assertIn("Full comparison: not implemented until Phase 5", markdown)

    def test_existing_v1_path_env_behavior_is_preserved(self) -> None:
        env = {
            "UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX": "custom/v1/observations",
            "UK_AQ_R2_HISTORY_AQILEVELS_PREFIX": "custom/v1/aqilevels/hourly",
            "UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX": "custom/_index/observations_timeseries",
        }
        config = MODULE.resolve_history_path_config("v1", env)
        self.assertEqual(config.observations_data_prefix, "custom/v1/observations")
        self.assertEqual(config.aqilevels_hourly_data_prefix, "custom/v1/aqilevels/hourly")
        self.assertEqual(config.observations_timeseries_index_prefix, "custom/_index/observations_timeseries")

    def test_v2_only_failed_report_writes_without_v1_config(self) -> None:
        v2_gap = {
            "history_version": "v2",
            "domain": "observations",
            "severity": "error",
            "gap_type": "missing_partition",
            "day_utc": "2026-06-08",
            "connector_id": 123,
            "pollutant_code": "pm25",
            "expected_path": "history/v2/observations/day_utc=2026-06-08/connector_id=123/pollutant_code=pm25/data.parquet",
            "suggested_repair": {
                "kind": "repair_observations_partition",
                "requires_index_rebuild": True,
            },
        }
        history_path_configs = MODULE.serialize_history_path_configs(
            MODULE.resolve_history_path_configs("v2", {})
        )
        summary = {
            "env": "CIC-Test",
            "profile": "manual",
            "started_at_utc": "2026-06-20T00:00:00Z",
            "finished_at_utc": "2026-06-20T00:01:00Z",
            "status": "fail",
            "source": "openaq",
            "from_day": "2026-06-08",
            "to_day": "2026-06-08",
            "dry_run": False,
            "check_only": True,
            "run_backfill": False,
            "db_path": ":memory:",
            "log_path": "test.log",
            "history_integrity_schema_version": 2,
            "history_version_mode": "v2",
            "checked_versions": ["v2"],
            "site_read_version": None,
            "history_path_configs": history_path_configs,
            "history_version_results": {
                "v2": {
                    "history_version": "v2",
                    "checks_implemented": True,
                    "status": "fail",
                    "observations": {
                        "status": "fail",
                        "checked_partitions": 8,
                        "gap_count": 1,
                        "gaps": [v2_gap],
                    },
                    "aqilevels": {
                        "status": "ok",
                        "checked_partitions": 7,
                        "gap_count": 0,
                        "gaps": [],
                        "debug": {
                            "checked": False,
                            "required": False,
                            "status": "skipped",
                            "gap_count": 0,
                            "gaps": [],
                        },
                    },
                }
            },
            "cross_check": {
                "ran": True,
                "history_version": "v2",
                "v2_observations": {
                    "status": "fail",
                    "checked_partitions": 8,
                    "gap_count": 1,
                    "gaps": [v2_gap],
                },
                "v2_aqilevels": {
                    "status": "ok",
                    "checked_partitions": 7,
                    "gap_count": 0,
                    "gaps": [],
                    "debug": {"checked": False, "required": False, "gap_count": 0, "gaps": []},
                },
                "cross_checks_total": 15,
                "cross_checks_ok": 0,
                "cross_checks_mismatch": 1,
            },
            "metrics": {},
        }

        self.assertEqual(summary["checked_versions"], ["v2"])
        self.assertEqual(list(summary["history_path_configs"].keys()), ["v2"])
        self.assertEqual(summary["status"], "fail")
        with tempfile.TemporaryDirectory() as tmp:
            json_path, md_path = MODULE.write_reports(tmp, "20260620T000000Z", summary)
            self.assertTrue(json_path.is_file())
            markdown = md_path.read_text(encoding="utf-8")
        self.assertIn("## R2 Cross-check — history_version=v2", markdown)
        self.assertIn("### V2 observation gaps", markdown)
        self.assertIn("repair_observations_partition", markdown)
        self.assertIn("history/v2/observations/day_utc=2026-06-08", markdown)
        self.assertNotIn("history_version=v1", markdown)

    def test_no_direct_v1_history_config_lookup_remains(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('history_path_configs["v1"]', source)


class CoreSnapshotVersionPathTests(unittest.TestCase):
    def test_v1_integrity_resolves_core_snapshot_root_to_v1_core(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup"
            env = {"UK_AQ_R2_HISTORY_DROPBOX_ROOT": str(root)}
            self.assertEqual(
                MODULE.resolve_core_snapshot_root("v1", env),
                str(root / "history/v1/core"),
            )
            self.assertEqual(MODULE.resolve_core_snapshot_prefix("v1", env), "history/v1/core")

    def test_v2_integrity_resolves_core_snapshot_root_to_v2_core(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup"
            env = {"UK_AQ_R2_HISTORY_DROPBOX_ROOT": str(root)}
            self.assertEqual(
                MODULE.resolve_core_snapshot_root("v2", env),
                str(root / "history/v2/core"),
            )
            self.assertEqual(MODULE.resolve_core_snapshot_prefix("v2", env), "history/v2/core")

    def test_v2_integrity_does_not_silently_fall_back_to_v1_core(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            explicit_v1 = Path(tmp) / "R2_history_backup" / "history/v1/core"
            env = {"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT": str(explicit_v1)}
            resolved = MODULE.resolve_core_snapshot_root("v2", env)
            self.assertTrue(resolved.endswith("R2_history_backup/history/v2/core"))
            self.assertNotIn("history/v1/core", resolved)

    def test_v2_missing_core_snapshot_reports_clear_missing_status(self) -> None:
        status = MODULE.classify_core_snapshot_status(
            {"status": "no_snapshot", "snapshot_day_utc": None},
            history_version="v2",
            expected_day="2026-06-20",
        )
        self.assertEqual(status, "v2_core_snapshot_missing")

    def test_v2_stale_core_snapshot_reports_clear_stale_status(self) -> None:
        status = MODULE.classify_core_snapshot_status(
            {"status": "reused", "snapshot_day_utc": "2026-06-16"},
            history_version="v2",
            expected_day="2026-06-20",
        )
        self.assertEqual(status, "v2_core_snapshot_stale")

    def test_report_includes_core_version_prefix_root_and_status(self) -> None:
        markdown = MODULE.format_summary_md({
            "env": "CIC-Test",
            "profile": "manual",
            "started_at_utc": "2026-06-20T00:00:00Z",
            "finished_at_utc": "2026-06-20T00:01:00Z",
            "status": "warning",
            "source": "openaq",
            "from_day": "2026-06-20",
            "to_day": "2026-06-20",
            "dry_run": True,
            "check_only": True,
            "run_backfill": False,
            "db_path": "/tmp/db.sqlite",
            "log_path": "/tmp/run.log",
            "snapshot": {
                "status": "no_snapshot",
                "core_history_version": "v2",
                "core_prefix": "history/v2/core",
                "snapshot_root": "/tmp/R2_history_backup/history/v2/core",
                "core_snapshot_status": "v2_core_snapshot_missing",
                "snapshot_day_utc": None,
                "manifest_hash": None,
                "previous_manifest_hash": None,
                "snapshot_day_dir": None,
                "bytes_read": 0,
                "rows_lookup": 0,
                "tables": {},
            },
        })
        self.assertIn("Core history version: v2", markdown)
        self.assertIn("Core prefix:   history/v2/core", markdown)
        self.assertIn("Snapshot root: /tmp/R2_history_backup/history/v2/core", markdown)
        self.assertIn("Core snapshot status: v2_core_snapshot_missing", markdown)


if __name__ == "__main__":
    unittest.main()
