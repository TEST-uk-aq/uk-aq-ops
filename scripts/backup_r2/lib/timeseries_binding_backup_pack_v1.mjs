import {
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
} from "../../../workers/shared/r2_sigv4.mjs";
import {
  assertSha256,
  normalizeRelativePath,
  sha256Hex,
  stableJson,
} from "./hierarchical_backup_v2.mjs";
import {
  TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
  timeseriesBindingSourceRangeKey,
  timeseriesBindingSourceRootKey,
  validateTimeseriesBindingSourceRangeManifest,
  validateTimeseriesBindingSourceRootManifest,
} from "./timeseries_binding_source_hierarchy_v2.mjs";

export const TIMESERIES_BINDING_BACKUP_PACK_VERSION = "v1";
export const TIMESERIES_BINDING_BACKUP_PACK_KIND =
  "uk_aq_r2_history_timeseries_binding_backup_pack";
export const TIMESERIES_BINDING_BACKUP_PACK_ROOT_KIND =
  "uk_aq_r2_history_timeseries_binding_backup_pack_root";
export const DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX =
  "history/_backup_packs_v1/timeseries_binding";

const PACK_SCHEMA_VERSION = 1;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeTimeseriesId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid timeseries_id: ${value}`);
  }
  return value;
}

function normalizeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeRangeBounds(rangeStart, rangeEnd) {
  const start = normalizeNonNegativeInteger(rangeStart, "range_start");
  const end = normalizeNonNegativeInteger(rangeEnd, "range_end");
  if (
    start % TIMESERIES_BINDING_SOURCE_RANGE_SIZE !== 0
    || end !== start + TIMESERIES_BINDING_SOURCE_RANGE_SIZE - 1
  ) {
    throw new Error(`Invalid timeseries binding backup-pack range ${start}-${end}`);
  }
  return { range_start: start, range_end: end };
}

function normalizePrefixPath(value, label) {
  return normalizeRelativePath(normalizePrefix(value), label);
}

function exactBindingPath(sourcePrefix, timeseriesId) {
  return `${sourcePrefix}/timeseries_id=${timeseriesId}.json`;
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error(`${label} must be bytes`);
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a base64 string`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must use canonical base64 encoding`);
  }
  return decoded;
}

function parseJsonBytes(body, key) {
  try {
    return JSON.parse(toBuffer(body, key).toString("utf8"));
  } catch (error) {
    throw new Error(
      `Invalid JSON at ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function serializeArtifact(payload) {
  const bytes = Buffer.from(stableJson(payload), "utf8");
  return {
    payload,
    bytes,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
  };
}

function normalizeSourceRange(sourceRangeManifest) {
  const sourceRange = validateTimeseriesBindingSourceRangeManifest(sourceRangeManifest);
  if (sourceRange.units.length === 0) {
    throw new Error(
      `Timeseries binding source range ${sourceRange.range_start}-${sourceRange.range_end} is empty`,
    );
  }
  for (const unit of sourceRange.units) {
    const expectedPath = exactBindingPath(sourceRange.source_prefix, unit.timeseries_id);
    if (unit.relative_path !== expectedPath) {
      throw new Error(
        `Timeseries binding source unit path/id mismatch: ${unit.relative_path}`,
      );
    }
  }
  return sourceRange;
}

function normalizePackMember(raw, sourcePrefix) {
  const member = assertObject(raw, "Timeseries binding backup-pack member");
  const timeseriesId = normalizeTimeseriesId(member.timeseries_id);
  const relativePath = normalizeRelativePath(
    member.relative_path,
    "timeseries binding backup-pack member path",
  );
  const expectedPath = exactBindingPath(sourcePrefix, timeseriesId);
  if (relativePath !== expectedPath) {
    throw new Error(
      `Timeseries binding backup-pack member path/id mismatch: ${relativePath}`,
    );
  }
  const size = normalizeNonNegativeInteger(
    member.size,
    `Timeseries binding backup-pack member size for ${timeseriesId}`,
  );
  const sha256 = assertSha256(
    member.sha256,
    `Timeseries binding backup-pack member SHA-256 for ${timeseriesId}`,
  );
  const body = decodeCanonicalBase64(
    member.body_base64,
    `Timeseries binding backup-pack member body for ${timeseriesId}`,
  );
  if (body.byteLength !== size) {
    throw new Error(`Timeseries binding backup-pack member size mismatch: ${timeseriesId}`);
  }
  if (sha256Hex(body) !== sha256) {
    throw new Error(`Timeseries binding backup-pack member SHA-256 mismatch: ${timeseriesId}`);
  }
  return {
    timeseries_id: timeseriesId,
    relative_path: relativePath,
    size,
    sha256,
    body_base64: body.toString("base64"),
  };
}

