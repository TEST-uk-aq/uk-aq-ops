#!/usr/bin/env python3
"""Path handling tests for uk-aq-aqi-gap-check."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-aqi-gap-check.py"
)
SPEC = importlib.util.spec_from_file_location("uk_aq_aqi_gap_check", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AqiGapCheckPathTests(unittest.TestCase):
    def test_resolve_output_dir_defaults_to_report_dir(self) -> None:
        env = {"UK_AQ_AQI_GAP_REPORT_DIR": "/tmp/example/aqi_gap_check/reports"}
        args = Namespace(output_dir=None)
        self.assertEqual(MODULE.resolve_output_dir(env, args), Path(env["UK_AQ_AQI_GAP_REPORT_DIR"]))

    def test_resolve_output_dir_honors_override(self) -> None:
        env = {"UK_AQ_AQI_GAP_REPORT_DIR": "/tmp/example/aqi_gap_check/reports"}
        args = Namespace(output_dir="~/custom/report-dir")
        self.assertEqual(MODULE.resolve_output_dir(env, args), Path("~/custom/report-dir").expanduser())

    def test_write_reports_uses_requested_directory(self) -> None:
        report = {"source_mode": "r2-dropbox", "profile": "daily", "generated_at": "2026-06-04T00:00:00Z", "from_day": "2026-05-01", "to_day": "2026-05-02", "selected_days": [], "expected_row_count": 0, "actual_row_count": 0, "missing_row_count": 0, "warnings": [], "missing_by_day": {}}
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "aqi_gap_check" / "reports"
            json_path, md_path = MODULE.write_reports(output_dir, "aqi_gap_check_test", report)
            self.assertTrue(json_path.is_file())
            self.assertTrue(md_path.is_file())
            self.assertEqual(json_path.parent, output_dir)
            self.assertEqual(md_path.parent, output_dir)


if __name__ == "__main__":
    unittest.main()
