from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/geography/validate_r2_geo_lookup_against_stations.py"
SPEC = importlib.util.spec_from_file_location("validate_r2_geo_lookup_against_stations", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
geo_validate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = geo_validate
SPEC.loader.exec_module(geo_validate)


def make_point(lon: float, lat: float) -> dict[str, object]:
    return {"type": "Point", "coordinates": [lon, lat], "srid": 4326}


def make_polygon(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> dict[str, object]:
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]
        ],
    }


def make_feature(code: str, name: str, bbox: list[float], geometry_ref: str) -> dict[str, object]:
    return {
        "code": code,
        "name": name,
        "bbox": bbox,
        "geometry_ref": geometry_ref,
    }


class FakeSupabaseClient:
    def __init__(self, stations: list[dict[str, object]], connectors: dict[int, str], code_name_maps: dict[tuple[str, str], dict[str, str]]):
        self._stations = stations
        self._connectors = connectors
        self._code_name_maps = code_name_maps

    def get_stations(self) -> list[dict[str, object]]:
        return list(self._stations)

    def get_connectors(self) -> dict[int, str]:
        return dict(self._connectors)

    def get_code_name_map(self, layer: str, version: str) -> dict[str, str]:
        return dict(self._code_name_maps.get((layer, version), {}))


class FakeR2Client:
    def __init__(self, objects: dict[str, object]):
        self._objects = objects
        self.calls: list[str] = []

    def get_json(self, object_key: str):
        self.calls.append(object_key)
        if object_key in self._objects:
            return self._objects[object_key]
        if "/grid_" in object_key and object_key.endswith(".json"):
            return {"features": []}
        raise geo_validate.LookupErrorWithContext(f"missing object: {object_key}")


def make_config(output_path: str) -> geo_validate.ValidationConfig:
    return geo_validate.ValidationConfig(
        supabase_url="https://example.supabase.co",
        sb_secret_key="service-key",
        bucket="uk-aq-pcon-la-lookup",
        prefix="v1",
        grid_size_degrees=0.05,
        boundary_detail="detailed",
        limit=3,
        random_seed=None,
        station_ids=None,
        output_path=output_path,
        cf_account_id="account-id",
        cf_api_token="api-token",
    )


