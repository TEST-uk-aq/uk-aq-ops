// Read-only Node verification. This is neither Prune deletion authority nor a
// replacement for authenticated original evidence, receipts or source-to-final
// comparison. There is no cross-operation footer/layout cache.
import { Buffer } from "node:buffer";
import { sha256Hex } from "./r2_sigv4.mjs";
import { encodeObservationHistoryIndexV3Json as json,
  validateObservationHistoryExactLeafScopedManifestArtifactV3,
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
} from "./uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { inspectPinnedCanonicalObservationFilesV3,
  OBSERVATION_HISTORY_OFFLINE_INSPECTOR_V3,
} from "./uk_aq_observation_history_target_writer.mjs";
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 as limits } from "./uk_aq_observation_history_writer_limits_v3.mjs";
import { getObservationHistoryGeneration } from "./uk_aq_observation_history_generation.mjs";
import { observationHistoryPhysicalSchemasFromManifest } from "./uk_aq_observation_history_schema.mjs";
import { validateCanonicalHistoryV2Manifest } from "./uk_aq_r2_history_manifest_validation.mjs";
import { validateObservationContentHashMetadata } from "./uk_aq_observation_content_hash.mjs";
import { validateR2HistoryV2ObservationsAggregateManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  buildR2HistoryV2ObservationsMonthManifestKey,
} from "./uk_aq_r2_observations_manifest_hierarchy.mjs";

export const EXACT_ONLY_DIRECT_VERIFIER_V3 = "exact-only-canonical-physical-v2";
const generation = getObservationHistoryGeneration("v3");
const SHA = /^[0-9a-f]{64}$/;
const physicalProofs = new WeakMap();

function equal(actual, expected, label) {
  if (json(actual) !== json(expected)) throw new Error(`direct verification ${label} mismatch`);
}
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`direct verification invalid ${label}`);
  return value;
}
function identity(object) {
  return { key: object.key, byte_size: object.byte_size, sha256: object.sha256 };
}
function descriptor(file) {
  return { key: file.key, byte_size: file.byte_size, sha256: file.sha256,
    row_count: file.row_count, row_group_count: file.row_group_count };
}
function segment(s) {
  return Object.fromEntries(["timeseries_id", "file_key", "row_group_ordinal", "row_start",
    "row_group_row_start", "row_count", "min_observed_at_utc", "max_observed_at_utc", "column_ranges"]
    .map((key) => [key, s[key]]));
}
function scopePath(scope) {
  const { day_utc: day, connector_id: connector, pollutant_code: pollutant } = scope || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      !Number.isSafeInteger(connector) || connector <= 0 || !/^[a-z0-9_]+$/.test(pollutant)) throw new Error("direct verification invalid scope");
  return `day_utc=${day}/connector_id=${connector}/pollutant_code=${pollutant}`;
}

// Explicit canonical contract_version is accepted hash-version provenance; no
// inference from hash bytes, exact-index schema or a reader's physical support.
export function exactCanonicalHashVersionV3(manifest) {
  validateObservationContentHashMetadata(manifest, { rowCount: manifest.row_count });
  const version = manifest.observation_content_hash_contract_version;
  if (Object.hasOwn(manifest, "observation_content_hash_version") &&
      manifest.observation_content_hash_version !== version) throw new Error("contradictory canonical hash versions");
  return version;
}

