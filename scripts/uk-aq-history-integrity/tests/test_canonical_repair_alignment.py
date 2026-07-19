#!/usr/bin/env python3
"""Focused local safety check for canonical Integrity proposal/apply boundaries."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
INTEGRITY_PATH = REPO_ROOT / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py"
METADATA_EXECUTOR = REPO_ROOT / "scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs"
APPLY_EXECUTOR = REPO_ROOT / "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs"


def load_integrity_module():
    spec = importlib.util.spec_from_file_location("uk_aq_history_integrity", INTEGRITY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load Integrity module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def identity(path: Path) -> tuple[str, int]:
    body = path.read_bytes()
    return hashlib.sha256(body).hexdigest(), len(body)


class CanonicalRepairAlignmentTest(unittest.TestCase):
    def test_aqi_local_build_is_proposal_validated_not_complete(self) -> None:
        import logging
        import time

        integrity = load_integrity_module()
        with tempfile.TemporaryDirectory(prefix="uk-aq-aqi-proposal-test-") as temp_raw:
            temp = Path(temp_raw)
            conn = integrity.open_db(str(temp / "integrity.sqlite"))
            conn.execute(
                """
                INSERT INTO aqi_rebuild_queue (
                  run_id, env_name, history_version, connector_id, day_utc,
                  reason, source_mode, status, created_at_utc
                ) VALUES (1, 'CIC-Test', 'v2', 7, '2026-07-12',
                          'obs_repaired', 'combined_local', 'queued',
                          '2026-07-19T00:00:00Z')
                """
            )
            conn.commit()
            original = integrity.run_aqi_rebuild_backfill
            integrity.run_aqi_rebuild_backfill = lambda **_kwargs: {
                "status": "ok", "log_path": None, "error": None,
            }
            try:
                result = integrity.run_aqi_rebuild_queue_execution(
                    conn, run_id=1, env_name="CIC-Test", run_compact="test",
                    env={"UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(temp / "logs")},
                    dry_run=False, run_backfill=True,
                    limits=integrity.LimitTracker(None, None, time.monotonic()),
                    log=logging.getLogger("aqi-proposal-test"),
                    history_version="v2",
                    skip_stale_local_post_validation=True,
                    execute_local_proposal=True,
                )
            finally:
                integrity.run_aqi_rebuild_backfill = original
            self.assertEqual(result["aqi_rebuilds_complete"], 0)
            self.assertEqual(result["aqi_rebuilds_proposal_validated"], 1)
            self.assertEqual(result["aqi_rebuild_results"][0]["status"], "proposal_validated")
            queue_status = conn.execute(
                "SELECT status FROM aqi_rebuild_queue WHERE run_id = 1"
            ).fetchone()[0]
            self.assertEqual(queue_status, "proposal_validated")
            conn.close()

    def test_exact_source_rows_are_required_before_tombstone(self) -> None:
        import duckdb

        integrity = load_integrity_module()
        with tempfile.TemporaryDirectory(prefix="uk-aq-source-evidence-test-") as temp_raw:
            temp = Path(temp_raw)
            dropbox = temp / "dropbox"
            dropbox.mkdir()
            run_state = integrity.create_run_overlay(
                tmp_dir=temp, run_id="exact", environment="CIC-Test",
                base_dropbox_root=dropbox,
            )
            day = "2026-07-12"
            connector_id = 7
            connector_prefix = (
                f"history/v2/observations/day_utc={day}/connector_id={connector_id}"
            )
            source_root = (
                Path(run_state["overlay_root"]) / "generated-objects" / connector_prefix
            )
            part_path = source_root / "pollutant_code=pm25/part-00000.parquet"
            part_path.parent.mkdir(parents=True)
            connection = duckdb.connect(database=":memory:")
            try:
                connection.execute(
                    """
                    COPY (
                      SELECT 7::INTEGER connector_id, 70::INTEGER station_id,
                             700::INTEGER timeseries_id, 'pm25'::VARCHAR pollutant_code,
                             TIMESTAMP '2026-07-12 01:00:00' observed_at_utc,
                             12.5::DOUBLE "value", 'V'::VARCHAR status
                    ) TO ? (FORMAT PARQUET)
                    """,
                    [str(part_path)],
                )
            finally:
                connection.close()
            manifest = {
                "history_version": "v2", "domain": "observations",
                "day_utc": day, "connector_id": connector_id,
                "source_row_count": 1, "timeseries_row_counts": {"700": 1},
                "pollutant_codes": ["pm25"],
                "child_manifests": [
                    {"pollutant_code": "pm25", "source_row_count": 1}
                ],
            }
            (source_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            evidence_root = (
                Path(run_state["overlay_root"]) /
                f"day_utc={day}/connector_id={connector_id}"
            )
            evidence_root.mkdir(parents=True)
            source_rows = [{
                "timeseries_id": 700, "station_id": 70,
                "pollutant_code": "pm25",
                "observed_at": "2026-07-12T01:00:00.000Z",
                "value": 12.5, "status": "V",
            }]
            rows_body = json.dumps(source_rows, separators=(",", ":")).encode()
            (evidence_root / "obs_history_rows.json").write_bytes(rows_body)
            evidence = {
                "schema_version": 1,
                "contract": "complete_authoritative_connector_day_source_rows",
                "connector_id": connector_id, "day_utc": day,
                "source_adapter": "sensorcommunity", "enumeration_complete": True,
                "files_enumerated": ["source.csv"],
                "files_required": ["source.csv"], "files_read": ["source.csv"],
                "files_authoritatively_absent": [],
                "canonical_rows_sha256": hashlib.sha256(rows_body).hexdigest(),
                "canonical_rows_bytes": len(rows_body), "total_rows": 1,
                "per_timeseries_counts": {"700": 1},
                "per_pollutant_counts": {"pm25": 1}, "pollutant_set": ["pm25"],
                "blocked_row_count": 0, "skipped_row_count": 0,
                "inactive_identity_rows_skipped": 0,
            }
            (evidence_root / "source-evidence.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            keys = integrity._capture_local_v2_observation_scope(
                run_state=run_state, day_utc=day, connector_id=connector_id,
            )
            self.assertIn(f"{connector_prefix}/pollutant_code=pm25/part-00000.parquet", keys)
            self.assertEqual(run_state["tombstone_prefixes"][0]["prefix"], connector_prefix)

            bad_state = integrity.create_run_overlay(
                tmp_dir=temp, run_id="mismatch", environment="CIC-Test",
                base_dropbox_root=dropbox,
            )
            bad_generated = Path(bad_state["overlay_root"]) / "generated-objects" / connector_prefix
            bad_generated.parent.mkdir(parents=True, exist_ok=True)
            import shutil
            shutil.copytree(source_root, bad_generated)
            bad_evidence_root = (
                Path(bad_state["overlay_root"]) /
                f"day_utc={day}/connector_id={connector_id}"
            )
            bad_evidence_root.mkdir(parents=True)
            bad_rows = [{**source_rows[0], "value": 99.0}]
            bad_body = json.dumps(bad_rows, separators=(",", ":")).encode()
            (bad_evidence_root / "obs_history_rows.json").write_bytes(bad_body)
            bad_evidence = {
                **evidence,
                "canonical_rows_sha256": hashlib.sha256(bad_body).hexdigest(),
                "canonical_rows_bytes": len(bad_body),
            }
            (bad_evidence_root / "source-evidence.json").write_text(
                json.dumps(bad_evidence), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "do not exactly match"):
                integrity._capture_local_v2_observation_scope(
                    run_state=bad_state, day_utc=day, connector_id=connector_id,
                )
            self.assertEqual(bad_state["tombstone_prefixes"], [])

    def test_modes_and_local_proposal_safety(self) -> None:
        integrity = load_integrity_module()
        check_args = argparse.Namespace(run_backfill=False, dry_run=False)
        dry_args = argparse.Namespace(run_backfill=True, dry_run=True)
        apply_args = argparse.Namespace(run_backfill=True, dry_run=False)
        self.assertEqual(integrity.resolve_effective_mode(check_args), "check_only")
        self.assertEqual(integrity.resolve_effective_mode(dry_args), "repair_dry_run")
        self.assertEqual(integrity.resolve_effective_mode(apply_args), "repair_apply")
        self.assertFalse(integrity.mode_creates_repair_overlay("check_only"))
        self.assertFalse(integrity.mode_allows_remote_apply("check_only"))
        self.assertTrue(integrity.mode_creates_repair_overlay("repair_dry_run"))
        self.assertFalse(integrity.mode_allows_remote_apply("repair_dry_run"))
        self.assertFalse(integrity.source_acquisition_dry_run("repair_dry_run"))
        self.assertTrue(integrity.mode_allows_remote_apply("repair_apply"))

        with tempfile.TemporaryDirectory(prefix="uk-aq-canonical-repair-test-") as temp_raw:
            temp = Path(temp_raw)
            audit_db = integrity.open_db(str(temp / "integrity.sqlite"))
            try:
                audit_columns = {
                    row[1]
                    for row in audit_db.execute("PRAGMA table_info(integrity_object_operations)")
                }
                self.assertTrue({"planned", "remote_completed", "get_verified", "delete_verified"} <= audit_columns)
            finally:
                audit_db.close()
            dropbox = temp / "dropbox"
            overlay = temp / "overlay"
            connector_prefix = "history/v2/observations/day_utc=2026-07-12/connector_id=7"
            pollutant_prefix = f"{connector_prefix}/pollutant_code=pm25"
            stale_part = dropbox / pollutant_prefix / "part-00001.parquet"
            baseline_part = dropbox / pollutant_prefix / "part-00000.parquet"
            replacement_part = overlay / pollutant_prefix / "part-00000.parquet"
            replacement_manifest = overlay / connector_prefix / "manifest.json"
            metadata_manifest = overlay / pollutant_prefix / "manifest.json"
            for path, body in (
                (stale_part, b"stale-surplus"),
                (baseline_part, b"old-valid-parquet"),
                (replacement_part, b"complete-source-connector-day"),
                (replacement_manifest, b'{"domain":"observations","manifest_kind":"connector"}\n'),
                (metadata_manifest, b'{"domain":"observations","manifest_kind":"pollutant"}\n'),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)

            replacement_key = replacement_part.relative_to(overlay).as_posix()
            connector_manifest_key = replacement_manifest.relative_to(overlay).as_posix()
            replacement_sha, replacement_bytes = identity(replacement_part)
            connector_sha, connector_bytes = identity(replacement_manifest)
            run_state = {
                "environment": "CIC-Test",
                "base_dropbox_root": str(dropbox),
                "objects": {
                    replacement_key: {
                        "proposed": True, "built": True, "structurally_validated": True,
                        "local_path": str(replacement_part), "sha256": replacement_sha,
                        "bytes": replacement_bytes, "dependencies": [],
                    },
                    connector_manifest_key: {
                        "proposed": True, "built": True, "structurally_validated": True,
                        "local_path": str(replacement_manifest), "sha256": connector_sha,
                        "bytes": connector_bytes, "dependencies": [replacement_key],
                    },
                },
                "tombstones": {},
                "tombstone_prefixes": [{"prefix": connector_prefix, "proposed": True}],
            }
            state_path = temp / "run-state.json"
            state_path.write_text(json.dumps(run_state), encoding="utf-8")

            node_program = r"""