export function timeseriesBindingBackupPackRootKey(
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
) {
  return `${normalizePrefixPath(packPrefix, "timeseries binding backup-pack prefix")}/root.json`;
}

export function timeseriesBindingBackupPackKey({
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  rangeStart,
  rangeEnd,
  sourceRangeHash,
}) {
  const bounds = normalizeRangeBounds(rangeStart, rangeEnd);
  const sourceRangeIdentity = assertSha256(
    sourceRangeHash,
    "timeseries binding backup-pack source_range_hash",
  );
  return `${normalizePrefixPath(packPrefix, "timeseries binding backup-pack prefix")}/`
    + `${timeseriesBindingSourceRangeKey(bounds.range_start, bounds.range_end)}/`
    + `${sourceRangeIdentity}.pack.json`;
}

export function buildTimeseriesBindingBackupPackV1({
  sourceRangeManifest,
  members,
}) {
  const sourceRange = normalizeSourceRange(sourceRangeManifest);
  if (!Array.isArray(members)) {
    throw new Error("Timeseries binding backup-pack members must be an array");
  }
  const byId = new Map();
  for (const raw of members) {
    const item = assertObject(raw, "Timeseries binding backup-pack source member");
    const timeseriesId = normalizeTimeseriesId(item.timeseries_id);
    if (byId.has(timeseriesId)) {
      throw new Error(`Duplicate timeseries binding backup-pack member ${timeseriesId}`);
    }
    const relativePath = normalizeRelativePath(item.relative_path);
    const expectedPath = exactBindingPath(sourceRange.source_prefix, timeseriesId);
    if (relativePath !== expectedPath) {
      throw new Error(`Timeseries binding backup-pack member path/id mismatch: ${relativePath}`);
    }
    const body = toBuffer(item.body, `Timeseries binding body ${timeseriesId}`);
    byId.set(timeseriesId, {
      timeseries_id: timeseriesId,
      relative_path: relativePath,
      size: body.byteLength,
      sha256: sha256Hex(body),
      body_base64: body.toString("base64"),
    });
  }
  const payload = {
    schema_version: PACK_SCHEMA_VERSION,
    kind: TIMESERIES_BINDING_BACKUP_PACK_KIND,
    backup_pack_version: TIMESERIES_BINDING_BACKUP_PACK_VERSION,
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    range_start: sourceRange.range_start,
    range_end: sourceRange.range_end,
    source_prefix: sourceRange.source_prefix,
    source_range_hash: sourceRange.source_range_hash,
    member_count: members.length,
    members: [...byId.values()].sort((left, right) => (
      left.timeseries_id - right.timeseries_id
    )),
  };
  return validateTimeseriesBindingBackupPackV1(payload, sourceRange);
}

