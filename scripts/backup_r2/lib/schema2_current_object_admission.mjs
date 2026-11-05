// Stage 2L: explicitly invoked APPLY-only current predecessor authentication.
// No command, writer, acquisition API, publication schedule or reusable proof.
import { r2GetObjectBounded, isStrongR2Etag, sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { requireObservationsGlobalOperationLockContext } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { prepareOfflineObservationHistoryScopeV3 } from "../../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs";
import { encodeObservationHistoryIndexV3Json as canonical,
  buildObservationHistoryExactLeafIndexV3Latest, latestArtifactFromRoots } from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { assertOriginalIntegrityOperationHeld, integrityOriginalOperationForApply } from "../../operations/lib/uk_aq_integrity_original_operation.mjs";
import { authenticateExactV3CompactLatest } from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";
import { validateSchema2PreparationV1 } from "./schema2_preparation.mjs";
import { SCHEMA2_PREPARATION_LIMITS as LIMITS, assertPreparationResourceTotals,
  assertPreparationRuntimeCapacity, assertBoundedPreparationJson, preflightPhysicalBody } from "./schema2_preparation_resources.mjs";

const G = getObservationHistoryGeneration("v3");
const identity = a => ({ key: a.key, byte_size: a.byte_size, sha256: a.sha256 });
const equal = (a, b, label) => { if (canonical(a) !== canonical(b)) throw new Error(`schema2 current admission mismatch: ${label}`); };
// Four assertions per object (two GET passes) plus phase assertions stay below
// Stage 2J's 1,024 lifetime requests. Earlier channel use can still exhaust it;
// that fails permanently, never reconnects or silently skips assertions.
export const SCHEMA2_CURRENT_OBJECT_LIMITS = Object.freeze({
  max_objects: 220, max_gets: 440, max_get_bytes: 2 * LIMITS.max_total_body_bytes,
});

function snapshotRequest(request) {
  assertPreparationRuntimeCapacity();
  // Bound the caller's in-memory control graph before structuredClone creates
  // another copy. In particular, do not clone unvalidated arbitrary extra fields.
  const selected = Object.fromEntries(["runState", "runRoot", "scopes", "selectedDays", "baselineObjects", "overlayObjects", "preparation"]
    .filter(key => request?.[key] !== undefined).map(key => [key, request[key]]));
  const pending = [[selected, 0]];
  let nodes = 0, bytes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > LIMITS.max_thrift_nodes || depth > LIMITS.max_json_depth) throw new Error("schema2 current admission request complexity");
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (value && typeof value === "object") {
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (array ? value.length > LIMITS.max_thrift_nodes : prototype !== Object.prototype && prototype !== null) {
        throw new Error("schema2 current admission requires bounded plain JSON control values");
      }
      const keys = Object.keys(value);
      if (array && keys.length !== value.length) throw new Error("schema2 current admission requires dense JSON control arrays");
      if (keys.length + pending.length + nodes > LIMITS.max_thrift_nodes) throw new Error("schema2 current admission request members");
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, "value")) throw new Error("schema2 current admission rejects JSON control accessors");
        bytes += Buffer.byteLength(key); pending.push([descriptor.value, depth + 1]);
      }
    } else if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
      throw new Error("schema2 current admission requires finite JSON control primitives");
    }
    if (bytes > LIMITS.max_total_body_bytes) throw new Error("schema2 current admission request bytes");
  }
  return structuredClone(selected);
}

function frozenDiagnostic(value) {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) frozenDiagnostic(member);
    Object.freeze(value);
  }
  return value;
}

/**
 * request: the independent Stage 2K validator inputs, never a supplied valid flag.
 * phase must explicitly be APPLY; production ownership always uses Stage 2J.
 * r2 may provide the existing bounded read adapter, never an assertion adapter.
 * The returned diagnostic describes this completed call only. It is not a
 * capability, preparation upgrade or authority for any later read/write.
 */
