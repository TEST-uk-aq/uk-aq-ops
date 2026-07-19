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
const { createCombinedLocalStore } = await import(process.argv[1]);
const { applyValidatedProposal, validateLocalProposal } = await import(process.argv[2]);
const statePath = process.argv[3];
const overlayRoot = process.argv[4];
const dropboxRoot = process.argv[5];
const connectorPrefix = process.argv[6];
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const store = createCombinedLocalStore({
  overlayRoot, dropboxRoot, runStateJson: statePath, prefixes: [connectorPrefix],
});
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
            metadata_only_state = {
                "environment": "CIC-Test",
                "base_dropbox_root": str(dropbox),
                "objects": {
                    metadata_manifest.relative_to(overlay).as_posix(): {
                        "proposed": True, "built": True, "structurally_validated": True,
                        "local_path": str(metadata_manifest), "sha256": metadata_sha,
                        "bytes": metadata_bytes,
                        "dependencies": [baseline_part.relative_to(dropbox).as_posix()],
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


if __name__ == "__main__":
    unittest.main()
