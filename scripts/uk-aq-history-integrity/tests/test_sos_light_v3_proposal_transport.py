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

    def test_coordinator_authenticates_artifact_and_stages_exact_body(self) -> None:
        envelope, artifact_path = self._artifact()
        output, audit = MODULE._load_authenticated_v3_proposal_result(
            run_state=self.run_state,
            envelope=envelope,
            expected_result_path=artifact_path,
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
        transition = MODULE.validate_proposal_run_state_transition(self.run_state)
        self.assertEqual(transition["status"], "succeeded")

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
