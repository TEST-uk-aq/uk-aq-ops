#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_sos_site_ref_bridge",
    MODULE_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SosSiteRefBridgeTests(unittest.TestCase):
    day_utc = "2026-07-15"

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _connection(
        self,
        *,
        bridge_timeseries_ids: tuple[int, ...] = (144,),
        bridge_site_ref: str = "ABD9",
        include_import_identity: bool = True,
        include_bridge_source_state: bool = True,
    ):
        conn = MODULE.open_db(str(self.root / "integrity.sqlite"))
        conn.execute(
            """
            INSERT INTO core_connectors_snapshot
              (id, connector_code, label)
            VALUES (1, 'sos', 'SOS')
            """
        )
        for timeseries_id in sorted({144, *bridge_timeseries_ids}):
            station_id = 81 if timeseries_id == 144 else timeseries_id
            station_ref = "8126" if timeseries_id == 144 else str(station_id)
            conn.execute(
                """
                INSERT INTO core_stations_snapshot
                  (id, connector_id, station_ref)
                VALUES (?, 1, ?)
                """,
                (station_id, station_ref),
            )
            conn.execute(
                """
                INSERT INTO core_timeseries_snapshot
                  (id, station_id, connector_id, timeseries_ref, label,
                   phenomenon_id)
                VALUES (?, ?, 1, ?, 'NO2', 10)
                """,
                (timeseries_id, station_id, f"ts-{timeseries_id}"),
            )
        conn.execute(
            """
            INSERT INTO core_phenomena_snapshot
              (id, label, source_label, pollutant_label,
               observed_property_id, connector_id)
            VALUES (10, 'NO2', 'Nitrogen dioxide', 'no2', 20, 1)
            """
        )
        conn.execute(
            """
            INSERT INTO core_observed_property_mappings_snapshot
              (id, connector_id, source_label, observed_property_id,
               observed_property_code, mapping_kind, is_aqi_eligible,
               is_active)
            VALUES
              (1, 1, 'Nitrogen dioxide', 20, 'no2',
               'raw_observed_property', 1, 1)
            """
        )
        conn.execute(
            """
            INSERT INTO source_station_timeseries_lookup
              (source_key, source_location_id, station_ref, station_id,
               connector_id, timeseries_id, is_active)
            VALUES ('sos', '8126', '8126', 81, 1, 144, 1)
            """
        )

        source_file_key = "sos:site_ref=ABD9:year=2026"
        conn.execute(
            """
            INSERT INTO source_file_state
              (source_file_key, env_name, source_key, remote_scheme,
               remote_url_or_key, station_ref, source_location_id, day_utc,
               exists_remote, first_seen_at_utc, last_checked_at_utc,
               last_status, source_count_mapping_identity,
               source_count_mapping_hash)
            VALUES (?, 'TEST', 'sos', 'uk_air_flat_file', ?, 'ABD9',
                    'ABD9', '2026-01-01', 1, ?, ?, 'unchanged', ?, ?)
            """,
            (
                source_file_key,
                "https://example.invalid/ABD9_2026.csv",
                "2026-07-25T00:00:00Z",
                "2026-07-25T00:00:00Z",
                MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                "a" * 64,
            ),
        )
        conn.execute(
            """
            INSERT INTO source_file_timeseries_counts
              (source_file_key, day_utc, timeseries_id, row_count,
               counted_at_utc, source_count_mapping_identity,
               source_count_mapping_hash)
            VALUES (?, ?, 144, 24, ?, ?, ?)
            """,
            (
                source_file_key,
                self.day_utc,
                "2026-07-25T00:00:00Z",
                MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                "a" * 64,
            ),
        )

        for timeseries_id in bridge_timeseries_ids:
            station_id = 81 if timeseries_id == 144 else timeseries_id
            conn.execute(
                """
                INSERT INTO sos_station_timeseries_site_refs_snapshot
                  (site_ref, pollutant_code, station_id, timeseries_id,
                   valid_from_day_utc, valid_to_day_utc)
                VALUES (?, 'no2', ?, ?, '2026-01-01', NULL)
                """,
                (bridge_site_ref, station_id, timeseries_id),
            )
        if (
            include_bridge_source_state
            and bridge_site_ref != "ABD9"
            and bridge_timeseries_ids
        ):
            bridge_file_key = (
                f"sos:site_ref={bridge_site_ref}:year=2026"
            )
            conn.execute(
                """
                INSERT INTO source_file_state
                  (source_file_key, env_name, source_key, remote_scheme,
                   remote_url_or_key, station_ref, source_location_id,
                   day_utc, exists_remote, first_seen_at_utc,
                   last_checked_at_utc, last_status,
                   source_count_mapping_identity, source_count_mapping_hash)
                VALUES (?, 'TEST', 'sos', 'uk_air_flat_file', ?, ?, ?,
                        '2026-01-01', 1, ?, ?, 'unchanged', ?, ?)
                """,
                (
                    bridge_file_key,
                    f"https://example.invalid/{bridge_site_ref}_2026.csv",
                    bridge_site_ref,
                    bridge_site_ref,
                    "2026-07-25T00:00:00Z",
                    "2026-07-25T00:00:00Z",
                    MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                    "a" * 64,
                ),
            )
        if include_import_identity:
            bridge_count = conn.execute(
                """
                SELECT COUNT(*)
                FROM sos_station_timeseries_site_refs_snapshot
                """
            ).fetchone()[0]
            conn.execute(
                """
                INSERT INTO core_snapshot_imports
                  (imported_at_utc, env_name, snapshot_path,
                   snapshot_manifest_hash, rows_sos_site_ref_bridge,
                   sos_site_ref_bridge_sha256, status)
                VALUES (?, 'TEST', '/snapshot', ?, ?, ?, 'ok')
                """,
                (
                    "2026-07-25T00:00:00Z",
                    "manifest-sha",
                    bridge_count,
                    "a" * 64,
                ),
            )
        conn.commit()
        return conn

    def _add_non_target_bridge_row(self, conn) -> None:
        conn.execute(
            """
            INSERT INTO core_stations_snapshot
              (id, connector_id, station_ref)
            VALUES (200, 1, 'ACTH')
            """
        )
        conn.execute(
            """
            INSERT INTO core_timeseries_snapshot
              (id, station_id, connector_id, timeseries_ref, label,
               phenomenon_id)
            VALUES
              (200, 200, 1, 'ts-ch2chchch2', '1,3-butadiene', 10)
            """
        )
        conn.execute(
            """
            INSERT INTO sos_station_timeseries_site_refs_snapshot
              (site_ref, pollutant_code, station_id, timeseries_id,
               valid_from_day_utc, valid_to_day_utc)
            VALUES
              ('ACTH', 'ch2chchch2', 200, 200, '2026-01-01', NULL)
            """
        )
        conn.execute(
            """
            UPDATE core_snapshot_imports
            SET rows_sos_site_ref_bridge = 2
            """
        )
        conn.commit()

    def _counts(self, conn):
        return MODULE._current_source_counts_for_v2_partition(
            conn,
            env_name="TEST",
            source_scope={"source": "sos"},
            day_utc=self.day_utc,
            connector_id=1,
            pollutant_code="no2",
        )

    def test_site_ref_bridge_resolves_without_matching_numeric_station_ref(self):
        conn = self._connection()
        try:
            counts, evidence = self._counts(conn)
        finally:
            conn.close()
        self.assertEqual(counts, {144: 24})
        self.assertEqual(
            evidence["identity_resolution"],
            "uk_air_site_ref_to_sos_timeseries_bridge",
        )
        self.assertEqual(evidence["resolved_site_ref_groups"], 1)
        self.assertEqual(evidence["unresolved_site_ref_groups"], 0)

    def test_annual_count_replacement_is_atomic_and_file_scoped(self):
        conn = self._connection()
        try:
            conn.execute(
                """
                INSERT INTO source_file_timeseries_counts
                  (source_file_key, day_utc, timeseries_id, row_count,
                   counted_at_utc)
                VALUES
                  ('sos:site_ref=ABD9:year=2026', '2026-07-14', 999, 12, ?),
                  ('sos:site_ref=OTHER:year=2026', '2026-07-15', 777, 5, ?)
                """,
                ("2026-07-25T00:00:00Z", "2026-07-25T00:00:00Z"),
            )
            result = MODULE._record_source_file_timeseries_counts(
                conn,
                "sos:site_ref=ABD9:year=2026",
                {(self.day_utc, 145): 23},
                "2026-07-25T01:00:00Z",
                source_count_mapping_identity=MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                source_count_mapping_hash="b" * 64,
            )
            rows = conn.execute(
                """
                SELECT source_file_key, day_utc, timeseries_id, row_count,
                       source_count_mapping_hash
                FROM source_file_timeseries_counts
                ORDER BY source_file_key, day_utc, timeseries_id
                """
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual(result, {"deleted_rows": 2, "inserted_rows": 1})
        self.assertEqual(
            rows,
            [
                (
                    "sos:site_ref=ABD9:year=2026",
                    self.day_utc,
                    145,
                    23,
                    "b" * 64,
                ),
                (
                    "sos:site_ref=OTHER:year=2026",
                    self.day_utc,
                    777,
                    5,
                    None,
                ),
            ],
        )

    def test_o3_counts_use_date_valid_bridge_identity(self):
        conn = self._connection()
        try:
            conn.execute(
                """
                UPDATE sos_station_timeseries_site_refs_snapshot
                SET pollutant_code = 'o3'
                """
            )
            conn.commit()
            counts, evidence = MODULE._current_source_counts_for_v2_partition(
                conn,
                env_name="TEST",
                source_scope={"source": "sos"},
                day_utc=self.day_utc,
                connector_id=1,
                pollutant_code="o3",
            )
        finally:
            conn.close()
        self.assertEqual(counts, {144: 24})
        self.assertEqual(evidence["processed_site_ref_groups"], 1)
        self.assertEqual(evidence["legitimate_empty_groups"], 0)

    def test_bridge_import_identity_is_required(self):
        conn = self._connection(include_import_identity=False)
        try:
            counts, evidence = self._counts(conn)
        finally:
            conn.close()
        self.assertEqual(counts, {})
        self.assertEqual(evidence["source_partition_state"], "bridge_unavailable")
        self.assertEqual(
            evidence["source_skip_reason"],
            "sos_site_ref_bridge_import_identity_unavailable",
        )

    def test_all_property_bridge_validates_then_filters_operation_scope(self):
        conn = self._connection()
        try:
            self._add_non_target_bridge_row(conn)
            bridge = MODULE._load_authoritative_sos_bridge_mapping(
                conn,
                connector_id=1,
                target_pollutants=("pm25", "pm10", "no2", "o3"),
            )
        finally:
            conn.close()
        self.assertEqual(bridge["bridge_artifact_row_count"], 2)
        self.assertEqual(bridge["bridge_row_count"], 2)
        self.assertEqual(bridge["selected_bridge_row_count"], 1)
        self.assertEqual(
            [row["pollutant_code"] for row in bridge["rows"]],
            ["no2"],
        )

    def test_bridge_generic_identity_validation_remains_fail_closed(self):
        conn = self._connection()
        try:
            cases = (
                ("site_ref = ''", "invalid SOS site-ref bridge identity"),
                ("pollutant_code = ''", "invalid SOS site-ref bridge identity"),
                (
                    "pollutant_code = 'bad/code'",
                    "invalid SOS site-ref bridge identity",
                ),
                (
                    "valid_from_day_utc = 'not-a-day'",
                    "invalid SOS site-ref bridge validity",
                ),
                (
                    "station_id = 999",
                    "SOS site-ref bridge core ownership mismatch",
                ),
            )
            for assignment, expected in cases:
                with self.subTest(assignment=assignment):
                    conn.execute(
                        "UPDATE sos_station_timeseries_site_refs_snapshot "
                        f"SET {assignment}"
                    )
                    with self.assertRaisesRegex(RuntimeError, expected):
                        MODULE._load_authoritative_sos_bridge_mapping(
                            conn,
                            connector_id=1,
                        )
                    conn.rollback()
        finally:
            conn.close()

    def test_bridge_snapshot_distinguishes_artifact_and_selected_counts(self):
        conn = self._connection()
        try:
            self._add_non_target_bridge_row(conn)
            snapshot_path = self.root / "bridge.json"
            result = MODULE.write_sos_site_ref_bridge_snapshot(
                conn=conn,
                connector_id=1,
                snapshot_path=snapshot_path,
            )
            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
        finally:
            conn.close()
        self.assertEqual(payload["bridge_artifact_row_count"], 2)
        self.assertEqual(payload["selected_bridge_row_count"], 1)
        self.assertEqual(payload["bridge_row_count"], 2)
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(result["bridge_artifact_row_count"], 2)
        self.assertEqual(result["selected_bridge_row_count"], 1)

    def test_v2_acquisition_does_not_query_live_mapping_authority(self):
        conn = self._connection()
        try:
            with mock.patch.object(
                MODULE,
                "_fetch_uk_air_flat_file_mapping_rows",
                side_effect=AssertionError("live mapping query must not run"),
            ):
                metrics = MODULE.check_sos_flat_files(
                    conn,
                    "TEST",
                    {},
                    self.day_utc,
                    self.day_utc,
                    dry_run=True,
                    run_backfill=False,
                    limits=MODULE.LimitTracker(None, None, MODULE.time.monotonic()),
                    log=logging.getLogger("test-v2-sos-mapping-authority"),
                    history_version="v2",
                )
        finally:
            conn.close()
        self.assertTrue(metrics["ran"])
        self.assertEqual(
            metrics["source_count_mapping_identity"],
            MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
        )
        self.assertEqual(metrics["source_count_mapping_hash"], "a" * 64)

    def test_snapshot_reuse_requires_matching_bridge_count_and_hash(self):
        conn = self._connection()
        manifest = {
            "tables": [{
                "table": "sos_station_timeseries_site_refs",
                "row_count": 1,
                "sha256": "a" * 64,
            }]
        }
        previous = MODULE.latest_successful_import(conn, "TEST")
        try:
            self.assertTrue(
                MODULE.snapshot_tables_have_rows(conn, manifest, previous)
            )
            conn.execute(
                """
                UPDATE core_snapshot_imports
                SET sos_site_ref_bridge_sha256 = ?
                """,
                ("b" * 64,),
            )
            conn.commit()
            changed = MODULE.latest_successful_import(conn, "TEST")
            self.assertFalse(
                MODULE.snapshot_tables_have_rows(conn, manifest, changed)
            )
        finally:
            conn.close()

    def test_ambiguous_and_conflicting_bridge_rows_fail_closed(self):
        cases = (
            {
                "bridge_timeseries_ids": (144, 145),
                "bridge_site_ref": "ABD9",
                "expected_counter": "ambiguous_site_ref_groups",
            },
            {
                "bridge_timeseries_ids": (145,),
                "bridge_site_ref": "ABD9",
                "expected_counter": "timeseries_conflict_groups",
            },
        )
        for index, case in enumerate(cases):
            with self.subTest(case=case["expected_counter"]):
                db_root = self.root / str(index)
                db_root.mkdir()
                old_root, self.root = self.root, db_root
                try:
                    conn = self._connection(
                        bridge_timeseries_ids=case["bridge_timeseries_ids"],
                        bridge_site_ref=case["bridge_site_ref"],
                    )
                    try:
                        counts, evidence = self._counts(conn)
                    finally:
                        conn.close()
                finally:
                    self.root = old_root
                self.assertEqual(counts, {})
                self.assertEqual(
                    evidence["source_partition_state"],
                    "mapping_unavailable",
                )
                self.assertEqual(evidence[case["expected_counter"]], 1)

    def test_missing_binding_warning_preserves_complete_canonical_counts(self):
        conn = self._connection()
        try:
            warning = {
                "classification": "no_authoritative_timeseries_binding",
                "reason": "no_authoritative_timeseries_binding",
                "site_ref": "HG4",
                "source_file_key": "sos:site_ref=HG4:year=2026",
                "source_file_sha256": "b" * 64,
                "source_label": "Nitrogen dioxide",
                "normalised_source_label": "nitrogen dioxide",
                "source_labels": ["Nitrogen dioxide"],
                "normalised_source_labels": ["nitrogen dioxide"],
                "pollutant_code": "no2",
                "day_utc": self.day_utc,
                "target_day_non_null_row_count": 24,
                "date_valid_binding_candidate_count": 0,
            }
            notes = (
                "mapping_issues=2026-07-15:no2="
                "no_authoritative_timeseries_binding "
                f"{MODULE._UK_AIR_MISSING_BINDING_NOTES_KEY}="
                f"{MODULE._encode_uk_air_missing_binding_notes([warning])}"
            )
            conn.execute(
                """
                INSERT INTO source_file_state (
                  source_file_key, env_name, source_key, remote_scheme,
                  remote_url_or_key, station_ref, source_location_id,
                  day_utc, exists_remote, first_seen_at_utc,
                  last_checked_at_utc, last_status,
                  sha256_uncompressed,
                  source_count_mapping_identity, source_count_mapping_hash,
                  notes
                ) VALUES (
                  'sos:site_ref=HG4:year=2026', 'TEST', 'sos',
                  'uk_air_flat_file', 'https://example.invalid/HG4_2026.csv',
                  'HG4', 'HG4', '2026-01-01', 1,
                  '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z',
                  'no_authoritative_timeseries_binding', ?, ?, ?, ?
                )
                """,
                (
                    "b" * 64,
                    MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                    "a" * 64,
                    notes,
                ),
            )
            conn.commit()
            counts, evidence = self._counts(conn)
        finally:
            conn.close()
        self.assertEqual(counts, {144: 24})
        self.assertEqual(
            evidence["source_partition_state"], "successful_non_empty"
        )
        self.assertTrue(evidence["source_counts_available"])
        self.assertEqual(evidence["source_rows"], 24)
        self.assertEqual(evidence["expected_site_ref_groups"], 1)
        self.assertEqual(evidence["processed_site_ref_groups"], 1)
        self.assertEqual(evidence["resolved_site_ref_groups"], 1)
        self.assertEqual(evidence["canonical_source_groups"], 1)
        self.assertEqual(evidence["source_groups_examined"], 2)
        self.assertEqual(evidence["unresolved_site_ref_groups"], 0)
        self.assertEqual(evidence["unmapped_site_ref_groups"], 0)
        self.assertEqual(
            evidence["no_authoritative_timeseries_binding_groups"], 1
        )
        self.assertEqual(
            evidence["no_authoritative_timeseries_binding_rows"], 24
        )
        self.assertEqual(
            evidence["no_authoritative_timeseries_binding_warnings"],
            [warning],
        )

        self.assertIsNone(
            MODULE._build_v2_source_r2_mismatch_gap_if_complete(
                day_utc=self.day_utc,
                connector_id=1,
                pollutant_code="no2",
                expected_path="history/v2/observations/example",
                source_counts=counts,
                r2_counts={144: 24},
                source_partition_evidence=evidence,
            )
        )

        gap = MODULE._build_v2_source_r2_mismatch_gap_if_complete(
            day_utc=self.day_utc,
            connector_id=1,
            pollutant_code="no2",
            expected_path="history/v2/observations/example",
            source_counts=counts,
            r2_counts={144: 23},
            source_partition_evidence=evidence,
        )
        self.assertIsNotNone(gap)

    def test_partial_source_population_cannot_create_r2_mismatch(self):
        gap = MODULE._build_v2_source_r2_mismatch_gap_if_complete(
            day_utc=self.day_utc,
            connector_id=1,
            pollutant_code="o3",
            expected_path="history/v2/observations/example",
            source_counts={144: 24},
            r2_counts={144: 24, 145: 24},
            source_partition_evidence={
                "source_partition_state": "mapping_unavailable",
                "source_counts_available": False,
                "source_skip_reason":
                    "r2_timeseries_not_covered_by_date_valid_sos_bridge",
            },
        )
        self.assertIsNone(gap)

    def test_repair_dry_run_with_v2_gaps_is_top_level_failure(self):
        self.assertEqual(
            MODULE._v2_top_level_status_after_repair_planning(
                "ok",
                run_backfill=True,
                dry_run=True,
                coordinator_failed=False,
                any_stopped=False,
                v2_gap_count=1,
            ),
            "fail",
        )

    def test_real_repair_uses_verified_post_repair_gap_count(self):
        cases = (
            {
                "name": "verified_zero_gaps",
                "verified": True,
                "remaining": 0,
                "expected": "ok",
            },
            {
                "name": "final_verification_failed",
                "verified": False,
                "remaining": 0,
                "expected": "fail",
            },
            {
                "name": "remaining_gap",
                "verified": True,
                "remaining": 1,
                "expected": "fail",
            },
        )
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    MODULE._v2_top_level_status_after_repair_planning(
                        "ok",
                        run_backfill=True,
                        dry_run=False,
                        coordinator_failed=False,
                        any_stopped=False,
                        # Initial findings trigger the repair, but do not
                        # override its verified final state.
                        v2_gap_count=4,
                        real_repair_verified=case["verified"],
                        post_repair_gap_count=case["remaining"],
                    ),
                    case["expected"],
                )

    def test_o3_is_part_of_sos_observation_scope_but_not_aqi_scope(self):
        self.assertEqual(
            MODULE._resolve_sos_target_pollutants({}),
            ("pm25", "pm10", "no2", "o3"),
        )
        self.assertEqual(MODULE._uk_air_normalize_pollutant_code("Ozone"), "o3")
        self.assertIn("o3", MODULE.V2_OBSERVATION_INTEGRITY_POLLUTANTS)
        self.assertNotIn("o3", MODULE.V2_AQI_SUPPORTED_POLLUTANTS)

    def test_zero_hash_candidates_block_first_value_at_evidence(self):
        conn = self._connection()
        try:
            observations = {
                "gaps": [{
                    "gap_type": "source_unavailable",
                    "day_utc": self.day_utc,
                    "connector_id": 1,
                }],
                "hash_check_candidates": [],
                "hash_candidates_by_pollutant": {
                    "pm25": 0,
                    "pm10": 0,
                    "no2": 0,
                    "o3": 0,
                },
                "source_resolution_by_pollutant": {
                    "no2": {
                        "source_skip_reason":
                            "sos_site_ref_bridge_mapping_unresolved",
                    }
                },
                "first_value_at_candidate_scopes": [{
                    "day_utc": self.day_utc,
                    "connector_id": 1,
                    "candidates": [{
                        "timeseries_id": 144,
                        "first_observed_at": "2026-07-15T00:00:00Z",
                    }],
                }],
                "first_value_at_evidence": {"blocked_scopes": []},
            }
            sink = []
            metrics = MODULE.run_v2_observation_content_hash_checks(
                conn=conn,
                env_name="TEST",
                run_compact="test",
                env={},
                v2_observations=observations,
                source_scope={"source": "sos"},
                log=logging.getLogger("test"),
                verified_first_value_at_scope_sink=sink,
            )
        finally:
            conn.close()
        self.assertEqual(metrics["checked"], 0)
        self.assertIn(
            "sos_site_ref_bridge_mapping_unresolved",
            metrics["zero_hash_checks_reason"],
        )
        self.assertEqual(sink, [])
        self.assertEqual(
            observations["first_value_at_evidence"]["status"],
            "blocked",
        )


if __name__ == "__main__":
    unittest.main()
