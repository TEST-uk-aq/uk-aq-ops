import { Buffer } from "node:buffer";

import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

const DEFAULT_V3_INDEX_ROOT = "history/_index_v3/observations_timeseries";
const DEFAULT_V3_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";

export const OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_KIND =
  "uk_aq_observation_history_v3_rebuild_rollback_snapshot";
export const OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_SCHEMA_VERSION = 1;

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
    );
  }
  return value;
}

function stableMigrationJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function exactDescriptor(raw, field) {
  const descriptor = {
    key: requiredText(raw?.key, `${field}.key`),
    byte_size: Number(raw?.byte_size),
    sha256: String(raw?.sha256 || "").trim().toLowerCase(),
  };
  if (!Number.isSafeInteger(descriptor.byte_size) || descriptor.byte_size <= 0) {
    throw new Error(`${field}.byte_size must be a positive safe integer`);
  }
  if (!/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
    throw new Error(`${field}.sha256 must be an exact SHA-256`);
  }
  return Object.freeze(descriptor);
}

function objectIdentity(key, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Object.freeze({
    key,
    byte_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  });
}

function parseJson(key, body) {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (error) {
    throw new Error(`v3 rollback snapshot dependency is invalid JSON: ${key}`, {
      cause: error,
    });
  }
}

function snapshotRoot(migrationRunId) {
  const runId = requiredText(migrationRunId, "migrationRunId");
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("migrationRunId is unsafe for the snapshot storage key");
  }
  return `_ops/migrations/observation_history_index_v3/${runId}/v3-rebuild-rollback`;
}

function backupObjectKey(root, sourceKey) {
  return `${root}/objects/${sourceKey}`;
}

async function requiredObject(getObject, descriptor, source) {
  const result = await getObject({ key: descriptor.key });
  if (!result || result.exists === false || result.body === null || result.body === undefined) {
    throw new Error(`${source} object is missing: ${descriptor.key}`);
  }
  const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
  const identity = objectIdentity(descriptor.key, body);
  if (
    identity.byte_size !== descriptor.byte_size ||
    identity.sha256 !== descriptor.sha256
  ) {
    throw new Error(`${source} object identity mismatch: ${descriptor.key}`);
  }
  return Object.freeze({ ...identity, body });
}