function context({ getObject, headObject = null, assertOperationHeld }) {
  if (typeof getObject !== "function" || typeof assertOperationHeld !== "function") {
    throw new Error("direct verification requires authenticated GET and held observations-operation exclusion");
  }
  if (headObject !== null && typeof headObject !== "function") throw new Error("invalid direct-verifier HEAD adapter");
  const pins = new Map(), parquetKeys = new Set();
  let lost = false, invalidated = false;
  const held = async () => {
    if (lost) throw new Error("direct verification operation exclusion was lost");
    if (invalidated) throw new Error("direct verification proof was invalidated; fresh verification required");
    try {
      if (await assertOperationHeld() === false) throw new Error("observations-operation exclusion is not held");
    } catch (error) { lost = true; throw error; }
  };
  async function read(key, { parquet = false } = {}) {
    await held();
    const object = await getObject({ key });
    await held();
    if (!object || object.exists === false || object.key !== key ||
        !(typeof object.body === "string" || object.body instanceof Uint8Array) ||
        typeof object.etag !== "string" || !object.etag) throw new Error(`direct verification missing body/current identity: ${key}`);
    const body = Buffer.from(object.body);
    const pin = { key, byte_size: body.length, sha256: sha256Hex(body), etag: object.etag };
    // Native authenticated S3 GET supplies the complete body and length, but
    // does not expose a stored checksum. Compute its SHA here; canonical file
    // reconciliation below still requires exact SHA equality. If supplied,
    // stored checksum metadata must independently agree, never be invented.
    if (parquet && ((object.sha256 != null && object.sha256 !== pin.sha256) ||
        (object.byte_size ?? object.bytes) !== pin.byte_size)) {
      throw new Error(`direct verification stored file SHA/size mismatch: ${key}`);
    }
    const prior = pins.get(key);
    if (prior) equal(pin, prior, `changed pinned object ${key}`);
    pins.set(key, pin);
    if (parquet) parquetKeys.add(key);
    return { ...pin, body };
  }
  async function recheck() {
    try {
      for (const pin of [...pins.values()]) {
        if (parquetKeys.has(pin.key) && headObject) {
          // The independent full-body SHA and inspection already exist in this
          // held operation. Require the authenticated stored checksum as well as
          // size AND unchanged ETag; an ETag alone is never SHA-256 evidence.
          await held();
          const object = await headObject({ key: pin.key });
          await held();
          if (!object || object.exists !== true || object.key !== pin.key ||
              !SHA.test(object.sha256) || !Number.isSafeInteger(object.byte_size ?? object.bytes) ||
              (object.byte_size !== undefined && object.bytes !== undefined && object.byte_size !== object.bytes) ||
              typeof object.etag !== "string" || !object.etag) {
            throw new Error(`direct verification current file SHA/size/ETag unavailable: ${pin.key}`);
          }
          equal({ key: object.key, byte_size: object.byte_size ?? object.bytes,
            sha256: object.sha256, etag: object.etag }, pin, `changed pinned object ${pin.key}`);
        } else {
          // No checksum-capable HEAD adapter: retain exact body verification at
          // this boundary. Never fall back from contradictory HEAD evidence.
          await read(pin.key, { parquet: parquetKeys.has(pin.key) });
        }
      }
      await held();
    } catch (error) {
      // A changed or uncertain identity cannot become reusable by restoring
      // metadata or retrying this handle. Start independent verification anew.
      invalidated = true;
      throw error;
    }
  }
  return { read, held, pins, recheck };
}

function aliases(parent, collection, identifier) {
  if (!Array.isArray(parent.child_manifests) || !Array.isArray(parent[collection]) || !parent[collection].length) {
    throw new Error("direct verification missing canonical child aliases");
  }
  equal(parent.child_manifests, parent[collection], "complete canonical aliases");
  const seen = new Set(), keys = new Set();
  for (const ref of parent[collection]) {
    const id = ref[identifier];
    if (seen.has(id) || !SHA.test(ref.manifest_hash) || typeof ref.manifest_key !== "string") throw new Error("direct verification contradictory child set");
    if (keys.has(ref.manifest_key)) throw new Error("duplicate canonical child key");
    const token = identifier === "connector_id" ? `connector_id=${positive(id, "connector member")}` : `pollutant_code=${id}`;
    if (identifier === "pollutant_code" && !/^[a-z0-9_]+$/.test(id)) throw new Error("invalid canonical pollutant member");
    equal(ref.manifest_key, parent.manifest_key.replace(/\/manifest\.json$/, `/${token}/manifest.json`), "canonical child path");
    keys.add(ref.manifest_key); seen.add(id);
  }
  equal(parent[identifier === "connector_id" ? "connector_ids" : "pollutant_codes"], [...seen], "canonical child membership");
  return parent[collection];
}

