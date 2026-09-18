from __future__ import annotations

import datetime as dt
import importlib.util
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py"
)
SPEC = importlib.util.spec_from_file_location("sos_light_v3_worker_boundary", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SosLightV3WorkerBoundaryTests(unittest.TestCase):
    def test_dedicated_pollutant_worker_log_labels_do_not_collide(self) -> None:
        for stage, expected_prefix in (
            ("detector", "v2_obs_detector"),
            ("proposal", "v2_obs"),
        ):
            labels = {
                MODULE._v2_observation_worker_log_label(
                    stage=stage,
                    day_utc="2026-06-02",
                    connector_id=1,
                    pollutant_code=pollutant,
                )
                for pollutant in ("no2", "o3", "pm10", "pm25")
            }
            self.assertEqual(len(labels), 4)
            self.assertIn(
                f"{expected_prefix}_day_2026-06-02_connector_1_pollutant_pm10",
                labels,
            )
        self.assertEqual(
            MODULE._v2_observation_worker_log_label(
                stage="proposal",
                day_utc="2026-06-02",
                connector_id=1,
                pollutant_code=None,
            ),
            "v2_obs_day_2026-06-02_connector_1",
        )

    def test_child_log_exists_and_contains_output_before_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temp_raw:
            temp = Path(temp_raw)
            wrapper = temp / "worker.sh"
            wrapper.write_text(
                "#!/usr/bin/env bash\necho child-started\nsleep 1\necho child-finished\n",
                encoding="utf-8",
            )
            result_holder = {}

            def invoke() -> None:
                result_holder["result"] = MODULE.run_narrow_backfill(
                    wrapper_path=str(wrapper),
                    env_file_path=None,
                    env_name="TEST",
                    timeseries_ids=[],
                    connector_ids=[1],
                    day=dt.date(2026, 6, 2),
                    log=logging.getLogger("worker-boundary-test"),
                    log_dir=temp,
                    log_label="active_child",
                    output_scope="observations_only",
                    extra_env={"UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare"},
                    history_version="v2",
                    complete_connector_day=True,
                    repair_pollutants=["pm10"],
                    worker_purpose="repair_proposal",
                    canonical_writes_allowed=False,
                )

            thread = threading.Thread(target=invoke)
            thread.start()
            log_path = temp / "active_child.log"
            deadline = time.monotonic() + 0.8
            contents = ""
            while time.monotonic() < deadline:
                if log_path.exists():
                    contents = log_path.read_text(encoding="utf-8")
                    if "child-started" in contents:
                        break
                time.sleep(0.02)
            self.assertTrue(thread.is_alive())
            self.assertIn("# completion: pending", contents)
            self.assertIn("# repair_pollutants: pm10", contents)
            self.assertIn("child-started", contents)
            thread.join(timeout=2)
            self.assertEqual(result_holder["result"]["status"], "ok")

    def test_completed_output_preserves_status_tails_and_result(self) -> None:
        with tempfile.NamedTemporaryFile() as wrapper, tempfile.TemporaryDirectory() as log_dir:
            def fake_run(*_args, **kwargs):
                kwargs["stdout"].write(
                    '{"event":"backfill_run_complete","status":"complete"}\nstdout-tail\n'
                )
                kwargs["stderr"].write("stderr-tail\n")
                return subprocess.CompletedProcess(["wrapper"], 0)

            with mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                result = MODULE.run_narrow_backfill(
                    wrapper_path=wrapper.name,
                    env_file_path=None,
                    env_name="TEST",
                    timeseries_ids=[101],
                    connector_ids=[1],
                    day=dt.date(2026, 6, 2),
                    log=logging.getLogger("worker-boundary-test"),
                    log_dir=Path(log_dir),
                    log_label="completed_child",
                    extra_env={"UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare"},
                    worker_purpose="repair_proposal",
                    canonical_writes_allowed=False,
                )
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["backfill_run_status"], "complete")
            self.assertIn("stdout-tail", result["stdout_tail"])
            self.assertIn("stderr-tail", result["stderr_tail"])
            self.assertIn(
                "# completion: complete",
                Path(result["log_path"]).read_text(encoding="utf-8"),
            )

    def test_timeout_remains_fail_closed(self) -> None:
        with tempfile.NamedTemporaryFile() as wrapper:
            with mock.patch.object(
                MODULE.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["wrapper"], 1800),
            ):
                result = MODULE.run_narrow_backfill(
                    wrapper_path=wrapper.name,
                    env_file_path=None,
                    env_name="TEST",
                    timeseries_ids=[101],
                    connector_ids=[1],
                    day=dt.date(2026, 6, 2),
                    log=logging.getLogger("worker-boundary-test"),
                    timeout_seconds=1800,
                    extra_env={"UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare"},
                    worker_purpose="repair_proposal",
                    canonical_writes_allowed=False,
                )
            self.assertEqual(result["status"], "timeout")
            self.assertIn("1800s", result["error"])

    def test_evidence_worker_is_explicitly_noncanonical_in_every_mode(self) -> None:
        for effective_mode in ("check_only", "repair_dry_run", "repair_apply"):
            with self.subTest(effective_mode=effective_mode):
                with tempfile.NamedTemporaryFile() as wrapper:
                    completed = subprocess.CompletedProcess(["wrapper"], 0, "", "")
                    with (
                        mock.patch.dict(
                            os.environ,
                            {"UK_AQ_INTEGRITY_EFFECTIVE_MODE": effective_mode},
                            clear=False,
                        ),
                        mock.patch.object(
                            MODULE.subprocess, "run", return_value=completed
                        ) as run,
                    ):
                        result = MODULE.run_narrow_backfill(
                            wrapper_path=wrapper.name,
                            env_file_path=None,
                            env_name="TEST",
                            timeseries_ids=[],
                            connector_ids=[1],
                            day=dt.date(2026, 6, 1),
                            log=logging.getLogger("worker-boundary-test"),
                            output_scope="observations_only",
                            extra_env={
                                "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare",
                                "UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY": "true",
                            },
                            history_version="v3",
                            complete_connector_day=True,
                            repair_pollutants=["no2"],
                            worker_purpose="source_evidence_only",
                            canonical_writes_allowed=False,
                        )

                self.assertEqual(result["status"], "ok")
                child_env = run.call_args.kwargs["env"]
                self.assertEqual(
                    child_env["UK_AQ_INTEGRITY_EFFECTIVE_MODE"],
                    effective_mode,
                )
                self.assertEqual(
                    child_env["UK_AQ_INTEGRITY_WORKER_PURPOSE"],
                    "source_evidence_only",
                )
                self.assertEqual(
                    child_env["UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED"],
                    "false",
                )
                self.assertEqual(child_env["UK_AQ_BACKFILL_DRY_RUN"], "false")

    def test_evidence_worker_rejects_write_permission_in_every_mode(self) -> None:
        for effective_mode in ("check_only", "repair_dry_run", "repair_apply"):
            with self.subTest(effective_mode=effective_mode):
                with tempfile.NamedTemporaryFile() as wrapper:
                    with (
                        mock.patch.dict(
                            os.environ,
                            {"UK_AQ_INTEGRITY_EFFECTIVE_MODE": effective_mode},
                            clear=False,
                        ),
                        mock.patch.object(MODULE.subprocess, "run") as run,
                        self.assertRaisesRegex(
                            ValueError, "cannot allow canonical writes"
                        ),
                    ):
                        MODULE.run_narrow_backfill(
                            wrapper_path=wrapper.name,
                            env_file_path=None,
                            env_name="TEST",
                            timeseries_ids=[],
                            connector_ids=[1],
                            day=dt.date(2026, 6, 1),
                            log=logging.getLogger("worker-boundary-test"),
                            output_scope="observations_only",
                            extra_env={
                                "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare",
                                "UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY": "true",
                            },
                            history_version="v3",
                            complete_connector_day=True,
                            repair_pollutants=["no2"],
                            worker_purpose="source_evidence_only",
                            canonical_writes_allowed=True,
                        )
                run.assert_not_called()

    def test_repair_proposal_worker_mode_matrix(self) -> None:
        for effective_mode in ("repair_dry_run", "repair_apply"):
            with self.subTest(effective_mode=effective_mode):
                with tempfile.NamedTemporaryFile() as wrapper:
                    completed = subprocess.CompletedProcess(["wrapper"], 0, "", "")
                    with (
                        mock.patch.dict(
                            os.environ,
                            {"UK_AQ_INTEGRITY_EFFECTIVE_MODE": effective_mode},
                            clear=False,
                        ),
                        mock.patch.object(
                            MODULE.subprocess, "run", return_value=completed
                        ) as run,
                    ):
                        result = MODULE.run_narrow_backfill(
                            wrapper_path=wrapper.name,
                            env_file_path=None,
                            env_name="TEST",
                            timeseries_ids=[101],
                            connector_ids=[1],
                            day=dt.date(2026, 6, 1),
                            log=logging.getLogger("worker-boundary-test"),
                            output_scope="observations_only",
                            extra_env={
                                "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare",
                            },
                            history_version="v3",
                            worker_purpose="repair_proposal",
                            canonical_writes_allowed=False,
                        )
                self.assertEqual(result["status"], "ok")
                child_env = run.call_args.kwargs["env"]
                self.assertEqual(
                    child_env["UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED"],
                    "false",
                )

        with tempfile.NamedTemporaryFile() as wrapper:
            with (
                mock.patch.dict(
                    os.environ,
                    {"UK_AQ_INTEGRITY_EFFECTIVE_MODE": "check_only"},
                    clear=False,
                ),
                mock.patch.object(MODULE.subprocess, "run") as run,
                self.assertRaisesRegex(
                    ValueError, "check_only may launch only source_evidence_only"
                ),
            ):
                MODULE.run_narrow_backfill(
                    wrapper_path=wrapper.name,
                    env_file_path=None,
                    env_name="TEST",
                    timeseries_ids=[101],
                    connector_ids=[1],
                    day=dt.date(2026, 6, 1),
                    log=logging.getLogger("worker-boundary-test"),
                    output_scope="observations_only",
                    extra_env={
                        "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare",
                    },
                    history_version="v3",
                    worker_purpose="repair_proposal",
                    canonical_writes_allowed=False,
                )
        run.assert_not_called()

    def test_run_backfill_false_still_suppresses_repair_worker(self) -> None:
        limits = mock.Mock()
        with mock.patch.object(MODULE, "run_narrow_backfill") as worker:
            metrics = MODULE.run_v2_gap_backfills(
                conn=mock.Mock(),
                run_id=1,
                env_name="TEST",
                run_compact="focused",
                env={},
                v2_observations={"gaps": [{"gap_type": "day_dir_missing"}]},
                dry_run=False,
                run_backfill=False,
                limits=limits,
                log=logging.getLogger("worker-boundary-test"),
            )
        worker.assert_not_called()
        self.assertEqual(metrics["observation_backfills_attempted"], 0)

    def test_fixed_v3_source_repair_is_coordinator_owned(self) -> None:
        with tempfile.NamedTemporaryFile() as wrapper:
            with (
                mock.patch.object(MODULE.subprocess, "run") as run,
                self.assertRaisesRegex(
                    ValueError,
                    "fixed-v3 source repair must use a local repair_proposal",
                ),
            ):
                MODULE.run_narrow_backfill(
                    wrapper_path=wrapper.name,
                    env_file_path=None,
                    env_name="TEST",
                    timeseries_ids=[101],
                    connector_ids=[1],
                    day=dt.date(2026, 6, 1),
                    log=logging.getLogger("worker-boundary-test"),
                    output_scope="observations_only",
                    history_version="v3",
                    worker_purpose="source_repair",
                    canonical_writes_allowed=True,
                )
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
