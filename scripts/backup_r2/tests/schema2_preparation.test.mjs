import "../../../tests/jsongen_test_environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV as LOCK_ENV, observationsGlobalOperationLockIdentity,
  observationsGlobalOperationLockContext } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { serveIntegrityAssertions, INTEGRITY_CHANNEL_ENV } from "../../operations/lib/uk_aq_integrity_original_operation.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { buildObservationHistoryV3SteadyStatePartition } from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsRootManifest, serializeR2HistoryV2ObservationsAggregateManifest,
} from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { buildObservationHistoryExactLeafIndexV3ScopedHierarchy, buildObservationHistoryExactLeafIndexV3Latest,
  encodeObservationHistoryIndexV3Json as canonical,
} from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { prepareSchema2PreparationV1, validateSchema2PreparationV1,
  SCHEMA2_PREPARATION_FREEZE_V1, SCHEMA2_PREPARATION_FINGERPRINT_V1,
} from "../lib/schema2_preparation.mjs";
import { SCHEMA2_PREPARATION_LIMITS } from "../lib/schema2_preparation_resources.mjs";
import { admitSchema2CurrentObjectsV1 } from "../lib/schema2_current_object_admission.mjs";

const base = "history/v3/observations", day = "2026-10-10";
const rootKey = `${base}/_manifests/manifest.json`;
const identity = a => ({ key: a.key, byte_size: a.byte_size, sha256: a.sha256 });

function partition(value = 10, pollutant = "no2") {
  return buildObservationHistoryV3SteadyStatePartition({ source: "integrity", targetWriterGitSha: "a".repeat(40), backedUpAtUtc: null,
    rows: [1, 2].map(id => ({ connector_id: 1, station_id: id, timeseries_id: id, pollutant_code: pollutant,
      observed_at_utc: `${day}T01:00:00.000Z`, value: value + id, verification_status: "P" })) });
}

function fixture(t, value = 10, includeRetainedSchema1 = false) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage2k-preparation-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const dropboxRoot = path.join(runRoot, "baseline"), overlayRoot = path.join(runRoot, "overlay");
  fs.mkdirSync(dropboxRoot); fs.mkdirSync(overlayRoot);
  const built = partition(value), m = built.canonical_pollutant_manifest;
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: built.target_metadata,
    canonicalManifest: { ...identity(m), manifest_hash: m.payload.manifest_hash, row_count: m.payload.row_count,
      observation_content_hash: m.payload.observation_content_hash, observation_content_hash_version: 1 }, exactSchemaVersion: 2 });
  const retained = includeRetainedSchema1 ? partition(20, "pm25") : null;
  const rm = retained?.canonical_pollutant_manifest;
  const retainedHierarchy = retained ? buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: retained.target_metadata,
    canonicalManifest: { ...identity(rm), manifest_hash: rm.payload.manifest_hash, row_count: rm.payload.row_count,
      observation_content_hash: rm.payload.observation_content_hash, observation_content_hash_version: 1 }, exactSchemaVersion: 1 }) : null;
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [hierarchy, ...(retainedHierarchy ? [retainedHierarchy] : [])] });
  const common = { domain: "observations", dayUtc: day, writerGitSha: "a".repeat(40), backedUpAtUtc: null };
  const connector = buildHistoryV2ConnectorManifest({ ...common, connectorId: 1,
    manifestKey: `${base}/day_utc=${day}/connector_id=1/manifest.json`, pollutantManifests: [m.payload, ...(rm ? [rm.payload] : [])] });
  const d = buildHistoryV2DayManifest({ ...common, manifestKey: `${base}/day_utc=${day}/manifest.json`, connectorManifests: [connector] });
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: 2026, month: "10", dayManifests: [d] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [year] });
  const bodies = new Map([...built.file_intents, m, ...(retained ? [...retained.file_intents, rm] : []), latest].map(a => [a.key, Buffer.from(a.body)]));
  for (const p of [connector, d]) bodies.set(p.manifest_key, Buffer.from(JSON.stringify(p)));
  for (const [p, key] of [[month, `${base}/_manifests/year=2026/month=10/manifest.json`],
    [year, `${base}/_manifests/year=2026/manifest.json`], [root, rootKey]]) {
    bodies.set(key, serializeR2HistoryV2ObservationsAggregateManifest(p, { basePrefix: base }));
  }
  const baselineObjects = [...bodies].map(([key, body]) => {
    const local = path.join(dropboxRoot, key);
    fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, body);
    return { key, relative_path: path.relative(runRoot, local), byte_size: body.length, sha256: sha256Hex(body) };
  });
  const run_id = "stage2k-preparation-check";
  const runState = { run_id, history_generation: "v3", execution_path: "generic_integrity", base_dropbox_root: dropboxRoot,
    overlay_root: overlayRoot, objects: {}, observations_global_operation_lock: { owner: "integrity", run_id },
    dropbox_currentness: { allowed: true, checkpoint_live_root_match: true, checkpoint: {
      observations_processed_source_root_hash: root.content_hash, observations_timeseries_latest: identity(latest) } } };
  return { runRoot, dropboxRoot, overlayRoot, built, hierarchy, retainedHierarchy, bodies, value,
    request: { runState, runRoot, scopes: [built.scope], baselineObjects, overlayObjects: [] } };
}