async function canonicalSource(ctx, scope, expectedRoot = null) {
  const prefix = generation.observations_prefix;
  const scopeKey = `${prefix}/${scopePath(scope)}/manifest.json`;
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const year = scope.day_utc.slice(0, 4), month = scope.day_utc.slice(5, 7);
  const keys = [rootKey, buildR2HistoryV2ObservationsYearManifestKey(prefix, year),
    buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month)];
  const chain = [];
  const aggregates = [];
  for (const [index, key] of keys.entries()) {
    const object = await ctx.read(key);
    if (index === 0 && expectedRoot) equal(identity(object), identity(expectedRoot), "original canonical root");
    const payload = JSON.parse(object.body.toString("utf8"));
    const canonical = validateR2HistoryV2ObservationsAggregateManifest(payload, { basePrefix: prefix });
    equal(payload, canonical, "canonical aggregate complete child set");
    chain.push(identity(object)); aggregates.push(payload);
  }
  for (const [index, target] of [[0, keys[1]], [1, keys[2]]]) {
    const ref = aggregates[index].children.find((c) => c.manifest_key === target);
    if (!ref) throw new Error("direct verification missing aggregate child");
    equal(ref.content_hash, aggregates[index + 1].content_hash, "aggregate child hash");
  }
  const dayKey = `${prefix}/day_utc=${scope.day_utc}/manifest.json`;
  const connectorKey = `${prefix}/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}/manifest.json`;
  const lower = [];
  for (const [kind, key] of [["day", dayKey], ["connector", connectorKey], ["pollutant", scopeKey]]) {
    const object = await ctx.read(key);
    const payload = JSON.parse(object.body.toString("utf8"));
    validateCanonicalHistoryV2Manifest(payload, { history_version: "v2", domain: "observations",
      manifest_kind: kind, manifest_key: key, day_utc: scope.day_utc,
      ...(kind !== "day" ? { connector_id: scope.connector_id } : {}),
      ...(kind === "pollutant" ? { pollutant_code: scope.pollutant_code } : {}),
    });
    if (payload.manifest_schema_version !== 3) throw new Error("unsupported canonical manifest schema");
    observationHistoryPhysicalSchemasFromManifest(payload);
    chain.push(identity(object)); lower.push({ object, payload });
  }
  const dayRef = aggregates[2].children.find((c) => c.manifest_key === dayKey);
  if (!dayRef) throw new Error("direct verification missing canonical day");
  equal(dayRef.manifest_hash, lower[0].payload.manifest_hash, "month/day hash");
  for (const [index, collection, id] of [[0, "connector_manifests", "connector_id"], [1, "pollutant_manifests", "pollutant_code"]]) {
    const parent = lower[index].payload, child = lower[index + 1].payload;
    const refs = aliases(parent, collection, id);
    const ref = refs.find((r) => r[id] === child[id]);
    if (!ref) throw new Error("direct verification missing selected child");
    for (const [field, value] of Object.entries(ref)) equal(child[field], value, `selected child ${field}`);
    // Repeated canonical file tables must agree for the complete selected child.
    const selectedFiles = parent.files.filter((f) => child.files.some((c) => c.key === f.key));
    equal(selectedFiles, child.files, "selected canonical parent file table");
    equal(refs.reduce((n, r) => n + positive(r.row_count, "child row count"), 0), parent.row_count, "parent child row total");
    equal(refs.reduce((n, r) => n + positive(r.file_count, "child file count"), 0), parent.file_count, "parent child file total");
    equal(refs.reduce((n, r) => n + positive(r.total_bytes, "child byte count"), 0), parent.total_bytes, "parent child byte total");
  }
  const { object, payload } = lower[2];
  positive(payload.row_count, "canonical rows");
  if (payload.history_schema_version !== 3 || payload.writer_version !== "parquet-wasm-zstd-v3") {
    throw new Error("offline direct verifier does not support this canonical physical schema/writer (schema 4 is unsupported)");
  }
  if (payload.child_manifests.length || payload.file_count <= 0) throw new Error("invalid canonical pollutant members");
  return { payload, chain, descriptor: { ...identity(object), manifest_hash: payload.manifest_hash,
    row_count: payload.row_count, observation_content_hash: payload.observation_content_hash,
    observation_content_hash_version: exactCanonicalHashVersionV3(payload) } };
}

