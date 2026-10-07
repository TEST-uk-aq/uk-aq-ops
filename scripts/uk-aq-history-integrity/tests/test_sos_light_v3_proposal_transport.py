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
        self.run_state["execution_path"] = "sos_light"
        self.run_state["sos_light"] = {
            "mode": "sos-light",
            "days": [{
                "day_utc": "2025-01-01",
                "pinned_day_manifest_present": True,
                "pinned_day_manifest_key": (
                    "history/v3/observations/day_utc=2025-01-01/manifest.json"
                ),
                "pinned_day_manifest_hash": "a" * 64,
                "pinned_baseline_connector_ids": [1],
                "expected_preserved_connector_ids": [],
                "expected_final_connector_ids": [1],
                "final_assembled_connector_ids": [1],
                "authoritative_observation_object_keys": [
                    "history/v3/observations/day_utc=2025-01-01/"
                    "connector_id=1/manifest.json",
                    "history/v3/observations/day_utc=2025-01-01/manifest.json",
                ],
            }],
        }
        self.key = "history/_index_v3/transport-test.json"
        self.body = b'{"transport":"exact"}\n'
        self.body_path = Path(self.run_state["overlay_root"]) / self.key
        self.body_path.parent.mkdir(parents=True, exist_ok=True)
        self.body_path.write_bytes(self.body)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_public_assembly_wrapper_forwards_logger_and_filters_metadata(
        self,
    ) -> None:
        scan_root = self.root / "assembly-wrapper-scan"
        scan_root.mkdir()
        (scan_root / "manifest.json").write_text("{}\n", encoding="utf-8")
        (scan_root / ".DS_Store").write_bytes(b"finder")
        (scan_root / "._manifest.json").write_bytes(b"apple-double")
        logger = mock.Mock(spec=logging.Logger)
        observed_names: list[str] = []

        def stub_assembler(
            run_state: dict[str, object],
            *,
            log: logging.Logger | None = None,
        ) -> dict[str, object]:
            self.assertIs(run_state, self.run_state)
            self.assertIs(log, logger)
            observed_names.extend(
                path.name for path in scan_root.rglob("*") if path.is_file()
            )
            return {"status": "stubbed"}

        self.run_state["sos_light"] = {}
        with (
            mock.patch.object(
                MODULE,
                "_ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS",
                side_effect=stub_assembler,
            ) as original_assembler,
            mock.patch.object(MODULE, "write_run_state") as write_state,
        ):
            result = MODULE.assemble_sos_light_complete_days(
                self.run_state,
                log=logger,
            )

        original_assembler.assert_called_once_with(
            self.run_state,
            log=logger,
        )
        self.assertEqual(observed_names, ["manifest.json"])
        self.assertEqual(
            result["ignored_local_filesystem_metadata_count"], 2,
        )
        self.assertEqual(
            result["ignored_local_filesystem_metadata_patterns"],
            [".DS_Store", "._*"],
        )
        self.assertIs(MODULE.Path.rglob, MODULE._ORIGINAL_PATH_RGLOB)
        write_state.assert_called_once_with(self.run_state)

    def test_complete_day_assembly_rejects_a_missing_frozen_peer(self) -> None:
        day_utc = "2025-01-15"
        day_prefix = f"history/v3/observations/day_utc={day_utc}"
        day_key = f"{day_prefix}/manifest.json"
        connector_key = f"{day_prefix}/connector_id=1/manifest.json"
        for key in (day_key, connector_key):
            local_path = Path(self.run_state["overlay_root"]) / key
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_text("{}\n", encoding="utf-8")
            self.run_state["objects"][key] = {
                "object_key": key,
                "local_path": str(local_path),
                "structurally_validated": True,
            }
        self.run_state["sos_light"] = {
            "mode": "sos-light",
            "validation_status": "validated_local_assembly",
            "old_live_r2_observation_bodies_used": False,
            "days": [{
                "day_utc": day_utc,
                "pinned_day_manifest_present": True,
                "pinned_day_manifest_key": f"{day_prefix}/manifest.json",
                "pinned_day_manifest_hash": "a" * 64,
                "pinned_baseline_connector_ids": [1, 8],
                "expected_preserved_connector_ids": [8],
                "expected_final_connector_ids": [1, 8],
                "final_assembled_connector_ids": [1, 8],
                "authoritative_observation_object_keys": [
                    connector_key,
                    f"{day_prefix}/connector_id=8/manifest.json",
                    day_key,
                ],
                "omitted_dropbox_connector_prefixes": [],
            }],
        }

        with (
            mock.patch.object(MODULE, "validate_run_state_core_snapshot_identity"),
            self.assertRaisesRegex(
                ValueError,
                "authoritative Dropbox object is unavailable",
            ),
        ):
            MODULE._ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS(self.run_state)

    def test_complete_day_assembly_copies_only_frozen_reachable_objects(
        self,
    ) -> None:
        day_utc = "2025-01-15"
        day_prefix = f"history/v3/observations/day_utc={day_utc}"
        day_key = f"{day_prefix}/manifest.json"
        connector_1_key = f"{day_prefix}/connector_id=1/manifest.json"
        connector_8_key = f"{day_prefix}/connector_id=8/manifest.json"
        bc_manifest_key = (
            f"{day_prefix}/connector_id=8/pollutant_code=bc/manifest.json"
        )
        uv_manifest_key = (
            f"{day_prefix}/connector_id=8/pollutant_code=uv370/manifest.json"
        )
        bc_parts = [
            f"{day_prefix}/connector_id=8/pollutant_code=bc/part-00000.parquet",
            f"{day_prefix}/connector_id=8/pollutant_code=bc/part-00001.parquet",
        ]
        uv_part = (
            f"{day_prefix}/connector_id=8/pollutant_code=uv370/part-00000.parquet"
        )
        orphan_manifest = (
            f"{day_prefix}/connector_id=8/pollutant_code=orphan/manifest.json"
        )
        orphan_part = (
            f"{day_prefix}/connector_id=8/pollutant_code=orphan/part-00000.parquet"
        )
        old_bc_part = (
            f"{day_prefix}/connector_id=8/pollutant_code=bc/old-part.parquet"
        )

        connector_references = [
            {"manifest_key": connector_1_key},
            {"manifest_key": connector_8_key},
        ]
        pollutant_references = [
            {"manifest_key": bc_manifest_key},
            {"manifest_key": uv_manifest_key},
        ]
        overlay_payloads = {
            day_key: {
                "manifest_kind": "day",
                "connector_manifests": connector_references,
                "child_manifests": connector_references,
            },
            connector_1_key: {
                "manifest_kind": "connector",
                "pollutant_manifests": [],
                "child_manifests": [],
            },
        }
        source_root = self.root / "source"
        for key, payload in overlay_payloads.items():
            source = source_root / key
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(json.dumps(payload), encoding="utf-8")
            MODULE.stage_overlay_object(
                self.run_state,
                object_key=key,
                source_path=source,
                stage="day_parent" if key == day_key else "connector_manifest",
            )
            MODULE.mark_overlay_structurally_validated(
                self.run_state, key, persist=False
            )

        dropbox_payloads = {
            connector_8_key: {
                "manifest_kind": "connector",
                "pollutant_manifests": pollutant_references,
                "child_manifests": pollutant_references,
            },
            bc_manifest_key: {
                "manifest_kind": "pollutant",
                "parquet_object_keys": bc_parts,
                "files": [{"key": key} for key in bc_parts],
            },
            uv_manifest_key: {
                "manifest_kind": "pollutant",
                "parquet_object_keys": [uv_part],
                "files": [{"key": uv_part}],
            },
            orphan_manifest: {
                "manifest_kind": "pollutant",
                "parquet_object_keys": [orphan_part],
                "files": [{"key": orphan_part}],
            },
        }
        for key, payload in dropbox_payloads.items():
            target = self.dropbox / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(payload), encoding="utf-8")
        for key in [*bc_parts, uv_part, orphan_part, old_bc_part]:
            target = self.dropbox / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(key.encode())

        authoritative_keys = sorted([
            day_key,
            connector_1_key,
            connector_8_key,
            bc_manifest_key,
            uv_manifest_key,
            *bc_parts,
            uv_part,
        ])
        self.run_state["sos_light"] = {
            "mode": "sos-light",
            "validation_status": "validated_local_assembly",
            "old_live_r2_observation_bodies_used": False,
            "dropbox_warnings": [],
            "days": [{
                "day_utc": day_utc,
                "pinned_day_manifest_present": True,
                "pinned_day_manifest_key": day_key,
                "pinned_day_manifest_hash": "a" * 64,
                "pinned_baseline_connector_ids": [1, 8],
                "expected_preserved_connector_ids": [8],
                "expected_final_connector_ids": [1, 8],
                "final_assembled_connector_ids": [1, 8],
                "final_connector_1_child_set": [],
                "authoritative_observation_object_keys": authoritative_keys,
            }],
        }

        with mock.patch.object(
            MODULE, "validate_run_state_core_snapshot_identity"
        ):
            result = MODULE._ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS(
                self.run_state
            )

        self.assertEqual(
            result["days"][0]["complete_day_object_keys"], authoritative_keys
        )
        for key in authoritative_keys:
            self.assertIn(key, self.run_state["objects"])
        for key in (orphan_manifest, orphan_part, old_bc_part):
            self.assertNotIn(key, self.run_state["objects"])

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

    def test_generic_file_backed_proposal_finalises_before_apply(self) -> None:
        executor = self._bulk_executor(1)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        logger = mock.Mock(spec=logging.Logger)
        succeeded = {
            "status": "succeeded",
            "manifest_status": "succeeded",
            "index_status": "succeeded",
        }
        with mock.patch.object(
            MODULE,
            "_finalise_staged_write_set_provenance",
            wraps=MODULE._finalise_staged_write_set_provenance,
        ) as finalise:
            self.assertFalse(
                MODULE._finalise_generic_file_backed_proposal_if_ready(
                    self.run_state,
                    dedicated_sos_historical_replacement=True,
                    observation_failed=False,
                    metadata=succeeded,
                    log=logger,
                )
            )
            self.assertFalse(
                MODULE._finalise_generic_file_backed_proposal_if_ready(
                    self.run_state,
                    dedicated_sos_historical_replacement=False,
                    observation_failed=False,
                    metadata={"status": "failed"},
                    log=logger,
                )
            )
            self.run_state["blocked_scopes"] = [{
                "stage": "observs_indexes",
                "reason": "test_blocked_proposal",
            }]
            self.assertFalse(
                MODULE._finalise_generic_file_backed_proposal_if_ready(
                    self.run_state,
                    dedicated_sos_historical_replacement=False,
                    observation_failed=False,
                    metadata=succeeded,
                    log=logger,
                )
            )
            self.run_state["blocked_scopes"] = []
            finalise.assert_not_called()
            self.assertNotIn(
                "final_staged_write_set_provenance", self.run_state
            )

            self.assertTrue(
                MODULE._finalise_generic_file_backed_proposal_if_ready(
                    self.run_state,
                    dedicated_sos_historical_replacement=False,
                    observation_failed=False,
                    metadata=succeeded,
                    log=logger,
                )
            )
            finalise.assert_called_once_with(self.run_state, log=logger)

        self.assertEqual(
            self.run_state["final_staged_write_set_provenance"]["status"],
            "finalised",
        )
        persisted = json.loads(
            Path(self.run_state["run_state_path"]).read_text(encoding="utf-8")
        )
        self.assertEqual(
            persisted["final_staged_write_set_provenance"]["status"],
            "finalised",
        )
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
        self.assertTrue(
            popen.call_args.args[0][1].endswith(
                "uk_aq_apply_sos_light_v3_proposal.mjs"
            )
        )
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

    def test_generic_executor_routes_only_to_generic_v3_entrypoint(self) -> None:
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=self._bulk_executor(1),
            dry_run=False,
            require_file_backed_bodies=True,
        )
        self.run_state.update({
            "execution_path": "generic_integrity",
            "dedicated_sos_historical_replacement": False,
        })
        self.run_state.pop("sos_light", None)
        prefix = (
            "history/v3/observations/day_utc=2026-09-28/"
            "connector_id=8/pollutant_code=o3"
        )
        self.run_state["tombstone_prefixes"] = [{
            "prefix": prefix,
            "proposed": True,
            "stage": "observations_data",
            "repair_pollutants": ["o3"],
            "authority_outcome": "authoritative_no_data_replacement",
            "authority_scope": {
                "day_utc": "2026-09-28",
                "connector_id": 8,
                "pollutant_code": "o3",
            },
        }]
        self.run_state["generic_integrity_selected_scope_authority"] = {
            "contract_version": (
                MODULE.GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
            ),
            "history_generation": "v3",
            "selected_scopes": [{
                "day_utc": "2026-09-28",
                "connector_id": 8,
                "pollutant_code": "o3",
                "pollutant_prefix": prefix,
                "outcome": "authoritative_no_data_replacement",
                "authorised_tombstone_prefix": prefix,
                "replacement_object_keys": [],
                "preservation_evidence": None,
            }],
            "authorised_pollutant_tombstone_prefixes": [prefix],
        }
        MODULE._finalise_staged_write_set_provenance(self.run_state)
        MODULE.write_run_state(self.run_state)
        logger = mock.Mock(spec=logging.Logger)
        process = FakePlannerProcess(stdout='{"ok":true}\n')
        with (
            mock.patch.object(
                MODULE, "validate_run_state_core_snapshot_identity",
            ),
            mock.patch.object(
                MODULE, "_repo_root_for_integrity_script",
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
        self.assertTrue(
            popen.call_args.args[0][1].endswith(
                "uk_aq_apply_generic_v3_proposal.mjs"
            )
        )
        self.assertEqual(
            self.run_state["proposal_transition_validation"][
                "state_fingerprint_contract_version"
            ],
            MODULE.GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
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
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, python_fingerprint)

    def test_generic_v3_fingerprint_parity_uses_selected_scope_not_sos(self) -> None:
        executor = self._bulk_executor(2)
        MODULE._record_metadata_executor_overlay(
            run_state=self.run_state,
            executor_result=executor,
            dry_run=False,
            require_file_backed_bodies=True,
        )
        self.run_state.update({
            "execution_path": "generic_integrity",
            "dedicated_sos_historical_replacement": False,
        })
        self.run_state.pop("sos_light", None)
        prefix = (
            "history/v3/observations/day_utc=2026-09-28/"
            "connector_id=8/pollutant_code=no2"
        )
        self.run_state["tombstone_prefixes"] = [{
            "prefix": prefix,
            "proposed": True,
            "stage": "observations_data",
            "repair_pollutants": ["no2"],
            "authority_outcome": "authoritative_no_data_replacement",
            "authority_scope": {
                "day_utc": "2026-09-28",
                "connector_id": 8,
                "pollutant_code": "no2",
            },
        }]
        self.run_state["generic_integrity_selected_scope_authority"] = {
            "contract_version": (
                MODULE.GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
            ),
            "history_generation": "v3",
            "selected_scopes": [{
                "day_utc": "2026-09-28",
                "connector_id": 8,
                "pollutant_code": "no2",
                "pollutant_prefix": prefix,
                "outcome": "authoritative_no_data_replacement",
                "authorised_tombstone_prefix": prefix,
                "replacement_object_keys": [],
                "preservation_evidence": None,
            }],
            "authorised_pollutant_tombstone_prefixes": [prefix],
        }
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
            / "scripts/backup_r2/lib/generic_v3_proposal_validation.mjs"
        ).as_uri()
        result = MODULE.subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                (
                    "import fs from 'node:fs';"
                    f"import {{computeGenericV3TransitionStateFingerprint}} from {json.dumps(validation_module)};"
                    "const state=JSON.parse(fs.readFileSync("
                    f"{json.dumps(self.run_state['run_state_path'])},'utf8'));"
                    "process.stdout.write(computeGenericV3TransitionStateFingerprint(state));"
                ),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, python_fingerprint)
        self.assertEqual(
            MODULE._proposal_transition_state_fingerprint_payload(
                self.run_state
            )["contract_version"],
            MODULE.GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
        )
        self.assertNotIn(
            "sos_light_connector_membership",
            MODULE._proposal_transition_state_fingerprint_payload(
                self.run_state
            ),
        )

    def test_generic_source_unavailable_scope_cannot_gain_deletion(self) -> None:
        self.run_state.update({
            "execution_path": "generic_integrity",
            "dedicated_sos_historical_replacement": False,
        })
        prefix = (
            "history/v3/observations/day_utc=2026-09-28/"
            "connector_id=8/pollutant_code=pm10"
        )
        self.run_state["tombstone_prefixes"] = [{
            "prefix": prefix,
            "proposed": True,
        }]
        with self.assertRaisesRegex(
            ValueError, "source-unavailable scope cannot be deleted",
        ):
            MODULE._finalise_generic_integrity_selected_scope_authority(
                self.run_state,
                [{
                    "day_utc": "2026-09-28",
                    "connector_id": 8,
                    "pollutant_codes": ["pm10"],
                    "outcome": "source_artifact_unavailable_preserved",
                }],
            )

    def test_generic_preserved_scope_freezes_parent_chain_and_matches_node(
        self,
    ) -> None:
        self.run_state.update({
            "execution_path": "generic_integrity",
            "dedicated_sos_historical_replacement": False,
        })
        self.run_state.pop("sos_light", None)
        day_utc = "2026-09-28"
        connector_id = 8
        pollutant_code = "pm10"
        day_prefix = f"history/v3/observations/day_utc={day_utc}"
        connector_prefix = f"{day_prefix}/connector_id={connector_id}"
        pollutant_prefix = (
            f"{connector_prefix}/pollutant_code={pollutant_code}"
        )
        pollutant_key = f"{pollutant_prefix}/manifest.json"
        connector_key = f"{connector_prefix}/manifest.json"
        day_key = f"{day_prefix}/manifest.json"
        pollutant_payload = {"manifest_hash": "a" * 64}
        pollutant_body = json.dumps(
            pollutant_payload, separators=(",", ":"),
        ).encode()
        pollutant_path = self.dropbox / pollutant_key
        pollutant_path.parent.mkdir(parents=True, exist_ok=True)
        pollutant_path.write_bytes(pollutant_body)
        pollutant_identity = {
            "sha256": hashlib.sha256(pollutant_body).hexdigest(),
            "bytes": len(pollutant_body),
            "source": "dropbox",
        }

        def add_staged(
            object_key: str,
            payload: dict[str, object],
            dependencies: list[str],
            identities: dict[str, dict[str, object]],
        ) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode()
            local_path = Path(self.run_state["overlay_root"]) / object_key
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(body)
            self.run_state["objects"][object_key] = {
                "object_key": object_key,
                "local_path": str(local_path),
                "sha256": hashlib.sha256(body).hexdigest(),
                "bytes": len(body),
                "stage": "observations_manifest",
                "dependencies": dependencies,
                "dependency_identities": identities,
                "proposed": True,
                "built": True,
                "structurally_validated": True,
                "changed": True,
                "included_in_write_set": True,
                "status": "planned",
                "planner_changed": True,
                "planner_status": "planned",
                "planner_included_in_write_set": True,
                "planner_dependencies": list(dependencies),
                "planner_dependency_identities": dict(identities),
            }

        pollutant_reference = {
            "manifest_key": pollutant_key,
            "manifest_hash": pollutant_payload["manifest_hash"],
        }
        connector_payload = {
            "manifest_hash": "b" * 64,
            "pollutant_manifests": [pollutant_reference],
            "child_manifests": [pollutant_reference],
        }
        add_staged(
            connector_key,
            connector_payload,
            [pollutant_key],
            {pollutant_key: pollutant_identity},
        )
        connector_entry = self.run_state["objects"][connector_key]
        connector_identity = {
            "sha256": connector_entry["sha256"],
            "bytes": connector_entry["bytes"],
            "source": "planned_overlay",
        }
        connector_reference = {
            "manifest_key": connector_key,
            "manifest_hash": connector_payload["manifest_hash"],
        }
        add_staged(
            day_key,
            {
                "manifest_hash": "c" * 64,
                "connector_manifests": [connector_reference],
                "child_manifests": [connector_reference],
            },
            [connector_key],
            {connector_key: connector_identity},
        )
        authority = MODULE._finalise_generic_integrity_selected_scope_authority(
            self.run_state,
            [{
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": pollutant_code,
                "outcome": "source_artifact_unavailable_preserved",
            }],
        )
        scope = authority["selected_scopes"][0]
        self.assertEqual(scope["pollutant_prefix"], pollutant_prefix)
        self.assertEqual(
            scope["preservation_evidence"]["pollutant_manifest"],
            {"object_key": pollutant_key, **pollutant_identity},
        )
        self.assertEqual(
            scope["preservation_evidence"]["connector_parent"]
            ["object_key"],
            connector_key,
        )
        self.assertEqual(
            scope["preservation_evidence"]["day_parent"]["object_key"],
            day_key,
        )
        self.run_state["proposal_transition_planner_unchanged_keys"] = []
        self.run_state["final_staged_write_set_provenance"] = {
            "status": "finalised",
            "final_staged_object_count": 2,
            "forced_republication_count": 0,
            "forced_republication_keys": [],
            "promotion_reason_counts": {},
            "rebuilt_dependency_identity_count": 0,
            "staged_dependency_edge_count": 1,
            "external_dependency_edge_counts": {
                "dropbox": 1,
                "overlay": 0,
            },
        }
        MODULE.write_run_state(self.run_state)
        python_fingerprint = (
            MODULE.proposal_transition_state_fingerprint_sha256(self.run_state)
        )
        validation_module = (
            Path(__file__).resolve().parents[3]
            / "scripts/backup_r2/lib/generic_v3_proposal_validation.mjs"
        ).as_uri()
        result = MODULE.subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                (
                    "import fs from 'node:fs';"
                    f"import {{computeGenericV3TransitionStateFingerprint}} from {json.dumps(validation_module)};"
                    "const state=JSON.parse(fs.readFileSync("
                    f"{json.dumps(self.run_state['run_state_path'])},'utf8'));"
                    "process.stdout.write(computeGenericV3TransitionStateFingerprint(state));"
                ),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, python_fingerprint)

        pollutant_path.write_bytes(b'{"manifest_hash":"stale"}')
        with self.assertRaisesRegex(
            ValueError, "preserved pollutant manifest identity changed",
        ):
            MODULE._canonical_generic_integrity_selected_scope_authority(
                self.run_state
            )

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
