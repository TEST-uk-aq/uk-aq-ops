// Test-only frozen sorted-array planner reference from Ops HEAD
// e795431271d7d0b870521d65aeee94f91d92770f. Functions below are exact copies
// of the planner and its local normalisation/hash closure at that commit.
// Do not import archive code or update this reference to follow optimisations.
import { Buffer } from "node:buffer";
import { sha256Hex } from "../../workers/shared/r2_sigv4.mjs";

export const OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT =
  "observation-history-index-v3-publication-v2";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PUBLICATION_STAGE_RANK = Object.freeze({
  canonical_parquet: 10,
  canonical_manifest: 20,
  child_shard: 30,
  scoped_manifest: 40,
  latest_global: 50,
});

function bytewiseCompare(left, right) {
  return Buffer.compare(
    Buffer.from(String(left), "utf8"),
    Buffer.from(String(right), "utf8"),
  );
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(bytewiseCompare)
        .map((key) => [key, canonicalizeJsonValue(value[key])]),
    );
  }
  return value;
}

export function encodeObservationHistoryIndexV3Json(payload) {
  return `${JSON.stringify(canonicalizeJsonValue(payload), null, 2)}\n`;
}

function normalizeKey(raw, fieldName) {
  const value = String(raw || "").trim().replace(/^\/+/, "");
  if (!value || value.endsWith("/")) {
    throw new TypeError(`${fieldName} must be a non-empty object key`);
  }
  return value;
}