// Reads every canonical file and inspects its actual bytes, independent of any
// proposed leaf. A new writer calls this after child writes; a completed root is
// authenticated separately at final acceptance. Existing scopes pass completed
// root-to-DCP authentication through verifyObservationHistoryExactOnlyScopeV3.
async function physicalMetadata(ctx, canonical, scope) {
  if (canonical.history_schema_version !== 3 || canonical.writer_version !== "parquet-wasm-zstd-v3" ||
      exactCanonicalHashVersionV3(canonical) !== 1) {
    throw new Error("offline inspector supports physical schema 3 / writer v3 / observation hash v1 only");
  }
  if (canonical.manifest_schema_version !== 3) throw new Error("unsupported canonical manifest schema");
  observationHistoryPhysicalSchemasFromManifest(canonical);
  equal(canonical.pollutant_codes, [scope.pollutant_code], "canonical pollutant membership");
  equal(canonical.child_manifests, [], "canonical pollutant child set");
  const files = canonical.files;
  if (!Array.isArray(files) || !files.length) throw new Error("missing canonical physical files");
  const scopePrefix = `${generation.observations_prefix}/${scopePath(scope)}`;
  const bodies = [];
  for (const [ordinal, file] of files.entries()) {
    const key = `${scopePrefix}/part-${String(ordinal).padStart(5, "0")}.parquet`;
    if (file.key !== key || !SHA.test(file.etag_or_hash)) throw new Error("canonical file order/key/hash mismatch");
    positive(file.row_count, "file rows"); positive(file.bytes, "file bytes");
    equal(file.pollutant_code, scope.pollutant_code, "canonical file pollutant");
    equal(file.pollutant_codes, [scope.pollutant_code], "canonical file pollutant membership");
    if (file.bytes > limits.max_file_bytes || file.row_count > limits.max_file_rows) throw new Error("canonical file exceeds accepted limits");
    const object = await ctx.read(key, { parquet: true });
    equal(object.byte_size, file.bytes, "canonical file size"); equal(object.sha256, file.etag_or_hash, "canonical file SHA");
    bodies.push({ key, body: object.body });
  }
  const { metadata } = inspectPinnedCanonicalObservationFilesV3(bodies, {
    historySchemaVersion: canonical.history_schema_version, writerVersion: canonical.writer_version,
    limits, partition: scope, fileKeyForOrdinal: (ordinal) => files[ordinal].key,
  });
  equal(canonical.columns, metadata.columns, "canonical physical columns");
  for (const field of ["row_count", "file_count", "observation_content_hash", "observation_content_hash_algorithm",
    "observation_content_hash_contract_version", "observation_content_hash_row_count", "observation_content_hash_columns", "verification_status_counts"]) {
    equal(canonical[field], metadata[field], `canonical decoded ${field}`);
  }
  equal(canonical.total_bytes, metadata.files.reduce((n, f) => n + f.byte_size, 0), "canonical total bytes");
  equal(canonical.parquet_object_keys, metadata.files.map((f) => f.key), "complete canonical file keys");
  const counts = {};
  for (const [i, file] of metadata.files.entries()) {
    const actual = files[i];
    equal(actual.timeseries_row_counts, file.timeseries_row_counts, "canonical per-file series counts");
    const groups = file.row_groups;
    for (const [field, value] of Object.entries({
      row_count: file.row_count, min_timeseries_id: Math.min(...groups.map((g) => g.min_timeseries_id)),
      max_timeseries_id: Math.max(...groups.map((g) => g.max_timeseries_id)),
      min_observed_at_utc: groups.map((g) => g.min_observed_at_utc).sort()[0],
      max_observed_at_utc: groups.map((g) => g.max_observed_at_utc).sort().at(-1),
    })) equal(actual[field], value, `canonical per-file ${field}`);
    for (const [id, count] of Object.entries(file.timeseries_row_counts)) counts[id] = (counts[id] || 0) + count;
  }
  equal(canonical.timeseries_row_counts, counts, "complete canonical series counts");
  equal(canonical.min_timeseries_id, Math.min(...Object.keys(counts).map(Number)), "scope min series");
  equal(canonical.max_timeseries_id, Math.max(...Object.keys(counts).map(Number)), "scope max series");
  equal(canonical.min_observed_at_utc, metadata.segments.map((s) => s.min_observed_at_utc).sort()[0], "scope minimum time");
  equal(canonical.max_observed_at_utc, metadata.segments.map((s) => s.max_observed_at_utc).sort().at(-1), "scope maximum time");
  return metadata;
}