export function validateTimeseriesBindingBackupPackV1(
  raw,
  sourceRangeManifest,
) {
  const pack = assertObject(raw, "Timeseries binding backup pack");
  const sourceRange = normalizeSourceRange(sourceRangeManifest);
  if (
    pack.schema_version !== PACK_SCHEMA_VERSION
    || pack.kind !== TIMESERIES_BINDING_BACKUP_PACK_KIND
    || pack.backup_pack_version !== TIMESERIES_BINDING_BACKUP_PACK_VERSION
    || pack.range_size !== TIMESERIES_BINDING_SOURCE_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding backup-pack identity mismatch");
  }
  const bounds = normalizeRangeBounds(pack.range_start, pack.range_end);
  if (
    bounds.range_start !== sourceRange.range_start
    || bounds.range_end !== sourceRange.range_end
  ) {
    throw new Error("Timeseries binding backup-pack range mismatch");
  }
  const sourcePrefix = normalizeRelativePath(
    pack.source_prefix,
    "timeseries binding backup-pack source prefix",
  );
  if (sourcePrefix !== sourceRange.source_prefix) {
    throw new Error("Timeseries binding backup-pack source_prefix mismatch");
  }
  const sourceRangeHash = assertSha256(
    pack.source_range_hash,
    "timeseries binding backup-pack source_range_hash",
  );
  if (sourceRangeHash !== sourceRange.source_range_hash) {
    throw new Error("Timeseries binding backup-pack source_range_hash mismatch");
  }
  if (!Array.isArray(pack.members)) {
    throw new Error("Timeseries binding backup-pack members must be an array");
  }
  const memberCount = normalizePositiveInteger(
    pack.member_count,
    "Timeseries binding backup-pack member_count",
  );
  if (
    memberCount !== pack.members.length
    || memberCount !== sourceRange.units.length
  ) {
    throw new Error("Timeseries binding backup-pack member_count mismatch");
  }
  const sourceUnitsById = new Map(
    sourceRange.units.map((unit) => [unit.timeseries_id, unit]),
  );
  const seen = new Set();
  const members = pack.members.map((member) => {
    const normalized = normalizePackMember(member, sourcePrefix);
    if (seen.has(normalized.timeseries_id)) {
      throw new Error(
        `Duplicate timeseries binding backup-pack member ${normalized.timeseries_id}`,
      );
    }
    seen.add(normalized.timeseries_id);
    const sourceUnit = sourceUnitsById.get(normalized.timeseries_id);
    if (!sourceUnit) {
      throw new Error(
        `Extra timeseries binding backup-pack member ${normalized.timeseries_id}`,
      );
    }
    if (
      normalized.relative_path !== sourceUnit.relative_path
      || normalized.size !== sourceUnit.size
      || normalized.sha256 !== sourceUnit.sha256
    ) {
      throw new Error(
        `Timeseries binding backup-pack member identity mismatch: ${normalized.timeseries_id}`,
      );
    }
    return normalized;
  });
  for (let index = 1; index < members.length; index += 1) {
    if (members[index - 1].timeseries_id >= members[index].timeseries_id) {
      throw new Error("Timeseries binding backup-pack members are not strictly sorted");
    }
  }
  for (const sourceUnit of sourceRange.units) {
    if (!seen.has(sourceUnit.timeseries_id)) {
      throw new Error(
        `Missing timeseries binding backup-pack member ${sourceUnit.timeseries_id}`,
      );
    }
  }
  return {
    schema_version: PACK_SCHEMA_VERSION,
    kind: TIMESERIES_BINDING_BACKUP_PACK_KIND,
    backup_pack_version: TIMESERIES_BINDING_BACKUP_PACK_VERSION,
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    range_start: sourceRange.range_start,
    range_end: sourceRange.range_end,
    source_prefix: sourcePrefix,
    source_range_hash: sourceRangeHash,
    member_count: memberCount,
    members: members.sort((left, right) => left.timeseries_id - right.timeseries_id),
  };
}

function normalizePackRootRange(raw, packPrefix) {
  const range = assertObject(raw, "Timeseries binding backup-pack root range");
  const bounds = normalizeRangeBounds(range.range_start, range.range_end);
  const sourceRangeHash = assertSha256(
    range.source_range_hash,
    "timeseries binding backup-pack root source_range_hash",
  );
  const packRelativePath = normalizeRelativePath(
    range.pack_relative_path,
    "timeseries binding backup-pack relative path",
  );
  const expectedPath = timeseriesBindingBackupPackKey({
    packPrefix,
    rangeStart: bounds.range_start,
    rangeEnd: bounds.range_end,
    sourceRangeHash,
  });
  if (packRelativePath !== expectedPath) {
    throw new Error(`Timeseries binding backup-pack root path mismatch: ${packRelativePath}`);
  }
  return {
    range_start: bounds.range_start,
    range_end: bounds.range_end,
    source_range_hash: sourceRangeHash,
    pack_relative_path: packRelativePath,
    pack_sha256: assertSha256(
      range.pack_sha256,
      "timeseries binding backup-pack SHA-256",
    ),
    pack_size: normalizePositiveInteger(
      range.pack_size,
      "Timeseries binding backup-pack byte size",
    ),
    member_count: normalizePositiveInteger(
      range.member_count,
      "Timeseries binding backup-pack range member_count",
    ),
  };
}

