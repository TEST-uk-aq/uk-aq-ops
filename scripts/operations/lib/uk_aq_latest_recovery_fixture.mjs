import assert from "node:assert/strict";
import { sha256Hex, isStrongR2Etag } from "../../../workers/shared/r2_sigv4.mjs";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  encodeObservationHistoryIndexV3Json, scopedRootDescriptor,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
  validateObservationHistoryExactLeafScopedManifestArtifactV3,
} from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS, serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  buildHistoryV2ConnectorManifestKey, buildHistoryV2PollutantManifestKey,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { validateCanonicalHistoryV2Manifest } from "../../../workers/shared/uk_aq_r2_history_manifest_validation.mjs";
import { verifyObservationHistoryV3UnlistedScope } from "../../../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";

export const SOURCE_BUCKET = "uk-aq-history-cic-test-v3-accept-20261014";
export const DAY = "2026-07-02";
export const CONNECTOR = 3;
export const GENERATION = getObservationHistoryGeneration("v3");
export const LATEST = GENERATION.observations_timeseries_latest_key;
export const SHA256 = /^[0-9a-f]{64}$/;
const prefix = GENERATION.observations_prefix;
const index = GENERATION.observations_timeseries_index_prefix;
const isSelected = scope => scope.day_utc === DAY && scope.connector_id === CONNECTOR;

export function objectIdentity({ key, body, etag }) {
  return { key, byte_size: body.length, sha256: sha256Hex(body), etag };
}

export function assertExactObject(object, reference) {
  assert(object.key === reference.key && object.body.length === reference.byte_size &&
    sha256Hex(object.body) === reference.sha256, `Object identity differs: ${reference.key}`);
}

export function latestRegistry(object) {
  assert(isStrongR2Etag(object.etag), "Latest requires a strong ETag");
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: {
    ...objectIdentity(object), body: object.body.toString("utf8"), payload: JSON.parse(object.body),
    kind: "observation_history_index_v3_latest_global", publication_stage: "latest_global",
  } });
}