function reconcile(hierarchy, source, metadata, indexRoot) {
  const parent = hierarchy.scoped_manifest, leaves = hierarchy.exact_leaves;
  if (parent?.payload?.schema_version !== 2) throw new Error("direct verifier requires explicit schema-2 selection");
  validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact: parent, exactLeaves: leaves, indexRoot });
  equal(parent.payload.canonical_source_manifest, source, "authenticated direct canonical descriptor");
  const bySeries = new Map();
  for (const s of metadata.segments) {
    const list = bySeries.get(s.timeseries_id) || [];
    list.push(segment(s)); bySeries.set(s.timeseries_id, list);
  }
  equal(leaves.map((l) => l.payload.timeseries_id).sort((a, b) => a - b), [...bySeries.keys()].sort((a, b) => a - b), "complete exact members");
  for (const leaf of leaves) {
    const p = leaf.payload;
    const expected = bySeries.get(p.timeseries_id).sort((a, b) =>
      a.min_observed_at_utc.localeCompare(b.min_observed_at_utc) || a.file_key.localeCompare(b.file_key) || a.row_group_ordinal - b.row_group_ordinal);
    equal(p.segments, expected, "actual physical segments/ranges/order");
    const keys = new Set(expected.map((s) => s.file_key));
    const expectedFiles = metadata.files.filter((f) => keys.has(f.key)).map((f) => {
      const pin = p.files.find((claimed) => claimed.key === f.key);
      if (pin?.etag) return { ...descriptor(f), etag: pin.etag };
      return descriptor(f);
    });
    equal(p.files, expectedFiles, "complete leaf physical files");
    equal(p.row_count, expected.reduce((n, s) => n + s.row_count, 0), "series count");
    equal(p.min_observed_at_utc, expected[0].min_observed_at_utc, "series minimum");
    equal(p.max_observed_at_utc, expected.at(-1).max_observed_at_utc, "series maximum");
    for (const prerequisite of leaf.publication_prerequisites) equal(identity(prerequisite), identity(source), "canonical leaf prerequisite");
  }
}

// Reusable read-only entry point for Prune and independent post-write adapters.
// Passing a hierarchy is preparation-only; omitting it verifies exact stored
// selector/leaf bytes. Neither mode creates durable original evidence.
export async function verifyObservationHistoryExactOnlyScopeV3({
  scope, getObject, headObject = null, assertOperationHeld, hierarchy = null,
  indexRoot = generation.observations_timeseries_index_prefix, expectedRoot = null,
}) {
  if (indexRoot !== generation.observations_timeseries_index_prefix) throw new Error("unsupported selected v3 index root");
  const ctx = context({ getObject, headObject, assertOperationHeld });
  const source = await canonicalSource(ctx, scope, expectedRoot);
  const metadata = await physicalMetadata(ctx, source.payload, scope);
  let selected = hierarchy;
  if (!selected) {
    const key = `${indexRoot}/${scopePath(scope)}/manifest.json`;
    const parent = await ctx.read(key);
    const payload = JSON.parse(parent.body.toString("utf8"));
    if (payload.schema_version !== 2) throw new Error("unsupported selected exact format for direct verifier");
    const leaves = [];
    for (const tuple of Object.values(payload.leaves_by_timeseries_id || {})) {
      const object = await ctx.read(tuple[0]);
      equal([object.key, object.byte_size, object.sha256], tuple, "stored immutable leaf");
      const leaf = JSON.parse(object.body.toString("utf8"));
      leaves.push({ ...identity(object), body: object.body.toString("utf8"), payload: leaf,
        kind: "observation_history_index_v3_exact_leaf", publication_stage: "child_shard",
        dependencies: leaf.files.map((f) => ({ ...identity(f), kind: "canonical_parquet" })),
        publication_prerequisites: [{ ...identity(source.descriptor), kind: "canonical_manifest" }],
      });
    }
    selected = { exact_leaves: leaves, scoped_manifest: {
      ...identity(parent), body: parent.body.toString("utf8"), payload,
      kind: "observation_history_index_v3_exact_leaf_scoped_manifest", publication_stage: "scoped_manifest",
      dependencies: [{ ...identity(source.descriptor), kind: "canonical_manifest" },
        ...leaves.map((l) => ({ ...identity(l), kind: "child_shard" }))], publication_prerequisites: [],
    } };
  }
  reconcile(selected, source.descriptor, metadata, indexRoot);
  for (const leaf of selected.exact_leaves) for (const file of leaf.payload.files) {
    if (file.etag) equal(file.etag, ctx.pins.get(file.key).etag, "current leaf ETag");
  }
  await ctx.recheck();
  const report = Object.freeze({ verifier_version: EXACT_ONLY_DIRECT_VERIFIER_V3,
    inspector: OBSERVATION_HISTORY_OFFLINE_INSPECTOR_V3, scope: Object.freeze({ ...scope }),
    canonical_chain: Object.freeze(source.chain), canonical_source_manifest: Object.freeze(source.descriptor),
    selector: Object.freeze(identity(selected.scoped_manifest)),
    leaves: Object.freeze(selected.exact_leaves.map((l) => Object.freeze(identity(l)))),
    files: Object.freeze(metadata.files.map((f) => Object.freeze({ ...descriptor(f), etag: ctx.pins.get(f.key).etag }))),
    row_count: metadata.row_count, canonical_hierarchy_complete: true, stored_selection_verified: hierarchy === null,
    finalisation_complete: false, source_to_final_verified: false,
    file_identity_proof: "authenticated_complete_body_sha256",
  });
  physicalProofs.set(report, { ctx, hierarchy: selected, source: source.descriptor, metadata, indexRoot });
  return report;
}

