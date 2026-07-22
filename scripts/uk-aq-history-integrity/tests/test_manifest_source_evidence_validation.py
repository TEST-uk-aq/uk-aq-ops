#!/usr/bin/env python3
"""Focused v2 connector-manifest/source-evidence contract checks."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_manifest_validation", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
INTEGRITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INTEGRITY
SPEC.loader.exec_module(INTEGRITY)


def connector_manifest(
    *,
    row_count: int = 2,
    source_row_count: int = 2,
    file_timeseries: dict[str, int] | None = None,
    file_pollutants: list[str] | None = None,
    child_counts: dict[str, int] | None = None,
) -> dict[str, object]:
    file_timeseries = file_timeseries or {"10": 1, "11": 1}
    file_pollutants = file_pollutants or ["pm25"]
    child_counts = child_counts or {"pm25": 2}
    files = []
    for index, pollutant_code in enumerate(file_pollutants):
        pollutant_row_count = sum(file_timeseries.values()) if index == 0 else 0
        files.append({
            "key": (
                "history/v2/observations/day_utc=2026-07-18/connector_id=1/"
                f"pollutant_code={pollutant_code}/part-{index:05d}.parquet"
            ),
            "row_count": pollutant_row_count,
            "pollutant_code": pollutant_code,
            "pollutant_codes": [pollutant_code],
            "timeseries_row_counts": file_timeseries if index == 0 else {},
        })
    children = [{
        "pollutant_code": code,
        "manifest_key": (
            "history/v2/observations/day_utc=2026-07-18/connector_id=1/"
            f"pollutant_code={code}/manifest.json"
        ),
        "source_row_count": count,
        "row_count": count,
    } for code, count in child_counts.items()]
    return {
        "history_version": "v2",
        "domain": "observations",
        "manifest_kind": "connector",
        "day_utc": "2026-07-18",
        "connector_id": 1,
        "source_row_count": source_row_count,
        "row_count": row_count,
        # The current writer puts these on file entries, not this top level.
        "pollutant_codes": list(file_pollutants),
        "files": files,
        "child_manifests": children,
        "pollutant_manifests": [dict(child) for child in children],
    }


def mismatches(manifest: dict[str, object], *, expected_rows: int = 2,
               expected_timeseries: dict[int, int] | None = None,
               expected_pollutants: dict[str, int] | None = None):
    return INTEGRITY._v2_observation_manifest_evidence_mismatches(
        manifest,
        expected_source_row_count=expected_rows,
        expected_timeseries_row_counts=expected_timeseries or {10: 1, 11: 1},
        expected_pollutant_counts=expected_pollutants or {"pm25": 2},
        source_evidence_pollutant_set=(expected_pollutants or {"pm25": 2}).keys(),
    )


class ManifestSourceEvidenceValidationTests(unittest.TestCase):
    def test_current_writer_file_timeseries_hierarchy_matches_source_evidence(self) -> None:
        summary, problems = mismatches(connector_manifest())
        self.assertEqual(problems, [])
        self.assertFalse(summary["timeseries_row_counts"]["top_level_present"])
        self.assertEqual(summary["timeseries_row_counts"]["derived_file_count"], 2)

    def test_real_row_count_mismatch_fails(self) -> None:
        _, problems = mismatches(connector_manifest(row_count=3, source_row_count=3))
        self.assertTrue(any(item["field"] == "connector_manifest_row_count" for item in problems))

    def test_failure_output_names_the_exact_mismatched_field(self) -> None:
        summary, problems = mismatches(connector_manifest(row_count=3, source_row_count=3))
        error = INTEGRITY.CanonicalConnectorManifestValidationError(
            "source_evidence_mismatch",
            {"manifest": summary, "mismatches": problems},
        )
        self.assertIn("connector_manifest_row_count", str(error))
        self.assertEqual(error.details["mismatches"][0]["field"], "connector_manifest_row_count")

    def test_missing_timeseries_fails_with_exact_field(self) -> None:
        _, problems = mismatches(
            connector_manifest(file_timeseries={"10": 2}),
        )
        failure = next(item for item in problems if item["field"] == "timeseries_row_counts")
        self.assertEqual(failure["missing_timeseries_ids"], [11])
        self.assertEqual(failure["count_mismatches"], ["10:1!=2"])

    def test_unexpected_timeseries_fails_with_exact_field(self) -> None:
        _, problems = mismatches(
            connector_manifest(file_timeseries={"10": 1, "12": 1}),
        )
        failure = next(item for item in problems if item["field"] == "timeseries_row_counts")
        self.assertEqual(failure["missing_timeseries_ids"], [11])
        self.assertEqual(failure["unexpected_timeseries_ids"], [12])

    def test_missing_pollutant_fails(self) -> None:
        _, problems = mismatches(
            connector_manifest(),
            expected_pollutants={"pm25": 2, "pm10": 0},
        )
        failure = next(item for item in problems if item["field"] == "pollutant_codes")
        self.assertEqual(failure["missing_pollutant_codes"], ["pm10"])

    def test_unexpected_pollutant_fails(self) -> None:
        _, problems = mismatches(
            connector_manifest(file_pollutants=["pm25", "no2"], child_counts={"pm25": 2, "no2": 0}),
        )
        failure = next(item for item in problems if item["field"] == "pollutant_codes")
        self.assertEqual(failure["unexpected_pollutant_codes"], ["no2"])

    def test_malformed_child_or_file_count_fails_closed(self) -> None:
        manifest = connector_manifest()
        manifest["files"][0]["row_count"] = "two"  # type: ignore[index]
        manifest["child_manifests"][0].pop("row_count")  # type: ignore[index]
        manifest["child_manifests"][0].pop("source_row_count")  # type: ignore[index]
        _, problems = mismatches(manifest)
        self.assertTrue(any(item["field"] == "manifest_file_entries" for item in problems))
        self.assertTrue(any(item["field"] == "child_manifests" for item in problems))

    def test_warning_only_missing_binding_rows_do_not_expand_manifest_expectation(self) -> None:
        source_evidence = {
            "total_rows": 2,
            "source_records_examined": 122,
            "missing_binding_groups": 5,
            "missing_binding_rows": 120,
        }
        _, problems = mismatches(
            connector_manifest(),
            expected_rows=source_evidence["total_rows"],
        )
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
