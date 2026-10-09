import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
  GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  GENERIC_V2_OPERATIONAL_CONTEXT_CONTRACT,
  RETAINED_V2_MAINTENANCE_CONTEXT_CONTRACT,
  SERVING_V2_LIVE_CONTEXT_CONTRACT,
  canonicalGenericV2SelectedScopeAuthority,
  computeGenericV2TransitionStateFingerprint,
  requireGenericV2OperationalContext,
} from "../lib/generic_v2_official_rdata_proposal_validation.mjs";

function genericAuthorityFixture() {
  const hash = "a".repeat(64);
  const prefix = "history/v2/observations/day_utc=2026-10-01"
    + "/connector_id=9/pollutant_code=no2";
  const sourceAuthority = {
    contract_version: "uk_aq_generic_v2_official_rdata_scope_source_authority_v1",
    authority_kind: "persisted_official_rdata_v7_semantic_evidence",
    history_generation: "v2",
    day_utc: "2026-10-01",
    connector_id: 9,
    source_adapter: "waqn",
    pollutant_code: "no2",
    evidence_id: 7,
    semantic_evidence_sha256: hash,
    source_evidence_input_sha256: hash,
    acquisition_audit_id: 8,
    acquisition_audit_sha256: hash,
    source_file_identities_sha256: hash,
    source_file_identities: [],
    files_required: [],
    files_read: [],
    files_authoritatively_absent: [],
    source_available_timeseries_ids: [],
    source_unavailable_timeseries_ids: [],
    source_unavailable_scopes: [],
    source_artifact_availability_sha256: hash,
    authoritative_station_timeseries_mapping_sha256: hash,
    observed_property_mapping_sha256: hash,
    preserved_baseline_dependency_sha256: hash,
    preserved_baseline_identity: {},
    canonical_rows_sha256: hash,
    canonical_rows_bytes: 2,
    final_target_row_count: 0,
    final_target_timeseries_row_counts: {},
    final_target_pollutant_counts: { no2: 0 },
    final_target_observation_content_hashes: {},
    selected_final_target_row_count: 0,
    selected_final_target_authoritatively_empty: true,
    timestamp_mapping: "rdata_date_beginning_plus_one_hour_to_observed_at_utc",
  };
  const scope = {
    day_utc: "2026-10-01",
    connector_id: 9,
    pollutant_code: "no2",
    pollutant_prefix: prefix,
    outcome: "authoritative_no_data_replacement",
    authorised_tombstone_prefix: prefix,
    replacement_object_keys: [],
    preservation_evidence: null,
    source_evidence_authority: sourceAuthority,
  };
  return {
    objects: {},
    tombstone_prefixes: [{ prefix, proposed: true }],
    explicit_official_force_partitions: [],
    explicit_official_force_replacement: false,
    generic_integrity_selected_scope_authority: {
      contract_version: GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
      history_generation: "v2",
      selected_scopes: [scope],
      metadata_only_scopes: [],
      metadata_only_derived_write_object_keys: [],
      explicit_force_targets: [],
      forced_republication_parquet_keys: [],
      authorised_pollutant_tombstone_prefixes: [prefix],
    },
  };
}

function normalConfigurationBody(environment, servingGeneration, bucket) {
  return Buffer.from([
    `UKAQ_ENV_NAME=${environment}`,
    `UK_AQ_R2_HISTORY_VERSION=${servingGeneration}`,
    `UK_AQ_R2_HISTORY_INDEX_VERSION=${servingGeneration}`,
    `CFLARE_R2_BUCKET=${bucket}`,
    "",
  ].join("\n"), "utf8");
}

function operationEnvironment(root, environment, servingGeneration, bucket) {
  const body = normalConfigurationBody(environment, servingGeneration, bucket);
  const envPath = path.join(root, `${environment}-${servingGeneration}.env`);
  fs.writeFileSync(envPath, body);
  return {
    UK_AQ_ENV_NAME: environment,
    UK_AQ_R2_HISTORY_VERSION: "v2",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v2",
    UK_AQ_BACKFILL_ENV_FILE: envPath,
    CFLARE_R2_BUCKET: bucket,
  };
}

