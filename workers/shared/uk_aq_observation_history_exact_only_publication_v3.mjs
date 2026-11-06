// Preparatory schema-2 publication integration. The shared finaliser has a hard
// inactive gate; the owning Prune writer can prepare but cannot enable it.
import { Buffer } from "node:buffer";
import { sha256Hex, isStrongR2Etag, r2PutObjectConditional } from "./r2_sigv4.mjs";
import { getObservationHistoryGeneration } from "./uk_aq_observation_history_generation.mjs";
import { exactLeafFormatV3 } from "./uk_aq_observation_history_exact_leaf_format_v3.mjs";
import { assertObservationHistoryExactOnlyPublicationActiveV3 } from "./uk_aq_observation_history_index_v3.mjs";
import { validatePhaseBV3RunFinalizationResult, pruneBatchFinalizationIdentityV3 }
  from './uk_aq_prune_batch_finalization_v3.mjs';
import { originalOperationError } from '../../scripts/operations/lib/uk_aq_prune_original_operation.mjs';
import {
  encodeObservationHistoryIndexV3Json as json,
  buildObservationHistoryIndexV3PublicationPlan,
  finalizeObservationHistoryIndexV3Publication,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
  scopedRootDescriptor,
} from "./uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  assertObservationHistoryExactOnlyProofOperationV3,
  assertObservationHistoryExactOnlyPruneProofV3,
  recheckObservationHistoryExactOnlyProofV3,
  acceptObservationHistoryExactOnlyScopeV3,
  prepareObservationHistoryExactOnlyScopeV3,
} from "./uk_aq_observation_history_exact_only_verifier_v3.mjs";

const generation = getObservationHistoryGeneration("v3");
const completions = new WeakMap();

// A completion is only a transient original-writer snapshot for the optional
// existing outbox. Copies/JSON cannot assert completion, and this is never a
// source-deletion permission or an independently authenticated DB commit.
// Fresh liveness checks use the original publisher and inspector contexts. Run
// synchronous evidence preparation here, without handing a detached description
// back across an await before it is consumed. The owner must retain its session
// lock until preparation and the original protected gate transaction finish.
export async function describeObservationHistoryExactOnlyCompletionV3(completion,
  prepare = description => description) {
  const state = completions.get(completion);
  if (!state) throw new Error("missing completed operation-local exact-only publication");
  state.assertUsable();
  await state.assertHeld();
  for (const proof of state.proofs) await assertObservationHistoryExactOnlyProofOperationV3(proof);
  state.assertUsable();
  return prepare(structuredClone(state.description));
}
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

// Owning-writer seam, before selecting any schema-2 index. Ordinary schema-1
// publication performs no additional reads. This is intentionally dormant:
// the normal builder still emits schema 1 and the shared finalizer rejects 2.
// Initial actual-byte inspection is here; the later pre-gate adapter reuses its
// opaque same-session proof rather than inspecting Parquet again for handover.
export async function preparePruneExactOnlyConnectorScopesV3({ partitions, canonical,
  originalOperation, getObject, headObject = null }) {
  const selected = partitions.filter(p => exactLeafFormatV3(p.v3_hierarchy.scoped_manifest.payload).schema_version === 2);
  if (!selected.length) return [];
  if (selected.length !== partitions.length) throw new Error('Incomplete Prune exact-only connector source selection');
  if (!originalOperation || typeof originalOperation.assertHeld !== 'function') {
    throw originalOperationError('original coordinator capability required for exact-only producer');
  }
  await originalOperation.assertHeld('publication');
  const prepared = [];
  for (const partition of selected) {
    const scope = await prepareObservationHistoryExactOnlyScopeV3({ scope: partition.scope,
      originalOperation, getObject, headObject });
    const canonicalRef = canonical.pollutant_manifests.find(r => r.key === scope.proof.canonical_source_manifest.key);
    same(id(canonicalRef || {}), id(scope.proof.canonical_source_manifest), 'owning writer canonical child');
    same(id(scope.hierarchy.scoped_manifest), id(partition.v3_hierarchy.scoped_manifest), 'owning writer prepared selector');
    same(scope.hierarchy.exact_leaves.map(id), partition.v3_hierarchy.exact_leaves.map(id), 'owning writer prepared leaves');
    prepared.push(scope);
  }
  await originalOperation.assertHeld('publication');
  return Object.freeze(prepared);
}

