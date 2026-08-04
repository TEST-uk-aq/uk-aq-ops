#!/usr/bin/env python3
"""Focused checks for physical core-snapshot eligibility."""

import importlib.util
import logging
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity_impl.py"
)
SPEC = importlib.util.spec_from_file_location("integrity_impl", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
INTEGRITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INTEGRITY
SPEC.loader.exec_module(INTEGRITY)


class CoreSnapshotStructuralCompletenessTests(unittest.TestCase):
    def test_relationship_anomaly_is_warning_not_exception(self) -> None:
        conn = sqlite3.connect(":memory:")
        try:
            conn.executescript(
                """
                CREATE TABLE core_connectors_snapshot (id INTEGER);
                CREATE TABLE core_stations_snapshot (id INTEGER, connector_id INTEGER);
                CREATE TABLE core_timeseries_snapshot (
                    id INTEGER,
                    station_id INTEGER,
                    connector_id INTEGER,
                    phenomenon_id INTEGER
                );
                CREATE TABLE core_phenomena_snapshot (
                    id INTEGER,
                    connector_id INTEGER,
                    observed_property_id INTEGER
                );
                CREATE TABLE core_observed_property_mappings_snapshot (
                    connector_id INTEGER,
                    observed_property_id INTEGER
                );
                INSERT INTO core_connectors_snapshot VALUES (1);
                INSERT INTO core_stations_snapshot VALUES (10, 1);
                INSERT INTO core_phenomena_snapshot VALUES (100, 1, 7);
                INSERT INTO core_observed_property_mappings_snapshot VALUES (1, 7);
                INSERT INTO core_timeseries_snapshot VALUES (1000, 10, 2, 100);
                """
            )
            warnings = INTEGRITY._core_snapshot_identity_relationship_warnings(conn)
        finally:
            conn.close()
        self.assertEqual(
            warnings,
            [{
                "check": "timeseries_station_connector_phenomenon",
                "row_count": 1,
            }],
        )

    def test_latest_candidate_remains_eligible_with_relationship_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            day_dir = root / "day_utc=2026-08-04"
            day_dir.mkdir()
            original = INTEGRITY._validate_complete_core_snapshot_candidate
            try:
                INTEGRITY._validate_complete_core_snapshot_candidate = lambda *args, **kwargs: (
                    {"day_utc": "2026-08-04"},
                    {
                        "identity": {
                            "core_snapshot_day_utc": "2026-08-04",
                            "core_snapshot_manifest_key": "history/v2/core/day_utc=2026-08-04/manifest.json",
                            "core_snapshot_manifest_hash": "a" * 64,
                            "core_snapshot_manifest_sha256": "b" * 64,
                        },
                        "snapshot_day_dir": str(day_dir),
                        "validated_tables": {},
                        "checksums_sha256": "c" * 64,
                        "identity_relationship_warnings": [{
                            "check": "timeseries_station_connector_phenomenon",
                            "row_count": 50,
                        }],
                    },
                )
                selection = INTEGRITY.select_latest_complete_core_snapshot(
                    root,
                    logging.getLogger("core-snapshot-test"),
                    selected_at_utc="2026-08-04T12:00:00Z",
                )
            finally:
                INTEGRITY._validate_complete_core_snapshot_candidate = original
        self.assertEqual(
            selection["identity"]["core_snapshot_day_utc"],
            "2026-08-04",
        )
        self.assertEqual(
            selection["identity_relationship_warnings"][0]["row_count"],
            50,
        )
        self.assertEqual(selection["skipped_candidates"], [])


if __name__ == "__main__":
    unittest.main()