function normalizeSha256(raw, fieldName) {
  const value = String(raw || "").trim();
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${fieldName} must be lower-case SHA-256`);
  }
  return value;
}

function positiveSafeInteger(raw, fieldName) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function identityDescriptor({ key, byte_size, sha256, kind = null }) {
  return {
    key: normalizeKey(key, `${kind || "dependency"}.key`),
    byte_size: positiveSafeInteger(
      byte_size,
      `${kind || "dependency"}.byte_size`,
    ),
    sha256: normalizeSha256(sha256, `${kind || "dependency"}.sha256`),
    ...(kind ? { kind } : {}),
  };
}

function normalizePublicationReferences(raw, fieldName) {
  const references = (Array.isArray(raw) ? raw : [])
    .map((reference) => identityDescriptor(reference))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  const keys = new Set();
  for (const reference of references) {
    if (keys.has(reference.key)) {
      throw new Error(`Duplicate publication ${fieldName}: ${reference.key}`);
    }
    keys.add(reference.key);
  }
  return references;
}

function normalizePublicationObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Publication object must be an artifact object");
  }
  const stage = String(raw.publication_stage || "").trim();
  if (!Object.hasOwn(PUBLICATION_STAGE_RANK, stage)) {
    throw new Error(`Unsupported v3 publication stage: ${stage || "unset"}`);
  }
  const key = normalizeKey(raw.key, "publication_object.key");
  const body = Buffer.isBuffer(raw.body)
    ? Buffer.from(raw.body)
    : Buffer.from(String(raw.body ?? ""), "utf8");
  if (body.byteLength === 0) {
    throw new TypeError(`Publication object body is empty: ${key}`);
  }
  const byteSize = positiveSafeInteger(
    raw.byte_size,
    `publication_object.byte_size:${key}`,
  );
  const sha256 = normalizeSha256(
    raw.sha256,
    `publication_object.sha256:${key}`,
  );
  if (body.byteLength !== byteSize || sha256Hex(body) !== sha256) {
    throw new Error(`Publication object identity mismatch: ${key}`);
  }
  const dependencies = normalizePublicationReferences(
    raw.dependencies,
    "dependency",
  );
  const publicationPrerequisites = normalizePublicationReferences(
    raw.publication_prerequisites,
    "prerequisite",
  );
  const dependencyKeys = new Set(dependencies.map((entry) => entry.key));
  for (const prerequisite of publicationPrerequisites) {
    if (dependencyKeys.has(prerequisite.key)) {
      throw new Error(
        `Publication reference cannot be both content dependency and order prerequisite: ${prerequisite.key}`,
      );
    }
  }
  return {
    key,
    body,
    byte_size: byteSize,
    sha256,
    content_type: String(raw.content_type || "application/octet-stream"),
    publication_stage: stage,
    dependencies,
    publication_prerequisites: publicationPrerequisites,
  };
}

function normalizeExternalReference(raw) {
  const identity = identityDescriptor(raw);
  if (raw?.verified !== true || raw?.durable !== true) {
    throw new Error(
      `External v3 reference lacks verified durable evidence: ${identity.key}`,
    );
  }
  return { ...identity, verified: true, durable: true };
}

function scheduleHashInput(plan) {
  return encodeObservationHistoryIndexV3Json({
    contract_version: plan.contract_version,
    tie_breaker: plan.tie_breaker,
    changed_dependency_edge_count: plan.changed_dependency_edge_count,
    changed_content_dependency_edge_count:
      plan.changed_content_dependency_edge_count,
    changed_order_prerequisite_edge_count:
      plan.changed_order_prerequisite_edge_count,
    external_reference_count: plan.external_reference_count,
    external_references: plan.external_references.map((entry) =>
      identityDescriptor(entry)
    ),
    entries: plan.entries.map((entry) => ({
      position: entry.position,
      key: entry.key,
      byte_size: entry.byte_size,
      sha256: entry.sha256,
      publication_stage: entry.publication_stage,
      dependencies: entry.dependencies,
      publication_prerequisites: entry.publication_prerequisites,
      changed_dependencies: entry.changed_dependencies,
      external_dependencies: entry.external_dependencies,
      changed_publication_prerequisites:
        entry.changed_publication_prerequisites,
      external_publication_prerequisites:
        entry.external_publication_prerequisites,
    })),
  });
}

export function buildObservationHistoryIndexV3PublicationPlan({
  objects,
  externalReferences = [],
}) {
  const normalizedObjects = (Array.isArray(objects) ? objects : [])
    .map(normalizePublicationObject);
  if (normalizedObjects.length === 0) {
    throw new Error("V3 publication plan requires changed objects");
  }
  const byKey = new Map();
  for (const object of normalizedObjects) {
    if (byKey.has(object.key)) {
      throw new Error(`Duplicate changed v3 publication key: ${object.key}`);
    }
    byKey.set(object.key, object);
  }
  const externalByKey = new Map();
  for (const raw of externalReferences) {
    const reference = normalizeExternalReference(raw);
    if (externalByKey.has(reference.key) || byKey.has(reference.key)) {
      throw new Error(`Duplicate external v3 reference key: ${reference.key}`);
    }
    externalByKey.set(reference.key, reference);
  }
  const indegree = new Map(normalizedObjects.map((object) => [object.key, 0]));
  const outgoing = new Map(normalizedObjects.map((object) => [object.key, []]));
  let changedContentEdgeCount = 0;
  let changedPrerequisiteEdgeCount = 0;
  for (const object of normalizedObjects) {
    for (const [relationship, references] of [
      ["content dependency", object.dependencies],
      ["order prerequisite", object.publication_prerequisites],
    ]) {
      for (const reference of references) {
        const changedReference = byKey.get(reference.key);
        const externalReference = externalByKey.get(reference.key);
        const resolved = changedReference || externalReference;
        if (!resolved) {
          throw new Error(
            `Missing required v3 publication ${relationship}: ${reference.key} -> ${object.key}`,
          );
        }
        if (
          resolved.byte_size !== reference.byte_size ||
          resolved.sha256 !== reference.sha256
        ) {
          throw new Error(
            `Contradictory v3 publication ${relationship} identity: ${reference.key} -> ${object.key}`,
          );
        }
        if (changedReference) {
          if (
            PUBLICATION_STAGE_RANK[changedReference.publication_stage] >
              PUBLICATION_STAGE_RANK[object.publication_stage]
          ) {
            throw new Error(
              `V3 publication stage conflict: ${reference.key} -> ${object.key}`,
            );
          }
          outgoing.get(reference.key).push(object.key);
          indegree.set(object.key, indegree.get(object.key) + 1);
          if (relationship === "content dependency") {
            changedContentEdgeCount += 1;
          } else {
            changedPrerequisiteEdgeCount += 1;
          }
        }
      }
    }
  }
  const eligible = normalizedObjects
    .filter((object) => indegree.get(object.key) === 0)
    .sort((left, right) =>
      PUBLICATION_STAGE_RANK[left.publication_stage] -
        PUBLICATION_STAGE_RANK[right.publication_stage] ||
      bytewiseCompare(left.key, right.key)
    );
  const ordered = [];
  while (eligible.length) {
    const next = eligible.shift();
    ordered.push(next);
    for (const parentKey of outgoing.get(next.key).sort(bytewiseCompare)) {
      indegree.set(parentKey, indegree.get(parentKey) - 1);
      if (indegree.get(parentKey) === 0) {
        eligible.push(byKey.get(parentKey));
        eligible.sort((left, right) =>
          PUBLICATION_STAGE_RANK[left.publication_stage] -
            PUBLICATION_STAGE_RANK[right.publication_stage] ||
          bytewiseCompare(left.key, right.key)
        );
      }
    }
  }
  if (ordered.length !== normalizedObjects.length) {
    const cycleKeys = normalizedObjects
      .filter((object) => !ordered.includes(object))
      .map((object) => object.key)
      .sort(bytewiseCompare);
    throw new Error(`V3 publication dependency cycle: ${cycleKeys.join(" -> ")}`);
  }
  const entries = ordered.map((object, index) => {
    const changedDependencies = object.dependencies
      .filter((dependency) => byKey.has(dependency.key))
      .map((dependency) => dependency.key);
    const externalDependencyKeys = object.dependencies
      .filter((dependency) => externalByKey.has(dependency.key))
      .map((dependency) => dependency.key);
    const changedPublicationPrerequisites = object.publication_prerequisites
      .filter((prerequisite) => byKey.has(prerequisite.key))
      .map((prerequisite) => prerequisite.key);
    const externalPublicationPrerequisites = object.publication_prerequisites
      .filter((prerequisite) => externalByKey.has(prerequisite.key))
      .map((prerequisite) => prerequisite.key);
    return {
      position: index + 1,
      key: object.key,
      body: object.body,
      byte_size: object.byte_size,
      sha256: object.sha256,
      content_type: object.content_type,
      publication_stage: object.publication_stage,
      dependencies: object.dependencies,
      publication_prerequisites: object.publication_prerequisites,
      changed_dependencies: changedDependencies,
      external_dependencies: externalDependencyKeys,
      changed_publication_prerequisites: changedPublicationPrerequisites,
      external_publication_prerequisites: externalPublicationPrerequisites,
    };
  });
  const plan = {
    contract_version: OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
    tie_breaker: "publication_stage_then_bytewise_utf8_key_among_eligible_nodes",
    changed_dependency_edge_count:
      changedContentEdgeCount + changedPrerequisiteEdgeCount,
    changed_content_dependency_edge_count: changedContentEdgeCount,
    changed_order_prerequisite_edge_count: changedPrerequisiteEdgeCount,
    external_reference_count: externalByKey.size,
    external_references: [...externalByKey.values()].sort((left, right) =>
      bytewiseCompare(left.key, right.key)
    ),
    entries,
  };
  return Object.freeze({
    ...plan,
    schedule_sha256: sha256Hex(scheduleHashInput(plan)),
  });
}
