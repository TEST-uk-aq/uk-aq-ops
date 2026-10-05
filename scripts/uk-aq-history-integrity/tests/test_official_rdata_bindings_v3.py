#!/usr/bin/env python3
"""Focused fixed-v3 core import and official-network binding checks."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import importlib.util
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error


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
RDATA = sys.modules["integrity.official_network_rdata"]


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

    @staticmethod
    def metadata_row(
        *,
        site_code: str = "SITE1",
        parameter: str = "NO2",
        start_date: str = "2020-01-01",
        end_date: str = "ongoing",
        ratified_to: str = "2026-01-01",
    ) -> dict[str, str]:
        return {
            "site_id": site_code,
            "parameter": parameter,
            "start_date": start_date,
            "end_date": end_date,
            "ratified_to": ratified_to,
        }

    @staticmethod
    def binding(
        *, timeseries_id: int = 1001, station_id: int = 101,
    ) -> dict[str, int]:
        return {
            "timeseries_id": timeseries_id,
            "station_id": station_id,
        }

    def classify_coverage(
        self,
        metadata_rows: list[dict[str, str]],
        *,
        bindings: dict[str, dict[str, int]] | None = None,
        day: dt.date = dt.date(2026, 9, 28),
        year: int = 2026,
        site_code: str = "SITE1",
    ) -> dict[str, object]:
        return INTEGRITY.classify_site_year_coverage(
            metadata_rows,
            site_code=site_code,
            bindings_by_pollutant=bindings or {"no2": self.binding()},
            selected_days=(day,),
            source_year=year,
        )

    def run_acquisition(
        self,
        *,
        metadata_rows: list[dict[str, str]],
        download_side_effect,
        temporary_directory: str,
        from_day: str = "2026-09-28",
        to_day: str = "2026-09-28",
    ) -> dict[str, object]:
        self.add_binding(
            site_code="SITE1",
            station_id=101,
            timeseries_id=1001,
            phenomenon_id=2001,
            observed_property_id=12,
            canonical_code="no2",
            label="NO2",
        )
        with mock.patch.object(
            INTEGRITY,
            "resolve_official_rdata_rscript",
        ), mock.patch.object(
            INTEGRITY,
            "official_rdata_rscript_identity",
            return_value={"executable": "/usr/bin/Rscript", "version": "test"},
        ), mock.patch.object(
            INTEGRITY,
            "download_official_rdata_pinned",
            side_effect=download_side_effect,
        ) as downloader, mock.patch.object(
            INTEGRITY,
            "extract_official_rdata_metadata",
            return_value=metadata_rows,
        ), mock.patch.object(
            INTEGRITY,
            "extract_official_rdata_site_year",
            return_value=[],
        ):
            metrics = INTEGRITY.check_official_network_rdata(
                conn=self.conn,
                source_key="waqn",
                env_name="TEST",
                env={
                    "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": temporary_directory,
                },
                from_day=from_day,
                to_day=to_day,
                selected_days=None,
                limits=INTEGRITY.LimitTracker(None, None, 0.0),
                log=logging.getLogger("official-rdata-lifecycle-test"),
                run_compact="2026-10-06T000000Z",
                selected_pollutants=("no2",),
            )
        return {"metrics": metrics, "downloader": downloader}

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

    def test_contradictory_active_lookup_connector_identity_fails_closed(self) -> None:
        self.add_binding(
            site_code="CONNECTOR",
            station_id=410,
            timeseries_id=7101,
            phenomenon_id=8101,
            observed_property_id=12,
            canonical_code="no2",
            label="NO2",
        )
        self.conn.execute(
            "UPDATE source_station_timeseries_lookup "
            "SET connector_id = 10 WHERE timeseries_id = 7101"
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

    def test_metadata_extraction_retains_verified_lifecycle_fields_for_both_networks(self) -> None:
        output = (
            '"site_id"\t"parameter"\t"start_date"\t"end_date"\t"ratified_to"\n'
            '"SITE1"\t"NO2"\t"2020-10-20"\t"ongoing"\t"2025-11-08"\n'
        )
        for source_key in ("waqn", "saqn"):
            with self.subTest(source_key=source_key), mock.patch.object(
                RDATA,
                "resolve_rscript",
                return_value="/usr/bin/Rscript",
            ), mock.patch.object(
                RDATA.subprocess,
                "run",
                return_value=mock.Mock(returncode=0, stdout=output, stderr=""),
            ) as runner:
                rows = RDATA.extract_metadata(
                    Path("fixture.RData"),
                    config=RDATA.NETWORKS[source_key],
                )
                self.assertEqual(
                    rows,
                    [self.metadata_row(
                        start_date="2020-10-20",
                        end_date="ongoing",
                        ratified_to="2025-11-08",
                    )],
                )
                self.assertEqual(
                    runner.call_args.args[0][-1],
                    RDATA.NETWORKS[source_key].metadata_object,
                )

    def test_lifecycle_ending_before_source_window_is_authoritative_no_coverage(self) -> None:
        result = self.classify_coverage([
            self.metadata_row(end_date="2026-09-26"),
        ])
        self.assertEqual(
            result["classification"],
            INTEGRITY.COVERAGE_AUTHORITATIVE_NO_COVERAGE,
        )
        self.assertEqual(
            result["selected_bindings"][0]["reason"],
            "coverage_ends_before_selected_source_window",
        )

    def test_lifecycle_starting_after_source_window_is_authoritative_no_coverage(self) -> None:
        result = self.classify_coverage([
            self.metadata_row(start_date="2026-09-29"),
        ])
        self.assertEqual(
            result["classification"],
            INTEGRITY.COVERAGE_AUTHORITATIVE_NO_COVERAGE,
        )
        self.assertEqual(
            result["selected_bindings"][0]["reason"],
            "coverage_starts_after_selected_source_window",
        )

    def test_car04_ongoing_lifecycle_remains_required(self) -> None:
        metadata_rows = [
            self.metadata_row(
                site_code="CAR04",
                parameter=parameter,
                start_date="2020-10-20",
                end_date="ongoing",
                ratified_to=ratified_to,
            )
            for parameter, ratified_to in (
                ("NO2", "2025-11-08"),
                ("PM10", "2025-11-09"),
                ("PM2.5", "2025-11-09"),
            )
        ]
        result = self.classify_coverage(
            metadata_rows,
            site_code="CAR04",
            bindings={
                "no2": self.binding(timeseries_id=1001),
                "pm10": self.binding(timeseries_id=1002),
                "pm25": self.binding(timeseries_id=1003),
            },
        )
        self.assertEqual(result["classification"], INTEGRITY.COVERAGE_REQUIRED)
        self.assertEqual(
            {row["classification"] for row in result["selected_bindings"]},
            {INTEGRITY.COVERAGE_REQUIRED},
        )

    def test_missing_or_malformed_lifecycle_is_indeterminate(self) -> None:
        cases = (
            (self.metadata_row(start_date=""), "start_date_missing"),
            (self.metadata_row(start_date="not-a-date"), "start_date_malformed"),
            (self.metadata_row(end_date=""), "end_date_missing"),
            (self.metadata_row(end_date="not-a-date"), "end_date_malformed"),
            (self.metadata_row(start_date="2026-01-02", end_date="2026-01-01"),
             "lifecycle_dates_contradictory"),
        )
        for metadata_row, reason in cases:
            with self.subTest(reason=reason):
                result = self.classify_coverage([metadata_row])
                self.assertEqual(
                    result["classification"],
                    INTEGRITY.COVERAGE_INDETERMINATE,
                )
                self.assertEqual(result["selected_bindings"][0]["reason"], reason)
        for metadata_rows, reason in (
            ([], "metadata_lifecycle_row_missing"),
            ([self.metadata_row(), self.metadata_row()],
             "metadata_lifecycle_row_ambiguous"),
        ):
            with self.subTest(reason=reason):
                result = self.classify_coverage(metadata_rows)
                self.assertEqual(
                    result["classification"],
                    INTEGRITY.COVERAGE_INDETERMINATE,
                )
                self.assertEqual(result["selected_bindings"][0]["reason"], reason)

    def test_mixed_selected_pollutants_remain_required_when_one_overlaps(self) -> None:
        result = self.classify_coverage(
            [
                self.metadata_row(parameter="PM10", end_date="2025-12-31"),
                self.metadata_row(parameter="NO2", end_date="ongoing"),
            ],
            bindings={
                "pm10": self.binding(timeseries_id=1001),
                "no2": self.binding(timeseries_id=1002),
            },
        )
        self.assertEqual(result["classification"], INTEGRITY.COVERAGE_REQUIRED)
        self.assertEqual(
            {
                row["pollutant_code"]: row["classification"]
                for row in result["selected_bindings"]
            },
            {
                "no2": INTEGRITY.COVERAGE_REQUIRED,
                "pm10": INTEGRITY.COVERAGE_AUTHORITATIVE_NO_COVERAGE,
            },
        )

    def test_authoritative_no_coverage_site_year_is_not_fetched_or_required_by_day(self) -> None:
        calls: list[str] = []

        def download(url: str, _destination: Path) -> dict[str, object]:
            calls.append(url)
            return {
                "bytes": 100,
                "sha256": "a" * 64,
                "etag": None,
                "last_modified": None,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            result = self.run_acquisition(
                metadata_rows=[self.metadata_row(end_date="2026-09-26")],
                download_side_effect=download,
                temporary_directory=temporary_directory,
            )

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].endswith("WAQ_metadata.RData"))
        self.assertEqual(
            result["metrics"]["site_year_files_authoritative_no_coverage"],
            1,
        )
        context = INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"]
        self.assertEqual(context["required_by_day"]["2026-09-28"], ["waqn:metadata"])
        audit = context["site_year_coverage_audit"][0]
        self.assertEqual(
            audit["classification"],
            INTEGRITY.COVERAGE_AUTHORITATIVE_NO_COVERAGE,
        )
        self.assertEqual(
            audit["acquisition_action"],
            "not_fetched_authoritative_no_coverage",
        )

    def test_required_site_year_http_404_still_fails_closed(self) -> None:
        def download(url: str, _destination: Path) -> dict[str, object]:
            if url.endswith("WAQ_metadata.RData"):
                return {
                    "bytes": 100,
                    "sha256": "b" * 64,
                    "etag": None,
                    "last_modified": None,
                }
            error = urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            error.close()
            raise error

        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaisesRegex(
                RuntimeError,
                "HTTP 404 is not authoritative no-coverage evidence",
            ):
                self.run_acquisition(
                    metadata_rows=[self.metadata_row(end_date="ongoing")],
                    download_side_effect=download,
                    temporary_directory=temporary_directory,
                )

    def test_site_year_fetched_once_and_required_only_for_covered_day(self) -> None:
        calls: list[str] = []

        def download(url: str, _destination: Path) -> dict[str, object]:
            calls.append(url)
            return {
                "bytes": 100,
                "sha256": "c" * 64,
                "etag": None,
                "last_modified": None,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            self.run_acquisition(
                metadata_rows=[self.metadata_row(end_date="2026-09-26")],
                download_side_effect=download,
                temporary_directory=temporary_directory,
                from_day="2026-09-27",
                to_day="2026-09-28",
            )

        self.assertEqual(len(calls), 2)
        self.assertEqual(sum(url.endswith("SITE1_2026.RData") for url in calls), 1)
        context = INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"]
        source_file = "waqn:site_ref=SITE1:year=2026"
        self.assertIn(source_file, context["required_by_day"]["2026-09-27"])
        self.assertNotIn(source_file, context["required_by_day"]["2026-09-28"])

    def test_january_first_retains_both_raw_source_year_windows(self) -> None:
        day = dt.date(2026, 1, 1)
        self.assertEqual(INTEGRITY.official_rdata_required_site_years((day,)), [2025, 2026])
        expected_windows = {
            2025: ("2025-12-31T23:00:00Z", "2026-01-01T00:00:00Z"),
            2026: ("2026-01-01T00:00:00Z", "2026-01-01T23:00:00Z"),
        }
        for year, expected in expected_windows.items():
            with self.subTest(year=year):
                result = self.classify_coverage(
                    [self.metadata_row(end_date="ongoing")],
                    day=day,
                    year=year,
                )
                self.assertEqual(result["classification"], INTEGRITY.COVERAGE_REQUIRED)
                window = result["raw_source_windows"][0]
                self.assertEqual(
                    (window["raw_start_utc"], window["raw_end_exclusive_utc"]),
                    expected,
                )


if __name__ == "__main__":
    unittest.main()
