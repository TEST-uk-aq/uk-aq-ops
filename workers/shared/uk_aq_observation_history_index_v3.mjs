// @ts-nocheck -- shared deterministic builder is consumed by Node and Deno callers.
import { Buffer } from "node:buffer";

import {
  validateObservationContentHashMetadata,
} from "./uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
import {
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
} from "./uk_aq_observation_history_target_writer.mjs";
import { normalizeObservationPropertyCode } from "./uk_aq_observation_property_code.mjs";
import {
  buildObservationHistoryIndexV3ScopedManifestPayload,
  validateObservationHistoryIndexV3ScopedManifestBody,
} from "./uk_aq_observation_history_scoped_manifest_v3.mjs";
import { sha256Hex } from "./r2_sigv4.mjs";

export const OBSERVATION_HISTORY_INDEX_GENERATION_V3 = "v3";
export const OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3 = 3;
export const OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 = 1000;
export const DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT =
  "history/_index_v3/observations_timeseries";
export const DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";
export const OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT =
  "observation-history-index-v3-publication-v2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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

function normalizePrefix(raw, fieldName) {
  const value = String(raw || "").trim().replace(/^\/+|\/+$/g, "");
  if (!value) throw new TypeError(`${fieldName} must be a non-empty prefix`);
  return value;
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

function nonNegativeSafeInteger(raw, fieldName) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeDay(raw, fieldName = "day_utc") {
  const value = String(raw || "").trim();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !ISO_DAY_PATTERN.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${fieldName} must be a valid ISO UTC day`);
  }
  return value;
}

function normalizeIso(raw, fieldName) {
  const value = String(raw || "").trim();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${fieldName} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeNullableIso(raw, fieldName) {
  return raw === null ? null : normalizeIso(raw, fieldName);
}

function minValue(values) {
  return values.reduce(
    (current, value) => current === null || value < current ? value : current,
    null,
  );
}

function maxValue(values) {
  return values.reduce(
    (current, value) => current === null || value > current ? value : current,
    null,
  );
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sameJson(left, right) {
  return encodeObservationHistoryIndexV3Json(left) ===
    encodeObservationHistoryIndexV3Json(right);
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

// Content dependencies are reflected in payload semantics. Publication
// prerequisites are scheduling-only evidence and never enter body/SHA identity.
function artifactFromPayload({
  kind,
  key,
  payload,
  dependencies,
  publicationPrerequisites = [],
  stage,
}) {
  const body = encodeObservationHistoryIndexV3Json(payload);
  const bodyBuffer = Buffer.from(body, "utf8");
  return Object.freeze({
    kind,
    key,
    payload,
    body,
    byte_size: bodyBuffer.byteLength,
    sha256: sha256Hex(bodyBuffer),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage,
    dependencies: Object.freeze(
      [...dependencies].sort((left, right) => bytewiseCompare(left.key, right.key)),
    ),
    publication_prerequisites: Object.freeze(
      [...publicationPrerequisites].sort((left, right) =>
        bytewiseCompare(left.key, right.key)
      ),
    ),
  });
}

function validateArtifact(artifact, expectedKind, expectedStage) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new TypeError(`${expectedKind} artifact must be an object`);
  }
  if (artifact.kind !== expectedKind) {
    throw new TypeError(`Expected ${expectedKind} artifact`);
  }
  if (artifact.publication_stage !== expectedStage) {
    throw new TypeError(`${expectedKind} publication stage is invalid`);
  }
  const key = normalizeKey(artifact.key, `${expectedKind}.key`);
  const body = String(artifact.body || "");
  if (body !== encodeObservationHistoryIndexV3Json(artifact.payload)) {
    throw new TypeError(`${expectedKind} body is not canonical JSON`);
  }
  const bodyBuffer = Buffer.from(body, "utf8");
  if (
    bodyBuffer.byteLength !== artifact.byte_size ||
    sha256Hex(bodyBuffer) !== artifact.sha256
  ) {
    throw new TypeError(`${expectedKind} artifact identity mismatch`);
  }
  return { ...artifact, key };
}

export function resolveObservationHistoryIndexV3BuildConfig({
  env = typeof process !== "undefined" ? process.env : {},
  requestedIndexGeneration = null,
} = {}) {
  const generation = String(
    requestedIndexGeneration ?? env?.UK_AQ_R2_HISTORY_INDEX_VERSION ?? "",
  );
  if (generation !== OBSERVATION_HISTORY_INDEX_GENERATION_V3) {
    throw new Error(
      `Unsupported observation-history index generation for v3 builder: ${generation || "unset"}`,
    );
  }
  return Object.freeze({
    domain: "observations",
    history_version: "v2",
    index_generation: OBSERVATION_HISTORY_INDEX_GENERATION_V3,
    index_root: DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
    latest_key: DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
    shard_width: OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
  });
}

function normalizeScope(partition) {
  if (!partition || typeof partition !== "object" || Array.isArray(partition)) {
    throw new TypeError("Phase 1 partition metadata must be an object");
  }
  const pollutantCode = normalizeObservationPropertyCode(
    partition.pollutant_code,
  );
  if (!pollutantCode) {
    throw new TypeError("Phase 1 partition pollutant_code is invalid");
  }
  return Object.freeze({
    day_utc: normalizeDay(partition.day_utc),
    connector_id: positiveSafeInteger(
      partition.connector_id,
      "partition.connector_id",
    ),
    pollutant_code: pollutantCode,
  });
}

export function observationHistoryIndexV3RangeForTimeseriesId(timeseriesId) {
  const normalizedId = positiveSafeInteger(timeseriesId, "timeseries_id");
  const rangeStart = Math.floor(
    normalizedId / OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
  ) * OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3;
  return Object.freeze({
    range_start: rangeStart,
    range_end: rangeStart + OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 - 1,
  });
}

function normalizeRangeStart(raw) {
  const value = nonNegativeSafeInteger(raw, "range_start");
  if (value % OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 !== 0) {
    throw new TypeError("range_start is not aligned to the v3 shard width");
  }
  return value;
}

function rangeToken(rangeStart) {
  const rangeEnd = rangeStart + OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 - 1;
  return `${String(rangeStart).padStart(6, "0")}-${String(rangeEnd).padStart(6, "0")}`;
}

function scopePrefix(scope, indexRoot) {
  return `${normalizePrefix(indexRoot, "index_root")}/day_utc=${scope.day_utc}` +
    `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`;
}

export function buildObservationHistoryIndexV3ChildShardKey({
  scope,
  rangeStart,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const normalizedScope = normalizeScope(scope);
  const normalizedRangeStart = normalizeRangeStart(rangeStart);
  return `${scopePrefix(normalizedScope, indexRoot)}/range=${rangeToken(normalizedRangeStart)}.json`;
}

export function buildObservationHistoryIndexV3ScopedManifestKey({
  scope,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  return `${scopePrefix(normalizeScope(scope), indexRoot)}/manifest.json`;
}

function assertSameJson(actual, expected, message) {
  if (!sameJson(actual, expected)) throw new Error(message);
}

function normalizeCanonicalManifestDescriptor(raw, scope) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("canonical_manifest must be an object");
  }
  const descriptor = {
    key: normalizeKey(raw.key, "canonical_manifest.key"),
    byte_size: positiveSafeInteger(
      raw.byte_size,
      "canonical_manifest.byte_size",
    ),
    sha256: normalizeSha256(raw.sha256, "canonical_manifest.sha256"),
    manifest_hash: normalizeSha256(
      raw.manifest_hash,
      "canonical_manifest.manifest_hash",
    ),
    row_count: nonNegativeSafeInteger(
      raw.row_count,
      "canonical_manifest.row_count",
    ),
    observation_content_hash: normalizeSha256(
      raw.observation_content_hash,
      "canonical_manifest.observation_content_hash",
    ),
  };
  const expectedScopeToken =
    `/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
  if (!descriptor.key.endsWith(expectedScopeToken)) {
    throw new Error("Canonical manifest key disagrees with partition scope");
  }
  assertSameJson(
    raw,
    descriptor,
    "Canonical manifest descriptor has unsupported or non-canonical fields",
  );
  return Object.freeze(descriptor);
}

function normalizeCanonicalManifest(raw, scope, metadata) {
  const descriptor = normalizeCanonicalManifestDescriptor(raw, scope);
  if (descriptor.row_count !== metadata.row_count) {
    throw new Error("Canonical manifest row count disagrees with Phase 1 metadata");
  }
  if (
    descriptor.observation_content_hash !== metadata.observation_content_hash
  ) {
    throw new Error(
      "Canonical manifest observation content hash disagrees with Phase 1 metadata",
    );
  }
  return descriptor;
}

function normalizeArtifactDependencies(artifact, allowedKinds) {
  if (!Array.isArray(artifact.dependencies)) {
    throw new TypeError(`${artifact.kind} dependencies must be an array`);
  }
  const dependencies = artifact.dependencies.map((raw) => {
    const kind = String(raw?.kind || "").trim();
    if (!allowedKinds.has(kind)) {
      throw new Error(`${artifact.kind} has unsupported dependency kind`);
    }
    const dependency = identityDescriptor({ ...raw, kind });
    assertSameJson(
      raw,
      dependency,
      `${artifact.kind} dependency has unsupported fields`,
    );
    return dependency;
  }).sort((left, right) => bytewiseCompare(left.key, right.key));
  const keys = new Set();
  for (const dependency of dependencies) {
    if (keys.has(dependency.key)) {
      throw new Error(`${artifact.kind} has duplicate dependency keys`);
    }
    keys.add(dependency.key);
  }
  return dependencies;
}

function assertExactDependencies(artifact, expected, allowedKinds) {
  const actual = normalizeArtifactDependencies(artifact, allowedKinds);
  const normalizedExpected = [...expected]
    .map((entry) => identityDescriptor(entry))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  assertSameJson(
    actual,
    normalizedExpected,
    `${artifact.kind} dependencies do not exactly match semantic references`,
  );
}

function normalizeArtifactPublicationPrerequisites(artifact, allowedKinds) {
  if (!Array.isArray(artifact.publication_prerequisites)) {
    throw new TypeError(
      `${artifact.kind} publication_prerequisites must be an array`,
    );
  }
  const prerequisites = artifact.publication_prerequisites.map((raw) => {
    const kind = String(raw?.kind || "").trim();
    if (!allowedKinds.has(kind)) {
      throw new Error(`${artifact.kind} has unsupported publication prerequisite kind`);
    }
    const prerequisite = identityDescriptor({ ...raw, kind });
    assertSameJson(
      raw,
      prerequisite,
      `${artifact.kind} publication prerequisite has unsupported fields`,
    );
    return prerequisite;
  }).sort((left, right) => bytewiseCompare(left.key, right.key));
  const keys = new Set();
  for (const prerequisite of prerequisites) {
    if (keys.has(prerequisite.key)) {
      throw new Error(`${artifact.kind} has duplicate publication prerequisites`);
    }
    keys.add(prerequisite.key);
  }
  return prerequisites;
}

function assertExactPublicationPrerequisites(
  artifact,
  expected,
  allowedKinds,
) {
  const actual = normalizeArtifactPublicationPrerequisites(
    artifact,
    allowedKinds,
  );
  const normalizedExpected = [...expected]
    .map((entry) => identityDescriptor(entry))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  assertSameJson(
    actual,
    normalizedExpected,
    `${artifact.kind} publication prerequisites do not exactly match ordering evidence`,
  );
}

function baseIndexPayload(kind) {
  return {
    schema_version: OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3,
    kind,
    index_generation: OBSERVATION_HISTORY_INDEX_GENERATION_V3,
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    shard_width: OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
  };
}

function normalizeSegment(raw, file, rowGroupStarts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Phase 1 exact segment must be an object");
  }
  const segment = {
    timeseries_id: positiveSafeInteger(
      raw.timeseries_id,
      "segment.timeseries_id",
    ),
    file_ordinal: nonNegativeSafeInteger(
      raw.file_ordinal,
      "segment.file_ordinal",
    ),
    file_key: normalizeKey(raw.file_key, "segment.file_key"),
    row_group_ordinal: nonNegativeSafeInteger(
      raw.row_group_ordinal,
      "segment.row_group_ordinal",
    ),
    row_start: nonNegativeSafeInteger(raw.row_start, "segment.row_start"),
    row_group_row_start: nonNegativeSafeInteger(
      raw.row_group_row_start,
      "segment.row_group_row_start",
    ),
    row_count: positiveSafeInteger(raw.row_count, "segment.row_count"),
    min_observed_at_utc: normalizeIso(
      raw.min_observed_at_utc,
      "segment.min_observed_at_utc",
    ),
    max_observed_at_utc: normalizeIso(
      raw.max_observed_at_utc,
      "segment.max_observed_at_utc",
    ),
  };
  if (segment.file_ordinal !== file.file_ordinal) {
    throw new Error("Exact segment file ordinal disagrees with its file");
  }
  if (segment.file_key !== file.key) {
    throw new Error("Exact segment file key disagrees with its file");
  }
  for (const [field, expected] of [
    ["file_row_count", file.row_count],
    ["file_byte_size", file.byte_size],
    ["history_schema_version", OBSERVATION_HISTORY_SCHEMA_VERSION_V3],
  ]) {
    if (Number(raw[field]) !== expected) {
      throw new Error(`Exact segment ${field} disagrees with file identity`);
    }
  }
  for (const [field, expected] of [
    ["file_sha256", file.sha256],
    ["writer_version", OBSERVATION_HISTORY_WRITER_VERSION_V3],
    ["physical_layout_version", OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION],
  ]) {
    if (raw[field] !== expected) {
      throw new Error(`Exact segment ${field} disagrees with file identity`);
    }
  }
  if (raw.file_etag !== file.etag) {
    throw new Error("Exact segment file_etag disagrees with file identity");
  }
  if (segment.min_observed_at_utc > segment.max_observed_at_utc) {
    throw new Error("Exact segment observation time bounds regress");
  }
  const rowGroupStart = rowGroupStarts.get(segment.row_group_ordinal);
  if (rowGroupStart === undefined) {
    throw new Error("Exact segment names an impossible row-group ordinal");
  }
  const rowGroup = file.row_groups.find(
    (entry) => entry.row_group_ordinal === segment.row_group_ordinal,
  );
  if (
    segment.row_group_row_start !== segment.row_start - rowGroupStart ||
    segment.row_group_row_start + segment.row_count > rowGroup.row_count ||
    segment.row_start + segment.row_count > file.row_count
  ) {
    throw new Error("Exact segment has impossible row-group/file coordinates");
  }
  return Object.freeze(segment);
}

