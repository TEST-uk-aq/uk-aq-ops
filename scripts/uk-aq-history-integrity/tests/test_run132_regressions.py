#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_run132", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class Run132RegressionTests(unittest.TestCase):
    def test_canonical_history_key_resolves_through_view_symlink_without_allowing_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            overlay = root / "overlay"
            view = root / "view"
            key = "history/v2/observations/day_utc=2026-05-17/connector_id=1/pollutant_code=o3/part-00000.parquet"
            source = overlay / key
            source.parent.mkdir(parents=True)
            source.write_bytes(b"PAR1")
            target = view / key
            target.parent.mkdir(parents=True)
            target.symlink_to(source)

            resolved = MODULE._resolve_canonical_history_object_key(
                view, key, allowed_real_roots=(overlay,)
            )
            self.assertEqual(resolved, target)
            self.assertTrue(resolved.is_file())
            self.assertIsNone(MODULE._resolve_canonical_history_object_key(view, "../outside.parquet"))
            self.assertIsNone(MODULE._resolve_canonical_history_object_key(view, "/tmp/outside.parquet"))

            outside = root / "outside.parquet"
            outside.write_bytes(b"PAR1")
            escaped = view / "history/v2/escaped.parquet"
            escaped.parent.mkdir(parents=True, exist_ok=True)
            escaped.symlink_to(outside)
            self.assertIsNone(MODULE._resolve_canonical_history_object_key(view, "history/v2/escaped.parquet"))

    def test_explicit_boundary_failure_calls_no_dropbox_source_or_r2_adapter(self) -> None:
        args = SimpleNamespace(
            env="TEST", profile="manual", source="sos", from_day="2026-05-17",
            to_day="2026-05-17", history_version="v2", verbose=False, dry_run=False,
            check_only=False, run_backfill=True, allow_stale_dropbox=False,
            logical_run_date=None,
        )
        env = {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": "/tmp/logs",
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": "/tmp/reports",
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": "/tmp/integrity.sqlite3",
        }
        blocked = {
            "allowed": False,
            "requested_start_day": "2026-05-17",
            "requested_end_day": "2026-05-17",
            "blocked_reason": "integrity_range_overlaps_ingestdb_boundary",
            "blockers": [{"connector_id": 1, "earliest_ingestdb_day": "2026-05-17"}],
        }
        with (
            mock.patch.object(MODULE, "parse_args", return_value=args),
            mock.patch.object(MODULE, "load_env_or_die", return_value=env),
            mock.patch.object(MODULE, "resolve_history_version_mode", return_value="v2"),
            mock.patch.object(MODULE, "expand_history_versions", return_value=("v2",)),
            mock.patch.object(MODULE, "resolve_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "serialize_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "setup_logging", return_value=Path("/tmp/test.log")),
            mock.patch.object(MODULE, "_resolve_daily_task_health_config", return_value={"enabled": False, "strict": False}),
            mock.patch.object(MODULE, "run_integrity_ingest_boundary_check", return_value=blocked) as boundary,
            mock.patch.object(MODULE, "run_scheduled_backup_gate") as backup_gate,
            mock.patch.object(MODULE, "run_preflight_or_die") as preflight,
            mock.patch.object(MODULE, "open_db") as open_db,
            mock.patch.object(MODULE, "write_reports") as write_reports,
        ):
            self.assertEqual(MODULE.main([]), 2)
        boundary.assert_called_once()
        backup_gate.assert_not_called()
        preflight.assert_not_called()
        open_db.assert_not_called()
        write_reports.assert_called_once()

    def test_allowed_boundary_delegates_to_global_lock_before_backup_or_preflight(self) -> None:
        args = SimpleNamespace(
            env="TEST", profile="manual", source="sos", from_day="2026-05-17",
            to_day="2026-05-17", history_version="v2", verbose=False, dry_run=False,
            check_only=True, run_backfill=False, allow_stale_dropbox=False,
            logical_run_date=None,
        )
        env = {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": "/tmp/logs",
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": "/tmp/reports",
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": "/tmp/integrity.sqlite3",
        }
        allowed = {
            "allowed": True,
            "requested_start_day": "2026-05-17",
            "requested_end_day": "2026-05-17",
            "blockers": [],
        }
        history_paths = {
            "v2": SimpleNamespace(observations_data_prefix="history/v2/observations"),
        }
        events: list[str] = []
        with (
            mock.patch.object(MODULE, "parse_args", return_value=args),
            mock.patch.object(MODULE, "load_env_or_die", return_value=env),
            mock.patch.object(MODULE, "resolve_history_version_mode", return_value="v2"),
            mock.patch.object(MODULE, "expand_history_versions", return_value=("v2",)),
            mock.patch.object(MODULE, "resolve_history_path_configs", return_value=history_paths),
            mock.patch.object(MODULE, "serialize_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "setup_logging", return_value=Path("/tmp/test.log")),
            mock.patch.object(MODULE, "_resolve_daily_task_health_config", return_value={"enabled": False, "strict": False}),
            mock.patch.object(MODULE, "observations_global_operation_lock_context", return_value={"held": False, "valid": False}),
            mock.patch.object(MODULE, "run_integrity_ingest_boundary_check", side_effect=lambda **_kwargs: events.append("boundary") or allowed),
            mock.patch.object(MODULE, "run_integrity_under_global_operation_lock", side_effect=lambda **_kwargs: events.append("global_lock") or 17),
            mock.patch.object(MODULE, "run_integrity_dropbox_currentness_gate") as currentness,
            mock.patch.object(MODULE, "run_scheduled_backup_gate") as backup_gate,
            mock.patch.object(MODULE, "run_preflight_or_die") as preflight,
        ):
            self.assertEqual(MODULE.main([]), 17)
        self.assertEqual(events, ["boundary", "global_lock"])
        currentness.assert_not_called()
        backup_gate.assert_not_called()
        preflight.assert_not_called()

    def test_locked_child_blocks_stale_checkpoint_before_old_backup_gate(self) -> None:
        args = SimpleNamespace(
            env="TEST", profile="manual", source="sos", from_day="2026-05-17",
            to_day="2026-05-17", history_version="v2", verbose=False, dry_run=False,
            check_only=True, run_backfill=False, allow_stale_dropbox=True,
            logical_run_date=None,
        )
        env = {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": "/tmp/logs",
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": "/tmp/reports",
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": "/tmp/integrity.sqlite3",
        }
        history_paths = {
            "v2": SimpleNamespace(observations_data_prefix="history/v2/observations"),
        }
        lock = {
            "held": True,
            "valid": True,
            "owner": "integrity",
            "run_id": "integrity:test",
            "logical_identity": "uk_aq:r2_history:v2:observations_global_operation",
        }
        with (
            mock.patch.object(MODULE, "parse_args", return_value=args),
            mock.patch.object(MODULE, "load_env_or_die", return_value=env),
            mock.patch.object(MODULE, "resolve_history_version_mode", return_value="v2"),
            mock.patch.object(MODULE, "expand_history_versions", return_value=("v2",)),
            mock.patch.object(MODULE, "resolve_history_path_configs", return_value=history_paths),
            mock.patch.object(MODULE, "serialize_history_path_configs", return_value={}),
            mock.patch.object(MODULE, "setup_logging", return_value=Path("/tmp/test.log")),
            mock.patch.object(MODULE, "_resolve_daily_task_health_config", return_value={"enabled": False, "strict": False}),
            mock.patch.object(MODULE, "observations_global_operation_lock_context", return_value=lock),
            mock.patch.object(MODULE, "run_integrity_ingest_boundary_check", return_value={"allowed": True, "blockers": []}),
            mock.patch.object(MODULE, "load_backfill_env_file_if_set"),
            mock.patch.object(MODULE, "resolve_r2_history_root", return_value="/dropbox"),
            mock.patch.object(MODULE, "run_integrity_dropbox_currentness_gate", return_value={
                "allowed": False,
                "status": "blocked_stale_dropbox_checkpoint",
                "checkpoint_live_root_match": False,
            }),
            mock.patch.object(MODULE, "run_scheduled_backup_gate") as backup_gate,
            mock.patch.object(MODULE, "run_preflight_or_die") as preflight,
            mock.patch.object(MODULE, "write_reports") as write_reports,
        ):
            self.assertEqual(MODULE.main([]), 2)
        backup_gate.assert_not_called()
        preflight.assert_not_called()
        write_reports.assert_called_once()


if __name__ == "__main__":
    unittest.main()