// Stop taking work on failure and await outstanding I/O before returning to the caller.
export async function forEachBounded(items, operation) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => {
    while (!failure && next < items.length) {
      try { await operation(items[next++]); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}

async function readCanonicalGraph(read) {
  const scopes = new Map();
  async function canonical(kind, ref, scope, key) {
    assert.equal(ref.manifest_key, key);
    const manifest = JSON.parse((await read(key)).body);
    validateCanonicalHistoryV2Manifest(manifest, { manifest_key: key, domain: "observations", manifest_kind: kind, ...scope });
    assert.equal(manifest.manifest_hash, ref.manifest_hash);
    return manifest;
  }
  async function day(dayRef) {
    const dayUtc = dayRef.day_utc;
    const parent = await canonical("day", dayRef, { day_utc: dayUtc }, `${prefix}/day_utc=${dayUtc}/manifest.json`);
    assert.deepEqual(parent.connector_manifests, parent.child_manifests);
    for (const connRef of parent.connector_manifests) {
      const connectorId = connRef.connector_id;
      const scope = { day_utc: dayUtc, connector_id: connectorId };
      const conn = await canonical("connector", connRef, scope, buildHistoryV2ConnectorManifestKey(prefix, dayUtc, connectorId));
      assert.deepEqual(conn.pollutant_manifests, conn.child_manifests);
      for (const descriptor of conn.pollutant_manifests) {
        const code = descriptor.pollutant_code;
        const key = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, code);
        const manifest = await canonical("pollutant", descriptor, { ...scope, pollutant_code: code }, key);
        assert(!scopes.has(key), `Duplicate canonical scope: ${key}`);
        for (const file of manifest.files) {
          assert(file.key.startsWith(key.slice(0, -"manifest.json".length)) && file.key.endsWith(".parquet"));
          assertExactObject(await read(file.key), { key: file.key, byte_size: Number(file.bytes), sha256: file.etag_or_hash });
        }
        scopes.set(key, { descriptor, manifest });
      }
    }
  }
  async function aggregate(level, key, fields = {}, contentHash) {
    const { body } = await read(key);
    const manifest = validateR2HistoryV2ObservationsAggregateManifest(JSON.parse(body), { basePrefix: prefix });
    assert(manifest.kind === OBSERVATIONS_AGGREGATE_MANIFEST_KINDS[level] &&
      (!contentHash || manifest.content_hash === contentHash) &&
      Object.entries(fields).every(([field, value]) => manifest[field] === value) &&
      body.equals(serializeR2HistoryV2ObservationsAggregateManifest(manifest, { basePrefix: prefix })),
    `Invalid ${level} manifest: ${key}`);
    return manifest.children;
  }
  for (const year of await aggregate("root", GENERATION.observations_root_key)) {
    for (const month of await aggregate("year", year.manifest_key, { year: year.year }, year.content_hash)) {
      for (const ref of await aggregate("month", month.manifest_key, { year: year.year, month: month.month }, month.content_hash)) {
        await day(ref);
      }
    }
  }
  return scopes;
}

async function readScopedGraph(read, root, canonicalKey, canonical) {
  const scopePath = root.key.slice(index.length + 1, -"/manifest.json".length);
  const alignedPrefix = `${index}/_aligned/${scopePath}/`;
  async function indexObject(ref, kind, expectedPrefix) {
    assert(ref.key.startsWith(expectedPrefix) && ref.key.endsWith(".json"), `Unexpected index key: ${ref.key}`);
    const object = await read(ref.key);
    assertExactObject(object, ref);
    const payload = JSON.parse(object.body);
    assert(payload.schema_version === 1 && payload.kind === kind && payload.key === ref.key &&
      payload.day_utc === root.day_utc && payload.connector_id === root.connector_id &&
      payload.pollutant_code === root.pollutant_code &&
      object.body.equals(Buffer.from(encodeObservationHistoryIndexV3Json(payload))), `Invalid schema-1 object: ${ref.key}`);
    return { ...ref, body: object.body.toString("utf8"), payload };
  }

  const scoped = await indexObject(root, "observation_timeseries_physical_leaf_scoped_manifest", `${index}/${scopePath}/`);
  assert.deepEqual(scopedRootDescriptor(scoped), root);
  const aligned = await indexObject(scoped.payload.source_aligned_scoped_manifest,
    "observation_timeseries_aligned_source_manifest", alignedPrefix);
  assert.equal(aligned.key, `${alignedPrefix}manifest.json`);
  assert.equal(aligned.payload.canonical_source_manifest.key, canonicalKey);
  assertExactObject(await read(canonicalKey), aligned.payload.canonical_source_manifest);
  assert.equal(Number(canonical.row_count), root.row_count);

  const files = new Map(canonical.files.map(file => [file.key, { byte_size: Number(file.bytes), sha256: file.etag_or_hash }]));
  const verifyFiles = (references, used) => {
    for (const { key, byte_size, sha256 } of references) {
      assert.deepEqual(files.get(key), { byte_size, sha256 }, `Parquet reference differs: ${key}`);
      used.add(key);
    }
  };
  const alignedFiles = new Set(), leafFiles = new Set(), children = new Map();
  for (const ref of aligned.payload.children) {
    const child = await indexObject(ref, "observation_timeseries_aligned_source_shard", alignedPrefix);
    assert.deepEqual(child.payload.canonical_source_manifest, aligned.payload.canonical_source_manifest);
    verifyFiles(child.payload.files, alignedFiles);
    assert(!children.has(ref.key), `Duplicate aligned child: ${ref.key}`);
    children.set(ref.key, child);
  }
  const leaves = [];
  const usedChildren = new Set();
  await forEachBounded(Object.entries(scoped.payload.leaves_by_timeseries_id), async ([id, [key, byte_size, sha256]]) => {
    assert.equal(key, `${index}/${scopePath}/timeseries_id=${id.padStart(9, "0")}.json`);
    const leaf = await indexObject({ key, byte_size, sha256 }, "observation_timeseries_physical_leaf", `${index}/${scopePath}/`);
    const childRef = leaf.payload.source_aligned_child;
    const child = children.get(childRef.key);
    assert.equal(leaf.payload.timeseries_id, Number(id));
    assert(child?.byte_size === childRef.byte_size && child.sha256 === childRef.sha256, `Invalid aligned dependency: ${key}`);
    usedChildren.add(childRef.key);
    verifyFiles(leaf.payload.files, leafFiles);
    leaves.push({ ...leaf, kind: "observation_history_index_v3_exact_leaf", publication_stage: "child_shard" });
  });
  assert(alignedFiles.size === files.size && leafFiles.size === files.size && usedChildren.size === children.size &&
    leaves.reduce((sum, leaf) => sum + leaf.payload.row_count, 0) === root.row_count, `Incomplete exact scope: ${root.key}`);
  validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact: {
    ...scoped, kind: "observation_history_index_v3_exact_leaf_scoped_manifest", publication_stage: "scoped_manifest",
  }, exactLeaves: leaves });
  return leaves.map(leaf => leaf.key).sort()[0];
}