export function buildTimeseriesBindingBackupPackRootV1({
  sourceRootManifest,
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  ranges,
}) {
  const sourceRoot = validateTimeseriesBindingSourceRootManifest(sourceRootManifest);
  const normalizedPackPrefix = normalizePrefixPath(
    packPrefix,
    "timeseries binding backup-pack prefix",
  );
  if (!Array.isArray(ranges)) {
    throw new Error("Timeseries binding backup-pack root ranges must be an array");
  }
  const normalizedRanges = ranges
    .map((range) => normalizePackRootRange(range, normalizedPackPrefix))
    .sort((left, right) => left.range_start - right.range_start);
  const seen = new Set();
  for (const range of normalizedRanges) {
    if (seen.has(range.range_start)) {
      throw new Error(`Duplicate timeseries binding backup-pack root range ${range.range_start}`);
    }
    seen.add(range.range_start);
  }
  const sourceByStart = new Map(sourceRoot.ranges.map((range) => [range.range_start, range]));
  if (normalizedRanges.length !== sourceRoot.ranges.length) {
    throw new Error("Timeseries binding backup-pack root range_count mismatch");
  }
  for (const range of normalizedRanges) {
    const source = sourceByStart.get(range.range_start);
    if (
      !source
      || range.range_end !== source.range_end
      || range.source_range_hash !== source.source_range_hash
      || range.member_count !== source.unit_count
    ) {
      throw new Error(
        `Timeseries binding backup-pack root/source range mismatch: ${range.range_start}`,
      );
    }
  }
  return {
    schema_version: PACK_SCHEMA_VERSION,
    kind: TIMESERIES_BINDING_BACKUP_PACK_ROOT_KIND,
    backup_pack_version: TIMESERIES_BINDING_BACKUP_PACK_VERSION,
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    source_prefix: sourceRoot.source_prefix,
    source_root_key: timeseriesBindingSourceRootKey(sourceRoot.source_prefix),
    source_root_hash: sourceRoot.source_root_hash,
    range_count: normalizedRanges.length,
    member_count: normalizedRanges.reduce((sum, range) => sum + range.member_count, 0),
    ranges: normalizedRanges,
  };
}

export function validateTimeseriesBindingBackupPackRootV1(
  raw,
  {
    packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
    sourceRootManifest = null,
  } = {},
) {
  const root = assertObject(raw, "Timeseries binding backup-pack root");
  if (
    root.schema_version !== PACK_SCHEMA_VERSION
    || root.kind !== TIMESERIES_BINDING_BACKUP_PACK_ROOT_KIND
    || root.backup_pack_version !== TIMESERIES_BINDING_BACKUP_PACK_VERSION
    || root.range_size !== TIMESERIES_BINDING_SOURCE_RANGE_SIZE
  ) {
    throw new Error("Timeseries binding backup-pack root identity mismatch");
  }
  const sourcePrefix = normalizeRelativePath(
    root.source_prefix,
    "timeseries binding backup-pack root source prefix",
  );
  const sourceRootKey = normalizeRelativePath(
    root.source_root_key,
    "timeseries binding backup-pack source root key",
  );
  if (sourceRootKey !== timeseriesBindingSourceRootKey(sourcePrefix)) {
    throw new Error("Timeseries binding backup-pack source root key mismatch");
  }
  const ranges = Array.isArray(root.ranges)
    ? root.ranges.map((range) => normalizePackRootRange(
      range,
      normalizePrefixPath(packPrefix, "timeseries binding backup-pack prefix"),
    ))
      .sort((left, right) => left.range_start - right.range_start)
    : null;
  if (!ranges) throw new Error("Timeseries binding backup-pack root ranges must be an array");
  const seen = new Set();
  for (const range of ranges) {
    if (seen.has(range.range_start)) {
      throw new Error(`Duplicate timeseries binding backup-pack root range ${range.range_start}`);
    }
    seen.add(range.range_start);
  }
  const rangeCount = normalizeNonNegativeInteger(
    root.range_count,
    "Timeseries binding backup-pack root range_count",
  );
  const memberCount = normalizeNonNegativeInteger(
    root.member_count,
    "Timeseries binding backup-pack root member_count",
  );
  if (rangeCount !== ranges.length) {
    throw new Error("Timeseries binding backup-pack root range_count mismatch");
  }
  if (memberCount !== ranges.reduce((sum, range) => sum + range.member_count, 0)) {
    throw new Error("Timeseries binding backup-pack root member_count mismatch");
  }
  const canonical = {
    schema_version: PACK_SCHEMA_VERSION,
    kind: TIMESERIES_BINDING_BACKUP_PACK_ROOT_KIND,
    backup_pack_version: TIMESERIES_BINDING_BACKUP_PACK_VERSION,
    range_size: TIMESERIES_BINDING_SOURCE_RANGE_SIZE,
    source_prefix: sourcePrefix,
    source_root_key: sourceRootKey,
    source_root_hash: assertSha256(
      root.source_root_hash,
      "timeseries binding backup-pack source_root_hash",
    ),
    range_count: rangeCount,
    member_count: memberCount,
    ranges,
  };
  if (sourceRootManifest) {
    const expected = buildTimeseriesBindingBackupPackRootV1({
      sourceRootManifest,
      packPrefix,
      ranges,
    });
    if (stableJson(expected) !== stableJson(canonical)) {
      throw new Error("Timeseries binding backup-pack root/source identity mismatch");
    }
  }
  return canonical;
}

