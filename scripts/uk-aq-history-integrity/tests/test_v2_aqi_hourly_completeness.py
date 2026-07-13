#!/usr/bin/env python3
"""Focused v2 AQI expected-hour contract regressions."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


BIN_DIR = Path(__file__).resolve().parents[1] / "bin"


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INTEGRITY = load_module("uk_aq_history_integrity_hourly", "uk-aq-history-integrity.py")
GAP_CHECK = load_module("uk_aq_aqi_gap_check_hourly", "uk-aq-aqi-gap-check.py")


class V2AqiHourlyCompletenessTests(unittest.TestCase):
    def test_288_five_minute_observations_and_24_valid_aqi_hours_are_healthy(self) -> None:
        expected_hours = set(range(24))
        observation_stats = {
            "row_count": 288,
            "timeseries_hour_keys": {101: tuple(expected_hours)},
        }
        expected = INTEGRITY._v2_aqi_expected_hour_keys(
            observation_stats,
            pollutant_code="pm25",
        )

        self.assertEqual(expected, {101: expected_hours})
        self.assertEqual(INTEGRITY._v2_aqi_missing_hour_keys(expected, {101: expected_hours}), {})
        self.assertEqual(
            GAP_CHECK.status_for(288, 24, expected_hours, expected_hours, "pm25", True, True, 24),
            "ok",
        )

    def test_one_expected_aqi_hour_missing_is_detected(self) -> None:
        expected_hours = set(range(24))
        actual_hours = expected_hours - {17}
        missing = INTEGRITY._v2_aqi_missing_hour_keys({101: expected_hours}, {101: actual_hours})

        self.assertEqual(missing, {101: [17]})
        self.assertIn(
            "missing_expected_aqi_hours",
            GAP_CHECK.status_for(288, 23, expected_hours, actual_hours, "pm25", True, True, 23),
        )

    def test_ineligible_pollutant_does_not_require_aqi(self) -> None:
        source_hours = set(range(24))

        self.assertEqual(
            INTEGRITY._v2_aqi_expected_hour_keys(
                {"row_count": 288, "timeseries_hour_keys": {101: tuple(source_hours)}},
                pollutant_code="o3",
            ),
            {},
        )
        self.assertEqual(
            GAP_CHECK.status_for(288, 0, source_hours, set(), "o3", True, True, None),
            "ok",
        )


if __name__ == "__main__":
    unittest.main()