function installCompleteOverlay(f, changed) {
  for (const [key, body] of changed.bodies) {
    if (!key.startsWith(`${base}/`)) continue;
    if (body.equals(f.bodies.get(key))) continue;
    const local = path.join(f.overlayRoot, key);
    fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, body);
    f.request.overlayObjects.push({ key, byte_size: body.length, sha256: sha256Hex(body), relative_path: path.relative(f.runRoot, local) });
    f.request.runState.objects[key] = { structurally_validated: true, proposed: true, built: true,
      proposal_owner: "source_derived_observation_repair", local_path: local, bytes: body.length, sha256: sha256Hex(body) };
  }
  const scope = changed.built.scope;
  const scopeId = `day_utc=${scope.day_utc}/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`;
  const sourceDir = path.join(f.overlayRoot, "source-evidence", scopeId);
  fs.mkdirSync(sourceDir, { recursive: true });
  const rows = [1, 2].map(id => ({ connector_id: 1, station_id: id, timeseries_id: id, pollutant_code: "no2",
    observed_at: `${day}T01:00:00.000Z`, value: changed.value + id, verification_status: "P" }));
  const rowsBody = Buffer.from(JSON.stringify(rows));
  const metadata = changed.built.target_metadata;
  const hash = Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith("observation_content_hash") || key === "verification_status_counts"));
  const evidenceBody = Buffer.from(JSON.stringify({ schema_version: 1, enumeration_complete: true, ...scope,
    requested_pollutant_set: [scope.pollutant_code], canonical_rows_bytes: rowsBody.length, canonical_rows_sha256: sha256Hex(rowsBody),
    total_rows: rows.length, per_pollutant_counts: { [scope.pollutant_code]: rows.length },
    observation_content_hashes: { [scope.pollutant_code]: hash } }));
  const rowsPath = path.join(sourceDir, "obs_history_rows.json"), evidencePath = path.join(sourceDir, "source-evidence.json");
  fs.writeFileSync(rowsPath, rowsBody); fs.writeFileSync(evidencePath, evidenceBody);
  f.request.runState.source_evidence_partitions = { [scopeId]: { identity: scopeId, ...scope,
    rows_path: rowsPath, evidence_path: evidencePath, rows_sha256: sha256Hex(rowsBody), evidence_sha256: sha256Hex(evidenceBody) } };
}

function refreeze(preparation) {
  const { freeze, fingerprint, ...projection } = preparation;
  const canonical_json = canonical(projection), sha256 = sha256Hex(canonical_json);
  return { ...projection,
    freeze: { contract_version: SCHEMA2_PREPARATION_FREEZE_V1, canonical_json, byte_size: Buffer.byteLength(canonical_json), sha256 },
    fingerprint: { contract_version: SCHEMA2_PREPARATION_FINGERPRINT_V1, sha256 } };
}

