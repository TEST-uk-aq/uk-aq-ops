import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import uk_aq_dashboard_api as api


class TestDropboxStatePathResolution(unittest.TestCase):
    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {}, clear=True)
        self.env_patcher.start()
        self._clear_storage_coverage_cache()

    def tearDown(self):
        self._clear_storage_coverage_cache()
        self.env_patcher.stop()

    def _clear_storage_coverage_cache(self):
        with api.CACHE_LOCK:
            api.STORAGE_COVERAGE_CACHE_STATE["rows"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["next_refresh_at"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["cache_key"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_path"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_error"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_info"] = None

    def test_looks_like_v1(self):
        self.assertTrue(api._looks_like_v1_dropbox_state_path("_ops/checkpoints/r2_history_backup_state_v1.json"))
        self.assertTrue(api._looks_like_v1_dropbox_state_path("V1_checkpoint.json"))
        self.assertFalse(api._looks_like_v1_dropbox_state_path("_ops/checkpoints/r2_history_backup_state_v2.json"))
        self.assertFalse(api._looks_like_v1_dropbox_state_path("v1_and_v2.json"))

    def test_default_v1_is_preserved_when_read_version_missing(self):
        info = api._resolve_dropbox_state_path_info()

        self.assertEqual(info["path"], api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v1"])
        self.assertEqual(info["source"], "default")
        self.assertFalse(info["fallback_attempted"])
        self.assertTrue(info["read_version"]["valid"])

    def test_default_v2_uses_v2_checkpoint(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"

        info = api._resolve_dropbox_state_path_info()

        self.assertEqual(info["path"], api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"])
        self.assertEqual(info["source"], "default")
        self.assertFalse(info["fallback_attempted"])

    def test_invalid_read_version_disables_dropbox_checkpoint_selection(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "banana"

        info = api._resolve_dropbox_state_path_info()
        days, state_path, state_error, load_info = api._load_dropbox_backup_days()

        self.assertIsNone(info["path"])
        self.assertEqual(info["source"], "disabled_invalid_read_version")
        self.assertFalse(info["fallback_attempted"])
        self.assertEqual(info["attempted_paths"], [])
        self.assertIn("Invalid", info["warning"])
        self.assertIn("banana", info["cache_key"])
        self.assertEqual(days, api._empty_dropbox_backup_days())
        self.assertIsNone(state_path)
        self.assertEqual(state_error, info["warning"])
        self.assertEqual(load_info["source"], "disabled_invalid_read_version")
        self.assertNotEqual(info["path"], api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v1"])

    def test_backup_state_rel_path_is_read_dynamically_from_environment(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
        os.environ[api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV] = "custom/path/a_v2.json"
        first = api._resolve_dropbox_state_path_info()

        os.environ[api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV] = "custom/path/b_v2.json"
        second = api._resolve_dropbox_state_path_info()

        self.assertEqual(first["path"], "custom/path/a_v2.json")
        self.assertEqual(second["path"], "custom/path/b_v2.json")
        self.assertNotEqual(first["cache_key"], second["cache_key"])

    def test_v2_ignores_v1_relative_override_and_uses_v2_default(self):
        v1_path = "_ops/checkpoints/r2_history_backup_state_v1.json"
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
        os.environ[api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV] = v1_path

        info = api._resolve_dropbox_state_path_info()

        self.assertEqual(info["path"], api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"])
        self.assertEqual(info["source"], "default:v2_ignored_v1_env_override")
        self.assertFalse(info["fallback_attempted"])
        self.assertIn(v1_path, info["attempted_paths"])
        self.assertIn(api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"], info["attempted_paths"])
        self.assertIn(api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV, info["warning"])

    def test_v2_ignores_v1_state_file_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            v1_override = Path(tmpdir) / "r2_history_backup_state_v1.json"
            v1_override.write_text(
                json.dumps({"domains": {"observations": {"days": {"2026-06-12": {}}}}}),
                encoding="utf-8",
            )
            os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
            os.environ[api.UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE_ENV] = str(v1_override)

            info = api._resolve_dropbox_state_path_info()
            candidates = api._candidate_dropbox_state_paths(info["path"], state_info=info)

        self.assertEqual(info["path"], api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"])
        self.assertEqual(info["source"], "default:v2_ignored_v1_state_file_override")
        self.assertFalse(info["fallback_attempted"])
        self.assertEqual(info["ignored_state_file_override"], str(v1_override))
        self.assertIsNone(info["state_file_override"])
        self.assertIn(str(v1_override), info["attempted_paths"])
        self.assertNotIn(v1_override, candidates)
        self.assertIn(api.UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE_ENV, info["warning"])

    def test_cache_keys_differ_between_v1_and_v2(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v1"
        v1_key = api._resolve_dropbox_state_path_info()["cache_key"]
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
        v2_key = api._resolve_dropbox_state_path_info()["cache_key"]

        self.assertNotEqual(v1_key, v2_key)
        self.assertIn(api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v1"], v1_key)
        self.assertIn(api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"], v2_key)

    def test_cache_key_includes_resolved_checkpoint_path_and_state_file_override(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
        os.environ[api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV] = "_ops/checkpoints/custom_state_v2.json"
        first = api._resolve_dropbox_state_path_info()

        os.environ[api.UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE_ENV] = "/tmp/custom_state_file_v2.json"
        second = api._resolve_dropbox_state_path_info()

        self.assertIn("_ops/checkpoints/custom_state_v2.json", first["cache_key"])
        self.assertIn("_ops/checkpoints/custom_state_v2.json", second["cache_key"])
        self.assertIn("/tmp/custom_state_file_v2.json", second["cache_key"])
        self.assertNotEqual(first["cache_key"], second["cache_key"])

    def test_fake_v2_checkpoint_extracts_expected_dropbox_days(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            checkpoint = (
                Path(tmpdir)
                / api.UK_AQ_DROPBOX_ROOT
                / api.UK_AQ_R2_HISTORY_DROPBOX_DIR
                / api.R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"]
            )
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_text(
                json.dumps(
                    {
                        "domains": {
                            "observations": {
                                "days": {
                                    "2026-06-12": {},
                                    "2026-06-13": {},
                                    "2026-06-14": {},
                                    "2026-06-15": {},
                                }
                            },
                            "aqilevels": {
                                "days": {
                                    "2026-06-12": {},
                                    "2026-06-13": {},
                                    "2026-06-14": {},
                                    "2026-06-15": {},
                                }
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )
            os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
            with patch.object(api, "UK_AQ_DROPBOX_LOCAL_ROOT", tmpdir):
                days, state_path, state_error, state_info = api._load_dropbox_backup_days()

        expected_days = {
            date(2026, 6, 12),
            date(2026, 6, 13),
            date(2026, 6, 14),
            date(2026, 6, 15),
        }
        self.assertEqual(days["observations"], expected_days)
        self.assertEqual(days["aqilevels"], expected_days)
        self.assertEqual(state_path, str(checkpoint))
        self.assertIsNone(state_error)
        self.assertIn("r2_history_backup_state_v2.json", state_info["cache_key"])

    def test_storage_coverage_payload_exposes_dropbox_diagnostics_and_preserves_r2_fields(self):
        os.environ[api.R2_HISTORY_READ_VERSION_ENV] = "v2"
        state_info = api._resolve_dropbox_state_path_info()
        rows = [
            {
                "date": "2026-06-12",
                "r2_observs": True,
                "r2_aqilevels": False,
                "dropbox_observs": True,
                "dropbox_aqilevels": True,
            }
        ]
        with api.CACHE_LOCK:
            api.STORAGE_COVERAGE_CACHE_STATE["rows"] = rows
            api.STORAGE_COVERAGE_CACHE_STATE["next_refresh_at"] = datetime.now(timezone.utc) + timedelta(minutes=5)
            api.STORAGE_COVERAGE_CACHE_STATE["cache_key"] = state_info["cache_key"]
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_path"] = "dropbox:/checkpoint_v2.json"
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_error"] = None
            api.STORAGE_COVERAGE_CACHE_STATE["dropbox_state_info"] = state_info

        payload = api._build_storage_coverage_payload("https://example.supabase.co", "service-key")

        for key in (
            "dropbox_backup_state_path",
            "dropbox_backup_state_error",
            "dropbox_backup_state_source",
            "dropbox_backup_state_attempted_paths",
            "dropbox_backup_state_cache_key",
            "dropbox_backup_state_warning",
            "dropbox_backup_state_fallback_attempted",
        ):
            self.assertIn(key, payload)
        self.assertEqual(payload["dropbox_backup_state_path"], "dropbox:/checkpoint_v2.json")
        self.assertFalse(payload["dropbox_backup_state_fallback_attempted"])
        self.assertIn("storage_coverage_days", payload)
        self.assertIn("r2_observs", payload["storage_coverage_days"][0])
        self.assertIn("r2_aqilevels", payload["storage_coverage_days"][0])
        self.assertTrue(payload["storage_coverage_days"][0]["r2_observs"])
        self.assertFalse(payload["storage_coverage_days"][0]["r2_aqilevels"])


if __name__ == "__main__":
    unittest.main()
