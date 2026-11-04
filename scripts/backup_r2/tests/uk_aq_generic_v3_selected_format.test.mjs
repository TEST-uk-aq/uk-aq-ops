import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { observationsGlobalOperationLockIdentity } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { buildObservationHistoryV3SteadyStatePartition } from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { buildObservationHistoryExactLeafIndexV3ScopedHierarchy, buildObservationHistoryExactLeafIndexV3Latest,
  encodeObservationHistoryIndexV3Json, latestArtifactFromRoots } from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { computeObservationContentHash } from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { applyValidatedGenericV3Proposal } from "../uk_aq_apply_generic_v3_proposal.mjs";
import { computeGenericV3TransitionStateFingerprint, GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT,
  GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT, validateLocalGenericV3Proposal,
  validateFinalGenericV3ProposalGraph } from "../lib/generic_v3_proposal_validation.mjs";

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


const scope = { day_utc: "2026-10-10", connector_id: 8, pollutant_code: "no2" };
function builtScope(selectedScope = scope, schema = 1) {
  const rows = [{ ...selectedScope, station_id: 1, timeseries_id: 1,
    observed_at_utc: `${selectedScope.day_utc}T01:00:00.000Z`, value: 1, verification_status: "P" }];
  const built = buildObservationHistoryV3SteadyStatePartition({ source: "integrity",
    targetWriterGitSha: "a".repeat(40), rows });
  const m = built.canonical_pollutant_manifest;
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: built.target_metadata,
    canonicalManifest: { key: m.key, byte_size: m.byte_size, sha256: m.sha256,
      manifest_hash: m.payload.manifest_hash, row_count: m.payload.row_count,
      observation_content_hash: m.payload.observation_content_hash, observation_content_hash_version: 1 },
    exactSchemaVersion: schema });
  return { rows, built, hierarchy };
}
function fixture({ preserved = false } = {}) {
  const f = fixedV3CoreApplyFixture(), current = builtScope();
  const prefix = current.built.canonical_pollutant_manifest.key.slice(0, -"/manifest.json".length);
  const runState = f.runState;
  Object.assign(runState, { history_generation: "v3", environment: "TEST", execution_path: "generic_integrity",
    dedicated_sos_historical_replacement: false, run_root: f.root, overlay_root: path.join(f.root, "overlay") });
  f.stage = (artifact, dependencies = artifact.dependencies || [], prerequisites = artifact.publication_prerequisites || []) => {
    const body = Buffer.from(artifact.body), localPath = path.join(runState.overlay_root, ...artifact.key.split("/"));
    fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, body);
    const refs = [...dependencies, ...prerequisites];
    runState.objects[artifact.key] = { local_path: localPath, bytes: body.byteLength, sha256: sha256Hex(body),
      proposed: true, built: true, structurally_validated: true, changed: true, included_in_write_set: true,
      status: "planned", stage: artifact.key.endsWith(".parquet") ? "observations_data" : "observations_manifest",
      dependencies: refs.map(r => r.key), dependency_identities: Object.fromEntries(refs.map(r => [r.key,
        { bytes: r.byte_size, sha256: r.sha256, source: runState.objects[r.key] ? "planned_overlay" : "dropbox" }])) };
  };
  for (const a of current.built.file_intents) f.stage(a);
  const m = current.built.canonical_pollutant_manifest;
  f.stage(m, current.built.file_intents.map(a => ({ key: a.key, byte_size: a.body.byteLength, sha256: a.sha256 })));
  // The canonical serializer already records the exact physical file SHA/size.
  for (const a of current.hierarchy.publication_objects) f.stage(a);
  // All derived references are now staged, regardless of construction order.
  for (const entry of Object.values(runState.objects)) for (const [key, identity] of Object.entries(entry.dependency_identities)) {
    if (runState.objects[key]) identity.source = "planned_overlay";
  }
  const hierarchies = [current.hierarchy];
  if (preserved) hierarchies.push(builtScope({ ...scope, pollutant_code: "pm10" }, 2).hierarchy);
  f.latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: hierarchies });
  f.stage(f.latest, [{ key: current.hierarchy.scoped_manifest.key,
    byte_size: current.hierarchy.scoped_manifest.byte_size, sha256: current.hierarchy.scoped_manifest.sha256 }]);
  const baselinePath = path.join(runState.base_dropbox_root, ...f.latest.key.split("/"));
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true }); fs.writeFileSync(baselinePath, f.latest.body);
  runState.dropbox_currentness = { allowed: true, checkpoint: { observations_timeseries_latest: {
    key: f.latest.key, byte_size: f.latest.byte_size, sha256: f.latest.sha256 } } };
  runState.generic_integrity_selected_scope_authority = {
    contract_version: GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT, history_generation: "v3",
    selected_scopes: [{ ...scope, pollutant_prefix: prefix, outcome: "complete_replacement",
      authorised_tombstone_prefix: prefix, replacement_object_keys: Object.keys(runState.objects).filter(k => k.startsWith(`${prefix}/`)).sort(),
      preservation_evidence: null, source_evidence_authority: null }], metadata_only_scopes: [],
    metadata_only_derived_write_object_keys: [], explicit_force_targets: [], forced_republication_parquet_keys: [],
    authorised_pollutant_tombstone_prefixes: [prefix] };
  runState.tombstone_prefixes = [{ prefix, proposed: true, stage: "observations_data", repair_pollutants: [scope.pollutant_code],
    authority_outcome: "complete_replacement", authority_scope: scope }];
  const sourceDir = path.join(runState.overlay_root, `day_utc=${scope.day_utc}`, `connector_id=${scope.connector_id}`);
  fs.mkdirSync(sourceDir, { recursive: true });
  const stored = current.rows.map(({ day_utc, connector_id, observed_at_utc, ...row }) => ({ ...row, observed_at: observed_at_utc }));
  const rowsBody = Buffer.from(JSON.stringify(stored));
  fs.writeFileSync(path.join(sourceDir, "obs_history_rows.json"), rowsBody);
  fs.writeFileSync(path.join(sourceDir, "source-evidence.json"), JSON.stringify({ schema_version: 1, enumeration_complete: true,
    day_utc: scope.day_utc, connector_id: scope.connector_id, canonical_rows_bytes: rowsBody.byteLength,
    canonical_rows_sha256: sha256Hex(rowsBody), total_rows: stored.length, per_pollutant_counts: { no2: stored.length },
    observation_content_hashes: { no2: computeObservationContentHash(current.rows) } }));
  f.current = current;
  f.freeze = () => {
    const count = Object.keys(runState.objects).length;
    runState.proposal_ingestion = { status: "complete", transport_mode: "file_backed_compact_proposal",
      completed_object_count: count, total_object_count: count, node_apply_launch_permitted: false };
    runState.final_staged_write_set_provenance = { status: "finalised", final_staged_object_count: count,
      forced_republication_keys: [], forced_republication_count: 0, rebuilt_dependency_identity_count: 0,
      staged_dependency_edge_count: 0, external_dependency_edge_counts: { dropbox: 0, overlay: 0 },
      promotion_reason_counts: {} };
    runState.proposal_transition_validation = { status: "succeeded", node_apply_launch_permitted: true,
      state_fingerprint_contract_version: GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
      state_fingerprint_sha256: computeGenericV3TransitionStateFingerprint(runState) };
    fs.writeFileSync(f.runStatePath, JSON.stringify(runState));
  };
  f.rewrite = (key, change) => {
    const entry = runState.objects[key], payload = change(JSON.parse(fs.readFileSync(entry.local_path)));
    const body = Buffer.from(encodeObservationHistoryIndexV3Json(payload));
    fs.writeFileSync(entry.local_path, body); entry.bytes = body.byteLength; entry.sha256 = sha256Hex(body);
    for (const object of Object.values(runState.objects)) if (object.dependency_identities[key]) {
      Object.assign(object.dependency_identities[key], { bytes: entry.bytes, sha256: entry.sha256 });
    }
  };
  f.freeze();
  return f;
}
async function rejectThroughBridge(f, pattern) {
  f.freeze();
  const calls = [];
  const unexpected = name => async () => { calls.push(name); throw new Error(`unexpected adapter: ${name}`); };
  await assert.rejects(applyValidatedGenericV3Proposal({ runStatePath: f.runStatePath, env: f.env, r2: f.r2,
    adapters: { ...Object.fromEntries(["getObject", "headObject", "putObject", "deleteObjects", "listAllObjects",
      "removePrefix", "finalize"].map(name => [name, unexpected(name)])),
      historyWriterClient: { query: unexpected("query") } } }), pattern);
  assert.deepEqual(calls, [], "rejection must precede every remote adapter");
  const saved = JSON.parse(fs.readFileSync(f.runStatePath));
  assert.notEqual(saved.apply?.status, "succeeded");
  assert.equal(saved.apply?.r2_mutation_possible, false);
  assert.equal(saved.apply?.publication_schedule, undefined);
}

