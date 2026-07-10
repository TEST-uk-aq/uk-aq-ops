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
from unittest import mock


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
        "history_version": None,
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
    def test_parse_args_accepts_sos_source(self) -> None:
        parsed = MODULE.parse_args(
            ["--env", "CIC-Test", "--source", "sos", "--profile", "manual", "--from-day", "2026-05-11", "--to-day", "2026-05-11"],
        )
        self.assertEqual(parsed.source, "sos")

    def test_parse_args_rejects_hyphenated_sos_source(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args(
                ["--env", "CIC-Test", "--source", "sos", "--profile", "manual", "--from-day", "2026-05-11", "--to-day", "2026-05-11"],
            )

    def _base_env(self, root: Path) -> tuple[dict[str, str], dict[str, str]]:
        state = root / "state" / "CIC-Test"
        snapshot_root = root / "snapshot"
        snapshot_root.mkdir(parents=True, exist_ok=True)
        (snapshot_root / "manifest.json").write_text("{}", encoding="utf-8")
        backfill_env = root / "backfill.env"
        backfill_env.write_text(
            "\n".join(
                [
                    "OBS_AQIDB_SUPABASE_URL=https://example.supabase.co",
                    "OBS_AQIDB_SECRET_KEY=example-service-role-key",
                    "OBS_AQIDB_SUPABASE_DB_URL=postgresql://example",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        r2_root = root / "r2"
        r2_v1_core = r2_root / "history" / "v1" / "core"
        r2_v1_core.mkdir(parents=True, exist_ok=True)
        (r2_v1_core / "manifest.json").write_text("{}", encoding="utf-8")

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
        os_env["UK_AQ_BACKFILL_ENV_FILE"] = str(backfill_env)
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
            self.assertTrue(
                any(
                    "Backfill wrapper is required when --run-backfill is used" in err
                    for err in errors
                )
            )

    def test_missing_r2_root_when_cross_check_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env.pop("UK_AQ_R2_HISTORY_DROPBOX_ROOT", None)
            args = make_args(skip_cross_check=False)
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("R2 history Dropbox root could not be resolved" in err for err in errors))

    def test_r2_root_resolves_from_dropbox_root_and_history_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env.pop("UK_AQ_R2_HISTORY_DROPBOX_ROOT", None)
            os_env["UK_AQ_DROPBOX_ROOT"] = "CIC-Test"
            os_env["UK_AQ_R2_HISTORY_DROPBOX_DIR"] = "R2_history_backup"
            backup_root = root / "dropbox-app" / "CIC-Test" / "R2_history_backup"
            (backup_root / "history" / "v1" / "core").mkdir(parents=True, exist_ok=True)
            (backup_root / "history" / "v1" / "core" / "manifest.json").write_text("{}", encoding="utf-8")
            os_env["UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"] = str(backup_root / "history" / "v1" / "core")
            args = make_args(skip_cross_check=False)
            with patched_env(os_env), mock.patch.object(MODULE, "DROPBOX_APP_ROOT", root / "dropbox-app"):
                errors, _, summary = MODULE.collect_preflight_errors(args, env)
            self.assertEqual(errors, [])
            self.assertEqual(summary["paths"]["r2_history_root"], str(backup_root))

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

    def test_daily_task_health_missing_backfill_env_file_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"] = "true"
            os_env.pop("UK_AQ_BACKFILL_ENV_FILE", None)
            args = make_args()
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(
                any("UK_AQ_BACKFILL_ENV_FILE is required when daily task health reporting is enabled." in err for err in errors),
            )

    def test_daily_task_health_disabled_allows_missing_backfill_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"] = "false"
            os_env.pop("UK_AQ_BACKFILL_ENV_FILE", None)
            args = make_args()
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertFalse(
                any("daily task health reporting is enabled" in err for err in errors),
            )

    def test_daily_task_health_missing_obs_creds_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            bad_env = root / "bad-backfill.env"
            bad_env.write_text("UK_AQ_BACKFILL_WRAPPER=/tmp/dummy.sh\n", encoding="utf-8")
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"] = "true"
            os_env["UK_AQ_BACKFILL_ENV_FILE"] = str(bad_env)
            args = make_args()
            with patched_env(os_env):
                errors, _, _ = MODULE.collect_preflight_errors(args, env)
            self.assertTrue(any("OBS_AQIDB_SUPABASE_URL is required" in err for err in errors))
            self.assertTrue(any("OBS_AQIDB_SECRET_KEY is required" in err for err in errors))

    def test_preflight_summary_includes_daily_task_health_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"] = "true"
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_STRICT"] = "true"
            args = make_args(source="sos", profile="manual", from_day="2026-05-01", to_day="2026-05-01")
            with patched_env(os_env):
                errors, _, summary = MODULE.collect_preflight_errors(args, env)
            self.assertEqual(errors, [])
            self.assertEqual(summary["env"], "CIC-Test")
            self.assertEqual(summary["profile"], "manual")
            self.assertEqual(summary["source"], "sos")
            self.assertTrue(summary["daily_task_health_enabled"])
            self.assertTrue(summary["daily_task_health_strict"])

    def test_v2_preflight_validates_and_reports_resolved_core_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            backup_root = root / "R2_history_backup"
            v2_core_root = backup_root / "history" / "v2" / "core"
            v2_core_root.mkdir(parents=True, exist_ok=True)
            (v2_core_root / "manifest.json").write_text("{}", encoding="utf-8")
            os_env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"] = str(backup_root)
            os_env["UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"] = str(
                backup_root / "history" / "v1" / "core",
            )
            args = make_args(history_version="v2", skip_cross_check=True)
            with patched_env(os_env):
                errors, _, summary = MODULE.collect_preflight_errors(args, env)
            self.assertEqual(errors, [])
            self.assertEqual(summary["paths"]["core_history_version"], "v2")
            self.assertEqual(summary["paths"]["core_prefix"], "history/v2/core")
            self.assertEqual(summary["paths"]["snapshot_root"], str(v2_core_root))

    def test_v2_preflight_missing_resolved_core_root_reports_v2_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env, os_env = self._base_env(root)
            backup_root = root / "R2_history_backup"
            (backup_root / "history" / "v1" / "core").mkdir(parents=True, exist_ok=True)
            (backup_root / "history" / "v1" / "core" / "manifest.json").write_text("{}", encoding="utf-8")
            os_env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"] = str(backup_root)
            os_env["UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT"] = str(
                backup_root / "history" / "v1" / "core",
            )
            args = make_args(history_version="v2", skip_cross_check=True)
            with patched_env(os_env):
                errors, _, summary = MODULE.collect_preflight_errors(args, env)
            self.assertEqual(summary["paths"]["snapshot_root"], str(backup_root / "history" / "v2" / "core"))
            self.assertTrue(
                any(
                    "history_version=v2" in err and "history/v2/core" in err
                    for err in errors
                ),
            )

    def test_resolve_daily_task_health_config_loads_obs_creds_from_backfill_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, os_env = self._base_env(root)
            os_env["UK_AQ_HISTORY_INTEGRITY_DAILY_TASK_HEALTH_ENABLED"] = "true"
            with patched_env(os_env):
                config = MODULE._resolve_daily_task_health_config(env_name="CIC-Test")
            self.assertTrue(config["enabled"])
            self.assertEqual(config["supabase_url"], "https://example.supabase.co")
            self.assertEqual(config["supabase_key"], "example-service-role-key")


if __name__ == "__main__":
    unittest.main()