// Prune-only pre-gate adapter. The real owner first runs/validates its mandatory
// batch finalizer; authenticate that result's current identities and reuse only
// physical proofs from the SAME live coordinator capability. The late reporting
// run manifest is deliberately absent. No new durable artifact is produced.
export async function preparePruneExactOnlyBatchCompletionV3({
  preparedScopes, finalization, runId, originalOperation, expectedDays,
  expectedConnectorPublicationCount, getObject,
}) {
  if (!originalOperation || originalOperation.run_id !== runId || typeof originalOperation.assertHeld !== 'function') {
    throw originalOperationError('matching original coordinator capability required');
  }
  if (!Array.isArray(preparedScopes) || !preparedScopes.length || typeof getObject !== 'function') {
    throw new Error('Original prepared exact-only scopes and authenticated GET required');
  }
  if (!Number.isSafeInteger(expectedConnectorPublicationCount) || expectedConnectorPublicationCount <= 0
    || !Array.isArray(expectedDays) || !expectedDays.length
    || finalization?.connector_results?.length !== expectedConnectorPublicationCount) {
    throw new Error('Original complete Prune batch membership required');
  }
  const held = () => originalOperation.assertHeld('preparation');
  await held();
  validatePhaseBV3RunFinalizationResult({ result: finalization, expectedDays, expectedConnectorPublicationCount });
  const batch = pruneBatchFinalizationIdentityV3(finalization);
  const reports = [], seen = new Set();
  for (const prepared of preparedScopes) {
    await assertObservationHistoryExactOnlyPruneProofV3(prepared.proof, originalOperation);
    const verified = await recheckObservationHistoryExactOnlyProofV3(prepared.proof);
    if (verified !== prepared.hierarchy) throw new Error('Prune prepared hierarchy substitution');
    const report = await acceptObservationHistoryExactOnlyScopeV3(prepared.proof);
    same(report.selector, id(verified.scoped_manifest), 'original batch selector');
    same(report.leaves, verified.exact_leaves.map(id), 'original batch leaves');
    if (seen.has(report.selector.key) || !expectedDays.includes(report.scope.day_utc)) throw new Error('Invalid original batch scope set');
    seen.add(report.selector.key); reports.push(report);
  }
  const get = async key => { await held(); const object = await getObject({ key }); await held(); return object; };
  // These are required existing canonical/day/latest identities, not Parquet.
  for (const ref of [...batch.day_manifests, ...batch.canonical_aggregate_references, ...batch.latest_global_references]) {
    same(id(snapshot(await get(ref.key), ref.key)), ref, 'checked original batch identity');
  }
  const latestKey = generation.observations_timeseries_latest_key;
  const latestObject = await get(latestKey);
  const latest = storedArtifact(latestObject, 'observation_history_index_v3_latest_global', 'latest_global');
  if (!batch.latest_global_references.some(r => json(r) === json(id(latest)))) throw new Error('Original batch latest identity missing');
  const registry = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest });
  for (const report of reports) {
    const selected = registry.roots.find(r => r.key === report.selector.key);
    const prepared = preparedScopes.find(s => s.hierarchy.scoped_manifest.key === report.selector.key);
    same(selected, scopedRootDescriptor(prepared.hierarchy.scoped_manifest), 'completed latest scope/format');
    if (!batch.exact_scope_references.some(r => json(r) === json(report.selector))
      || report.canonical_chain.slice(0, 3).some(r => !batch.canonical_aggregate_references.some(b => json(b) === json(r)))
      || !batch.day_manifests.some(r => json(r) === json(report.canonical_chain[3]))) {
      throw new Error('Checked batch differs from the authenticated original canonical/index chain');
    }
    await recheckObservationHistoryExactOnlyProofV3(report);
  }
  await held();
  const completion = Object.freeze({});
  completions.set(completion, { proofs: reports, assertHeld: held,
    assertUsable() { same(pruneBatchFinalizationIdentityV3(finalization), batch, 'original checked batch'); },
    description: {
      schema_version: 2, kind: 'uk_aq_prune_exact_only_completion', invocation_id: runId,
      finalisation_complete: true, authority_state: 'prepared_before_original_gate_transaction',
      batch_finalization: batch, latest: id(latest),
      scopes: reports.map(report => ({ scope: report.scope, verifier_version: report.verifier_version,
        inspector: report.inspector, physical_identity: report.physical_identity,
        canonical_chain: report.canonical_chain, canonical_source_manifest: report.canonical_source_manifest,
        selector: report.selector, leaves: report.leaves, files: report.files, row_count: report.row_count })),
    } });
  return completion;
}