function operationalFixture({ environment, bucket, servingGeneration }) {
  const runState = genericAuthorityFixture();
  const hash = "b".repeat(64);
  runState.environment = environment;
  runState.core_snapshot_identity = {
    core_snapshot_day_utc: "2026-10-01",
    core_snapshot_manifest_key: "history/v2/core/day_utc=2026-10-01/manifest.json",
    core_snapshot_manifest_hash: "c".repeat(64),
    core_snapshot_manifest_sha256: "d".repeat(64),
  };
  runState.timeseries_binding_pre_repair_verification = {
    status: "ok",
    source_adapter: "waqn",
    connector_id: 9,
    pollutant_codes: ["no2"],
    required_timeseries_ids: [9001],
    required_binding_count: 1,
    gap_count: 0,
    provider: { mode: "individual", observation_generation: "v2" },
  };
  runState.dropbox_currentness = {
    allowed: true,
    checkpoint_live_root_match: true,
    checkpoint: {
      relative_key: "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/root.json",
      sha256: "e".repeat(64),
      observations_processed_source_root_hash: hash,
    },
    live_observations_root: {
      key: "history/v2/observations/_manifests/manifest.json",
      content_hash: hash,
    },
  };
  runState.observations_global_operation_lock = {
    valid: true,
    owner: "integrity",
    run_id: `integrity:${environment}:fixture`,
  };
  const common = {
    environment,
    bucket,
    normal_configuration_sha256: createHash("sha256").update(Buffer.from(JSON.stringify({
      bucket,
      environment,
      index_generation: servingGeneration,
      serving_generation: servingGeneration,
    }), "utf8")).digest("hex"),
    observation_generation: "v2",
    index_generation: "v2",
    observations_root: "history/v2/observations",
    implementation_revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    selected_scopes: [{
      day_utc: "2026-10-01", connector_id: 9, pollutant_code: "no2",
    }],
    core_snapshot_identity: runState.core_snapshot_identity,
    timeseries_binding_verification: {
      ...runState.timeseries_binding_pre_repair_verification,
      provider: {
        mode: "individual",
        observation_generation: "v2",
        authenticated_generation_complete: false,
        pack_root_relative_path: null,
        pack_root_sha256: null,
        source_root_hash: null,
        checkpoint_source_root_hash: null,
        ranges_verified: null,
        total_pack_members_verified: null,
        authenticated_members_returned: null,
      },
    },
    dropbox_checkpoint_sha256: "e".repeat(64),
    dropbox_observations_root_hash: hash,
    live_v2_observations_root_hash: hash,
    observations_global_operation_lock: runState.observations_global_operation_lock,
    generation_v2_backup_completion_required: true,
  };
  const authority = environment === "TEST" ? {
    contract_version: RETAINED_V2_MAINTENANCE_CONTEXT_CONTRACT,
    intent: "retained_v2_official_rdata_maintenance",
    ...common,
    serving_generation: "v3",
    non_serving_downstream_suppressed: true,
    deliberate_retained_v2_divergence: true,
  } : {
    contract_version: SERVING_V2_LIVE_CONTEXT_CONTRACT,
    intent: "serving_v2_official_rdata_integrity",
    ...common,
    serving_generation: "v2",
    non_serving_downstream_suppressed: false,
    normal_downstream_eligible_after_final_verification: true,
  };
  const field = environment === "TEST"
    ? "retained_v2_maintenance_context" : "serving_v2_live_context";
  runState[field] = authority;
  runState.generic_v2_operational_context = {
    contract_version: GENERIC_V2_OPERATIONAL_CONTEXT_CONTRACT,
    mode: environment === "TEST"
      ? "retained_v2_non_serving_test" : "serving_v2_live",
    authority_contract_version: authority.contract_version,
    authority,
  };
  return runState;
}

test("generic fixed-v2 authority has independent versioned contract identities", () => {
  assert.equal(
    GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
    "uk_aq_generic_integrity_v2_selected_scope_authority_v1",
  );
  assert.equal(
    GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    "uk_aq_generic_integrity_v2_transition_state_fingerprint_v2",
  );
});

test("generic fixed-v2 authority rejects a relabelled fixed-v3 authority", () => {
  assert.throws(
    () => canonicalGenericV2SelectedScopeAuthority({
      generic_integrity_selected_scope_authority: {
        contract_version: "uk_aq_generic_integrity_v3_selected_scope_authority_v3",
        history_generation: "v3",
        selected_scopes: [],
        metadata_only_scopes: [],
        authorised_pollutant_tombstone_prefixes: [],
      },
    }),
    /Generic fixed-v2 selected-scope authority is unavailable/,
  );
});

test("generic fixed-v2 authority binds exact persisted official source evidence", () => {
  const runState = genericAuthorityFixture();
  assert.equal(
    canonicalGenericV2SelectedScopeAuthority(runState)
      .selected_scopes[0].source_evidence_authority.evidence_id,
    7,
  );
  runState.generic_integrity_selected_scope_authority
    .selected_scopes[0].source_evidence_authority.source_evidence_input_sha256 = "b";
  assert.throws(
    () => canonicalGenericV2SelectedScopeAuthority(runState),
    /persisted source authority is invalid/,
  );
});