test("actual schema-2 bytes prepare separately and independently validate; altered bytes and refrozen graphs reject", async t => {
  const f = fixture(t), preparation = await prepareSchema2PreparationV1(f.request);
  assert.equal(preparation.outcomes[0].outcome, "unchanged_or_preserved");
  assert.equal(preparation.outcomes[0].prior.schema_version, 2);
  assert.equal(preparation.outcomes[0].proposed.sha256, f.hierarchy.scoped_manifest.sha256);
  assert.equal(preparation.repair_apply_eligible, false);
  assert.equal(preparation.publication_eligible, false);
  assert.equal(preparation.current_object_authority, null);
  assert.deepEqual(f.request.runState.objects, {});
  assert.equal((await validateSchema2PreparationV1(f.request)).valid, true);
  const entry = preparation.inventory.find(e => e.type === "canonical_parquet");
  const stagedPath = path.join(f.runRoot, entry.body_ref.relative_path), original = fs.readFileSync(stagedPath);
  const changed = Buffer.from(original); changed[4] ^= 1; fs.writeFileSync(stagedPath, changed);
  await assert.rejects(() => validateSchema2PreparationV1(f.request), /changed body|identity/);
  fs.writeFileSync(stagedPath, original);
  const forged = structuredClone(preparation); forged.edges.pop();
  await assert.rejects(() => validateSchema2PreparationV1({ ...f.request, preparation: refreeze(forged) }), /independent complete graph/);
  for (const extra of [false, true]) {
    const forgedInventory = structuredClone(preparation);
    if (extra) forgedInventory.inventory.push({ ...forgedInventory.inventory[0], key: `${base}/extra.json` });
    else forgedInventory.inventory.pop();
    await assert.rejects(() => validateSchema2PreparationV1({ ...f.request, preparation: refreeze(forgedInventory) }), /independent complete graph/);
  }
  const badFingerprint = structuredClone(preparation); badFingerprint.fingerprint.sha256 = "0".repeat(64);
  await assert.rejects(() => validateSchema2PreparationV1({ ...f.request, preparation: badFingerprint }), /freeze\/fingerprint/);
});

test("missing or extra inventory and symlink parent paths cannot pass preparation admission", async t => {
  for (const fault of ["missing", "extra", "symlink"]) {
    const f = fixture(t);
    if (fault === "missing") f.request.baselineObjects = f.request.baselineObjects.filter(e => e.key !== f.built.file_intents[0].key);
    if (fault === "extra") {
      const key = `${base}/unused.json`, body = Buffer.from("{}");
      fs.writeFileSync(path.join(f.dropboxRoot, key), body);
      f.request.baselineObjects.push({ key, relative_path: `baseline/${key}`, byte_size: body.length, sha256: sha256Hex(body) });
    }
    if (fault === "symlink") {
      fs.renameSync(path.join(f.dropboxRoot, "history"), path.join(f.dropboxRoot, "real-history"));
      fs.symlinkSync("real-history", path.join(f.dropboxRoot, "history"));
    }
    await assert.rejects(() => prepareSchema2PreparationV1(f.request), /missing|membership|symlink|physical identity/);
    assert.equal(fs.existsSync(path.join(f.runRoot, "schema2-preparation")), false);
  }
});

test("a changed overlay cannot borrow a missing current-run body identity", async t => {
  const f = fixture(t), changed = partition(50).file_intents[0], local = path.join(f.overlayRoot, changed.key);
  fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, changed.body);
  f.request.overlayObjects.push({ ...identity(changed), relative_path: path.relative(f.runRoot, local) });
  f.request.runState.objects[changed.key] = { structurally_validated: true, proposed: true, built: true,
    proposal_owner: "source_derived_observation_repair", local_path: local, bytes: changed.byte_size };
  await assert.rejects(() => prepareSchema2PreparationV1(f.request), /not pinned current-run replacement/);
  assert.equal(fs.existsSync(path.join(f.runRoot, "schema2-preparation")), false);
});

