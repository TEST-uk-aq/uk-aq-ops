from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import logging
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_sos_light_v2_hardening", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


class ReadinessResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def __enter__(self) -> "ReadinessResponse":
        return self

    def __exit__(self, *_args: object) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class SosLightV2CoordinatorHardeningTests(unittest.TestCase):
    def tearDown(self) -> None:
        MODULE.close_logging_handlers()

    def test_public_assembly_wrapper_forwards_staging_and_log_and_filters_metadata(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scan_root = Path(tmpdir)
            (scan_root / "manifest.json").write_text("{}\n", encoding="utf-8")
            (scan_root / ".DS_Store").write_bytes(b"finder")
            (scan_root / "._manifest.json").write_bytes(b"apple-double")
            run_state: dict[str, object] = {"sos_light": {}}
            staging = object()
            operation_log = mock.Mock(spec=logging.Logger)
            audit_log = mock.Mock(spec=logging.Logger)
            observed_names: list[str] = []

            def stub_assembler(
                received_run_state: dict[str, object],
                *,
                proposal_staging: object | None = None,
                log: logging.Logger | None = None,
            ) -> dict[str, object]:
                self.assertIs(received_run_state, run_state)
                self.assertIs(proposal_staging, staging)
                self.assertIs(log, operation_log)
                observed_names.extend(
                    path.name for path in scan_root.rglob("*") if path.is_file()
                )
                return {"status": "stubbed"}

            with (
                mock.patch.object(
                    MODULE,
                    "_ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS",
                    side_effect=stub_assembler,
                ) as original_assembler,
                mock.patch.object(MODULE, "write_run_state") as write_state,
                mock.patch.object(
                    MODULE.logging,
                    "getLogger",
                    return_value=audit_log,
                ),
            ):
                result = MODULE.assemble_sos_light_complete_days(
                    run_state,
                    proposal_staging=staging,
                    log=operation_log,
                )

            original_assembler.assert_called_once_with(
                run_state,
                proposal_staging=staging,
                log=operation_log,
            )
            self.assertEqual(observed_names, ["manifest.json"])
            self.assertEqual(
                result["ignored_local_filesystem_metadata_count"],
                2,
            )
            self.assertEqual(
                result["ignored_local_filesystem_metadata_patterns"],
                [".DS_Store", "._*"],
            )
            self.assertEqual(
                run_state["sos_light"],
                {
                    "ignored_local_filesystem_metadata_count": 2,
                    "ignored_local_filesystem_metadata_patterns": [
                        ".DS_Store",
                        "._*",
                    ],
                },
            )
            self.assertIs(MODULE.Path.rglob, MODULE._ORIGINAL_PATH_RGLOB)
            write_state.assert_called_once_with(run_state)
            audit_log.info.assert_called_once_with(
                "SOS-light ignored %d known macOS metadata files from the Dropbox baseline",
                2,
            )

    def _run_state(self, root: Path) -> dict[str, object]:
        dropbox = root / "dropbox"
        dropbox.mkdir()
        state = MODULE.create_run_overlay(
            tmp_dir=root,
            run_id="v2-hardening",
            environment="TEST",
            base_dropbox_root=dropbox,
        )
        state.update({
            "execution_path": "sos_light",
            "mode": "sos-light",
            "dedicated_sos_historical_replacement": True,
            "mutation_connector_ids": [1],
            "selected_mutation_connector_ids": [1],
            "protected_connector_ids": [1],
        })
        return state

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
            "v2": SimpleNamespace(
                observations_data_prefix="history/v2/observations"
            ),
        }

    @staticmethod
    def _add_object(state: dict[str, object], index: int) -> None:
        key = f"history/v2/observations/day_utc=2026-01-01/object-{index:04d}.json"
        state["objects"][key] = {
            "object_key": key,
            "local_path": f"/run/{index}",
            "sha256": f"{index:064x}"[-64:],
            "bytes": index,
            "stage": "observations_data",
            "dependencies": [],
            "dependency_identities": {},
            "proposed": True,
            "built": True,
            "structurally_validated": True,
        }

    @staticmethod
    def _locked_context() -> dict[str, object]:
        return {
            "held": True,
            "valid": True,
            "owner": "integrity",
            "run_id": "integrity:TEST:step-zero",
            "logical_identity": (
                "uk_aq:r2_history:v2:observations_global_operation"
            ),
        }

    @staticmethod
    def _write_enabled_sos_args(*, source: str = "sos") -> SimpleNamespace:
        return SimpleNamespace(
            allow_stale_dropbox=True,
            check_only=False,
            dry_run=False,
            env="TEST",
            from_day="2026-09-01",
            history_version="v2",
            repair_pollutants=["pm25"],
            run_backfill=True,
            source=source,
            to_day="2026-09-01",
        )

    @staticmethod
    def _recovery_authority_inputs() -> dict[str, object]:
        writer_runs = [
            {
                "task_key": task_key,
                "latest_finished_run": {
                    "run_id": f"{task_key}:prior",
                    "status": "succeeded",
                    "started_at": "2026-09-28T06:00:00Z",
                    "finished_at": "2026-09-28T06:10:00Z",
                },
                "running_run": None,
            }
            for task_key in (
                "ops.prune_daily",
                "ops.r2_core_snapshot",
                "ops.history_integrity",
            )
        ]
        return {
            "global_operation_lock": {
                "logical_identity": "uk_aq:r2_history:v2:observations_global_operation",
                "run_id": "integrity:TEST:2026-09-29T090000Z",
                "nonce": "original-session",
                "wait_ms": 0,
                "outcome": "held",
            },
            "backup_readiness": {
                "backup_ready": True,
                "backup_run_id": "backup-17",
                "backup_started_at": "2026-09-28T07:00:00Z",
                "backup_finished_at": "2026-09-28T07:30:00Z",
                "writer_runs": writer_runs,
            },
            "dropbox_currentness": {
                "checkpoint_live_root_match": True,
                "checkpoint": {
                    "relative_key": "_ops/checkpoints/root.json",
                    "byte_size": 123,
                    "sha256": "a" * 64,
                    "observations_processed_source_root_hash": "b" * 64,
                },
                "live_observations_root": {
                    "key": "history/v2/observations/_manifests/manifest.json",
                    "content_hash": "b" * 64,
                    "byte_size": 456,
                },
            },
            "core_snapshot_identity": {
                "core_snapshot_day_utc": "2026-09-28",
                "core_snapshot_manifest_key": (
                    "history/v2/core/day_utc=2026-09-28/manifest.json"
                ),
                "core_snapshot_manifest_hash": "c" * 64,
                "core_snapshot_manifest_sha256": "d" * 64,
            },
        }

    @staticmethod
    def _recovery_self_writer() -> dict[str, object]:
        return {
            "daily_task_health_run_id": "health-41",
            "platform_run_id": "TEST:2026-09-29T090000Z",
            "integrity_run_id": 41,
            "environment": "TEST",
            "original_history_integrity_watermark": {
                "latest_finished_run": {
                    "run_id": "history-prior",
                    "status": "Finished",
                    "started_at": "2026-09-28T06:00:00Z",
                    "finished_at": "2026-09-28T06:10:00Z",
                    "failed_at": None,
                    "completed_at": "2026-09-28T06:10:00Z",
                    "summary": {"repair_mode": True},
                },
                "running_run": None,
            },
        }

    @staticmethod
    def _readiness_payload(
        *,
        history_running: dict[str, object] | None = None,
        history_finished: dict[str, object] | None = None,
    ) -> dict[str, object]:
        prior = {
            "run_id": "history-prior",
            "status": "Finished",
            "started_at": "2026-09-28T06:00:00Z",
            "finished_at": "2026-09-28T06:10:00Z",
            "failed_at": None,
            "completed_at": "2026-09-28T06:10:00Z",
            "summary": {"repair_mode": True},
        }
        latest_history = history_finished or prior
        writer_runs = [
            {
                "task_key": "ops.prune_daily",
                "latest_finished_run": {
                    "run_id": "prune-prior",
                    "status": "Finished",
                    "completed_at": "2026-09-28T06:00:00Z",
                },
                "running_run": None,
                "is_running": False,
            },
            {
                "task_key": "ops.r2_core_snapshot",
                "latest_finished_run": {
                    "run_id": "core-prior",
                    "status": "Finished",
                    "completed_at": "2026-09-28T06:05:00Z",
                },
                "running_run": None,
                "is_running": False,
            },
            {
                "task_key": "ops.history_integrity",
                "latest_finished_run": latest_history,
                "running_run": history_running,
                "is_running": history_running is not None,
            },
        ]
        if history_running is not None:
            ready = False
            blocked_reason = "relevant_writer_running"
        elif history_finished is not None:
            ready = False
            blocked_reason = "backup_started_before_latest_writer_finished"
        else:
            ready = True
            blocked_reason = None
        return {
            "ready": ready,
            "blocked_reason": blocked_reason,
            "backup_run_id": "backup-17",
            "backup_started_at": "2026-09-28T07:00:00Z",
            "backup_finished_at": "2026-09-28T07:30:00Z",
            "running_backup_run": None,
            "latest_writer_finished_at": (
                "2026-09-29T09:01:00Z"
                if history_finished is not None
                else "2026-09-28T06:10:00Z"
            ),
            "writer_runs": writer_runs,
        }

    def _check_recovery_readiness(
        self,
        payload: dict[str, object],
        *,
        include_self_context: bool = True,
        recovery_self_writer: dict[str, object] | None = None,
    ) -> dict[str, object]:
        selected_self_writer = (
            recovery_self_writer
            if recovery_self_writer is not None
            else self._recovery_self_writer()
        )
        with mock.patch.object(
            MODULE.urllib.request,
            "urlopen",
            return_value=ReadinessResponse(payload),
        ):
            return MODULE.check_dropbox_backup_ready(
                supabase_url="https://example.supabase.co",
                service_role_key="secret",
                integrity_started_at_utc="2026-09-29T09:00:00Z",
                recovery_self_writer=(
                    selected_self_writer if include_self_context else None
                ),
            )

    def test_fixed_v2_currentness_gate_supports_checkpoint_only(self) -> None:
        completed = SimpleNamespace(
            returncode=0,
            stdout='{"allowed":true}',
            stderr="",
        )
        with (
            mock.patch.object(
                MODULE, "_repo_root_for_integrity_script", return_value=Path("/tmp/repo")
            ),
            mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run,
        ):
            result = MODULE.run_integrity_dropbox_currentness_gate(
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                dropbox_root="/dropbox",
                observations_prefix="history/v2/observations",
                timeseries_binding_backup_mode="individual",
                checkpoint_only=True,
            )

        self.assertTrue(result["allowed"])
        self.assertIn("--checkpoint-only", run.call_args.args[0])

    def test_fixed_v2_sos_backup_gate_ignores_stale_override_only_for_qualifying_route(
        self,
    ) -> None:
        calls: list[tuple[bool, object]] = []

        def observe(**kwargs: object) -> dict[str, object]:
            calls.append((
                bool(kwargs["allow_stale_dropbox"]),
                kwargs.get("recovery_self_writer"),
            ))
            return {"backup_ready": True}

        with (
            mock.patch.object(
                MODULE,
                "resolve_backup_gate_credentials",
                return_value=("https://example.invalid", "secret"),
            ),
            mock.patch.object(
                MODULE, "check_dropbox_backup_ready", side_effect=observe
            ),
        ):
            MODULE.run_scheduled_backup_gate(
                self._write_enabled_sos_args(), "2026-09-01T01:00:00Z"
            )
            MODULE.run_scheduled_backup_gate(
                self._write_enabled_sos_args(source="openaq"),
                "2026-09-01T01:00:00Z",
                recovery_self_writer=self._recovery_self_writer(),
            )

        self.assertEqual(calls, [(False, None), (True, None)])

    def _run_locked_step_zero(
        self,
        root: Path,
        *,
        currentness_results: list[dict[str, object]],
        backup_result: dict[str, object],
        events: list[str],
        stop_after_step_zero: bool = False,
    ) -> tuple[int | None, mock.Mock]:
        def currentness(**kwargs: object) -> dict[str, object]:
            events.append(
                "checkpoint" if kwargs.get("checkpoint_only") is True else "root"
            )
            return currentness_results.pop(0)

        def backup(*_args: object, **_kwargs: object) -> dict[str, object]:
            events.append("writer_order")
            return backup_result

        def preflight(*_args: object, **_kwargs: object) -> dict[str, object]:
            events.append("detect_boundary")
            if stop_after_step_zero:
                raise RuntimeError("stop after fixed-v2 Step 0")
            return {"status": "ok"}

        env = self._base_env(root)
        preflight_mock = mock.Mock(side_effect=preflight)
        started_at = dt.datetime(
            2026, 9, 1, 1, 0, 0, tzinfo=dt.timezone.utc
        )
        inherited_run = {
            "started_at": started_at,
            "started_at_utc": MODULE.fmt_iso(started_at),
            "run_compact": MODULE.fmt_compact(started_at),
            "log_path": str(
                root / "logs" / f"run-{MODULE.fmt_compact(started_at)}.log"
            ),
        }
        patches = (
            mock.patch.object(MODULE, "load_env_or_die", return_value=env),
            mock.patch.object(
                MODULE, "resolve_history_path_configs", return_value=self._history_paths()
            ),
            mock.patch.object(MODULE, "serialize_history_path_configs", return_value={}),
            mock.patch.object(
                MODULE,
                "_resolve_daily_task_health_config",
                return_value={"enabled": False, "strict": False},
            ),
            mock.patch.object(
                MODULE,
                "observations_global_operation_lock_context",
                return_value=self._locked_context(),
            ),
            mock.patch.object(
                MODULE,
                "inherited_integrity_logical_run_context",
                return_value=inherited_run,
            ),
            mock.patch.object(
                MODULE,
                "run_integrity_ingest_boundary_check",
                return_value={"allowed": True, "blockers": []},
            ),
            mock.patch.object(MODULE, "load_backfill_env_file_if_set"),
            mock.patch.object(MODULE, "resolve_r2_history_root", return_value="/dropbox"),
            mock.patch.object(
                MODULE,
                "run_integrity_dropbox_currentness_gate",
                side_effect=currentness,
            ),
            mock.patch.object(MODULE, "run_scheduled_backup_gate", side_effect=backup),
            mock.patch.object(MODULE, "run_preflight_or_die", preflight_mock),
        )
        with mock.patch.dict(MODULE.os.environ, {}, clear=True):
            with patches[0], patches[1], patches[2], patches[3], patches[4], \
                    patches[5], patches[6], patches[7], patches[8], patches[9], \
                    patches[10], patches[11]:
                if stop_after_step_zero:
                    with self.assertRaisesRegex(
                        RuntimeError, "stop after fixed-v2 Step 0"
                    ):
                        MODULE.main([
                            "--env", "TEST",
                            "--source", "sos",
                            "--from-day", "2026-09-01",
                            "--to-day", "2026-09-01",
                            "--run-backfill",
                            "--repair-pollutants", "pm25",
                            "--allow-stale-dropbox",
                        ])
                    return None, preflight_mock
                return MODULE.main([
                    "--env", "TEST",
                    "--source", "sos",
                    "--from-day", "2026-09-01",
                    "--to-day", "2026-09-01",
                    "--run-backfill",
                    "--repair-pollutants", "pm25",
                    "--allow-stale-dropbox",
                ]), preflight_mock

    def test_fixed_v2_step_zero_orders_checkpoint_writer_and_root_before_detect(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            events: list[str] = []
            result, _preflight = self._run_locked_step_zero(
                Path(tmpdir),
                currentness_results=[
                    {"allowed": True, "status": "checkpoint_complete"},
                    {
                        "allowed": True,
                        "status": "current",
                        "checkpoint_live_root_match": True,
                    },
                ],
                backup_result={"backup_ready": True},
                events=events,
                stop_after_step_zero=True,
            )

        self.assertIsNone(result)
        self.assertEqual(
            events,
            ["checkpoint", "writer_order", "root", "detect_boundary"],
        )

    def test_fixed_v2_failed_writer_order_stops_before_root_or_detect(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            events: list[str] = []
            result, preflight = self._run_locked_step_zero(
                Path(tmpdir),
                currentness_results=[
                    {"allowed": True, "status": "checkpoint_complete"},
                ],
                backup_result={
                    "backup_ready": False,
                    "blocked_reason": "backup_started_before_latest_writer_finished",
                },
                events=events,
            )

        self.assertEqual(result, 2)
        self.assertEqual(events, ["checkpoint", "writer_order"])
        preflight.assert_not_called()

    def test_fixed_v2_root_mismatch_stops_after_writer_order_before_detect(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            events: list[str] = []
            result, preflight = self._run_locked_step_zero(
                Path(tmpdir),
                currentness_results=[
                    {"allowed": True, "status": "checkpoint_complete"},
                    {
                        "allowed": False,
                        "status": "blocked_stale_dropbox_checkpoint",
                        "checkpoint_live_root_match": False,
                    },
                ],
                backup_result={"backup_ready": True},
                events=events,
            )

        self.assertEqual(result, 2)
        self.assertEqual(events, ["checkpoint", "writer_order", "root"])
        preflight.assert_not_called()

    def test_501_objects_checkpoint_at_250_500_and_final(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            writes: list[tuple[int, str]] = []
            real_write = MODULE.write_run_state

            def observe(run_state: dict[str, object]) -> Path:
                staging = run_state["sos_light_v2_proposal_staging"]
                writes.append((staging["completed_object_count"], staging["status"]))
                return real_write(run_state)

            with mock.patch.object(MODULE, "write_run_state", side_effect=observe):
                staging = MODULE._SosLightV2ProposalStaging(
                    run_state=state,
                    log=None,
                )
                for index in range(1, 502):
                    self._add_object(state, index)
                    staging.object_completed(phase="fixture")
                staging.complete()

            self.assertEqual(writes, [(250, "in_progress"), (500, "in_progress"), (501, "complete")])
            self.assertFalse(
                state["sos_light_v2_proposal_staging"]["node_apply_launch_permitted"]
            )

    def test_time_checkpoint_occurs_before_250_objects(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            clock = FakeClock()
            with mock.patch.object(MODULE, "write_run_state") as write_state:
                staging = MODULE._SosLightV2ProposalStaging(
                    run_state=state,
                    log=None,
                    monotonic=clock,
                )
                self._add_object(state, 1)
                staging.object_completed(phase="fixture")
                clock.value = 15.0
                self._add_object(state, 2)
                staging.object_completed(phase="fixture")
            write_state.assert_called_once_with(state)
            self.assertEqual(
                state["sos_light_v2_proposal_staging"]["completed_object_count"], 2
            )

    def test_changed_scopes_are_deduplicated_and_materialised_deterministically(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            staging = MODULE._SosLightV2ProposalStaging(
                run_state=state,
                log=None,
            )
            later = {"day_utc": "2026-01-02", "connector_id": 1}
            earlier = {"connector_id": 1, "day_utc": "2026-01-01"}
            staging.record_changed_scope("OBSERVS_CHANGED", later)
            staging.record_changed_scope("OBSERVS_CHANGED", earlier)
            staging.record_changed_scope("OBSERVS_CHANGED", dict(later))
            staging.persist_checkpoint(phase="fixture", final=False)
            self.assertEqual(
                state["changed_scopes"]["OBSERVS_CHANGED"],
                [earlier, later],
            )
            self.assertEqual(
                state["sos_light_v2_proposal_staging"]["changed_scope_count"],
                2,
            )

    def test_progress_is_count_or_time_bounded_not_per_object(self) -> None:
        clock = FakeClock()
        log = mock.Mock(spec=logging.Logger)
        progress = MODULE._BoundedCoordinatorProgress(
            log=log,
            phase="fixture",
            total_objects=501,
            monotonic=clock,
        )
        progress.start()
        for completed in range(1, 502):
            progress.progress(completed)
        progress.complete(501)
        self.assertEqual(log.info.call_count, 4)
        messages = [call.args[1] for call in log.info.call_args_list]
        self.assertIn('"completed_objects":250', messages[1])
        self.assertIn('"completed_objects":500', messages[2])

    def _freeze_one_object(self, state: dict[str, object]) -> str:
        key = "history/v2/observations/day_utc=2026-01-01/manifest.json"
        body_path = Path(state["run_root"]) / "fixture-source.json"
        body_path.parent.mkdir(parents=True, exist_ok=True)
        body_path.write_text('{"manifest_kind":"day"}\n', encoding="utf-8")
        MODULE.stage_overlay_object(
            state,
            object_key=key,
            source_path=body_path,
            stage="day_parent",
            persist=False,
        )
        MODULE.mark_overlay_structurally_validated(state, key, persist=False)
        staging = MODULE._SosLightV2ProposalStaging(run_state=state, log=None)
        staging.completed_events = 1
        staging.complete()
        MODULE._finalise_staged_write_set_provenance(state)
        state["sos_light_v2_proposal_staging"]["final_provenance_status"] = "complete"
        MODULE.write_run_state(state)
        return key

    def test_partial_checkpoint_is_rejected_before_node_launch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            MODULE._SosLightV2ProposalStaging(run_state=state, log=None)
            MODULE.write_run_state(state)
            with (
                mock.patch.object(MODULE, "validate_run_state_core_snapshot_identity"),
                mock.patch.object(MODULE.subprocess, "Popen") as popen,
            ):
                result = MODULE.run_canonical_apply_executor(
                    run_state=state,
                    env={},
                    log=mock.Mock(spec=logging.Logger),
                )
            self.assertEqual(result["reason"], "complete_v2_sos_light_staging_invalid")
            self.assertFalse(result["r2_mutation_possible"])
            popen.assert_not_called()

    def test_persisted_state_equality_rejects_transition_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            key = self._freeze_one_object(state)
            MODULE._require_v2_sos_light_persisted_state_equality(state)
            state["objects"][key]["stage"] = "tampered"
            with self.assertRaisesRegex(ValueError, "checkpoint is stale"):
                MODULE._require_v2_sos_light_persisted_state_equality(state)

    def test_apply_checks_existing_checkpoint_before_any_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            key = self._freeze_one_object(state)
            persisted_stage = state["objects"][key]["stage"]
            state["objects"][key]["stage"] = "tampered-after-final-checkpoint"
            observed_persisted_stage: list[str] = []
            real_require = MODULE._require_v2_sos_light_persisted_state_equality

            def observe_existing_checkpoint(run_state: dict[str, object]) -> None:
                persisted = json.loads(
                    Path(run_state["run_state_path"]).read_text(encoding="utf-8")
                )
                observed_persisted_stage.append(
                    persisted["objects"][key]["stage"]
                )
                real_require(run_state)

            with (
                mock.patch.object(
                    MODULE, "validate_run_state_core_snapshot_identity"
                ),
                mock.patch.object(
                    MODULE,
                    "_require_v2_sos_light_persisted_state_equality",
                    side_effect=observe_existing_checkpoint,
                ),
                mock.patch.object(MODULE.subprocess, "Popen") as popen,
            ):
                result = MODULE.run_canonical_apply_executor(
                    run_state=state,
                    env={},
                    log=mock.Mock(spec=logging.Logger),
                )

            self.assertEqual(observed_persisted_stage, [persisted_stage])
            self.assertEqual(
                result["reason"],
                "v2_sos_light_persisted_state_equality_failed",
            )
            self.assertFalse(result["r2_mutation_possible"])
            popen.assert_not_called()

    def test_python_and_node_transition_fingerprints_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state = self._run_state(Path(tmpdir))
            self._freeze_one_object(state)
            python_fingerprint = MODULE.proposal_transition_state_fingerprint_sha256(state)
            module_url = (
                Path(__file__).resolve().parents[2]
                / "backup_r2/lib/sos_light_v2_coordinator_validation.mjs"
            ).as_uri()
            script = (
                f'import {{ computeCoordinatorTransitionStateFingerprint as compute }} '
                f'from {json.dumps(module_url)}; '
                "let body=''; for await (const chunk of process.stdin) body += chunk; "
                "process.stdout.write(compute(JSON.parse(body)));"
            )
            completed = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                input=json.dumps(state),
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertRegex(python_fingerprint, r"^[a-f0-9]{64}$")
            self.assertEqual(completed.stdout, python_fingerprint)

    def test_successful_python_transition_is_persisted_before_node_launch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            state = self._run_state(root)
            self._freeze_one_object(state)
            observed_at_launch: dict[str, object] = {}
            recovery_state_path = root / "recovery.json"
            recovery_state = {
                "contract_version": MODULE.FIXED_V2_SOS_LIGHT_RECOVERY_CONTRACT,
                "profile": MODULE.FIXED_V2_SOS_LIGHT_RECOVERY_PROFILE,
                "authority_status": "complete",
                "generation": "v2",
                "logical_run": {},
                "r2_mutation_started": False,
                "resume": "permitted",
                "node_apply_launch_permitted": False,
                "r2_mutation_possible": False,
                "recovery": {"outcome": "not_required"},
            }
            MODULE._atomic_write_fixed_v2_recovery_state(
                recovery_state_path, recovery_state
            )
            state["fixed_v2_lock_recovery_state_path"] = str(
                recovery_state_path
            )

            class FakeProcess:
                returncode = 0

                def __init__(self) -> None:
                    self.stdout = io.StringIO('{"applied":true}\n')
                    self.stderr = io.StringIO("")

                def wait(self) -> int:
                    return self.returncode

            def launch(*args: object, **kwargs: object) -> FakeProcess:
                del args, kwargs
                persisted = json.loads(
                    Path(state["run_state_path"]).read_text(encoding="utf-8")
                )
                observed_at_launch.update(persisted)
                recovery_at_launch = MODULE._read_fixed_v2_recovery_state(
                    recovery_state_path
                )
                self.assertTrue(
                    recovery_at_launch["node_apply_launch_permitted"]
                )
                self.assertTrue(recovery_at_launch["r2_mutation_possible"])
                return FakeProcess()

            with (
                mock.patch.object(
                    MODULE, "validate_run_state_core_snapshot_identity"
                ),
                mock.patch.object(MODULE.subprocess, "Popen", side_effect=launch),
            ):
                result = MODULE.run_canonical_apply_executor(
                    run_state=state,
                    env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                    log=mock.Mock(spec=logging.Logger),
                )

            transition = observed_at_launch["proposal_transition_validation"]
            staging = observed_at_launch["sos_light_v2_proposal_staging"]
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(transition["status"], "succeeded")
            self.assertEqual(
                transition["state_fingerprint_contract_version"],
                MODULE.SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
            )
            self.assertRegex(
                transition["state_fingerprint_sha256"], r"^[a-f0-9]{64}$"
            )
            self.assertTrue(transition["node_apply_launch_permitted"])
            self.assertEqual(
                staging["python_transition_validation_status"], "succeeded"
            )
            self.assertEqual(
                staging["persisted_state_equality_status"], "succeeded"
            )
            self.assertTrue(staging["node_apply_launch_permitted"])

    def test_retained_lock_context_reuses_identity_and_stale_context_is_ignored(self) -> None:
        started = dt.datetime(2026, 9, 27, 16, 15, 33, tzinfo=dt.timezone.utc)
        run_compact = MODULE.fmt_compact(started)
        context = MODULE.build_integrity_logical_run_context(
            env_name="TEST",
            started_at_utc=MODULE.fmt_iso(started),
            run_compact=run_compact,
            log_path=Path("/tmp/logs") / f"run-{run_compact}.log",
        )
        self.assertIsNone(MODULE.inherited_integrity_logical_run_context(
            {MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV: json.dumps(context)},
            expected_env_name="TEST",
            expected_log_dir="/tmp/logs",
            global_operation_lock={"valid": False},
        ))
        inherited = MODULE.inherited_integrity_logical_run_context(
            {MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV: json.dumps(context)},
            expected_env_name="TEST",
            expected_log_dir="/tmp/logs",
            global_operation_lock={
                "valid": True,
                "run_id": f"integrity:TEST:{run_compact}",
            },
        )
        self.assertEqual(inherited["run_compact"], run_compact)
        mismatched = dict(context)
        mismatched["log_path"] = "/tmp/logs/run-2026-09-27T161537Z.log"
        with self.assertRaisesRegex(RuntimeError, "identity disagrees"):
            MODULE.inherited_integrity_logical_run_context(
                {
                    MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV:
                        json.dumps(mismatched),
                },
                expected_env_name="TEST",
                expected_log_dir="/tmp/logs",
                global_operation_lock={
                    "valid": True,
                    "run_id": f"integrity:TEST:{run_compact}",
                },
            )

    def test_parent_passes_original_identity_to_retained_lock_child(self) -> None:
        run_compact = "2026-09-27T161533Z"
        with (
            mock.patch.object(MODULE, "_repo_root_for_integrity_script", return_value=Path("/tmp/repo")),
            mock.patch.object(MODULE, "resolve_history_writer_database_url", return_value="postgresql://test"),
            mock.patch.object(MODULE, "close_logging_handlers") as close_handlers,
            mock.patch.object(MODULE.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run,
        ):
            MODULE.run_integrity_under_global_operation_lock(
                argv=["--env", "TEST"],
                args=SimpleNamespace(env="TEST"),
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                run_compact=run_compact,
                started_at_utc="2026-09-27T16:15:33Z",
                log_path=f"/tmp/logs/run-{run_compact}.log",
            )
        close_handlers.assert_called_once_with()
        child_context = json.loads(
            run.call_args.kwargs["env"][MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV]
        )
        self.assertEqual(child_context["run_compact"], run_compact)
        self.assertEqual(
            run.call_args.args[0][run.call_args.args[0].index("--run-id") + 1],
            f"integrity:TEST:{run_compact}",
        )
        self.assertNotIn("--recovery-profile", run.call_args.args[0])

    def test_only_explicit_fixed_v2_route_enables_lock_recovery_profile(self) -> None:
        run_compact = "2026-09-29T090000Z"
        with tempfile.TemporaryDirectory() as tmpdir:
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
                mock.patch.object(MODULE, "close_logging_handlers"),
                mock.patch.object(
                    MODULE.subprocess,
                    "run",
                    return_value=SimpleNamespace(returncode=0),
                ) as run,
            ):
                MODULE.run_integrity_under_global_operation_lock(
                    argv=["--env", "TEST"],
                    args=SimpleNamespace(env="TEST"),
                    env={
                        "UK_AQ_BACKFILL_NODE_BIN": "node",
                        "UK_AQ_HISTORY_INTEGRITY_TMP_DIR": tmpdir,
                    },
                    run_compact=run_compact,
                    started_at_utc="2026-09-29T09:00:00Z",
                    log_path=f"/tmp/logs/run-{run_compact}.log",
                    fixed_v2_recovery_enabled=True,
                )
        command = run.call_args.args[0]
        self.assertEqual(
            command[command.index("--recovery-profile") + 1],
            MODULE.FIXED_V2_SOS_LIGHT_RECOVERY_PROFILE,
        )
        state_path = command[command.index("--recovery-state-json") + 1]
        self.assertEqual(
            run.call_args.kwargs["env"][
                MODULE.FIXED_V2_SOS_LIGHT_RECOVERY_STATE_ENV
            ],
            state_path,
        )

    def test_lock_child_appends_to_parent_log_and_report_identity(self) -> None:
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
            MODULE.close_logging_handlers()
            context = MODULE.build_integrity_logical_run_context(
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
                        MODULE.INTEGRITY_LOGICAL_RUN_CONTEXT_ENV:
                            json.dumps(context),
                    },
                    clear=True,
                ),
                mock.patch.object(MODULE, "load_env_or_die", return_value=env),
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
            self.assertIn(
                f'"run_id": "integrity:TEST:{run_compact}"', combined_log
            )
            self.assertTrue(
                (root / "reports" / f"{run_compact}-summary.json").exists()
            )
            self.assertFalse(
                (root / "reports" / f"{later_compact}-summary.json").exists()
            )

    def test_pre_lock_blocked_run_keeps_one_log_and_report(self) -> None:
        started = dt.datetime(
            2026, 9, 27, 16, 15, 33, tzinfo=dt.timezone.utc
        )
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

    def test_independent_logging_setups_use_fresh_identities(self) -> None:
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

    def test_recovery_authority_accepts_only_the_original_exact_authority(self) -> None:
        args = self._write_enabled_sos_args()
        inputs = self._recovery_authority_inputs()
        original = MODULE._fixed_v2_recovery_authority_projection(
            args=args,
            started_iso="2026-09-29T09:00:00Z",
            run_compact="2026-09-29T090000Z",
            integrity_run_id=41,
            daily_task_health_run_id="health-41",
            platform_run_id="TEST:2026-09-29T090000Z",
            requested_from_day="2026-09-01",
            requested_to_day="2026-09-01",
            **inputs,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "recovery.json"
            MODULE._initialise_fixed_v2_recovery_state(state_path, original)
            recovered_inputs = json.loads(json.dumps(inputs))
            history_writer = next(
                entry
                for entry in recovered_inputs["backup_readiness"]["writer_runs"]
                if entry["task_key"] == "ops.history_integrity"
            )
            history_writer["running_run"] = {
                "run_id": "health-41",
                "platform_run_id": "TEST:2026-09-29T090000Z",
                "status": "running",
            }
            recovered = MODULE._fixed_v2_recovery_authority_projection(
                args=args,
                started_iso="2026-09-29T09:00:00Z",
                run_compact="2026-09-29T090000Z",
                integrity_run_id=41,
                daily_task_health_run_id="health-41",
                platform_run_id="TEST:2026-09-29T090000Z",
                requested_from_day="2026-09-01",
                requested_to_day="2026-09-01",
                **recovered_inputs,
            )
            state = MODULE._revalidate_fixed_v2_recovery_state(
                state_path, recovered
            )
            self.assertEqual(state["resume"], "permitted")
            self.assertEqual(state["recovery"]["outcome"], "resumed")

            mutations = {
                "backup": lambda value: value["backup"].update(
                    {"backup_run_id": "backup-18"}
                ),
                "checkpoint": lambda value: value["checkpoint"].update(
                    {"sha256": "e" * 64}
                ),
                "observations_root": lambda value: value[
                    "observations_roots"
                ].update({
                    "dropbox_content_hash": "f" * 64,
                    "live_r2_content_hash": "f" * 64,
                }),
                "core": lambda value: value["core_snapshot_identity"].update(
                    {"core_snapshot_manifest_sha256": "1" * 64}
                ),
                "writer": lambda value: value["writer_watermarks"][
                    "ops.prune_daily"
                ]["latest_finished_run"].update({"run_id": "prune:different"}),
            }
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    MODULE._initialise_fixed_v2_recovery_state(
                        state_path, original
                    )
                    changed = json.loads(json.dumps(recovered))
                    mutate(changed)
                    with self.assertRaisesRegex(
                        RuntimeError, "authority changed or is uncertain"
                    ):
                        MODULE._revalidate_fixed_v2_recovery_state(
                            state_path, changed
                        )
                    blocked = MODULE._read_fixed_v2_recovery_state(state_path)
                    self.assertEqual(blocked["resume"], "forbidden")
                    self.assertEqual(
                        blocked["recovery"]["outcome"],
                        "blocked_authority_changed",
                    )

    def test_recovery_readiness_ignores_only_exact_running_self(self) -> None:
        own_running = {
            "run_id": "health-41",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "platform_run_id": "TEST:2026-09-29T090000Z",
                "repair_mode": True,
            },
        }
        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=own_running)
        )
        self.assertTrue(result["backup_ready"])
        self.assertIsNone(result["blocked_reason"])
        self.assertEqual(
            result["recovery_self_writer_evidence"]["running_run"]["run_id"],
            "health-41",
        )
        history = next(
            writer for writer in result["writer_runs"]
            if writer["task_key"] == "ops.history_integrity"
        )
        self.assertFalse(history["is_running"])
        self.assertIsNone(history["running_run"])
        watermarks = MODULE._fixed_v2_writer_watermarks(
            result,
            daily_task_health_run_id="health-41",
            platform_run_id="TEST:2026-09-29T090000Z",
        )
        self.assertEqual(
            watermarks["ops.history_integrity"],
            self._recovery_self_writer()[
                "original_history_integrity_watermark"
            ],
        )

    def test_recovery_readiness_matches_self_by_summary_platform_id(self) -> None:
        recovery_self_writer = self._recovery_self_writer()
        recovery_self_writer["daily_task_health_run_id"] = None
        own_running = {
            "run_id": "health-rpc-row",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "platform_run_id": "TEST:2026-09-29T090000Z",
                "repair_mode": True,
            },
        }

        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=own_running),
            recovery_self_writer=recovery_self_writer,
        )

        self.assertTrue(result["backup_ready"])
        self.assertIsNone(result["blocked_reason"])
        self.assertEqual(
            result["recovery_self_writer_evidence"]["running_run"]["run_id"],
            "health-rpc-row",
        )
        history = next(
            writer for writer in result["writer_runs"]
            if writer["task_key"] == "ops.history_integrity"
        )
        self.assertFalse(history["is_running"])
        self.assertIsNone(history["running_run"])

    def test_recovery_readiness_rejects_summary_platform_id_mismatch(
        self,
    ) -> None:
        recovery_self_writer = self._recovery_self_writer()
        recovery_self_writer["daily_task_health_run_id"] = None
        different_running = {
            "run_id": "health-rpc-row",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "platform_run_id": "TEST:2026-09-29T090001Z",
                "repair_mode": True,
            },
        }

        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=different_running),
            recovery_self_writer=recovery_self_writer,
        )

        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "relevant_writer_running")

    def test_recovery_readiness_falls_back_to_integrity_id_and_environment(
        self,
    ) -> None:
        recovery_self_writer = self._recovery_self_writer()
        recovery_self_writer["daily_task_health_run_id"] = None
        recovery_self_writer["platform_run_id"] = ""
        own_running = {
            "run_id": "health-rpc-row",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "repair_mode": True,
            },
        }

        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=own_running),
            recovery_self_writer=recovery_self_writer,
        )

        self.assertTrue(result["backup_ready"])
        self.assertIsNone(result["blocked_reason"])
        self.assertEqual(
            result["recovery_self_writer_evidence"]["running_run"]["run_id"],
            "health-rpc-row",
        )

    def test_recovery_readiness_rejects_integrity_id_from_different_environment(
        self,
    ) -> None:
        recovery_self_writer = self._recovery_self_writer()
        recovery_self_writer["daily_task_health_run_id"] = None
        recovery_self_writer["platform_run_id"] = ""
        different_running = {
            "run_id": "health-rpc-row",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "LIVE",
                "integrity_run_id": 41,
                "repair_mode": True,
            },
        }

        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=different_running),
            recovery_self_writer=recovery_self_writer,
        )

        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "relevant_writer_running")

    def test_recovery_readiness_blocks_different_running_integrity(self) -> None:
        different_running = {
            "run_id": "health-99",
            "status": "Started",
            "started_at": "2026-09-29T09:00:30Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "platform_run_id": "TEST:2026-09-29T090000Z",
                "repair_mode": True,
            },
        }
        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=different_running)
        )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "relevant_writer_running")

    def test_recovery_readiness_attributes_finished_or_failed_self(self) -> None:
        for status, timestamp_field in (
            ("Finished", "finished_at"),
            ("Failed", "failed_at"),
        ):
            with self.subTest(status=status):
                own_finished = {
                    "run_id": "health-41",
                    "status": status,
                    "started_at": "2026-09-29T09:00:00Z",
                    "finished_at": None,
                    "failed_at": None,
                    "completed_at": "2026-09-29T09:01:00Z",
                    "summary": {
                        "env": "TEST",
                        "integrity_run_id": 41,
                        "platform_run_id": "TEST:2026-09-29T090000Z",
                        "repair_mode": True,
                    },
                }
                own_finished[timestamp_field] = "2026-09-29T09:01:00Z"
                result = self._check_recovery_readiness(
                    self._readiness_payload(history_finished=own_finished)
                )
                self.assertTrue(result["backup_ready"])
                self.assertEqual(
                    result["latest_writer_finished_at"],
                    "2026-09-28T06:10:00Z",
                )
                self.assertEqual(
                    result["recovery_self_writer_evidence"][
                        "latest_finished_run"
                    ]["status"],
                    status,
                )
                history = next(
                    writer for writer in result["writer_runs"]
                    if writer["task_key"] == "ops.history_integrity"
                )
                self.assertEqual(
                    history["latest_finished_run"]["run_id"],
                    "history-prior",
                )
                watermarks = MODULE._fixed_v2_writer_watermarks(
                    result,
                    daily_task_health_run_id="health-41",
                    platform_run_id="TEST:2026-09-29T090000Z",
                )
                self.assertEqual(
                    watermarks["ops.history_integrity"],
                    self._recovery_self_writer()[
                        "original_history_integrity_watermark"
                    ],
                )

    def test_recovery_readiness_blocks_different_finished_or_failed_integrity(
        self,
    ) -> None:
        for status, timestamp_field in (
            ("Finished", "finished_at"),
            ("Failed", "failed_at"),
        ):
            with self.subTest(status=status):
                different_finished = {
                    "run_id": "health-99",
                    "status": status,
                    "started_at": "2026-09-29T09:00:10Z",
                    "finished_at": None,
                    "failed_at": None,
                    "completed_at": "2026-09-29T09:01:00Z",
                    "summary": {
                        "env": "TEST",
                        "integrity_run_id": 41,
                        "platform_run_id": "TEST:2026-09-29T090000Z",
                        "repair_mode": True,
                    },
                }
                different_finished[timestamp_field] = (
                    "2026-09-29T09:01:00Z"
                )
                result = self._check_recovery_readiness(
                    self._readiness_payload(
                        history_finished=different_finished
                    )
                )
                self.assertFalse(result["backup_ready"])
                self.assertEqual(
                    result["blocked_reason"],
                    "backup_started_before_latest_writer_finished",
                )

    def test_generic_readiness_still_blocks_running_integrity(self) -> None:
        own_running = {
            "run_id": "health-41",
            "status": "Started",
            "started_at": "2026-09-29T09:00:00Z",
            "summary": {
                "env": "TEST",
                "integrity_run_id": 41,
                "platform_run_id": "TEST:2026-09-29T090000Z",
                "repair_mode": True,
            },
        }
        result = self._check_recovery_readiness(
            self._readiness_payload(history_running=own_running),
            include_self_context=False,
        )
        self.assertFalse(result["backup_ready"])
        self.assertEqual(result["blocked_reason"], "relevant_writer_running")

    def test_recovery_writer_ordering_uses_original_run_start_time(self) -> None:
        args = self._write_enabled_sos_args()
        recovery_self_writer = self._recovery_self_writer()
        with mock.patch.object(
            MODULE,
            "check_dropbox_backup_ready",
            return_value={"backup_ready": True},
        ) as readiness:
            MODULE.run_scheduled_backup_gate(
                args,
                "2026-09-29T09:00:00Z",
                recovery_self_writer=recovery_self_writer,
            )
        self.assertEqual(
            readiness.call_args.kwargs["integrity_started_at_utc"],
            "2026-09-29T09:00:00Z",
        )
        self.assertFalse(readiness.call_args.kwargs["allow_stale_dropbox"])
        self.assertEqual(
            readiness.call_args.kwargs["recovery_self_writer"],
            recovery_self_writer,
        )

    def test_node_apply_permission_requires_resolved_recovery_authority(self) -> None:
        inputs = self._recovery_authority_inputs()
        original = MODULE._fixed_v2_recovery_authority_projection(
            args=self._write_enabled_sos_args(),
            started_iso="2026-09-29T09:00:00Z",
            run_compact="2026-09-29T090000Z",
            integrity_run_id=41,
            daily_task_health_run_id="health-41",
            platform_run_id="TEST:2026-09-29T090000Z",
            requested_from_day="2026-09-01",
            requested_to_day="2026-09-01",
            **inputs,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = Path(tmpdir) / "recovery.json"
            MODULE._initialise_fixed_v2_recovery_state(state_path, original)
            permitted = MODULE._permit_fixed_v2_node_apply_launch(state_path)
            self.assertTrue(permitted["node_apply_launch_permitted"])
            self.assertTrue(permitted["r2_mutation_possible"])

            permitted["resume"] = "unresolved"
            permitted["node_apply_launch_permitted"] = False
            permitted["r2_mutation_possible"] = False
            MODULE._atomic_write_fixed_v2_recovery_state(
                state_path, permitted
            )
            with self.assertRaisesRegex(RuntimeError, "does not permit"):
                MODULE._permit_fixed_v2_node_apply_launch(state_path)


if __name__ == "__main__":
    unittest.main()