export function serializeTimeseriesBindingBackupPackV1(pack) {
  return serializeArtifact(pack);
}

export function serializeTimeseriesBindingBackupPackRootV1(root) {
  return serializeArtifact(root);
}

async function readObjectMaybe(r2, key) {
  const head = await r2HeadObject({ r2, key });
  if (!head?.exists) return null;
  const object = await r2GetObject({ r2, key });
  const body = toBuffer(object.body, key);
  if (Number.isSafeInteger(head.bytes) && head.bytes !== body.byteLength) {
    throw new Error(`R2 object size changed while reading: ${key}`);
  }
  if (head.sha256 && head.sha256 !== sha256Hex(body)) {
    throw new Error(`R2 object SHA-256 changed while reading: ${key}`);
  }
  return { head, body };
}

async function readRequiredJson(r2, key) {
  const object = await readObjectMaybe(r2, key);
  if (!object) throw new Error(`Required R2 object is missing: ${key}`);
  return { ...object, payload: parseJsonBytes(object.body, key) };
}

async function readMembers(r2, sourceRange, concurrency) {
  const output = new Array(sourceRange.units.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < sourceRange.units.length) {
      const index = nextIndex;
      nextIndex += 1;
      const unit = sourceRange.units[index];
      const object = await readObjectMaybe(r2, unit.relative_path);
      if (!object) {
        throw new Error(`Timeseries binding source member is missing: ${unit.relative_path}`);
      }
      if (object.body.byteLength !== unit.size) {
        throw new Error(`Timeseries binding source member size mismatch: ${unit.relative_path}`);
      }
      if (sha256Hex(object.body) !== unit.sha256) {
        throw new Error(`Timeseries binding source member SHA-256 mismatch: ${unit.relative_path}`);
      }
      output[index] = {
        timeseries_id: unit.timeseries_id,
        relative_path: unit.relative_path,
        body: object.body,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sourceRange.units.length) }, () => worker()),
  );
  return output;
}

async function verifyPackObject({ r2, key, sourceRange, expectedReference = null }) {
  const object = await readObjectMaybe(r2, key);
  if (!object) return null;
  const payload = validateTimeseriesBindingBackupPackV1(
    parseJsonBytes(object.body, key),
    sourceRange,
  );
  const artifact = serializeTimeseriesBindingBackupPackV1(payload);
  if (!object.body.equals(artifact.bytes)) {
    throw new Error(`Timeseries binding backup pack is not canonical deterministic JSON: ${key}`);
  }
  if (
    expectedReference
    && (
      expectedReference.pack_sha256 !== artifact.sha256
      || expectedReference.pack_size !== artifact.size
      || expectedReference.member_count !== payload.member_count
    )
  ) {
    throw new Error(`Timeseries binding backup-pack root/child identity mismatch: ${key}`);
  }
  return { payload, artifact };
}