test("complete source-authenticated replacement retains prior identity and cannot borrow removed or changed overlay bytes", async t => {
  const f = fixture(t, 10, true), changed = fixture(t, 50, true);
  installCompleteOverlay(f, changed);
  const originalObjects = structuredClone(f.request.runState.objects);
  const preparation = await prepareSchema2PreparationV1(f.request);
  const outcome = preparation.outcomes[0];
  assert.equal(outcome.outcome, "complete_nonempty_replacement");
  assert.equal(outcome.prior.sha256, f.hierarchy.scoped_manifest.sha256);
  assert.equal(outcome.proposed.sha256, changed.hierarchy.scoped_manifest.sha256);
  assert.notEqual(outcome.prior.sha256, outcome.proposed.sha256);
  assert.ok(outcome.source_evidence.rows_sha256);
  const preserved = preparation.outcomes.find(entry => entry.scope.pollutant_code === "pm25");
  assert.equal(preserved.affected, false);
  assert.equal(preserved.prior.schema_version, 1);
  assert.equal(preserved.proposed.sha256, f.retainedHierarchy.scoped_manifest.sha256);
  assert.ok(preparation.inventory.some(entry => entry.key.includes("/_aligned/")));
  assert.deepEqual(f.request.runState.objects, originalObjects);
  assert.equal((await validateSchema2PreparationV1(f.request)).valid, true);
  const key = changed.built.file_intents[0].key, local = path.join(f.overlayRoot, key);
  assert.ok(fs.existsSync(path.join(f.dropboxRoot, key)), "original baseline body remains present");
  const original = fs.readFileSync(local);
  fs.unlinkSync(local);
  await assert.rejects(() => validateSchema2PreparationV1(f.request), /ENOENT|missing|local|identity/);
  const mutated = Buffer.from(original); mutated[4] ^= 1; fs.writeFileSync(local, mutated);
  await assert.rejects(() => validateSchema2PreparationV1(f.request), /changed body|identity/);
});

// Stage 2L checks reuse these real preparation/physical fixtures. Only remote
// R2 and PostgreSQL ownership are substituted. The production original-session
// client and server framing run over an actual inherited descriptor; this is
// structural evidence, not real PostgreSQL continuity or TEST acceptance.
async function admissionFixture(t, changed = false) {
  const f = fixture(t, 10, true);
  if (changed) installCompleteOverlay(f, fixture(t, 50, true));
  const lock = observationsGlobalOperationLockIdentity(), nonce = randomUUID();
  f.env = { ...process.env, [LOCK_ENV.held]: "true", [LOCK_ENV.acquired]: "true", [LOCK_ENV.owner]: "integrity",
    [LOCK_ENV.runId]: f.request.runState.run_id, [LOCK_ENV.logicalIdentity]: lock.logical_identity,
    [LOCK_ENV.classId]: String(lock.class_id), [LOCK_ENV.objectId]: String(lock.object_id),
    [LOCK_ENV.nonce]: nonce, [LOCK_ENV.waitMs]: "0", [LOCK_ENV.outcome]: "held" };
  f.request.runState.observations_global_operation_lock = observationsGlobalOperationLockContext({ env: f.env });
  f.preparation = await prepareSchema2PreparationV1(f.request);
  f.remote = new Map(f.bodies);
  for (const hierarchy of [f.hierarchy, f.retainedHierarchy]) {
    for (const artifact of hierarchy.publication_objects) f.remote.set(artifact.key, Buffer.from(artifact.body));
  }
  return f;
}

