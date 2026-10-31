// Preparatory schema-2 publication integration. The shared finaliser has a hard
// inactive gate; no production writer imports or enables this path.
import { Buffer } from "node:buffer";
import { sha256Hex } from "./r2_sigv4.mjs";
import { getObservationHistoryGeneration } from "./uk_aq_observation_history_generation.mjs";
import { exactLeafFormatV3 } from "./uk_aq_observation_history_exact_leaf_format_v3.mjs";
import {
  encodeObservationHistoryIndexV3Json as json,
  buildObservationHistoryIndexV3PublicationPlan,
  finalizeObservationHistoryIndexV3Publication,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
  scopedRootDescriptor,
} from "./uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  recheckObservationHistoryExactOnlyProofV3,
  verifyObservationHistoryExactOnlyScopeV3,
} from "./uk_aq_observation_history_exact_only_verifier_v3.mjs";

const generation = getObservationHistoryGeneration("v3");
function id(o) { return { key: o.key, byte_size: o.byte_size, sha256: o.sha256 }; }
function same(a, b, label) {
  if (json(a) !== json(b)) throw new Error(`schema-2 publication ${label} changed`);
}
function snapshot(object, key) {
  if (object?.key !== key) throw new Error("schema-2 GET must return the requested key and explicit existence");
  if (object.exists === false) return Object.freeze({ key, exists: false });
  if (typeof object.etag !== "string" || !object.etag ||
      !(typeof object.body === "string" || object.body instanceof Uint8Array)) throw new Error("schema-2 current body/ETag unavailable");
  const body = Buffer.from(object.body);
  return Object.freeze({ key, exists: true, byte_size: body.length, sha256: sha256Hex(body), etag: object.etag });
}
function storedArtifact(object, kind, stage) {
  const current = snapshot(object, object.key);
  if (!current.exists) throw new Error("schema-2 compact latest is missing; explicit reconstruction required");
  const body = Buffer.from(object.body).toString("utf8");
  const payload = JSON.parse(body);
  if (body !== json(payload)) throw new Error("schema-2 compact latest noncanonical body");
  return { ...id(current), body, payload, kind, publication_stage: stage, dependencies: [], publication_prerequisites: [] };
}

