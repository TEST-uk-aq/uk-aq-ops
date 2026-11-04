/** Admission for the schema-1 graph executed by generic fixed-v3 APPLY. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalDependencyIdentities,
  validateExternalDependencyRoot,
} from "../uk_aq_apply_integrity_proposal.mjs";
import { classifyObservationHistoryIntegrityKey } from "./observation_history_integrity_key_allowlist.mjs";
import {
  scopedRootDescriptor,
  validateObservationHistoryExactLeafScopedManifestArtifactV3,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
  latestArtifactFromRoots,
} from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";

const ROOT = "history/_index_v3/observations_timeseries";
const LATEST = "history/_index_v3/observations_timeseries_latest.json";
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopeId = (scope) => `${scope.day_utc}|${scope.connector_id}|${scope.pollutant_code}`;
const selectorKey = (scope) => `${ROOT}/day_utc=${scope.day_utc}`
  + `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}/manifest.json`;
function reject(key, reason) {
  throw new Error(`Generic fixed-v3 selected-format admission rejected: ${key}: ${reason}`);
}

function authenticatedJson(object, kind, publicationStage) {
  const body = object.body;
  if (!Buffer.isBuffer(body) || body.byteLength !== Number(object.entry.bytes)
      || sha256(body) !== object.entry.sha256) reject(object.key, "frozen body identity changed");
  let payload;
  try { payload = JSON.parse(body.toString("utf8")); }
  catch { reject(object.key, "invalid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    reject(object.key, "invalid object shape");
  }
  return { key: object.key, body: body.toString("utf8"), payload,
    byte_size: body.byteLength, sha256: object.entry.sha256, kind,
    publication_stage: publicationStage };
}

function schema1(artifact, scope, kind) {
  const p = artifact.payload;
  if (p.schema_version !== 1 || p.kind !== kind
      || p.exact_leaf_index_version !== "exact-timeseries-leaf-v1"
      || p.index_generation !== "v3" || p.history_version !== "v2"
      || p.domain !== "observations" || p.key !== artifact.key
      || p.physical_layout_version !== "timeseries-aligned-v2" || p.aligned_row_cap !== 1024
      || p.history_schema_version !== 3 || p.writer_version !== "parquet-wasm-zstd-v3"
      || ["day_utc", "connector_id", "pollutant_code"].some((f) => p[f] !== scope[f])
      || Object.hasOwn(p, "exact_index_schema_version") || Object.hasOwn(p, "exact_index_kind")) {
    reject(artifact.key, "schema-2 or unknown/contradictory schema-1 format or scope");
  }
}

function registryRoots(artifact) {
  if (Array.isArray(artifact.payload.day_summaries) && !artifact.payload.day_summaries.length) {
    if (artifact.body !== latestArtifactFromRoots([], ROOT, LATEST).body) {
      reject(artifact.key, "empty latest registry is contradictory");
    }
    return [];
  }
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact }).roots;
}

export function validateGenericV3SelectedFormats({ runState, proposal, authority }) {
  const objects = new Map(proposal.objects.map((object) => [object.key, object]));
  const affected = new Map([
    ...authority.selected_scopes.filter((s) => s.outcome !== "source_artifact_unavailable_preserved"),
    ...authority.metadata_only_scopes,
  ].map((s) => [scopeId(s), s]));
  for (const object of proposal.objects) {
    const match = object.key.match(/^history\/v3\/observations\/day_utc=([^/]+)\/connector_id=([^/]+)\/pollutant_code=([^/]+)\//);
    if (match && !affected.has(`${match[1]}|${match[2]}|${match[3]}`)) {
      reject(object.key, "canonical mutation has no affected-scope authority");
    }
  }
  const derived = proposal.objects.filter((o) => o.key.startsWith(`${ROOT}/`));
  if (!affected.size && !derived.length && !objects.has(LATEST)) return;

  // Check every staged selector first, including selectors outside declared scope.
  // These are the buffers that PUT consumes; staged paths are never reloaded here.
  const selectors = new Map();
  for (const object of derived) {
    const scope = classifyObservationHistoryIntegrityKey(object.key);
    if (scope?.kind !== "observation_scoped_index") continue;
    const artifact = authenticatedJson(object,
      "observation_history_index_v3_exact_leaf_scoped_manifest", "scoped_manifest");
    schema1(artifact, scope, "observation_timeseries_physical_leaf_scoped_manifest");
    if (Object.hasOwn(artifact.payload, "canonical_source_manifest")) {
      reject(object.key, "schema-1 selector has direct-canonical schema-2 authority");
    }
    if (!affected.has(scopeId(scope))) reject(object.key, "selector has no affected-scope authority");
    selectors.set(object.key, artifact);
  }

  // A compact descriptor is preservation evidence only when its complete original
  // registry is authenticated by the accepted checkpoint. No live R2 discovery.
  const expected = runState.dropbox_currentness?.checkpoint?.observations_timeseries_latest;
  if (runState.dropbox_currentness?.allowed !== true || expected?.key !== LATEST) {
    reject(LATEST, "affected selection has no authenticated checkpoint registry");
  }
  const baselineBody = fs.readFileSync(path.join(runState.base_dropbox_root, ...LATEST.split("/")));
  const baseline = authenticatedJson({ key: LATEST, body: baselineBody,
    entry: { bytes: expected.byte_size, sha256: expected.sha256 } },
  "observation_history_index_v3_latest_global", "latest_global");
  const priorRoots = registryRoots(baseline);
  const priorByScope = new Map(priorRoots.map((r) => [scopeId(r), r]));
  for (const [id, scope] of affected) {
    if (priorByScope.get(id)?.exact_index_schema_version === 2) {
      reject(selectorKey(scope), "affected prior schema-2 selection is unsupported");
    }
  }

  const visited = new Set();
  const externalObjects = new WeakSet();
  const identitiesByObject = new WeakMap();
  const resolvedBodies = new Map();
  const checkpointObject = { key: LATEST, body: baselineBody, entry: { source: "dropbox" } };
  externalObjects.add(checkpointObject);
  // Resolve only explicit frozen edges, preserving legitimate external bodies.
  function dependency(parent, ref) {
    if (!ref || typeof ref.key !== "string" || !Number.isSafeInteger(ref.byte_size)
        || ref.byte_size <= 0 || !/^[a-f0-9]{64}$/.test(ref.sha256 || "")) {
      reject(parent.key, "missing or malformed body dependency");
    }
    if (!identitiesByObject.has(parent)) {
      identitiesByObject.set(parent, new Map(canonicalDependencyIdentities(parent.entry).map((d) => [d.key, d])));
    }
    const declared = identitiesByObject.get(parent).get(ref.key);
    const pinned = parent.entry.pinned_baseline_references?.[ref.key];
    const identity = declared || (pinned?.source === "pinned_dropbox_canonical_baseline"
      ? { ...pinned, source: "dropbox" } : externalObjects.has(parent)
        ? { bytes: ref.byte_size, sha256: ref.sha256,
          source: objects.has(ref.key) ? "planned_overlay" : parent.entry.source } : null);
    if (!identity || identity.bytes !== ref.byte_size || identity.sha256 !== ref.sha256) {
      reject(parent.key, `body/dependency contradiction: ${ref.key}`);
    }
    // This synchronous validation does not modify proposal bodies. Reuse only an
    // exact key/source/size/SHA result within this invocation, never across runs.
    const cacheKey = `${ref.key}|${identity.source}|${ref.byte_size}|${ref.sha256}`;
    if (resolvedBodies.has(cacheKey)) return resolvedBodies.get(cacheKey);
    let object = objects.get(ref.key);
    if (object) {
      if (identity.source !== "planned_overlay") reject(parent.key, `staged dependency provenance: ${ref.key}`);
    } else {
      let external;
      try {
        external = validateExternalDependencyRoot({ runState, objectKey: parent.key,
          dependencyKey: ref.key, identity });
      } catch (error) { reject(parent.key, error.message); }
      object = { key: ref.key, body: fs.readFileSync(external.local_path), entry: identity };
      externalObjects.add(object);
    }
    if (object.body.byteLength !== ref.byte_size || sha256(object.body) !== ref.sha256) {
      reject(parent.key, `dependency bytes changed: ${ref.key}`);
    }
    visited.add(ref.key);
    resolvedBodies.set(cacheKey, object);
    return object;
  }

  const descriptors = new Map();
  for (const [id, scope] of affected) {
    const key = selectorKey(scope);
    if (scope.outcome === "authoritative_no_data_replacement") {
      if (selectors.has(key)) reject(key, "empty scope still selects a manifest");
      continue;
    }
    let artifact = selectors.get(key), object = objects.get(key);
    if (!artifact && priorByScope.has(id)) {
      // An unchanged selector may remain external. Its actual pinned body must
      // close over the final graph; the registry alone cannot supply leaf bytes.
      object = dependency(checkpointObject, priorByScope.get(id));
      artifact = authenticatedJson(object,
        "observation_history_index_v3_exact_leaf_scoped_manifest", "scoped_manifest");
      schema1(artifact, scope, "observation_timeseries_physical_leaf_scoped_manifest");
      if (Object.hasOwn(artifact.payload, "canonical_source_manifest")) {
        reject(key, "schema-1 selector has direct-canonical schema-2 authority");
      }
    }
    if (!artifact) reject(key, "affected scope has no authenticated compatible selector");
    const p = artifact.payload;
    if (!same(p.leaf_descriptor_fields, ["key", "byte_size", "sha256"])) {
      reject(key, "unsupported leaf descriptor format");
    }
    const tuples = p.leaves_by_timeseries_id;
    if (!tuples || typeof tuples !== "object" || Array.isArray(tuples) || !Object.keys(tuples).length) {
      reject(key, "selector-only or incomplete leaf graph");
    }
    const alignedKey = key.replace(`${ROOT}/`, `${ROOT}/_aligned/`);
    if (p.source_aligned_scoped_manifest?.key !== alignedKey) reject(key, "missing compatible aligned scope");
    const alignedObject = dependency(object, p.source_aligned_scoped_manifest);
    const aligned = authenticatedJson(alignedObject);
    schema1(aligned, scope, "observation_timeseries_aligned_source_manifest");
    const canonicalKey = `history/v3/observations/day_utc=${scope.day_utc}`
      + `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}/manifest.json`;
    if (aligned.payload.canonical_source_manifest?.key !== canonicalKey) reject(key, "canonical scope contradiction");
    const canonical = authenticatedJson(dependency(alignedObject, aligned.payload.canonical_source_manifest));
    if (canonical.payload.manifest_hash !== aligned.payload.canonical_source_manifest.manifest_hash) {
      reject(key, "canonical manifest identity contradiction");
    }
    const shards = new Map();
    if (!Array.isArray(aligned.payload.children) || !aligned.payload.children.length) reject(key, "incomplete aligned graph");
    for (const ref of aligned.payload.children) {
      const child = dependency(alignedObject, ref), shard = authenticatedJson(child);
      schema1(shard, scope, "observation_timeseries_aligned_source_shard");
      if (!same(shard.payload.canonical_source_manifest, aligned.payload.canonical_source_manifest)) {
        reject(child.key, "aligned canonical authority contradiction");
      }
      dependency(child, shard.payload.canonical_source_manifest);
      for (const file of shard.payload.files || []) dependency(child, file);
      shards.set(child.key, shard);
    }
    const leaves = Object.entries(tuples).map(([timeseriesId, tuple]) => {
      if (!Array.isArray(tuple) || tuple.length !== 3
          || !/^[1-9]\d*$/.test(timeseriesId)
          || tuple[0] !== `${key.slice(0, -"manifest.json".length)}timeseries_id=${timeseriesId.padStart(9, "0")}.json`) {
        reject(key, "unsupported leaf identity");
      }
      const child = dependency(object, { key: tuple[0], byte_size: tuple[1], sha256: tuple[2] });
      const leaf = authenticatedJson(child, "observation_history_index_v3_exact_leaf", "child_shard");
      schema1(leaf, scope, "observation_timeseries_physical_leaf");
      if (leaf.payload.timeseries_id !== Number(timeseriesId)
          || Object.hasOwn(leaf.payload, "canonical_source_manifest")) reject(child.key, "leaf identity contradiction");
      const shard = shards.get(leaf.payload.source_aligned_child?.key);
      if (!shard || shard.sha256 !== leaf.payload.source_aligned_child.sha256
          || shard.byte_size !== leaf.payload.source_aligned_child.byte_size) reject(child.key, "leaf/aligned dependency contradiction");
      dependency(child, leaf.payload.source_aligned_child);
      for (const file of leaf.payload.files || []) dependency(child, file);
      return leaf;
    });
    validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact, exactLeaves: leaves });
    const c = p.coverage;
    if (!c || c.timeseries_count !== leaves.length || c.physical_leaf_count !== leaves.length
        || c.physical_file_count !== new Set(leaves.flatMap((l) => l.payload.files.map((f) => f.key))).size
        || c.row_count !== leaves.reduce((sum, l) => sum + l.payload.row_count, 0)
        || c.row_count !== canonical.payload.row_count
        || c.min_observed_at_utc !== leaves.map((l) => l.payload.min_observed_at_utc).sort()[0]
        || c.max_observed_at_utc !== leaves.map((l) => l.payload.max_observed_at_utc).sort().at(-1)) {
      reject(key, "selector/leaf coverage contradiction");
    }
    visited.add(key);
    descriptors.set(id, scopedRootDescriptor(artifact));
  }
  for (const object of derived) {
    if (!visited.has(object.key)) reject(object.key, "derived mutation outside complete affected graph");
  }

  const latestObject = objects.get(LATEST);
  const latest = latestObject ? authenticatedJson(latestObject,
    "observation_history_index_v3_latest_global", "latest_global") : baseline;
  const roots = registryRoots(latest);
  const finalByScope = new Map(roots.map((r) => [scopeId(r), r]));
  const preservedParents = new WeakMap();
  function requirePreservedCanonicalSelection(root) {
    const base = "history/v3/observations", day = root.day_utc;
    const chain = [
      `${base}/_manifests/manifest.json`,
      `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`,
      `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`,
      `${base}/day_utc=${day}/manifest.json`,
      `${base}/day_utc=${day}/connector_id=${root.connector_id}/manifest.json`,
      `${base}/day_utc=${day}/connector_id=${root.connector_id}/pollutant_code=${root.pollutant_code}/manifest.json`,
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const parent = objects.get(chain[i]);
      if (!parent) continue;
      if (!preservedParents.has(parent)) preservedParents.set(parent, authenticatedJson(parent).payload);
      const payload = preservedParents.get(parent), childKey = chain[i + 1];
      const aliases = i < 3 ? ["children"] : i === 3
        ? ["connector_manifests", "child_manifests"] : ["pollutant_manifests", "child_manifests"];
      const field = i < 2 ? "content_hash" : "manifest_hash";
      const refs = aliases.filter((alias) => Object.hasOwn(payload, alias)).map((alias) => {
        const matches = Array.isArray(payload[alias])
          ? payload[alias].filter((r) => r.manifest_key === childKey) : [];
        if (matches.length !== 1) reject(parent.key, `preserved schema-2 canonical child omitted: ${childKey}`);
        return matches[0];
      });
      const identity = parent.entry.dependency_identities?.[childKey]
        || parent.entry.pinned_baseline_references?.[childKey];
      if (!refs.length || !identity) reject(parent.key, `ambiguous preserved canonical closure: ${childKey}`);
      const child = authenticatedJson(dependency(parent,
        { key: childKey, byte_size: identity.bytes, sha256: identity.sha256 }));
      if (!/^[a-f0-9]{64}$/.test(child.payload[field] || "")
          || refs.some((ref) => ref[field] !== child.payload[field])) {
        reject(parent.key, `preserved canonical child identity contradiction: ${childKey}`);
      }
    }
  }
  for (const root of roots) {
    const id = scopeId(root), selected = descriptors.get(id);
    if (affected.has(id)) {
      if (!selected || !same(root, selected)) reject(root.key, "latest/selector identity or format contradiction");
      if (objects.has(selected.key)) {
        if (!latestObject) reject(LATEST, "changed selector has no final latest closure");
        dependency(latestObject, selected);
      }
    } else if (!same(root, priorByScope.get(id))) {
      reject(root.key, "unaffected selection changed or lacks pinned preservation authority");
    } else if (root.exact_index_schema_version === 2) {
      requirePreservedCanonicalSelection(root);
    }
  }
  for (const [id, root] of [...priorByScope, ...descriptors]) {
    if (affected.get(id)?.outcome === "authoritative_no_data_replacement") {
      if (finalByScope.has(id)) reject(root.key, "removed scope remains selected");
    } else if (!finalByScope.has(id)) reject(root.key, "selected scope omitted from latest");
  }
}
