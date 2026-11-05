// Stage 2M integration only: private local preparation and protected read-only
// admission. No writer, publication, recovery or alternate ownership adapter.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { getObservationHistoryGeneration, assertObservationHistoryGenerationKey } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { requireObservationsGlobalOperationLockContext } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { integrityOriginalOperationForApply, assertOriginalIntegrityOperationHeld } from "../../operations/lib/uk_aq_integrity_original_operation.mjs";
import { EXACT_ONLY_DIRECT_VERIFIER_V3 } from "../../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs";
import { prepareSchema2PreparationV1, validateSchema2PreparationV1 } from "./schema2_preparation.mjs";
import { SCHEMA2_PREPARATION_LIMITS as L, assertBoundedPreparationJson, assertPreparationRuntimeCapacity } from "./schema2_preparation_resources.mjs";
import { admitSchema2CurrentObjectsV1 } from "./schema2_current_object_admission.mjs";
import { authenticateExactV3CompactLatest } from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";

export const SCHEMA2_DIAGNOSTIC_V1 = "uk_aq_integrity_schema2_read_only_diagnostic_v1";
const G = getObservationHistoryGeneration("v3");
const id = e => ({ key: e.key, byte_size: e.byte_size, sha256: e.sha256 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireCondition(value, reason) { if (!value) throw new Error(`schema2 diagnostic blocked: ${reason}`); }

// Every ancestor is checked, then a no-follow descriptor and its inode/times
// are checked around the bounded read. No arbitrary filesystem discovery.
export function readDiagnosticBody(root, relative, maxBytes, pin = null) {
  requireCondition(typeof relative === "string" && !path.isAbsolute(relative) && relative.split("/").every(p => p && ![".", ".."].includes(p) && !/[\\\x00-\x1f\x7f]/.test(p)), "unsafe body path");
  const target = path.resolve(root, relative);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    requireCondition(!stat.isSymbolicLink() && (current === target ? stat.isFile() : stat.isDirectory()), "symlink/body path");
  }
  const before = fs.statSync(target);
  requireCondition(before.size > 0 && before.size <= maxBytes && (!pin || before.size === pin.byte_size), "body size/capacity");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    requireCondition(opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size, "changed body descriptor");
    const body = Buffer.alloc(before.size); let at = 0;
    while (at < body.length) { const n = fs.readSync(fd, body, at, body.length - at, at); requireCondition(n > 0, "short body read"); at += n; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(target);
    requireCondition(!named.isSymbolicLink() && named.ino === opened.ino && named.dev === opened.dev &&
      named.size === opened.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs &&
      named.mtimeMs === after.mtimeMs && named.ctimeMs === after.ctimeMs && (!pin || sha256Hex(body) === pin.sha256), "changed body identity");
    return body;
  } finally { fs.closeSync(fd); }
}
export function writeDiagnosticJson(root, relative, value) {
  const body = Buffer.from(JSON.stringify(value)); assertBoundedPreparationJson(body);
  const target = path.join(root, relative);
  fs.writeFileSync(target, body, { flag: "wx", mode: 0o600 });
  return { key: relative, byte_size: body.length, sha256: sha256Hex(body) };
}
export function consumeDiagnosticJson(root, pin) {
  const body = readDiagnosticBody(root, pin.key, L.max_json_body_bytes, pin);
  // Consume before parsing/use. No retry or second invocation can reuse it.
  fs.unlinkSync(path.join(root, pin.key));
  assertBoundedPreparationJson(body); return JSON.parse(body.toString("utf8"));
}
function requireSelection(seed, env) {
  requireCondition(seed.contract_version === SCHEMA2_DIAGNOSTIC_V1 && seed.environment === "TEST" && env.UK_AQ_ENV_NAME === "TEST", "explicit TEST selection required");
  requireCondition(env.UK_AQ_R2_HISTORY_VERSION === "v3" && env.UK_AQ_R2_HISTORY_INDEX_VERSION === "v3", "fixed v3 history/index configuration required");
  const context = requireObservationsGlobalOperationLockContext({ env, expectedOwner: "integrity", expectedRunId: seed.run_id });
  requireCondition(seed.operation_nonce === context.nonce, "original operation nonce");
  requireCondition(seed.dropbox_currentness?.allowed === true && seed.dropbox_currentness?.checkpoint_live_root_match === true &&
    seed.dropbox_currentness.lock_run_id === context.run_id, "accepted locked Step 0 required");
  requireCondition(Array.isArray(seed.scopes) && seed.scopes.length > 0 && seed.scopes.length <= L.max_affected_dcps, "finite explicit scopes required");
  return context;
}

export function recheckDiagnosticOriginals(request, originalRoot) {
  for (const e of request.baselineObjects) readDiagnosticBody(originalRoot, e.key, e.key.endsWith(".parquet") ? L.max_file_bytes : L.max_json_body_bytes, e);
  const checkpoint = request.runState.dropbox_currentness.checkpoint;
  readDiagnosticBody(originalRoot, checkpoint.relative_key, L.max_json_body_bytes, checkpoint);
}

export async function prepareSchema2Diagnostic({ seed, runRoot, env = process.env }) {
  assertPreparationRuntimeCapacity();
  const context = requireSelection(seed, env), originalRoot = path.resolve(seed.original_root);
  requireCondition(!originalRoot.split(path.sep).includes("archive") && !path.resolve(runRoot).startsWith(`${originalRoot}${path.sep}`) && path.resolve(runRoot) !== originalRoot, "scratch must be outside original baseline");
  const checkpoint = seed.dropbox_currentness.checkpoint;
  readDiagnosticBody(originalRoot, checkpoint.relative_key, L.max_json_body_bytes, checkpoint);
  const latestBody = readDiagnosticBody(originalRoot, G.observations_timeseries_latest_key, L.max_json_body_bytes, checkpoint.observations_timeseries_latest);
  assertBoundedPreparationJson(latestBody);
  const latestPayload = JSON.parse(latestBody.toString("utf8"));
  requireCondition(Array.isArray(latestPayload.day_summaries) && latestPayload.day_summaries.length <= L.max_scopes &&
    latestPayload.day_summaries.every(d => Array.isArray(d.scoped_roots) && d.scoped_roots.length <= L.max_scopes) &&
    latestPayload.day_summaries.reduce((n, d) => n + d.scoped_roots.length, 0) <= L.max_scopes, "complete registry cardinality limit");
  const registry = authenticateExactV3CompactLatest({ runState: { dropbox_currentness: seed.dropbox_currentness },
    store: { getObjectFromSourceIfExists: key => ({ key, source: "dropbox", body: latestBody }) } });
  requireCondition(registry.roots.length <= L.max_scopes, "complete selected scope limit");
  for (const scope of seed.scopes) requireCondition(registry.roots.some(r => r.day_utc === scope.day_utc &&
    r.connector_id === scope.connector_id && r.pollutant_code === scope.pollutant_code), "unsupported absent/new diagnostic scope");
  const inputs = new Map(); let bytes = 0;
  function admit(key, size, sha256) {
    requireCondition(!inputs.has(key) && Number.isSafeInteger(size) && size > 0 && /^[a-f0-9]{64}$/.test(sha256), "duplicate/invalid baseline identity");
    bytes += size;
    requireCondition(inputs.size < L.max_objects && bytes <= L.max_total_body_bytes, "complete baseline resource capacity");
    inputs.set(key, { key, byte_size: size, sha256 });
  }
  function walk(key) {
    assertObservationHistoryGenerationKey(G, key);
    requireCondition(!inputs.has(key), "cyclic/duplicate canonical membership");
    const body = readDiagnosticBody(originalRoot, key, L.max_json_body_bytes);
    assertBoundedPreparationJson(body); const payload = JSON.parse(body.toString("utf8"));
    admit(key, body.length, sha256Hex(body));
    if (key === G.observations_root_key) requireCondition(payload.content_hash === checkpoint.observations_processed_source_root_hash, "original root differs from checkpoint");
    const children = key.includes("/_manifests/") ? payload.children : payload.child_manifests;
    requireCondition(Array.isArray(children), "canonical child array missing");
    for (const child of children) walk(child.manifest_key);
    if (payload.manifest_kind === "pollutant") {
      requireCondition(Array.isArray(payload.files), "canonical file table missing");
      for (const file of payload.files) {
        assertObservationHistoryGenerationKey(G, file.key);
        requireCondition(file.key.endsWith(".parquet") && file.bytes <= L.max_file_bytes, "physical file resource bound");
        admit(file.key, file.bytes, file.etag_or_hash);
      }
    }
  }
  walk(G.observations_root_key);
  const latest = checkpoint.observations_timeseries_latest;
  requireCondition(latest?.key === G.observations_timeseries_latest_key, "checkpoint compact latest identity");
  admit(latest.key, latest.byte_size, latest.sha256);
  // All membership and compressed-byte sizes are admitted before copying any
  // physical file. The snapshot is complete, unmasked and byte-identical; it is
  // transient local input, never another backup domain or proposal inventory.
  const baselineRoot = path.join(runRoot, "baseline"), overlayRoot = path.join(runRoot, "overlay");
  fs.mkdirSync(baselineRoot, { mode: 0o700 }); fs.mkdirSync(overlayRoot, { mode: 0o700 });
  const baselineObjects = [];
  for (const entry of inputs.values()) {
    const body = readDiagnosticBody(originalRoot, entry.key, entry.key.endsWith(".parquet") ? L.max_file_bytes : L.max_json_body_bytes, entry);
    const target = path.join(baselineRoot, entry.key);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, body, { flag: "wx", mode: 0o600 });
    baselineObjects.push({ ...entry, relative_path: `baseline/${entry.key}` });
  }
  const request = { runRoot, scopes: seed.scopes, baselineObjects, overlayObjects: [],
    selectedDays: [...new Set(seed.scopes.map(s => s.day_utc))].sort(),
    runState: { run_id: seed.run_id, history_generation: "v3", execution_path: seed.execution_path,
      base_dropbox_root: baselineRoot, overlay_root: overlayRoot, observations_global_operation_lock: context,
      dropbox_currentness: seed.dropbox_currentness, objects: {}, source_evidence_partitions: {} } };
  await prepareSchema2PreparationV1(request);
  await validateSchema2PreparationV1(request);
  recheckDiagnosticOriginals(request, originalRoot);
  return { contract_version: SCHEMA2_DIAGNOSTIC_V1, seed, request };
}