async function authoritativeV3Closure({ getR2Object, latestKey, indexRoot }) {
  const latestResult = await getR2Object({ key: latestKey });
  if (!latestResult || latestResult.exists === false || latestResult.body == null) {
    throw new Error(`Authoritative v3 latest object is missing: ${latestKey}`);
  }
  const latestBody = Buffer.isBuffer(latestResult.body)
    ? latestResult.body
    : Buffer.from(latestResult.body);
  const latest = parseJson(latestKey, latestBody);
  if (
    latest?.kind !== "observation_timeseries_latest_global" ||
    latest?.index_generation !== "v3" ||
    latest?.history_version !== "v2" ||
    latest?.index_root !== indexRoot ||
    latest?.key_layout?.latest_key !== latestKey ||
    !Array.isArray(latest?.day_summaries) ||
    latest.day_summaries.length === 0
  ) {
    throw new Error("Authoritative v3 latest object is invalid or contradictory");
  }
  const objects = new Map();
  objects.set(latestKey, Object.freeze({
    ...objectIdentity(latestKey, latestBody),
    stage: "latest_global",
    body: latestBody,
  }));
  const add = async (raw, field, stage) => {
    const descriptor = exactDescriptor(raw, field);
    if (!descriptor.key.startsWith(`${indexRoot}/`)) {
      throw new Error(`${field} escapes the authoritative v3 index root`);
    }
    const existing = objects.get(descriptor.key);
    if (existing) {
      if (
        existing.byte_size !== descriptor.byte_size ||
        existing.sha256 !== descriptor.sha256
      ) throw new Error(`Contradictory v3 dependency identity: ${descriptor.key}`);
      return existing;
    }
    const object = await requiredObject(getR2Object, descriptor, "Authoritative v3");
    const entry = Object.freeze({ ...object, stage });
    objects.set(entry.key, entry);
    return entry;
  };
  const roots = latest.day_summaries.flatMap((day) =>
    Array.isArray(day?.scoped_roots) ? day.scoped_roots : []
  );
  if (roots.length === 0) throw new Error("Authoritative v3 latest has no scoped roots");
  for (const root of roots) {
    const scopedObject = await add(root, "scoped_root", "scoped_manifest");
    const scoped = parseJson(scopedObject.key, scopedObject.body);
    if (
      scoped?.kind !== "observation_timeseries_physical_leaf_scoped_manifest" ||
      scoped?.key !== scopedObject.key ||
      !scoped?.leaves_by_timeseries_id
    ) throw new Error(`Authoritative v3 scoped manifest is invalid: ${scopedObject.key}`);
    const alignedManifestObject = await add(
      scoped.source_aligned_scoped_manifest,
      "source_aligned_scoped_manifest",
      "aligned_manifest",
    );
    const alignedManifest = parseJson(
      alignedManifestObject.key,
      alignedManifestObject.body,
    );
    if (
      alignedManifest?.kind !== "observation_timeseries_aligned_source_manifest" ||
      alignedManifest?.key !== alignedManifestObject.key ||
      !Array.isArray(alignedManifest.children)
    ) throw new Error(`Authoritative aligned manifest is invalid: ${alignedManifestObject.key}`);
    const alignedChildren = new Map(alignedManifest.children.map((child) => {
      const descriptor = exactDescriptor(child, "aligned_manifest.children");
      return [descriptor.key, descriptor];
    }));
    for (const [timeseriesId, tuple] of Object.entries(scoped.leaves_by_timeseries_id)) {
      if (!Array.isArray(tuple) || tuple.length !== 3) {
        throw new Error(`Exact-leaf descriptor is invalid: ${scopedObject.key}/${timeseriesId}`);
      }
      const leafObject = await add({
        key: tuple[0],
        byte_size: tuple[1],
        sha256: tuple[2],
      }, `exact_leaf.${timeseriesId}`, "exact_leaf");
      const leaf = parseJson(leafObject.key, leafObject.body);
      if (
        leaf?.kind !== "observation_timeseries_physical_leaf" ||
        leaf?.key !== leafObject.key ||
        String(leaf?.timeseries_id) !== timeseriesId
      ) throw new Error(`Authoritative exact leaf is invalid: ${leafObject.key}`);
      const sourceChild = exactDescriptor(
        leaf.source_aligned_child,
        "source_aligned_child",
      );
      const alignedChild = alignedChildren.get(sourceChild.key);
      if (
        !alignedChild ||
        alignedChild.byte_size !== sourceChild.byte_size ||
        alignedChild.sha256 !== sourceChild.sha256
      ) throw new Error(`Exact leaf cites an unpinned aligned child: ${leafObject.key}`);
      await add(leaf.source_aligned_child, "source_aligned_child", "aligned_child");
    }
    for (const child of alignedManifest.children) {
      const alignedChildObject = await add(
        child,
        "aligned_manifest.children",
        "aligned_child",
      );
      const alignedChild = parseJson(alignedChildObject.key, alignedChildObject.body);
      if (
        alignedChild?.kind !== "observation_timeseries_aligned_source_shard" ||
        alignedChild?.key !== alignedChildObject.key
      ) throw new Error(`Authoritative aligned child is invalid: ${alignedChildObject.key}`);
    }
  }
  const stageRank = {
    aligned_child: 10,
    aligned_manifest: 20,
    exact_leaf: 30,
    scoped_manifest: 40,
    latest_global: 50,
  };
  return Object.freeze([...objects.values()].sort((left, right) =>
    stageRank[left.stage] - stageRank[right.stage] ||
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
  ));
}

function snapshotPayload({ migrationRunId, environment, bucket, canonicalRoot, objects }) {
  return {
    transition: {
      kind: "v3-rebuild",
      source_index_generation: "v3",
      target_index_generation: "v3",
    },
    environment: requiredText(environment, "environment").toUpperCase(),
    bucket: requiredText(bucket, "bucket"),
    migration_run_id: requiredText(migrationRunId, "migrationRunId"),
    canonical_pre_state: exactDescriptor(canonicalRoot, "canonicalRoot"),
    latest_key: DEFAULT_V3_LATEST_KEY,
    index_root: DEFAULT_V3_INDEX_ROOT,
    object_count: objects.length,
    total_bytes: objects.reduce((sum, entry) => sum + entry.byte_size, 0),
    objects: objects.map(({ key, byte_size, sha256, stage }) => ({
      key,
      byte_size,
      sha256,
      stage,
    })),
  };
}

