import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  observationsGlobalOperationLockIdentity,
} from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  applyValidatedSosLightV3Proposal,
} from "../uk_aq_apply_sos_light_v3_proposal.mjs";
import {
  applyValidatedGenericV3Proposal,
} from "../uk_aq_apply_generic_v3_proposal.mjs";
import {
  materializeSosLightV3ProposalBodies,
  SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
  writeSosLightV3ProposalArtifact,
} from "../lib/sos_light_v3_proposal_transport.mjs";
import {
  computeCoordinatorTransitionStateFingerprint,
  requireCoordinatorProposalFreeze,
  SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  validateDedicatedSosHistoricalProposalV3,
  validateFinalSosLightV3ProposalGraph,
  validateLocalSosLightV3Proposal,
} from "../lib/sos_light_v3_proposal_validation.mjs";
import {
  computeGenericV3TransitionStateFingerprint,
  GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT,
  GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  validateFinalGenericV3ProposalGraph,
  validateLocalGenericV3Proposal,
} from "../lib/generic_v3_proposal_validation.mjs";

function connectorMembershipEvidence(
  dayUtc,
  connectorIds = [1],
  authoritativeObjectKeys = null,
) {
  const sortedConnectorIds = [...connectorIds].sort((left, right) => left - right);
  const root = `history/v3/observations/day_utc=${dayUtc}`;
  const closure = authoritativeObjectKeys || [
    `${root}/manifest.json`,
    ...sortedConnectorIds.map((connectorId) =>
      `${root}/connector_id=${connectorId}/manifest.json`),
  ];
  return {
    day_utc: dayUtc,
    pinned_day_manifest_present: true,
    pinned_day_manifest_key: `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
    pinned_day_manifest_hash: "a".repeat(64),
    pinned_baseline_connector_ids: sortedConnectorIds,
    expected_preserved_connector_ids: sortedConnectorIds.filter((connectorId) => connectorId !== 1),
    expected_final_connector_ids: sortedConnectorIds.includes(1)
      ? sortedConnectorIds
      : [1, ...sortedConnectorIds].sort((left, right) => left - right),
    final_assembled_connector_ids: sortedConnectorIds.includes(1)
      ? sortedConnectorIds
      : [1, ...sortedConnectorIds].sort((left, right) => left - right),
    authoritative_observation_object_keys: [...closure].sort(),
  };
}

function finalDayManifestBody(dayUtc, connectorIds = [1]) {
  const references = [...connectorIds]
    .sort((left, right) => left - right)
    .map((connectorId) => ({
      connector_id: connectorId,
      manifest_key:
        `history/v3/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
    }));
  return Buffer.from(JSON.stringify({
    connector_ids: references.map(({ connector_id: connectorId }) => connectorId),
    connector_manifests: references,
    child_manifests: references,
  }));
}

function fixedV3CoreApplyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-core-apply-"));
  const dropboxRoot = path.join(root, "dropbox");
  fs.mkdirSync(dropboxRoot, { recursive: true });
  const dayUtc = "2026-09-15";
  const manifestHash = "a".repeat(64);
  const manifestKey = `history/v3/core/day_utc=${dayUtc}/manifest.json`;
  const manifestBody = Buffer.from(JSON.stringify({
    day_utc: dayUtc,
    manifest_hash: manifestHash,
  }));
  const manifestPath = path.join(dropboxRoot, ...manifestKey.split("/"));
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifestBody);
  const identity = {
    core_snapshot_day_utc: dayUtc,
    core_snapshot_manifest_key: manifestKey,
    core_snapshot_manifest_hash: manifestHash,
    core_snapshot_manifest_sha256: sha256Hex(manifestBody),
  };
  const identityPath = path.join(root, "core-snapshot-identity.json");
  fs.writeFileSync(identityPath, JSON.stringify(identity));
  const lockRunId = "integrity:TEST:v3-core-boundary";
  const lockIdentity = observationsGlobalOperationLockIdentity();
  const env = {
    UK_AQ_ENV_NAME: "TEST",
    UK_AQ_R2_HISTORY_VERSION: "v3",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3",
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_JSON: JSON.stringify(identity),
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_FILE: identityPath,
    UK_AQ_INTEGRITY_CORE_SNAPSHOT_DROPBOX_ROOT: dropboxRoot,
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_HELD: "true",
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_OWNER: "integrity",
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_RUN_ID: lockRunId,
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_IDENTITY:
      lockIdentity.logical_identity,
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_CLASS_ID:
      String(lockIdentity.class_id),
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_OBJECT_ID:
      String(lockIdentity.object_id),
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_NONCE: "test-nonce",
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_ACQUIRED: "true",
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_WAIT_MS: "0",
    UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_OUTCOME: "held",
  };
  const runStatePath = path.join(root, "run-state.json");
  const runState = {
    run_id: "v3-core-boundary",
    execution_path: "sos_light",
    observations_global_operation_lock: { run_id: lockRunId },
    base_dropbox_root: dropboxRoot,
    core_snapshot_identity: identity,
    core_snapshot_consumer_audit: [],
    objects: {},
    tombstone_prefixes: [],
  };
  fs.writeFileSync(runStatePath, JSON.stringify(runState));
  const r2 = {
    endpoint: "https://example.invalid",
    bucket: "test-bucket",
    region: "auto",
    access_key_id: "test-access-key",
    secret_access_key: "test-secret-key",
  };
  return { root, runStatePath, runState, identity, identityPath, env, r2 };
}

