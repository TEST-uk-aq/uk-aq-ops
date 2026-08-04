#!/usr/bin/env python3
"""Focused v2-only core snapshot contract tests."""

from __future__ import annotations

import importlib.util
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def writer_shaped_v2_manifest(day_utc: str) -> dict[str, object]:
    prefix = "history/v2/core"
    tables = []
    for table in MODULE.CORE_TABLES_TO_IMPORT:
        relative_path = f"table={table}/rows.ndjson.gz"
        tables.append({
            "table": table,
            "order_by": "id",
            "relative_path": relative_path,
            "key": f"{prefix}/day_utc={day_utc}/{relative_path}",
            "row_count": 0,
            "uncompressed_bytes": 0,
            "compressed_bytes": 0,
            "sha256": "0" * 64,
            "sha256_uncompressed": "0" * 64,
        })
    return {
        "schema_name": "uk_aq_core_snapshot",
        "schema_version": 1,
        "generated_at_utc": "2026-07-13T00:00:00.000Z",
        "day_utc": day_utc,
        "source_schema": "uk_aq_core",
        "prefix": prefix,
        "file_format": "ndjson.gz",
        "tables": tables,
        "totals": {"table_count": len(tables), "total_rows": 0},
        "checksums": {"key": f"{prefix}/day_utc={day_utc}/checksums.sha256", "algorithm": "sha256", "sha256": "0" * 64},
        "manifest_hash": "1" * 64,
    }


def write_complete_v2_snapshot(root: Path, day_utc: str) -> dict[str, str]:
    prefix = "history/v2/core"
    day_dir = root / f"day_utc={day_utc}"
    day_dir.mkdir(parents=True, exist_ok=True)
    rows_by_table = {
        "connectors": [{"id": 1, "connector_code": "sos"}],
        "stations": [{
            "id": 10,
            "connector_id": 1,
            "station_ref": "ABC",
        }],
        "timeseries": [{
            "id": 100,
            "station_id": 10,
            "connector_id": 1,
            "timeseries_ref": "sos-no2",
            "phenomenon_id": 1000,
        }],
        "phenomena": [{
            "id": 1000,
            "connector_id": 1,
            "source_label": "Nitrogen dioxide",
            "observed_property_id": 10000,
        }],
        "observed_property_mappings": [{
            "id": 10000,
            "connector_id": 1,
            "source_label": "Nitrogen dioxide",
            "source_uom": "ug/m3",
            "observed_property_id": 10000,
            "observed_property_code": "no2",
            "mapping_kind": "raw_observed_property",
            "is_active": True,
        }],
        "sos_station_timeseries_site_refs": [{
            "site_ref": "ABC",
            "uk_air_ref": "ABC",
            "pollutant_code": "no2",
            "station_id": 10,
            "timeseries_id": 100,
            "station_ref": "ABC",
            "timeseries_ref": "sos-no2",
        }],
    }
    tables = []
    checksum_lines = []
    writer_tables = (
        "connectors", "categories", "observed_properties",
        "observed_property_mappings", "phenomena", "offerings",
        "features", "procedures", "networks", "sos_networks",
        "sos_network_pollutants", "stations", "station_metadata",
        "timeseries", "sos_station_timeseries_site_refs",
    )
    for table in writer_tables:
        raw = "".join(
            json.dumps(row, separators=(",", ":")) + "\n"
            for row in rows_by_table.get(table, [])
        ).encode()
        compressed = gzip.compress(raw, mtime=0)
        relative_path = f"table={table}/rows.ndjson.gz"
        path = day_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(compressed)
        compressed_sha = hashlib.sha256(compressed).hexdigest()
        checksum_lines.append(f"{compressed_sha}  {relative_path}")
        tables.append({
            "table": table,
            "order_by": "id",
            "relative_path": relative_path,
            "key": f"{prefix}/day_utc={day_utc}/{relative_path}",
            "row_count": len(rows_by_table.get(table, [])),
            "uncompressed_bytes": len(raw),
            "compressed_bytes": len(compressed),
            "sha256": compressed_sha,
            "sha256_uncompressed": hashlib.sha256(raw).hexdigest(),
            **({"source_schema": "uk_aq_raw"}
               if table == "sos_station_timeseries_site_refs" else {}),
        })
    checksums_body = ("\n".join(checksum_lines) + "\n").encode()
    (day_dir / "checksums.sha256").write_bytes(checksums_body)
    manifest_without_hash = {
        "schema_name": "uk_aq_core_snapshot",
        "schema_version": 1,
        "generated_at_utc": f"{day_utc}T00:00:00.000Z",
        "day_utc": day_utc,
        "source_schema": "uk_aq_core",
        "prefix": prefix,
        "file_format": "ndjson.gz",
        "tables": tables,
        "totals": {
            "table_count": len(tables),
            "total_rows": sum(entry["row_count"] for entry in tables),
            "total_uncompressed_bytes": sum(
                entry["uncompressed_bytes"] for entry in tables
            ),
            "total_compressed_bytes": sum(
                entry["compressed_bytes"] for entry in tables
            ),
        },
        "checksums": {
            "key": f"{prefix}/day_utc={day_utc}/checksums.sha256",
            "algorithm": "sha256",
            "sha256": hashlib.sha256(checksums_body).hexdigest(),
        },
    }
    manifest_hash = hashlib.sha256(json.dumps(
        manifest_without_hash, separators=(",", ":"), ensure_ascii=False,
    ).encode()).hexdigest()
    manifest = {**manifest_without_hash, "manifest_hash": manifest_hash}
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode()
    (day_dir / "manifest.json").write_bytes(manifest_bytes)
    return {
        "manifest_hash": manifest_hash,
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }


class V2CoreSnapshotContractTests(unittest.TestCase):
    def test_latest_complete_snapshot_is_pinned_across_midnight_and_modes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup" / "history" / "v2" / "core"
            identity_2026_08_02 = write_complete_v2_snapshot(
                root, "2026-08-02",
            )
            identity_2026_08_03 = write_complete_v2_snapshot(
                root, "2026-08-03",
            )
            write_complete_v2_snapshot(root, "2026-08-04")
            incomplete = root / "day_utc=2026-08-04"
            (
                incomplete / "table=connectors" / "rows.ndjson.gz"
            ).unlink()

            selection = MODULE.select_latest_complete_core_snapshot(
                root,
                MODULE.logging.getLogger("test-latest-complete-core"),
                selected_at_utc="2026-08-03T23:59:00Z",
            )
            identity = selection["identity"]
            self.assertEqual(identity["core_snapshot_day_utc"], "2026-08-03")
            self.assertEqual(
                identity["core_snapshot_manifest_key"],
                "history/v2/core/day_utc=2026-08-03/manifest.json",
            )
            self.assertEqual(
                identity["core_snapshot_manifest_hash"],
                identity_2026_08_03["manifest_hash"],
            )
            self.assertEqual(
                identity["core_snapshot_manifest_sha256"],
                identity_2026_08_03["manifest_sha256"],
            )
            self.assertEqual(selection["candidate_days"], [
                "2026-08-04", "2026-08-03", "2026-08-02",
            ])
            self.assertEqual(
                selection["skipped_candidates"][0]["day_utc"],
                "2026-08-04",
            )
            self.assertIn(
                "snapshot file missing",
                selection["skipped_candidates"][0]["reason"],
            )

            coordinator_file = Path(tmp) / "pinned-core-identity.json"
            MODULE.write_core_snapshot_identity_file(coordinator_file, identity)
            child_payloads = []
            for mode in ("check_only", "dry_run", "write_enabled"):
                child_env = MODULE.core_snapshot_child_environment(
                    identity=identity,
                    identity_file=coordinator_file,
                    snapshot_root=root,
                    mode=mode,
                    stage="focused_midnight_child",
                )
                child_payloads.append(
                    child_env["UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_JSON"]
                )
                child = MODULE.validate_pinned_core_snapshot_identity(
                    coordinator_identity=identity,
                    requested_identity=json.loads(child_payloads[-1]),
                    snapshot_root=root,
                    stage=f"{mode}:after_2026-08-04T00:01:00Z",
                )
                self.assertEqual(
                    child["core_snapshot_manifest_key"],
                    identity["core_snapshot_manifest_key"],
                )
                self.assertNotIn("day_utc=2026-08-04", json.dumps(child))
            self.assertEqual(len(set(child_payloads)), 1)

            with self.assertRaisesRegex(ValueError, "identity is required"):
                MODULE.validate_pinned_core_snapshot_identity(
                    coordinator_identity=identity,
                    requested_identity=None,
                    snapshot_root=root,
                    stage="proposal",
                )
            contradictory = {
                **identity,
                "core_snapshot_day_utc": "2026-08-02",
                "core_snapshot_manifest_key": (
                    "history/v2/core/day_utc=2026-08-02/manifest.json"
                ),
                "core_snapshot_manifest_hash": identity_2026_08_02[
                    "manifest_hash"
                ],
                "core_snapshot_manifest_sha256": identity_2026_08_02[
                    "manifest_sha256"
                ],
            }
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                MODULE.validate_pinned_core_snapshot_identity(
                    coordinator_identity=identity,
                    requested_identity=contradictory,
                    snapshot_root=root,
                    stage="apply",
                )

            complete_root = Path(tmp) / "later" / "history" / "v2" / "core"
            complete_root.mkdir(parents=True)
            incomplete.rename(complete_root / incomplete.name)
            with self.assertRaisesRegex(ValueError, "no complete committed"):
                MODULE.select_latest_complete_core_snapshot(
                    complete_root,
                    MODULE.logging.getLogger("test-no-complete-core"),
                )

            write_complete_v2_snapshot(root, "2026-08-04")
            later_selection = MODULE.select_latest_complete_core_snapshot(
                root,
                MODULE.logging.getLogger("test-later-core-invocation"),
                selected_at_utc="2026-08-04T01:00:00Z",
            )
            self.assertEqual(
                later_selection["identity"]["core_snapshot_day_utc"],
                "2026-08-04",
            )
    def test_v2_core_root_is_the_only_supported_integrity_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup"
            env = {"UK_AQ_R2_HISTORY_DROPBOX_ROOT": str(root)}
            self.assertEqual(
                MODULE.resolve_core_snapshot_root("v2", env),
                str(root / "history" / "v2" / "core"),
            )
            with self.assertRaisesRegex(ValueError, "v2 only"):
                MODULE.resolve_core_snapshot_root("v1", env)
            with self.assertRaisesRegex(ValueError, "must target history/v2/core"):
                MODULE.resolve_core_snapshot_root(
                    "v2",
                    {"UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT": str(root / "history" / "v1" / "core")},
                )

    def test_importer_accepts_the_actual_v2_core_writer_manifest_layout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup" / "history" / "v2" / "core"
            write_complete_v2_snapshot(root, "2026-07-12")
            conn = MODULE.open_db(str(Path(tmp) / "integrity.sqlite"))
            try:
                result = MODULE.import_core_snapshot(
                    conn,
                    "CIC-Test",
                    str(root),
                    force=False,
                    dry_run=True,
                    log=MODULE.logging.getLogger("test-v2-core-manifest"),
                )
            finally:
                conn.close()
            self.assertEqual(result["status"], "dry_run")
            self.assertEqual(set(result["tables"]), set(MODULE.CORE_TABLES_TO_IMPORT))

    def test_importer_rejects_a_legacy_prefix_instead_of_falling_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "R2_history_backup" / "history" / "v2" / "core"
            day_dir = root / "day_utc=2026-07-12"
            day_dir.mkdir(parents=True)
            manifest = writer_shaped_v2_manifest("2026-07-12")
            manifest["prefix"] = "history/v1/core"
            (day_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIsNone(
                MODULE.find_latest_snapshot(root, MODULE.logging.getLogger("test-v2-core-manifest")),
            )

if __name__ == "__main__":
    unittest.main()
