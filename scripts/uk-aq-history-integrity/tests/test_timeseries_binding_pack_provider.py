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


def stable_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def binding_bytes(timeseries_id: int, connector_id: int, pollutant: str) -> bytes:
    return stable_bytes({
        "schema_version": 1,
        "history_version": "v2",
        "index_kind": "timeseries_binding",
        "timeseries_id": timeseries_id,
        "connector_id": connector_id,
        "pollutant_code": pollutant,
    })


class PackedBindingFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
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
                        f"{PROVIDER.BINDING_PREFIX}/timeseries_id={timeseries_id}.json",
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
                "source_prefix": PROVIDER.BINDING_PREFIX,
                "source_range_hash": source_range_hash,
                "member_count": len(packed_members),
                "members": packed_members,
            }
            pack_body = stable_bytes(pack)
            relative_path = (
                f"{PROVIDER.PACK_PREFIX}/range={start:06d}-{end:06d}/"
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
            "source_prefix": PROVIDER.BINDING_PREFIX,
            "source_root_key": f"{PROVIDER.BINDING_PREFIX}/_manifests/root.json",
            "source_root_hash": self.source_root_hash,
            "range_count": len(references),
            "member_count": sum(int(item["member_count"]) for item in references),
            "ranges": references,
        }
        pack_root_body = stable_bytes(pack_root)
        pack_root_path = self.root / PROVIDER.PACK_ROOT_PATH
        pack_root_path.parent.mkdir(parents=True, exist_ok=True)
        pack_root_path.write_bytes(pack_root_body)

        state_ranges = []
        for reference in references:
            start = int(reference["range_start"])
            end = int(reference["range_end"])
            shard_key = (
                f"{PROVIDER.STATE_ROOT_PREFIX}/timeseries_binding_packs/"
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
                "pack_root_relative_path": PROVIDER.PACK_ROOT_PATH,
                "pack_root_size": len(pack_root_body),
                "copied_at": "2026-09-04T12:00:01.000Z",
                "verified": True,
                "ranges": state_ranges,
            },
        }
        state_path = self.root / PROVIDER.STATE_ROOT_PATH
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

    def test_cli_defaults_to_individual_and_accepts_explicit_test_pack(self) -> None:
        common = [
            "--env", "TEST", "--source", "sos", "--check-only",
            "--from-day", "2026-06-01", "--to-day", "2026-06-01",
        ]
        individual = MODULE.parse_args(common)
        self.assertEqual(individual.timeseries_binding_backup_mode, "individual")
        packed = MODULE.parse_args([
            *common,
            "--timeseries-binding-backup-mode", "pack",
            "--timeseries-binding-pack-root", str(self.root),
        ])
        self.assertEqual(packed.timeseries_binding_backup_mode, "pack")
        self.assertEqual(packed.timeseries_binding_pack_root, str(self.root))

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


if __name__ == "__main__":
    unittest.main()
