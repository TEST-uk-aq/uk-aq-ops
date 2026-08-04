#!/usr/bin/env python3
"""Apply the focused Integrity core-snapshot structural eligibility correction."""

from __future__ import annotations

from pathlib import Path
import re


SOURCE_PATH = Path(
    "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py"
)
TEST_PATH = Path(
    "scripts/uk-aq-history-integrity/tests/"
    "test_core_snapshot_structural_completeness.py"
)


def apply_source_change(source: str) -> str:
    helper_marker = "\ndef _validate_complete_core_snapshot_candidate(\n"
    helper_name = "def _core_snapshot_identity_relationship_warnings("
    helper = '''

def _core_snapshot_identity_relationship_warnings(
    validation_conn: sqlite3.Connection,
) -> list[dict[str, Any]]:
    """Return semantic identity anomalies without rejecting a physical snapshot."""
    relationship_checks = {
        "station_connector": """
            SELECT COUNT(*)
            FROM core_stations_snapshot s
            LEFT JOIN core_connectors_snapshot c ON c.id = s.connector_id
            WHERE s.id IS NULL OR s.connector_id IS NULL OR c.id IS NULL
        """,
        "timeseries_station_connector_phenomenon": """
            SELECT COUNT(*)
            FROM core_timeseries_snapshot t
            LEFT JOIN core_stations_snapshot s ON s.id = t.station_id
            LEFT JOIN core_connectors_snapshot c ON c.id = t.connector_id
            LEFT JOIN core_phenomena_snapshot p ON p.id = t.phenomenon_id
            WHERE t.id IS NULL OR t.station_id IS NULL
               OR t.connector_id IS NULL OR t.phenomenon_id IS NULL
               OR s.id IS NULL OR c.id IS NULL OR p.id IS NULL
               OR s.connector_id != t.connector_id
        """,
        "phenomenon_observed_property_mapping": """
            SELECT COUNT(*)
            FROM core_phenomena_snapshot p
            WHERE p.id IS NULL OR p.connector_id IS NULL
               OR p.observed_property_id IS NULL
               OR NOT EXISTS (
                   SELECT 1
                   FROM core_observed_property_mappings_snapshot m
                   WHERE m.connector_id = p.connector_id
                     AND m.observed_property_id = p.observed_property_id
               )
        """,
    }
    warnings: list[dict[str, Any]] = []
    for label, query in relationship_checks.items():
        count = int(validation_conn.execute(query).fetchone()[0] or 0)
        if count:
            warnings.append({"check": label, "row_count": count})
    return warnings
'''

    if helper_name not in source:
        if source.count(helper_marker) != 1:
            raise RuntimeError("candidate validator insertion marker is not unique")
        source = source.replace(helper_marker, helper + helper_marker, 1)

    semantic_pattern = re.compile(
        r"        orphan_checks = \{.*?"
        r"        lookup_rows = _build_lookup\(validation_conn, log\)\n",
        re.DOTALL,
    )
    semantic_replacement = '''        identity_relationship_warnings = (
            _core_snapshot_identity_relationship_warnings(validation_conn)
        )
        for warning in identity_relationship_warnings:
            log.warning(
                "core snapshot identity relationship warning check=%s "
                "row_count=%s; snapshot remains structurally eligible",
                warning["check"],
                warning["row_count"],
            )
        lookup_rows = _build_lookup(validation_conn, log)
'''
    source, replacement_count = semantic_pattern.subn(
        semantic_replacement,
        source,
        count=1,
    )
    if replacement_count != 1:
        if "snapshot remains structurally eligible" not in source:
            raise RuntimeError("semantic relationship rejection block was not found")

    return_marker = '        "checksums_sha256": checksums_sha256,\n'
    warning_return = (
        return_marker
        + '        "identity_relationship_warnings": '
        + "identity_relationship_warnings,\n"
    )
    if '"identity_relationship_warnings": identity_relationship_warnings' not in source:
        if source.count(return_marker) != 1:
            raise RuntimeError("candidate return marker is not unique")
        source = source.replace(return_marker, warning_return, 1)

    selection_marker = '            "checksums_sha256": validated["checksums_sha256"],\n'
    selection_warnings = (
        selection_marker
        + '            "identity_relationship_warnings": '
        + 'validated["identity_relationship_warnings"],\n'
    )
    if 'validated["identity_relationship_warnings"]' not in source:
        if source.count(selection_marker) != 1:
            raise RuntimeError("selection audit marker is not unique")
        source = source.replace(selection_marker, selection_warnings, 1)

    if "core snapshot identity relationship is invalid" in source:
        raise RuntimeError("fail-closed semantic relationship rejection remains")

    return source


def test_source() -> str:
    return '''#!/usr/bin/env python3
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
'''


def main() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    changed = apply_source_change(source)
    if changed == source:
        raise RuntimeError("source change produced no diff")
    SOURCE_PATH.write_text(changed, encoding="utf-8")
    TEST_PATH.write_text(test_source(), encoding="utf-8")


if __name__ == "__main__":
    main()
