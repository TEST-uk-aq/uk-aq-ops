#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import logging
import sys
import tempfile
import unittest
from pathlib import Path


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
               last_status)
            VALUES (?, 'CIC-Test', 'sos', 'uk_air_flat_file', ?, 'ABD9',
                    'ABD9', '2026-01-01', 1, ?, ?, 'unchanged')
            """,
            (
                source_file_key,
                "https://example.invalid/ABD9_2026.csv",
                "2026-07-25T00:00:00Z",
                "2026-07-25T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO source_file_timeseries_counts
              (source_file_key, day_utc, timeseries_id, row_count,
               counted_at_utc)
            VALUES (?, ?, 144, 24, ?)
            """,
            (source_file_key, self.day_utc, "2026-07-25T00:00:00Z"),
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
                   last_checked_at_utc, last_status)
                VALUES (?, 'CIC-Test', 'sos', 'uk_air_flat_file', ?, ?, ?,
                        '2026-01-01', 1, ?, ?, 'unchanged')
                """,
                (
                    bridge_file_key,
                    f"https://example.invalid/{bridge_site_ref}_2026.csv",
                    bridge_site_ref,
                    bridge_site_ref,
                    "2026-07-25T00:00:00Z",
                    "2026-07-25T00:00:00Z",
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
                VALUES (?, 'CIC-Test', '/snapshot', ?, ?, ?, 'ok')
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

    def _counts(self, conn):
        return MODULE._current_source_counts_for_v2_partition(
            conn,
            env_name="CIC-Test",
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

    def test_snapshot_reuse_requires_matching_bridge_count_and_hash(self):
        conn = self._connection()
        manifest = {
            "tables": [{
                "table": "sos_station_timeseries_site_refs",
                "row_count": 1,
                "sha256": "a" * 64,
            }]
        }
        previous = MODULE.latest_successful_import(conn, "CIC-Test")
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
            changed = MODULE.latest_successful_import(conn, "CIC-Test")
            self.assertFalse(
                MODULE.snapshot_tables_have_rows(conn, manifest, changed)
            )
        finally:
            conn.close()

    def test_unmapped_ambiguous_and_conflicting_bridge_rows_fail_closed(self):
        cases = (
            {
                "bridge_timeseries_ids": (144,),
                "bridge_site_ref": "ZZZ1",
                "expected_counter": "unmapped_site_ref_groups",
            },
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
                env_name="CIC-Test",
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