test("generic fixed-v2 selects retained TEST and serving LIVE independently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v2-context-"));
  try {
    const testState = operationalFixture({
      environment: "TEST", bucket: "uk-aq-history-cic-test", servingGeneration: "v3",
    });
    const testEnv = operationEnvironment(
      root, "TEST", "v3", "uk-aq-history-cic-test",
    );
    assert.equal(
      requireGenericV2OperationalContext(testState, testEnv).mode,
      "retained_v2_non_serving_test",
    );

    const liveState = operationalFixture({
      environment: "LIVE", bucket: "configured-live-bucket-fixture", servingGeneration: "v2",
    });
    const liveEnv = operationEnvironment(
      root, "LIVE", "v2", "configured-live-bucket-fixture",
    );
    assert.equal(
      requireGenericV2OperationalContext(liveState, liveEnv).mode,
      "serving_v2_live",
    );
    assert.equal(
      requireGenericV2OperationalContext(liveState, liveEnv)
        .context.authority.bucket,
      "configured-live-bucket-fixture",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generic fixed-v2 rejects cross-mode substitution and concealed LIVE v3", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v2-context-"));
  try {
    const testState = operationalFixture({
      environment: "TEST", bucket: "uk-aq-history-cic-test", servingGeneration: "v3",
    });
    testState.generic_v2_operational_context.mode = "serving_v2_live";
    assert.throws(
      () => requireGenericV2OperationalContext(
        testState,
        operationEnvironment(root, "TEST", "v3", "uk-aq-history-cic-test"),
      ),
      /Serving fixed-v2 LIVE authority|operational context changed/,
    );

    const liveState = operationalFixture({
      environment: "LIVE", bucket: "configured-live-bucket-fixture", servingGeneration: "v2",
    });
    assert.throws(
      () => requireGenericV2OperationalContext(
        liveState,
        operationEnvironment(root, "LIVE", "v3", "configured-live-bucket-fixture"),
      ),
      /Serving fixed-v2 LIVE authority is incomplete or contradictory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generic fixed-v2 transition fingerprint matches Python UTF-8 canonicalisation", () => {
  const runState = operationalFixture({
    environment: "LIVE", bucket: "configured-live-bucket-fixture", servingGeneration: "v2",
  });
  runState.execution_path = "generic_integrity";
  runState.official_rdata_source_adapter = "waqn";
  runState.proposal_transition_planner_unchanged_keys = [];
  runState.final_staged_write_set_provenance = {
    status: "finalised",
    final_staged_object_count: 0,
    forced_republication_count: 0,
    forced_republication_keys: [],
    promotion_reason_counts: {},
    rebuilt_dependency_identity_count: 0,
    staged_dependency_edge_count: 0,
    external_dependency_edge_counts: {},
  };
  const comparison = {
    source_adapter: "waqn",
    site_code: "fixture",
    pollutant_code: "no2",
    graph: {
      original_timestamp: "2026-10-01 01:00",
      interpreted_europe_london: "2026-10-01T01:00:00+01:00",
      observed_at_utc: "2026-10-01T00:00:00.000Z",
      value: "12.5",
      unit: "ug/m3",
    },
    rdata: {
      original_timestamp: "2026-10-01 00:00",
      interpreted_europe_london: "2026-10-01T00:00:00+01:00",
      observed_at_utc: "2026-10-01T00:00:00.000Z",
      value: "12.5",
      unit: "ug/m3",
    },
    canonical: {
      observed_at_utc: "2026-10-01T00:00:00.000Z",
      value: "12.5",
      unit: "ug/m3",
    },
    europe_london_offset: "+01:00",
    hour_convention: "rdata_beginning_plus_one_hour_equals_graph_end",
  };
  const artifact = {
    contract_version: "uk_aq_official_rdata_timestamp_authority_v1",
    status: "accepted",
    source_adapter: "waqn",
    timestamp_mapping: "rdata_date_beginning_plus_one_hour_to_observed_at_utc",
    unit_authority: "accepted_matching_measurement_and_unit",
    comparisons: [comparison],
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v2-fingerprint-"));
  try {
    const artifactPath = path.join(temporaryRoot, "timestamp-authority.json");
    const artifactBody = Buffer.from(JSON.stringify(artifact), "utf8");
    fs.writeFileSync(artifactPath, artifactBody);
    runState.official_rdata_timestamp_authority_artifact_path = artifactPath;
    runState.official_rdata_timestamp_authority = {
      ...artifact,
      artifact_sha256: createHash("sha256").update(artifactBody).digest("hex"),
    };
    const statePath = path.join(temporaryRoot, "run-state.json");
    fs.writeFileSync(statePath, JSON.stringify(runState));
    const env = operationEnvironment(
      temporaryRoot, "LIVE", "v2", "configured-live-bucket-fixture",
    );
    const nodeFingerprint = computeGenericV2TransitionStateFingerprint(runState, env);
    const modulePath = path.resolve(
      "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py",
    );
    const python = spawnSync("python3", [
      "-c",
      [
        "import importlib.util,json,sys",
        "spec=importlib.util.spec_from_file_location('integrity_fp',sys.argv[2])",
        "module=importlib.util.module_from_spec(spec)",
        "sys.modules[spec.name]=module",
        "spec.loader.exec_module(module)",
        "state=json.load(open(sys.argv[1],encoding='utf-8'))",
        "print(module.proposal_transition_state_fingerprint_sha256(state),end='')",
      ].join(";"),
      statePath,
      modulePath,
    ], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout, nodeFingerprint);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
