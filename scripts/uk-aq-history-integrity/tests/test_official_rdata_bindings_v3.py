#!/usr/bin/env python3
"""Focused fixed-v3 core import and official-network binding checks."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import importlib.util
import logging
import json
from pathlib import Path
import sys
import tempfile
import subprocess
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
        INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS.clear()

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

    @staticmethod
    def stage_official_proposal(
        root: Path,
        *,
        requested_pollutants: list[str],
        rows: list[dict[str, object]],
        source_available_pollutants: list[str],
        source_unavailable_scopes: list[dict[str, object]] | None = None,
        preserved_baseline_identity: dict[str, object] | None = None,
        source_file_identities: list[dict[str, object]] | None = None,
    ) -> tuple[Path, dict[str, object]]:
        root.mkdir(parents=True, exist_ok=True)
        repo_root = Path(__file__).resolve().parents[3]
        helper = (
            repo_root / "scripts/uk-aq-history-integrity/bin/integrity/"
            "official_network_rdata_proposal.mjs"
        )
        writer_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_root, check=True,
            text=True, stdout=subprocess.PIPE,
        ).stdout.strip()
        unavailable_scopes = list(source_unavailable_scopes or [])
        identities = source_file_identities or [{
            "source_file": "waqn:metadata", "sha256": "a" * 64,
            "bytes": 100,
        }]
        payload = {
            "history_generation": "v3",
            "day_utc": "2026-09-28",
            "connector_id": 9,
            "source_adapter": "waqn",
            "requested_pollutant_set": requested_pollutants,
            "backed_up_at_utc": "2026-10-06T00:00:00Z",
            "rows": rows,
            "preserved_baseline_rows": [],
            "preserved_baseline_identity": preserved_baseline_identity or {
                "source": "dropbox", "partition_identities": [],
            },
            "source_available_timeseries_ids": [
                1001 + index for index, _ in enumerate(source_available_pollutants)
            ],
            "source_available_pollutant_codes": source_available_pollutants,
            "source_unavailable_timeseries_ids": [
                int(scope["timeseries_id"]) for scope in unavailable_scopes
            ],
            "source_unavailable_scopes": unavailable_scopes,
            "source_file_identities": identities,
            "required_source_files": [
                str(identity["source_file"]) for identity in identities
            ],
            "authoritatively_absent_source_files": [],
            "authoritative_mapping_sha256": "b" * 64,
            "observed_property_mapping_sha256": "c" * 64,
            "ratification_audit": [],
            "mapping_audit": {
                "mapped_source_groups": [], "excluded_source_groups": [],
            },
            "rscript_identity": {
                "executable": "/usr/bin/Rscript", "version": "test",
            },
        }
        input_path = root / "input.json"
        input_path.write_text(json.dumps(payload), encoding="utf-8")
        stage_root = root / "stage"
        completed = subprocess.run(
            [
                "node", str(helper), str(input_path), str(stage_root),
                "history/v3/observations", writer_sha, "v3",
            ],
            cwd=repo_root, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(completed.stderr)
        evidence_path = (
            stage_root / "day_utc=2026-09-28/connector_id=9/"
            "source-evidence.json"
        )
        return stage_root, json.loads(evidence_path.read_text(encoding="utf-8"))

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
        decode_side_effect=None,
        decoded_rows: list[dict[str, str]] | None = None,
        site_code: str = "SITE1",
    ) -> dict[str, object]:
        self.add_binding(
            site_code=site_code,
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
            return_value=list(decoded_rows or []),
            side_effect=decode_side_effect,
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

    def run_partial_january_proposal(
        self,
        *,
        temporary_directory: str,
        baseline_rows: list[dict[str, object]],
    ) -> tuple[dict[str, object], dict[str, object], list[dict[str, object]]]:
        repo_root = Path(__file__).resolve().parents[3]
        day_utc = "2026-01-01"
        partition_prefix = (
            "history/v3/observations/day_utc=2026-01-01/connector_id=9/"
            "pollutant_code=no2"
        )
        source_rows = [{
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": f"2026-01-01T{hour:02}:00:00.000Z",
            "value": float(hour),
            "verification_status": "R",
        } for hour in range(1, 24)]
        unavailable_scope = {
            "day_utc": day_utc,
            "site_code": "SITE1",
            "source_year": 2025,
            "source_file_key": "waqn:site_ref=SITE1:year=2025",
            "pollutant_code": "no2",
            "station_id": 101,
            "timeseries_id": 1001,
            "reason": "source_artifact_unavailable",
            "canonical_url": "https://airquality.gov.wales/sites/default/files/"
            "openair/R_data/SITE1_2025.RData",
            "final_url": "https://www.airquality.gov.wales/sites/default/files/"
            "openair/R_data/SITE1_2025.RData",
            "http_status": 404,
            "raw_source_windows": [{
                "canonical_day_utc": day_utc,
                "raw_start_utc": "2025-12-31T23:00:00Z",
                "raw_end_exclusive_utc": "2026-01-01T00:00:00Z",
            }],
            "canonical_unavailable_windows": [{
                "canonical_day_utc": day_utc,
                "canonical_start_utc": "2026-01-01T00:00:00Z",
                "canonical_end_exclusive_utc": "2026-01-01T01:00:00Z",
            }],
        }
        root = Path(temporary_directory)
        baseline_root = root / "baseline"
        parquet_key = f"{partition_prefix}/part-00000.parquet"
        parquet_path = baseline_root / parquet_key
        parquet_path.parent.mkdir(parents=True)
        parquet_body = b"pinned-january-baseline-parquet"
        parquet_path.write_bytes(parquet_body)
        manifest_path = baseline_root / partition_prefix / "manifest.json"
        manifest_path.write_text(json.dumps({
            "files": [{
                "key": parquet_key,
                "bytes": len(parquet_body),
                "etag_or_hash": hashlib.sha256(parquet_body).hexdigest(),
            }],
        }), encoding="utf-8")
        INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"] = {
            "source_key": "waqn",
            "connector_id": 9,
            "bindings": {
                "SITE1": {
                    "no2": {"station_id": 101, "timeseries_id": 1001},
                },
            },
            "rows_by_day": {day_utc: source_rows},
            "source_unavailable_by_day": {day_utc: [unavailable_scope]},
            "required_by_day": {
                day_utc: ["waqn:metadata", "waqn:site_ref=SITE1:year=2026"],
            },
            "identities_by_key": {
                "waqn:metadata": {
                    "source_file": "waqn:metadata", "bytes": 1,
                    "sha256": "a" * 64,
                },
                "waqn:site_ref=SITE1:year=2026": {
                    "source_file": "waqn:site_ref=SITE1:year=2026", "bytes": 1,
                    "sha256": "b" * 64,
                },
            },
            "absent_keys": [],
            "authoritative_mapping_sha256": "c" * 64,
            "observed_property_mapping_sha256": "d" * 64,
            "audits_by_day": {day_utc: []},
            "mapping_audit": {
                "mapped_source_groups": [], "excluded_source_groups": [],
            },
            "rscript_identity": {
                "executable": "/usr/bin/Rscript", "version": "test",
            },
        }
        stage_root = root / "stage"
        with mock.patch.object(
            INTEGRITY,
            "resolve_r2_history_root",
            return_value=baseline_root,
        ), mock.patch.object(
            INTEGRITY,
            "_observation_rows_from_local_parquet_for_shared_hash",
            return_value=baseline_rows,
        ):
            result = INTEGRITY._prepare_official_rdata_proposal(
                source_key="waqn",
                day_utc=day_utc,
                connector_id=9,
                selected_pollutants=["no2"],
                stage_root=stage_root,
                env={"UK_AQ_OPS_REPO_ROOT": str(repo_root)},
                history_generation="v3",
            )
        evidence = json.loads((
            stage_root / f"day_utc={day_utc}/connector_id=9/source-evidence.json"
        ).read_text(encoding="utf-8"))
        preserved = json.loads((
            stage_root /
            f"day_utc={day_utc}/connector_id=9/preserved_baseline_rows.json"
        ).read_text(encoding="utf-8"))
        return result, evidence, preserved

    def run_empty_baseline_subset_hash_check(
        self,
        *,
        temporary_directory: str,
        source_rows: list[dict[str, object]],
    ) -> tuple[dict[str, object], dict[str, object]]:
        repo_root = Path(__file__).resolve().parents[3]
        day_utc = "2026-09-28"
        source_hash = INTEGRITY._compute_observation_hash_with_shared_javascript(
            rows=source_rows,
            is_sos=False,
            env={"UK_AQ_OPS_REPO_ROOT": str(repo_root)},
            allow_empty=not source_rows,
        )
        source_state = "successful_non_empty" if source_rows else "successful_empty"
        unavailable_scope = {
            "day_utc": day_utc,
            "site_code": "SITE2",
            "source_year": 2026,
            "source_file_key": "waqn:site_ref=SITE2:year=2026",
            "pollutant_code": "no2",
            "station_id": 102,
            "timeseries_id": 1002,
            "reason": "source_artifact_unavailable",
            "canonical_unavailable_windows": [{
                "canonical_day_utc": day_utc,
                "canonical_start_utc": "2026-09-28T00:00:00Z",
                "canonical_end_exclusive_utc": "2026-09-29T00:00:00Z",
            }],
        }
        candidate = {
            "day_utc": day_utc,
            "connector_id": 9,
            "pollutant_code": "no2",
            "manifest_path": str(Path(temporary_directory) / "manifest.json"),
            "manifest_rel": "manifest.json",
            "parquet_paths": [str(Path(temporary_directory) / "part.parquet")],
            "source_row_count": len(source_rows),
            "source_timeseries_row_counts": (
                {"1001": len(source_rows)} if source_rows else {}
            ),
            "source_evidence": {
                "source_partition_state": source_state,
                "source_counts_available": True,
                "source_skip_reason": None,
                "required_source_file_count": 1,
                "successful_source_file_count": 1,
                "source_available_timeseries_ids": [1001],
                "source_unavailable_timeseries_ids": [1002],
                "source_unavailable_scopes": [unavailable_scope],
                "comparison_scope": "source_available_timestamp_windows",
            },
        }
        evidence = {
            "observation_content_hashes": {"no2": source_hash},
        }
        INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"] = {
            "connector_id": 9,
        }
        v2_observations = {
            "hash_check_candidates": [candidate],
            "hash_candidates_by_pollutant": {"no2": 1},
            "gaps": [],
        }
        env = {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": temporary_directory,
            "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": temporary_directory,
            "UK_AQ_OPS_REPO_ROOT": str(repo_root),
        }
        with mock.patch.object(
            INTEGRITY,
            "_prepare_official_rdata_proposal",
            return_value={"status": "ok"},
        ), mock.patch.object(
            INTEGRITY,
            "_load_complete_connector_day_source_evidence",
            return_value=(evidence, source_rows),
        ), mock.patch.object(
            INTEGRITY,
            "_persist_complete_connector_day_source_evidence",
        ), mock.patch.object(
            INTEGRITY,
            "_observation_rows_from_local_parquet_for_shared_hash",
            return_value=[],
        ):
            metrics = INTEGRITY.run_v2_observation_content_hash_checks(
                conn=self.conn,
                env_name="TEST",
                run_compact="2026-10-06T000000Z",
                env=env,
                v2_observations=v2_observations,
                source_scope={"source": "waqn"},
                log=logging.getLogger("official-rdata-empty-subset-test"),
                repair_pollutants=["no2"],
            )
        return metrics, v2_observations

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

        def download(url: str, _destination: Path, **_kwargs) -> dict[str, object]:
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

    def test_car04_ongoing_2026_http_404_is_source_unavailable(self) -> None:
        def download(url: str, _destination: Path, **_kwargs) -> dict[str, object]:
            if url.endswith("WAQ_metadata.RData"):
                return {
                    "bytes": 100,
                    "sha256": "b" * 64,
                    "etag": None,
                    "last_modified": None,
                }
            raise RDATA.AuthoritativeSourceArtifactAbsent(
                canonical_url=url,
                final_url=url.replace(
                    "https://airquality.gov.wales/",
                    "https://www.airquality.gov.wales/",
                ),
                requested_at_utc="2026-10-06T00:00:00+00:00",
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            result = self.run_acquisition(
                metadata_rows=[self.metadata_row(
                    site_code="CAR04", end_date="ongoing"
                )],
                download_side_effect=download,
                temporary_directory=temporary_directory,
                site_code="CAR04",
            )
        self.assertEqual(
            result["metrics"]["site_year_files_source_unavailable"], 1
        )
        self.assertEqual(result["metrics"]["canonical_rows"], 0)
        context = INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"]
        self.assertEqual(
            context["required_by_day"]["2026-09-28"], ["waqn:metadata"]
        )
        [scope] = context["source_unavailable_scopes"]
        self.assertEqual(scope["site_code"], "CAR04")
        self.assertEqual(scope["reason"], "source_artifact_unavailable")
        self.assertEqual(scope["timeseries_id"], 1001)
        self.assertEqual(scope["http_status"], 404)
        counts, evidence = INTEGRITY._official_rdata_source_counts_for_partition(
            source_key="waqn",
            day_utc="2026-09-28",
            pollutant_code="no2",
        )
        self.assertEqual(counts, {})
        self.assertEqual(
            evidence["source_partition_state"], "source_artifact_unavailable"
        )
        self.assertEqual(evidence["source_unavailable_timeseries_ids"], [1001])
        self.assertFalse(evidence["source_counts_available"])

    def test_site_year_fetched_once_and_required_only_for_covered_day(self) -> None:
        calls: list[str] = []

        def download(url: str, _destination: Path, **_kwargs) -> dict[str, object]:
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

    def test_metadata_404_remains_fail_closed(self) -> None:
        def download(url: str, _destination: Path, **_kwargs):
            raise RDATA.AuthoritativeSourceArtifactAbsent(
                canonical_url=url,
                final_url=url,
                requested_at_utc="2026-10-06T00:00:00+00:00",
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaisesRegex(
                RuntimeError, "required metadata RData fetch failed closed"
            ):
                self.run_acquisition(
                    metadata_rows=[self.metadata_row()],
                    download_side_effect=download,
                    temporary_directory=temporary_directory,
                )

    def test_site_year_non_404_and_transport_fail_closed(self) -> None:
        for failure in (
            urllib.error.HTTPError(
                "https://airquality.gov.wales/sites/default/files/openair/R_data/"
                "SITE1_2026.RData",
                500,
                "Server Error",
                {},
                None,
            ),
            TimeoutError("timed out"),
        ):
            with self.subTest(failure=type(failure).__name__):
                original_conn = self.conn
                self.conn = INTEGRITY.open_db(":memory:")
                def download(url: str, _destination: Path, **_kwargs):
                    if url.endswith("WAQ_metadata.RData"):
                        return {
                            "bytes": 100,
                            "sha256": "d" * 64,
                            "etag": None,
                            "last_modified": None,
                        }
                    raise failure

                try:
                    with tempfile.TemporaryDirectory() as temporary_directory:
                        with self.assertRaisesRegex(
                            RuntimeError, "required RData fetch failed closed"
                        ):
                            self.run_acquisition(
                                metadata_rows=[self.metadata_row()],
                                download_side_effect=download,
                                temporary_directory=temporary_directory,
                            )
                finally:
                    self.conn.close()
                    self.conn = original_conn
                    if isinstance(failure, urllib.error.HTTPError):
                        failure.close()

    def test_provider_host_validation_accepts_only_explicit_aliases(self) -> None:
        waqn = RDATA.NETWORKS["waqn"]
        path = "/sites/default/files/openair/R_data/CAR04_2026.RData"
        for host in waqn.accepted_hosts:
            self.assertEqual(
                RDATA._validated_provider_url(
                    f"https://{host}{path}", config=waqn, expected_path=path
                ),
                f"https://{host}{path}",
            )
        for url in (
            f"https://airquality.gov.wales.evil.example{path}",
            f"https://www.scottishairquality.scot{path}",
            f"http://www.airquality.gov.wales{path}",
            f"https://www.airquality.gov.wales/other/CAR04_2026.RData",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(
                RuntimeError, "unexpected waqn RData provider URL"
            ):
                RDATA._validated_provider_url(
                    url, config=waqn, expected_path=path
                )

        saqn = RDATA.NETWORKS["saqn"]
        saqn_path = "/openair/R_data/ABD_2026.RData"
        for host in saqn.accepted_hosts:
            RDATA._validated_provider_url(
                f"https://{host}{saqn_path}",
                config=saqn,
                expected_path=saqn_path,
            )

    def test_download_classifies_only_authenticated_canonical_404_as_absent(self) -> None:
        config = RDATA.NETWORKS["waqn"]
        canonical_url = config.base_url + "CAR04_2026.RData"
        accepted_final_url = canonical_url.replace(
            "https://airquality.gov.wales/",
            "https://www.airquality.gov.wales/",
        )
        accepted_404 = urllib.error.HTTPError(
            accepted_final_url, 404, "Not Found", {}, None
        )
        with tempfile.TemporaryDirectory() as temporary_directory, mock.patch.object(
            RDATA.urllib.request,
            "urlopen",
            side_effect=accepted_404,
        ):
            with self.assertRaises(
                RDATA.AuthoritativeSourceArtifactAbsent
            ) as caught:
                RDATA.download_pinned(
                    canonical_url,
                    Path(temporary_directory) / "CAR04_2026.RData",
                    config=config,
                )
        accepted_404.close()
        self.assertEqual(caught.exception.final_url, accepted_final_url)
        self.assertEqual(caught.exception.http_status, 404)

        unexpected_404 = urllib.error.HTTPError(
            "https://airquality.gov.wales.evil.example/sites/default/files/"
            "openair/R_data/CAR04_2026.RData",
            404,
            "Not Found",
            {},
            None,
        )
        with tempfile.TemporaryDirectory() as temporary_directory, mock.patch.object(
            RDATA.urllib.request,
            "urlopen",
            side_effect=unexpected_404,
        ):
            with self.assertRaisesRegex(
                RuntimeError, "unexpected waqn RData provider URL"
            ):
                RDATA.download_pinned(
                    canonical_url,
                    Path(temporary_directory) / "CAR04_2026.RData",
                    config=config,
                )
        unexpected_404.close()

    def test_partial_successful_download_fails_closed(self) -> None:
        class PartialResponse:
            status = 200
            headers = {"Content-Length": "10"}

            def __init__(self, url: str) -> None:
                self.url = url
                self.read_count = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def geturl(self) -> str:
                return self.url

            def read(self, _size: int) -> bytes:
                self.read_count += 1
                return b"short" if self.read_count == 1 else b""

        config = RDATA.NETWORKS["waqn"]
        canonical_url = config.base_url + "CAR04_2026.RData"
        with tempfile.TemporaryDirectory() as temporary_directory, mock.patch.object(
            RDATA.urllib.request,
            "urlopen",
            return_value=PartialResponse(canonical_url),
        ):
            destination = Path(temporary_directory) / "CAR04_2026.RData"
            with self.assertRaisesRegex(RuntimeError, "download was incomplete"):
                RDATA.download_pinned(
                    canonical_url,
                    destination,
                    config=config,
                )
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name(destination.name + ".part").exists())

    def test_malformed_present_site_year_remains_fail_closed(self) -> None:
        def download(url: str, _destination: Path, **_kwargs):
            return {
                "bytes": 100,
                "sha256": "e" * 64,
                "etag": None,
                "last_modified": None,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaisesRegex(
                RuntimeError, "site-year RData decode failed closed"
            ):
                self.run_acquisition(
                    metadata_rows=[self.metadata_row()],
                    download_side_effect=download,
                    temporary_directory=temporary_directory,
                    decode_side_effect=RuntimeError("malformed workspace"),
                )

    def test_absent_site_does_not_stop_other_available_site(self) -> None:
        self.add_binding(
            site_code="SITE2",
            station_id=102,
            timeseries_id=1002,
            phenomenon_id=2002,
            observed_property_id=12,
            canonical_code="no2",
            label="NO2",
        )

        def download(url: str, _destination: Path, **_kwargs):
            if url.endswith("SITE1_2026.RData"):
                raise RDATA.AuthoritativeSourceArtifactAbsent(
                    canonical_url=url,
                    final_url=url,
                    requested_at_utc="2026-10-06T00:00:00+00:00",
                )
            return {
                "bytes": 100,
                "sha256": "f" * 64,
                "etag": None,
                "last_modified": None,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            result = self.run_acquisition(
                metadata_rows=[
                    self.metadata_row(site_code="SITE1"),
                    self.metadata_row(site_code="SITE2"),
                ],
                download_side_effect=download,
                temporary_directory=temporary_directory,
                decoded_rows=[{
                    "date": "2026-09-28T00:00:00Z",
                    "NO2": "17.5",
                }],
            )
        self.assertEqual(result["metrics"]["site_year_files_fetched"], 1)
        self.assertEqual(
            result["metrics"]["site_year_files_source_unavailable"], 1
        )
        counts, evidence = INTEGRITY._official_rdata_source_counts_for_partition(
            source_key="waqn",
            day_utc="2026-09-28",
            pollutant_code="no2",
        )
        self.assertEqual(counts, {1002: 1})
        self.assertEqual(evidence["source_available_timeseries_ids"], [1002])
        self.assertEqual(evidence["source_unavailable_timeseries_ids"], [1001])
        gap = INTEGRITY._build_v2_source_r2_mismatch_gap_if_complete(
            source_partition_evidence=evidence,
            day_utc="2026-09-28",
            connector_id=9,
            pollutant_code="no2",
            expected_path="manifest.json",
            source_counts=counts,
            r2_counts={1002: 1},
        )
        self.assertIsNone(gap)

    def test_january_split_marks_only_missing_raw_year_artifact(self) -> None:
        def download(url: str, _destination: Path, **_kwargs):
            if url.endswith("SITE1_2025.RData"):
                raise RDATA.AuthoritativeSourceArtifactAbsent(
                    canonical_url=url,
                    final_url=url,
                    requested_at_utc="2026-10-06T00:00:00+00:00",
                )
            return {
                "bytes": 100,
                "sha256": "1" * 64,
                "etag": None,
                "last_modified": None,
            }

        with tempfile.TemporaryDirectory() as temporary_directory:
            result = self.run_acquisition(
                metadata_rows=[self.metadata_row()],
                download_side_effect=download,
                temporary_directory=temporary_directory,
                from_day="2026-01-01",
                to_day="2026-01-01",
            )
        self.assertEqual(result["metrics"]["site_year_files_fetched"], 1)
        [scope] = result["metrics"]["source_unavailable_scopes"]
        self.assertEqual(scope["source_year"], 2025)
        self.assertEqual(
            scope["raw_source_windows"],
            [{
                "canonical_day_utc": "2026-01-01",
                "raw_start_utc": "2025-12-31T23:00:00Z",
                "raw_end_exclusive_utc": "2026-01-01T00:00:00Z",
            }],
        )

    def test_january_missing_prior_year_keeps_present_year_source_rows(self) -> None:
        def download(url: str, _destination: Path, **_kwargs):
            if url.endswith("SITE1_2025.RData"):
                raise RDATA.AuthoritativeSourceArtifactAbsent(
                    canonical_url=url,
                    final_url=url,
                    requested_at_utc="2026-10-06T00:00:00+00:00",
                )
            return {
                "bytes": 100,
                "sha256": "2" * 64,
                "etag": None,
                "last_modified": None,
            }

        present_year_rows = [{
            "date": f"2026-01-01T{hour:02}:00:00Z",
            "NO2": str(10 + hour),
        } for hour in range(23)]
        with tempfile.TemporaryDirectory() as temporary_directory:
            self.run_acquisition(
                metadata_rows=[self.metadata_row()],
                download_side_effect=download,
                temporary_directory=temporary_directory,
                from_day="2026-01-01",
                to_day="2026-01-01",
                decoded_rows=present_year_rows,
            )

        context = INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"]
        rows = context["rows_by_day"]["2026-01-01"]
        self.assertEqual(len(rows), 23)
        self.assertEqual(rows[0]["observed_at_utc"], "2026-01-01T01:00:00.000Z")
        self.assertEqual(rows[-1]["observed_at_utc"], "2026-01-01T23:00:00.000Z")
        [scope] = context["source_unavailable_by_day"]["2026-01-01"]
        self.assertEqual(scope["canonical_unavailable_windows"], [{
            "canonical_day_utc": "2026-01-01",
            "canonical_start_utc": "2026-01-01T00:00:00Z",
            "canonical_end_exclusive_utc": "2026-01-01T01:00:00Z",
        }])
        counts, evidence = INTEGRITY._official_rdata_source_counts_for_partition(
            source_key="waqn",
            day_utc="2026-01-01",
            pollutant_code="no2",
        )
        self.assertEqual(counts, {1001: 23})
        self.assertEqual(evidence["source_available_timeseries_ids"], [1001])
        self.assertEqual(evidence["source_unavailable_timeseries_ids"], [1001])
        self.assertEqual(evidence["comparison_scope"], "source_available_timestamp_windows")

    def test_january_proposal_preserves_only_missing_midnight_window(self) -> None:
        midnight = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-01-01T00:00:00.000Z",
            "value": 5.0,
            "verification_status": "R",
        }
        baseline_present_window = {
            **midnight,
            "observed_at_utc": "2026-01-01T01:00:00.000Z",
            "value": 99.0,
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            result, evidence, preserved = self.run_partial_january_proposal(
                temporary_directory=temporary_directory,
                baseline_rows=[midnight, baseline_present_window],
            )

        self.assertEqual(result["source_timeseries_row_counts"], {"1001": 23})
        self.assertEqual(result["final_target_timeseries_row_counts"], {"1001": 24})
        self.assertEqual(preserved, [{
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at": "2026-01-01T00:00:00.000Z",
            "value": 5.0,
            "verification_status": "R",
        }])
        self.assertEqual(evidence["total_rows"], 23)
        self.assertEqual(evidence["preserved_baseline_row_count"], 1)
        self.assertEqual(evidence["final_target_row_count"], 24)
        self.assertEqual(evidence["source_available_timeseries_ids"], [1001])
        self.assertEqual(evidence["source_unavailable_timeseries_ids"], [1001])

    def test_january_proposal_does_not_manufacture_missing_baseline_row(self) -> None:
        baseline_present_window = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-01-01T01:00:00.000Z",
            "value": 99.0,
            "verification_status": "R",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            result, evidence, preserved = self.run_partial_january_proposal(
                temporary_directory=temporary_directory,
                baseline_rows=[baseline_present_window],
            )

        self.assertEqual(preserved, [])
        self.assertEqual(result["final_target_timeseries_row_counts"], {"1001": 23})
        self.assertEqual(evidence["preserved_baseline_row_count"], 0)
        self.assertEqual(evidence["final_target_row_count"], 23)

    def test_empty_baseline_comparable_subset_yields_normal_mismatch(self) -> None:
        source_rows = [{
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 10.0,
            "verification_status": "P",
        }]
        with tempfile.TemporaryDirectory() as temporary_directory:
            metrics, observations = self.run_empty_baseline_subset_hash_check(
                temporary_directory=temporary_directory,
                source_rows=source_rows,
            )

        self.assertEqual(metrics["mismatch"], 1)
        self.assertEqual(metrics["invalid_contract"], 0)
        self.assertEqual(
            observations["gaps"][-1]["gap_type"],
            "observation_content_hash_mismatch",
        )

    def test_empty_source_and_baseline_comparable_subsets_verify(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            metrics, observations = self.run_empty_baseline_subset_hash_check(
                temporary_directory=temporary_directory,
                source_rows=[],
            )

        self.assertEqual(metrics["verified"], 1)
        self.assertEqual(metrics["invalid_contract"], 0)
        self.assertEqual(metrics["mismatch"], 0)
        self.assertFalse(observations["gaps"])

    def test_cross_check_filters_baseline_by_exact_unavailable_window(self) -> None:
        day_utc = "2026-01-01"
        self.conn.execute(
            "INSERT INTO core_connectors_snapshot (id, connector_code) "
            "VALUES (9, 'waqn')"
        )
        self.conn.execute(
            "INSERT INTO core_phenomena_snapshot "
            "(id, label, source_label, pollutant_label, observed_property_id, connector_id) "
            "VALUES (2001, 'NO2', 'NO2', 'NO2', NULL, 9)"
        )
        self.conn.execute(
            "INSERT INTO core_timeseries_snapshot "
            "(id, station_id, connector_id, phenomenon_id) VALUES (1001, 101, 9, 2001)"
        )
        self.conn.execute(
            "INSERT INTO source_file_state "
            "(source_file_key, env_name, source_key, remote_scheme, remote_url_or_key, "
            " exists_remote, first_seen_at_utc, last_checked_at_utc, last_status) "
            "VALUES ('waqn:test', 'TEST', 'waqn', 'https', 'https://example.test', "
            " 1, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z', 'unchanged')"
        )
        self.conn.execute(
            "INSERT INTO source_file_timeseries_counts "
            "(source_file_key, day_utc, timeseries_id, row_count, counted_at_utc) "
            "VALUES ('waqn:test', ?, 1001, 23, '2026-10-06T00:00:00Z')",
            (day_utc,),
        )
        unavailable_scope = {
            "day_utc": day_utc,
            "pollutant_code": "no2",
            "timeseries_id": 1001,
            "canonical_unavailable_windows": [{
                "canonical_day_utc": day_utc,
                "canonical_start_utc": "2026-01-01T00:00:00Z",
                "canonical_end_exclusive_utc": "2026-01-01T01:00:00Z",
            }],
        }
        source_rows = [{
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": f"2026-01-01T{hour:02}:00:00.000Z",
        } for hour in range(1, 24)]
        baseline_rows = [{
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": f"2026-01-01T{hour:02}:00:00.000Z",
        } for hour in range(24)]
        INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"] = {
            "connector_id": 9,
            "bindings": {
                "SITE1": {
                    "no2": {"station_id": 101, "timeseries_id": 1001},
                },
            },
            "rows_by_day": {day_utc: source_rows},
            "source_unavailable_by_day": {day_utc: [unavailable_scope]},
        }
        with tempfile.TemporaryDirectory() as temporary_directory, mock.patch.object(
            INTEGRITY,
            "_read_r2_timeseries_manifest_counts",
            return_value=({1001: 24}, None, None),
        ), mock.patch.object(
            INTEGRITY,
            "_observation_rows_from_local_parquet_for_shared_hash",
            return_value=baseline_rows,
        ) as parquet_reader:
            metrics = INTEGRITY.run_r2_cross_checks(
                self.conn,
                run_id=1,
                env_name="TEST",
                source_filter="waqn",
                from_day=day_utc,
                to_day=day_utc,
                r2_history_root=temporary_directory,
                r2_manifest_prefix="history/v3/observations_timeseries",
                checked_at_utc="2026-10-06T00:00:00Z",
                log=logging.getLogger("official-rdata-cross-check-test"),
            )

        parquet_reader.assert_called_once()
        self.assertEqual(metrics["cross_checks_ok"], 1)
        self.assertEqual(metrics["discrepancy_total"], 0)
        self.assertEqual(
            self.conn.execute(
                "SELECT source_row_count, r2_row_count, status FROM cross_checks"
            ).fetchall(),
            [(23, 23, "ok")],
        )

    def test_proposal_represents_source_available_empty_final_target(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        helper = (
            repo_root / "scripts/uk-aq-history-integrity/bin/integrity/"
            "official_network_rdata_proposal.mjs"
        )
        writer_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_root, check=True,
            text=True, stdout=subprocess.PIPE,
        ).stdout.strip()
        payload = {
            "history_generation": "v3",
            "day_utc": "2026-09-28",
            "connector_id": 9,
            "source_adapter": "waqn",
            "requested_pollutant_set": ["no2"],
            "backed_up_at_utc": "2026-10-06T00:00:00Z",
            "rows": [],
            "preserved_baseline_rows": [],
            "preserved_baseline_identity": {
                "source": "dropbox", "partition_identities": [],
            },
            "source_available_timeseries_ids": [1001],
            "source_available_pollutant_codes": ["no2"],
            "source_unavailable_timeseries_ids": [],
            "source_unavailable_scopes": [],
            "source_file_identities": [{
                "source_file": "waqn:metadata", "sha256": "a" * 64, "bytes": 100,
            }],
            "required_source_files": ["waqn:metadata"],
            "authoritatively_absent_source_files": [],
            "authoritative_mapping_sha256": "b" * 64,
            "observed_property_mapping_sha256": "c" * 64,
            "ratification_audit": [],
            "mapping_audit": {"mapped_source_groups": [], "excluded_source_groups": []},
            "rscript_identity": {"executable": "/usr/bin/Rscript", "version": "test"},
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_path = root / "input.json"
            input_path.write_text(json.dumps(payload), encoding="utf-8")
            completed = subprocess.run(
                [
                    "node", str(helper), str(input_path), str(root / "stage"),
                    "history/v3/observations", writer_sha, "v3",
                ],
                cwd=repo_root, text=True, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            evidence = json.loads((
                root / "stage/day_utc=2026-09-28/connector_id=9/source-evidence.json"
            ).read_text(encoding="utf-8"))
            generated = root / "stage/generated-objects"
            self.assertFalse(list(generated.rglob("*.parquet")))
            self.assertFalse(list(generated.rglob("manifest.json")))
            run_state = {
                "overlay_root": str(root / "stage"),
                "run_state_path": str(root / "run-state.json"),
                "objects": {},
                "tombstone_prefixes": [],
            }
            captured = INTEGRITY._capture_local_v2_observation_scope(
                run_state=run_state,
                day_utc="2026-09-28",
                connector_id=9,
                repair_pollutants=["no2"],
            )
            self.assertEqual(captured, [])
            self.assertEqual(run_state["objects"], {})
            self.assertEqual(run_state["tombstone_prefixes"], [{
                "prefix": (
                    "history/v3/observations/day_utc=2026-09-28/"
                    "connector_id=9/pollutant_code=no2"
                ),
                "proposed": True,
                "deleted": False,
                "deletion_verified": False,
                "stage": "observations_data",
                "repair_pollutants": ["no2"],
            }])

        empty_hash = "ba11f8ae1a68f90774b65d0e7cee54d827699dcade0af06e15a4262f4fa489c7"
        self.assertEqual(evidence["empty_final_target_pollutant_codes"], ["no2"])
        self.assertEqual(evidence["final_target_pollutant_counts"], {"no2": 0})
        self.assertEqual(
            evidence["observation_content_hashes"]["no2"]["observation_content_hash"],
            empty_hash,
        )
        self.assertEqual(
            evidence["final_target_observation_content_hashes"]["no2"]["observation_content_hash"],
            empty_hash,
        )

    def test_proposal_keeps_source_and_preserved_baseline_rows_separate(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        helper = (
            repo_root / "scripts/uk-aq-history-integrity/bin/integrity/"
            "official_network_rdata_proposal.mjs"
        )
        writer_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        source_row = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 10.0,
            "verification_status": "P",
        }
        preserved_row = {
            "connector_id": 9,
            "station_id": 102,
            "timeseries_id": 1002,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 20.0,
            "verification_status": "R",
        }
        for label, source_rows, available_ids, available_pollutants in (
            ("mixed", [source_row], [1001], ["no2"]),
            ("available_empty_with_preserved", [], [1001], ["no2"]),
            ("unavailable_only", [], [], []),
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                payload = {
                    "history_generation": "v3",
                    "day_utc": "2026-09-28",
                    "connector_id": 9,
                    "source_adapter": "waqn",
                    "requested_pollutant_set": ["no2"],
                    "backed_up_at_utc": "2026-10-06T00:00:00Z",
                    "rows": source_rows,
                    "preserved_baseline_rows": [preserved_row],
                    "preserved_baseline_identity": {
                        "source": "dropbox",
                        "partition_identities": [{
                            "pollutant_code": "no2",
                            "preserved_row_count": 1,
                        }],
                    },
                    "source_available_timeseries_ids": available_ids,
                    "source_available_pollutant_codes": available_pollutants,
                    "source_unavailable_timeseries_ids": [1002],
                    "source_unavailable_scopes": [{
                        "day_utc": "2026-09-28",
                        "site_code": "SITE2",
                        "source_year": 2026,
                        "source_file_key": "waqn:site_ref=SITE2:year=2026",
                        "pollutant_code": "no2",
                        "station_id": 102,
                        "timeseries_id": 1002,
                        "reason": "source_artifact_unavailable",
                        "canonical_unavailable_windows": [{
                            "canonical_day_utc": "2026-09-28",
                            "canonical_start_utc": "2026-09-28T00:00:00Z",
                            "canonical_end_exclusive_utc": "2026-09-29T00:00:00Z",
                        }],
                    }],
                    "source_file_identities": [{
                        "source_file": "waqn:metadata",
                        "sha256": "a" * 64,
                        "bytes": 100,
                    }],
                    "required_source_files": ["waqn:metadata"],
                    "authoritatively_absent_source_files": [],
                    "authoritative_mapping_sha256": "b" * 64,
                    "observed_property_mapping_sha256": "c" * 64,
                    "ratification_audit": [],
                    "mapping_audit": {
                        "mapped_source_groups": [],
                        "excluded_source_groups": [],
                    },
                    "rscript_identity": {
                        "executable": "/usr/bin/Rscript",
                        "version": "test",
                    },
                }
                input_path = root / "input.json"
                input_path.write_text(json.dumps(payload), encoding="utf-8")
                completed = subprocess.run(
                    [
                        "node", str(helper), str(input_path), str(root / "stage"),
                        "history/v3/observations", writer_sha, "v3",
                    ],
                    cwd=repo_root,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                evidence_path = (
                    root / "stage/day_utc=2026-09-28/connector_id=9/"
                    "source-evidence.json"
                )
                evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
                self.assertEqual(evidence["total_rows"], len(source_rows))
                self.assertEqual(evidence["preserved_baseline_row_count"], 1)
                self.assertEqual(
                    evidence["final_target_row_count"], len(source_rows) + 1
                )
                self.assertEqual(
                    evidence["per_timeseries_counts"],
                    {"1001": 1} if source_rows else {},
                )
                self.assertEqual(
                    evidence["final_target_timeseries_row_counts"],
                    ({"1001": 1, "1002": 1} if source_rows else {"1002": 1}),
                )
                self.assertEqual(
                    evidence["source_unavailable_timeseries_ids"], [1002]
                )
                if label == "available_empty_with_preserved":
                    empty_hash = evidence["observation_content_hashes"]["no2"]
                    self.assertEqual(
                        empty_hash["observation_content_hash"],
                        "ba11f8ae1a68f90774b65d0e7cee54d827699dcade0af06e15a4262f4fa489c7",
                    )
                    self.assertEqual(
                        empty_hash["observation_content_hash_row_count"], 0
                    )
                    validated_evidence, validated_rows = (
                        INTEGRITY._load_complete_connector_day_source_evidence(
                            stage_root=root / "stage",
                            day_utc="2026-09-28",
                            connector_id=9,
                            repair_pollutants=["no2"],
                        )
                    )
                    self.assertEqual(validated_rows, [])
                    self.assertEqual(
                        validated_evidence["observation_content_hashes"][
                            "no2"
                        ]["observation_content_hash_row_count"],
                        0,
                    )
                elif label == "unavailable_only":
                    self.assertNotIn("no2", evidence["observation_content_hashes"])
                self.assertNotEqual(
                    evidence["canonical_rows_sha256"],
                    evidence["preserved_baseline_rows_sha256"],
                )
                generated_parquets = list(
                    (root / "stage/generated-objects").rglob("*.parquet")
                )
                self.assertTrue(generated_parquets)
                pollutant_manifest_path = next(
                    path for path in (root / "stage/generated-objects").rglob(
                        "manifest.json"
                    )
                    if "pollutant_code=no2" in path.as_posix()
                )
                pollutant_manifest = json.loads(
                    pollutant_manifest_path.read_text(encoding="utf-8")
                )
                self.assertEqual(
                    int(pollutant_manifest["row_count"]), len(source_rows) + 1
                )
                self.assertEqual(
                    set(evidence["final_target_timeseries_row_counts"]),
                    ({"1001", "1002"} if source_rows else {"1002"}),
                )
                self.assertFalse(list((root / "stage").rglob("*tombstone*")))

    def test_prepare_proposal_reads_unavailable_rows_only_from_pinned_baseline(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        day_utc = "2026-09-28"
        partition_prefix = (
            "history/v3/observations/day_utc=2026-09-28/connector_id=9/"
            "pollutant_code=no2"
        )
        preserved_row = {
            "connector_id": 9,
            "station_id": 102,
            "timeseries_id": 1002,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 20.0,
            "verification_status": "R",
        }
        source_row = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 10.0,
            "verification_status": "P",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            baseline_root = root / "baseline"
            parquet_key = f"{partition_prefix}/part-00000.parquet"
            parquet_path = baseline_root / parquet_key
            parquet_path.parent.mkdir(parents=True)
            parquet_body = b"pinned-baseline-parquet"
            parquet_path.write_bytes(parquet_body)
            manifest_path = baseline_root / partition_prefix / "manifest.json"
            manifest_path.write_text(json.dumps({
                "files": [{
                    "key": parquet_key,
                    "bytes": len(parquet_body),
                    "etag_or_hash": hashlib.sha256(parquet_body).hexdigest(),
                }],
            }), encoding="utf-8")
            unavailable_scope = {
                "day_utc": day_utc,
                "site_code": "SITE2",
                "source_year": 2026,
                "source_file_key": "waqn:site_ref=SITE2:year=2026",
                "pollutant_code": "no2",
                "station_id": 102,
                "timeseries_id": 1002,
                "reason": "source_artifact_unavailable",
                "canonical_url": "https://airquality.gov.wales/sites/default/files/"
                "openair/R_data/SITE2_2026.RData",
                "final_url": "https://www.airquality.gov.wales/sites/default/files/"
                "openair/R_data/SITE2_2026.RData",
                "http_status": 404,
                "raw_source_windows": [],
                "canonical_unavailable_windows": [{
                    "canonical_day_utc": day_utc,
                    "canonical_start_utc": "2026-09-28T00:00:00Z",
                    "canonical_end_exclusive_utc": "2026-09-29T00:00:00Z",
                }],
            }
            INTEGRITY.OFFICIAL_RDATA_RUN_CONTEXTS["waqn"] = {
                "source_key": "waqn",
                "connector_id": 9,
                "bindings": {
                    "SITE1": {"no2": {"station_id": 101, "timeseries_id": 1001}},
                    "SITE2": {"no2": {"station_id": 102, "timeseries_id": 1002}},
                },
                "rows_by_day": {day_utc: [source_row]},
                "source_unavailable_by_day": {day_utc: [unavailable_scope]},
                "required_by_day": {day_utc: ["waqn:metadata", "waqn:site_ref=SITE1:year=2026"]},
                "identities_by_key": {
                    "waqn:metadata": {
                        "source_file": "waqn:metadata", "bytes": 1, "sha256": "a" * 64,
                    },
                    "waqn:site_ref=SITE1:year=2026": {
                        "source_file": "waqn:site_ref=SITE1:year=2026",
                        "bytes": 1,
                        "sha256": "b" * 64,
                    },
                },
                "absent_keys": [],
                "authoritative_mapping_sha256": "c" * 64,
                "observed_property_mapping_sha256": "d" * 64,
                "audits_by_day": {day_utc: []},
                "mapping_audit": {
                    "mapped_source_groups": [], "excluded_source_groups": [],
                },
                "rscript_identity": {
                    "executable": "/usr/bin/Rscript", "version": "test",
                },
            }
            stage_root = root / "stage"
            with mock.patch.object(
                INTEGRITY,
                "resolve_r2_history_root",
                return_value=baseline_root,
            ), mock.patch.object(
                INTEGRITY,
                "_observation_rows_from_local_parquet_for_shared_hash",
                return_value=[preserved_row],
            ) as baseline_reader:
                result = INTEGRITY._prepare_official_rdata_proposal(
                    source_key="waqn",
                    day_utc=day_utc,
                    connector_id=9,
                    selected_pollutants=["no2"],
                    stage_root=stage_root,
                    env={"UK_AQ_OPS_REPO_ROOT": str(repo_root)},
                    history_generation="v3",
                )
            self.assertEqual(baseline_reader.call_count, 1)
            self.assertEqual(result["source_timeseries_row_counts"], {"1001": 1})
            self.assertEqual(
                result["final_target_timeseries_row_counts"],
                {"1001": 1, "1002": 1},
            )
            self.assertEqual(result["preserved_baseline_rows"], 1)
            evidence = json.loads((
                stage_root / f"day_utc={day_utc}/connector_id=9/source-evidence.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(evidence["total_rows"], 1)
            self.assertEqual(evidence["preserved_baseline_row_count"], 1)
            self.assertEqual(evidence["final_target_row_count"], 2)
            validated_evidence, validated_source_rows = (
                INTEGRITY._load_complete_connector_day_source_evidence(
                    stage_root=stage_root,
                    day_utc=day_utc,
                    connector_id=9,
                    repair_pollutants=["no2"],
                )
            )
            self.assertEqual(validated_source_rows[0]["timeseries_id"], 1001)
            self.assertEqual(
                validated_evidence["source_unavailable_timeseries_ids"],
                [1002],
            )
            [partition_identity] = evidence[
                "preserved_baseline_identity"
            ]["partition_identities"]
            self.assertEqual(partition_identity["baseline_state"], "partition_present")
            self.assertEqual(
                partition_identity["object_identities"][1]["sha256"],
                hashlib.sha256(parquet_body).hexdigest(),
            )

    def test_mixed_multi_pollutant_proposal_retains_empty_target_scope(self) -> None:
        source_row = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 10.0,
            "verification_status": "P",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            stage_root, evidence = self.stage_official_proposal(
                root,
                requested_pollutants=["no2", "pm10"],
                rows=[source_row],
                source_available_pollutants=["no2", "pm10"],
            )
            generated = stage_root / "generated-objects"
            self.assertTrue(list(
                generated.rglob("pollutant_code=no2/part-*.parquet")
            ))
            self.assertTrue(list(
                generated.rglob("pollutant_code=no2/manifest.json")
            ))
            self.assertFalse(list(
                generated.rglob("pollutant_code=pm10/part-*.parquet")
            ))
            self.assertFalse(list(
                generated.rglob("pollutant_code=pm10/manifest.json")
            ))
            self.assertEqual(evidence["evidence_contract_version"], 6)
            self.assertEqual(
                evidence["source_evidence_input_sha256"],
                INTEGRITY._source_evidence_input_sha256(evidence),
            )
            self.assertEqual(
                evidence["preserved_baseline_dependency_sha256"],
                INTEGRITY._official_rdata_preserved_baseline_dependency_sha256(
                    evidence
                ),
            )
            run_state = {
                "overlay_root": str(stage_root),
                "base_dropbox_root": str(root / "baseline"),
                "run_state_path": str(root / "run-state.json"),
                "objects": {},
                "tombstone_prefixes": [],
            }
            with mock.patch.object(
                INTEGRITY,
                "_observation_rows_from_local_parquet_for_shared_hash",
                return_value=[source_row],
            ):
                captured = INTEGRITY._capture_local_v2_observation_scope(
                    run_state=run_state,
                    day_utc="2026-09-28",
                    connector_id=9,
                    repair_pollutants=["no2", "pm10"],
                )
            self.assertTrue(captured)
            self.assertTrue(all("pollutant_code=no2" in key for key in captured))
            self.assertEqual(
                [entry["prefix"].rsplit("=", 1)[-1]
                 for entry in run_state["tombstone_prefixes"]],
                ["no2", "pm10"],
            )
            changed, empty = INTEGRITY._observation_changed_scope_pollutants(
                validated_overlay_keys=captured,
                source_evidence=evidence,
                requested_repair_pollutants=["no2", "pm10"],
            )
            self.assertEqual(changed, ["no2", "pm10"])
            self.assertEqual(empty, ["pm10"])
            outcomes = INTEGRITY._official_rdata_selected_partition_outcomes(
                day_utc="2026-09-28",
                connector_id=9,
                pollutant_codes=changed,
                empty_pollutant_codes=empty,
                validated_overlay_keys=captured,
                created_tombstones=[
                    entry["prefix"]
                    for entry in run_state["tombstone_prefixes"]
                ],
            )
            self.assertEqual(
                [(item["pollutant_code"], item["outcome"])
                 for item in outcomes],
                [
                    ("no2", "complete_replacement"),
                    ("pm10", "authoritative_no_data_replacement"),
                ],
            )
            self.assertTrue(all(item["tombstone_created"] for item in outcomes))
            self.assertTrue(outcomes[0]["replacement_object_keys"])
            self.assertEqual(outcomes[1]["replacement_object_keys"], [])

    def test_all_empty_multi_pollutant_proposal_has_no_synthetic_objects(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            stage_root, evidence = self.stage_official_proposal(
                root,
                requested_pollutants=["no2", "pm10"],
                rows=[],
                source_available_pollutants=["no2", "pm10"],
            )
            generated = stage_root / "generated-objects"
            self.assertFalse(list(generated.rglob("*.parquet")))
            self.assertFalse(list(generated.rglob("manifest.json")))
            run_state = {
                "overlay_root": str(stage_root),
                "run_state_path": str(root / "run-state.json"),
                "objects": {},
                "tombstone_prefixes": [],
            }
            captured = INTEGRITY._capture_local_v2_observation_scope(
                run_state=run_state,
                day_utc="2026-09-28",
                connector_id=9,
                repair_pollutants=["no2", "pm10"],
            )
            self.assertEqual(captured, [])
            changed, empty = INTEGRITY._observation_changed_scope_pollutants(
                validated_overlay_keys=captured,
                source_evidence=evidence,
                requested_repair_pollutants=["no2", "pm10"],
            )
            self.assertEqual(changed, ["no2", "pm10"])
            self.assertEqual(empty, ["no2", "pm10"])
            actions = INTEGRITY._merge_changed_observation_metadata_actions(
                [],
                [{
                    "day_utc": "2026-09-28",
                    "connector_id": 9,
                    "timeseries_ids": [],
                    "pollutant_codes": changed,
                    "empty_pollutant_codes": empty,
                }],
            )
            leaf_actions = {
                (action["kind"], action.get("pollutant_code"))
                for action in actions
            }
            self.assertNotIn(
                ("observation_pollutant_manifest_repair", "no2"), leaf_actions
            )
            self.assertNotIn(
                ("observation_pollutant_manifest_repair", "pm10"), leaf_actions
            )
            self.assertIn(("observation_index_repair", "no2"), leaf_actions)
            self.assertIn(("observation_index_repair", "pm10"), leaf_actions)
            self.assertIn(
                ("observation_connector_manifest_repair", None), leaf_actions
            )
            self.assertIn(("observation_day_manifest_repair", None), leaf_actions)

    def test_mixed_metadata_actions_skip_only_empty_pollutant_manifest(self) -> None:
        actions = INTEGRITY._merge_changed_observation_metadata_actions(
            [],
            [{
                "day_utc": "2026-09-28",
                "connector_id": 9,
                "timeseries_ids": [1001],
                "pollutant_codes": ["no2", "pm10"],
                "empty_pollutant_codes": ["pm10"],
            }],
        )
        leaf_actions = {
            (action["kind"], action.get("pollutant_code")) for action in actions
        }
        self.assertIn(
            ("observation_pollutant_manifest_repair", "no2"), leaf_actions
        )
        self.assertNotIn(
            ("observation_pollutant_manifest_repair", "pm10"), leaf_actions
        )
        self.assertIn(("observation_index_repair", "no2"), leaf_actions)
        self.assertIn(("observation_index_repair", "pm10"), leaf_actions)
        self.assertIn(
            ("observation_connector_manifest_repair", None), leaf_actions
        )
        self.assertIn(("observation_day_manifest_repair", None), leaf_actions)

    def test_wholly_unavailable_pollutant_is_excluded_before_empty_replacement(self) -> None:
        unavailable_scope = {
            "day_utc": "2026-09-28",
            "site_code": "SITE2",
            "source_year": 2026,
            "source_file_key": "waqn:site_ref=SITE2:year=2026",
            "pollutant_code": "pm10",
            "station_id": 102,
            "timeseries_id": 1002,
            "reason": "source_artifact_unavailable",
            "canonical_url": "https://example.test/SITE2_2026.RData",
            "final_url": "https://example.test/SITE2_2026.RData",
            "http_status": 404,
            "raw_source_windows": [],
            "canonical_unavailable_windows": [{
                "canonical_day_utc": "2026-09-28",
                "canonical_start_utc": "2026-09-28T00:00:00Z",
                "canonical_end_exclusive_utc": "2026-09-29T00:00:00Z",
            }],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            stage_root, evidence = self.stage_official_proposal(
                root,
                requested_pollutants=["no2"],
                rows=[],
                source_available_pollutants=["no2"],
                source_unavailable_scopes=[unavailable_scope],
            )
            run_state = {
                "overlay_root": str(stage_root),
                "run_state_path": str(root / "run-state.json"),
                "objects": {},
                "tombstone_prefixes": [],
            }
            captured = INTEGRITY._capture_local_v2_observation_scope(
                run_state=run_state,
                day_utc="2026-09-28",
                connector_id=9,
                repair_pollutants=["no2"],
            )
            self.assertEqual(captured, [])
            self.assertEqual(evidence["empty_final_target_pollutant_codes"], ["no2"])
            self.assertEqual(len(run_state["tombstone_prefixes"]), 1)
            self.assertTrue(
                run_state["tombstone_prefixes"][0]["prefix"].endswith(
                    "pollutant_code=no2"
                )
            )

    def test_preservation_dependency_is_deterministic_and_changes_with_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, evidence_a = self.stage_official_proposal(
                root / "a",
                requested_pollutants=["no2"], rows=[],
                source_available_pollutants=["no2"],
            )
            _, evidence_a_repeat = self.stage_official_proposal(
                root / "a-repeat",
                requested_pollutants=["no2"], rows=[],
                source_available_pollutants=["no2"],
            )
            _, evidence_b = self.stage_official_proposal(
                root / "b",
                requested_pollutants=["no2"], rows=[],
                source_available_pollutants=["no2"],
                preserved_baseline_identity={
                    "source": "dropbox",
                    "partition_identities": [{
                        "pollutant_code": "no2",
                        "baseline_state": "partition_absent",
                        "object_identities": [],
                    }],
                },
            )
            self.assertEqual(
                evidence_a["preserved_baseline_dependency_sha256"],
                evidence_a_repeat["preserved_baseline_dependency_sha256"],
            )
            self.assertEqual(
                evidence_a["source_evidence_input_sha256"],
                evidence_a_repeat["source_evidence_input_sha256"],
            )
            self.assertNotEqual(
                evidence_a["preserved_baseline_dependency_sha256"],
                evidence_b["preserved_baseline_dependency_sha256"],
            )
            self.assertNotEqual(
                evidence_a["source_evidence_input_sha256"],
                evidence_b["source_evidence_input_sha256"],
            )
            first = INTEGRITY._persist_complete_connector_day_source_evidence(
                conn=self.conn, env_name="TEST", evidence=evidence_a,
                canonical_rows=[],
            )
            second = INTEGRITY._persist_complete_connector_day_source_evidence(
                conn=self.conn, env_name="TEST", evidence=evidence_b,
                canonical_rows=[],
            )
            self.assertNotEqual(first["evidence_id"], second["evidence_id"])

    def test_official_rdata_evidence_uses_cross_runtime_utf8_ordering(self) -> None:
        identities = [
            {
                "source_file": "waqn:site_ref=SWA1:year=2026",
                "sha256": "1" * 64,
                "bytes": 101,
            },
            {
                "source_file": "waqn:site_ref=SWA11:year=2026",
                "sha256": "2" * 64,
                "bytes": 111,
            },
            {
                "source_file": "waqn:site_ref=SWA12:year=2026",
                "sha256": "3" * 64,
                "bytes": 112,
            },
        ]
        unavailable_scopes = [
            {
                "day_utc": "2026-09-28",
                "site_code": site_code,
                "source_year": 2026,
                "source_file_key": f"waqn:site_ref={site_code}:year=2026",
                "pollutant_code": "pm10",
                "station_id": station_id,
                "timeseries_id": timeseries_id,
                "reason": "source_artifact_unavailable",
                "canonical_url": (
                    f"https://example.test/{site_code}_2026.RData"
                ),
                "final_url": f"https://example.test/{site_code}_2026.RData",
                "http_status": 404,
                "raw_source_windows": [],
                "canonical_unavailable_windows": [{
                    "canonical_day_utc": "2026-09-28",
                    "canonical_start_utc": "2026-09-28T00:00:00Z",
                    "canonical_end_exclusive_utc": "2026-09-29T00:00:00Z",
                }],
            }
            for site_code, station_id, timeseries_id in (
                ("SWA1", 201, 2001),
                ("SWA11", 211, 2011),
            )
        ]
        expected_source_files = [
            "waqn:site_ref=SWA11:year=2026",
            "waqn:site_ref=SWA12:year=2026",
            "waqn:site_ref=SWA1:year=2026",
        ]
        source_row = {
            "connector_id": 9,
            "station_id": 101,
            "timeseries_id": 1001,
            "pollutant_code": "no2",
            "observed_at_utc": "2026-09-28T01:00:00.000Z",
            "value": 10.0,
            "verification_status": "P",
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            stage_a, evidence_a = self.stage_official_proposal(
                root / "a",
                requested_pollutants=["no2", "pm10"],
                rows=[source_row],
                source_available_pollutants=["no2"],
                source_unavailable_scopes=unavailable_scopes,
                source_file_identities=identities,
            )
            stage_b, evidence_b = self.stage_official_proposal(
                root / "b",
                requested_pollutants=["no2", "pm10"],
                rows=[source_row],
                source_available_pollutants=["no2"],
                source_unavailable_scopes=list(reversed(unavailable_scopes)),
                source_file_identities=list(reversed(identities)),
            )
            _, evidence_changed = self.stage_official_proposal(
                root / "changed",
                requested_pollutants=["no2", "pm10"],
                rows=[source_row],
                source_available_pollutants=["no2"],
                source_unavailable_scopes=unavailable_scopes,
                source_file_identities=[
                    identities[0],
                    {**identities[1], "sha256": "f" * 64},
                    identities[2],
                ],
            )

            validated, validated_rows = (
                INTEGRITY._load_complete_connector_day_source_evidence(
                    stage_root=stage_a,
                    day_utc="2026-09-28",
                    connector_id=9,
                    repair_pollutants=["no2", "pm10"],
                )
            )
            self.assertEqual(
                [identity["source_file"] for identity in validated[
                    "source_file_identities"
                ]],
                expected_source_files,
            )
            self.assertEqual(
                evidence_a["source_file_identities_sha256"],
                evidence_b["source_file_identities_sha256"],
            )
            self.assertEqual(
                evidence_a["source_artifact_availability_sha256"],
                evidence_b["source_artifact_availability_sha256"],
            )
            self.assertEqual(
                evidence_a["source_artifact_availability_sha256"],
                INTEGRITY._official_rdata_source_artifact_availability_sha256(
                    evidence_a
                ),
            )
            self.assertEqual(
                evidence_a["preserved_baseline_dependency_sha256"],
                evidence_b["preserved_baseline_dependency_sha256"],
            )
            self.assertEqual(
                evidence_a["preserved_baseline_dependency_sha256"],
                INTEGRITY._official_rdata_preserved_baseline_dependency_sha256(
                    evidence_a
                ),
            )
            persisted_a = INTEGRITY._persist_complete_connector_day_source_evidence(
                conn=self.conn,
                env_name="TEST",
                evidence=evidence_a,
                canonical_rows=validated_rows,
            )
            persisted_b = INTEGRITY._persist_complete_connector_day_source_evidence(
                conn=self.conn,
                env_name="TEST",
                evidence=evidence_b,
                canonical_rows=validated_rows,
            )
            self.assertEqual(
                persisted_a["evidence_id"], persisted_b["evidence_id"]
            )
            self.assertNotEqual(
                evidence_a["source_file_identities_sha256"],
                evidence_changed["source_file_identities_sha256"],
            )
            self.assertNotEqual(
                evidence_a["source_evidence_input_sha256"],
                evidence_changed["source_evidence_input_sha256"],
            )

            evidence_b_path = (
                stage_b / "day_utc=2026-09-28/connector_id=9/"
                "source-evidence.json"
            )
            tampered_availability = json.loads(
                evidence_b_path.read_text(encoding="utf-8")
            )
            tampered_availability[
                "source_artifact_availability_sha256"
            ] = "d" * 64
            tampered_availability["source_evidence_input_sha256"] = (
                INTEGRITY._source_evidence_input_sha256(tampered_availability)
            )
            evidence_b_path.write_text(
                json.dumps(tampered_availability), encoding="utf-8"
            )
            with self.assertRaisesRegex(
                ValueError,
                "source artifact availability identity is invalid",
            ):
                INTEGRITY._load_complete_connector_day_source_evidence(
                    stage_root=stage_b,
                    day_utc="2026-09-28",
                    connector_id=9,
                    repair_pollutants=["no2", "pm10"],
                )

            evidence_path = (
                stage_a / "day_utc=2026-09-28/connector_id=9/"
                "source-evidence.json"
            )
            tampered = json.loads(evidence_path.read_text(encoding="utf-8"))
            tampered["source_file_identities"][0]["sha256"] = "e" * 64
            evidence_path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(
                ValueError,
                "source file identities changed",
            ):
                INTEGRITY._load_complete_connector_day_source_evidence(
                    stage_root=stage_a,
                    day_utc="2026-09-28",
                    connector_id=9,
                    repair_pollutants=["no2", "pm10"],
                )

    def test_official_rdata_v6_does_not_advance_sos_contract(self) -> None:
        self.assertEqual(INTEGRITY.OFFICIAL_RDATA_SOURCE_EVIDENCE_CONTRACT_VERSION, 6)
        self.assertEqual(INTEGRITY.SOURCE_EVIDENCE_CONTRACT_VERSION, 4)
        v5_payload = INTEGRITY._source_evidence_input_payload({
            "evidence_contract_version": 5,
            "source_artifact_availability_sha256": "a" * 64,
            "preserved_baseline_dependency_sha256": "b" * 64,
        })
        self.assertEqual(
            v5_payload["source_artifact_availability_sha256"], "a" * 64
        )
        self.assertNotIn(
            "preserved_baseline_dependency_sha256", v5_payload
        )
        v4_payload = INTEGRITY._source_evidence_input_payload({
            "evidence_contract_version": 4,
            "source_artifact_availability_sha256": "a" * 64,
        })
        self.assertNotIn("source_artifact_availability_sha256", v4_payload)

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