async function runAdmissionChild(f, { fault = null, loseAt = null, channel = true, phase = "APPLY" } = {}) {
  const binding = { owner: "integrity", run_id: f.request.runState.run_id,
    nonce: f.env[LOCK_ENV.nonce], session_pid: 71, operation_lifetime: randomUUID() };
  const script = `
    import fs from 'node:fs';
    import { admitSchema2CurrentObjectsV1 } from './scripts/backup_r2/lib/schema2_current_object_admission.mjs';
    import { integrityOriginalOperationForApply, assertOriginalIntegrityOperationHeld } from './scripts/operations/lib/uk_aq_integrity_original_operation.mjs';
    process.on('SIGTERM', () => {}); // Let a cancelled check report its diagnostics.
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const remote = new Map(input.remote.map(([key, body]) => [key, Buffer.from(body, 'base64')]));
    const counts = new Map(); let writes = 0, gets = 0;
    const before = JSON.stringify(input.request);
    const r2 = { adapter: {
      async getObjectBounded({ key, max_bytes, accept_encoding_identity }) {
        gets++; counts.set(key, (counts.get(key) || 0) + 1);
        if (!accept_encoding_identity) throw new Error('identity encoding required');
        let body = remote.get(key), etag = '"current-' + key + '"';
        if (input.fault === 'missing_leaf' && key.includes('/_exact_v2/')) throw Object.assign(new Error('missing current leaf'), { status: 404 });
        if (input.fault === 'changed_current' && gets === 1) { body = Buffer.from(body); body[0] ^= 1; }
        if (input.fault === 'weak_selector' && key === input.selector) etag = 'W/"weak"';
        if (input.fault === 'changed_recheck' && key === input.selector && counts.get(key) === 2) etag = '"different"';
        if (input.fault === 'local_tamper' && gets === 1) fs.appendFileSync(input.localBody, ' ');
        if (input.fault === 'mutate_caller' && gets === 1) input.request.runState.run_id = 'swapped';
        if (!body || body.length > max_bytes) throw new Error('bounded current object unavailable');
        return { body, bytes: body.length, etag };
      },
      putObject() { writes++; throw new Error('unexpected write'); },
      deleteObjects() { writes++; throw new Error('unexpected delete'); },
    } };
    let output;
    try {
      const report = await admitSchema2CurrentObjectsV1({ request: input.request, phase: input.phase, r2 });
      output = { report, gets, writes, unchanged: before === JSON.stringify(input.request),
        diagnosticFrozen: Object.isFrozen(report.authenticated_objects[0]) && Object.isFrozen(report.selectors[0].frozen_proposed) };
      await integrityOriginalOperationForApply({ expectedRunId: report.original_session.run_id }).complete();
    } catch (error) {
      let permanentlyLost = false;
      try { await assertOriginalIntegrityOperationHeld({ expectedRunId: input.request.runState.run_id }); }
      catch { permanentlyLost = true; }
      output = { blocked: true, error: error.message, gets, writes, permanentlyLost };
    }
    // Production cancellation terminates this child. Our SIGTERM handler only
    // keeps it alive long enough to report permanent rejection to the parent.
    process.stdout.write(JSON.stringify(output) + '\\n', () => process.exit(0));
  `;
  const childEnv = { ...f.env };
  delete childEnv[INTEGRITY_CHANNEL_ENV];
  if (channel) childEnv[INTEGRITY_CHANNEL_ENV] = JSON.stringify({ fd: 3, binding });
  const child = spawn(process.execPath, ["--import", "./tests/jsongen_test_environment.mjs", "--input-type=module", "-e", script],
    { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", wire = "", assertions = 0;
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const owner = new EventEmitter(); owner.connected = true;
  owner.send = (message, callback) => child.stdio[3].write(`${JSON.stringify(message)}\n`, callback);
  child.stdio[3].on("error", () => {});
  const stop = serveIntegrityAssertions({ channel: owner, binding,
    assertOwned: async () => {
      if (++assertions === loseAt) throw new Error("injected original ownership loss");
      return 71;
    }, onFailure: () => child.stdio[3].destroy() });
  child.stdio[3].on("data", chunk => {
    wire += chunk;
    for (;;) {
      const end = wire.indexOf("\n"); if (end < 0) break;
      const frame = wire.slice(0, end); wire = wire.slice(end + 1);
      owner.emit("message", JSON.parse(frame));
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); stop();
      if (code !== 0) reject(new Error(`admission child ${code}/${signal}: ${stderr} ${stdout}`));
      else { try { resolve({ ...JSON.parse(stdout), assertions }); } catch (e) { reject(e); } }
    });
  });
  child.stdin.end(JSON.stringify({ request: f.request, remote: [...f.remote].map(([key, body]) => [key, body.toString("base64")]),
    fault, phase, selector: f.hierarchy.scoped_manifest.key,
    localBody: path.join(f.runRoot, f.preparation.inventory[0].body_ref.relative_path) }));
  return await ended;
}