import fs from "node:fs";
const { createCombinedLocalStore, createStagedObjectMap } = await import(process.argv[1]);
const { applyValidatedProposal, validateLocalProposal } = await import(process.argv[2]);
const statePath = process.argv[3];
const overlayRoot = process.argv[4];
const dropboxRoot = process.argv[5];
const connectorPrefix = process.argv[6];
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const store = createCombinedLocalStore({
  overlayRoot, dropboxRoot, runStateJson: statePath, prefixes: [connectorPrefix],
});
const dependencyBody = Buffer.from("unchanged-dropbox-dependency");
const dependencyKey = "history/v2/observations/day_utc=2026-07-11/connector_id=7/manifest.json";
const identityPlanner = createStagedObjectMap({
  r2: {},
  store: {
    getObjectIfExists: (key) => key === dependencyKey ? {
      key, body: dependencyBody, bytes: dependencyBody.byteLength,
      source: "dropbox", content_sha256: null,
    } : null,
  },
});
const identityProposal = await identityPlanner.stage({
  key: "history/_index_v2/observations_timeseries/pm25.json",
  body: "{}", kind: "pollutant_timeseries_index", dependencies: [dependencyKey],
});
if (identityProposal.dependency_identities[dependencyKey].bytes !== dependencyBody.byteLength) {
  throw new Error("metadata planning did not pin the unchanged Dropbox dependency identity");
}
const listed = await store.listAllObjects({ prefix: `${connectorPrefix}/` });
if (listed.some((entry) => entry.key.endsWith("part-00001.parquet"))) {
  throw new Error("proposed prefix tombstone exposed a stale Dropbox part");
}
if (!listed.some((entry) => entry.key.endsWith("part-00000.parquet") && entry.source === "overlay")) {
  throw new Error("structurally validated replacement did not win combined-local resolution");
}
const proposal = validateLocalProposal(state);
if (proposal.prefixes.length !== 1 || proposal.prefixes[0].prefix !== connectorPrefix) {
  throw new Error("planned deletion escaped the intended connector-day");
}
if (proposal.objects.some((entry) => entry.key.includes("generation=") || entry.key.includes("data-receipt"))) {
  throw new Error("non-canonical transaction object was planned");
}
const incomplete = structuredClone(state);
incomplete.objects[Object.keys(incomplete.objects)[0]].structurally_validated = false;
let incompleteRejected = false;
try { validateLocalProposal(incomplete); } catch { incompleteRejected = true; }
if (!incompleteRejected) throw new Error("apply preflight accepted incomplete structural validation");
const incompletePath = `${statePath}.incomplete`;
fs.writeFileSync(incompletePath, JSON.stringify(incomplete));
let remoteCalls = 0;
const remoteAdapter = async () => { remoteCalls += 1; throw new Error("remote adapter must not run"); };
let applyRejected = false;
try {
  await applyValidatedProposal({
    runStatePath: incompletePath,
    r2: {},
    adapters: {
      deleteObjects: remoteAdapter,
      getObject: remoteAdapter,
      listAllObjects: remoteAdapter,
      putObject: remoteAdapter,
    },
  });
} catch { applyRejected = true; }
if (!applyRejected || remoteCalls !== 0) {
  throw new Error("apply reached a remote adapter before complete structural validation");
}
const broadDelete = structuredClone(state);
broadDelete.tombstone_prefixes[0].prefix = "history/v2/observations/day_utc=2026-07-12";
let broadDeleteRejected = false;
try { validateLocalProposal(broadDelete); } catch { broadDeleteRejected = true; }
if (!broadDeleteRejected) throw new Error("apply preflight accepted a non-connector deletion prefix");
for (const prefix of [
  "history/v2/observations/day_utc=2026-07-12/connector_id=7",
  "history/v2/aqilevels/hourly/data/day_utc=2026-07-12/connector_id=7",
  "history/v2/aqilevels/hourly/debug/day_utc=2026-07-12/connector_id=7",
]) {
  const allowed = structuredClone(state);
  allowed.tombstone_prefixes = [{ prefix, proposed: true }];
  validateLocalProposal(allowed);
}
for (const prefix of [
  "history/v2/observations",
  "history/v2/observations/day_utc=2026-02-30/connector_id=7",
  "history/v2/observations/day_utc=2026-07-12/connector_id=0",
  "history/v2/observations/day_utc=2026-07-12/connector_id=07",
  "history/v2/observations/day_utc=2026-07-12/connector_id=7/pollutant_code=pm25",
  "history/v2/observations/day_utc=2026-07-12/connector_id=7/generation=x",
  "history/v2/observations/day_utc=2026-07-12/connector_id=7/transactions",
  "history/v2/observations/day_utc=2026-07-12/connector_id=7/transactions/transaction_id=x/data-receipt.json",
  "history/v2/observations_timeseries",
  "history/v2/aqilevels_hourly/day_utc=2026-07-12/connector_id=7",
]) {
  const rejected = structuredClone(state);
  rejected.tombstone_prefixes = [{ prefix, proposed: true }];
  let didReject = false;
  try { validateLocalProposal(rejected); } catch { didReject = true; }
  if (!didReject) throw new Error(`apply preflight accepted forbidden deletion prefix: ${prefix}`);
}
"""
            subprocess.run(
                [
                    "node", "--input-type=module", "--eval", node_program,
                    METADATA_EXECUTOR.as_uri(), APPLY_EXECUTOR.as_uri(), str(state_path),
                    str(overlay), str(dropbox), connector_prefix,
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )

            baseline_before = baseline_part.read_bytes()
            metadata_sha, metadata_bytes = identity(metadata_manifest)
            baseline_sha, baseline_bytes = identity(baseline_part)
            baseline_key = baseline_part.relative_to(dropbox).as_posix()
            metadata_only_state = {
                "environment": "CIC-Test",
                "base_dropbox_root": str(dropbox),
                "objects": {
                    metadata_manifest.relative_to(overlay).as_posix(): {
                        "proposed": True, "built": True, "structurally_validated": True,
                        "local_path": str(metadata_manifest), "sha256": metadata_sha,
                        "bytes": metadata_bytes,
                        "dependencies": [baseline_key],
                        "dependency_identities": {
                            baseline_key: {
                                "sha256": baseline_sha,
                                "bytes": baseline_bytes,
                                "source": "dropbox",
                            },
                        },
                    },
                },
                "tombstone_prefixes": [],
            }
            metadata_state_path = temp / "metadata-only-state.json"
            metadata_state_path.write_text(json.dumps(metadata_only_state), encoding="utf-8")
            subprocess.run(
                [
                    "node", "--input-type=module", "--eval",
                    "import fs from 'node:fs'; const { validateLocalProposal } = await import(process.argv[1]); "
                    "validateLocalProposal(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));",
                    APPLY_EXECUTOR.as_uri(), str(metadata_state_path),
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(baseline_part.read_bytes(), baseline_before)

            baseline_part.write_bytes(b"changed-after-planning")
            changed_dependency_program = r"""
import fs from "node:fs";
const { applyValidatedProposal } = await import(process.argv[1]);
let remoteCalls = 0;
const remoteAdapter = async () => { remoteCalls += 1; throw new Error("remote adapter must not run"); };
let rejected = false;
try {
  await applyValidatedProposal({
    runStatePath: process.argv[2], r2: {},
    adapters: { deleteObjects: remoteAdapter, getObject: remoteAdapter,
      listAllObjects: remoteAdapter, putObject: remoteAdapter },
  });
} catch { rejected = true; }
if (!rejected || remoteCalls !== 0) {
  throw new Error("changed Dropbox dependency reached a remote operation");
}
"""
            subprocess.run(
                [
                    "node", "--input-type=module", "--eval",
                    changed_dependency_program, APPLY_EXECUTOR.as_uri(),
                    str(metadata_state_path),
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )


if __name__ == "__main__":
    unittest.main()
