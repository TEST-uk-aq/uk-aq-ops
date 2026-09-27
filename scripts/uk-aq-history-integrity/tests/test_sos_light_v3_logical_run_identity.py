#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity-sos-light-v3.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_sos_light_v3_run_identity", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SosLightV3LogicalRunIdentityTests(unittest.TestCase):
    def tearDown(self) -> None:
        MODULE.close_logging_handlers()

    @staticmethod
    def _base_env(root: Path) -> dict[str, str]:
        return {
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(root / "logs"),
            "UK_AQ_HISTORY_INTEGRITY_REPORT_DIR": str(root / "reports"),
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": str(root / "integrity.sqlite3"),
        }

    @staticmethod
    def _history_paths() -> dict[str, SimpleNamespace]:
        return {
            "v3": SimpleNamespace(
                observations_data_prefix="history/v3/observations"
            ),
        }

    def test_lock_child_reuses_parent_log_and_report_identity(self) -> None:
        parent_started = dt.datetime(
            2026, 9, 27, 16, 15, 33, tzinfo=dt.timezone.utc
        )
        child_wall_clock = dt.datetime(
            2026, 9, 27, 16, 15, 37, tzinfo=dt.timezone.utc
        )
        run_compact = MODULE.fmt_compact(parent_started)
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            env = self._base_env(root)
            parent_log_path = MODULE.setup_logging(
                env["UK_AQ_HISTORY_INTEGRITY_LOG_DIR"], run_compact, False
            )
            logging.getLogger("logical-run-test").info("start env=TEST")
            logging.getLogger("logical-run-test").info(
                "IngestDB boundary check: allowed"
            )
            MODULE.close_logging_handlers()

            logical_context = MODULE.build_integrity_logical_run_context(
                env_name="TEST",
                started_at_utc=MODULE.fmt_iso(parent_started),
                run_compact=run_compact,
                log_path=parent_log_path,
            )
            lock = {
                "held": True,
                "valid": True,
                "owner": "integrity",
                "run_id": f"integrity:TEST:{run_compact}",
                "logical_identity": (
                    "uk_aq:r2_history:v2:observations_global_operation"
                ),
            }
            blocked_checkpoint = {
                "allowed": False,
                "status": "blocked_stale_dropbox_checkpoint",
                "checkpoint_live_root_match": False,
            }
            with (
                mock.patch.dict(
                    MODULE.os.environ,
                    {
                        MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV: json.dumps(
                            logical_context
                        ),
                    },
                    clear=True,
                ),
                mock.patch.object(MODULE, "load_env_or_die", return_value=env),
                mock.patch.object(
                    MODULE, "resolve_and_pin_integrity_target_writer_git_sha"
                ),
                mock.patch.object(
                    MODULE,
                    "resolve_history_path_configs",
                    return_value=self._history_paths(),
                ),
                mock.patch.object(
                    MODULE, "serialize_history_path_configs", return_value={}
                ),
                mock.patch.object(
                    MODULE,
                    "_resolve_daily_task_health_config",
                    return_value={"enabled": False, "strict": False},
                ),
                mock.patch.object(
                    MODULE,
                    "observations_global_operation_lock_context",
                    return_value=lock,
                ),
                mock.patch.object(
                    MODULE,
                    "run_integrity_ingest_boundary_check",
                    return_value={"allowed": True, "blockers": []},
                ),
                mock.patch.object(MODULE, "load_backfill_env_file_if_set"),
                mock.patch.object(
                    MODULE, "resolve_r2_history_root", return_value="/dropbox"
                ),
                mock.patch.object(
                    MODULE,
                    "run_integrity_dropbox_currentness_gate",
                    return_value=blocked_checkpoint,
                ),
                mock.patch.object(
                    MODULE, "utc_now", return_value=child_wall_clock
                ),
            ):
                result = MODULE.main([
                    "--env", "TEST",
                    "--source", "sos",
                    "--from-day", "2026-09-26",
                    "--to-day", "2026-09-26",
                    "--check-only",
                ])

            self.assertEqual(result, 2)
            later_compact = MODULE.fmt_compact(child_wall_clock)
            self.assertEqual(
                sorted(path.name for path in (root / "logs").glob("run-*.log")),
                [f"run-{run_compact}.log"],
            )
            self.assertFalse(
                (root / "logs" / f"run-{later_compact}.log").exists()
            )
            combined_log = parent_log_path.read_text(encoding="utf-8")
            self.assertEqual(combined_log.count("INFO start env=TEST"), 1)
            self.assertIn(
                "INFO resumed under observations global operation lock",
                combined_log,
            )
            self.assertIn(f'"run_id": "integrity:TEST:{run_compact}"', combined_log)
            self.assertTrue(
                (root / "reports" / f"{run_compact}-summary.json").exists()
            )
            self.assertFalse(
                (root / "reports" / f"{later_compact}-summary.json").exists()
            )

    def test_pre_lock_blocked_run_keeps_one_log_and_report(self) -> None:
        started = dt.datetime(2026, 9, 27, 16, 15, 33, tzinfo=dt.timezone.utc)
        run_compact = MODULE.fmt_compact(started)
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            env = self._base_env(root)
            blocked = {
                "allowed": False,
                "blocked_reason": "integrity_range_overlaps_ingestdb_boundary",
                "blockers": [{"connector_id": 1}],
            }
            with (
                mock.patch.dict(MODULE.os.environ, {}, clear=True),
                mock.patch.object(MODULE, "load_env_or_die", return_value=env),
                mock.patch.object(
                    MODULE, "resolve_and_pin_integrity_target_writer_git_sha"
                ),
                mock.patch.object(
                    MODULE,
                    "resolve_history_path_configs",
                    return_value=self._history_paths(),
                ),
                mock.patch.object(
                    MODULE, "serialize_history_path_configs", return_value={}
                ),
                mock.patch.object(
                    MODULE,
                    "_resolve_daily_task_health_config",
                    return_value={"enabled": False, "strict": False},
                ),
                mock.patch.object(
                    MODULE,
                    "run_integrity_ingest_boundary_check",
                    return_value=blocked,
                ),
                mock.patch.object(MODULE, "utc_now", return_value=started),
                mock.patch.object(
                    MODULE, "run_integrity_under_global_operation_lock"
                ) as global_lock,
            ):
                result = MODULE.main([
                    "--env", "TEST",
                    "--source", "sos",
                    "--from-day", "2026-09-26",
                    "--to-day", "2026-09-26",
                    "--check-only",
                ])

            self.assertEqual(result, 2)
            global_lock.assert_not_called()
            self.assertEqual(
                [path.name for path in (root / "logs").glob("run-*.log")],
                [f"run-{run_compact}.log"],
            )
            self.assertTrue(
                (root / "reports" / f"{run_compact}-summary.json").exists()
            )

    def test_only_valid_lock_child_may_inherit_context(self) -> None:
        context = {
            MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV: json.dumps({
                "contract_version": MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_VERSION,
                "env_name": "TEST",
                "started_at_utc": "2026-09-27T16:15:33Z",
                "run_compact": "2026-09-27T161533Z",
                "log_path": "/tmp/logs/run-2026-09-27T161533Z.log",
            }),
        }
        self.assertIsNone(
            MODULE.inherited_integrity_logical_run_context(
                context,
                expected_env_name="TEST",
                expected_log_dir="/tmp/logs",
                global_operation_lock={"valid": False},
            )
        )
        with self.assertRaisesRegex(RuntimeError, "missing its logical run context"):
            MODULE.inherited_integrity_logical_run_context(
                {},
                expected_env_name="TEST",
                expected_log_dir="/tmp/logs",
                global_operation_lock={
                    "valid": True,
                    "run_id": "integrity:TEST:2026-09-27T161533Z",
                },
            )
        mismatched = json.loads(
            context[MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV]
        )
        mismatched["log_path"] = "/tmp/logs/run-2026-09-27T161537Z.log"
        with self.assertRaisesRegex(RuntimeError, "identity disagrees"):
            MODULE.inherited_integrity_logical_run_context(
                {
                    MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV: json.dumps(
                        mismatched
                    ),
                },
                expected_env_name="TEST",
                expected_log_dir="/tmp/logs",
                global_operation_lock={
                    "valid": True,
                    "run_id": "integrity:TEST:2026-09-27T161533Z",
                },
            )

    def test_parent_passes_original_identity_to_global_lock_child(self) -> None:
        run_compact = "2026-09-27T161533Z"
        started_iso = "2026-09-27T16:15:33Z"
        log_path = Path("/tmp/logs") / f"run-{run_compact}.log"
        with (
            mock.patch.object(
                MODULE,
                "_repo_root_for_integrity_script",
                return_value=Path("/tmp/repo"),
            ),
            mock.patch.object(
                MODULE,
                "resolve_history_writer_database_url",
                return_value="postgresql://test",
            ),
            mock.patch.object(MODULE, "close_logging_handlers") as close_handlers,
            mock.patch.object(
                MODULE.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=23),
            ) as run,
        ):
            result = MODULE.run_integrity_under_global_operation_lock(
                argv=["--env", "TEST"],
                args=SimpleNamespace(env="TEST"),
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                run_compact=run_compact,
                started_at_utc=started_iso,
                log_path=log_path,
            )

        self.assertEqual(result, 23)
        close_handlers.assert_called_once_with()
        command = run.call_args.args[0]
        self.assertEqual(
            command[command.index("--run-id") + 1],
            f"integrity:TEST:{run_compact}",
        )
        child_context = json.loads(
            run.call_args.kwargs["env"][MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV]
        )
        self.assertEqual(
            child_context,
            MODULE.build_integrity_logical_run_context(
                env_name="TEST",
                started_at_utc=started_iso,
                run_compact=run_compact,
                log_path=log_path,
            ),
        )

    def test_independent_setup_uses_a_distinct_log_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            first = MODULE.setup_logging(
                str(log_dir), "2026-09-27T161533Z", False
            )
            MODULE.close_logging_handlers()
            second = MODULE.setup_logging(
                str(log_dir), "2026-09-27T161537Z", False
            )
            MODULE.close_logging_handlers()
            self.assertNotEqual(first, second)
            self.assertEqual(
                sorted(path.name for path in log_dir.glob("run-*.log")),
                [
                    "run-2026-09-27T161533Z.log",
                    "run-2026-09-27T161537Z.log",
                ],
            )


if __name__ == "__main__":
    unittest.main()