export async function runSchema2Diagnostic({ handoff, r2, env = process.env }) {
  requireCondition(handoff.contract_version === SCHEMA2_DIAGNOSTIC_V1, "unknown handoff");
  const context = requireSelection(handoff.seed, env), request = handoff.request;
  requireCondition(request.runState.run_id === context.run_id && request.runState.execution_path === handoff.seed.execution_path &&
    same(request.scopes, handoff.seed.scopes) && same(request.runState.dropbox_currentness, handoff.seed.dropbox_currentness), "independent handoff authority mismatch");
  const operation = integrityOriginalOperationForApply({ env, expectedRunId: context.run_id });
  requireCondition(operation, "genuine original-session diagnostic channel required");
  try {
    await validateSchema2PreparationV1(request);
    recheckDiagnosticOriginals(request, handoff.seed.original_root);
    const evidence = await admitSchema2CurrentObjectsV1({ request, phase: "APPLY", r2, env });
    recheckDiagnosticOriginals(request, handoff.seed.original_root);
    const finalAssertion = await assertOriginalIntegrityOperationHeld({ env, expectedRunId: context.run_id });
    requireCondition(finalAssertion.session_pid === evidence.original_session.session_pid, "final original session changed");
    // Only compact diagnostics leave the protected child. Never serialize the
    // capability, private channel metadata, bodies or complete physical proof.
    const result = { contract_version: SCHEMA2_DIAGNOSTIC_V1, status: "diagnostic_authenticated", ...diagnosticFlags(),
      run_id: context.run_id, execution_path: request.runState.execution_path,
      scope_count: evidence.selectors.length, affected_scope_count: request.scopes.length,
      current_objects: evidence.observed.objects, get_count: evidence.observed.gets, get_bytes: evidence.observed.get_bytes,
      proof_version: EXACT_ONLY_DIRECT_VERIFIER_V3, preparation_fingerprint: evidence.preparation_fingerprint,
      original_session: { ...evidence.original_session, last_sequence: finalAssertion.sequence }, original_session_continuity_lost: false,
      original_session_continuity: "asserted_through_completed_admission" };
    await operation.complete();
    return result;
  } catch (error) { operation.close(); throw error; }
}
export function diagnosticFlags() {
  return { read_only: true, evidence_scope: "completed_call_only", reusable_currentness: false,
    repair_apply_eligible: false, publication_eligible: false, repair_completed: false, writer_finalisation_completed: false,
    current_object_authority: null, conditional_publication_authority: null, source_deletion_eligible: false, r2_mutation_attempted: false };
}