// Pure GET preparation: original selectors, exact immutable revision conflict
// checks, compact latest and dependency graph. Does not create a conversion
// mode, progress ledger or receipt. Lock assertion must remain bound to the same
// observations-operation session for the lifetime of the returned closure.
export async function prepareObservationHistoryExactOnlyPublicationV3({
  preparedScopes, getObject, headObject = null, assertOperationHeld,
  finalizeCanonicalHierarchy, finalizeRun, runId = null,
}) {
  if (!Array.isArray(preparedScopes) || !preparedScopes.length ||
      [getObject, assertOperationHeld, finalizeCanonicalHierarchy, finalizeRun].some((fn) => typeof fn !== "function")) {
    throw new Error("schema-2 preparation requires verified scopes, held operation and existing finalisation adapters");
  }
  if (headObject !== null && typeof headObject !== "function") throw new Error("invalid schema-2 publication HEAD adapter");
  let lost = false, failed = false;
  const held = async () => {
    if (lost || failed) throw new Error("schema-2 operation exclusion lost or publication invalidated");
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
    selectors.set(parent.key, { original, expected: id(parent), selected: false, parent, proof: prepared.proof });
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
  let rootAccepted = false, latestReadback = false, completedRun = null;
  let reports = [];
  const guarded = fn => async (...args) => {
    try { return await fn(...args); }
    catch (error) { failed = true; completedRun = null; throw error; }
  };
  const lifecycle = Object.freeze(Object.fromEntries(Object.entries({
    async beforePublish(entry, policy) {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      await held();
      // Immutable leaves do not mutate canonical files. Keep the original
      // operation proof live per entry; check current source/file identities
      // once at selector admission, rather than refetching all files per leaf.
      for (const proof of proofs) await assertObservationHistoryExactOnlyProofOperationV3(proof);
      if (policy?.role === "selector") {
        const guard = selectors.get(entry.key);
        if (!guard) throw new Error("unregistered schema-2 selector");
        await recheckObservationHistoryExactOnlyProofV3(guard.proof);
        const current = snapshot(await get(entry.key), entry.key);
        same(current, guard.original, "original selector identity guard");
        same(id(entry), guard.expected, "prepared selector identity");
      }
      if (entry.publication_stage === "latest_global") {
        for (const proof of proofs) await recheckObservationHistoryExactOnlyProofV3(proof);
        same(snapshot(await get(latestKey), latestKey), originalLatest, "original compact latest identity guard");
      }
      // Held exclusion + identity recheck, not a GET/PUT compare-and-swap claim.
      await held();
    },
    async afterReadback(entry) {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      await held();
      const guard = selectors.get(entry.key);
      if (guard) guard.selected = true;
      if (entry.publication_stage === "latest_global") {
        if (!rootAccepted) throw new Error("latest precedes complete canonical acceptance");
        latestReadback = true;
      }
    },
    async acceptCurrentRoot() {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      completedRun = null;
      rootAccepted = false;
      if ([...selectors.values()].some((s) => !s.selected)) throw new Error("not all selectors selected/read back");
      await held();
      const result = await finalizeCanonicalHierarchy();
      if (result?.ok !== true) throw new Error("canonical aggregate finalisation incomplete");
      // Authenticate the completed current root and all stored exact objects;
      // bottom-up child preparation did not require this root to exist earlier.
      reports = [];
      for (const [index, hierarchy] of hierarchies.entries()) {
        const report = await acceptObservationHistoryExactOnlyScopeV3(proofs[index]);
        same(report.selector, id(hierarchy.scoped_manifest), "accepted current selector");
        same(report.leaves, hierarchy.exact_leaves.map(id), "accepted immutable leaves");
        reports.push(report);
      }
      await checkLatestRoots(); await held(); rootAccepted = true;
    },
    async finalizeRun() {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      completedRun = null;
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
      completedRun = Object.freeze(id(expected));
    },
  }).map(([name, fn]) => [name, guarded(fn)])));
  return Object.freeze({ plan, latest, lifecycle, original_selectors: Object.freeze(
    [...selectors.values()].map((s) => s.original)),
    completedPublication: guarded(async () => {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      if (!completedRun || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId || "")) {
        throw new Error("exact-only publication/run finalisation or original invocation incomplete");
      }
      await held();
      for (const report of reports) await recheckObservationHistoryExactOnlyProofV3(report);
      await checkLatestRoots();
      same(id(snapshot(await get(latestKey), latestKey)), id(latest), "completed latest");
      same(id(snapshot(await get(completedRun.key), completedRun.key)), completedRun, "completed run");
      await held();
      const completion = Object.freeze({});
      const run = completedRun;
      completions.set(completion, { proofs: reports, assertHeld: held,
        assertUsable() {
          if (lost || failed || completedRun !== run) throw new Error("exact-only completion operation ended or changed");
        }, description: {
          schema_version: 1, kind: "uk_aq_prune_exact_only_completion",
          invocation_id: runId, finalisation_complete: true, latest: id(latest), run: completedRun,
          scopes: reports.map((report) => ({
            scope: report.scope, verifier_version: report.verifier_version, inspector: report.inspector,
            physical_identity: report.physical_identity, canonical_chain: report.canonical_chain,
            canonical_source_manifest: report.canonical_source_manifest,
            selector: report.selector, leaves: report.leaves, files: report.files,
            row_count: report.row_count,
          })),
        } });
      return completion;
    }),
    // Shared finaliser always rejects schema 2 in this phase, before any PUT or
    // durable-evidence adapter. There is no opt-in argument or env switch.
    finalize: (adapters) => finalizeObservationHistoryIndexV3Publication({ ...adapters,
      plan, exactOnlyLifecycle: lifecycle, publicationConcurrency: 1 }),
  });
}
// Exact object IO remains bound to the owning operation through its held
// assertion. The caller owns proof, attempt state and publication order.
function createExactOnlyObjectPublicationV3({ held, getObject, r2, admitConditionalWrite }) {
  const read = async key => {
    await held(); const object = await getObject({ key }); await held();
    const pin = snapshot(object, key);
    if (pin.exists && !isStrongR2Etag(pin.etag)) throw new Error('Conditional publication requires a strong current ETag');
    return { object, pin };
  };
  const exact = (object, artifact) => {
    const pin = snapshot(object, artifact.key);
    same(id(pin), id(artifact), 'immutable/selected bytes');
    if (!Buffer.from(object.body).equals(Buffer.from(artifact.body))) throw new Error('Exact publication bytes differ');
    return pin;
  };
  // One conditional attempt, followed by authoritative readback. No blind
  // retry, rollback, or GET/ordinary-PUT claimed as atomic compare-and-swap.
  const write = async (artifact, expected, attempt) => {
    assertObservationHistoryExactOnlyPublicationActiveV3();
    if (attempt.blocked) throw new Error('Conditional publication conflict requires explicit recovery');
    const before = await read(artifact.key);
    if (attempt.started) {
      if (before.pin.exists && before.pin.sha256 === artifact.sha256) {
        const pin = exact(before.object, artifact);
        if (attempt.etag) same(pin.etag, attempt.etag, 'original write object identity');
        return pin;
      }
      // If the original write did not land, only its unchanged predecessor may
      // be retried. Any other authority requires explicit external recovery.
    }
    same(before.pin, expected, 'previous selector/object identity');
    admitConditionalWrite?.(artifact);
    attempt.started = true;
    let outcome;
    try {
      await held();
      outcome = await r2PutObjectConditional({ r2, key: artifact.key, body: Buffer.from(artifact.body),
        sha256: artifact.sha256, content_type: artifact.content_type || 'application/json',
        ...(expected.exists ? { if_match: expected.etag } : { if_none_match: '*' }) });
      attempt.etag = outcome.etag;
      await held();
    } catch (error) {
      // Even rejected/ambiguous attempts require identity readback. A failed
      // precondition never authorises accepting another writer's selection.
      const current = await read(artifact.key);
      if (error.code !== 'R2_WRITE_AMBIGUOUS') { attempt.blocked = true; throw error; }
      const pin = exact(current.object, artifact);
      attempt.etag = pin.etag;
      return pin;
    }
    const current = await read(artifact.key);
    const pin = exact(current.object, artifact);
    same(pin.etag, outcome.etag, 'conditional write readback identity');
    return pin;
  };
  return Object.freeze({ read, exact, write });
}

