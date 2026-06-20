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
        self.assertFalse(config.checks_implemented)

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
                "UK_AQ_R2_HISTORY_READ_VERSION=v2\n"
                "UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX=from-file/v2/observations\n"
                "UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX=from-file/v2/aqi/data\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "UK_AQ_BACKFILL_ENV_FILE": str(env_path),
                    "UK_AQ_R2_HISTORY_READ_VERSION": "v1",
                },
                clear=True,
            ):
                result = MODULE.load_backfill_env_file_if_set()
                self.assertTrue(result["loaded"])
                self.assertEqual(os.environ["UK_AQ_R2_HISTORY_READ_VERSION"], "v1")
                self.assertEqual(
                    os.environ["UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX"],
                    "from-file/v2/observations",
                )
                self.assertIn("UK_AQ_R2_HISTORY_READ_VERSION", result["shared_history_keys"])
                self.assertIn("UK_AQ_R2_HISTORY_READ_VERSION", result["skipped_existing_keys"])

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
        self.assertIn("Deep v2 checks: not implemented in Phase 1", markdown)
        self.assertIn("## v1/v2 comparison", markdown)
        self.assertIn("Full comparison: not implemented in Phase 1", markdown)

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


if __name__ == "__main__":
    unittest.main()
