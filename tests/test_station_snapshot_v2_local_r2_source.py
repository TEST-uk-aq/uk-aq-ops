import importlib.util
import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
ROOT_SERVE = REPO_ROOT / "_codex_context" / "serve.py"
OPS_ROOT = REPO_ROOT


def load_serve_module():
    spec = importlib.util.spec_from_file_location("chronicchannel_local_serve", ROOT_SERVE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StationSnapshotV2LocalR2SourceTest(unittest.TestCase):
    def test_post_coverage_rows_are_not_marked_as_r2_without_direct_r2_rows(self):
        serve = load_serve_module()
        handler = object.__new__(serve.MultiRootHandler)
        result = {"debug": {}}

        ingest_obs = [
            {"observed_at": "2026-06-18T10:00:00Z", "value": 5.1},
            {"observed_at": "2026-06-17T10:00:00Z", "value": 4.8},
        ]
        obs_aqidb_obs = [
            {"observed_at": "2026-06-18T10:00:00Z", "value": 5.0},
        ]
        direct_r2_obs = [
            {"observed_at": "2026-06-13T10:00:00Z", "value": 3.9, "source": "direct_r2_observs"},
        ]

        handler._v2_merge_rows(result, ingest_obs, obs_aqidb_obs, direct_r2_obs, [])

        rows_by_hour = {row["observed_at"]: row for row in result["rows"]}
        for hour in ("2026-06-18T10:00:00Z", "2026-06-17T10:00:00Z"):
            self.assertFalse(rows_by_hour[hour]["has_r2_observs_row"])
            self.assertIsNone(rows_by_hour[hour]["r2_observs_value"])

        self.assertTrue(rows_by_hour["2026-06-13T10:00:00Z"]["has_r2_observs_row"])
        self.assertEqual(rows_by_hour["2026-06-13T10:00:00Z"]["r2_observs_value"], 3.9)

    def test_same_hour_observations_keep_exact_timestamps_and_share_aqi(self):
        serve = load_serve_module()
        handler = object.__new__(serve.MultiRootHandler)
        result = {"debug": {}}

        ingest_obs = [
            {"observed_at": "2026-06-18T12:03:00Z", "value": 1.1},
            {"observed_at": "2026-06-18T12:17:00Z", "value": 1.7},
            {"observed_at": "2026-06-18T12:52:30Z", "value": 2.2},
        ]
        aqi_rows = [
            {
                "timestamp_hour_utc": "2026-06-18T12:00:00Z",
                "source": "r2",
                "daqi_index_level": 1,
                "eaqi_index_level": 1,
            }
        ]

        handler._v2_merge_rows(result, ingest_obs, [], [], aqi_rows)

        self.assertEqual(len(result["rows"]), 3)
        rows_by_exact = {row["observed_at"]: row for row in result["rows"]}
        self.assertEqual(
            set(rows_by_exact),
            {
                "2026-06-18T12:03:00Z",
                "2026-06-18T12:17:00Z",
                "2026-06-18T12:52:30Z",
            },
        )
        for row in rows_by_exact.values():
            self.assertEqual(row["hour_bucket"], "2026-06-18T12:00:00Z")
            self.assertEqual(row["aqi_source"], "R2 History")
            self.assertTrue(row["has_aqi_row"])

        debug = result["debug"]
        self.assertEqual(debug["observation_key_mode"], "exact_observed_at")
        self.assertEqual(debug["aqi_key_mode"], "hour_bucket")
        self.assertEqual(debug["exact_observation_row_count"], 3)
        self.assertEqual(debug["same_hour_observation_group_count"], 1)
        self.assertEqual(debug["max_observations_in_hour_bucket"], 3)
        self.assertEqual(debug["collapsed_hour_collision_count"], 0)
        self.assertEqual(debug["non_hourly_observation_count"], 3)
        self.assertEqual(debug["standalone_aqi_only_row_count"], 0)
        self.assertFalse(debug["chart_history_rows_used_for_r2_column"])


    def test_aqi_history_api_retention_rows_display_as_obsaqidb(self):
        serve = load_serve_module()
        handler = object.__new__(serve.MultiRootHandler)
        result = {"debug": {}}

        handler._v2_merge_rows(
            result,
            [{"observed_at": "2026-06-18T10:05:00Z", "value": 5.1}],
            [],
            [],
            [
                {
                    "timestamp_hour_utc": "2026-06-18T10:00:00Z",
                    "source": "obs_aqidb",
                    "source_coverage": "retention",
                    "hourly_mean_ugm3": 5.0,
                }
            ],
        )

        row = result["rows"][0]
        self.assertEqual(row["aqi_source"], "ObsAQIDB retention")
        self.assertIsNone(row["r2_observs_value"])
        self.assertEqual(result["debug"]["aqi_rows_after_r2_coverage_labelled_r2_count"], 0)

    def test_chart_history_rows_do_not_feed_r2_observs_source(self):
        source = ROOT_SERVE.read_text(encoding="utf-8")

        self.assertNotIn("r2_obs, chart_debug = self._v2_fetch_chart_history_rows", source)
        self.assertNotIn("if not r2_obs:\n            r2_obs = self._v2_fetch_r2_rows", source)
        self.assertIn("chart_rows, chart_debug = self._v2_fetch_chart_history_rows", source)
        self.assertIn("'direct_r2_observs_row_count': r2_obs_count", source)
        self.assertIn("'r2_observs_source_used': 'direct_observations_r2_api'", source)

    def test_r2_aqi_points_merge_as_r2_history(self):
        serve = load_serve_module()
        handler = object.__new__(serve.MultiRootHandler)
        result = {"debug": {}}

        handler._v2_merge_rows(
            result,
            [],
            [],
            [],
            [
                {
                    "period_start_utc": "2026-06-04T12:00:00.000Z",
                    "source": "r2",
                    "daqi_index_level": 1,
                    "eaqi_index_level": 1,
                    "eaqi_input_value_ugm3": 3.969,
                    "source_observation_count": 1,
                },
                {
                    "timestamp_hour_utc": "2026-06-04T12:00:00.000Z",
                    "source": "obsaqidb",
                    "hourly_mean_ugm3": 2.763,
                    "daqi_index_level": 1,
                    "eaqi_index_level": 1,
                },
            ],
        )

        row = result["rows"][0]
        self.assertEqual(row["aqi_source"], "R2 History")
        self.assertEqual(row["hourly_mean_ugm3"], 3.969)
        self.assertEqual(row["hourly_sample_count"], 1)
        self.assertTrue(result["overlap_detected"])

    def test_r2_fetch_accepts_points_payloads(self):
        serve = load_serve_module()
        handler = object.__new__(serve.MultiRootHandler)
        payload = {"points": [{"period_start_utc": "2026-06-04T12:00:00.000Z"}]}
        handler._fetch_json = lambda _url, _headers: payload

        rows = handler._v2_fetch_r2_rows("https://example.test/aqi", "token", {"debug": "1"})

        self.assertEqual(rows, payload["points"])

    def test_frontend_declares_hour_bucket_and_aqi_alignment_classes(self):
        html = (OPS_ROOT / "station_snapshot_v2/index.html").read_text(encoding="utf-8")

        self.assertIn("const cols=['hour bucket','observed_at'", html)
        self.assertIn("const keys=['hour_bucket','observed_at'", html)
        self.assertIn("same-hour-row", html)
        self.assertIn("bucket-repeat", html)
        self.assertIn("aqi-colour-cell", html)
        self.assertIn("aqi-level-cell", html)
        self.assertIn("observed_at exact", html)


if __name__ == "__main__":
    unittest.main()