function remoteMutationAdapters(counter) {
  const remote = async () => {
    counter.calls += 1;
    throw new Error("remote mutation adapter must not run");
  };
  return {
    getObject: remote,
    putObject: remote,
    putAndVerifyParquet: remote,
    listAllObjects: remote,
    deleteObjects: remote,
  };
}

test("fixed-v3 APPLY child accepts a canonical pinned v3 core before proposal validation", async () => {
  const fixture = fixedV3CoreApplyFixture();
  const counter = { calls: 0 };
  try {
    await assert.rejects(
      applyValidatedSosLightV3Proposal({
        runStatePath: fixture.runStatePath,
        env: fixture.env,
        r2: fixture.r2,
        adapters: remoteMutationAdapters(counter),
      }),
      /proposal ingestion checkpoint is incomplete/,
    );
    assert.equal(counter.calls, 0);
    const persisted = JSON.parse(fs.readFileSync(fixture.runStatePath, "utf8"));
    assert.equal(
      persisted.core_snapshot_consumer_audit.at(-1).stage,
      "fixed_v3_canonical_apply_child",
    );
    assert.equal(
      persisted.core_snapshot_consumer_audit.at(-1).status,
      "validated",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fixed-v3 APPLY child rejects missing, mismatched, and v2 core identity before mutation", async (t) => {
  const cases = [
    ["missing child identity", (fixture) => {
      delete fixture.runState.core_snapshot_identity;
    }, /child_requested_identity_invalid/],
    ["coordinator and child mismatch", (fixture) => {
      fixture.runState.core_snapshot_identity = {
        ...fixture.identity,
        core_snapshot_day_utc: "2026-09-14",
        core_snapshot_manifest_key:
          "history/v3/core/day_utc=2026-09-14/manifest.json",
      };
    }, /coordinator_child_identity_mismatch/],
    ["v2 identity", (fixture) => {
      const v2Identity = {
        ...fixture.identity,
        core_snapshot_manifest_key:
          `history/v2/core/day_utc=${fixture.identity.core_snapshot_day_utc}/manifest.json`,
      };
      fixture.runState.core_snapshot_identity = v2Identity;
      fixture.env.UK_AQ_INTEGRITY_CORE_SNAPSHOT_IDENTITY_JSON =
        JSON.stringify(v2Identity);
      fs.writeFileSync(fixture.identityPath, JSON.stringify(v2Identity));
    }, /coordinator_manifest_key_noncanonical/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const fixture = fixedV3CoreApplyFixture();
      const counter = { calls: 0 };
      try {
        mutate(fixture);
        fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
        await assert.rejects(
          applyValidatedSosLightV3Proposal({
            runStatePath: fixture.runStatePath,
            env: fixture.env,
            r2: fixture.r2,
            adapters: remoteMutationAdapters(counter),
          }),
          expected,
        );
        assert.equal(counter.calls, 0);
        const persisted = JSON.parse(
          fs.readFileSync(fixture.runStatePath, "utf8"),
        );
        assert.equal(
          persisted.apply.current_phase,
          "core_snapshot_identity_validation",
        );
        assert.equal(persisted.apply.r2_mutation_possible, false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("fixed-v3 execution scope does not require retired AQI fields", () => {
  const dayUtc = "2025-01-15";
  const runState = {
    execution_path: "sos_light",
    mode: "sos-light",
    environment: "TEST",
    mutation_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    protected_connector_ids: [1],
    sos_light: {
      mode: "sos-light",
      validation_status: "complete_local_days_validated",
      old_live_r2_observation_bodies_used: false,
      no_old_live_r2_body_planning_or_preservation: true,
      days: [connectorMembershipEvidence(dayUtc)],
    },
  };
  const proposal = {
    objects: [
      {
        key: `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
        body: finalDayManifestBody(dayUtc),
      },
      { key: `history/v3/observations/day_utc=${dayUtc}/connector_id=1/manifest.json` },
    ],
    prefixes: [{
      prefix: `history/v3/observations/day_utc=${dayUtc}`,
      entry: { stage: "sos_light_complete_day" },
    }],
  };

  assert.doesNotThrow(() => validateDedicatedSosHistoricalProposalV3({
    runState,
    proposal,
  }));
  assert.equal(Object.hasOwn(runState, "aqi_policy"), false);
  assert.equal(Object.hasOwn(runState, "changed_scopes"), false);
});

test("fixed-v3 rejects a final day that loses a frozen preserved connector", () => {
  const dayUtc = "2025-01-15";
  const root = `history/v3/observations/day_utc=${dayUtc}`;
  const runState = {
    execution_path: "sos_light",
    mode: "sos-light",
    environment: "TEST",
    mutation_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    protected_connector_ids: [1],
    sos_light: {
      mode: "sos-light",
      validation_status: "complete_local_days_validated",
      old_live_r2_observation_bodies_used: false,
      no_old_live_r2_body_planning_or_preservation: true,
      days: [connectorMembershipEvidence(dayUtc, [1, 8])],
    },
  };
  const proposal = {
    objects: [
      { key: `${root}/manifest.json`, body: finalDayManifestBody(dayUtc, [1]) },
      { key: `${root}/connector_id=1/manifest.json`, body: Buffer.from("{}") },
    ],
    prefixes: [{
      prefix: root,
      entry: { stage: "sos_light_complete_day" },
    }],
  };

  assert.throws(
    () => validateDedicatedSosHistoricalProposalV3({ runState, proposal }),
    /lacks required connector 8|differs from pinned authority/,
  );
});

test("fixed-v3 rejects unexpected canonical objects outside the frozen day closure", () => {
  const dayUtc = "2025-01-15";
  const root = `history/v3/observations/day_utc=${dayUtc}`;
  const runState = {
    execution_path: "sos_light",
    mode: "sos-light",
    environment: "TEST",
    mutation_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    protected_connector_ids: [1],
    sos_light: {
      mode: "sos-light",
      validation_status: "complete_local_days_validated",
      old_live_r2_observation_bodies_used: false,
      no_old_live_r2_body_planning_or_preservation: true,
      days: [connectorMembershipEvidence(dayUtc)],
    },
  };
  const baseObjects = [
    { key: `${root}/manifest.json`, body: finalDayManifestBody(dayUtc) },
    { key: `${root}/connector_id=1/manifest.json`, body: Buffer.from("{}") },
  ];
  for (const unexpectedKey of [
    `${root}/connector_id=1/pollutant_code=orphan/manifest.json`,
    `${root}/connector_id=1/pollutant_code=no2/old-part.parquet`,
  ]) {
    assert.throws(
      () => validateDedicatedSosHistoricalProposalV3({
        runState,
        proposal: {
          objects: [...baseObjects, { key: unexpectedKey, body: Buffer.from("orphan") }],
          prefixes: [{ prefix: root, entry: { stage: "sos_light_complete_day" } }],
        },
      }),
      /final day object closure differs from frozen authority/,
    );
  }
});

function fixedV3LocalProposalState(indexKey) {
  const dayUtc = "2025-01-15";
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-key-allowlist-"));
  const overlayRoot = path.join(runRoot, "overlay");
  const keys = [
    `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
    `history/v3/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`,
    indexKey,
  ];
  const objects = {};
  for (const key of keys) {
    const body = key === `history/v3/observations/day_utc=${dayUtc}/manifest.json`
      ? finalDayManifestBody(dayUtc)
      : Buffer.from("{}\n");
    const localPath = path.join(overlayRoot, ...key.split("/"));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, body);
    objects[key] = {
      local_path: localPath,
      proposed: true,
      built: true,
      structurally_validated: true,
      bytes: body.byteLength,
      sha256: sha256Hex(body),
      dependencies: [],
      dependency_identities: {},
    };
  }
  const runState = {
    run_root: runRoot,
    overlay_root: overlayRoot,
    execution_path: "sos_light",
    mode: "sos-light",
    environment: "TEST",
    mutation_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    protected_connector_ids: [1],
    sos_light: {
      mode: "sos-light",
      validation_status: "complete_local_days_validated",
      old_live_r2_observation_bodies_used: false,
      no_old_live_r2_body_planning_or_preservation: true,
      days: [connectorMembershipEvidence(dayUtc)],
    },
    objects,
    tombstone_prefixes: [{
      prefix: `history/v3/observations/day_utc=${dayUtc}`,
      proposed: true,
      stage: "sos_light_complete_day",
    }],
    proposal_transition_planner_unchanged_keys: [],
    proposal_ingestion: {
      status: "complete",
      transport_mode: "file_backed_compact_proposal",
      completed_object_count: keys.length,
      total_object_count: keys.length,
      node_apply_launch_permitted: false,
    },
    final_staged_write_set_provenance: {
      status: "finalised",
      final_staged_object_count: keys.length,
      forced_republication_count: 0,
      forced_republication_keys: [],
      promotion_reason_counts: {},
      rebuilt_dependency_identity_count: 0,
      staged_dependency_edge_count: 0,
      external_dependency_edge_counts: {},
    },
    proposal_transition_validation: {
      status: "succeeded",
      node_apply_launch_permitted: true,
      state_fingerprint_contract_version:
        SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    },
  };
  runState.proposal_transition_validation.state_fingerprint_sha256 =
    computeCoordinatorTransitionStateFingerprint(runState);
  return { runRoot, runState };
}

test("fixed-v3 local APPLY validation rejects unknown index families before mutation", () => {
  for (const validKey of [
    "history/_index_v3/observations_timeseries/day_utc=2025-01-15/connector_id=1/pollutant_code=no2/timeseries_id=000000123.json",
    "history/_index_v3/observations_timeseries/_aligned/day_utc=2025-01-15/connector_id=1/pollutant_code=no2/manifest.json",
  ]) {
    const valid = fixedV3LocalProposalState(validKey);
    try {
      assert.doesNotThrow(() => validateLocalSosLightV3Proposal(valid.runState));
    } finally {
      fs.rmSync(valid.runRoot, { recursive: true, force: true });
    }
  }

  for (const invalidKey of [
    "history/_index_v3/not_an_observation_index/manifest.json",
    "history/_index_v3/aqilevels_timeseries/manifest.json",
  ]) {
    const invalid = fixedV3LocalProposalState(invalidKey);
    try {
      assert.throws(
        () => validateLocalSosLightV3Proposal(invalid.runState),
        /Non-observation history is outside the Integrity proposal contract/,
      );
    } finally {
      fs.rmSync(invalid.runRoot, { recursive: true, force: true });
    }
  }
});

test("fixed-v3 final graph validates canonical pollutant data without misclassifying an aligned index manifest", async () => {
  const dayUtc = "2025-01-15";
  const pollutantCode = "no2";
  const identity = `day_utc=${dayUtc}/connector_id=1/pollutant_code=${pollutantCode}`;
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-final-graph-"));
  const overlayRoot = path.join(runRoot, "overlay");
  try {
    const rawRows = [{
      station_id: 10,
      timeseries_id: 123,
      pollutant_code: pollutantCode,
      observed_at: `${dayUtc}T00:00:00.000Z`,
      value: 17.5,
      verification_status: "P",
    }];
    const canonicalRows = rawRows.map((row) => ({
      connector_id: 1,
      station_id: row.station_id,
      timeseries_id: row.timeseries_id,
      pollutant_code: row.pollutant_code,
      observed_at_utc: row.observed_at,
      value: row.value,
      verification_status: row.verification_status,
    }));
    const { canonical_rows: _canonicalRows, ...contentHash } =
      computeObservationContentHash(canonicalRows);
    const evidenceDirectory = path.join(
      overlayRoot,
      "source-evidence",
      `day_utc=${dayUtc}`,
      "connector_id=1",
      `pollutant_code=${pollutantCode}`,
    );
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
    const evidencePath = path.join(evidenceDirectory, "source-evidence.json");
    const rowsBody = Buffer.from(JSON.stringify(rawRows));
    const evidenceBody = Buffer.from(JSON.stringify({
      schema_version: 1,
      enumeration_complete: true,
      day_utc: dayUtc,
      connector_id: 1,
      requested_pollutant_set: [pollutantCode],
      missing_binding_rows: 0,
      canonical_rows_bytes: rowsBody.byteLength,
      canonical_rows_sha256: sha256Hex(rowsBody),
      total_rows: rawRows.length,
      per_pollutant_counts: { [pollutantCode]: rawRows.length },
      observation_content_hashes: { [pollutantCode]: contentHash },
    }));
    fs.writeFileSync(rowsPath, rowsBody);
    fs.writeFileSync(evidencePath, evidenceBody);

    const observationPrefix =
      `history/v3/observations/day_utc=${dayUtc}/connector_id=1/pollutant_code=${pollutantCode}`;
    const partKey = `${observationPrefix}/part-00000.parquet`;
    const manifestKey = `${observationPrefix}/manifest.json`;
    const alignedManifestKey =
      "history/_index_v3/observations_timeseries/_aligned/"
      + `day_utc=${dayUtc}/connector_id=1/pollutant_code=${pollutantCode}/manifest.json`;
    const manifestEntry = {};
    const alignedManifestEntry = {};
    const proposal = {
      objects: [
        {
          key: `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
          body: finalDayManifestBody(dayUtc),
          entry: {},
        },
        { key: `history/v3/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`, body: Buffer.from("{}"), entry: {} },
        { key: partKey, body: Buffer.from("parquet"), entry: {} },
        {
          key: manifestKey,
          body: Buffer.from(JSON.stringify({
            row_count: rawRows.length,
            parquet_object_keys: [partKey],
          })),
          entry: manifestEntry,
        },
        {
          key: alignedManifestKey,
          body: Buffer.from(JSON.stringify({ kind: "observation_timeseries_aligned_source_manifest" })),
          entry: alignedManifestEntry,
        },
      ],
      prefixes: [{
        prefix: `history/v3/observations/day_utc=${dayUtc}`,
        entry: { stage: "sos_light_complete_day" },
      }],
    };
    const runState = {
      overlay_root: overlayRoot,
      execution_path: "sos_light",
      mode: "sos-light",
      environment: "TEST",
      mutation_connector_ids: [1],
      selected_mutation_connector_ids: [1],
      protected_connector_ids: [1],
      requested_repair_pollutants: [pollutantCode],
      sos_light: {
        mode: "sos-light",
        validation_status: "complete_local_days_validated",
        old_live_r2_observation_bodies_used: false,
        no_old_live_r2_body_planning_or_preservation: true,
        days: [connectorMembershipEvidence(dayUtc, [1], [
          `history/v3/observations/day_utc=${dayUtc}/manifest.json`,
          `history/v3/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`,
          manifestKey,
          partKey,
        ])],
      },
      source_evidence_partitions: {
        [identity]: {
          identity,
          day_utc: dayUtc,
          connector_id: 1,
          pollutant_code: pollutantCode,
          evidence_path: evidencePath,
          rows_path: rowsPath,
          evidence_sha256: sha256Hex(evidenceBody),
          rows_sha256: sha256Hex(rowsBody),
        },
      },
    };

    const result = await validateFinalSosLightV3ProposalGraph({ runState, proposal });
    assert.equal(result.status, "succeeded");
    assert.equal(result.validated_partition_count, 1);
    assert.equal(manifestEntry.final_proposal_graph_validated, true);
    assert.equal(Object.hasOwn(alignedManifestEntry, "final_proposal_graph_validated"), false);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

function proposal(key, body, overrides = {}) {
  return {
    key,
    proposed_body: body,
    bytes: Buffer.byteLength(body),
    new_sha256: sha256Hex(Buffer.from(body)),
    changed: true,
    included_in_write_set: true,
    status: "planned",
    dependencies: [],
    dependency_identities: {},
    ...overrides,
  };
}

function fixture() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-proposal-transport-"));
  const overlayRoot = path.join(runRoot, "overlay");
  fs.mkdirSync(overlayRoot);
  return {
    runRoot,
    overlayRoot,
    runState: { run_root: runRoot, overlay_root: overlayRoot, objects: {} },
  };
}

test("fixed-v3 proposal transport materialises exact bodies and emits a compact envelope", () => {
  const { runRoot, overlayRoot, runState } = fixture();
  try {
    const key = "history/_index_v3/observations_timeseries/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/manifest.json";
    const largeBody = JSON.stringify({ payload: "x".repeat(1024 * 1024) });
    const skippedKey = "history/_index_v3/unchanged.json";
    const output = {
      ok: true,
      planning: {
        proposals: [
          proposal(key, largeBody),
          proposal(skippedKey, "unchanged", {
            changed: false,
            included_in_write_set: false,
            status: "skipped_unchanged",
          }),
        ],
      },
    };
    const audit = materializeSosLightV3ProposalBodies({ output, overlayRoot, runState });
    const changed = output.planning.proposals[0];
    assert.equal(changed.proposed_body, undefined);
    assert.equal(changed.body, undefined);
    assert.deepEqual(changed.body_ref, {
      contract_version: SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
      source: "planned_overlay",
      relative_path: key,
      sha256: sha256Hex(Buffer.from(largeBody)),
      bytes: Buffer.byteLength(largeBody),
    });
    assert.equal(fs.readFileSync(path.join(overlayRoot, ...key.split("/")), "utf8"), largeBody);
    assert.equal(output.planning.proposals[1].proposed_body, undefined);
    assert.equal(output.planning.proposals[1].body_ref, undefined);
    assert.equal(audit.file_backed_changed_body_count, 1);

    const envelope = writeSosLightV3ProposalArtifact({
      output,
      resultPath: path.join(runRoot, "proposal-results", "proposal.json"),
      runRoot,
    });
    const stdout = JSON.stringify(envelope);
    assert.ok(Buffer.byteLength(stdout) < 4096);
    assert.equal(stdout.includes(largeBody.slice(0, 1000)), false);
    const artifactText = fs.readFileSync(
      path.join(runRoot, envelope.proposal_artifact.relative_path),
      "utf8",
    );
    assert.equal(artifactText.includes(largeBody.slice(0, 1000)), false);
    assert.equal(JSON.parse(artifactText).output.planning.proposals[0].body_ref.sha256,
      changed.new_sha256);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("materialisation reuses an exact staged body and rejects an outside staged path", () => {
  const { runRoot, overlayRoot, runState } = fixture();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-proposal-outside-"));
  try {
    const key = "history/v3/observations/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/manifest.json";
    const body = "already-staged";
    const stagedPath = path.join(overlayRoot, ...key.split("/"));
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.writeFileSync(stagedPath, body);
    const before = fs.statSync(stagedPath).ino;
    runState.objects[key] = {
      local_path: stagedPath,
      sha256: sha256Hex(Buffer.from(body)),
      bytes: Buffer.byteLength(body),
    };
    const output = { ok: true, planning: { proposals: [proposal(key, body)] } };
    materializeSosLightV3ProposalBodies({ output, overlayRoot, runState });
    assert.equal(fs.statSync(stagedPath).ino, before, "exact current-run bytes must not be rewritten");

    const outsidePath = path.join(outsideRoot, "body.json");
    fs.writeFileSync(outsidePath, body);
    const badRunState = {
      ...runState,
      objects: { [key]: { ...runState.objects[key], local_path: outsidePath } },
    };
    assert.throws(
      () => materializeSosLightV3ProposalBodies({
        output: { ok: true, planning: { proposals: [proposal(key, body)] } },
        overlayRoot,
        runState: badRunState,
      }),
      /outside its permitted run-local boundary/,
    );
    assert.throws(
      () => writeSosLightV3ProposalArtifact({
        output,
        resultPath: path.join(outsideRoot, "proposal.json"),
        runRoot,
      }),
      /outside its permitted run-local boundary/,
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

function frozenCoordinatorState() {
  const childKey = "history/_index_v3/child.json";
  const parentKey = "history/_index_v3/parent.json";
  const childIdentity = {
    sha256: "a".repeat(64),
    bytes: 11,
    source: "planned_overlay",
  };
  const object = ({ key, sha256, bytes, dependencies, identities }) => ({
    object_key: key,
    sha256,
    bytes,
    stage: "child_shard",
    dependencies,
    dependency_identities: identities,
    proposed: true,
    built: true,
    structurally_validated: true,
    changed: true,
    included_in_write_set: true,
    status: "planned",
    planner_changed: true,
    planner_status: "planned",
    planner_included_in_write_set: true,
    planner_dependencies: dependencies,
    planner_dependency_identities: identities,
  });
  const complete = {
    sos_light: {
      mode: "sos-light",
      days: [connectorMembershipEvidence("2025-01-01")],
    },
    objects: {
      [childKey]: object({
        key: childKey,
        sha256: childIdentity.sha256,
        bytes: childIdentity.bytes,
        dependencies: [],
        identities: {},
      }),
      [parentKey]: object({
        key: parentKey,
        sha256: "b".repeat(64),
        bytes: 17,
        dependencies: [childKey],
        identities: { [childKey]: childIdentity },
      }),
    },
    proposal_transition_planner_unchanged_keys: [],
    tombstone_prefixes: [{
      prefix: "history/v3/observations/day_utc=2025-01-01",
      proposed: true,
    }],
    proposal_ingestion: {
      status: "complete",
      transport_mode: "file_backed_compact_proposal",
      completed_object_count: 2,
      total_object_count: 2,
      node_apply_launch_permitted: false,
    },
    final_staged_write_set_provenance: {
      status: "finalised",
      final_staged_object_count: 2,
      forced_republication_count: 0,
      forced_republication_keys: [],
      promotion_reason_counts: { exact_prefix_replacement: 0 },
      rebuilt_dependency_identity_count: 0,
      staged_dependency_edge_count: 1,
      external_dependency_edge_counts: { dropbox: 0, overlay: 0 },
    },
    proposal_transition_validation: {
      status: "succeeded",
      node_apply_launch_permitted: true,
    },
  };
  complete.proposal_transition_validation.state_fingerprint_contract_version =
    SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT;
  complete.proposal_transition_validation.state_fingerprint_sha256 =
    computeCoordinatorTransitionStateFingerprint(complete);
  return { complete, childKey, parentKey };
}

test("fixed-v3 coordinator fingerprint accepts only the untouched frozen graph", () => {
  const { complete, childKey, parentKey } = frozenCoordinatorState();
  assert.doesNotThrow(() => requireCoordinatorProposalFreeze(complete));

  const changedDependency = structuredClone(complete);
  changedDependency.objects[parentKey].dependency_identities[childKey].source = "overlay";
  assert.throws(
    () => requireCoordinatorProposalFreeze(changedDependency),
    /transition evidence is stale or changed/,
  );

  const changedProvenance = structuredClone(complete);
  changedProvenance.final_staged_write_set_provenance.rebuilt_dependency_identity_count = 1;
  assert.throws(
    () => requireCoordinatorProposalFreeze(changedProvenance),
    /transition evidence is stale or changed/,
  );

  const changedPlannerEvidence = structuredClone(complete);
  changedPlannerEvidence.objects[parentKey].planner_status = "changed_after_validation";
  assert.throws(
    () => requireCoordinatorProposalFreeze(changedPlannerEvidence),
    /transition evidence is stale or changed/,
  );
});

test("fixed-v3 apply rejects missing, unknown, and intermediate fingerprints", () => {
  const { complete } = frozenCoordinatorState();
  const missingFingerprint = structuredClone(complete);
  delete missingFingerprint.proposal_transition_validation.state_fingerprint_sha256;
  assert.throws(
    () => requireCoordinatorProposalFreeze(missingFingerprint),
    /transition-state fingerprint is missing/,
  );

  const unknownContract = structuredClone(complete);
  unknownContract.proposal_transition_validation.state_fingerprint_contract_version =
    "unknown_transition_fingerprint_v999";
  assert.throws(
    () => requireCoordinatorProposalFreeze(unknownContract),
    /fingerprint contract is unknown/,
  );

  assert.throws(
    () => requireCoordinatorProposalFreeze({
      ...complete,
      proposal_ingestion: {
        ...complete.proposal_ingestion,
        status: "in_progress",
      },
    }),
    /ingestion checkpoint is incomplete/,
  );
  assert.throws(
    () => requireCoordinatorProposalFreeze({
      ...complete,
      final_staged_write_set_provenance: undefined,
    }),
    /write-set provenance is incomplete/,
  );
  assert.throws(
    () => requireCoordinatorProposalFreeze({
      ...complete,
      proposal_transition_validation: undefined,
    }),
    /transition validation is not frozen/,
  );
});

function genericV3SelectedScopeState({ authoritativeEmpty = false } = {}) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-generic-v3-"));
  const overlayRoot = path.join(runRoot, "overlay");
  const dropboxRoot = path.join(runRoot, "dropbox");
  fs.mkdirSync(overlayRoot, { recursive: true });
  fs.mkdirSync(dropboxRoot, { recursive: true });
  const dayUtc = "2026-09-28";
  const connectorId = 8;
  const pollutantCode = "no2";
  const prefix = `history/v3/observations/day_utc=${dayUtc}`
    + `/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const objects = {};
  const addObject = (key, body, dependencies = []) => {
    const localPath = path.join(overlayRoot, ...key.split("/"));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, body);
    const dependencyIdentities = Object.fromEntries(dependencies.map((dependencyKey) => [
      dependencyKey,
      {
        sha256: objects[dependencyKey].sha256,
        bytes: objects[dependencyKey].bytes,
        source: "planned_overlay",
      },
    ]));
    objects[key] = {
      object_key: key,
      local_path: localPath,
      sha256: sha256Hex(body),
      bytes: body.byteLength,
      stage: key.endsWith(".parquet") ? "observations_data" : "observations_manifest",
      dependencies,
      dependency_identities: dependencyIdentities,
      proposed: true,
      built: true,
      structurally_validated: true,
      changed: true,
      included_in_write_set: true,
      status: "planned",
      planner_changed: true,
      planner_status: "planned",
      planner_included_in_write_set: true,
      planner_dependencies: [...dependencies],
      planner_dependency_identities: structuredClone(dependencyIdentities),
    };
  };
  const replacementObjectKeys = [];
  if (!authoritativeEmpty) {
    const partKey = `${prefix}/part-00000.parquet`;
    const manifestKey = `${prefix}/manifest.json`;
    addObject(partKey, Buffer.from("representative-parquet"));
    addObject(manifestKey, Buffer.from("{}\n"), [partKey]);
    replacementObjectKeys.push(partKey, manifestKey);
    replacementObjectKeys.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  }
  const runState = {
    run_id: "generic-v3-test",
    run_root: runRoot,
    overlay_root: overlayRoot,
    base_dropbox_root: dropboxRoot,
    execution_path: "generic_integrity",
    dedicated_sos_historical_replacement: false,
    environment: "TEST",
    objects,
    tombstone_prefixes: [{
      prefix,
      proposed: true,
      stage: "observations_data",
      repair_pollutants: [pollutantCode],
      authority_outcome: authoritativeEmpty
        ? "authoritative_no_data_replacement" : "complete_replacement",
      authority_scope: {
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
      },
    }],
    generic_integrity_selected_scope_authority: {
      contract_version: GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT,
      history_generation: "v3",
      selected_scopes: [{
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: pollutantCode,
        outcome: authoritativeEmpty
          ? "authoritative_no_data_replacement" : "complete_replacement",
        authorised_tombstone_prefix: prefix,
        replacement_object_keys: replacementObjectKeys,
      }],
      authorised_pollutant_tombstone_prefixes: [prefix],
    },
    proposal_transition_planner_unchanged_keys: [],
    proposal_ingestion: {
      status: "complete",
      transport_mode: "file_backed_compact_proposal",
      completed_object_count: Object.keys(objects).length,
      total_object_count: Object.keys(objects).length,
      node_apply_launch_permitted: false,
    },
    final_staged_write_set_provenance: {
      status: "finalised",
      final_staged_object_count: Object.keys(objects).length,
      forced_republication_count: 0,
      forced_republication_keys: [],
      promotion_reason_counts: {},
      rebuilt_dependency_identity_count: 0,
      staged_dependency_edge_count: authoritativeEmpty ? 0 : 1,
      external_dependency_edge_counts: { dropbox: 0, overlay: 0 },
    },
    proposal_transition_validation: {
      status: "succeeded",
      node_apply_launch_permitted: true,
      state_fingerprint_contract_version:
        GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    },
  };
  runState.proposal_transition_validation.state_fingerprint_sha256 =
    computeGenericV3TransitionStateFingerprint(runState);
  return { runRoot, runState, prefix, env: { UK_AQ_ENV_NAME: "TEST" } };
}

test("generic fixed-v3 accepts selected non-empty authority and remains isolated from SOS", () => {
  const fixture = genericV3SelectedScopeState();
  try {
    const proposal = validateLocalGenericV3Proposal(fixture.runState, fixture.env);
    assert.equal(proposal.objects.length, 2);
    assert.equal(proposal.prefixes.length, 1);
    assert.throws(
      () => validateLocalSosLightV3Proposal(fixture.runState),
      /fingerprint contract is unknown|SOS-light proposals only|connector-membership/,
    );
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
  }
});

test("generic fixed-v3 accepts authoritative empty without synthetic children", () => {
  const fixture = genericV3SelectedScopeState({ authoritativeEmpty: true });
  try {
    const proposal = validateLocalGenericV3Proposal(fixture.runState, fixture.env);
    assert.equal(proposal.objects.length, 0);
    assert.equal(proposal.prefixes.length, 1);
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
  }
});

test("generic fixed-v3 final graph proves authoritative empty from immutable source evidence", async () => {
  const fixture = genericV3SelectedScopeState({ authoritativeEmpty: true });
  try {
    const rowsBody = Buffer.from("[]");
    const evidenceDirectory = path.join(
      fixture.runState.overlay_root,
      "day_utc=2026-09-28",
      "connector_id=8",
    );
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, "obs_history_rows.json"), rowsBody);
    fs.writeFileSync(path.join(evidenceDirectory, "source-evidence.json"), JSON.stringify({
      schema_version: 1,
      enumeration_complete: true,
      day_utc: "2026-09-28",
      connector_id: 8,
      canonical_rows_bytes: rowsBody.byteLength,
      canonical_rows_sha256: sha256Hex(rowsBody),
      total_rows: 0,
      missing_binding_rows: 0,
      per_pollutant_counts: {},
      observation_content_hashes: {},
    }));
    const proposal = validateLocalGenericV3Proposal(fixture.runState, fixture.env);
    const validation = await validateFinalGenericV3ProposalGraph({
      runState: fixture.runState,
      proposal,
    });
    assert.equal(validation.status, "succeeded");
    assert.equal(validation.partitions[0].status, "validated_authoritative_empty");
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
  }
});

test("generic fixed-v3 rejects source-unavailable deletion and stale fingerprints before mutation", () => {
  const fixture = genericV3SelectedScopeState();
  try {
    const unavailable = structuredClone(fixture.runState);
    unavailable.generic_integrity_selected_scope_authority.selected_scopes[0].outcome =
      "source_artifact_unavailable_preserved";
    unavailable.generic_integrity_selected_scope_authority.selected_scopes[0]
      .authorised_tombstone_prefix = null;
    unavailable.generic_integrity_selected_scope_authority.selected_scopes[0]
      .replacement_object_keys = [];
    unavailable.generic_integrity_selected_scope_authority
      .authorised_pollutant_tombstone_prefixes = [];
    assert.throws(
      () => computeGenericV3TransitionStateFingerprint(unavailable),
      /proposed tombstones exceed selected authority/,
    );

    const stale = structuredClone(fixture.runState);
    stale.objects[`${fixture.prefix}/manifest.json`].bytes += 1;
    assert.throws(
      () => validateLocalGenericV3Proposal(stale, fixture.env),
      /transition evidence is stale or changed/,
    );
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
  }
});

test("generic fixed-v3 bridge rejects a stale freeze before any R2 adapter", async () => {
  const fixture = genericV3SelectedScopeState();
  const boundary = fixedV3CoreApplyFixture();
  const counter = { calls: 0 };
  try {
    fixture.runState.observations_global_operation_lock = {
      run_id: boundary.runState.observations_global_operation_lock.run_id,
    };
    fixture.runState.objects[`${fixture.prefix}/manifest.json`].bytes += 1;
    const runStatePath = path.join(fixture.runRoot, "run-state.json");
    fs.writeFileSync(runStatePath, JSON.stringify(fixture.runState));
    await assert.rejects(
      applyValidatedGenericV3Proposal({
        runStatePath,
        env: boundary.env,
        r2: boundary.r2,
        adapters: remoteMutationAdapters(counter),
      }),
      /transition evidence is stale or changed/,
    );
    assert.equal(counter.calls, 0);
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
    fs.rmSync(boundary.root, { recursive: true, force: true });
  }
});

test("generic fixed-v3 bridge rejects the dedicated SOS execution path", async () => {
  const fixture = fixedV3CoreApplyFixture();
  const counter = { calls: 0 };
  try {
    await assert.rejects(
      applyValidatedGenericV3Proposal({
        runStatePath: fixture.runStatePath,
        env: fixture.env,
        r2: fixture.r2,
        adapters: remoteMutationAdapters(counter),
      }),
      /accepts generic_integrity proposals only/,
    );
    assert.equal(counter.calls, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("generic fixed-v3 authenticates an unstaged preserved Dropbox dependency", () => {
  const fixture = genericV3SelectedScopeState();
  try {
    const dayUtc = "2026-09-28";
    const externalPrefix = `history/v3/observations/day_utc=${dayUtc}`
      + "/connector_id=8/pollutant_code=pm10";
    const externalKey = `${externalPrefix}/manifest.json`;
    const externalBody = Buffer.from("preserved-pm10\n");
    const externalPath = path.join(fixture.runState.base_dropbox_root, ...externalKey.split("/"));
    fs.mkdirSync(path.dirname(externalPath), { recursive: true });
    fs.writeFileSync(externalPath, externalBody);
    const parentKey = `${fixture.prefix}/manifest.json`;
    const parent = fixture.runState.objects[parentKey];
    parent.dependencies.push(externalKey);
    parent.planner_dependencies.push(externalKey);
    const externalIdentity = {
      sha256: sha256Hex(externalBody),
      bytes: externalBody.byteLength,
      source: "dropbox",
    };
    parent.dependency_identities[externalKey] = externalIdentity;
    parent.planner_dependency_identities[externalKey] = externalIdentity;
    fixture.runState.generic_integrity_selected_scope_authority.selected_scopes.push({
      day_utc: dayUtc,
      connector_id: 8,
      pollutant_code: "pm10",
      outcome: "source_artifact_unavailable_preserved",
      authorised_tombstone_prefix: null,
      replacement_object_keys: [],
    });
    fixture.runState.final_staged_write_set_provenance.external_dependency_edge_counts.dropbox = 1;
    fixture.runState.proposal_transition_validation.state_fingerprint_sha256 =
      computeGenericV3TransitionStateFingerprint(fixture.runState);
    assert.doesNotThrow(() => validateLocalGenericV3Proposal(fixture.runState, fixture.env));

    fs.writeFileSync(externalPath, Buffer.from("changed-after-freeze\n"));
    assert.throws(
      () => validateLocalGenericV3Proposal(fixture.runState, fixture.env),
      /external dependency identity changed after planning/,
    );
  } finally {
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
  }
});
