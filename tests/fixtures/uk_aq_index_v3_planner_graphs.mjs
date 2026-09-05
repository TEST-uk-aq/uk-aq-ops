import { Buffer } from "node:buffer";
import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";

export function plannerObject(key, stage = "child_shard") {
  const body = Buffer.from(JSON.stringify({ key }), "utf8");
  return {
    key, body, byte_size: body.byteLength, sha256: sha256Hex(body),
    publication_stage: stage, dependencies: [], publication_prerequisites: [],
  };
}

export function plannerReference(object) {
  return { key: object.key, byte_size: object.byte_size, sha256: object.sha256 };
}

// Approximate the archive shape: many independent physical leaves behind
// canonical prerequisites, then scoped parents and one global latest object.
export function archivePlannerGraph(objectCount = 76986, scopeCount = 576) {
  const leafCount = objectCount - scopeCount - 1;
  if (!Number.isInteger(leafCount) || leafCount < scopeCount) throw new Error("Graph is too small");
  const scopes = Array.from({ length: scopeCount }, (_, index) => {
    const scope = String(index).padStart(6, "0");
    const canonical = plannerObject(`history/v2/observations/scope=${scope}/manifest.json`, "canonical_manifest");
    const parquet = plannerObject(`history/v2/observations/scope=${scope}/part.parquet`, "canonical_parquet");
    return {
      scope, canonical, parquet,
      parent: plannerObject(`history/_index_v3/observations_timeseries/scope=${scope}/manifest.json`, "scoped_manifest"),
    };
  });
  const leaves = Array.from({ length: leafCount }, (_, index) => {
    const entry = scopes[index % scopeCount];
    const leaf = plannerObject(`history/_index_v3/observations_timeseries/scope=${entry.scope}/timeseries=${String(index).padStart(8, "0")}.json`);
    leaf.dependencies.push(plannerReference(entry.parquet));
    leaf.publication_prerequisites.push(plannerReference(entry.canonical));
    entry.parent.dependencies.push(plannerReference(leaf));
    return leaf;
  });
  const latest = plannerObject("history/_index_v3/observations_timeseries_latest.json", "latest_global");
  latest.dependencies = scopes.map(({ parent }) => plannerReference(parent));
  return {
    objects: [latest, ...scopes.map(({ parent }) => parent).reverse(), ...leaves.reverse()],
    externalReferences: scopes.flatMap(({ canonical, parquet }) => [canonical, parquet].map((entry) => ({
      ...plannerReference(entry), verified: true, durable: true,
    }))),
  };
}