// Internal, adapter-only Prune publication. This deliberately does not call or
// enable the hard-disabled shared schema-2 finaliser. The owning split writer
// captures selectors BEFORE canonical writes and retains this closure only in
// its original operation. It is not a conversion or cross-invocation recovery API.
export function createDormantPruneExactOnlyPublicationV3({ originalOperation, r2,
  getObject, recordDurableEvidence, admitConditionalWrite = null }) {
  if (!(typeof r2?.adapter?.putObjectConditional === 'function'
      || (r2?.endpoint && r2?.region && r2?.access_key_id && r2?.secret_access_key && r2?.bucket))
    || typeof getObject !== 'function' || typeof recordDurableEvidence !== 'function'
    || typeof originalOperation?.assertHeld !== 'function'
    || (admitConditionalWrite !== null && typeof admitConditionalWrite !== 'function')) {
    throw new Error('Dormant Prune publication requires conditional R2 capability and original operation');
  }
  let lost = false;
  let batchLatest = null;
  const scopes = new Map();
  const held = async () => {
    if (lost) throw originalOperationError('dormant publication original session lost');
    try {
      if (await originalOperation.assertHeld('publication') === false) throw originalOperationError('session not held');
    } catch (error) { lost = true; throw error; }
  };
  const { read, exact, write } = createExactOnlyObjectPublicationV3({
    held, getObject, r2, admitConditionalWrite,
  });
  const verifyLeaves = async state => {
    for (const leaf of state.prepared.hierarchy.exact_leaves) {
      const current = await read(leaf.key);
      exact(current.object, leaf);
      same(current.pin, state.leaves.get(leaf.key), 'verified immutable object identity');
    }
  };
  return Object.freeze({ held,
    async beginBatch() {
      await this.recheck();
      const current = await read(generation.observations_timeseries_latest_key);
      if (!batchLatest) batchLatest = { original: current.pin, attempt: {}, artifact: null };
      else if (batchLatest.artifact && current.pin.exists && current.pin.sha256 === batchLatest.artifact.sha256) {
        exact(current.object, batchLatest.artifact);
        if (batchLatest.attempt.etag) same(current.pin.etag, batchLatest.attempt.etag, 'original latest write identity');
      } else same(current.pin, batchLatest.original, 'original latest retry identity');
    },
    async capture(partitions) {
      for (const partition of partitions) {
        const artifact = partition.v3_hierarchy.scoped_manifest;
        if (scopes.has(artifact.key)) throw new Error('Duplicate dormant Prune scope');
        const { pin, object } = await read(artifact.key);
        if (pin.exists) {
          if (exactLeafFormatV3(JSON.parse(Buffer.from(object.body).toString('utf8'))).schema_version === 2) {
            throw new Error('Already selected schema-2 scope requires original-attempt recovery authority');
          }
          // This is a first-publication owner, never index-only conversion.
          // Existing schema-1 selector bytes remain pinned until the switch.
        }
        scopes.set(artifact.key, { original: pin, expected: id(artifact), prepared: null,
          selected: null, attempt: {}, leaves: new Map(), leafAttempts: new Map() });
      }
    },
    async publish({ preparedScopes, plan }) {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      // Validate the existing publication graph and the original scope set;
      // leaves from ALL scopes are durable before ANY selector is changed.
      const states = preparedScopes.map(prepared => {
        const state = scopes.get(prepared.hierarchy.scoped_manifest.key);
        if (!state) throw new Error('Missing original pre-write selector identity');
        same(state.expected, id(prepared.hierarchy.scoped_manifest), 'original prepared selector');
        state.prepared = prepared; return state;
      });
      const artifacts = preparedScopes.flatMap(p => p.hierarchy.publication_objects);
      same(plan.entries.map(id).sort((a,b) => a.key.localeCompare(b.key)),
        artifacts.map(id).sort((a,b) => a.key.localeCompare(b.key)), 'complete connector plan');
      for (const state of states) {
        await assertObservationHistoryExactOnlyPruneProofV3(state.prepared.proof, originalOperation);
        await recheckObservationHistoryExactOnlyProofV3(state.prepared.proof);
        for (const leaf of state.prepared.hierarchy.exact_leaves) {
          const current = await read(leaf.key);
          let pin;
          if (current.pin.exists) {
            pin = exact(current.object, leaf);
            if (state.leaves.has(leaf.key)) same(pin, state.leaves.get(leaf.key), 'reused immutable identity');
            const attempt = state.leafAttempts.get(leaf.key);
            if (attempt?.etag) same(pin.etag, attempt.etag, 'original immutable write identity');
          } else {
            const attempt = state.leafAttempts.get(leaf.key) || {};
            state.leafAttempts.set(leaf.key, attempt);
            pin = await write(leaf, current.pin, attempt);
          }
          state.leaves.set(leaf.key, pin);
        }
      }
      for (const state of states) {
        await recheckObservationHistoryExactOnlyProofV3(state.prepared.proof);
        await verifyLeaves(state);
        const selector = state.prepared.hierarchy.scoped_manifest;
        if (state.selected) same((await read(selector.key)).pin, state.selected, 'selected scope identity');
        else state.selected = await write(selector, state.original, state.attempt);
        await verifyLeaves(state);
      }
      const objects = [];
      for (const entry of plan.entries) {
        const current = await read(entry.key); exact(current.object, entry);
        const durable = await recordDurableEvidence({ ...id(entry), publication_stage: entry.publication_stage,
          post_put_get_verified: true, schedule_sha256: plan.schedule_sha256, position: entry.position });
        if (durable?.durable !== true) throw new Error('Dormant exact publication durable evidence incomplete');
        objects.push(Object.freeze({ ...id(entry), verified: true, durable: true }));
      }
      await held();
      return Object.freeze({ ok: true, status: 'published', objects: Object.freeze(objects) });
    },
    async recheck() {
      for (const state of scopes.values()) {
        if (!state.selected || !state.prepared) throw new Error('Leaf-only/interrupted selector publication is incomplete');
        await assertObservationHistoryExactOnlyPruneProofV3(state.prepared.proof, originalOperation);
        await recheckObservationHistoryExactOnlyProofV3(state.prepared.proof);
        await verifyLeaves(state);
        same((await read(state.selected.key)).pin, state.selected, 'selected scope identity');
      }
      await held();
    },
    async publishLatest(artifact) {
      assertObservationHistoryExactOnlyPublicationActiveV3();
      await this.recheck();
      if (!batchLatest) throw new Error('Missing original batch latest identity');
      if (batchLatest.artifact) same(id(artifact), id(batchLatest.artifact), 'prepared latest retry');
      batchLatest.artifact = artifact;
      const result = await write(artifact, batchLatest.original, batchLatest.attempt);
      await this.recheck();
      return { ok: true, key: result.key, byte_size: result.byte_size, sha256: result.sha256,
        verified: true, post_put_get_verified: true, status: 'succeeded' };
    },
  });
}