function segmentSignature(segment) {
  return [
    segment.timeseries_id,
    segment.file_ordinal,
    segment.file_key,
    segment.row_group_ordinal,
    segment.row_start,
    segment.row_group_row_start,
    segment.row_count,
    segment.min_observed_at_utc,
    segment.max_observed_at_utc,
  ].join("\u0000");
}

function compareSegments(left, right) {
  return left.file_ordinal - right.file_ordinal ||
    left.row_start - right.row_start ||
    left.row_group_ordinal - right.row_group_ordinal ||
    left.timeseries_id - right.timeseries_id ||
    bytewiseCompare(left.min_observed_at_utc, right.min_observed_at_utc) ||
    bytewiseCompare(segmentSignature(left), segmentSignature(right));
}

function normalizeFile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Phase 1 file metadata must be an object");
  }
  const file = {
    file_ordinal: nonNegativeSafeInteger(raw.file_ordinal, "file.file_ordinal"),
    key: normalizeKey(raw.key, "file.key"),
    row_count: positiveSafeInteger(raw.row_count, "file.row_count"),
    byte_size: positiveSafeInteger(raw.byte_size, "file.byte_size"),
    sha256: normalizeSha256(raw.sha256, "file.sha256"),
    etag: raw.etag === null || raw.etag === undefined
      ? null
      : String(raw.etag).trim() || null,
    history_schema_version: Number(raw.history_schema_version),
    writer_version: String(raw.writer_version || ""),
    physical_layout_version: String(raw.physical_layout_version || ""),
    row_group_count: positiveSafeInteger(
      raw.row_group_count,
      "file.row_group_count",
    ),
    row_groups: [],
    timeseries_row_counts: raw.timeseries_row_counts,
  };
  if (
    file.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    file.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    file.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION
  ) {
    throw new Error("Unsupported Phase 1 physical file identity");
  }
  const rawGroups = Array.isArray(raw.row_groups) ? raw.row_groups : [];
  if (rawGroups.length !== file.row_group_count) {
    throw new Error("Phase 1 row-group count mismatch");
  }
  const seenOrdinals = new Set();
  file.row_groups = rawGroups.map((rawGroup) => {
    const ordinal = nonNegativeSafeInteger(
      rawGroup?.row_group_ordinal,
      "row_group.row_group_ordinal",
    );
    if (seenOrdinals.has(ordinal)) {
      throw new Error("Duplicate Phase 1 row-group ordinal");
    }
    seenOrdinals.add(ordinal);
    return {
      row_group_ordinal: ordinal,
      row_start: nonNegativeSafeInteger(
        rawGroup?.row_start,
        "row_group.row_start",
      ),
      row_count: positiveSafeInteger(
        rawGroup?.row_count,
        "row_group.row_count",
      ),
      min_timeseries_id: positiveSafeInteger(
        rawGroup?.min_timeseries_id,
        "row_group.min_timeseries_id",
      ),
      max_timeseries_id: positiveSafeInteger(
        rawGroup?.max_timeseries_id,
        "row_group.max_timeseries_id",
      ),
      min_observed_at_utc: normalizeIso(
        rawGroup?.min_observed_at_utc,
        "row_group.min_observed_at_utc",
      ),
      max_observed_at_utc: normalizeIso(
        rawGroup?.max_observed_at_utc,
        "row_group.max_observed_at_utc",
      ),
      raw_segments: Array.isArray(rawGroup?.segments) ? rawGroup.segments : [],
    };
  }).sort((left, right) => left.row_group_ordinal - right.row_group_ordinal);
  let expectedStart = 0;
  for (const [index, rowGroup] of file.row_groups.entries()) {
    if (
      rowGroup.row_group_ordinal !== index ||
      rowGroup.row_start !== expectedStart ||
      rowGroup.min_timeseries_id > rowGroup.max_timeseries_id ||
      rowGroup.min_observed_at_utc > rowGroup.max_observed_at_utc
    ) {
      throw new Error("Phase 1 row-group coordinates or bounds are impossible");
    }
    expectedStart += rowGroup.row_count;
  }
  if (expectedStart !== file.row_count) {
    throw new Error("Phase 1 row-group rows do not reconcile to file rows");
  }
  return file;
}

