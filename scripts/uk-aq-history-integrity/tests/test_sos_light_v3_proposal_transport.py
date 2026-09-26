from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "bin"
    / "uk-aq-history-integrity-sos-light-v3.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_sos_light_v3_transport", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakePlannerProcess:
    def __init__(self, *, stdout: str, stderr: str = "", returncode: int = 0) -> None:
        self.stdin = io.StringIO()
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.returncode = returncode

    def wait(self) -> int:
        return self.returncode


class FixedV3ProposalTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dropbox = self.root / "dropbox"
        self.dropbox.mkdir()
        self.run_state = MODULE.create_run_overlay(
            tmp_dir=self.root,
            run_id="transport-test",
            environment="TEST",
            base_dropbox_root=self.dropbox,
        )
        self.key = "history/_index_v3/transport-test.json"
        self.body = b'{"transport":"exact"}\n'
        self.body_path = Path(self.run_state["overlay_root"]) / self.key
        self.body_path.parent.mkdir(parents=True, exist_ok=True)
        self.body_path.write_bytes(self.body)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _proposal(self, *, relative_path: str | None = None) -> dict[str, object]:
        digest = hashlib.sha256(self.body).hexdigest()
        return {
            "key": self.key,
            "kind": "observation_history_index_v3_exact_leaf",
            "publication_stage": "child_shard",
            "bytes": len(self.body),
            "new_sha256": digest,
            "changed": True,
            "included_in_write_set": True,
            "status": "planned",
            "dependencies": [],
            "dependency_identities": {},
            "body_ref": {
                "contract_version": MODULE.SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
                "source": "planned_overlay",
                "relative_path": relative_path or self.key,
                "sha256": digest,
                "bytes": len(self.body),
            },
        }

    def _artifact(self) -> tuple[dict[str, object], Path]:
        output = {
            "ok": True,
            "planning": {
                "proposals": [self._proposal()],
                "proposal_transport": {
                    "representation_mode":
                        "compact_graph_with_run_local_overlay_body_refs",
                    "body_reference_contract_version":
                        MODULE.SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
                    "proposal_count": 1,
                    "file_backed_body_count": 1,
                    "file_backed_body_total_bytes": len(self.body),
                    "file_backed_changed_body_count": 1,
                    "file_backed_changed_body_total_bytes": len(self.body),
                },
            },
        }
        artifact = {
            "contract_version": MODULE.SOS_LIGHT_V3_PROPOSAL_ARTIFACT_CONTRACT,
            "kind": "uk_aq_sos_light_v3_compact_proposal",
            "output": output,
        }
        artifact_path = (
            Path(self.run_state["run_root"])
            / "proposal-results"
            / "fixed-v3-observation-metadata.json"
        )
        artifact_path.parent.mkdir(parents=True)
        artifact_path.write_text(
            json.dumps(artifact, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        artifact_sha256, artifact_bytes = MODULE._file_sha256_and_bytes(
            artifact_path
        )
        envelope = {
            "schema_version": 1,
            "kind": "uk_aq_sos_light_v3_proposal_transport_envelope",
            "transport_contract_version":
                MODULE.SOS_LIGHT_V3_PROPOSAL_TRANSPORT_CONTRACT,
            "transport_mode": "file_backed_compact_proposal",
            "status": "planned",
            "proposal_artifact": {
                "relative_path": str(
                    artifact_path.relative_to(Path(self.run_state["run_root"]))
                ),
                "sha256": artifact_sha256,
                "bytes": artifact_bytes,
                "contract_version":
                    MODULE.SOS_LIGHT_V3_PROPOSAL_ARTIFACT_CONTRACT,
            },
            "proposal_count": 1,
            "file_backed_changed_body_count": 1,
            "file_backed_changed_body_total_bytes": len(self.body),
        }
        return envelope, artifact_path

    def _bulk_executor(self, count: int) -> dict[str, object]:
        proposals: list[dict[str, object]] = []
        total_bytes = 0
        for index in range(count):
            key = f"history/_index_v3/bulk/{index:05d}.json"
            body = json.dumps(
                {"index": index}, separators=(",", ":"),
            ).encode("utf-8") + b"\n"
            body_path = Path(self.run_state["overlay_root"]) / key
            body_path.parent.mkdir(parents=True, exist_ok=True)
            body_path.write_bytes(body)
            digest = hashlib.sha256(body).hexdigest()
            total_bytes += len(body)
            proposals.append({
                "key": key,
                "kind": "observation_history_index_v3_exact_leaf",
                "publication_stage": "child_shard",
                "bytes": len(body),
                "new_sha256": digest,
                "changed": True,
                "included_in_write_set": True,
                "status": "planned",
                "dependencies": [],
                "dependency_identities": {},
                "body_ref": {
                    "contract_version":
                        MODULE.SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
                    "source": "planned_overlay",
                    "relative_path": key,
                    "sha256": digest,
                    "bytes": len(body),
                },
            })
        return {
            "output": {
                "ok": True,
                "planning": {
                    "proposals": proposals,
                    "blocked_scopes": [],
                },
            },
            "transport": {
                "status": "authenticated",
                "transport_mode": "file_backed_compact_proposal",
                "file_backed_changed_body_count": count,
                "file_backed_changed_body_total_bytes": total_bytes,
            },
        }

    def test_coordinator_authenticates_artifact_and_stages_exact_body(self) -> None:
        envelope, artifact_path = self._artifact()
        logger = mock.Mock(spec=logging.Logger)
        output, audit = MODULE._load_authenticated_v3_proposal_result(
            run_state=self.run_state,
            envelope=envelope,
            expected_result_path=artifact_path,
            log=logger,
        )
        self.assertEqual(audit["status"], "authenticated")
        self.assertNotIn("proposed_body", output["planning"]["proposals"][0])
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result={"output": output, "transport": audit},
            dry_run=False,
            require_file_backed_bodies=True,
        )
        entry = self.run_state["objects"][self.key]
        self.assertEqual(Path(entry["local_path"]).read_bytes(), self.body)
        self.assertEqual(entry["sha256"], hashlib.sha256(self.body).hexdigest())
        self.assertEqual(entry["body_reference_source"], "planned_overlay")
        transition = MODULE.validate_proposal_run_state_transition(
            self.run_state,
            log=logger,
        )
        self.assertEqual(transition["status"], "succeeded")
        phases = [
            json.loads(call.args[1])["phase"]
            for call in logger.info.call_args_list
        ]
        self.assertIn("proposal_artifact_authentication_started", phases)
        self.assertIn("proposal_artifact_authentication_complete", phases)
        self.assertIn("proposal_transition_validation_started", phases)
        self.assertIn("proposal_transition_validation_complete", phases)

    def test_tampered_missing_and_outside_bodies_fail_before_acceptance(self) -> None:
        envelope, artifact_path = self._artifact()
        self.body_path.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "staged body identity"):
            MODULE._load_authenticated_v3_proposal_result(
                run_state=self.run_state,
                envelope=envelope,
                expected_result_path=artifact_path,
            )
        self.body_path.unlink()
        with self.assertRaisesRegex(ValueError, "missing or unsafe"):
            MODULE._load_authenticated_v3_proposal_result(
                run_state=self.run_state,
                envelope=envelope,
                expected_result_path=artifact_path,
            )
        outside = self.root / "outside.json"
        outside.write_bytes(self.body)
        with self.assertRaises(ValueError):
            MODULE._resolve_v3_proposal_body_reference(
                run_state=self.run_state,
                proposal=self._proposal(relative_path="../outside.json"),
                object_key=self.key,
            )

    def test_tampered_proposal_artifact_is_rejected(self) -> None:
        envelope, artifact_path = self._artifact()
        artifact_path.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "artifact identity"):
            MODULE._load_authenticated_v3_proposal_result(
                run_state=self.run_state,
                envelope=envelope,
                expected_result_path=artifact_path,
            )

    def test_bulk_staging_uses_bounded_consistent_checkpoints(self) -> None:
        executor = self._bulk_executor(501)
        self.run_state["changed_scopes"]["OBS_INDEXES_CHANGED"] = [{
            "object_key": "history/_index_v3/bulk/00000.json",
            "stage": "child_shard",
            "provenance": "repair_generated",
        }]
        real_write = MODULE.write_run_state
        persisted_snapshots: list[dict[str, object]] = []
        logger = mock.Mock(spec=logging.Logger)

        def capture_write(state: dict[str, object]) -> Path:
            result = real_write(state)
            persisted_snapshots.append(json.loads(result.read_text()))
            return result

        with mock.patch.object(
            MODULE, "write_run_state", side_effect=capture_write,
        ) as write_state:
            MODULE._record_metadata_executor_overlay(
                run_state=self.run_state,
                executor_result=executor,
                dry_run=False,
                require_file_backed_bodies=True,
                log=logger,
            )

        self.assertEqual(write_state.call_count, 3)
        self.assertEqual(
            [
                snapshot["proposal_ingestion"]["completed_object_count"]
                for snapshot in persisted_snapshots
            ],
            [250, 500, 501],
        )
        self.assertEqual(
            [
                snapshot["proposal_ingestion"]["status"]
                for snapshot in persisted_snapshots
            ],
            ["in_progress", "in_progress", "complete"],
        )
        for snapshot in persisted_snapshots:
            for entry in snapshot["objects"].values():
                self.assertTrue(entry["structurally_validated"])
                self.assertRegex(entry["sha256"], r"^[a-f0-9]{64}$")
                self.assertIsInstance(entry["bytes"], int)
                self.assertEqual(entry["dependencies"], [])
                self.assertEqual(entry["dependency_identities"], {})
        scopes = self.run_state["changed_scopes"]["OBS_INDEXES_CHANGED"]
        self.assertEqual(len(scopes), 501)
        self.assertEqual(
            scopes,
            sorted(
                scopes,
                key=lambda value: json.dumps(
                    value, sort_keys=True, separators=(",", ":"),
                ),
            ),
        )
        phases = [
            json.loads(call.args[1])["phase"]
            for call in logger.info.call_args_list
        ]
        self.assertEqual(phases.count("proposal_overlay_staging_started"), 1)
        self.assertEqual(phases.count("proposal_overlay_staging_progress"), 3)
        self.assertEqual(phases.count("proposal_overlay_staging_complete"), 1)
        self.assertEqual(
            phases.count("proposal_run_state_checkpoint_started"), 3,
        )
        self.assertEqual(
            phases.count("proposal_run_state_checkpoint_complete"), 3,
        )

    def test_failed_bulk_batch_leaves_only_non_apply_checkpoint(self) -> None:
        executor = self._bulk_executor(251)
        missing_key = "history/_index_v3/bulk/00250.json"
        (Path(self.run_state["overlay_root"]) / missing_key).unlink()

        with self.assertRaisesRegex(ValueError, "missing or unsafe"):
            MODULE._record_metadata_executor_overlay(
                run_state=self.run_state,
                executor_result=executor,
                dry_run=False,
                require_file_backed_bodies=True,
            )

        persisted = json.loads(
            Path(self.run_state["run_state_path"]).read_text()
        )
        self.assertEqual(len(persisted["objects"]), 250)
        self.assertEqual(
            persisted["proposal_ingestion"]["status"], "in_progress",
        )
        self.assertFalse(
            persisted["proposal_ingestion"]["node_apply_launch_permitted"],
        )
        self.assertNotIn("proposal_transition_validation", persisted)
        with self.assertRaisesRegex(ValueError, "complete fail-closed"):
            MODULE._require_complete_persisted_file_backed_proposal(persisted)

    def test_bulk_and_original_staging_have_same_semantic_object_graph(self) -> None:
        bulk_executor = self._bulk_executor(3)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=bulk_executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        with tempfile.TemporaryDirectory() as comparison_dir:
            comparison_root = Path(comparison_dir)
            comparison_dropbox = comparison_root / "dropbox"
            comparison_dropbox.mkdir()
            comparison_state = MODULE.create_run_overlay(
                tmp_dir=comparison_root,
                run_id="comparison",
                environment="TEST",
                base_dropbox_root=comparison_dropbox,
            )
            inline_proposals = []
            for proposal in bulk_executor["output"]["planning"]["proposals"]:
                inline = dict(proposal)
                inline.pop("body_ref")
                inline["proposed_body"] = (
                    Path(self.run_state["overlay_root"])
                    .joinpath(str(proposal["key"]))
                    .read_text()
                )
                inline_proposals.append(inline)
            MODULE._record_metadata_executor_overlay(
                run_state=comparison_state,
                executor_result={
                    "output": {"planning": {"proposals": inline_proposals}},
                },
                dry_run=False,
            )

        semantic_fields = {
            "object_key", "sha256", "bytes", "stage", "dependencies",
            "dependency_identities", "proposed", "built",
            "structurally_validated", "changed", "included_in_write_set",
            "status", "planner_changed", "planner_status",
            "planner_included_in_write_set", "planner_dependencies",
            "planner_dependency_identities",
        }
        self.assertEqual(
            {
                key: {
                    field: value
                    for field, value in entry.items()
                    if field in semantic_fields
                }
                for key, entry in self.run_state["objects"].items()
            },
            {
                key: {
                    field: value
                    for field, value in entry.items()
                    if field in semantic_fields
                }
                for key, entry in comparison_state["objects"].items()
            },
        )
        self.assertEqual(
            self.run_state["changed_scopes"],
            comparison_state["changed_scopes"],
        )

    def test_complete_file_backed_state_must_be_finalised_and_persisted(self) -> None:
        executor = self._bulk_executor(1)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        with self.assertRaisesRegex(ValueError, "not finalised"):
            MODULE._require_complete_persisted_file_backed_proposal(
                self.run_state
            )

    def test_apply_launch_requires_and_persists_final_validation(self) -> None:
        executor = self._bulk_executor(1)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        logger = mock.Mock(spec=logging.Logger)
        with (
            mock.patch.object(
                MODULE, "validate_run_state_core_snapshot_identity",
            ),
            mock.patch.object(MODULE.subprocess, "Popen") as popen,
        ):
            blocked = MODULE.run_canonical_apply_executor(
                run_state=self.run_state,
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                log=logger,
            )
        self.assertEqual(
            blocked["reason"], "complete_final_run_state_checkpoint_invalid",
        )
        popen.assert_not_called()

        self.run_state.pop("proposal_transition_validation")
        MODULE._finalise_staged_write_set_provenance(self.run_state)
        MODULE.write_run_state(self.run_state)
        process = FakePlannerProcess(stdout='{"ok":true}\n')

        def validate_transition(
            state: dict[str, object], *, log: logging.Logger | None = None,
        ) -> dict[str, object]:
            del log
            persisted = json.loads(
                Path(state["run_state_path"]).read_text()
            )
            self.assertEqual(
                persisted["final_staged_write_set_provenance"]["status"],
                "finalised",
            )
            self.assertNotIn("proposal_transition_validation", persisted)
            return {
                "status": "succeeded",
                "node_apply_launch_permitted": True,
            }

        with (
            mock.patch.object(
                MODULE, "validate_run_state_core_snapshot_identity",
            ),
            mock.patch.object(
                MODULE,
                "validate_proposal_run_state_transition",
                side_effect=validate_transition,
            ),
            mock.patch.object(
                MODULE,
                "_repo_root_for_integrity_script",
                return_value=self.root,
            ),
            mock.patch.object(
                MODULE.subprocess, "Popen", return_value=process,
            ) as popen,
        ):
            applied = MODULE.run_canonical_apply_executor(
                run_state=self.run_state,
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                log=logger,
            )
        self.assertEqual(applied["status"], "succeeded")
        popen.assert_called_once()
        persisted = json.loads(
            Path(self.run_state["run_state_path"]).read_text()
        )
        self.assertEqual(
            persisted["proposal_transition_validation"]["status"],
            "succeeded",
        )
        self.assertTrue(
            persisted["proposal_transition_validation"][
                "node_apply_launch_permitted"
            ]
        )
        self.assertEqual(
            persisted["proposal_transition_validation"][
                "state_fingerprint_contract_version"
            ],
            MODULE.SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
        )
        self.assertEqual(
            persisted["proposal_transition_validation"][
                "state_fingerprint_sha256"
            ],
            MODULE.proposal_transition_state_fingerprint_sha256(persisted),
        )
        MODULE._finalise_staged_write_set_provenance(self.run_state)
        MODULE.write_run_state(self.run_state)
        MODULE._require_complete_persisted_file_backed_proposal(self.run_state)
        self.run_state["objects"][
            "history/_index_v3/bulk/00000.json"
        ]["status"] = "mutated_after_checkpoint"
        with self.assertRaisesRegex(ValueError, "checkpoint is stale"):
            MODULE._require_complete_persisted_file_backed_proposal(
                self.run_state
            )

    def test_python_and_node_transition_fingerprints_match(self) -> None:
        executor = self._bulk_executor(2)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        child_key = "history/_index_v3/bulk/00000.json"
        parent_key = "history/_index_v3/bulk/00001.json"
        child = self.run_state["objects"][child_key]
        identity = {
            "sha256": child["sha256"],
            "bytes": child["bytes"],
            "source": "planned_overlay",
        }
        parent = self.run_state["objects"][parent_key]
        parent["dependencies"] = [child_key]
        parent["dependency_identities"] = {child_key: identity}
        parent["planner_dependencies"] = [child_key]
        parent["planner_dependency_identities"] = {child_key: identity}
        self.run_state["tombstone_prefixes"] = [{
            "prefix": "history/v3/observations/day_utc=2025-01-01",
            "proposed": True,
        }]
        MODULE._finalise_staged_write_set_provenance(self.run_state)
        MODULE.write_run_state(self.run_state)
        transition = MODULE.validate_proposal_run_state_transition(
            self.run_state
        )
        self.assertEqual(transition["status"], "succeeded")
        python_fingerprint = (
            MODULE.proposal_transition_state_fingerprint_sha256(self.run_state)
        )
        validation_module = (
            Path(__file__).resolve().parents[3]
            / "scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs"
        ).as_uri()
        result = MODULE.subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                (
                    "import fs from 'node:fs';"
                    f"import {{computeCoordinatorTransitionStateFingerprint}} from {json.dumps(validation_module)};"
                    "const state=JSON.parse(fs.readFileSync("
                    f"{json.dumps(self.run_state['run_state_path'])},'utf8'));"
                    "process.stdout.write(computeCoordinatorTransitionStateFingerprint(state));"
                ),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout, python_fingerprint)

    def test_progress_throttles_by_count_and_elapsed_time(self) -> None:
        logger = mock.Mock(spec=logging.Logger)
        with mock.patch.object(MODULE.time, "monotonic", return_value=0.0) as clock:
            progress = MODULE._BoundedCoordinatorProgress(
                log=logger,
                phase="bounded_test",
                total_objects=500,
            )
            progress.start()
            self.assertFalse(progress.progress(249))
            self.assertTrue(progress.progress(250))
            clock.return_value = 16.0
            self.assertTrue(progress.progress(251))
            progress.complete(251)
        phases = [
            json.loads(call.args[1])["phase"]
            for call in logger.info.call_args_list
        ]
        self.assertEqual(phases, [
            "bounded_test_started",
            "bounded_test_progress",
            "bounded_test_progress",
            "bounded_test_complete",
        ])

    def test_bulk_checkpoint_time_limit_triggers_before_250_objects(self) -> None:
        executor = self._bulk_executor(2)
        clock = [0.0]
        real_resolve = MODULE._resolve_v3_proposal_body_reference
        resolve_count = 0

        def resolve_then_advance(**kwargs: object) -> tuple[Path, str, int]:
            nonlocal resolve_count
            resolved = real_resolve(**kwargs)
            resolve_count += 1
            if resolve_count == 1:
                clock[0] = 16.0
            return resolved

        real_write = MODULE.write_run_state
        snapshots: list[dict[str, object]] = []

        def capture_write(state: dict[str, object]) -> Path:
            result = real_write(state)
            snapshots.append(json.loads(result.read_text()))
            return result

        with (
            mock.patch.object(
                MODULE.time, "monotonic", side_effect=lambda: clock[0],
            ),
            mock.patch.object(
                MODULE,
                "_resolve_v3_proposal_body_reference",
                side_effect=resolve_then_advance,
            ),
            mock.patch.object(
                MODULE, "write_run_state", side_effect=capture_write,
            ),
        ):
            MODULE._record_metadata_executor_overlay(
                run_state=self.run_state,
                executor_result=executor,
                dry_run=False,
                require_file_backed_bodies=True,
            )
        self.assertEqual(
            [
                snapshot["proposal_ingestion"]["completed_object_count"]
                for snapshot in snapshots
            ],
            [1, 2],
        )

    def test_v3_wrapper_accepts_a_small_authenticated_control_envelope(self) -> None:
        envelope, _ = self._artifact()
        encoded_envelope = json.dumps(envelope, separators=(",", ":")) + "\n"
        self.assertLess(len(encoded_envelope.encode("utf-8")), 64 * 1024)
        process = FakePlannerProcess(stdout=encoded_envelope)
        with (
            mock.patch.object(
                MODULE,
                "_repo_root_for_integrity_script",
                return_value=self.root,
            ),
            mock.patch.object(
                MODULE,
                "_authoritative_v2_core_timeseries_bindings",
                return_value=[],
            ),
            mock.patch.object(MODULE.subprocess, "Popen", return_value=process),
        ):
            result = MODULE._run_v3_observation_metadata_proposal(
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                actions=[{"day_utc": "2025-01-01"}],
                dry_run=False,
                log=logging.getLogger("test.v3.transport.small"),
                run_state=self.run_state,
            )
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["transport"]["status"], "authenticated")
        self.assertEqual(result["output"]["ok"], True)

    def test_v3_wrapper_rejects_oversized_stdout_before_artifact_acceptance(self) -> None:
        process = FakePlannerProcess(stdout="x" * (64 * 1024 + 1))
        with (
            mock.patch.object(
                MODULE,
                "_repo_root_for_integrity_script",
                return_value=self.root,
            ),
            mock.patch.object(
                MODULE,
                "_authoritative_v2_core_timeseries_bindings",
                return_value=[],
            ),
            mock.patch.object(MODULE.subprocess, "Popen", return_value=process),
            mock.patch.object(
                MODULE,
                "_load_authenticated_v3_proposal_result",
            ) as authenticate,
        ):
            result = MODULE._run_v3_observation_metadata_proposal(
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                actions=[{"day_utc": "2025-01-01"}],
                dry_run=False,
                log=logging.getLogger("test.v3.transport.oversized"),
                run_state=self.run_state,
            )
        self.assertEqual(result["status"], "failed")
        self.assertIn(
            "fixed-v3 proposal control envelope exceeded 64 KiB",
            result["error"],
        )
        self.assertEqual(result["output"], {})
        authenticate.assert_not_called()

    def test_v2_wrapper_retains_ordinary_unbounded_stdout_drain(self) -> None:
        padding = "x" * (64 * 1024 + 1)
        process = FakePlannerProcess(stdout=json.dumps({
            "status": "planned",
            "results": [],
            "padding": padding,
        }))
        with (
            mock.patch.object(
                MODULE,
                "_repo_root_for_integrity_script",
                return_value=self.root,
            ),
            mock.patch.object(
                MODULE,
                "_authoritative_v2_core_timeseries_bindings",
                return_value=[],
            ),
            mock.patch.object(MODULE.subprocess, "Popen", return_value=process),
        ):
            result = MODULE._run_v2_observation_metadata_executor(
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                actions=[{"day_utc": "2025-01-01"}],
                dry_run=False,
                log=logging.getLogger("test.v2.transport.original"),
            )
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["output"]["padding"], padding)


if __name__ == "__main__":
    unittest.main()