class ValidateR2GeoLookupAgainstStationsTests(unittest.TestCase):
    def test_select_station_rows_is_deterministic_with_seed(self) -> None:
        rows = [
            {"id": idx, "geometry": make_point(0.01 * idx, 0.01 * idx), "pcon_code": f"PCON-{idx}", "la_code": f"LA-{idx}"}
            for idx in range(1, 6)
        ]

        first, first_stats = geo_validate.select_station_rows(rows, limit=3, station_ids=None, random_seed=42)
        second, second_stats = geo_validate.select_station_rows(rows, limit=3, station_ids=None, random_seed=42)

        self.assertEqual([row["id"] for row in first], [row["id"] for row in second])
        self.assertEqual(first_stats["eligible"], 5)
        self.assertEqual(second_stats["eligible"], 5)
        self.assertEqual(len(first), 3)

    def test_select_station_rows_explicit_ids_take_priority(self) -> None:
        rows = [
            {"id": 1, "geometry": make_point(0.01, 0.01), "pcon_code": "PCON-1", "la_code": "LA-1"},
            {"id": 2, "geometry": make_point(0.02, 0.02), "pcon_code": "PCON-2", "la_code": "LA-2"},
            {"id": 3, "geometry": make_point(0.03, 0.03), "pcon_code": "PCON-3", "la_code": "LA-3"},
        ]

        selected, stats = geo_validate.select_station_rows(rows, limit=1, station_ids=[3, 1], random_seed=999)

        self.assertEqual([row["id"] for row in selected], [3, 1])
        self.assertEqual(stats["eligible"], 3)
        self.assertEqual(stats["total_rows_considered"], 3)

    def test_select_station_rows_only_eligible_rows_are_sampled(self) -> None:
        rows = [
            {"id": 1, "geometry": make_point(0.01, 0.01), "pcon_code": "PCON-1", "la_code": "LA-1"},
            {"id": 2, "geometry": make_point(0.02, 0.02), "pcon_code": "", "la_code": "LA-2"},
            {"id": 3, "geometry": make_point(0.03, 0.03), "pcon_code": "PCON-3", "la_code": ""},
            {"id": 4, "geometry": "not-a-point", "pcon_code": "PCON-4", "la_code": "LA-4"},
        ]

        selected, stats = geo_validate.select_station_rows(rows, limit=10, station_ids=None, random_seed=None)

        self.assertEqual([row["id"] for row in selected], [1])
        self.assertEqual(stats["eligible"], 1)
        self.assertEqual(stats["skipped"]["missing_pcon_code"], 1)
        self.assertEqual(stats["skipped"]["missing_la_code"], 1)
        self.assertEqual(stats["skipped"]["invalid_geometry"], 1)

    def test_compare_station_row_classifies_mismatches(self) -> None:
        base = geo_validate.compare_station_row(
            stored_pcon_code="PCON-1",
            stored_pcon_name="Alpha",
            stored_la_code="LA-1",
            stored_la_name="Beta",
            pcon_lookup={"code": "PCON-1", "name": "Alpha", "match_strategy": "exact_tile"},
            la_lookup={"code": "LA-1", "name": "Beta", "match_strategy": "exact_tile"},
        )
        self.assertTrue(base["overall_match"])
        self.assertEqual(base["classification"], [])

        version_diff = geo_validate.compare_station_row(
            stored_pcon_code="PCON-OLD",
            stored_pcon_name="Alpha",
            stored_la_code="LA-1",
            stored_la_name="Beta",
            pcon_lookup={"code": "PCON-NEW", "name": "Alpha", "match_strategy": "exact_tile"},
            la_lookup={"code": "LA-1", "name": "Beta", "match_strategy": "exact_tile"},
        )
        self.assertIn("pcon_code_mismatch", version_diff["classification"])
        self.assertIn("possible_boundary_version_difference", version_diff["classification"])

        boundary_edge = geo_validate.compare_station_row(
            stored_pcon_code="PCON-1",
            stored_pcon_name="Alpha",
            stored_la_code="LA-1",
            stored_la_name="Beta",
            pcon_lookup={"code": "PCON-1", "name": "Alpha", "match_strategy": "neighbour_tile"},
            la_lookup={"code": "LA-1", "name": "Beta", "match_strategy": "exact_tile"},
        )
        self.assertIn("possible_boundary_edge", boundary_edge["classification"])

    def test_validate_station_classifies_invalid_coordinates_and_lookup_errors(self) -> None:
        manifest = {
            "prefix": "v1",
            "grid_size_degrees": 0.05,
            "layers": {
                "pcon": {"boundary_version": "2024"},
                "la": {"boundary_version": "2025"},
            },
        }

        class ExplodingR2Client(FakeR2Client):
            def get_json(self, object_key: str):
                if "/grid_" in object_key:
                    raise geo_validate.LookupErrorWithContext(f"boom: {object_key}")
                return super().get_json(object_key)

        objects = {
            "v1/manifest.json": manifest,
        }
        supabase = FakeSupabaseClient([], {}, {})
        with tempfile.TemporaryDirectory() as tmpdir:
            config = make_config(str(Path(tmpdir) / "latest.json"))
            validator = geo_validate.GeoLookupValidator(config, supabase, FakeR2Client(objects))
            invalid = validator.validate_station(
                {
                    "id": 99,
                    "station_name": "Bad",
                    "connector_id": 1,
                    "geometry": make_point(999.0, 999.0),
                    "pcon_code": "PCON-9",
                    "pcon_version": "2024",
                    "la_code": "LA-9",
                    "la_version": "2025",
                },
                "connector-1",
            )

            self.assertIn("invalid_coordinates", invalid["comparison"]["classification"])

            validator = geo_validate.GeoLookupValidator(config, supabase, ExplodingR2Client(objects))
            lookup_error = validator.validate_station(
                {
                    "id": 100,
                    "station_name": "Boom",
                    "connector_id": 1,
                    "geometry": make_point(0.01, 0.01),
                    "pcon_code": "PCON-9",
                    "pcon_version": "2024",
                    "la_code": "LA-9",
                    "la_version": "2025",
                },
                "connector-1",
            )

            self.assertIn("lookup_error", lookup_error["comparison"]["classification"])

    def test_validator_run_uses_exact_tile_neighbour_tile_and_reports_summary(self) -> None:
        manifest = {
            "prefix": "v1",
            "grid_size_degrees": 0.05,
            "layers": {
                "pcon": {"boundary_version": "2024"},
                "la": {"boundary_version": "2025"},
            },
        }

        objects: dict[str, object] = {
            "v1/manifest.json": manifest,
            "v1/by_code/pcon/2024/PCON-1.json": {
                "code": "PCON-1",
                "name": "Alpha",
                "geometry": make_polygon(0.00, 0.00, 0.04, 0.04),
            },
            "v1/by_code/la/2025/LA-1.json": {
                "code": "LA-1",
                "name": "Alpha LA",
                "geometry": make_polygon(0.00, 0.00, 0.04, 0.04),
            },
            "v1/by_code/pcon/2024/PCON-2.json": {
                "code": "PCON-2",
                "name": "Beta",
                "geometry": make_polygon(0.04, 0.00, 0.08, 0.04),
            },
            "v1/by_code/la/2025/LA-2.json": {
                "code": "LA-2",
                "name": "Beta LA",
                "geometry": make_polygon(0.04, 0.00, 0.08, 0.04),
            },
            "v1/pcon/detailed/grid_0.05/iy0_ix0.json": {
                "features": [
                    make_feature("PCON-1", "Alpha", [0.00, 0.00, 0.04, 0.04], "by_code/pcon/2024/PCON-1.json"),
                    make_feature("PCON-2", "Beta", [0.04, 0.00, 0.08, 0.04], "by_code/pcon/2024/PCON-2.json"),
                ]
            },
            "v1/la/detailed/grid_0.05/iy0_ix0.json": {
                "features": [
                    make_feature("LA-1", "Alpha LA", [0.00, 0.00, 0.04, 0.04], "by_code/la/2025/LA-1.json"),
                ]
            },
            "v1/pcon/detailed/grid_0.05/iy0_ix1.json": {"features": []},
            "v1/la/detailed/grid_0.05/iy0_ix1.json": {
                "features": [
                    make_feature("LA-2", "Beta LA", [0.04, 0.00, 0.08, 0.04], "by_code/la/2025/LA-2.json"),
                ]
            },
        }

        stations = [
            {
                "id": 1,
                "station_name": "Exact",
                "connector_id": 10,
                "geometry": make_point(0.01, 0.01),
                "pcon_code": "PCON-1",
                "pcon_version": "2024",
                "la_code": "LA-1",
                "la_version": "2025",
            },
            {
                "id": 2,
                "station_name": "Neighbour",
                "connector_id": 11,
                "geometry": make_point(0.06, 0.01),
                "pcon_code": "PCON-2",
                "pcon_version": "2024",
                "la_code": "LA-2",
                "la_version": "2025",
            },
            {
                "id": 3,
                "station_name": "Missing",
                "connector_id": 12,
                "geometry": make_point(1.00, 1.00),
                "pcon_code": "PCON-3",
                "pcon_version": "2024",
                "la_code": "LA-3",
                "la_version": "2025",
            },
        ]

        connectors = {10: "connector-10", 11: "connector-11", 12: "connector-12"}
        code_name_maps = {
            ("pcon", "2024"): {"PCON-1": "Alpha", "PCON-2": "Beta", "PCON-3": "Gamma"},
            ("la", "2025"): {"LA-1": "Alpha LA", "LA-2": "Beta LA", "LA-3": "Gamma LA"},
        }

        supabase = FakeSupabaseClient(stations, connectors, code_name_maps)
        r2 = FakeR2Client(objects)
        with tempfile.TemporaryDirectory() as tmpdir:
            config = make_config(str(Path(tmpdir) / "latest.json"))
            validator = geo_validate.GeoLookupValidator(config, supabase, r2)
            report = validator.run()

        summary = report["summary"]
        self.assertEqual(summary["eligible"], 3)
        self.assertEqual(summary["sampled"], 3)
        self.assertEqual(summary["pcon_code_matches"], 2)
        self.assertEqual(summary["pcon_missing_r2"], 1)
        self.assertEqual(summary["la_code_matches"], 2)
        self.assertEqual(summary["la_missing_r2"], 1)
        self.assertEqual(summary["overall_matches"], 2)
        self.assertEqual(summary["overall_mismatches"], 1)

        row1 = next(row for row in report["rows"] if row["station_id"] == 1)
        row2 = next(row for row in report["rows"] if row["station_id"] == 2)
        row3 = next(row for row in report["rows"] if row["station_id"] == 3)

        self.assertEqual(row1["r2"]["pcon_match_strategy"], "exact_tile")
        self.assertEqual(row1["r2"]["la_match_strategy"], "exact_tile")
        self.assertEqual(row2["r2"]["pcon_match_strategy"], "neighbour_tile")
        self.assertEqual(row2["r2"]["la_match_strategy"], "exact_tile")
        self.assertIn("possible_boundary_edge", row2["comparison"]["classification"])
        self.assertEqual(row3["r2"]["pcon_match_strategy"], "no_match")
        self.assertEqual(row3["r2"]["la_match_strategy"], "no_match")
        self.assertIn("pcon_no_r2_match", row3["comparison"]["classification"])
        self.assertIn("la_no_r2_match", row3["comparison"]["classification"])


if __name__ == "__main__":
    unittest.main()