function normalizeTimeseriesCounts(raw, fieldName) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const counts = new Map();
  for (const [rawId, rawCount] of Object.entries(raw)) {
    const timeseriesId = positiveSafeInteger(rawId, `${fieldName} key`);
    const count = positiveSafeInteger(rawCount, `${fieldName}.${rawId}`);
    if (counts.has(timeseriesId)) {
      throw new Error(`${fieldName} contains duplicate timeseries identity`);
    }
    counts.set(timeseriesId, count);
  }
  return counts;
}

export function validateObservationHistoryTargetMetadataForV3(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Phase 1 target metadata must be an object");
  }
  if (
    metadata.history_version !== "v2" ||
    metadata.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    metadata.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    metadata.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
    !Array.isArray(metadata.columns) ||
    !sameJson(metadata.columns, OBSERVATION_HISTORY_COLUMNS_V3)
  ) {
    throw new Error("Unsupported Phase 1 history/schema/writer/layout identity");
  }
  const scope = normalizeScope(metadata.partition);
  const rowCount = nonNegativeSafeInteger(metadata.row_count, "metadata.row_count");
  validateObservationContentHashMetadata(metadata, { rowCount });
  const files = (Array.isArray(metadata.files) ? metadata.files : [])
    .map(normalizeFile)
    .sort((left, right) => left.file_ordinal - right.file_ordinal);
  const fileCount = nonNegativeSafeInteger(
    metadata.file_count,
    "metadata.file_count",
  );
  if (
    files.length !== fileCount ||
    (rowCount === 0 && files.length !== 0) ||
    (rowCount > 0 && files.length === 0)
  ) {
    throw new Error("Phase 1 file count mismatch");
  }
  const fileKeys = new Set();
  for (const [index, file] of files.entries()) {
    if (file.file_ordinal !== index || fileKeys.has(file.key)) {
      throw new Error("Phase 1 files have duplicate or non-contiguous identity");
    }
    fileKeys.add(file.key);
  }
  if (sum(files.map((file) => file.row_count)) !== rowCount) {
    throw new Error("Phase 1 file row counts do not reconcile");
  }

  const segments = [];
  const nestedSignatures = new Set();
  for (const file of files) {
    const rowGroupStarts = new Map(
      file.row_groups.map((rowGroup) => [
        rowGroup.row_group_ordinal,
        rowGroup.row_start,
      ]),
    );
    const nestedSegments = [];
    for (const rowGroup of file.row_groups) {
      for (const rawSegment of rowGroup.raw_segments) {
        const segment = normalizeSegment(rawSegment, file, rowGroupStarts);
        if (segment.row_group_ordinal !== rowGroup.row_group_ordinal) {
          throw new Error("Nested exact segment belongs to the wrong row group");
        }
        const signature = segmentSignature(segment);
        if (nestedSignatures.has(signature)) {
          throw new Error("Duplicate exact segment evidence");
        }
        nestedSignatures.add(signature);
        nestedSegments.push(segment);
      }
    }
    nestedSegments.sort(compareSegments);
    let expectedRowStart = 0;
    for (const segment of nestedSegments) {
      if (segment.row_start !== expectedRowStart) {
        throw new Error("Exact file segments overlap or leave row coverage gaps");
      }
      expectedRowStart += segment.row_count;
    }
    if (expectedRowStart !== file.row_count) {
      throw new Error("Exact file segment rows do not reconcile");
    }
    const expectedCounts = normalizeTimeseriesCounts(
      file.timeseries_row_counts,
      `file[${file.file_ordinal}].timeseries_row_counts`,
    );
    const actualCounts = new Map();
    for (const segment of nestedSegments) {
      actualCounts.set(
        segment.timeseries_id,
        (actualCounts.get(segment.timeseries_id) || 0) + segment.row_count,
      );
    }
    if (!sameJson(Object.fromEntries(expectedCounts), Object.fromEntries(actualCounts))) {
      throw new Error("Phase 1 file timeseries row counts do not reconcile");
    }
    for (const rowGroup of file.row_groups) {
      const groupSegments = nestedSegments.filter(
        (segment) => segment.row_group_ordinal === rowGroup.row_group_ordinal,
      );
      if (
        sum(groupSegments.map((segment) => segment.row_count)) !== rowGroup.row_count ||
        minValue(groupSegments.map((segment) => segment.timeseries_id)) !== rowGroup.min_timeseries_id ||
        maxValue(groupSegments.map((segment) => segment.timeseries_id)) !== rowGroup.max_timeseries_id ||
        minValue(groupSegments.map((segment) => segment.min_observed_at_utc)) !== rowGroup.min_observed_at_utc ||
        maxValue(groupSegments.map((segment) => segment.max_observed_at_utc)) !== rowGroup.max_observed_at_utc
      ) {
        throw new Error("Phase 1 row-group segment evidence is contradictory");
      }
    }
    segments.push(...nestedSegments);
  }

  const topLevelSegments = Array.isArray(metadata.segments)
    ? metadata.segments
    : [];
  const normalizedTopLevel = [];
  const topLevelSignatures = new Set();
  for (const rawSegment of topLevelSegments) {
    const ordinal = nonNegativeSafeInteger(
      rawSegment?.file_ordinal,
      "segment.file_ordinal",
    );
    const file = files[ordinal];
    if (!file) throw new Error("Top-level exact segment names an unknown file");
    const rowGroupStarts = new Map(
      file.row_groups.map((rowGroup) => [
        rowGroup.row_group_ordinal,
        rowGroup.row_start,
      ]),
    );
    const segment = normalizeSegment(rawSegment, file, rowGroupStarts);
    const signature = segmentSignature(segment);
    if (topLevelSignatures.has(signature)) {
      throw new Error("Duplicate top-level exact segment evidence");
    }
    topLevelSignatures.add(signature);
    normalizedTopLevel.push(segment);
  }
  if (
    topLevelSignatures.size !== nestedSignatures.size ||
    [...topLevelSignatures].some((signature) => !nestedSignatures.has(signature))
  ) {
    throw new Error("Top-level and row-group exact segment evidence disagree");
  }
  normalizedTopLevel.sort(compareSegments);

  const byTimeseries = new Map();
  for (const segment of normalizedTopLevel) {
    if (!byTimeseries.has(segment.timeseries_id)) {
      byTimeseries.set(segment.timeseries_id, []);
    }
    byTimeseries.get(segment.timeseries_id).push(segment);
  }
  for (const [timeseriesId, timeseriesSegments] of byTimeseries) {
    timeseriesSegments.sort(compareSegments);
    for (let index = 1; index < timeseriesSegments.length; index += 1) {
      const previous = timeseriesSegments[index - 1];
      const current = timeseriesSegments[index];
      if (
        current.file_ordinal < previous.file_ordinal ||
        (
          current.file_ordinal === previous.file_ordinal &&
          current.row_start < previous.row_start + previous.row_count
        ) ||
        current.min_observed_at_utc < previous.max_observed_at_utc
      ) {
        throw new Error(
          `Exact segments overlap or regress for timeseries_id=${timeseriesId}`,
        );
      }
    }
  }
  if (sum(normalizedTopLevel.map((segment) => segment.row_count)) !== rowCount) {
    throw new Error("Phase 1 exact segment row counts do not reconcile");
  }

  return Object.freeze({
    scope,
    row_count: rowCount,
    file_count: files.length,
    files: Object.freeze(files),
    segments: Object.freeze(normalizedTopLevel),
    timeseries: Object.freeze(byTimeseries),
    observation_content_hash: metadata.observation_content_hash,
  });
}

function fileDescriptor(file) {
  return Object.freeze({
    key: file.key,
    byte_size: file.byte_size,
    sha256: file.sha256,
    row_count: file.row_count,
    row_group_count: file.row_group_count,
    history_schema_version: file.history_schema_version,
    writer_version: file.writer_version,
    physical_layout_version: file.physical_layout_version,
    ...(file.etag ? { etag: file.etag } : {}),
  });
}

function segmentPayload(segment) {
  return Object.freeze({
    file_key: segment.file_key,
    row_group_ordinal: segment.row_group_ordinal,
    row_start: segment.row_start,
    row_group_row_start: segment.row_group_row_start,
    row_count: segment.row_count,
    min_observed_at_utc: segment.min_observed_at_utc,
    max_observed_at_utc: segment.max_observed_at_utc,
  });
}

function childCoverage(payload) {
  return {
    timeseries_count: payload.timeseries.length,
    timeseries_ids: payload.timeseries.map((entry) => entry.timeseries_id),
    row_count: sum(payload.timeseries.map((entry) => entry.row_count)),
    min_observed_at_utc: minValue(
      payload.timeseries.map((entry) => entry.min_observed_at_utc),
    ),
    max_observed_at_utc: maxValue(
      payload.timeseries.map((entry) => entry.max_observed_at_utc),
    ),
    file_count: payload.files.length,
  };
}

