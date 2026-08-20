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
import { sha256Hex } from "./r2_sigv4.mjs";

export const OBSERVATION_HISTORY_INDEX_GENERATION_V3 = "v3";
export const OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3 = 3;
export const OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3 = 1000;
export const DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT =
  "history/_index_v3/observations_timeseries";
export const DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";
export const OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT =
  "observation-history-index-v3-publication-v1";

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

function artifactFromPayload({ kind, key, payload, dependencies, stage }) {
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
  ).trim().toLowerCase();
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

function normalizeCanonicalManifest(raw, scope, metadata) {
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
    row_count: positiveSafeInteger(
      raw.row_count,
      "canonical_manifest.row_count",
    ),
    observation_content_hash: normalizeSha256(
      raw.observation_content_hash,
      "canonical_manifest.observation_content_hash",
    ),
  };
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
  const expectedScopeToken =
    `/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
  if (!descriptor.key.endsWith(expectedScopeToken)) {
    throw new Error("Canonical manifest key disagrees with Phase 1 partition");
  }
  return Object.freeze(descriptor);
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
  const rowCount = positiveSafeInteger(metadata.row_count, "metadata.row_count");
  validateObservationContentHashMetadata(metadata, { rowCount });
  const files = (Array.isArray(metadata.files) ? metadata.files : [])
    .map(normalizeFile)
    .sort((left, right) => left.file_ordinal - right.file_ordinal);
  if (
    files.length === 0 ||
    files.length !== positiveSafeInteger(metadata.file_count, "metadata.file_count")
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
    canonical_source_manifest: source,
    coverage: null,
    files,
    timeseries,
  };
  payload.coverage = childCoverage(payload);
  const dependencies = [
    identityDescriptor({ ...source, kind: "canonical_manifest" }),
    ...files.map((file) =>
      identityDescriptor({ ...file, kind: "canonical_parquet" })
    ),
  ];
  return artifactFromPayload({
    kind: "observation_history_index_v3_child_shard",
    key: buildObservationHistoryIndexV3ChildShardKey({
      scope: normalized.scope,
      rangeStart: normalizedRangeStart,
      indexRoot,
    }),
    payload,
    dependencies,
    stage: "child_shard",
  });
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
  };
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
  if (!Array.isArray(childShards) || childShards.length === 0) {
    throw new Error("Scoped v3 manifest requires child shard dependencies");
  }
  const children = childShards.map((rawArtifact) => {
    const artifact = validateArtifact(
      rawArtifact,
      "observation_history_index_v3_child_shard",
      "child_shard",
    );
    const payload = artifact.payload;
    if (
      payload.day_utc !== normalized.scope.day_utc ||
      payload.connector_id !== normalized.scope.connector_id ||
      payload.pollutant_code !== normalized.scope.pollutant_code ||
      !sameJson(payload.canonical_source_manifest, source)
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
  return artifactFromPayload({
    kind: "observation_history_index_v3_scoped_manifest",
    key: buildObservationHistoryIndexV3ScopedManifestKey({
      scope: normalized.scope,
      indexRoot,
    }),
    payload,
    dependencies,
    stage: "scoped_manifest",
  });
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

export function buildObservationHistoryIndexV3Latest({
  scopedManifests,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_INDEX_V3_LATEST_KEY,
}) {
  if (!Array.isArray(scopedManifests) || scopedManifests.length === 0) {
    throw new Error("V3 latest/global metadata requires scoped dependencies");
  }
  const normalizedIndexRoot = normalizePrefix(indexRoot, "index_root");
  const roots = scopedManifests.map((rawArtifact) => {
    const artifact = validateArtifact(
      rawArtifact,
      "observation_history_index_v3_scoped_manifest",
      "scoped_manifest",
    );
    const expectedKey = buildObservationHistoryIndexV3ScopedManifestKey({
      scope: artifact.payload,
      indexRoot: normalizedIndexRoot,
    });
    if (artifact.key !== expectedKey) {
      throw new Error("V3 latest/global metadata received a non-canonical root");
    }
    return { artifact, descriptor: scopedRootDescriptor(artifact) };
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
  const payload = {
    schema_version: OBSERVATION_HISTORY_INDEX_SCHEMA_VERSION_V3,
    kind: "observation_timeseries_latest_global",
    index_generation: OBSERVATION_HISTORY_INDEX_GENERATION_V3,
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    shard_width: OBSERVATION_HISTORY_INDEX_SHARD_WIDTH_V3,
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
      latest_key: normalizeKey(latestKey, "latest_key"),
    },
    day_summaries: daySummaries,
  };
  return artifactFromPayload({
    kind: "observation_history_index_v3_latest_global",
    key: normalizeKey(latestKey, "latest_key"),
    payload,
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
  const dependencies = (Array.isArray(raw.dependencies) ? raw.dependencies : [])
    .map((dependency) => identityDescriptor(dependency))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  const dependencyKeys = new Set();
  for (const dependency of dependencies) {
    if (dependencyKeys.has(dependency.key)) {
      throw new Error(`Duplicate publication dependency: ${dependency.key}`);
    }
    dependencyKeys.add(dependency.key);
  }
  return {
    key,
    body,
    byte_size: byteSize,
    sha256,
    content_type: String(raw.content_type || "application/octet-stream"),
    publication_stage: stage,
    dependencies,
  };
}

function normalizeExternalDependency(raw) {
  const identity = identityDescriptor(raw);
  if (raw?.verified !== true || raw?.durable !== true) {
    throw new Error(
      `External v3 dependency lacks verified durable evidence: ${identity.key}`,
    );
  }
  return { ...identity, verified: true, durable: true };
}

function scheduleHashInput(plan) {
  return encodeObservationHistoryIndexV3Json({
    contract_version: plan.contract_version,
    tie_breaker: plan.tie_breaker,
    changed_dependency_edge_count: plan.changed_dependency_edge_count,
    external_dependency_count: plan.external_dependency_count,
    entries: plan.entries.map((entry) => ({
      position: entry.position,
      key: entry.key,
      byte_size: entry.byte_size,
      sha256: entry.sha256,
      publication_stage: entry.publication_stage,
      dependencies: entry.dependencies,
      changed_dependencies: entry.changed_dependencies,
      external_dependencies: entry.external_dependencies,
    })),
  });
}

export function buildObservationHistoryIndexV3PublicationPlan({
  objects,
  externalDependencies = [],
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
  for (const raw of externalDependencies) {
    const dependency = normalizeExternalDependency(raw);
    if (externalByKey.has(dependency.key) || byKey.has(dependency.key)) {
      throw new Error(`Duplicate external v3 dependency key: ${dependency.key}`);
    }
    externalByKey.set(dependency.key, dependency);
  }
  const indegree = new Map(normalizedObjects.map((object) => [object.key, 0]));
  const outgoing = new Map(normalizedObjects.map((object) => [object.key, []]));
  let changedEdgeCount = 0;
  for (const object of normalizedObjects) {
    for (const dependency of object.dependencies) {
      const changedDependency = byKey.get(dependency.key);
      const externalDependency = externalByKey.get(dependency.key);
      const resolved = changedDependency || externalDependency;
      if (!resolved) {
        throw new Error(
          `Missing required v3 publication dependency: ${dependency.key} -> ${object.key}`,
        );
      }
      if (
        resolved.byte_size !== dependency.byte_size ||
        resolved.sha256 !== dependency.sha256
      ) {
        throw new Error(
          `Contradictory v3 publication dependency identity: ${dependency.key} -> ${object.key}`,
        );
      }
      if (changedDependency) {
        if (
          PUBLICATION_STAGE_RANK[changedDependency.publication_stage] >
            PUBLICATION_STAGE_RANK[object.publication_stage]
        ) {
          throw new Error(
            `V3 publication stage conflict: ${dependency.key} -> ${object.key}`,
          );
        }
        outgoing.get(dependency.key).push(object.key);
        indegree.set(object.key, indegree.get(object.key) + 1);
        changedEdgeCount += 1;
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
    return {
      position: index + 1,
      key: object.key,
      body: object.body,
      byte_size: object.byte_size,
      sha256: object.sha256,
      content_type: object.content_type,
      publication_stage: object.publication_stage,
      dependencies: object.dependencies,
      changed_dependencies: changedDependencies,
      external_dependencies: externalDependencyKeys,
    };
  });
  const plan = {
    contract_version: OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONTRACT,
    tie_breaker: "publication_stage_then_bytewise_utf8_key_among_eligible_nodes",
    changed_dependency_edge_count: changedEdgeCount,
    external_dependency_count: externalByKey.size,
    external_dependencies: [...externalByKey.values()].sort((left, right) =>
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
    plan.entries.length === 0
  ) {
    throw new Error("Invalid observation-history v3 publication plan");
  }
  const expectedHash = sha256Hex(scheduleHashInput(plan));
  if (plan.schedule_sha256 !== expectedHash) {
    throw new Error("Observation-history v3 publication schedule identity mismatch");
  }
  for (const [index, entry] of plan.entries.entries()) {
    if (entry.position !== index + 1) {
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
    plan.external_dependencies.map((entry) => [entry.key, entry]),
  );
  const evidence = [];
  for (const entry of plan.entries) {
    for (const dependency of entry.dependencies) {
      const completedDependency = completed.get(dependency.key);
      const externalDependency = externalByKey.get(dependency.key);
      if (
        completedDependency?.verified !== true ||
        completedDependency?.durable !== true
      ) {
        if (
          externalDependency?.verified !== true ||
          externalDependency?.durable !== true
        ) {
          throw new Error(
            `V3 dependent publication blocked by incomplete dependency: ${dependency.key} -> ${entry.key}`,
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
