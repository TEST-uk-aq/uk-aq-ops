#!/usr/bin/env python3
"""Focused official-network retained verification-scope checks."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "backup_r2/lib/observation_verification_source.py"
)
SPEC = importlib.util.spec_from_file_location(
    "observation_verification_retained_scope_test", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
SOURCE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SOURCE
SPEC.loader.exec_module(SOURCE)


def binding_bytes(
    timeseries_id: int,
    connector_id: int,
    pollutant_code: str,
    station_id: int,
    **extra: object,
) -> bytes:
    return json.dumps({
        "schema_version": 1,
        "history_version": "v2",
        "index_kind": "timeseries_binding",
        "timeseries_id": timeseries_id,
        "connector_id": connector_id,
        "pollutant_code": pollutant_code,
        "station_id": station_id,
        **extra,
    }, sort_keys=True).encode("utf-8")


def provider_audit() -> dict[str, object]:
    return {
        "authenticated_generation_complete": True,
        "observation_generation": "v3",
        "source_root_hash": "a" * 64,
        "pack_root_relative_path": (
            "history/_backup_packs_v1/timeseries_binding/generation=v3/root.json"
        ),
        "pack_root_sha256": "b" * 64,
        "ranges_verified": 3,
        "total_pack_members_verified": 7,
    }


class OfficialRetainedVerificationScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute(
            "CREATE TABLE core_stations_snapshot ("
            "id INTEGER PRIMARY KEY, connector_id INTEGER, station_ref TEXT)"
        )
        self.conn.executemany(
            "INSERT INTO core_stations_snapshot VALUES (?, ?, ?)",
            ((91, 9, "abc"), (92, 9, "DEF")),
        )
        self.members = {
            901: binding_bytes(
                901, 9, "no2", 91, phenomenon_id=1901, observed_property_id=12
            ),
            902: binding_bytes(902, 9, "o3", 91),
            903: binding_bytes(903, 9, "pm10", 92),
            904: binding_bytes(904, 9, "pm25", 92),
            905: binding_bytes(905, 9, "no", 92),
            1001: binding_bytes(1001, 10, "no2", 101),
        }
        self.active_timeseries_ids = [901, 903]
        self.metadata = [
            {"site_id": "ABC", "parameter": "NO2", "ratified_to": "2026-06-30"},
            {"site_id": "ABC", "parameter": "O3", "ratified_to": "Never"},
            {"site_id": "DEF", "parameter": "PM10", "ratified_to": "2026-05-31"},
            {"site_id": "DEF", "parameter": "PM2.5", "ratified_to": ""},
        ]

    def tearDown(self) -> None:
        self.conn.close()

    def build(self):
        return SOURCE.build_official_retained_verification_scope(
            conn=self.conn,
            source_key="waqn",
            connector_id=9,
            authenticated_members=self.members,
            provider_audit=provider_audit(),
            active_selected_timeseries_ids=self.active_timeseries_ids,
            metadata_rows=self.metadata,
        )

    def test_complete_retained_scope_includes_inactive_selected_bindings(self) -> None:
        candidate, boundaries, readiness, audit = self.build()

        self.assertEqual(
            [row["timeseries_id"] for row in candidate],
            [901, 902, 903, 904],
        )
        self.assertEqual(
            {row["pollutant_code"] for row in candidate},
            {"no2", "o3", "pm10", "pm25"},
        )
        self.assertTrue(readiness["publishable"])
        self.assertEqual(
            readiness["binding_scope"],
            "authenticated_retained_v3_binding_pack",
        )
        self.assertEqual(readiness["retained_connector_timeseries_count"], 5)
        self.assertEqual(readiness["retained_selected_timeseries_count"], 4)
        self.assertEqual(readiness["active_selected_timeseries_count"], 2)
        self.assertEqual(
            readiness["active_selected_retained_intersection_count"], 2
        )
        self.assertEqual(
            readiness["active_selected_missing_from_retained_count"], 0
        )
        self.assertEqual(
            readiness["active_selected_missing_from_retained_timeseries_ids"], []
        )
        self.assertEqual(
            readiness["inactive_retained_selected_timeseries_count"], 2
        )
        self.assertEqual(readiness["candidate_timeseries_count"], 4)
        self.assertEqual(len(boundaries), 4)
        self.assertEqual(audit["retained_unselected_timeseries_count"], 1)
        self.assertEqual(candidate[0]["site_id"], "ABC")
        self.assertEqual(candidate[1]["ratified_to"], None)

    def test_same_retained_scope_path_supports_saqn_connector_10(self) -> None:
        self.conn.execute(
            "INSERT INTO core_stations_snapshot VALUES (101, 10, 'SAQ')"
        )
        candidate, _boundaries, readiness, _audit = (
            SOURCE.build_official_retained_verification_scope(
                conn=self.conn,
                source_key="saqn",
                connector_id=10,
                authenticated_members={1001: self.members[1001]},
                provider_audit=provider_audit(),
                active_selected_timeseries_ids=[1001],
                metadata_rows=[{
                    "site_id": "SAQ",
                    "parameter": "NO2",
                    "ratified_to": "Never",
                }],
            )
        )
        self.assertEqual(candidate[0]["connector_id"], 10)
        self.assertTrue(readiness["publishable"])

    def test_malformed_or_contradictory_selected_binding_fails_closed(self) -> None:
        cases = {
            "non-positive station": binding_bytes(901, 9, "no2", 0),
            "contradictory timeseries": binding_bytes(999, 9, "no2", 91),
            "blank pollutant": binding_bytes(901, 9, "", 91),
        }
        for label, body in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    SOURCE.retained_official_binding_members(
                        {901: body}, connector_id=9
                    )

    def test_missing_or_blank_pinned_core_station_identity_fails_closed(self) -> None:
        for station_id, expected in ((999, "missing or ambiguous"), (93, "blank")):
            with self.subTest(station_id=station_id):
                if station_id == 93:
                    self.conn.execute(
                        "INSERT INTO core_stations_snapshot VALUES (93, 9, '   ')"
                    )
                retained = [{
                    "connector_id": 9,
                    "timeseries_id": 9999,
                    "station_id": station_id,
                    "pollutant_code": "no2",
                }]
                with self.assertRaisesRegex(ValueError, expected):
                    SOURCE.resolve_retained_station_identities(
                        self.conn, retained, connector_id=9
                    )

    def test_missing_or_ambiguous_metadata_identity_fails_closed(self) -> None:
        for metadata in (
            [],
            [self.metadata[0], dict(self.metadata[0])],
        ):
            with self.subTest(matches=len(metadata)):
                self.members = {901: self.members[901]}
                self.active_timeseries_ids = [901]
                self.metadata = metadata
                with self.assertRaisesRegex(ValueError, "metadata identity failed"):
                    self.build()

    def test_candidate_omission_prevents_publishable_readiness(self) -> None:
        readiness = SOURCE.retained_scope_coverage_readiness(
            provider_audit=provider_audit(),
            connector_id=9,
            scope_counts={
                "retained_connector_timeseries_count": 2,
                "retained_selected_timeseries_count": 2,
            },
            retained_timeseries_ids=[901, 902],
            station_identity_timeseries_ids=[901, 902],
            metadata_identity_timeseries_ids=[901, 902],
            candidate_timeseries_ids=[901],
            active_selected_timeseries_ids=[901],
        )
        self.assertFalse(readiness["publishable"])
        self.assertIn("exactly equal", readiness["reason"])

    def test_active_selected_core_missing_from_retained_is_auditable_blocker(self) -> None:
        self.active_timeseries_ids = [999, 901, 998]
        candidate, _boundaries, readiness, audit = self.build()
        self.assertFalse(readiness["publishable"])
        self.assertIn(
            "active core timeseries are missing from retained binding authority",
            readiness["reason"],
        )
        self.assertEqual(readiness["active_selected_timeseries_count"], 3)
        self.assertEqual(
            readiness["active_selected_retained_intersection_count"], 1
        )
        self.assertEqual(
            readiness["active_selected_missing_from_retained_count"], 2
        )
        self.assertEqual(
            readiness["active_selected_missing_from_retained_timeseries_ids"],
            [998, 999],
        )
        self.assertEqual(len(candidate), 4)
        self.assertEqual(audit["candidate_timeseries_count"], 4)

    def test_active_selected_core_duplicate_timeseries_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate active selected core"):
            SOURCE.active_selected_core_timeseries_ids({
                "ABC": {
                    "no2": {"station_id": 91, "timeseries_id": 901},
                    "o3": {"station_id": 91, "timeseries_id": 901},
                }
            })

    def test_supported_stable_binding_schemas_include_continuity_schema(self) -> None:
        for schema_version, continuity in (
            (1, None),
            (2, {"schema_version": 1, "members": []}),
        ):
            with self.subTest(schema_version=schema_version):
                body = binding_bytes(
                    901,
                    9,
                    "no2",
                    91,
                    schema_version=schema_version,
                    **({"continuity": continuity} if continuity is not None else {}),
                )
                retained, _counts = SOURCE.retained_official_binding_members(
                    {901: body}, connector_id=9
                )
                self.assertEqual(retained[0]["timeseries_id"], 901)

    def test_unsupported_or_missing_stable_binding_contract_identity_fails(self) -> None:
        cases = (
            ({"schema_version": 3}, "schema_version"),
            ({"schema_version": None}, "schema_version"),
            ({"history_version": "v3"}, "history_version"),
            ({"history_version": None}, "history_version"),
            ({"index_kind": "timeseries"}, "index_kind"),
            ({"index_kind": None}, "index_kind"),
        )
        for override, expected in cases:
            with self.subTest(override=override):
                body = binding_bytes(901, 9, "no2", 91, **override)
                with self.assertRaisesRegex(ValueError, expected):
                    SOURCE.retained_official_binding_members(
                        {901: body}, connector_id=9
                    )


if __name__ == "__main__":
    unittest.main()
