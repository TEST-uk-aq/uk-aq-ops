import unittest
from unittest.mock import patch, mock_open
import os
import json

from uk_aq_dashboard_api import (
    _looks_like_v1_dropbox_state_path,
    _resolve_dropbox_state_path_info,
    R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS,
)

class TestDropboxStatePathResolution(unittest.TestCase):
    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {}, clear=True)
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def test_looks_like_v1(self):
        self.assertTrue(_looks_like_v1_dropbox_state_path("_ops/checkpoints/r2_history_backup_state_v1.json"))
        self.assertTrue(_looks_like_v1_dropbox_state_path("V1_checkpoint.json"))
        self.assertFalse(_looks_like_v1_dropbox_state_path("_ops/checkpoints/r2_history_backup_state_v2.json"))
        self.assertFalse(_looks_like_v1_dropbox_state_path("v1_and_v2.json"))

    @patch("uk_aq_dashboard_api._resolve_r2_history_read_version")
    @patch("uk_aq_dashboard_api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV", "")
    def test_resolve_default_v1(self, mock_read_version):
        mock_read_version.return_value = {"version": "v1"}
        info = _resolve_dropbox_state_path_info()
        self.assertEqual(info["path"], R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v1"])
        self.assertEqual(info["source"], "default")
        self.assertFalse(info["fallback_attempted"])

    @patch("uk_aq_dashboard_api._resolve_r2_history_read_version")
    @patch("uk_aq_dashboard_api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV", "")
    def test_resolve_default_v2(self, mock_read_version):
        mock_read_version.return_value = {"version": "v2"}
        info = _resolve_dropbox_state_path_info()
        self.assertEqual(info["path"], R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"])
        self.assertEqual(info["source"], "default")
        self.assertFalse(info["fallback_attempted"])

    @patch("uk_aq_dashboard_api._resolve_r2_history_read_version")
    @patch("uk_aq_dashboard_api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV", "_ops/checkpoints/r2_history_backup_state_v1.json")
    def test_resolve_override_v2_with_v1_path(self, mock_read_version):
        # When read version is v2 but env looks like v1, it should fallback to default v2
        mock_read_version.return_value = {"version": "v2"}
        info = _resolve_dropbox_state_path_info()
        self.assertEqual(info["path"], R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"])
        self.assertEqual(info["source"], "default_override_v1")
        self.assertTrue(info["fallback_attempted"])
        self.assertIsNotNone(info["warning"])
        self.assertIn("_ops/checkpoints/r2_history_backup_state_v1.json", info["attempted_paths"])
        self.assertIn(R2_HISTORY_BACKUP_STATE_REL_PATH_DEFAULTS["v2"], info["attempted_paths"])

    @patch("uk_aq_dashboard_api._resolve_r2_history_read_version")
    @patch("uk_aq_dashboard_api.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH_ENV", "custom_v2_path.json")
    def test_resolve_explicit_v2_override(self, mock_read_version):
        mock_read_version.return_value = {"version": "v2"}
        info = _resolve_dropbox_state_path_info()
        self.assertEqual(info["path"], "custom_v2_path.json")
        self.assertEqual(info["source"], "env")
        self.assertFalse(info["fallback_attempted"])
        self.assertIsNone(info["warning"])

if __name__ == "__main__":
    unittest.main()
