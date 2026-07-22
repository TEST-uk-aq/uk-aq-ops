#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_source_evidence_identity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class SourceEvidenceIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def evidence(
        self,
        *,
        rows: list[dict[str, object]] | None = None,
        registry_hash: str = "1" * 64,
        authoritative_mapping_hash: str = "2" * 64,
        property_mapping_hash: str = "3" * 64,
    ) -> tuple[dict[str, object], list[dict[str, object]]]:
        canonical_rows = list(rows or [])
        rows_bytes = canonical_bytes(canonical_rows)
        evidence: dict[str, object] = {
            "source_adapter": "sos",
            "day_utc": "2026-07-18",
            "connector_id": 1,
            "source_file_identities_sha256": "4" * 64,
            "requested_pollutant_set": ["no2", "pm10", "pm25"],
            "contract": "pollutant_scoped_authoritative_connector_day_source_rows",
            "evidence_contract_version": MODULE.SOURCE_EVIDENCE_CONTRACT_VERSION,
            "source_label_registry_snapshot_content_sha256": registry_hash,
            "authoritative_station_timeseries_mapping_sha256": authoritative_mapping_hash,
            "observed_property_mapping_sha256": property_mapping_hash,
            "canonical_rows_sha256": hashlib.sha256(rows_bytes).hexdigest(),
            "canonical_rows_bytes": len(rows_bytes),
        }
        evidence["source_evidence_input_sha256"] = MODULE._source_evidence_input_sha256(
            evidence
        )
        return evidence, canonical_rows

    def test_same_semantic_identity_and_output_reuses_record(self) -> None:
        conn = MODULE.open_db(str(self.root / "reuse.sqlite"))
        try:
            evidence, rows = self.evidence()
            first = MODULE._persist_complete_connector_day_source_evidence(
                conn=conn, env_name="CIC-Test", evidence=evidence,
                canonical_rows=rows,
            )
            repeated_evidence = dict(evidence)
            repeated_evidence["source_label_registry_snapshot_file"] = (
                "/different/run/root/registry.json"
            )
            repeated_evidence["source_label_registry_snapshot_file_sha256"] = (
                "9" * 64
            )
            second = MODULE._persist_complete_connector_day_source_evidence(
                conn=conn, env_name="CIC-Test", evidence=repeated_evidence,
                canonical_rows=rows,
            )
            self.assertEqual(first, second)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM source_connector_day_evidence").fetchone()[0],
                1,
            )
        finally:
            conn.close()

    def test_same_semantic_identity_with_different_output_fails_closed(self) -> None:
        conn = MODULE.open_db(str(self.root / "conflict.sqlite"))
        try:
            evidence, rows = self.evidence()
            MODULE._persist_complete_connector_day_source_evidence(
                conn=conn, env_name="CIC-Test", evidence=evidence,
                canonical_rows=rows,
            )
            changed, changed_rows = self.evidence(rows=[{"timeseries_id": 1}])
            with self.assertRaisesRegex(RuntimeError, "identical semantic inputs"):
                MODULE._persist_complete_connector_day_source_evidence(
                    conn=conn, env_name="CIC-Test", evidence=changed,
                    canonical_rows=changed_rows,
                )
        finally:
            conn.close()

    def test_registry_or_mapping_change_preserves_distinct_evidence(self) -> None:
        conn = MODULE.open_db(str(self.root / "semantic-change.sqlite"))
        try:
            variants = (
                self.evidence(),
                self.evidence(registry_hash="5" * 64),
                self.evidence(authoritative_mapping_hash="6" * 64),
            )
            ids = []
            for evidence, rows in variants:
                ids.append(MODULE._persist_complete_connector_day_source_evidence(
                    conn=conn, env_name="CIC-Test", evidence=evidence,
                    canonical_rows=rows,
                )["evidence_id"])
            self.assertEqual(len(set(ids)), 3)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM source_connector_day_evidence").fetchone()[0],
                3,
            )
        finally:
            conn.close()

    def test_legacy_table_migration_preserves_row_and_allows_new_identity(self) -> None:
        db_path = self.root / "legacy.sqlite"
        legacy = sqlite3.connect(db_path)
        legacy.executescript(
            """
            CREATE TABLE source_connector_day_evidence (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              env_name TEXT NOT NULL,
              day_utc TEXT NOT NULL,
              connector_id INTEGER NOT NULL,
              source_adapter TEXT NOT NULL,
              source_file_identities_sha256 TEXT NOT NULL,
              canonical_rows_sha256 TEXT NOT NULL,
              canonical_rows_bytes INTEGER NOT NULL,
              evidence_sha256 TEXT NOT NULL,
              evidence_json TEXT NOT NULL,
              canonical_rows_json TEXT NOT NULL,
              created_at_utc TEXT NOT NULL,
              UNIQUE (env_name, day_utc, connector_id, source_file_identities_sha256)
            );
            CREATE INDEX idx_source_connector_day_evidence_lookup
              ON source_connector_day_evidence(env_name, day_utc, connector_id, id DESC);
            """
        )
        legacy.execute(
            """
            INSERT INTO source_connector_day_evidence VALUES
              (1, 'CIC-Test', '2026-07-18', 1, 'sos', ?, ?, 2, ?, '{}', '[]', ?)
            """,
            ("4" * 64, hashlib.sha256(b"[]").hexdigest(), "7" * 64,
             "2026-07-18T00:00:00Z"),
        )
        legacy.commit()
        legacy.close()

        conn = MODULE.open_db(str(db_path))
        try:
            migrated = conn.execute(
                "SELECT id, source_evidence_input_sha256 "
                "FROM source_connector_day_evidence ORDER BY id"
            ).fetchall()
            self.assertEqual(migrated, [(1, None)])
            evidence, rows = self.evidence()
            inserted = MODULE._persist_complete_connector_day_source_evidence(
                conn=conn, env_name="CIC-Test", evidence=evidence,
                canonical_rows=rows,
            )
            self.assertNotEqual(inserted["evidence_id"], 1)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM source_connector_day_evidence").fetchone()[0],
                2,
            )
            conn.commit()
        finally:
            conn.close()
        reopened = MODULE.open_db(str(db_path))
        try:
            self.assertEqual(
                reopened.execute(
                    "SELECT id, source_evidence_input_sha256 "
                    "FROM source_connector_day_evidence ORDER BY id"
                ).fetchall(),
                [(1, None), (2, evidence["source_evidence_input_sha256"])],
            )
        finally:
            reopened.close()

    def test_zero_canonical_rows_with_missing_bindings_is_valid(self) -> None:
        stage_root = self.root / "stage"
        source_dir = stage_root / "day_utc=2026-07-18" / "connector_id=1"
        source_dir.mkdir(parents=True)
        rows_bytes = b"[]"
        (source_dir / "obs_history_rows.json").write_bytes(rows_bytes)
        evidence: dict[str, object] = {
            "schema_version": 1,
            "contract": "pollutant_scoped_authoritative_connector_day_source_rows",
            "evidence_contract_version": MODULE.SOURCE_EVIDENCE_CONTRACT_VERSION,
            "requested_pollutant_set": ["pm10"],
            "connector_id": 1,
            "day_utc": "2026-07-18",
            "source_adapter": "sos",
            "enumeration_complete": True,
            "files_required": [], "files_read": [],
            "files_authoritatively_absent": [], "source_file_identities": [],
            "source_file_identities_sha256": hashlib.sha256(b"[]").hexdigest(),
            "source_label_registry_snapshot_content_sha256": "1" * 64,
            "authoritative_station_timeseries_mapping_sha256": "2" * 64,
            "observed_property_mapping_sha256": "3" * 64,
            "canonical_rows_sha256": hashlib.sha256(rows_bytes).hexdigest(),
            "canonical_rows_bytes": len(rows_bytes), "total_rows": 0,
            "per_timeseries_counts": {}, "per_pollutant_counts": {},
            "pollutant_set": [], "blocked_row_count": 0,
            "inactive_identity_rows_skipped": 0,
            "source_records_examined": 24,
            "source_csv_records_scanned": 8760,
            "canonical_rows_mapped": 0,
            "missing_binding_groups": 1,
            "missing_binding_rows": 24,
            "source_label_classification_counts": {
                "no_authoritative_timeseries_binding": 1,
            },
            "source_label_target_day_row_counts": {
                "no_authoritative_timeseries_binding": 24,
            },
            "source_label_summary": {}, "source_label_classifications": [],
        }
        evidence["source_evidence_input_sha256"] = MODULE._source_evidence_input_sha256(
            evidence
        )
        (source_dir / "source-evidence.json").write_text(
            json.dumps(evidence), encoding="utf-8"
        )
        loaded, rows = MODULE._load_complete_connector_day_source_evidence(
            stage_root=stage_root, day_utc="2026-07-18", connector_id=1,
            repair_pollutants=["pm10"],
        )
        self.assertEqual(rows, [])
        self.assertEqual(loaded["canonical_rows_mapped"], 0)
        self.assertEqual(loaded["source_records_examined"], 24)

    def test_nonnegative_integer_validation_rejects_invalid_values(self) -> None:
        self.assertEqual(MODULE._require_nonnegative_evidence_int({"value": 0}, "value"), 0)
        for evidence in ({}, {"value": True}, {"value": -1}, {"value": 1.5}):
            with self.subTest(evidence=evidence):
                with self.assertRaises(ValueError):
                    MODULE._require_nonnegative_evidence_int(evidence, "value")


if __name__ == "__main__":
    unittest.main()
