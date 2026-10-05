#!/usr/bin/env python3
"""Focused fixed-v3 core import and official-network binding checks."""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import logging
from pathlib import Path
import sys
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity-sos-light-v3_impl.py"
)
SPEC = importlib.util.spec_from_file_location("official_rdata_bindings_v3", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
INTEGRITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INTEGRITY
SPEC.loader.exec_module(INTEGRITY)


class OfficialRDataBindingsV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = INTEGRITY.open_db(":memory:")

    def tearDown(self) -> None:
        self.conn.close()

    def add_binding(
        self,
        *,
        site_code: str,
        station_id: int,
        timeseries_id: int,
        phenomenon_id: int,
        observed_property_id: int | None,
        canonical_code: str | None,
        label: str,
        add_observed_property: bool = True,
    ) -> None:
        if add_observed_property and observed_property_id is not None:
            self.conn.execute(
                "INSERT OR IGNORE INTO core_observed_properties_snapshot "
                "(id, code, display_name) VALUES (?, ?, ?)",
                (observed_property_id, canonical_code, label),
            )
        self.conn.execute(
            "INSERT INTO core_phenomena_snapshot "
            "(id, label, source_label, pollutant_label, observed_property_id, connector_id) "
            "VALUES (?, ?, ?, ?, ?, 9)",
            (phenomenon_id, label, label, label, observed_property_id),
        )
        self.conn.execute(
            "INSERT INTO core_timeseries_snapshot "
            "(id, station_id, connector_id, phenomenon_id) VALUES (?, ?, 9, ?)",
            (timeseries_id, station_id, phenomenon_id),
        )
        self.conn.execute(
            "INSERT INTO source_station_timeseries_lookup "
            "(source_key, source_location_id, station_ref, station_id, connector_id, "
            " timeseries_id, is_active) VALUES ('waqn', ?, ?, ?, 9, ?, 1)",
            (site_code, site_code, station_id, timeseries_id),
        )

    def resolve(self, selected: tuple[str, ...] = ("pm25", "pm10", "no2", "o3")):
        return INTEGRITY._official_rdata_bindings(
            self.conn,
            source_key="waqn",
            selected_pollutants=selected,
        )

    def test_canonical_observed_properties_resolve_all_selected_pollutants_without_mapping_rows(self) -> None:
        expected = {3: "pm10", 9: "pm25", 12: "no2", 14: "o3"}
        for offset, (observed_property_id, code) in enumerate(expected.items(), start=1):
            self.add_binding(
                site_code="AH",
                station_id=100,
                timeseries_id=1000 + offset,
                phenomenon_id=2000 + offset,
                observed_property_id=observed_property_id,
                canonical_code=code,
                label=f"diagnostic-{code}",
            )

        bindings, mapping_hash, property_hash, audit = self.resolve()

        self.assertEqual(set(bindings["AH"]), set(expected.values()))
        self.assertEqual(
            {
                row["observed_property_id"]: row["pollutant_code"]
                for row in audit["mapped_source_groups"]
            },
            expected,
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM core_observed_property_mappings_snapshot"
            ).fetchone()[0],
            0,
        )
        self.assertRegex(mapping_hash, r"^[a-f0-9]{64}$")
        self.assertRegex(property_hash, r"^[a-f0-9]{64}$")

    def test_missing_or_blank_canonical_identity_fails_without_label_fallback(self) -> None:
        cases = (
            (None, None, True, "missing_observed_property_id"),
            (12, None, False, "missing_canonical_observed_property"),
            (12, "", True, "blank_canonical_observed_property_code"),
        )
        for index, (property_id, code, add_property, reason) in enumerate(cases, start=1):
            with self.subTest(reason=reason):
                conn = INTEGRITY.open_db(":memory:")
                original = self.conn
                self.conn = conn
                try:
                    self.add_binding(
                        site_code="LABELONLY",
                        station_id=100 + index,
                        timeseries_id=1000 + index,
                        phenomenon_id=2000 + index,
                        observed_property_id=property_id,
                        canonical_code=code,
                        label="NO2",
                        add_observed_property=add_property,
                    )
                    with self.assertRaisesRegex(RuntimeError, reason):
                        self.resolve(("no2",))
                finally:
                    self.conn = original
                    conn.close()

    def test_duplicate_authoritative_site_pollutant_binding_fails_closed(self) -> None:
        for index in (1, 2):
            self.add_binding(
                site_code="DUP",
                station_id=200,
                timeseries_id=3000 + index,
                phenomenon_id=4000 + index,
                observed_property_id=12,
                canonical_code="no2",
                label="NO2",
            )
        with self.assertRaisesRegex(
            RuntimeError,
            r"authoritative binding is ambiguous: DUP/no2=2",
        ):
            self.resolve(("no2",))

    def test_canonical_unselected_pollutants_do_not_block_selected_scope(self) -> None:
        for index, (property_id, code) in enumerate(
            ((12, "no2"), (14, "o3"), (15, "no")),
            start=1,
        ):
            self.add_binding(
                site_code="SELECTED",
                station_id=300,
                timeseries_id=5000 + index,
                phenomenon_id=6000 + index,
                observed_property_id=property_id,
                canonical_code=code,
                label=code.upper(),
            )
        bindings, _mapping_hash, _property_hash, audit = self.resolve(("no2",))
        self.assertEqual(set(bindings["SELECTED"]), {"no2"})
        self.assertEqual(
            {row["reason"] for row in audit["excluded_source_groups"]},
            {"not_selected_pollutant", "unsupported_integrity_pollutant"},
        )

    def test_contradictory_station_identity_fails_closed(self) -> None:
        self.add_binding(
            site_code="CONTRADICTORY",
            station_id=400,
            timeseries_id=7001,
            phenomenon_id=8001,
            observed_property_id=12,
            canonical_code="no2",
            label="NO2",
        )
        self.conn.execute(
            "UPDATE core_timeseries_snapshot SET station_id = 401 WHERE id = 7001"
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "contradictory_station_timeseries_identity",
        ):
            self.resolve(("no2",))

    def test_authenticated_core_table_loader_imports_observed_properties(self) -> None:
        self.assertIn("observed_properties", INTEGRITY.CORE_TABLES_TO_IMPORT)
        with tempfile.TemporaryDirectory() as temporary_directory:
            day_dir = Path(temporary_directory)
            relative_path = "table=observed_properties/rows.ndjson.gz"
            table_path = day_dir / relative_path
            table_path.parent.mkdir(parents=True)
            payload = b'{"id":3,"code":"pm10","display_name":"PM10"}\n'
            compressed = gzip.compress(payload)
            table_path.write_bytes(compressed)
            entry = {
                "table": "observed_properties",
                "relative_path": relative_path,
                "sha256": hashlib.sha256(compressed).hexdigest(),
            }
            rows, bytes_read = INTEGRITY._verify_and_load_table(
                self.conn,
                day_dir,
                entry,
                logging.getLogger("official-rdata-binding-test"),
            )
            self.assertEqual(rows, 1)
            self.assertEqual(bytes_read, len(compressed))
            self.assertEqual(
                self.conn.execute(
                    "SELECT id, code, display_name "
                    "FROM core_observed_properties_snapshot"
                ).fetchall(),
                [(3, "pm10", "PM10")],
            )
            with self.assertRaisesRegex(RuntimeError, "sha256 mismatch"):
                INTEGRITY._verify_and_load_table(
                    self.conn,
                    day_dir,
                    {**entry, "sha256": "0" * 64},
                    logging.getLogger("official-rdata-binding-test"),
                )


if __name__ == "__main__":
    unittest.main()