export function buildObservationHistoryIndexV3ChildShard({
  metadata,
  canonicalManifest,
  rangeStart,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const normalized = validateObservationHistoryTargetMetadataForV3(metadata);
  const source = normalizeCanonicalManifest(
    canonicalManifest,
    normalized.scope,
    normalized,
  );
  const normalizedRangeStart = normalizeRangeStart(rangeStart);
  const rangeEnd = normalizedRangeStart +
    OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 - 1;
  const timeseriesIds = [...normalized.timeseries.keys()]
    .filter((timeseriesId) =>
      timeseriesId >= normalizedRangeStart && timeseriesId <= rangeEnd
    )
    .sort((left, right) => left - right);
  if (timeseriesIds.length === 0) {
    throw new Error("Cannot build an empty observation-history v3 child shard");
  }
  for (const timeseriesId of timeseriesIds) {
    const expected = observationHistoryIndexV3RangeForTimeseriesId(timeseriesId);
    if (expected.range_start !== normalizedRangeStart) {
      throw new Error("Timeseries is assigned to the wrong logical v3 shard");
    }
  }
  const selectedSegments = timeseriesIds.flatMap(
    (timeseriesId) => normalized.timeseries.get(timeseriesId),
  );
  const referencedKeys = new Set(
    selectedSegments.map((segment) => segment.file_key),
  );
  const files = normalized.files
    .filter((file) => referencedKeys.has(file.key))
    .map(fileDescriptor)
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  const timeseries = timeseriesIds.map((timeseriesId) => {
    const exactSegments = [...normalized.timeseries.get(timeseriesId)]
      .sort(compareSegments)
      .map(segmentPayload);
    return {
      timeseries_id: timeseriesId,
      row_count: sum(exactSegments.map((segment) => segment.row_count)),
      min_observed_at_utc: minValue(
        exactSegments.map((segment) => segment.min_observed_at_utc),
      ),
      max_observed_at_utc: maxValue(
        exactSegments.map((segment) => segment.max_observed_at_utc),
      ),
      segments: exactSegments,
    };
  });
  const payload = {
    schema_version: OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3,
    kind: "observation_timeseries_exact_shard",
    index_generation: OBSERVATION_HISTORY_INDEX_GENERATION_V3,
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    shard_width: OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
    range_start: normalizedRangeStart,
    range_end: rangeEnd,
    day_utc: normalized.scope.day_utc,
    connector_id: normalized.scope.connector_id,
    pollutant_code: normalized.scope.pollutant_code,
    row_start_scope: "file",
    coverage: null,
    files,
    timeseries,
  };
  payload.coverage = childCoverage(payload);
  const dependencies = files.map((file) =>
    identityDescriptor({ ...file, kind: "canonical_parquet" })
  );
  const artifact = artifactFromPayload({
    kind: "observation_history_index_v3_child_shard",
    key: buildObservationHistoryIndexV3ChildShardKey({
      scope: normalized.scope,
      rangeStart: normalizedRangeStart,
      indexRoot,
    }),
    payload,
    dependencies,
    publicationPrerequisites: [
      identityDescriptor({ ...source, kind: "canonical_manifest" }),
    ],
    stage: "child_shard",
  });
  validateObservationHistoryIndexV3ChildShardArtifact({ artifact, indexRoot });
  return artifact;
}

function childDescriptor(artifact) {
  const payload = artifact.payload;
  return {
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
    range_start: payload.range_start,
    range_end: payload.range_end,
    timeseries_count: payload.coverage.timeseries_count,
    timeseries_ids: [...payload.coverage.timeseries_ids],
    row_count: payload.coverage.row_count,
    min_observed_at_utc: payload.coverage.min_observed_at_utc,
    max_observed_at_utc: payload.coverage.max_observed_at_utc,
    file_count: payload.coverage.file_count,
    files: payload.files.map(({ key, byte_size, sha256 }) => ({
      key,
      byte_size,
      sha256,
    })),
  };
}

function normalizeChildFile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("V3 child file descriptor must be an object");
  }
  const file = {
    key: normalizeKey(raw.key, "child.file.key"),
    byte_size: positiveSafeInteger(raw.byte_size, "child.file.byte_size"),
    sha256: normalizeSha256(raw.sha256, "child.file.sha256"),
    row_count: positiveSafeInteger(raw.row_count, "child.file.row_count"),
    row_group_count: positiveSafeInteger(
      raw.row_group_count,
      "child.file.row_group_count",
    ),
    history_schema_version: Number(raw.history_schema_version),
    writer_version: String(raw.writer_version || ""),
    physical_layout_version: String(raw.physical_layout_version || ""),
    ...(raw.etag === undefined
      ? {}
      : { etag: String(raw.etag || "").trim() }),
  };
  if (
    file.history_schema_version !== OBSERVATION_HISTORY_SCHEMA_VERSION_V3 ||
    file.writer_version !== OBSERVATION_HISTORY_WRITER_VERSION_V3 ||
    file.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
    (Object.hasOwn(file, "etag") && !file.etag)
  ) {
    throw new Error("V3 child has unsupported physical file identity");
  }
  assertSameJson(
    raw,
    file,
    "V3 child file descriptor has unsupported or non-canonical fields",
  );
  return file;
}

function normalizeChildSegment(raw, timeseriesId, filesByKey, rowGroupStarts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("V3 child exact segment must be an object");
  }
  const segment = {
    file_key: normalizeKey(raw.file_key, "child.segment.file_key"),
    row_group_ordinal: nonNegativeSafeInteger(
      raw.row_group_ordinal,
      "child.segment.row_group_ordinal",
    ),
    row_start: nonNegativeSafeInteger(
      raw.row_start,
      "child.segment.row_start",
    ),
    row_group_row_start: nonNegativeSafeInteger(
      raw.row_group_row_start,
      "child.segment.row_group_row_start",
    ),
    row_count: positiveSafeInteger(raw.row_count, "child.segment.row_count"),
    min_observed_at_utc: normalizeIso(
      raw.min_observed_at_utc,
      "child.segment.min_observed_at_utc",
    ),
    max_observed_at_utc: normalizeIso(
      raw.max_observed_at_utc,
      "child.segment.max_observed_at_utc",
    ),
  };
  assertSameJson(
    raw,
    segment,
    "V3 child segment has unsupported or non-canonical fields",
  );
  const file = filesByKey.get(segment.file_key);
  if (!file) throw new Error("V3 child segment names an unlisted file");
  if (
    segment.row_group_ordinal >= file.row_group_count ||
    segment.row_start + segment.row_count > file.row_count ||
    segment.row_group_row_start > segment.row_start ||
    segment.min_observed_at_utc > segment.max_observed_at_utc
  ) {
    throw new Error("V3 child segment has impossible physical coordinates or bounds");
  }
  const groupKey = `${segment.file_key}\u0000${segment.row_group_ordinal}`;
  const inferredGroupStart = segment.row_start - segment.row_group_row_start;
  const previousGroupStart = rowGroupStarts.get(groupKey);
  if (
    previousGroupStart !== undefined &&
    previousGroupStart !== inferredGroupStart
  ) {
    throw new Error("V3 child segment has contradictory row-group coordinates");
  }
  rowGroupStarts.set(groupKey, inferredGroupStart);
  return { ...segment, timeseries_id: timeseriesId };
}

function assertNonOverlappingPhysicalSegments(segments, filesByKey, label, {
  requireCompleteFiles = false,
} = {}) {
  const byFile = new Map([...filesByKey.keys()].map((key) => [key, []]));
  for (const segment of segments) byFile.get(segment.file_key).push(segment);
  for (const [fileKey, fileSegments] of byFile) {
    fileSegments.sort((left, right) =>
      left.row_start - right.row_start ||
      left.row_count - right.row_count ||
      left.timeseries_id - right.timeseries_id
    );
    if (fileSegments.length === 0) {
      throw new Error(`${label} lists an unreferenced physical file`);
    }
    let expectedStart = requireCompleteFiles ? 0 : fileSegments[0].row_start;
    for (const segment of fileSegments) {
      if (
        segment.row_start < expectedStart ||
        (requireCompleteFiles && segment.row_start !== expectedStart)
      ) {
        throw new Error(`${label} has overlapping or incomplete physical segments`);
      }
      expectedStart = segment.row_start + segment.row_count;
    }
    if (requireCompleteFiles && expectedStart !== filesByKey.get(fileKey).row_count) {
      throw new Error(`${label} physical file rows do not reconcile`);
    }
  }
}

