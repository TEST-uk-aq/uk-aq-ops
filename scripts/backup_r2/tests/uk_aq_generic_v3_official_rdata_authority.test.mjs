import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  requireGenericV3OfficialRdataAuthority,
} from "../lib/generic_v3_proposal_validation.mjs";

function fixture(root) {
  const proposalInput = {
    history_generation: "v3",
    day_utc: "2026-10-08",
    connector_id: 9,
    source_adapter: "waqn",
    requested_pollutant_set: ["no2"],
    backed_up_at_utc: "2026-10-09T00:00:00Z",
    rows: [{
      connector_id: 9,
      station_id: 101,
      timeseries_id: 35030407,
      pollutant_code: "no2",
      observed_at_utc: "2026-10-08T18:00:00.000Z",
      value: 1.72125,
      verification_status: "P",
    }],
    preserved_baseline_rows: [],
    preserved_baseline_identity: { source: "dropbox", partition_identities: [] },
    source_unavailable_scopes: [],
    source_available_timeseries_ids: [35030407],
    source_available_pollutant_codes: ["no2"],
    source_unavailable_timeseries_ids: [],
    source_file_identities: [{
      source_file: "waqn:site_ref=CARD:year=2026",
      sha256: "8".repeat(64),
      bytes: 100,
    }],
    required_source_files: ["waqn:site_ref=CARD:year=2026"],
    authoritatively_absent_source_files: [],
    authoritative_mapping_sha256: "a".repeat(64),
    observed_property_mapping_sha256: "b".repeat(64),
    ratification_audit: [],
    mapping_audit: { mapped_source_groups: [], excluded_source_groups: [] },
    rscript_identity: { executable: "/usr/bin/Rscript", version: "test" },
  };
  const inputPath = path.join(root, "input.json");
  const stageRoot = path.join(root, "stage");
  fs.writeFileSync(inputPath, JSON.stringify(proposalInput));
  execFileSync("node", [
    "scripts/uk-aq-history-integrity/bin/integrity/official_network_rdata_proposal.mjs",
    inputPath,
    stageRoot,
    "history/v3/observations",
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    "v3",
  ]);
  return {
    execution_path: "generic_integrity",
    history_generation: "v3",
    official_rdata_source_adapter: "waqn",
    overlay_root: stageRoot,
    generic_integrity_selected_scope_authority: {
      contract_version: "uk_aq_generic_integrity_v3_selected_scope_authority_v3",
      history_generation: "v3",
      selected_scopes: [{
        day_utc: "2026-10-08",
        connector_id: 9,
        pollutant_code: "no2",
      }],
    },
  };
}

test("generic fixed-v3 binds v9 source without an external certificate", () => {
  assert.equal(
    GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    "uk_aq_generic_integrity_v3_transition_state_fingerprint_v4",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-rdata-authority-"));
  try {
    const runState = fixture(root);
    const authority = requireGenericV3OfficialRdataAuthority(runState);
    assert.equal(authority.source_adapter, "waqn");
    assert.equal(authority.contract_version,
      "uk_aq_generic_v3_official_rdata_publication_authority_v2");
    assert.equal(authority.selected_scope_source_evidence[0].timestamp_mapping,
      "rdata_date_beginning_plus_one_hour_to_observed_at_utc");
    assert.equal(authority.selected_scope_source_evidence[0].evidence_contract_version, 9);
    const runStatePath = path.join(root, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify(runState));
    const pythonAuthority = JSON.parse(execFileSync("python3", [
      "-c",
      [
        "import importlib.util, json, pathlib, sys",
        "module_path = pathlib.Path('scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py').resolve()",
        "spec = importlib.util.spec_from_file_location('v3_authority_parity', module_path)",
        "module = importlib.util.module_from_spec(spec)",
        "sys.modules[spec.name] = module",
        "spec.loader.exec_module(module)",
        "state = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
        "print(json.dumps(module._generic_v3_official_rdata_publication_authority(state), sort_keys=True, separators=(',', ':')))",
      ].join("; "),
      runStatePath,
    ], { encoding: "utf8" }));
    assert.deepEqual(pythonAuthority, authority);
    const evidencePath = path.join(
      runState.overlay_root, "day_utc=2026-10-08", "connector_id=9", "source-evidence.json",
    );
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    evidence.timestamp_mapping = "rdata_posixct_gmt_instant_to_observed_at_utc";
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    assert.throws(
      () => requireGenericV3OfficialRdataAuthority(runState),
      /semantic evidence|timestamp mapping|changed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