export async function admitSchema2CurrentObjectsV1({ request, phase, r2, env = process.env }) {
  if (phase !== "APPLY") throw new Error("schema2 current admission requires explicit APPLY boundary");
  // Snapshot all caller-owned authority before the first await. The independent
  // validator still reopens actual local bytes, both now and at final admission.
  const accepted = snapshotRequest(request), channelEnv = { ...env };
  const preparation = accepted.preparation || accepted.runState?.schema2_preparation;
  await validateSchema2PreparationV1(accepted);
  const runId = preparation.run_id;
  const context = requireObservationsGlobalOperationLockContext({ env: channelEnv, expectedOwner: "integrity", expectedRunId: runId });
  const frozenContext = preparation.accepted_authority.observations_global_operation_lock;
  if (frozenContext.owner !== context.owner || frozenContext.run_id !== context.run_id || frozenContext.nonce !== context.nonce) {
    throw new Error("schema2 current admission requires the frozen original operation nonce/run/owner");
  }
  const operation = integrityOriginalOperationForApply({ env: channelEnv, expectedRunId: runId });
  if (!operation) throw new Error("schema2 current admission requires original-session channel");
  const expected = new Map(), pins = new Map(), bodies = new Map();
  let firstAssertion = null, lastAssertion = null, gets = 0, getBytes = 0;
  async function held() {
    // Do not replace this with context validation or an injectable callback.
    const result = await assertOriginalIntegrityOperationHeld({ env: channelEnv, expectedRunId: runId });
    if (result.owner !== "integrity" || result.run_id !== runId || result.read_only !== true || result.repair_authorized !== false ||
        !Number.isSafeInteger(result.session_pid) || result.session_pid <= 0 ||
        !Number.isSafeInteger(result.sequence) || result.sequence <= (lastAssertion?.sequence || 0) ||
        (firstAssertion && result.session_pid !== firstAssertion.session_pid)) {
      throw new Error("schema2 current admission lost original session/sequence binding");
    }
    firstAssertion ||= result; lastAssertion = result;
  }
  function admitResources(extraBytes = 0, extraObjects = 0, extraEdges = 0) {
    const upper = preparation.admission_upper_bounds;
    const bytes = [...expected.values()].reduce((n, e) => n + e.byte_size, 0) + extraBytes;
    if (expected.size + extraObjects > SCHEMA2_CURRENT_OBJECT_LIMITS.max_objects || bytes > LIMITS.max_total_body_bytes) {
      throw new Error("schema2 current admission exceeds finite current object/body budget");
    }
    // Reserve the validated preparation workload AND the fresh current graph.
    // This is deliberately stricter than preparation alone, never a v1 upgrade.
    assertPreparationResourceTotals({ ...upper, objects: upper.objects + expected.size + extraObjects,
      edges: upper.edges + extraEdges, total_body_bytes: upper.total_body_bytes + bytes });
  }
  function add(object, type) {
    const value = { ...identity(object), type };
    if (expected.has(value.key)) { equal(expected.get(value.key), value, `duplicate current key ${value.key}`); return; }
    if (!Number.isSafeInteger(value.byte_size) || value.byte_size <= 0 ||
        value.byte_size > (type === "canonical_parquet" ? LIMITS.max_file_bytes : LIMITS.max_json_body_bytes) ||
        !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("schema2 current admission invalid object identity");
    expected.set(value.key, value); admitResources();
  }
  async function read(entry) {
    if (++gets > SCHEMA2_CURRENT_OBJECT_LIMITS.max_gets ||
        getBytes + entry.byte_size > SCHEMA2_CURRENT_OBJECT_LIMITS.max_get_bytes) throw new Error("schema2 current admission GET budget exhausted");
    await held();
    const object = await r2GetObjectBounded({ r2, key: entry.key, max_bytes: entry.byte_size, accept_encoding_identity: true });
    await held();
    if (object.exists === false || object.bytes !== entry.byte_size || !isStrongR2Etag(object.etag)) {
      throw new Error(`schema2 current admission missing size/strong ETag: ${entry.key}`);
    }
    const actual = { key: entry.key, byte_size: object.bytes, sha256: sha256Hex(object.body), etag: object.etag, type: entry.type };
    equal(identity(actual), identity(entry), `frozen prior/current bytes ${entry.key}`);
    if (object.sha256 != null) equal(object.sha256, actual.sha256, `stored checksum ${entry.key}`);
    if (pins.has(entry.key)) equal(actual, pins.get(entry.key), `changed current identity/ETag ${entry.key}`);
    getBytes += object.bytes; pins.set(entry.key, actual);
    if (entry.type !== "canonical_parquet") assertBoundedPreparationJson(object.body);
    return object.body;
  }
  try {
    await held();
    if (preparation.outcomes.some(o => o.prior.no_selector || o.proposed.no_selector)) {
      throw new Error("schema2 current admission does not support absent/no-selector outcomes");
    }
    const baseline = preparation.input_inventory.filter(e => e.source === "dropbox");
    for (const e of baseline) add(e, e.key.endsWith(".parquet") ? "canonical_parquet" : "canonical_or_latest");
    // Every read is planned from independently validated frozen evidence. Live
    // bytes can only contradict it; they never supply new preservation inputs.
    for (const e of expected.values()) bodies.set(e.key, await read(e));
    const registry = authenticateExactV3CompactLatest({ runState: preparation.accepted_authority,
      store: { getObjectFromSourceIfExists: key => ({ key, body: bodies.get(key), source: "dropbox" }) } });
    equal(registry.roots.map(canonical).sort(), preparation.outcomes.map(o => canonical(o.prior.checkpoint_descriptor)).sort(), "complete prior selected registry");

    // Before reconstruction/decoding, reserve a conservative serialization and
    // fan-out bound using the entire authenticated current canonical file table.
    let rows = 0, files = 0, derived = 0, uncompressed = 0;
    for (const outcome of preparation.outcomes) {
      const manifest = JSON.parse(bodies.get(outcome.baseline_canonical_source.key).toString("utf8"));
      const series = Object.keys(manifest.timeseries_row_counts).length;
      derived += outcome.prior.schema_version === 1 ? 2 * series + 2 : series + 1;
      rows += manifest.row_count; files += manifest.files.length;
    }
    if (!Number.isSafeInteger(rows) || rows > LIMITS.max_decoded_rows) throw new Error("schema2 current admission decoded row budget");
    admitResources(rows * 16384 + derived * 4096, derived, derived * (files + 2));
    for (const outcome of preparation.outcomes) {
      const manifest = JSON.parse(bodies.get(outcome.baseline_canonical_source.key).toString("utf8"));
      for (const file of manifest.files) {
        uncompressed += preflightPhysicalBody(bodies.get(file.key), { row_count: file.row_count }).uncompressed_bytes;
        if (uncompressed > LIMITS.max_uncompressed_bytes) throw new Error("schema2 current admission uncompressed page budget");
      }
    }
    const selectors = [];
    for (const outcome of preparation.outcomes) {
      // Existing verifier independently checks root-to-DCP aliases, complete
      // physical routing/ranges and decoded values/status/hash from fresh bytes.
      // Its local getter is restricted to already authenticated current inputs.
      await held();
      const rebuilt = await prepareOfflineObservationHistoryScopeV3({ scope: outcome.scope,
        exactSchemaVersion: outcome.prior.schema_version,
        getObject: async ({ key }) => {
          if (!bodies.has(key)) throw new Error(`schema2 current admission missing frozen current dependency: ${key}`);
          return { key, body: bodies.get(key) };
        } });
      await held();
      equal(rebuilt.canonical_source_manifest, outcome.baseline_canonical_source, "current baseline canonical source");
      equal(identity(rebuilt.hierarchy.scoped_manifest), identity(outcome.prior), "current predecessor, never proposed replacement");
      const currentDescriptor = authenticateRebuiltDescriptor(rebuilt.hierarchy);
      equal(currentDescriptor, outcome.prior.checkpoint_descriptor, "current selected format and whole scope");
      // Leaf bodies and full metadata do not survive this scope iteration in
      // the current cache; the compact registry has just been reconciled.
      const artifacts = rebuilt.hierarchy.publication_objects;
      for (const artifact of artifacts) add(artifact, artifact.kind);
      for (const artifact of artifacts) {
        for (const dep of [...artifact.dependencies, ...artifact.publication_prerequisites]) {
          const target = expected.get(dep.key);
          if (!target) throw new Error(`schema2 current admission incomplete dependency: ${dep.key}`);
          equal(identity(target), identity(dep), `current dependency ${dep.key}`);
        }
      }
      for (const artifact of artifacts) await read(expected.get(artifact.key));
      selectors.push({ scope: outcome.scope, current_predecessor: { ...pins.get(outcome.prior.key),
        schema_version: outcome.prior.schema_version, kind: outcome.prior.kind, exact_leaf_index_version: outcome.prior.exact_leaf_index_version },
        frozen_proposed: outcome.proposed });
    }
    equal(identity(latestArtifactFromRoots(registry.roots, G.observations_timeseries_index_prefix, G.observations_timeseries_latest_key)),
      identity(expected.get(G.observations_timeseries_latest_key)), "completed compact latest");
    // Bounded full GET rechecks avoid assuming that HEAD exposes a checksum.
    // Contradictory/missing/weak validators fail; there is no HEAD fallback.
    for (const entry of expected.values()) await read(entry);
    await validateSchema2PreparationV1(accepted);
    await held();
    return frozenDiagnostic({ state: "authenticated_read_only_diagnostic", evidence_scope: "completed_call_only",
      reusable_currentness: false, read_only: true, repair_apply_eligible: false, publication_eligible: false,
      current_object_authority: null, conditional_publication_authority: null, source_deletion_eligible: false,
      preparation_fingerprint: Object.freeze({ ...preparation.fingerprint }),
      original_session: Object.freeze({ owner: "integrity", run_id: runId, session_pid: firstAssertion.session_pid,
        first_sequence: firstAssertion.sequence, last_sequence: lastAssertion.sequence }),
      selectors: Object.freeze(selectors), authenticated_objects: Object.freeze([...pins.values()]),
      limits: SCHEMA2_CURRENT_OBJECT_LIMITS, observed: Object.freeze({ objects: pins.size, gets, get_bytes: getBytes }),
    });
  } catch (error) {
    // No retryable admission handle survives even a content/remote uncertainty.
    // Production close invalidates the original channel and cancels the child.
    operation.close();
    throw error;
  } finally { bodies.clear(); }
}

function authenticateRebuiltDescriptor(hierarchy) {
  // Use the existing registry validator rather than a new selected-format rule.
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [hierarchy] });
  return authenticateExactV3CompactLatest({ runState: { dropbox_currentness: { allowed: true,
    checkpoint: { observations_timeseries_latest: identity(latest) } } },
    store: { getObjectFromSourceIfExists: key => ({ key, body: latest.body, source: "dropbox" }) } }).roots[0];
}
