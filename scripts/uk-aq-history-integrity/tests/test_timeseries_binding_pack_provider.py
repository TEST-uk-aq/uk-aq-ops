#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock


BIN_DIR = Path(__file__).resolve().parents[1] / "bin"
if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))

from integrity import timeseries_binding_provider as PROVIDER


MODULE_PATH = BIN_DIR / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_binding_pack_test", MODULE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

V3_MODULE_PATH = BIN_DIR / "uk-aq-history-integrity-sos-light-v3.py"
V3_SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_binding_pack_v3_test", V3_MODULE_PATH
)
if V3_SPEC is None or V3_SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {V3_MODULE_PATH}")
V3_MODULE = importlib.util.module_from_spec(V3_SPEC)
sys.modules[V3_SPEC.name] = V3_MODULE
V3_SPEC.loader.exec_module(V3_MODULE)


def stable_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def binding_bytes(
    timeseries_id: int,
    connector_id: int,
    pollutant: str,
    *,
    station_id: int | None = None,
) -> bytes:
    payload = {
        "schema_version": 1,
        "history_version": "v2",
        "index_kind": "timeseries_binding",
        "timeseries_id": timeseries_id,
        "connector_id": connector_id,
        "pollutant_code": pollutant,
    }
    if station_id is not None:
        payload["station_id"] = station_id
    return stable_bytes(payload)