test("schema-1 complete generic graph passes existing local and final validation, including preserved schema-2 reference", async () => {
  for (const preserved of [false, true]) {
    const f = fixture({ preserved });
    try {
      const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
      const result = await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal });
      assert.equal(result.status, "succeeded");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

for (const [name, change] of [
  ["schema-2", p => ({ ...p, schema_version: 2, kind: "observation_timeseries_physical_leaf_scoped_manifest_v2",
    exact_leaf_index_version: "exact-timeseries-leaf-v2" })],
  ["unknown-format", p => ({ ...p, exact_leaf_index_version: "future" })],
  ["missing version", p => { delete p.exact_leaf_index_version; return p; }],
  ["contradictory scope", p => ({ ...p, connector_id: 9 })],
  ["invalid shape", () => []],
  ["selector-only", p => ({ ...p, leaves_by_timeseries_id: {} })],
  ["leaf dependency contradiction", p => { p.leaves_by_timeseries_id["1"][2] = "f".repeat(64); return p; }],
]) test(`actual generic bridge rejects ${name} before all mutation adapters`, async () => {
  const f = fixture();
  try {
    f.rewrite(f.current.hierarchy.scoped_manifest.key, change);
    await rejectThroughBridge(f, /selected-format admission rejected/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("actual generic bridge rejects invalid JSON and changed staged bytes after freeze", async () => {
  for (const reauthenticate of [false, true]) {
    const f = fixture();
    try {
      const entry = f.runState.objects[f.current.hierarchy.scoped_manifest.key];
      fs.writeFileSync(entry.local_path, "{");
      if (reauthenticate) { entry.bytes = 1; entry.sha256 = sha256Hex(Buffer.from("{"));
        for (const object of Object.values(f.runState.objects)) if (object.dependency_identities[f.current.hierarchy.scoped_manifest.key]) {
          Object.assign(object.dependency_identities[f.current.hierarchy.scoped_manifest.key], { bytes: 1, sha256: entry.sha256 });
        }
      }
      // Local byte-identity failure predates final-graph audit creation.
      f.freeze(); const calls = [];
      await assert.rejects(applyValidatedGenericV3Proposal({ runStatePath: f.runStatePath, env: f.env, r2: f.r2,
        adapters: { putObject: async () => calls.push("put"), deleteObjects: async () => calls.push("delete") } }),
        reauthenticate ? /invalid JSON/ : /identity changed|dependency identity is invalid/);
      assert.deepEqual(calls, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("actual generic bridge rejects changed latest schema-2 selection and absent selector graph", async () => {
  for (const removeSelector of [false, true]) {
    const f = fixture();
    try {
      if (removeSelector) {
        delete f.runState.objects[f.current.hierarchy.scoped_manifest.key];
        const latest = f.runState.objects[f.latest.key]; latest.dependencies = []; latest.dependency_identities = {};
      } else f.rewrite(f.latest.key, p => { Object.assign(p.day_summaries[0].scoped_roots[0], {
        exact_index_schema_version: 2, exact_index_kind: "observation_timeseries_physical_leaf_scoped_manifest_v2",
        exact_leaf_index_version: "exact-timeseries-leaf-v2" }); return p; });
      await rejectThroughBridge(f, /selected-format|compact latest/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("immutable schema-2 revision remains outside the actual generic bridge allowlist", async () => {
  const f = fixture();
  try {
    f.stage(builtScope(scope, 2).hierarchy.exact_leaves[0], []);
    f.freeze(); const calls = [];
    await assert.rejects(applyValidatedGenericV3Proposal({ runStatePath: f.runStatePath, env: f.env, r2: f.r2,
      adapters: { putObject: async () => calls.push("put"), deleteObjects: async () => calls.push("delete") } }),
      /Non-observation history is outside/);
    assert.deepEqual(calls, []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("supported schema-1 reaches the frozen schedule through the actual bridge", async () => {
  const f = fixture({ preserved: true });
  try {
    // No retained database adapter is supplied: stop after admission/scheduling,
    // before any operation. This is structural validation, not a repair run.
    await assert.rejects(applyValidatedGenericV3Proposal({ runStatePath: f.runStatePath,
      env: f.env, r2: f.r2 }), /requires one retained PostgreSQL history-writer session/);
    const saved = JSON.parse(fs.readFileSync(f.runStatePath));
    assert.equal(saved.final_proposal_graph_validation.status, "succeeded");
    assert.equal(saved.apply.publication_schedule.total_positions, Object.keys(f.runState.objects).length);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a genuine selector-only graph cannot bypass generic APPLY with schema 1 or 2", async () => {
  for (const schema of [1, 2]) {
    const f = fixture();
    try {
      const selector = f.current.hierarchy.scoped_manifest.key;
      for (const key of Object.keys(f.runState.objects)) {
        if (key.startsWith("history/_index_v3/observations_timeseries/") && key !== selector) delete f.runState.objects[key];
      }
      f.runState.objects[selector].dependencies = [];
      f.runState.objects[selector].dependency_identities = {};
      if (schema === 2) f.rewrite(selector, p => ({ ...p, schema_version: 2 }));
      await rejectThroughBridge(f, /selected-format admission rejected/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("unchanged external schema-1 leaf/aligned dependencies retain pinned body authority", async () => {
  const f = fixture();
  try {
    const externalKeys = f.current.hierarchy.publication_objects.filter(a => a !== f.current.hierarchy.scoped_manifest).map(a => a.key);
    for (const key of externalKeys) {
      const entry = f.runState.objects[key], target = path.join(f.runState.base_dropbox_root, ...key.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(entry.local_path, target);
      delete f.runState.objects[key];
    }
    // Canonical bytes are restaged for replacement. Pinned external derived
    // bodies commit those exact identities; they need no redundant PUT.
    for (const object of Object.values(f.runState.objects)) for (const key of externalKeys) {
      if (object.dependency_identities[key]) object.dependency_identities[key].source = "dropbox";
    }
    f.freeze();
    const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
    assert.equal((await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal })).status, "succeeded");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an affected prior schema-2 selection cannot be converted by a schema-1 proposal", async () => {
  const f = fixture();
  try {
    const prior = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [builtScope(scope, 2).hierarchy] });
    fs.writeFileSync(path.join(f.runState.base_dropbox_root, ...prior.key.split("/")), prior.body);
    Object.assign(f.runState.dropbox_currentness.checkpoint.observations_timeseries_latest,
      { byte_size: prior.byte_size, sha256: prior.sha256 });
    await rejectThroughBridge(f, /affected prior schema-2 selection is unsupported/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("changing an unaffected preserved schema-2 descriptor fails before mutation", async () => {
  const f = fixture({ preserved: true });
  try {
    f.rewrite(f.latest.key, p => { p.day_summaries[0].scoped_roots[1].sha256 = "f".repeat(64); return p; });
    await rejectThroughBridge(f, /unaffected selection changed/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

async function metadataOnly(f) {
  const { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } = await import("../../../workers/shared/uk_aq_r2_history_canonical.mjs");
  const { buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsYearManifest,
    buildR2HistoryV2ObservationsRootManifest, serializeR2HistoryV2ObservationsAggregateManifest }
    = await import("../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs");
  const base = "history/v3/observations", day = scope.day_utc;
  const common = { domain: "observations", dayUtc: day, writerGitSha: "a".repeat(40), backedUpAtUtc: null };
  const connector = buildHistoryV2ConnectorManifest({ ...common, connectorId: scope.connector_id,
    manifestKey: `${base}/day_utc=${day}/connector_id=${scope.connector_id}/manifest.json`,
    pollutantManifests: [f.current.built.canonical_pollutant_manifest.payload] });
  const d = buildHistoryV2DayManifest({ ...common, manifestKey: `${base}/day_utc=${day}/manifest.json`, connectorManifests: [connector] });
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: 2026, month: "10", dayManifests: [d] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [year] });
  const canonical = [[connector.manifest_key, Buffer.from(JSON.stringify(connector))],
    [d.manifest_key, Buffer.from(JSON.stringify(d))],
    ...[month, year, root].map((p, i) => [`${base}/_manifests/${["year=2026/month=10/manifest.json", "year=2026/manifest.json", "manifest.json"][i]}`,
      serializeR2HistoryV2ObservationsAggregateManifest(p, { basePrefix: base })])];
  for (const [key, entry] of Object.entries(f.runState.objects)) if (key.startsWith(`${base}/`)) {
    canonical.push([key, fs.readFileSync(entry.local_path)]); delete f.runState.objects[key];
  }
  for (const [key, body] of canonical) {
    const target = path.join(f.runState.base_dropbox_root, ...key.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
  }
  for (const entry of Object.values(f.runState.objects)) for (const [key, ref] of Object.entries(entry.dependency_identities)) {
    if (key.startsWith(`${base}/`)) ref.source = "dropbox";
  }
  const keys = [root, year, month, d, connector].map(p => p.manifest_key);
  // Aggregate builders expose their keys through the established deterministic paths.
  keys.splice(0, 3, `${base}/_manifests/manifest.json`, `${base}/_manifests/year=2026/manifest.json`, `${base}/_manifests/year=2026/month=10/manifest.json`);
  keys.push(f.current.built.canonical_pollutant_manifest.key);
  const authority = f.runState.generic_integrity_selected_scope_authority;
  authority.selected_scopes = []; authority.authorised_pollutant_tombstone_prefixes = [];
  f.runState.tombstone_prefixes = [];
  authority.metadata_only_scopes = [{ ...scope, derived_index_prefix: f.current.hierarchy.scoped_manifest.key.slice(0, -"/manifest.json".length),
    canonical_dependencies: keys.map(key => { const body = fs.readFileSync(path.join(f.runState.base_dropbox_root, ...key.split("/")));
      return { object_key: key, bytes: body.byteLength, sha256: sha256Hex(body), source: "dropbox" }; }),
    derived_object_keys: Object.keys(f.runState.objects).filter(key => key !== f.latest.key).sort(), observation_deletion_prefixes: [] }];
  authority.metadata_only_derived_write_object_keys = Object.keys(f.runState.objects).sort();
  f.freeze();
}

test("legitimate schema-1 metadata-only graph keeps its canonical pinned dependencies", async () => {
  const f = fixture();
  try {
    await metadataOnly(f);
    const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
    assert.equal(proposal.prefixes.length, 0);
    assert.equal((await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal })).status, "succeeded");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("metadata-only selector without its compatible leaf closure fails through the real bridge", async () => {
  const f = fixture();
  try {
    await metadataOnly(f);
    const selector = f.current.hierarchy.scoped_manifest.key;
    for (const key of Object.keys(f.runState.objects)) if (key !== selector && key !== f.latest.key) delete f.runState.objects[key];
    f.runState.objects[selector].dependencies = []; f.runState.objects[selector].dependency_identities = {};
    const authority = f.runState.generic_integrity_selected_scope_authority;
    authority.metadata_only_scopes[0].derived_object_keys = [selector];
    authority.metadata_only_derived_write_object_keys = Object.keys(f.runState.objects).sort();
    await rejectThroughBridge(f, /body\/dependency contradiction/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("authoritative empty schema-1 scope may remove the last latest descriptor", async () => {
  const f = fixture();
  try {
    for (const key of Object.keys(f.runState.objects)) delete f.runState.objects[key];
    const latest = latestArtifactFromRoots([], "history/_index_v3/observations_timeseries", f.latest.key); f.stage(latest);
    const selected = f.runState.generic_integrity_selected_scope_authority.selected_scopes[0];
    selected.outcome = "authoritative_no_data_replacement"; selected.replacement_object_keys = [];
    f.runState.tombstone_prefixes[0].authority_outcome = selected.outcome;
    const sourceDir = path.join(f.runState.overlay_root, `day_utc=${scope.day_utc}`, `connector_id=${scope.connector_id}`);
    fs.writeFileSync(path.join(sourceDir, "obs_history_rows.json"), "[]");
    fs.writeFileSync(path.join(sourceDir, "source-evidence.json"), JSON.stringify({ schema_version: 1, enumeration_complete: true,
      day_utc: scope.day_utc, connector_id: scope.connector_id, canonical_rows_bytes: 2,
      canonical_rows_sha256: sha256Hex(Buffer.from("[]")), total_rows: 0, per_pollutant_counts: {}, observation_content_hashes: {} }));
    f.freeze();
    const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
    assert.equal((await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal })).status, "succeeded");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("schema-1 byte-identical replacement may retain the authenticated selector and latest outside the PUT set", async () => {
  const f = fixture();
  try {
    for (const artifact of f.current.hierarchy.publication_objects) {
      const entry = f.runState.objects[artifact.key], target = path.join(f.runState.base_dropbox_root, ...artifact.key.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(entry.local_path, target);
      delete f.runState.objects[artifact.key];
    }
    delete f.runState.objects[f.latest.key];
    f.freeze();
    const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
    assert.equal((await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal })).status, "succeeded");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("preserved schema-2 reference cannot hide removal from a staged canonical parent", async () => {
  const f = fixture({ preserved: true });
  try {
    const m = f.current.built.canonical_pollutant_manifest;
    const key = m.key.replace("/pollutant_code=no2", "");
    f.stage({ key, body: JSON.stringify({ pollutant_manifests: [
      { manifest_key: m.key, manifest_hash: m.payload.manifest_hash } ] }) },
      [{ key: m.key, byte_size: m.byte_size, sha256: m.sha256 }]);
    await rejectThroughBridge(f, /preserved schema-2 canonical child omitted/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("schema-1 repair preserves a schema-2 sibling through a rebuilt canonical parent", async () => {
  const f = fixture({ preserved: true });
  try {
    const { buildHistoryV2ConnectorManifest } = await import("../../../workers/shared/uk_aq_r2_history_canonical.mjs");
    const m = f.current.built.canonical_pollutant_manifest;
    const sibling = builtScope({ ...scope, pollutant_code: "pm10" }, 2).built.canonical_pollutant_manifest;
    const target = path.join(f.runState.base_dropbox_root, ...sibling.key.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, sibling.body);
    const key = m.key.replace("/pollutant_code=no2", "");
    const parent = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: scope.day_utc,
      connectorId: scope.connector_id, writerGitSha: "a".repeat(40), backedUpAtUtc: null,
      manifestKey: key, pollutantManifests: [m.payload, sibling.payload] });
    f.stage({ key, body: JSON.stringify(parent) }, [m, sibling]);
    f.freeze();
    const proposal = validateLocalGenericV3Proposal(f.runState, f.env);
    assert.equal((await validateFinalGenericV3ProposalGraph({ runState: f.runState, proposal })).status, "succeeded");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
