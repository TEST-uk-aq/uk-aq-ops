#!/usr/bin/env python3
"""Focused v2-only core snapshot contract tests."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
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


class V2CoreSnapshotContractTests(unittest.TestCase):
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
            day_dir = root / "day_utc=2026-07-12"
            day_dir.mkdir(parents=True)
            (day_dir / "manifest.json").write_text(
                json.dumps(writer_shaped_v2_manifest("2026-07-12")),
                encoding="utf-8",
            )
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