export async function createObservationHistoryV3RebuildRollbackSnapshot({
  getR2Object,
  putBackupObject,
  getBackupObject,
  migrationRunId,
  environment,
  bucket,
  canonicalRoot,
}) {
  for (const [name, adapter] of Object.entries({
    getR2Object,
    putBackupObject,
    getBackupObject,
  })) {
    if (typeof adapter !== "function") throw new TypeError(`${name} adapter is required`);
  }
  const root = snapshotRoot(migrationRunId);
  const objects = await authoritativeV3Closure({
    getR2Object,
    latestKey: DEFAULT_V3_LATEST_KEY,
    indexRoot: DEFAULT_V3_INDEX_ROOT,
  });
  for (const object of objects) {
    const key = backupObjectKey(root, object.key);
    await putBackupObject({ key, body: object.body });
    const current = await getBackupObject({ key });
    const identity = objectIdentity(key, current?.body || Buffer.alloc(0));
    if (
      current?.exists === false ||
      identity.byte_size !== object.byte_size ||
      identity.sha256 !== object.sha256
    ) throw new Error(`v3 rollback snapshot readback failed: ${object.key}`);
  }
  const payload = snapshotPayload({
    migrationRunId,
    environment,
    bucket,
    canonicalRoot,
    objects,
  });
  const envelope = {
    schema_version: OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_SCHEMA_VERSION,
    kind: OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_KIND,
    snapshot_root_sha256: sha256Hex(stableMigrationJson(payload)),
    payload,
  };
  const inventoryKey = `${root}/inventory.json`;
  await putBackupObject({ key: inventoryKey, body: Buffer.from(stableMigrationJson(envelope)) });
  const verified = await verifyObservationHistoryV3RebuildRollbackSnapshot({
    getBackupObject,
    getR2Object,
    migrationRunId,
    environment,
    bucket,
    canonicalRoot,
    expectedSnapshotRootSha256: envelope.snapshot_root_sha256,
  });
  return Object.freeze({ ...verified, inventory_key: inventoryKey });
}

export async function verifyObservationHistoryV3RebuildRollbackSnapshot({
  getBackupObject,
  getR2Object = null,
  migrationRunId,
  environment,
  bucket,
  canonicalRoot,
  expectedSnapshotRootSha256,
}) {
  const root = snapshotRoot(migrationRunId);
  const inventoryKey = `${root}/inventory.json`;
  const inventory = await getBackupObject({ key: inventoryKey });
  if (!inventory || inventory.exists === false || inventory.body == null) {
    throw new Error(`v3 rebuild rollback snapshot inventory is missing: ${inventoryKey}`);
  }
  const envelope = parseJson(inventoryKey, inventory.body);
  if (
    envelope?.schema_version !== OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_SCHEMA_VERSION ||
    envelope?.kind !== OBSERVATION_HISTORY_V3_REBUILD_SNAPSHOT_KIND ||
    envelope?.snapshot_root_sha256 !== sha256Hex(stableMigrationJson(envelope?.payload)) ||
    envelope?.snapshot_root_sha256 !== String(expectedSnapshotRootSha256 || "").toLowerCase()
  ) throw new Error("v3 rebuild rollback snapshot root identity is invalid");
  const expectedPayload = snapshotPayload({
    migrationRunId,
    environment,
    bucket,
    canonicalRoot,
    objects: (envelope.payload?.objects || []).map((entry) => ({ ...entry })),
  });
  if (stableMigrationJson(envelope.payload) !== stableMigrationJson(expectedPayload)) {
    throw new Error("v3 rebuild rollback snapshot authority does not match this migration");
  }
  if (getR2Object) {
    await requiredObject(
      getR2Object,
      envelope.payload.canonical_pre_state,
      "current canonical pre-state",
    );
  }
  const objects = [];
  for (const raw of envelope.payload.objects) {
    const descriptor = { ...exactDescriptor(raw, "snapshot.objects"), stage: raw.stage };
    const key = backupObjectKey(root, descriptor.key);
    const object = await requiredObject(
      getBackupObject,
      { key, byte_size: descriptor.byte_size, sha256: descriptor.sha256 },
      "v3 rebuild rollback snapshot",
    );
    if (getR2Object) {
      await requiredObject(
        getR2Object,
        descriptor,
        "current authoritative v3 pre-state",
      );
    }
    objects.push(Object.freeze({ ...descriptor, backup_key: key, body: object.body }));
  }
  return Object.freeze({
    verified: true,
    snapshot_root_sha256: envelope.snapshot_root_sha256,
    inventory_key: inventoryKey,
    inventory_identity: objectIdentity(inventoryKey, inventory.body),
    canonical_pre_state: envelope.payload.canonical_pre_state,
    object_count: objects.length,
    total_bytes: envelope.payload.total_bytes,
    objects: Object.freeze(objects),
  });
}