export function validateObservationHistoryIndexV3ChildShardArtifact({
  artifact: rawArtifact,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const artifact = validateArtifact(
    rawArtifact,
    "observation_history_index_v3_child_shard",
    "child_shard",
  );
  const rawPayload = artifact.payload;
  const scope = normalizeScope(rawPayload);
  const publicationPrerequisites = normalizeArtifactPublicationPrerequisites(
    artifact,
    new Set(["canonical_manifest"]),
  );
  if (publicationPrerequisites.length !== 1) {
    throw new Error("V3 child requires one canonical-manifest publication prerequisite");
  }
  const canonicalPrerequisite = publicationPrerequisites[0];
  const expectedManifestScopeToken =
    `/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
  if (!canonicalPrerequisite.key.endsWith(expectedManifestScopeToken)) {
    throw new Error("V3 child publication prerequisite disagrees with scope");
  }
  const rangeStart = normalizeRangeStart(rawPayload.range_start);
  const rangeEnd = rangeStart + OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 - 1;
  if (Number(rawPayload.range_end) !== rangeEnd) {
    throw new Error("V3 child range end disagrees with shard width");
  }
  const files = (Array.isArray(rawPayload.files) ? rawPayload.files : [])
    .map(normalizeChildFile);
  if (files.length === 0) throw new Error("V3 child requires physical files");
  const filesByKey = new Map();
  for (const [index, file] of files.entries()) {
    if (
      filesByKey.has(file.key) ||
      (index > 0 && bytewiseCompare(files[index - 1].key, file.key) >= 0)
    ) {
      throw new Error("V3 child files are duplicate or non-deterministically ordered");
    }
    filesByKey.set(file.key, file);
  }
  const rawTimeseries = Array.isArray(rawPayload.timeseries)
    ? rawPayload.timeseries
    : [];
  if (rawTimeseries.length === 0) throw new Error("V3 child cannot be empty");
  const rowGroupStarts = new Map();
  const allSegments = [];
  const timeseries = rawTimeseries.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("V3 child timeseries entry must be an object");
    }
    const timeseriesId = positiveSafeInteger(
      raw.timeseries_id,
      "child.timeseries_id",
    );
    if (
      timeseriesId < rangeStart ||
      timeseriesId > rangeEnd ||
      (index > 0 && rawTimeseries[index - 1].timeseries_id >= timeseriesId)
    ) {
      throw new Error("V3 child timeseries identity is out of shard or non-deterministic");
    }
    const segments = (Array.isArray(raw.segments) ? raw.segments : [])
      .map((segment) =>
        normalizeChildSegment(
          segment,
          timeseriesId,
          filesByKey,
          rowGroupStarts,
        )
      );
    if (segments.length === 0) {
      throw new Error("V3 child timeseries requires exact segments");
    }
    const fileOrder = new Map(files.map((file, ordinal) => [file.key, ordinal]));
    for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
      const previous = segments[segmentIndex - 1];
      const current = segments[segmentIndex];
      if (
        fileOrder.get(current.file_key) < fileOrder.get(previous.file_key) ||
        (
          current.file_key === previous.file_key &&
          current.row_start < previous.row_start + previous.row_count
        ) ||
        current.min_observed_at_utc < previous.max_observed_at_utc
      ) {
        throw new Error("V3 child timeseries segments overlap, regress, or are unordered");
      }
    }
    const normalized = {
      timeseries_id: timeseriesId,
      row_count: sum(segments.map((segment) => segment.row_count)),
      min_observed_at_utc: minValue(
        segments.map((segment) => segment.min_observed_at_utc),
      ),
      max_observed_at_utc: maxValue(
        segments.map((segment) => segment.max_observed_at_utc),
      ),
      segments: segments.map(({ timeseries_id: _timeseriesId, ...segment }) =>
        segment
      ),
    };
    assertSameJson(
      raw,
      normalized,
      "V3 child timeseries totals, bounds, or fields are contradictory",
    );
    allSegments.push(...segments);
    return normalized;
  });
  assertNonOverlappingPhysicalSegments(
    allSegments,
    filesByKey,
    "V3 child",
  );
  const expectedPayload = {
    ...baseIndexPayload("observation_timeseries_exact_shard"),
    range_start: rangeStart,
    range_end: rangeEnd,
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    row_start_scope: "file",
    coverage: childCoverage({ files, timeseries }),
    files,
    timeseries,
  };
  assertSameJson(
    rawPayload,
    expectedPayload,
    "V3 child payload has contradictory identity, coverage, or fields",
  );
  const expectedKey = buildObservationHistoryIndexV3ChildShardKey({
    scope,
    rangeStart,
    indexRoot,
  });
  if (artifact.key !== expectedKey) throw new Error("V3 child key is non-canonical");
  assertExactDependencies(
    artifact,
    files.map((file) =>
      identityDescriptor({ ...file, kind: "canonical_parquet" })
    ),
    new Set(["canonical_parquet"]),
  );
  assertExactPublicationPrerequisites(
    artifact,
    [canonicalPrerequisite],
    new Set(["canonical_manifest"]),
  );
  return Object.freeze({
    artifact,
    scope,
    canonical_prerequisite: canonicalPrerequisite,
    range_start: rangeStart,
    range_end: rangeEnd,
    files: Object.freeze(files),
    files_by_key: filesByKey,
    timeseries: Object.freeze(timeseries),
    segments: Object.freeze(allSegments),
  });
}

function normalizeScopedHierarchy(raw, fieldName = "scoped_hierarchy") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  if (!Array.isArray(raw.child_shards)) {
    throw new TypeError(`${fieldName}.child_shards must be an array`);
  }
  if (!raw.scoped_manifest) {
    throw new TypeError(`${fieldName}.scoped_manifest is required`);
  }
  return raw;
}

function validateObservationHistoryIndexV3ScopedManifestSnapshot({
  artifact: rawArtifact,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const artifact = validateArtifact(
    rawArtifact,
    "observation_history_index_v3_scoped_manifest",
    "scoped_manifest",
  );
  const validatedBody = validateObservationHistoryIndexV3ScopedManifestBody({
    key: artifact.key,
    body: artifact.body,
    indexRoot,
  });
  const { scope, source, descriptors } = validatedBody;
  assertExactDependencies(
    artifact,
    [
      identityDescriptor({ ...source, kind: "canonical_manifest" }),
      ...descriptors.map((descriptor) =>
        identityDescriptor({ ...descriptor, kind: "child_shard" })
      ),
    ],
    new Set(["canonical_manifest", "child_shard"]),
  );
  assertExactPublicationPrerequisites(artifact, [], new Set());
  return Object.freeze({
    artifact,
    scope,
    source,
    descriptors,
    coverage: validatedBody.coverage,
  });
}

export function validateObservationHistoryIndexV3ScopedManifestArtifact({
  artifact: rawArtifact,
  childShards,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const snapshot = validateObservationHistoryIndexV3ScopedManifestSnapshot({
    artifact: rawArtifact,
    indexRoot,
  });
  const { artifact } = snapshot;
  if (
    !Array.isArray(childShards) ||
    (childShards.length === 0 && snapshot.coverage.row_count !== 0)
  ) {
    throw new Error(
      "Semantic scoped-manifest validation requires complete child artifacts",
    );
  }
  const rawPayload = artifact.payload;
  const { scope, source } = snapshot;
  const sourcePublicationIdentity = identityDescriptor({
    ...source,
    kind: "canonical_manifest",
  });
  const children = childShards.map((child) =>
    validateObservationHistoryIndexV3ChildShardArtifact({
      artifact: child,
      indexRoot,
    })
  ).sort((left, right) => left.range_start - right.range_start);
  const seenRanges = new Set();
  const seenTimeseries = new Set();
  const filesByKey = new Map();
  const segments = [];
  for (const child of children) {
    if (seenRanges.has(child.range_start)) {
      throw new Error("Scoped v3 manifest has duplicate shard ranges");
    }
    seenRanges.add(child.range_start);
    if (
      !sameJson(child.scope, scope) ||
      !sameJson(child.canonical_prerequisite, sourcePublicationIdentity)
    ) {
      throw new Error("Scoped v3 manifest received a contradictory child shard");
    }
    for (const entry of child.timeseries) {
      if (seenTimeseries.has(entry.timeseries_id)) {
        throw new Error("Scoped v3 manifest has duplicate timeseries coverage");
      }
      seenTimeseries.add(entry.timeseries_id);
    }
    for (const file of child.files) {
      const previous = filesByKey.get(file.key);
      if (previous && !sameJson(previous, file)) {
        throw new Error("Scoped v3 manifest has contradictory shared file identity");
      }
      filesByKey.set(file.key, file);
    }
    segments.push(...child.segments);
  }
  assertNonOverlappingPhysicalSegments(
    segments,
    filesByKey,
    "Scoped v3 manifest",
    { requireCompleteFiles: true },
  );
  const descriptors = children.map(({ artifact: child }) =>
    childDescriptor(child)
  );
  const timeseriesIds = [...seenTimeseries].sort((left, right) => left - right);
  const coverage = {
    timeseries_count: timeseriesIds.length,
    timeseries_ids: timeseriesIds,
    row_count: sum(descriptors.map((entry) => entry.row_count)),
    min_observed_at_utc: minValue(
      descriptors.map((entry) => entry.min_observed_at_utc),
    ),
    max_observed_at_utc: maxValue(
      descriptors.map((entry) => entry.max_observed_at_utc),
    ),
    child_shard_count: descriptors.length,
    physical_file_count: filesByKey.size,
  };
  if (coverage.row_count !== source.row_count) {
    throw new Error("Scoped v3 manifest rows disagree with canonical source");
  }
  const expectedPayload = {
    ...baseIndexPayload("observation_timeseries_scoped_manifest"),
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    canonical_source_manifest: source,
    coverage,
    children: descriptors,
  };
  assertSameJson(
    rawPayload,
    expectedPayload,
    "Scoped v3 manifest payload has contradictory identity, coverage, or children",
  );
  const expectedKey = buildObservationHistoryIndexV3ScopedManifestKey({
    scope,
    indexRoot,
  });
  if (artifact.key !== expectedKey) {
    throw new Error("Scoped v3 manifest key is non-canonical");
  }
  assertExactDependencies(
    artifact,
    [
      identityDescriptor({ ...source, kind: "canonical_manifest" }),
      ...children.map(({ artifact: child }) =>
        identityDescriptor({
          key: child.key,
          byte_size: child.byte_size,
          sha256: child.sha256,
          kind: "child_shard",
        })
      ),
    ],
    new Set(["canonical_manifest", "child_shard"]),
  );
  return Object.freeze({
    artifact,
    scope,
    source,
    children: Object.freeze(children),
    descriptors: Object.freeze(descriptors),
    coverage: Object.freeze(coverage),
  });
}

export function buildObservationHistoryIndexV3ScopedManifest({
  metadata,
  canonicalManifest,
  childShards,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const normalized = validateObservationHistoryTargetMetadataForV3(metadata);
  const source = normalizeCanonicalManifest(
    canonicalManifest,
    normalized.scope,
    normalized,
  );
  if (
    !Array.isArray(childShards) ||
    (childShards.length === 0 && normalized.row_count !== 0)
  ) {
    throw new Error("Scoped v3 manifest requires complete child shard dependencies");
  }
  const children = childShards.map((rawArtifact) => {
    const validated = validateObservationHistoryIndexV3ChildShardArtifact({
      artifact: rawArtifact,
      indexRoot,
    });
    const { artifact } = validated;
    const payload = artifact.payload;
    if (
      payload.day_utc !== normalized.scope.day_utc ||
      payload.connector_id !== normalized.scope.connector_id ||
      payload.pollutant_code !== normalized.scope.pollutant_code ||
      !sameJson(
        validated.canonical_prerequisite,
        identityDescriptor({ ...source, kind: "canonical_manifest" }),
      )
    ) {
      throw new Error("Scoped v3 manifest received a contradictory child shard");
    }
    return { artifact, descriptor: childDescriptor(artifact) };
  }).sort((left, right) =>
    left.descriptor.range_start - right.descriptor.range_start ||
    bytewiseCompare(left.artifact.key, right.artifact.key)
  );
  const seenRanges = new Set();
  const seenTimeseries = new Set();
  for (const { artifact, descriptor } of children) {
    if (seenRanges.has(descriptor.range_start)) {
      throw new Error("Scoped v3 manifest has duplicate shard ranges");
    }
    seenRanges.add(descriptor.range_start);
    const expectedKey = buildObservationHistoryIndexV3ChildShardKey({
      scope: normalized.scope,
      rangeStart: descriptor.range_start,
      indexRoot,
    });
    if (artifact.key !== expectedKey) {
      throw new Error("Scoped v3 manifest child key is non-canonical");
    }
    for (const timeseriesId of descriptor.timeseries_ids) {
      const expectedRange = observationHistoryIndexV3RangeForTimeseriesId(
        timeseriesId,
      );
      if (
        expectedRange.range_start !== descriptor.range_start ||
        seenTimeseries.has(timeseriesId)
      ) {
        throw new Error("Scoped v3 manifest has wrong or duplicate shard assignment");
      }
      seenTimeseries.add(timeseriesId);
    }
  }
  const expectedTimeseriesIds = [...normalized.timeseries.keys()]
    .sort((left, right) => left - right);
  const actualTimeseriesIds = [...seenTimeseries].sort((left, right) => left - right);
  if (!sameJson(expectedTimeseriesIds, actualTimeseriesIds)) {
    throw new Error("Scoped v3 root/child timeseries coverage disagreement");
  }
  const descriptors = children.map((entry) => entry.descriptor);
  if (sum(descriptors.map((entry) => entry.row_count)) !== normalized.row_count) {
    throw new Error("Scoped v3 root/child row coverage disagreement");
  }
  const payload = {
    schema_version: OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3,
    kind: "observation_timeseries_scoped_manifest",
    index_generation: OBSERVATION_HISTORY_INDEX_GENERATION_V3,
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    shard_width: OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
    day_utc: normalized.scope.day_utc,
    connector_id: normalized.scope.connector_id,
    pollutant_code: normalized.scope.pollutant_code,
    canonical_source_manifest: source,
    coverage: {
      timeseries_count: actualTimeseriesIds.length,
      timeseries_ids: actualTimeseriesIds,
      row_count: normalized.row_count,
      min_observed_at_utc: minValue(
        descriptors.map((entry) => entry.min_observed_at_utc),
      ),
      max_observed_at_utc: maxValue(
        descriptors.map((entry) => entry.max_observed_at_utc),
      ),
      child_shard_count: descriptors.length,
      physical_file_count: normalized.file_count,
    },
    children: descriptors,
  };
  const dependencies = [
    identityDescriptor({ ...source, kind: "canonical_manifest" }),
    ...children.map(({ artifact }) =>
      identityDescriptor({
        key: artifact.key,
        byte_size: artifact.byte_size,
        sha256: artifact.sha256,
        kind: "child_shard",
      })
    ),
  ];
  const artifact = artifactFromPayload({
    kind: "observation_history_index_v3_scoped_manifest",
    key: buildObservationHistoryIndexV3ScopedManifestKey({
      scope: normalized.scope,
      indexRoot,
    }),
    payload,
    dependencies,
    stage: "scoped_manifest",
  });
  validateObservationHistoryIndexV3ScopedManifestArtifact({
    artifact,
    childShards,
    indexRoot,
  });
  return artifact;
}

export function buildObservationHistoryIndexV3ScopedHierarchy({
  metadata,
  canonicalManifest,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const normalized = validateObservationHistoryTargetMetadataForV3(metadata);
  const rangeStarts = [...new Set(
    [...normalized.timeseries.keys()].map(
      (timeseriesId) =>
        observationHistoryIndexV3RangeForTimeseriesId(timeseriesId).range_start,
    ),
  )].sort((left, right) => left - right);
  const childShards = rangeStarts.map((rangeStart) =>
    buildObservationHistoryIndexV3ChildShard({
      metadata,
      canonicalManifest,
      rangeStart,
      indexRoot,
    })
  );
  const scopedManifest = buildObservationHistoryIndexV3ScopedManifest({
    metadata,
    canonicalManifest,
    childShards,
    indexRoot,
  });
  return Object.freeze({
    child_shards: Object.freeze(childShards),
    scoped_manifest: scopedManifest,
  });
}

function scopedRootDescriptor(artifact) {
  const payload = artifact.payload;
  return {
    day_utc: payload.day_utc,
    connector_id: payload.connector_id,
    pollutant_code: payload.pollutant_code,
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
    row_count: payload.coverage.row_count,
    timeseries_count: payload.coverage.timeseries_count,
    child_shard_count: payload.coverage.child_shard_count,
    physical_file_count: payload.coverage.physical_file_count,
    min_observed_at_utc: payload.coverage.min_observed_at_utc,
    max_observed_at_utc: payload.coverage.max_observed_at_utc,
  };
}

function normalizeScopedRoots(scopedHierarchies, indexRoot) {
  if (!Array.isArray(scopedHierarchies) || scopedHierarchies.length === 0) {
    throw new Error("V3 latest/global metadata requires scoped hierarchies");
  }
  const roots = scopedHierarchies.map((rawHierarchy, index) => {
    const hierarchy = normalizeScopedHierarchy(
      rawHierarchy,
      `scoped_hierarchies[${index}]`,
    );
    const validated = validateObservationHistoryIndexV3ScopedManifestArtifact({
      artifact: hierarchy.scoped_manifest,
      childShards: hierarchy.child_shards,
      indexRoot,
    });
    return {
      hierarchy,
      artifact: validated.artifact,
      descriptor: scopedRootDescriptor(validated.artifact),
    };
  }).sort((left, right) =>
    bytewiseCompare(left.descriptor.day_utc, right.descriptor.day_utc) ||
    left.descriptor.connector_id - right.descriptor.connector_id ||
    bytewiseCompare(
      left.descriptor.pollutant_code,
      right.descriptor.pollutant_code,
    ) ||
    bytewiseCompare(left.artifact.key, right.artifact.key)
  );
  const seen = new Set();
  for (const { descriptor } of roots) {
    const identity = [
      descriptor.day_utc,
      descriptor.connector_id,
      descriptor.pollutant_code,
    ].join("\u0000");
    if (seen.has(identity)) {
      throw new Error("V3 latest/global metadata has duplicate scoped roots");
    }
    seen.add(identity);
  }
  return roots;
}

function latestPayloadForRoots(roots, normalizedIndexRoot, normalizedLatestKey) {
  const byDay = new Map();
  for (const { descriptor } of roots) {
    if (!byDay.has(descriptor.day_utc)) byDay.set(descriptor.day_utc, []);
    byDay.get(descriptor.day_utc).push(descriptor);
  }
  const daySummaries = [...byDay.entries()]
    .sort(([left], [right]) => bytewiseCompare(left, right))
    .map(([dayUtc, scopedRoots]) => ({
      day_utc: dayUtc,
      row_count: sum(scopedRoots.map((entry) => entry.row_count)),
      scoped_root_count: scopedRoots.length,
      connector_ids: [...new Set(scopedRoots.map((entry) => entry.connector_id))]
        .sort((left, right) => left - right),
      pollutant_codes: [...new Set(
        scopedRoots.map((entry) => entry.pollutant_code),
      )].sort(bytewiseCompare),
      scoped_roots: scopedRoots,
    }));
  const days = daySummaries.map((entry) => entry.day_utc);
  return {
    ...baseIndexPayload("observation_timeseries_latest_global"),
    index_root: normalizedIndexRoot,
    min_day_utc: days[0],
    max_day_utc: days[days.length - 1],
    day_count: days.length,
    scoped_root_count: roots.length,
    child_shard_count: sum(
      roots.map(({ descriptor }) => descriptor.child_shard_count),
    ),
    physical_file_reference_count: sum(
      roots.map(({ descriptor }) => descriptor.physical_file_count),
    ),
    total_rows: sum(roots.map(({ descriptor }) => descriptor.row_count)),
    days,
    key_layout: {
      scoped_manifest_key_template:
        `${normalizedIndexRoot}/day_utc={day_utc}/connector_id={connector_id}` +
        "/pollutant_code={pollutant_code}/manifest.json",
      child_shard_key_template:
        `${normalizedIndexRoot}/day_utc={day_utc}/connector_id={connector_id}` +
        "/pollutant_code={pollutant_code}/range={range_start}-{range_end}.json",
      latest_key: normalizedLatestKey,
    },
    day_summaries: daySummaries,
  };
}

function normalizeScopedRootDescriptor(raw, indexRoot) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("V3 latest scoped-root descriptor must be an object");
  }
  const scope = normalizeScope(raw);
  const descriptor = {
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    key: normalizeKey(raw.key, "scoped_root.key"),
    byte_size: positiveSafeInteger(raw.byte_size, "scoped_root.byte_size"),
    sha256: normalizeSha256(raw.sha256, "scoped_root.sha256"),
    row_count: nonNegativeSafeInteger(raw.row_count, "scoped_root.row_count"),
    timeseries_count: nonNegativeSafeInteger(
      raw.timeseries_count,
      "scoped_root.timeseries_count",
    ),
    child_shard_count: nonNegativeSafeInteger(
      raw.child_shard_count,
      "scoped_root.child_shard_count",
    ),
    physical_file_count: nonNegativeSafeInteger(
      raw.physical_file_count,
      "scoped_root.physical_file_count",
    ),
    min_observed_at_utc: normalizeNullableIso(
      raw.min_observed_at_utc,
      "scoped_root.min_observed_at_utc",
    ),
    max_observed_at_utc: normalizeNullableIso(
      raw.max_observed_at_utc,
      "scoped_root.max_observed_at_utc",
    ),
  };
  if (
    (
      descriptor.row_count === 0
        ? descriptor.timeseries_count !== 0 ||
          descriptor.child_shard_count !== 0 ||
          descriptor.physical_file_count !== 0 ||
          descriptor.min_observed_at_utc !== null ||
          descriptor.max_observed_at_utc !== null
        : descriptor.timeseries_count === 0 ||
          descriptor.child_shard_count === 0 ||
          descriptor.physical_file_count === 0 ||
          descriptor.min_observed_at_utc === null ||
          descriptor.max_observed_at_utc === null ||
          descriptor.min_observed_at_utc > descriptor.max_observed_at_utc
    ) ||
    descriptor.key !== buildObservationHistoryIndexV3ScopedManifestKey({
      scope,
      indexRoot,
    })
  ) {
    throw new Error("V3 latest scoped-root descriptor is contradictory");
  }
  assertSameJson(
    raw,
    descriptor,
    "V3 latest scoped-root descriptor has unsupported fields",
  );
  return descriptor;
}

function validateObservationHistoryIndexV3LatestSnapshot({
  artifact: rawArtifact,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
}) {
  const artifact = validateArtifact(
    rawArtifact,
    "observation_history_index_v3_latest_global",
    "latest_global",
  );
  const normalizedIndexRoot = normalizePrefix(indexRoot, "index_root");
  const normalizedLatestKey = normalizeKey(latestKey, "latest_key");
  const rawDaySummaries = Array.isArray(artifact.payload.day_summaries)
    ? artifact.payload.day_summaries
    : [];
  const descriptors = rawDaySummaries.flatMap((day) =>
    (Array.isArray(day?.scoped_roots) ? day.scoped_roots : []).map((root) =>
      normalizeScopedRootDescriptor(root, normalizedIndexRoot)
    )
  );
  if (descriptors.length === 0) {
    throw new Error("V3 latest/global metadata requires scoped-root descriptors");
  }
  const roots = descriptors.map((descriptor) => ({ descriptor }));
  roots.sort((left, right) =>
    bytewiseCompare(left.descriptor.day_utc, right.descriptor.day_utc) ||
    left.descriptor.connector_id - right.descriptor.connector_id ||
    bytewiseCompare(
      left.descriptor.pollutant_code,
      right.descriptor.pollutant_code,
    )
  );
  const seen = new Set();
  for (const { descriptor } of roots) {
    const identity = scopeIdentity(descriptor);
    if (seen.has(identity)) {
      throw new Error("V3 latest/global metadata has duplicate scoped roots");
    }
    seen.add(identity);
  }
  assertSameJson(
    artifact.payload,
    latestPayloadForRoots(roots, normalizedIndexRoot, normalizedLatestKey),
    "V3 latest/global payload has contradictory roots, summaries, or counters",
  );
  if (artifact.key !== normalizedLatestKey) {
    throw new Error("V3 latest/global key is non-canonical");
  }
  assertExactDependencies(
    artifact,
    descriptors.map((descriptor) =>
      identityDescriptor({ ...descriptor, kind: "scoped_manifest" })
    ),
    new Set(["scoped_manifest"]),
  );
  assertExactPublicationPrerequisites(artifact, [], new Set());
  return Object.freeze({ artifact, roots: Object.freeze(roots) });
}

export function validateObservationHistoryIndexV3LatestArtifact({
  artifact: rawArtifact,
  scopedHierarchies,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
}) {
  const snapshot = validateObservationHistoryIndexV3LatestSnapshot({
    artifact: rawArtifact,
    indexRoot,
    latestKey,
  });
  const { artifact } = snapshot;
  const normalizedIndexRoot = normalizePrefix(indexRoot, "index_root");
  const normalizedLatestKey = normalizeKey(latestKey, "latest_key");
  const roots = normalizeScopedRoots(scopedHierarchies, normalizedIndexRoot);
  const expectedPayload = latestPayloadForRoots(
    roots,
    normalizedIndexRoot,
    normalizedLatestKey,
  );
  assertSameJson(
    artifact.payload,
    expectedPayload,
    "V3 latest/global payload has contradictory roots, summaries, or counters",
  );
  if (artifact.key !== normalizedLatestKey) {
    throw new Error("V3 latest/global key is non-canonical");
  }
  assertExactDependencies(
    artifact,
    roots.map(({ artifact: root }) =>
      identityDescriptor({
        key: root.key,
        byte_size: root.byte_size,
        sha256: root.sha256,
        kind: "scoped_manifest",
      })
    ),
    new Set(["scoped_manifest"]),
  );
  return Object.freeze({ artifact, roots: Object.freeze(roots) });
}

export function buildObservationHistoryIndexV3Latest({
  scopedHierarchies,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
}) {
  const normalizedIndexRoot = normalizePrefix(indexRoot, "index_root");
  const normalizedLatestKey = normalizeKey(latestKey, "latest_key");
  const roots = normalizeScopedRoots(scopedHierarchies, normalizedIndexRoot);
  const artifact = artifactFromPayload({
    kind: "observation_history_index_v3_latest_global",
    key: normalizedLatestKey,
    payload: latestPayloadForRoots(roots, normalizedIndexRoot, normalizedLatestKey),
    dependencies: roots.map(({ artifact }) =>
      identityDescriptor({
        key: artifact.key,
        byte_size: artifact.byte_size,
        sha256: artifact.sha256,
        kind: "scoped_manifest",
      })
    ),
    stage: "latest_global",
  });
  validateObservationHistoryIndexV3LatestArtifact({
    artifact,
    scopedHierarchies,
    indexRoot: normalizedIndexRoot,
    latestKey: normalizedLatestKey,
  });
  return artifact;
}

function scopeIdentity(scope) {
  const normalized = normalizeScope(scope);
  return [
    normalized.day_utc,
    normalized.connector_id,
    normalized.pollutant_code,
  ].join("\u0000");
}

/**
 * Replace or add named child ranges while trusting semantically coherent
 * descriptors for omitted ranges in the existing scoped manifest. A range is
 * removed only when explicitly listed in removedRangeStarts.
 */
export function updateObservationHistoryIndexV3ScopedManifest({
  existingScopedManifest,
  canonicalManifest = null,
  replacementChildShards = [],
  removedRangeStarts = [],
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
}) {
  const existing = validateObservationHistoryIndexV3ScopedManifestSnapshot({
    artifact: existingScopedManifest,
    indexRoot,
  });
  if (!Array.isArray(replacementChildShards)) {
    throw new TypeError("replacement_child_shards must be an array");
  }
  if (!Array.isArray(removedRangeStarts)) {
    throw new TypeError("removed_range_starts must be an array");
  }
  const source = canonicalManifest === null
    ? existing.source
    : normalizeCanonicalManifestDescriptor(canonicalManifest, existing.scope);
  const byRange = new Map(
    existing.descriptors.map((descriptor) => [descriptor.range_start, descriptor]),
  );
  const replacementRanges = new Set();
  for (const rawArtifact of replacementChildShards) {
    const validated = validateObservationHistoryIndexV3ChildShardArtifact({
      artifact: rawArtifact,
      indexRoot,
    });
    if (replacementRanges.has(validated.range_start)) {
      throw new Error("Targeted scoped update has duplicate replacement ranges");
    }
    if (
      !sameJson(validated.scope, existing.scope) ||
      !sameJson(
        validated.canonical_prerequisite,
        identityDescriptor({ ...source, kind: "canonical_manifest" }),
      )
    ) {
      throw new Error("Targeted scoped update replacement disagrees with scope or source");
    }
    replacementRanges.add(validated.range_start);
    byRange.set(validated.range_start, childDescriptor(validated.artifact));
  }
  const removals = new Set();
  for (const rawRangeStart of removedRangeStarts) {
    const rangeStart = normalizeRangeStart(rawRangeStart);
    if (removals.has(rangeStart)) {
      throw new Error("Targeted scoped update has duplicate removal ranges");
    }
    if (replacementRanges.has(rangeStart)) {
      throw new Error("Targeted scoped update cannot replace and remove one range");
    }
    if (!byRange.has(rangeStart)) {
      throw new Error("Targeted scoped update removal range does not exist");
    }
    removals.add(rangeStart);
    byRange.delete(rangeStart);
  }
  const descriptors = [...byRange.values()].sort(
    (left, right) => left.range_start - right.range_start,
  );
  if (descriptors.length === 0) {
    throw new Error("Targeted scoped update cannot remove every child");
  }
  const artifact = artifactFromPayload({
    kind: "observation_history_index_v3_scoped_manifest",
    key: buildObservationHistoryIndexV3ScopedManifestKey({
      scope: existing.scope,
      indexRoot,
    }),
    payload: buildObservationHistoryIndexV3ScopedManifestPayload({
      scope: existing.scope,
      canonicalSource: source,
      childDescriptors: descriptors,
    }),
    dependencies: [
      identityDescriptor({ ...source, kind: "canonical_manifest" }),
      ...descriptors.map((descriptor) =>
        identityDescriptor({ ...descriptor, kind: "child_shard" })
      ),
    ],
    stage: "scoped_manifest",
  });
  validateObservationHistoryIndexV3ScopedManifestSnapshot({
    artifact,
    indexRoot,
  });
  return artifact;
}

/**
 * Replace or add named scoped roots while preserving every omitted descriptor
 * in the existing latest object. A scope is removed only when explicitly
 * listed in removedScopes.
 */
export function updateObservationHistoryIndexV3Latest({
  existingLatest,
  replacementScopedManifests = [],
  removedScopes = [],
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
}) {
  const existing = validateObservationHistoryIndexV3LatestSnapshot({
    artifact: existingLatest,
    indexRoot,
    latestKey,
  });
  if (!Array.isArray(replacementScopedManifests)) {
    throw new TypeError("replacement_scoped_manifests must be an array");
  }
  if (!Array.isArray(removedScopes)) {
    throw new TypeError("removed_scopes must be an array");
  }
  const byScope = new Map(
    existing.roots.map(({ descriptor }) => [
      scopeIdentity(descriptor),
      descriptor,
    ]),
  );
  const replacementScopes = new Set();
  for (const rawArtifact of replacementScopedManifests) {
    const validated = validateObservationHistoryIndexV3ScopedManifestSnapshot({
      artifact: rawArtifact,
      indexRoot,
    });
    const identity = scopeIdentity(validated.scope);
    if (replacementScopes.has(identity)) {
      throw new Error("Targeted latest update has duplicate replacement scopes");
    }
    replacementScopes.add(identity);
    byScope.set(identity, scopedRootDescriptor(validated.artifact));
  }
  const removals = new Set();
  for (const rawScope of removedScopes) {
    const identity = scopeIdentity(rawScope);
    if (removals.has(identity)) {
      throw new Error("Targeted latest update has duplicate removal scopes");
    }
    if (replacementScopes.has(identity)) {
      throw new Error("Targeted latest update cannot replace and remove one scope");
    }
    if (!byScope.has(identity)) {
      throw new Error("Targeted latest update removal scope does not exist");
    }
    removals.add(identity);
    byScope.delete(identity);
  }
  const normalizedIndexRoot = normalizePrefix(indexRoot, "index_root");
  const normalizedLatestKey = normalizeKey(latestKey, "latest_key");
  const roots = [...byScope.values()].map((descriptor) => ({ descriptor }));
  roots.sort((left, right) =>
    bytewiseCompare(left.descriptor.day_utc, right.descriptor.day_utc) ||
    left.descriptor.connector_id - right.descriptor.connector_id ||
    bytewiseCompare(
      left.descriptor.pollutant_code,
      right.descriptor.pollutant_code,
    )
  );
  if (roots.length === 0) {
    throw new Error("Targeted latest update cannot remove every scoped root");
  }
  const artifact = artifactFromPayload({
    kind: "observation_history_index_v3_latest_global",
    key: normalizedLatestKey,
    payload: latestPayloadForRoots(roots, normalizedIndexRoot, normalizedLatestKey),
    dependencies: roots.map(({ descriptor }) =>
      identityDescriptor({ ...descriptor, kind: "scoped_manifest" })
    ),
    stage: "latest_global",
  });
  validateObservationHistoryIndexV3LatestSnapshot({
    artifact,
    indexRoot: normalizedIndexRoot,
    latestKey: normalizedLatestKey,
  });
  return artifact;
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

function validatePublicationPlan(plan) {
  if (
    !plan ||
    plan.contract_version !== OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT ||
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan.external_references) ||
    plan.entries.length === 0
  ) {
    throw new Error("Invalid observation-history v3 publication plan");
  }
  const expectedHash = sha256Hex(scheduleHashInput(plan));
  if (plan.schedule_sha256 !== expectedHash) {
    throw new Error("Observation-history v3 publication schedule identity mismatch");
  }
  for (const [index, entry] of plan.entries.entries()) {
    if (
      entry.position !== index + 1 ||
      !Array.isArray(entry.dependencies) ||
      !Array.isArray(entry.publication_prerequisites)
    ) {
      throw new Error("Observation-history v3 publication positions are invalid");
    }
  }
  return plan;
}

export async function finalizeObservationHistoryIndexV3Publication({
  plan,
  putIfChanged,
  getObject,
  recordDurableEvidence,
}) {
  validatePublicationPlan(plan);
  if (
    typeof putIfChanged !== "function" ||
    typeof getObject !== "function" ||
    typeof recordDurableEvidence !== "function"
  ) {
    throw new TypeError(
      "V3 publication finaliser requires putIfChanged, getObject and recordDurableEvidence adapters",
    );
  }
  const completed = new Map();
  const externalByKey = new Map(
    plan.external_references.map((entry) => [entry.key, entry]),
  );
  const evidence = [];
  for (const entry of plan.entries) {
    for (const [relationship, reference] of [
      ...entry.dependencies.map((dependency) =>
        ["content dependency", dependency]
      ),
      ...entry.publication_prerequisites.map((prerequisite) =>
        ["order prerequisite", prerequisite]
      ),
    ]) {
      const completedDependency = completed.get(reference.key);
      const externalDependency = externalByKey.get(reference.key);
      if (
        completedDependency?.verified !== true ||
        completedDependency?.durable !== true
      ) {
        if (
          externalDependency?.verified !== true ||
          externalDependency?.durable !== true
        ) {
          throw new Error(
            `V3 dependent publication blocked by incomplete ${relationship}: ${reference.key} -> ${entry.key}`,
          );
        }
      }
    }
    const putResult = await putIfChanged({
      key: entry.key,
      body: Buffer.from(entry.body),
      byte_size: entry.byte_size,
      sha256: entry.sha256,
      content_type: entry.content_type,
      publication_stage: entry.publication_stage,
    });
    if (!putResult || putResult.ok === false) {
      throw new Error(`V3 publication PUT failed: ${entry.key}`);
    }
    const fetched = await getObject({ key: entry.key });
    const fetchedBody = Buffer.isBuffer(fetched?.body)
      ? Buffer.from(fetched.body)
      : Buffer.from(fetched?.body ?? "");
    if (
      fetchedBody.byteLength !== entry.byte_size ||
      sha256Hex(fetchedBody) !== entry.sha256
    ) {
      throw new Error(`V3 post-PUT GET verification failed: ${entry.key}`);
    }
    const durableResult = await recordDurableEvidence({
      key: entry.key,
      byte_size: entry.byte_size,
      sha256: entry.sha256,
      publication_stage: entry.publication_stage,
      put_status: String(putResult.status || "succeeded"),
      post_put_get_verified: true,
      schedule_sha256: plan.schedule_sha256,
      position: entry.position,
    });
    if (!durableResult || durableResult.durable !== true) {
      throw new Error(`V3 durable publication evidence failed: ${entry.key}`);
    }
    const entryEvidence = Object.freeze({
      key: entry.key,
      byte_size: entry.byte_size,
      sha256: entry.sha256,
      publication_stage: entry.publication_stage,
      put_status: String(putResult.status || "succeeded"),
      verified: true,
      durable: true,
    });
    completed.set(entry.key, entryEvidence);
    evidence.push(entryEvidence);
  }
  return Object.freeze({
    ok: true,
    status: "succeeded",
    schedule_sha256: plan.schedule_sha256,
    published_object_count: evidence.length,
    objects: Object.freeze(evidence),
  });
}
