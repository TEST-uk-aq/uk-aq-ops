from __future__ import annotations

import datetime as dt
import importlib.util
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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