class PackedBindingFixture:
    def __init__(self, root: Path, observation_generation: str = "v2") -> None:
        self.root = root
        self.observation_generation = observation_generation
        self.binding_prefix = (
            f"history/_index_{observation_generation}/timeseries_binding"
        )
        suffix = "/generation=v3" if observation_generation == "v3" else ""
        self.pack_prefix = (
            f"history/_backup_packs_v1/timeseries_binding{suffix}"
        )
        self.pack_root_path = f"{self.pack_prefix}/root.json"
        self.state_root_prefix = (
            "_ops/checkpoints/r2_history_backup_state_v2/"
            f"observation_generation={observation_generation}"
        )
        self.state_root_path = f"{self.state_root_prefix}/root.json"
        self.source_root_hash = sha256(b"source-root")

    def write(
        self,
        members: list[dict[str, object]],
        *,
        checkpoint_source_root_hash: str | None = None,
        reference_overrides: dict[int, dict[str, object]] | None = None,
    ) -> None:
        grouped: dict[int, list[dict[str, object]]] = {}
        for member in members:
            timeseries_id = int(member["timeseries_id"])
            grouped.setdefault((timeseries_id // 1000) * 1000, []).append(member)

        references: list[dict[str, object]] = []
        for start, group in sorted(grouped.items()):
            end = start + 999
            source_range_hash = sha256(f"source-range:{start}".encode())
            packed_members = []
            for raw in group:
                timeseries_id = int(raw["timeseries_id"])
                body = bytes(raw["body"])
                packed_members.append({
                    "timeseries_id": timeseries_id,
                    "relative_path": raw.get(
                        "relative_path",
                        f"{self.binding_prefix}/timeseries_id={timeseries_id}.json",
                    ),
                    "size": raw.get("size", len(body)),
                    "sha256": raw.get("sha256", sha256(body)),
                    "body_base64": raw.get(
                        "body_base64", base64.b64encode(body).decode("ascii")
                    ),
                })
            pack = {
                "schema_version": 1,
                "kind": PROVIDER.PACK_KIND,
                "backup_pack_version": "v1",
                "range_size": 1000,
                "range_start": start,
                "range_end": end,
                "source_prefix": self.binding_prefix,
                "source_range_hash": source_range_hash,
                "member_count": len(packed_members),
                "members": packed_members,
            }
            pack_body = stable_bytes(pack)
            relative_path = (
                f"{self.pack_prefix}/range={start:06d}-{end:06d}/"
                f"{source_range_hash}.pack.json"
            )
            target = self.root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(pack_body)
            reference = {
                "range_start": start,
                "range_end": end,
                "source_range_hash": source_range_hash,
                "pack_relative_path": relative_path,
                "pack_sha256": sha256(pack_body),
                "pack_size": len(pack_body),
                "member_count": len(packed_members),
            }
            reference.update((reference_overrides or {}).get(start, {}))
            references.append(reference)

        pack_root = {
            "schema_version": 1,
            "kind": PROVIDER.PACK_ROOT_KIND,
            "backup_pack_version": "v1",
            "range_size": 1000,
            "source_prefix": self.binding_prefix,
            "source_root_key": f"{self.binding_prefix}/_manifests/root.json",
            "source_root_hash": self.source_root_hash,
            "range_count": len(references),
            "member_count": sum(int(item["member_count"]) for item in references),
            "ranges": references,
        }
        pack_root_body = stable_bytes(pack_root)
        pack_root_path = self.root / self.pack_root_path
        pack_root_path.parent.mkdir(parents=True, exist_ok=True)
        pack_root_path.write_bytes(pack_root_body)

        state_ranges = []
        for reference in references:
            start = int(reference["range_start"])
            end = int(reference["range_end"])
            shard_key = (
                f"{self.state_root_prefix}/timeseries_binding_packs/"
                f"range={start:06d}-{end:06d}.json"
            )
            shard = {
                "schema_version": 1,
                "kind": PROVIDER.PACK_RANGE_STATE_KIND,
                "backup_pack_version": "v1",
                "range_size": 1000,
                "range_start": start,
                "range_end": end,
                "processed_source_range_hash": reference["source_range_hash"],
                "pack_relative_path": reference["pack_relative_path"],
                "pack_sha256": reference["pack_sha256"],
                "pack_size": reference["pack_size"],
                "member_count": reference["member_count"],
                "copied_at": "2026-09-04T12:00:00.000Z",
                "verified": True,
            }
            shard_body = stable_bytes(shard)
            shard_path = self.root / shard_key
            shard_path.parent.mkdir(parents=True, exist_ok=True)
            shard_path.write_bytes(shard_body)
            state_ranges.append({
                "range_start": start,
                "range_end": end,
                "state_shard_key": shard_key,
                "processed_source_range_hash": reference["source_range_hash"],
                "pack_relative_path": reference["pack_relative_path"],
                "pack_sha256": reference["pack_sha256"],
                "pack_size": reference["pack_size"],
                "member_count": reference["member_count"],
                "state_shard_hash": sha256(shard_body),
            })
        state_root = {
            "schema_version": 1,
            "kind": PROVIDER.STATE_ROOT_KIND,
            "backup_version": "v2",
            "observation_generation": self.observation_generation,
            "observations": {"processed_source_root_hash": None, "years": []},
            "global_units": {},
            "timeseries_binding_packs": {
                "schema_version": 1,
                "kind": PROVIDER.PACK_STATE_ROOT_KIND,
                "backup_pack_version": "v1",
                "processed_source_root_hash": (
                    checkpoint_source_root_hash or self.source_root_hash
                ),
                "processed_pack_root_sha256": sha256(pack_root_body),
                "pack_root_relative_path": self.pack_root_path,
                "pack_root_size": len(pack_root_body),
                "copied_at": "2026-09-04T12:00:01.000Z",
                "verified": True,
                "ranges": state_ranges,
            },
        }
        state_path = self.root / self.state_root_path
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_bytes(stable_bytes(state_root))


class TimeseriesBindingPackProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sos_body = binding_bytes(101, 1, "pm25")
        self.non_sos_body = binding_bytes(1101, 2, "no2")
        self.members = [
            {"timeseries_id": 101, "body": self.sos_body},
            {"timeseries_id": 1101, "body": self.non_sos_body},
        ]
        self.fixture = PackedBindingFixture(self.root)
        self.fixture.write(self.members)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_healthy_generation_verifies_globally(self) -> None:
        selected, audit = PROVIDER.verify_packed_binding_generation(
            self.root, {101}
        )
        self.assertEqual(selected, {101: self.sos_body})
        self.assertEqual(audit["ranges_verified"], 2)
        self.assertEqual(audit["total_pack_members_verified"], 2)
        self.assertGreater(audit["total_pack_bytes_verified"], 0)
        self.assertNotIn("authenticated_generation_complete", audit)
        self.assertNotIn("authenticated_members_returned", audit)

    def test_v3_authenticated_member_api_returns_complete_verified_generation_once(self) -> None:
        v3_members = [
            {
                "timeseries_id": 101,
                "body": binding_bytes(101, 1, "pm25", station_id=11),
            },
            {
                "timeseries_id": 9101,
                "body": binding_bytes(9101, 9, "no2", station_id=91),
            },
        ]
        fixture = PackedBindingFixture(self.root, observation_generation="v3")
        fixture.write(v3_members)
        original_reader = PROVIDER._read_json_bytes
        with mock.patch.object(
            PROVIDER,
            "_read_json_bytes",
            wraps=original_reader,
        ) as reader:
            authenticated, audit = (
                PROVIDER.authenticated_packed_binding_generation(
                    self.root, observation_generation="v3"
                )
            )

        self.assertEqual(set(authenticated), {101, 9101})
        self.assertEqual(audit["observation_generation"], "v3")
        self.assertTrue(audit["authenticated_generation_complete"])
        self.assertEqual(audit["authenticated_members_returned"], 2)
        pack_reads = [
            call
            for call in reader.call_args_list
            if str(call.args[0]).endswith(".pack.json")
        ]
        self.assertEqual(len(pack_reads), audit["ranges_verified"])

    def test_v3_authenticated_member_api_rejects_duplicate_retained_identity(self) -> None:
        body = binding_bytes(9101, 9, "no2", station_id=91)
        fixture = PackedBindingFixture(self.root, observation_generation="v3")
        fixture.write([
            {"timeseries_id": 9101, "body": body},
            {"timeseries_id": 9101, "body": body},
        ])
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "duplicate"):
            PROVIDER.authenticated_packed_binding_generation(
                self.root, observation_generation="v3"
            )

    def test_exact_sos_bytes_materialise_without_non_sos(self) -> None:
        with PROVIDER.binding_backup_view(
            mode="pack",
            individual_root=self.root / "unused",
            pack_root=self.root,
            required_timeseries_ids={101},
        ) as (view, audit):
            sos_path = view / PROVIDER.BINDING_PREFIX / "timeseries_id=101.json"
            non_sos_path = view / PROVIDER.BINDING_PREFIX / "timeseries_id=1101.json"
            self.assertEqual(sos_path.read_bytes(), self.sos_body)
            self.assertFalse(non_sos_path.exists())
            self.assertEqual(audit["sos_bindings_materialised"], 1)
            self.assertEqual(audit["non_sos_bindings_materialised"], 0)

    def test_individual_mode_returns_existing_root_unchanged(self) -> None:
        individual = self.root / "individual"
        individual.mkdir()
        with PROVIDER.binding_backup_view(
            mode="individual",
            individual_root=individual,
            pack_root=None,
            required_timeseries_ids={101},
        ) as (view, audit):
            self.assertEqual(view, individual)
            self.assertEqual(audit["cleanup_outcome"], "not_applicable")

    def test_cli_defaults_pack_for_sos_official_networks_and_all(self) -> None:
        for source in ("sos", "waqn", "saqn", "all"):
            with self.subTest(source=source):
                parsed = V3_MODULE.parse_args([
                    "--env", "TEST", "--source", source, "--check-only",
                    "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                ])
                self.assertEqual(parsed.timeseries_binding_backup_mode, "pack")

    def test_cli_preserves_individual_default_for_other_sources(self) -> None:
        for source in ("openaq", "sensorcommunity"):
            with self.subTest(source=source):
                parsed = V3_MODULE.parse_args([
                    "--env", "TEST", "--source", source, "--check-only",
                    "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                ])
                self.assertEqual(
                    parsed.timeseries_binding_backup_mode,
                    "individual",
                )

    def test_cli_live_defaults_remain_individual(self) -> None:
        for source in ("waqn", "saqn", "all", "openaq", "sensorcommunity"):
            with self.subTest(source=source):
                parsed = V3_MODULE.parse_args([
                    "--env", "LIVE", "--source", source, "--check-only",
                    "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                ])
                self.assertEqual(
                    parsed.timeseries_binding_backup_mode,
                    "individual",
                )

    def test_cli_accepts_explicit_test_pack_for_supported_sources(self) -> None:
        for source in ("sos", "waqn", "saqn", "all"):
            with self.subTest(source=source):
                parsed = V3_MODULE.parse_args([
                    "--env", "TEST", "--source", source, "--check-only",
                    "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                    "--timeseries-binding-backup-mode", "pack",
                    "--timeseries-binding-pack-root", str(self.root),
                ])
                self.assertEqual(parsed.timeseries_binding_backup_mode, "pack")
                self.assertEqual(
                    parsed.timeseries_binding_pack_root,
                    str(self.root),
                )

    def test_cli_rejects_pack_for_sources_without_pack_routing(self) -> None:
        for source in ("openaq", "sensorcommunity"):
            with self.subTest(source=source), self.assertRaises(SystemExit):
                V3_MODULE.parse_args([
                    "--env", "TEST", "--source", source, "--check-only",
                    "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                    "--timeseries-binding-backup-mode", "pack",
                ])

    def test_cli_pack_mode_remains_test_only(self) -> None:
        with self.assertRaises(SystemExit):
            V3_MODULE.parse_args([
                "--env", "LIVE", "--source", "waqn", "--check-only",
                "--from-day", "2026-06-01", "--to-day", "2026-06-01",
                "--timeseries-binding-backup-mode", "pack",
            ])

    def test_root_checkpoint_source_identity_mismatch_fails(self) -> None:
        self.fixture.write(
            self.members,
            checkpoint_source_root_hash=sha256(b"different-source-root"),
        )
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "source identity mismatch"):
            PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_child_pack_sha_mismatch_fails(self) -> None:
        self.fixture.write(
            self.members,
            reference_overrides={0: {"pack_sha256": "0" * 64}},
        )
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "SHA-256 mismatch"):
            PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_child_pack_size_mismatch_fails(self) -> None:
        self.fixture.write(
            self.members,
            reference_overrides={0: {"pack_size": 1}},
        )
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "byte size mismatch"):
            PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_requested_pack_mode_never_falls_back_to_individual(self) -> None:
        individual = self.root / "individual"
        binding_path = (
            individual / PROVIDER.BINDING_PREFIX / "timeseries_id=101.json"
        )
        binding_path.parent.mkdir(parents=True)
        binding_path.write_bytes(self.sos_body)
        self.fixture.write(
            self.members,
            reference_overrides={0: {"pack_sha256": "0" * 64}},
        )
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "SHA-256 mismatch"):
            with PROVIDER.binding_backup_view(
                mode="pack",
                individual_root=individual,
                pack_root=self.root,
                required_timeseries_ids={101},
            ):
                self.fail("corrupt pack unexpectedly fell back to individual files")

    def test_decoded_member_hash_and_size_mismatch_fail(self) -> None:
        cases = (
            ({"sha256": "0" * 64}, "decoded SHA-256 mismatch"),
            ({"size": len(self.sos_body) + 1}, "decoded size mismatch"),
            ({"body_base64": "!!"}, "body_base64 is invalid"),
        )
        for override, expected in cases:
            with self.subTest(expected=expected):
                members = [
                    {"timeseries_id": 101, "body": self.sos_body, **override},
                    {"timeseries_id": 1101, "body": self.non_sos_body},
                ]
                self.fixture.write(members)
                with self.assertRaisesRegex(PROVIDER.PackedBindingError, expected):
                    PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_duplicate_member_fails(self) -> None:
        self.fixture.write([
            {"timeseries_id": 101, "body": self.sos_body},
            {"timeseries_id": 101, "body": self.sos_body},
        ])
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "duplicate"):
            PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_path_traversal_fails(self) -> None:
        self.fixture.write([{
            "timeseries_id": 101,
            "body": self.sos_body,
            "relative_path": "../timeseries_id=101.json",
        }])
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "path"):
            PROVIDER.verify_packed_binding_generation(self.root, {101})

    def test_missing_required_sos_binding_fails(self) -> None:
        with self.assertRaisesRegex(PROVIDER.PackedBindingError, "required SOS"):
            PROVIDER.verify_packed_binding_generation(self.root, {999})

    def test_temporary_view_removed_after_success_and_exception(self) -> None:
        paths: list[Path] = []
        with PROVIDER.binding_backup_view(
            mode="pack",
            individual_root=self.root / "unused",
            pack_root=self.root,
            required_timeseries_ids={101},
        ) as (view, audit):
            paths.append(view)
        self.assertFalse(paths[-1].exists())
        self.assertEqual(audit["cleanup_outcome"], "removed")

        with self.assertRaisesRegex(RuntimeError, "semantic failure"):
            with PROVIDER.binding_backup_view(
                mode="pack",
                individual_root=self.root / "unused",
                pack_root=self.root,
                required_timeseries_ids={101},
            ) as (view, failed_audit):
                paths.append(view)
                raise RuntimeError("semantic failure")
        self.assertFalse(paths[-1].exists())
        self.assertEqual(failed_audit["cleanup_outcome"], "removed")

    def test_existing_sos_semantic_validator_consumes_pack_view(self) -> None:
        expected = [
            {"timeseries_id": 101, "connector_id": 1, "pollutant_code": "pm25"},
            {"timeseries_id": 1101, "connector_id": 2, "pollutant_code": "no2"},
        ]
        conn = sqlite3.connect(":memory:")
        try:
            with mock.patch.object(
                MODULE,
                "_authoritative_v2_core_timeseries_bindings",
                return_value=expected,
            ):
                result = MODULE.run_sos_timeseries_binding_verification(
                    conn=conn,
                    config=MODULE.resolve_history_path_config("v2", {}),
                    individual_root=self.root / "unused",
                    backup_mode="pack",
                    pack_root=self.root,
                    stage="check_only",
                )
        finally:
            conn.close()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["required_binding_count"], 1)
        self.assertEqual(result["provider"]["sos_bindings_materialised"], 1)
        self.assertEqual(result["provider"]["non_sos_bindings_materialised"], 0)
        self.assertEqual(result["provider"]["cleanup_outcome"], "removed")

    def test_v3_generic_binding_verification_uses_only_scoped_core_ids(self) -> None:
        manager = mock.MagicMock()
        materialized_root = self.root / "materialized"
        manager.__enter__.return_value = (
            materialized_root,
            {"mode": "pack", "cleanup_outcome": "removed"},
        )
        manager.__exit__.return_value = False
        expected = {
            9101: {
                "timeseries_id": 9101,
                "connector_id": 9,
                "pollutant_code": "no2",
            },
        }
        conn = sqlite3.connect(":memory:")
        try:
            with mock.patch.object(
                V3_MODULE,
                "_expected_v2_core_timeseries_bindings",
                return_value=expected,
            ) as expected_bindings, mock.patch.object(
                V3_MODULE,
                "binding_backup_view",
                return_value=manager,
            ) as binding_view, mock.patch.object(
                V3_MODULE,
                "_validate_v2_timeseries_bindings",
                return_value=[],
            ) as validator:
                result = V3_MODULE.run_timeseries_binding_verification(
                    conn=conn,
                    config=V3_MODULE.resolve_history_path_config("v3", {}),
                    individual_root=self.root / "individual",
                    backup_mode="pack",
                    pack_root=self.root,
                    connector_ids={9},
                    stage="final_verification",
                )
        finally:
            conn.close()

        expected_bindings.assert_called_once_with(
            mock.ANY,
            allowed_connector_ids={9},
        )
        self.assertEqual(
            binding_view.call_args.kwargs["required_timeseries_ids"],
            {9101},
        )
        self.assertEqual(
            binding_view.call_args.kwargs["observation_generation"],
            "v3",
        )
        validator.assert_called_once_with(
            conn=mock.ANY,
            view_root=materialized_root,
            config=mock.ANY,
            allowed_connector_ids={9},
        )
        self.assertEqual(result["connector_ids"], [9])
        self.assertEqual(result["required_binding_count"], 1)

    def test_v3_final_verification_routes_effective_binding_scope_and_mode(self) -> None:
        cases = (
            ("waqn", {9}, [9], "pack", {9}),
            ("saqn", {10}, [10], "pack", {10}),
            ("all", None, [1, 2, 9, 10], "pack", {1, 2, 9, 10}),
            ("openaq", {2}, [2], "individual", {2}),
            ("sensorcommunity", {4}, [4], "individual", {4}),
        )
        conn = sqlite3.connect(":memory:")
        try:
            for source, allowed, scoped, mode, expected_scope in cases:
                with self.subTest(source=source), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    verification_result = {
                        "stage": "final_verification",
                        "status": "ok",
                        "connector_ids": sorted(expected_scope),
                        "required_binding_count": 1,
                        "semantic_binding_count_checked": 1,
                        "gap_count": 0,
                        "gaps": [],
                        "provider": {"mode": mode},
                    }
                    with mock.patch.object(
                        V3_MODULE,
                        "validate_run_state_core_snapshot_identity",
                    ), mock.patch.object(
                        V3_MODULE,
                        "_create_final_verification_view",
                        return_value=root / "final-view",
                    ), mock.patch.object(
                        V3_MODULE,
                        "run_v2_post_repair_integrity_rechecks",
                        return_value={"observations": {"gaps": []}},
                    ), mock.patch.object(
                        V3_MODULE,
                        "verify_apply_persistence_artifacts",
                        return_value={"status": "verified"},
                    ), mock.patch.object(
                        V3_MODULE,
                        "run_timeseries_binding_verification",
                        return_value=verification_result,
                    ) as binding_verification:
                        result = V3_MODULE.run_v2_final_verification(
                            run_state={
                                "overlay_root": str(root / "overlay"),
                                "base_dropbox_root": str(root / "dropbox"),
                            },
                            conn=conn,
                            env_name="TEST",
                            config=V3_MODULE.resolve_history_path_config("v3", {}),
                            from_day="2026-09-29",
                            to_day="2026-09-29",
                            allowed_connector_ids=allowed,
                            source_scope={
                                "source": source,
                                "connector_ids": scoped,
                            },
                            log=mock.Mock(),
                            require_remote_state=False,
                            timeseries_binding_backup_mode=mode,
                            timeseries_binding_pack_root=(
                                root if mode == "pack" else None
                            ),
                        )

                    call = binding_verification.call_args.kwargs
                    self.assertEqual(call["backup_mode"], mode)
                    self.assertEqual(call["connector_ids"], expected_scope)
                    self.assertEqual(result["status"], "planned")
        finally:
            conn.close()

    def test_v3_final_verification_fails_closed_on_pack_view_error(self) -> None:
        conn = sqlite3.connect(":memory:")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with mock.patch.object(
                    V3_MODULE,
                    "validate_run_state_core_snapshot_identity",
                ), mock.patch.object(
                    V3_MODULE,
                    "_create_final_verification_view",
                    return_value=root / "final-view",
                ), mock.patch.object(
                    V3_MODULE,
                    "run_v2_post_repair_integrity_rechecks",
                    return_value={"observations": {"gaps": []}},
                ), mock.patch.object(
                    V3_MODULE,
                    "verify_apply_persistence_artifacts",
                    return_value={"status": "verified"},
                ), mock.patch.object(
                    V3_MODULE,
                    "run_timeseries_binding_verification",
                    side_effect=V3_MODULE.PackedBindingError(
                        "fixture pack authentication failed"
                    ),
                ):
                    result = V3_MODULE.run_v2_final_verification(
                        run_state={
                            "overlay_root": str(root / "overlay"),
                            "base_dropbox_root": str(root / "dropbox"),
                        },
                        conn=conn,
                        env_name="TEST",
                        config=V3_MODULE.resolve_history_path_config("v3", {}),
                        from_day="2026-09-29",
                        to_day="2026-09-29",
                        allowed_connector_ids={9},
                        source_scope={"source": "waqn", "connector_ids": [9]},
                        log=mock.Mock(),
                        require_remote_state=False,
                        timeseries_binding_backup_mode="pack",
                        timeseries_binding_pack_root=root,
                    )
        finally:
            conn.close()

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["remaining_gap_count"], 1)
        self.assertEqual(
            result["remaining_scopes"][0]["gap_type"],
            "timeseries_binding_backup_view_failed",
        )

    def test_individual_mode_skips_operational_verifier(self) -> None:
        conn = sqlite3.connect(":memory:")
        try:
            for stage in ("check_only", "pre_repair", "repair_final"):
                with self.subTest(stage=stage), mock.patch.object(
                    MODULE,
                    "run_sos_timeseries_binding_verification",
                ) as verifier:
                    result = (
                        MODULE.run_pack_mode_sos_timeseries_binding_verification(
                            conn=conn,
                            config=MODULE.resolve_history_path_config("v2", {}),
                            individual_root=self.root / "individual",
                            backup_mode="individual",
                            pack_root=self.root,
                            stage=stage,
                        )
                    )
                    self.assertIsNone(result)
                    verifier.assert_not_called()
        finally:
            conn.close()

    def test_pack_check_only_invokes_operational_verifier(self) -> None:
        expected = {
            "stage": "check_only",
            "status": "ok",
            "gap_count": 0,
            "gaps": [],
        }
        conn = sqlite3.connect(":memory:")
        try:
            with mock.patch.object(
                MODULE,
                "run_sos_timeseries_binding_verification",
                return_value=expected,
            ) as verifier:
                result = MODULE.run_pack_mode_sos_timeseries_binding_verification(
                    conn=conn,
                    config=MODULE.resolve_history_path_config("v2", {}),
                    individual_root=self.root / "unused",
                    backup_mode="pack",
                    pack_root=self.root,
                    stage="check_only",
                )
        finally:
            conn.close()
        self.assertIs(result, expected)
        verifier.assert_called_once()
        self.assertEqual(verifier.call_args.kwargs["stage"], "check_only")
        self.assertEqual(verifier.call_args.kwargs["backup_mode"], "pack")

    def test_currentness_gate_wrapper_propagates_waqn_default_pack_mode(self) -> None:
        parsed = V3_MODULE.parse_args([
            "--env", "TEST", "--source", "waqn", "--check-only",
            "--from-day", "2026-06-01", "--to-day", "2026-06-01",
        ])
        completed = mock.Mock(
            returncode=0,
            stdout='{"allowed": true}\n',
            stderr="",
        )
        with mock.patch.object(
            V3_MODULE,
            "_repo_root_for_integrity_script",
            return_value=self.root,
        ), mock.patch.object(
            V3_MODULE.subprocess,
            "run",
            return_value=completed,
        ) as runner:
            result = V3_MODULE.run_integrity_dropbox_currentness_gate(
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                dropbox_root=self.root,
                observations_prefix="history/v2/observations",
                timeseries_binding_backup_mode=(
                    parsed.timeseries_binding_backup_mode
                ),
            )
        command = runner.call_args.args[0]
        mode_index = command.index("--timeseries-binding-backup-mode")
        self.assertEqual(command[mode_index + 1], "pack")
        self.assertTrue(result["allowed"])

    def _format_binding_summary(
        self,
        binding_result: dict[str, object] | None,
    ) -> str:
        history_result: dict[str, object] = {}
        if binding_result is not None:
            history_result["timeseries_bindings"] = binding_result
        return MODULE.format_summary_md({
            "env": "TEST",
            "profile": "manual",
            "started_at_utc": "2026-09-04T12:00:00Z",
            "status": "ok",
            "source": "sos",
            "dry_run": False,
            "check_only": True,
            "run_backfill": False,
            "db_path": ":memory:",
            "log_path": "tmp/test.log",
            "checked_versions": ["v2"],
            "history_version_results": {"v2": history_result},
            "cross_check": {"ran": True},
        })

    def test_individual_summary_omits_binding_input_section(self) -> None:
        markdown = self._format_binding_summary(None)
        self.assertNotIn("### SOS timeseries binding input", markdown)

    def test_pack_summary_renders_binding_input_section(self) -> None:
        markdown = self._format_binding_summary({
            "stage": "check_only",
            "status": "ok",
            "gap_count": 0,
            "gaps": [],
            "provider": {
                "mode": "pack",
                "ranges_verified": 143,
            },
        })
        self.assertIn("### SOS timeseries binding input", markdown)
        self.assertIn("- Mode: pack", markdown)
        self.assertIn("- Ranges verified: 143", markdown)


if __name__ == "__main__":
    unittest.main()