export async function loadFixture(getObject) {
  const objects = new Map();
  let bytes = 0;
  async function read(key) {
    assert((key === LATEST || key.startsWith(`${prefix}/`) || key.startsWith(`${index}/`)) &&
      key.split("/").every(part => /^[a-zA-Z0-9_=.-]+$/.test(part) && part !== "." && part !== ".."), "Unsafe fixture key");
    if (objects.has(key)) return objects.get(key);
    assert(objects.size < 4000 && bytes < 128 * 1024 * 1024, "Source exceeds the bounded fixture size");
    const object = await getObject(key);
    bytes += object.body.length;
    assert(bytes <= 128 * 1024 * 1024, "Source exceeds the bounded fixture byte size");
    objects.set(key, object);
    return object;
  }
  const original = await read(LATEST);
  const registry = latestRegistry(original);
  const additions = registry.roots.filter(isSelected);
  assert(registry.roots.length === 12 && registry.artifact.payload.total_rows === 31928);
  assert.deepEqual(additions.map(root => root.pollutant_code), ["no2", "pm25"]);
  assert(additions.reduce((sum, root) => sum + root.row_count, 0) === 5106);
  assert(registry.roots.some(root => root.day_utc === DAY && root.connector_id === 2) && registry.roots.some(root => root.day_utc !== DAY));

  const canonical = await readCanonicalGraph(read);
  assert.equal(canonical.size, registry.roots.length, "Canonical and latest scope totals differ");
  const verifiedAdditions = [];
  let omittedKey;
  for (const root of registry.roots) {
    const key = buildHistoryV2PollutantManifestKey(prefix, root.day_utc, root.connector_id, root.pollutant_code);
    const scope = canonical.get(key);
    assert(scope, `Latest scope lacks canonical authority: ${key}`);
    const firstLeaf = await readScopedGraph(read, root, key, scope.manifest);
    if (isSelected(root)) {
      const rebuilt = await verifyObservationHistoryV3UnlistedScope({ getObject: ({ key }) => read(key),
        observationsPrefix: prefix, indexRoot: index, scope: root, descriptor: scope.descriptor });
      assert.deepEqual(scopedRootDescriptor(rebuilt.artifact), root);
      verifiedAdditions.push(rebuilt.artifact);
      omittedKey ??= firstLeaf;
    }
  }
  const predecessor = updateObservationHistoryExactLeafIndexV3Latest({ existingLatest: registry.artifact, removedScopes: additions });
  const retained = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: predecessor });
  assert.deepEqual(retained.roots, registry.roots.filter(root => !isSelected(root)));
  assert(retained.roots.length === 10 && predecessor.payload.total_rows === 26822 && omittedKey);
  const restored = updateObservationHistoryExactLeafIndexV3Latest({ existingLatest: predecessor, replacementScopedManifests: verifiedAdditions });
  assert(original.body.equals(Buffer.from(restored.body)), "Rebuilt restored latest differs from the original bytes");
  for (const key of [GENERATION.observations_root_key, LATEST]) {
    assertExactObject(await getObject(key), objectIdentity(objects.get(key)));
  }
  objects.delete(LATEST);
  return { objects, original, originalTotals: { scopes: registry.roots.length, rows: registry.artifact.payload.total_rows },
    predecessor, additions, omittedKey,
    backupKey: `_ops/observation-history/latest-recovery/${predecessor.sha256}.json` };
}
