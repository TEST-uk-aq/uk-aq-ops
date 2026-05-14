#!/usr/bin/env python3
"""Preflight checks for uk-aq-history-integrity."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from argparse import Namespace
from contextlib import contextmanager
from io import StringIO
from pathlib import Path
from contextlib import redirect_stderr


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def make_args(**overrides: object) -> Namespace:
    values = {
        "env": "CIC-Test",
        "profile": "daily",
        "source": "openaq",
        "from_day": None,
        "to_day": None,
        "dry_run": False,
        "check_only": False,
        "run_backfill": False,
        "max_download_mb": None,
        "max_runtime_minutes": None,
        "verbose": False,
        "concurrency": 8,
        "force_snapshot_import": False,
        "skip_snapshot_import": False,
        "skip_cross_check": False,
    }
    values.update(overrides)
    return Namespace(**values)


@contextmanager
def patched_env(values: dict[str, str]):
    original = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(values)
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)


class PreflightTests(unittest.TestCase):
    def _base_env(self, root: Path) -> tuple[dict[str, str], dict[str, str]]:
        state = root / "state" / "CIC-Test"
        snapshot_root = root / "snapshot"
        snapshot_root.mkdir(parents=True, exist_ok=True)
        (snapshot_root / "manifest.json").write_text("{}", encoding="utf-8")
        r2_root = root / "r2"
        (r2_root / "history" / "v1").mkdir(parents=True, exist_ok=True)

        env = {
            "UK_AQ_ENV_NAME": "CIC-Test",
            "UK_AQ_HISTORY_INTEGRITY_ROOT": str(root),
            "UK_AQ_HISTORY_INTEGRITY_STATE_DIR": str(state),
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": str(state / "uk_aq_history_integrity.sqlite"),
            "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(state / "source-cache"),
            "UK_AQ_HISTORY_INTEGRITY_TMP_DIR": str(state / "tmp"),
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(state / "logs"),
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": str(state / "reports"),
            "UK_AQ_HISTORY_INTEGRITY_LOCK_DIR": str(state / "locks"),
            "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT": str(snapshot_root),
        }
        os_env = dict(env)
        os_env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"] = str(r2_root)
        os_env["UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH"] = str(
            root / "dropbox" / "CIC-Test" / "uk_aq_history_integrity.sqlite",
        )
        return env, os_env

    def test_env_mismatch_detection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            env["UK_AQ_ENV_NAME"] = "LIVE"
            args = make_args(env="CIC-Test")
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("UK_AQ_ENV_NAME" in err for err in errors))

    def test_required_var_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env.pop("UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT", None)
            with patched_env(os_env):
                with redirect_stderr(StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        MODULE.load_env_or_die()
            self.assertEqual(raised.exception.code, 3)

    def test_wrong_live_cic_path_detection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env["UK_AQ_HISTORY_INTEGRITY_DB_PATH"] = "/tmp/state/LIVE/db.sqlite"
            args = make_args(env="CIC-Test")
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("contains '/LIVE/'" in err for err in errors))

    def test_missing_backfill_wrapper_when_run_backfill_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env["UK_AQ_BACKFILL_WRAPPER"] = str(root / "missing-wrapper.sh")
            os_env["UK_AQ_BACKFILL_ENV_FILE"] = str(root / "missing-backfill.env")
            args = make_args(run_backfill=True)
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("UK_AQ_BACKFILL_WRAPPER does not exist" in err for err in errors))

    def test_missing_r2_root_when_cross_check_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env.pop("UK_AQ_R2_HISTORY_DROPBOX_ROOT", None)
            args = make_args(skip_cross_check=False)
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("UK_AQ_R2_HISTORY_DROPBOX_ROOT is required" in err for err in errors))

    def test_missing_r2_root_allowed_when_skip_cross_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env.pop("UK_AQ_R2_HISTORY_DROPBOX_ROOT", None)
            args = make_args(skip_cross_check=True)
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertFalse(any("UK_AQ_R2_HISTORY_DROPBOX_ROOT" in err for err in errors))

    def test_valid_fresh_install_state_dir_db_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            args = make_args()
            with patched_env(os_env):
                errors, warnings, _ = MODULE.collect_preflight_errors(args, env)
            self.assertEqual(errors, [])
            self.assertIsInstance(warnings, list)


if __name__ == "__main__":
    unittest.main()