// Pure GET preparation: original selectors, exact immutable revision conflict
// checks, compact latest and dependency graph. Does not create a conversion
// mode, progress ledger or receipt. Lock assertion must remain bound to the same
// observations-operation session for the lifetime of the returned closure.
export async function prepareObservationHistoryExactOnlyPublicationV3({
  preparedScopes, getObject, assertOperationHeld,
  finalizeCanonicalHierarchy, finalizeRun,
}) {
  if (!Array.isArray(preparedScopes) || !preparedScopes.length ||
      [getObject, assertOperationHeld, finalizeCanonicalHierarchy, finalizeRun].some((fn) => typeof fn !== "function")) {
    throw new Error("schema-2 preparation requires verified scopes, held operation and existing finalisation adapters");
  }
  let lost = false;
  const held = async () => {
    if (lost) throw new Error("schema-2 operation exclusion previously lost");
    try { if (await assertOperationHeld() === false) throw new Error("schema-2 operation exclusion absent"); }
    catch (error) { lost = true; throw error; }
  };
  const get = async (key) => { await held(); const object = await getObject({ key }); await held(); return object; };
  const selectors = new Map(), hierarchies = [], proofs = [], external = new Map();
  const externalIdentity = (identity) => {
    const old = external.get(identity.key);
    if (old) same(id(old), id(identity), "external dependency");
    external.set(identity.key, { ...id(identity), verified: true, durable: true });
  };
  for (const prepared of preparedScopes) {
    const hierarchy = await recheckObservationHistoryExactOnlyProofV3(prepared.proof);
    if (hierarchy !== prepared.hierarchy) throw new Error("schema-2 prepared hierarchy substitution");
    const parent = hierarchy.scoped_manifest;
    if (selectors.has(parent.key)) throw new Error("duplicate schema-2 selector scope");
    const originalObject = await get(parent.key), original = snapshot(originalObject, parent.key);
    if (original.exists) {
      const format = exactLeafFormatV3(JSON.parse(Buffer.from(originalObject.body).toString("utf8")));
      if (format.schema_version === 2) throw new Error("schema-2 selector already selected: explicit authenticated recovery required");
    }
    selectors.set(parent.key, { original, expected: id(parent), selected: false, parent });
    for (const leaf of hierarchy.exact_leaves) {
      const object = await get(leaf.key), pin = snapshot(object, leaf.key);
      if (pin.exists) same(id(pin), id(leaf), "immutable revision conflict");
    }
    externalIdentity(prepared.proof.canonical_source_manifest);
    for (const leaf of hierarchy.exact_leaves) for (const file of leaf.payload.files) externalIdentity(file);
    hierarchies.push(hierarchy); proofs.push(prepared.proof);
  }
  const latestKey = generation.observations_timeseries_latest_key;
  const latestObject = await get(latestKey), originalLatest = snapshot(latestObject, latestKey);
  const existingLatest = storedArtifact(latestObject, "observation_history_index_v3_latest_global", "latest_global");
  const latest = updateObservationHistoryExactLeafIndexV3Latest({ existingLatest,
    replacementScopedManifests: hierarchies.map((h) => h.scoped_manifest) });
  const registry = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest });
  const checkLatestRoots = async () => {
    for (const root of registry.roots) {
      const currentObject = await get(root.key), current = snapshot(currentObject, root.key);
      if (!current.exists) throw new Error("schema-2 latest dependency absent");
      same(id(current), id(root), "compact latest selector identity");
      const payload = JSON.parse(Buffer.from(currentObject.body).toString("utf8"));
      same(scopedRootDescriptor({ ...id(current), payload }), root, "compact latest format/coverage");
    }
  };
  for (const root of registry.roots) if (!selectors.has(root.key)) {
    const current = snapshot(await get(root.key), root.key);
    if (!current.exists) throw new Error("unchanged latest dependency absent");
    same(id(current), id(root), "unchanged latest dependency"); externalIdentity(current);
  }
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects: [...hierarchies.flatMap((h) => h.publication_objects), latest],
    externalReferences: [...external.values()],
  });
  let rootAccepted = false, latestReadback = false;
  let reports = [];
  const lifecycle = Object.freeze({
    async beforePublish(entry, policy) {
      await held();
      for (const proof of proofs) await recheckObservationHistoryExactOnlyProofV3(proof);
      if (policy?.role === "selector") {
        const guard = selectors.get(entry.key);
        if (!guard) throw new Error("unregistered schema-2 selector");
        const current = snapshot(await get(entry.key), entry.key);
        same(current, guard.original, "original selector identity guard");
        same(id(entry), guard.expected, "prepared selector identity");
      }
      if (entry.publication_stage === "latest_global") {
        same(snapshot(await get(latestKey), latestKey), originalLatest, "original compact latest identity guard");
      }
      // Held exclusion + identity recheck, not a GET/PUT compare-and-swap claim.
      await held();
    },
    async afterReadback(entry) {
      await held();
      const guard = selectors.get(entry.key);
      if (guard) guard.selected = true;
      if (entry.publication_stage === "latest_global") {
        if (!rootAccepted) throw new Error("latest precedes complete canonical acceptance");
        latestReadback = true;
      }
    },
    async acceptCurrentRoot() {
      if ([...selectors.values()].some((s) => !s.selected)) throw new Error("not all selectors selected/read back");
      await held();
      const result = await finalizeCanonicalHierarchy();
      if (result?.ok !== true) throw new Error("canonical aggregate finalisation incomplete");
      // Authenticate the completed current root and all stored exact objects;
      // bottom-up child preparation did not require this root to exist earlier.
      reports = [];
      for (const hierarchy of hierarchies) {
        const p = hierarchy.scoped_manifest.payload;
        const report = await verifyObservationHistoryExactOnlyScopeV3({
          scope: { day_utc: p.day_utc, connector_id: p.connector_id, pollutant_code: p.pollutant_code },
          getObject, assertOperationHeld: held,
        });
        same(report.selector, id(hierarchy.scoped_manifest), "accepted current selector");
        same(report.leaves, hierarchy.exact_leaves.map(id), "accepted immutable leaves");
        reports.push(report);
      }
      await checkLatestRoots(); await held(); rootAccepted = true;
    },
    async finalizeRun() {
      if (!rootAccepted || !latestReadback) throw new Error("selector-selected/latest-unfinalised is not success");
      await checkLatestRoots();
      same(id(snapshot(await get(latestKey), latestKey)), id(latest), "current completed latest");
      for (const report of reports) await recheckObservationHistoryExactOnlyProofV3(report);
      await held();
      // Existing run-completion semantics stay with the owning writer. Require
      // its exact prepared body for independent readback, never existence alone.
      const result = await finalizeRun({ directVerification: reports, latest: id(latest) });
      if (result?.ok !== true || !result.artifact || !result.artifact.key.startsWith(`${generation.observations_runs_prefix}/`)) {
        throw new Error("existing run finalisation incomplete");
      }
      const expected = result.artifact, object = await get(expected.key);
      const current = snapshot(object, expected.key);
      same(id(current), id(expected), "completed run readback");
      if (!Buffer.from(expected.body).equals(Buffer.from(object.body))) throw new Error("completed run exact bytes differ");
      same(id(snapshot(await get(latestKey), latestKey)), id(latest), "final completed latest");
      for (const report of reports) await recheckObservationHistoryExactOnlyProofV3(report);
      await held();
    },
  });
  return Object.freeze({ plan, latest, lifecycle, original_selectors: Object.freeze(
    [...selectors.values()].map((s) => s.original)),
    // Shared finaliser always rejects schema 2 in this phase, before any PUT or
    // durable-evidence adapter. There is no opt-in argument or env switch.
    finalize: (adapters) => finalizeObservationHistoryIndexV3Publication({ ...adapters,
      plan, exactOnlyLifecycle: lifecycle, publicationConcurrency: 1 }),
  });
}