async function writeAndVerifyPack({ r2, key, artifact, sourceRange }) {
  await r2PutObject({
    r2,
    key,
    body: artifact.bytes,
    content_type: "application/json; charset=utf-8",
    sha256: artifact.sha256,
  });
  const verified = await verifyPackObject({ r2, key, sourceRange });
  if (
    !verified
    || verified.artifact.sha256 !== artifact.sha256
    || verified.artifact.size !== artifact.size
    || !verified.artifact.bytes.equals(artifact.bytes)
  ) {
    throw new Error(`Timeseries binding backup-pack write verification failed: ${key}`);
  }
}

export async function publishTimeseriesBindingBackupPacksV1({
  r2,
  bindingPrefix = "history/_index_v2/timeseries_binding",
  packPrefix = DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  writeR2 = false,
  readConcurrency = 16,
} = {}) {
  const normalizedBindingPrefix = normalizePrefixPath(
    bindingPrefix,
    "timeseries binding source prefix",
  );
  const normalizedPackPrefix = normalizePrefixPath(
    packPrefix,
    "timeseries binding backup-pack prefix",
  );
  const concurrency = normalizePositiveInteger(
    readConcurrency,
    "Timeseries binding backup-pack read concurrency",
  );
  const sourceRootKey = timeseriesBindingSourceRootKey(normalizedBindingPrefix);
  const sourceRootObject = await readRequiredJson(r2, sourceRootKey);
  const sourceRoot = validateTimeseriesBindingSourceRootManifest(sourceRootObject.payload);
  if (sourceRoot.source_prefix !== normalizedBindingPrefix) {
    throw new Error("Timeseries binding source root prefix mismatch");
  }

  const packRootKey = timeseriesBindingBackupPackRootKey(normalizedPackPrefix);
  const existingPackRootObject = await readObjectMaybe(r2, packRootKey);
  let existingPackRoot = null;
  if (existingPackRootObject) {
    existingPackRoot = validateTimeseriesBindingBackupPackRootV1(
      parseJsonBytes(existingPackRootObject.body, packRootKey),
      { packPrefix: normalizedPackPrefix },
    );
    const existingArtifact = serializeTimeseriesBindingBackupPackRootV1(existingPackRoot);
    if (!existingPackRootObject.body.equals(existingArtifact.bytes)) {
      throw new Error(
        `Timeseries binding backup-pack root is not canonical deterministic JSON: ${packRootKey}`,
      );
    }
  }
  const existingRangeReferences = new Map(
    (existingPackRoot?.ranges || []).map((range) => [range.pack_relative_path, range]),
  );

  const rangeReferences = [];
  const rangeReports = [];
  let rangesReused = 0;
  let rangesRebuilt = 0;
  let rangesWritten = 0;
  let rawBindingBytes = 0;
  let packBytes = 0;

  for (const sourceRangeReference of sourceRoot.ranges) {
    if (sourceRangeReference.unit_count <= 0) {
      throw new Error(
        `Timeseries binding source root references an empty range: ${sourceRangeReference.manifest_key}`,
      );
    }
    const sourceRangeObject = await readRequiredJson(r2, sourceRangeReference.manifest_key);
    const sourceRange = normalizeSourceRange(sourceRangeObject.payload);
    if (
      sourceRange.range_start !== sourceRangeReference.range_start
      || sourceRange.range_end !== sourceRangeReference.range_end
      || sourceRange.source_range_hash !== sourceRangeReference.source_range_hash
      || sourceRange.units.length !== sourceRangeReference.unit_count
    ) {
      throw new Error(
        `Timeseries binding source root/range mismatch: ${sourceRangeReference.manifest_key}`,
      );
    }
    rawBindingBytes += sourceRange.units.reduce((sum, unit) => sum + unit.size, 0);
    const packKey = timeseriesBindingBackupPackKey({
      packPrefix: normalizedPackPrefix,
      rangeStart: sourceRange.range_start,
      rangeEnd: sourceRange.range_end,
      sourceRangeHash: sourceRange.source_range_hash,
    });
    const existingReference = existingRangeReferences.get(packKey) || null;
    let verifiedPack = await verifyPackObject({
      r2,
      key: packKey,
      sourceRange,
      expectedReference: existingReference,
    });
    let action = "reused";
    let written = false;
    if (verifiedPack) {
      rangesReused += 1;
    } else {
      const members = await readMembers(r2, sourceRange, concurrency);
      const payload = buildTimeseriesBindingBackupPackV1({
        sourceRangeManifest: sourceRange,
        members,
      });
      const artifact = serializeTimeseriesBindingBackupPackV1(payload);
      verifiedPack = { payload, artifact };
      action = "rebuilt";
      rangesRebuilt += 1;
      if (writeR2) {
        await writeAndVerifyPack({ r2, key: packKey, artifact, sourceRange });
        written = true;
        rangesWritten += 1;
      }
    }
    packBytes += verifiedPack.artifact.size;
    const reference = {
      range_start: sourceRange.range_start,
      range_end: sourceRange.range_end,
      source_range_hash: sourceRange.source_range_hash,
      pack_relative_path: packKey,
      pack_sha256: verifiedPack.artifact.sha256,
      pack_size: verifiedPack.artifact.size,
      member_count: sourceRange.units.length,
    };
    rangeReferences.push(reference);
    rangeReports.push({ ...reference, action, written });
  }

  const packRoot = buildTimeseriesBindingBackupPackRootV1({
    sourceRootManifest: sourceRoot,
    packPrefix: normalizedPackPrefix,
    ranges: rangeReferences,
  });
  const packRootArtifact = serializeTimeseriesBindingBackupPackRootV1(packRoot);
  const currentSourceRootObject = await readRequiredJson(r2, sourceRootKey);
  const currentSourceRoot = validateTimeseriesBindingSourceRootManifest(
    currentSourceRootObject.payload,
  );
  if (stableJson(currentSourceRoot) !== stableJson(sourceRoot)) {
    throw new Error("Timeseries binding source root changed during backup-pack publication");
  }

  const rootChanged = !existingPackRootObject
    || !existingPackRootObject.body.equals(packRootArtifact.bytes);
  let rootWritten = false;
  if (writeR2 && rootChanged) {
    await r2PutObject({
      r2,
      key: packRootKey,
      body: packRootArtifact.bytes,
      content_type: "application/json; charset=utf-8",
      sha256: packRootArtifact.sha256,
    });
    const verifiedRootObject = await readRequiredJson(r2, packRootKey);
    const verifiedRoot = validateTimeseriesBindingBackupPackRootV1(
      verifiedRootObject.payload,
      { packPrefix: normalizedPackPrefix, sourceRootManifest: sourceRoot },
    );
    const verifiedArtifact = serializeTimeseriesBindingBackupPackRootV1(verifiedRoot);
    if (
      !verifiedRootObject.body.equals(packRootArtifact.bytes)
      || verifiedArtifact.sha256 !== packRootArtifact.sha256
      || verifiedArtifact.size !== packRootArtifact.size
    ) {
      throw new Error(`Timeseries binding backup-pack root verification failed: ${packRootKey}`);
    }
    rootWritten = true;
  }

  return {
    status: writeR2 ? "succeeded" : "planned",
    mode: writeR2 ? "write-r2" : "dry-run",
    source_root_key: sourceRootKey,
    source_root_hash: sourceRoot.source_root_hash,
    pack_root_key: packRootKey,
    pack_root_sha256: packRootArtifact.sha256,
    pack_root_size: packRootArtifact.size,
    pack_root_changed: rootChanged,
    pack_root_written: rootWritten,
    range_count: sourceRoot.ranges.length,
    member_count: sourceRoot.unit_count,
    raw_binding_bytes: rawBindingBytes,
    pack_bytes: packBytes,
    ranges_reused: rangesReused,
    ranges_rebuilt: rangesRebuilt,
    ranges_written: rangesWritten,
    ranges: rangeReports,
  };
}