// Only operation liveness, not current object identity or physical inspection.
// This cheap guard is safe between scope-level identity/acceptance boundaries;
// it cannot refresh a proof or survive loss of its original lock session.
export async function assertObservationHistoryExactOnlyProofOperationV3(report) {
  const proof = physicalProofs.get(report);
  if (!proof) throw new Error("missing operation-local direct verification proof");
  await proof.ctx.held();
}

// Opaque operation-local proof: serialised/copied reports cannot admit a write.
// Recheck current identities and complete prepared artifact consistency. This
// reuses inspection evidence, not a new full physical inspection; the latter
// remains mandatory in verifyObservationHistoryExactOnlyScopeV3().
export async function recheckObservationHistoryExactOnlyProofV3(report) {
  const proof = physicalProofs.get(report);
  if (!proof) throw new Error("missing operation-local direct verification proof");
  await proof.ctx.recheck();
  reconcile(proof.hierarchy, proof.source, proof.metadata, proof.indexRoot);
  equal(identity(proof.hierarchy.scoped_manifest), report.selector, "verified selector identity");
  equal(proof.hierarchy.exact_leaves.map(identity), report.leaves, "verified leaf identities");
  return proof.hierarchy;
}

// Shared producer entry for future writer adapters. Files and the canonical
// pollutant child must already be durably written. No completed root is required
// yet; it is mandatory at final acceptance. Always inspect actual pinned files.
export async function prepareObservationHistoryExactOnlyScopeV3({ scope, getObject, headObject = null, assertOperationHeld }) {
  const ctx = context({ getObject, headObject, assertOperationHeld });
  const key = `${generation.observations_prefix}/${scopePath(scope)}/manifest.json`;
  const object = await ctx.read(key);
  const canonical = JSON.parse(object.body.toString("utf8"));
  validateCanonicalHistoryV2Manifest(canonical, { history_version: "v2", domain: "observations",
    manifest_kind: "pollutant", manifest_key: key, ...scope });
  const source = { ...identity(object), manifest_hash: canonical.manifest_hash,
    row_count: canonical.row_count, observation_content_hash: canonical.observation_content_hash,
    observation_content_hash_version: exactCanonicalHashVersionV3(canonical) };
  const metadata = await physicalMetadata(ctx, canonical, scope);
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata, canonicalManifest: source, exactSchemaVersion: 2,
  });
  reconcile(hierarchy, source, metadata, generation.observations_timeseries_index_prefix);
  await ctx.recheck();
  const proof = Object.freeze({ verifier_version: EXACT_ONLY_DIRECT_VERIFIER_V3,
    inspector: OBSERVATION_HISTORY_OFFLINE_INSPECTOR_V3,
    canonical_source_manifest: Object.freeze(source),
    selector: Object.freeze(identity(hierarchy.scoped_manifest)),
    leaves: Object.freeze(hierarchy.exact_leaves.map((l) => Object.freeze(identity(l)))),
    canonical_hierarchy_complete: false, finalisation_complete: false, source_to_final_verified: false,
  });
  physicalProofs.set(proof, { ctx, hierarchy, source, metadata,
    indexRoot: generation.observations_timeseries_index_prefix });
  return Object.freeze({ hierarchy, proof });
}