test("Stage 2L authenticates complete fresh mixed-format prior closure, distinct proposed bytes and original descriptor assertions", async t => {
  const f = await admissionFixture(t, true), result = await runAdmissionChild(f);
  assert.equal(result.report?.state, "authenticated_read_only_diagnostic", JSON.stringify(result));
  assert.equal(result.gets, 2 * f.remote.size);
  assert.equal(result.assertions, 4 * f.remote.size + 2 * f.preparation.outcomes.length + 2);
  assert.equal(result.report.original_session.session_pid, 71);
  assert.equal(result.report.repair_apply_eligible, false);
  assert.equal(result.report.publication_eligible, false);
  assert.equal(result.report.reusable_currentness, false);
  assert.equal(result.report.current_object_authority, null);
  assert.equal(result.report.evidence_scope, "completed_call_only");
  assert.deepEqual(result.report.preparation_fingerprint, f.preparation.fingerprint);
  assert.notEqual(result.report.selectors[0].current_predecessor.sha256, result.report.selectors[0].frozen_proposed.sha256);
  assert.equal(result.report.selectors[0].current_predecessor.sha256, f.hierarchy.scoped_manifest.sha256);
  assert.ok(result.report.authenticated_objects.some(o => o.key.includes("/_aligned/")));
  assert.ok(result.report.authenticated_objects.some(o => o.key.includes("/_exact_v2/")));
  assert.deepEqual(result.report.authenticated_objects.map(o => o.key).sort(), [...f.remote.keys()].sort());
  assert.equal(result.unchanged, true); assert.equal(result.writes, 0);
  assert.equal(result.diagnosticFrozen, true);
  const mutatedCaller = await runAdmissionChild(f, { fault: "mutate_caller" });
  assert.equal(mutatedCaller.report?.original_session.run_id, f.request.runState.run_id);
  assert.deepEqual(mutatedCaller.report?.preparation_fingerprint, f.preparation.fingerprint);
  assert.equal(mutatedCaller.writes, 0);
});

test("Stage 2L current drift, weak selector ETag, missing leaf, recheck ETag drift and local tamper permanently reject without writes", async t => {
  for (const fault of ["changed_current", "weak_selector", "missing_leaf", "changed_recheck", "local_tamper"]) {
    const result = await runAdmissionChild(await admissionFixture(t), { fault });
    assert.equal(result.blocked, true, `${fault}: ${JSON.stringify(result)}`);
    assert.equal(result.permanentlyLost, true, fault);
    assert.equal(result.writes, 0, fault);
    assert.ok(result.gets > 0, fault);
  }
});

test("Stage 2L context-only/non-APPLY inputs cannot read; ownership loss before/after reads and at final admission cannot succeed", async t => {
  const f = await admissionFixture(t);
  for (const options of [{ channel: false }, { phase: "PROPOSE" }, { loseAt: 2 }, { loseAt: 3 },
    { loseAt: 4 * f.remote.size + 2 * f.preparation.outcomes.length + 2 }]) {
    const result = await runAdmissionChild(f, options);
    assert.equal(result.blocked, true, JSON.stringify({ options, result }));
    assert.equal(result.writes, 0);
    if (!options.loseAt || options.loseAt === 2) assert.equal(result.gets, 0);
    if (options.loseAt) assert.equal(result.permanentlyLost, true);
  }
});

test("Stage 2L rejects hidden binary/map and sparse-array control payloads before cloning ignored run-state fields", async () => {
  for (const extra of [new ArrayBuffer(16), new Map([["hidden", new Uint8Array(16)]]), new Array(1000000)]) {
    await assert.rejects(() => admitSchema2CurrentObjectsV1({ phase: "APPLY", request: { runState: { extra } } }), /JSON control/);
  }
});

test("finite affected-scope admission rejects before materialising a preparation directory", async t => {
  const f = fixture(t);
  f.request.scopes = Array.from({ length: SCHEMA2_PREPARATION_LIMITS.max_affected_dcps + 1 }, (_, i) => ({
    day_utc: `2026-10-${String(i + 1).padStart(2, "0")}`, connector_id: 1, pollutant_code: "no2" }));
  await assert.rejects(() => prepareSchema2PreparationV1(f.request), /capacity.*affected DCPs/);
  assert.equal(fs.existsSync(path.join(f.runRoot, "schema2-preparation")), false);
});
