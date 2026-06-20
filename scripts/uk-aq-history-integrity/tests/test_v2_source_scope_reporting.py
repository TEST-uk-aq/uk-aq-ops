#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_scope_report", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class V2SourceScopeReportingTests(unittest.TestCase):
    def test_markdown_includes_source_scope_line(self) -> None:
        summary = {
            "env": "CIC-Test",
            "profile": "manual",
            "started_at_utc": "2026-06-20T00:00:00Z",
            "finished_at_utc": "2026-06-20T00:01:00Z",
            "status": "ok",
            "source": "openaq",
            "from_day": "2026-06-07",
            "to_day": "2026-06-07",
            "dry_run": False,
            "check_only": True,
            "run_backfill": False,
            "db_path": ":memory:",
            "log_path": "tmp/test.log",
            "history_integrity_schema_version": MODULE.HISTORY_INTEGRITY_SCHEMA_VERSION,
            "history_version_mode": "v2",
            "checked_versions": ["v2"],
            "site_read_version": None,
            "history_path_configs": {"v2": MODULE.resolve_history_path_config("v2", {}).to_dict()},
            "history_version_results": {
                "v2": {
                    "observations": {"status": "ok", "checked_partitions": 1, "gap_count": 0, "gaps": [], "source_scope": {"source": "openaq", "connector_ids": [6], "scope": "source"}},
                    "aqilevels": {"status": "ok", "checked_partitions": 1, "gap_count": 0, "gaps": [], "debug": {"checked": False, "required": False, "gaps": []}, "source_scope": {"source": "openaq", "connector_ids": [6], "scope": "source"}},
                }
            },
            "cross_check": {"ran": True, "source_scope": {"source": "openaq", "connector_ids": [6], "scope": "source"}},
        }

        markdown = MODULE.format_summary_md(summary)

        self.assertIn("- Source scope: openaq connector_id=6", markdown)


if __name__ == "__main__":
    unittest.main()
