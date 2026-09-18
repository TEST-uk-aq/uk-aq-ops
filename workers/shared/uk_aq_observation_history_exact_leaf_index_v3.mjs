// @ts-nocheck -- shared deterministic exact-leaf builder for Node writers.
import { Buffer } from "node:buffer";

import {
  buildObservationHistoryIndexV3PublicationPlan,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
  validateObservationHistoryTargetMetadataForV3,
} from "./uk_aq_observation_history_index_v3.mjs";
import {
  OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE,
  OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
} from "./uk_aq_observation_history_target_writer.mjs";
import {
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
import { sha256Hex } from "./r2_sigv4.mjs";

export {
  buildObservationHistoryIndexV3PublicationPlan,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
};

export const OBSERVATION_HISTORY_EXACT_LEAF_INDEX_GENERATION_V3 = "v3";
export const OBSERVATION_HISTORY_EXACT_LEAF_SCHEMA_VERSION_V3 = 1;
export const OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3 =
  "observation_timeseries_physical_leaf_scoped_manifest";
export const OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3 =
  "observation_timeseries_physical_leaf";
export const DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT =
  "history/_index_v3/observations_timeseries";
export const DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";
export const DEFAULT_OBSERVATION_HISTORY_ALIGNED_SOURCE_INDEX_V3_ROOT =
  `${DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT}/_aligned`;

const SHARD_WIDTH = 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_VALIDATION_LAYOUT = "timeseries-bounded-v1";

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function normalizePrefix(value, label) {
  const prefix = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${label} is invalid`);
  }
  return prefix;
}

function normalizeKey(value, label) {
  const key = String(value || "").trim().replace(/^\/+/, "");
  if (!key || key.endsWith("/")) throw new TypeError(`${label} is invalid`);
  return key;
}

function integer(value, label, { zero = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (zero ? number < 0 : number <= 0)) {
    throw new TypeError(`${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  }
  return number;
}

function exactSha256(value, label) {
  const sha256 = String(value || "").trim();
  if (!SHA256.test(sha256)) throw new TypeError(`${label} must be lower-case SHA-256`);
  return sha256;
}

function identity(value, label, kind = null) {
  const result = {
    key: normalizeKey(value?.key, `${label}.key`),
    byte_size: integer(value?.byte_size, `${label}.byte_size`),
    sha256: exactSha256(value?.sha256, `${label}.sha256`),
  };
  return kind ? { ...result, kind } : result;
}

function artifact({ kind, key, payload, dependencies = [], prerequisites = [], stage }) {
  const body = encodeObservationHistoryIndexV3Json(payload);
  const bytes = Buffer.from(body, "utf8");
  return Object.freeze({
    kind,
    key: normalizeKey(key, `${kind}.key`),
    payload: Object.freeze(payload),
    body,
    byte_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage,
    dependencies: Object.freeze([...dependencies].sort((left, right) =>
      bytewiseCompare(left.key, right.key)
    )),
    publication_prerequisites: Object.freeze([...prerequisites].sort((left, right) =>
      bytewiseCompare(left.key, right.key)
    )),
  });
}

function scopePath(scope) {
  return `day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}`;
}

function normalizeScope(scope) {
  const dayUtc = String(scope?.day_utc || "");
  const parsed = new Date(`${dayUtc}T00:00:00.000Z`);
  const connectorId = integer(scope?.connector_id, "scope.connector_id");
  const pollutantCode = String(scope?.pollutant_code || "").trim().toLowerCase();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) ||
    Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dayUtc ||
    !/^[a-z0-9_]+$/.test(pollutantCode)
  ) throw new TypeError("exact-leaf scope is invalid");
  return Object.freeze({
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
  });
}

function commonPayload(kind, scope) {
  return {
    schema_version: OBSERVATION_HISTORY_EXACT_LEAF_SCHEMA_VERSION_V3,
    kind,
    index_generation: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_GENERATION_V3,
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    aligned_row_cap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
    exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
    ...scope,
  };
}

function fileDescriptor(raw) {
  return Object.freeze({
    key: normalizeKey(raw.key, "file.key"),
    byte_size: integer(raw.byte_size, "file.byte_size"),
    sha256: exactSha256(raw.sha256, "file.sha256"),
    row_count: integer(raw.row_count, "file.row_count"),
    row_group_count: integer(raw.row_group_count, "file.row_group_count"),
    ...(raw.etag ? { etag: String(raw.etag) } : {}),
  });
}

function validateRange(raw, file, rowCount, label) {
  const start = integer(raw?.start, `${label}.start`, { zero: true });
  const end = integer(raw?.end, `${label}.end`);
  const dataPageOffset = integer(
    raw?.data_page_offset,
    `${label}.data_page_offset`,
    { zero: true },
  );
  const dictionaryPageOffset = raw?.dictionary_page_offset === null
    ? null
    : integer(raw?.dictionary_page_offset, `${label}.dictionary_page_offset`, { zero: true });
  if (
    start >= end || end > file.byte_size || dataPageOffset < start || dataPageOffset >= end ||
    (dictionaryPageOffset === null && start !== dataPageOffset) ||
    (dictionaryPageOffset !== null &&
      (dictionaryPageOffset !== start || dictionaryPageOffset >= dataPageOffset)) ||
    integer(raw?.num_values, `${label}.num_values`) !== rowCount
  ) throw new Error(`${label} is outside or contradicts its pinned file`);
  return Object.freeze({
    start,
    end,
    data_page_offset: dataPageOffset,
    dictionary_page_offset: dictionaryPageOffset,
    num_values: rowCount,
  });
}

function normalizedTarget(metadata) {
  if (
    !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
    !Array.isArray(metadata.files) || !Array.isArray(metadata.segments) ||
    metadata?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
    metadata.aligned_row_cap !== OBSERVATION_HISTORY_ALIGNED_ROW_CAP ||
    metadata.exact_leaf_index_version !== OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION ||
    encodeObservationHistoryIndexV3Json(metadata.decode_profile) !==
      encodeObservationHistoryIndexV3Json(OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE)
  ) throw new Error("target metadata does not pin the selected exact-leaf layout/profile");
  if (
    metadata.files.some((file) =>
      file?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
      !Array.isArray(file.row_groups) || file.row_groups.some((rowGroup) =>
        !Array.isArray(rowGroup?.segments) || rowGroup.segments.some((segment) =>
          segment?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION
        )
      )
    ) ||
    metadata.segments.some((segment) =>
      segment?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION
    )
  ) throw new Error("target files/segments do not pin timeseries-aligned-v2");
  // Reuse the mature logical/file/segment validator without making the
  // retained provisional shard builder emit aligned-v2 objects. The view
  // changes only its legacy layout discriminator; selected-layout fields and
  // exact column ranges are validated against the original metadata below.
  const validationSegment = (segment) => ({
    ...segment,
    physical_layout_version: LEGACY_VALIDATION_LAYOUT,
  });
  const validationMetadata = {
    ...metadata,
    physical_layout_version: LEGACY_VALIDATION_LAYOUT,
    files: metadata.files.map((file) => ({
      ...file,
      physical_layout_version: LEGACY_VALIDATION_LAYOUT,
      row_groups: file.row_groups.map((rowGroup) => ({
        ...rowGroup,
        segments: rowGroup.segments.map(validationSegment),
      })),
    })),
    segments: metadata.segments.map(validationSegment),
  };
  const validated = validateObservationHistoryTargetMetadataForV3(
    validationMetadata,
  );
  const files = new Map(metadata.files.map((raw) => {
    const file = fileDescriptor(raw);
    return [file.key, file];
  }));
  const segmentsByTimeseries = new Map();
  const segments = metadata.segments.map((raw, index) => {
    const file = files.get(raw.file_key);
    if (!file) throw new Error("exact segment names an undeclared file");
    const rowCount = integer(raw.row_count, `segments[${index}].row_count`);
    if (
      rowCount > OBSERVATION_HISTORY_ALIGNED_ROW_CAP ||
      raw.row_group_row_start !== 0 ||
      integer(raw.row_group_ordinal, `segments[${index}].row_group_ordinal`, { zero: true }) >=
        file.row_group_count
    ) throw new Error("exact segment is not one complete cap-1024 row group");
    const segment = Object.freeze({
      timeseries_id: integer(raw.timeseries_id, `segments[${index}].timeseries_id`),
      file_key: file.key,
      row_group_ordinal: Number(raw.row_group_ordinal),
      row_start: integer(raw.row_start, `segments[${index}].row_start`, { zero: true }),
      row_group_row_start: 0,
      row_count: rowCount,
      min_observed_at_utc: String(raw.min_observed_at_utc),
      max_observed_at_utc: String(raw.max_observed_at_utc),
      column_ranges: Object.freeze({
        observed_at_utc: validateRange(
          raw.column_ranges?.observed_at_utc,
          file,
          rowCount,
          `segments[${index}].observed_at_utc`,
        ),
        value: validateRange(
          raw.column_ranges?.value,
          file,
          rowCount,
          `segments[${index}].value`,
        ),
      }),
    });
    const list = segmentsByTimeseries.get(segment.timeseries_id) || [];
    list.push(segment);
    segmentsByTimeseries.set(segment.timeseries_id, list);
    return segment;
  });
  for (const [timeseriesId, list] of segmentsByTimeseries) {
    list.sort((left, right) =>
      bytewiseCompare(left.min_observed_at_utc, right.min_observed_at_utc) ||
      bytewiseCompare(left.file_key, right.file_key) ||
      left.row_group_ordinal - right.row_group_ordinal
    );
    for (let index = 1; index < list.length; index += 1) {
      if (list[index].min_observed_at_utc < list[index - 1].max_observed_at_utc) {
        throw new Error(`exact segments regress for timeseries_id=${timeseriesId}`);
      }
    }
  }
  if (
    validated.row_count <= 0 ||
    segments.length === 0 ||
    segmentsByTimeseries.size === 0
  ) {
    throw new Error(
      "exact-v3 publication requires a non-empty canonical scope",
    );
  }
  return Object.freeze({
    scope: normalizeScope(validated.scope),
    row_count: validated.row_count,
    files,
    segments: Object.freeze(segments),
    timeseries: segmentsByTimeseries,
  });
}

function canonicalManifestDescriptor(raw, normalized) {
  const descriptor = {
    key: normalizeKey(raw?.key, "canonical_manifest.key"),
    byte_size: integer(raw?.byte_size, "canonical_manifest.byte_size"),
    sha256: exactSha256(raw?.sha256, "canonical_manifest.sha256"),
    manifest_hash: exactSha256(raw?.manifest_hash, "canonical_manifest.manifest_hash"),
    row_count: integer(raw?.row_count, "canonical_manifest.row_count", { zero: true }),
    observation_content_hash: exactSha256(
      raw?.observation_content_hash,
      "canonical_manifest.observation_content_hash",
    ),
  };
  if (
    descriptor.row_count !== normalized.row_count ||
    !descriptor.key.endsWith(`/${scopePath(normalized.scope)}/manifest.json`)
  ) throw new Error("canonical manifest contradicts exact-leaf target metadata");
  return Object.freeze(descriptor);
}

function rangeStart(timeseriesId) {
  return Math.floor(timeseriesId / SHARD_WIDTH) * SHARD_WIDTH;
}

function rangeName(start) {
  return `${String(start).padStart(6, "0")}-${String(start + SHARD_WIDTH - 1).padStart(6, "0")}`;
}

function alignedShardKey(indexRoot, scope, start) {
  return `${indexRoot}/_aligned/${scopePath(scope)}/range=${rangeName(start)}.json`;
}

function alignedManifestKey(indexRoot, scope) {
  return `${indexRoot}/_aligned/${scopePath(scope)}/manifest.json`;
}

function leafKey(indexRoot, scope, timeseriesId) {
  return `${indexRoot}/${scopePath(scope)}/timeseries_id=${String(timeseriesId).padStart(9, "0")}.json`;
}

function scopedManifestKey(indexRoot, scope) {
  return `${indexRoot}/${scopePath(scope)}/manifest.json`;
}

function timeseriesEntry(timeseriesId, segments) {
  return Object.freeze({
    timeseries_id: timeseriesId,
    row_count: segments.reduce((sum, segment) => sum + segment.row_count, 0),
    min_observed_at_utc: segments[0].min_observed_at_utc,
    max_observed_at_utc: segments.at(-1).max_observed_at_utc,
    segments: Object.freeze(segments.map((segment) => Object.freeze({ ...segment }))),
  });
}

function buildAlignedSourceShard({ normalized, source, indexRoot, start }) {
  const ids = [...normalized.timeseries.keys()]
    .filter((timeseriesId) => rangeStart(timeseriesId) === start)
    .sort((left, right) => left - right);
  const timeseries = ids.map((timeseriesId) =>
    timeseriesEntry(timeseriesId, normalized.timeseries.get(timeseriesId))
  );
  const fileKeys = new Set(timeseries.flatMap((entry) =>
    entry.segments.map((segment) => segment.file_key)
  ));
  const files = [...normalized.files.values()]
    .filter((file) => fileKeys.has(file.key))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  const key = alignedShardKey(indexRoot, normalized.scope, start);
  const payload = {
    ...commonPayload("observation_timeseries_aligned_source_shard", normalized.scope),
    key,
    range_start: start,
    range_end: start + SHARD_WIDTH - 1,
    canonical_source_manifest: source,
    files,
    timeseries,
  };
  return artifact({
    kind: "observation_history_index_v3_aligned_source_shard",
    key,
    payload,
    dependencies: files.map((file) => identity(file, "aligned file", "canonical_parquet")),
    prerequisites: [identity(source, "canonical manifest", "canonical_manifest")],
    stage: "child_shard",
  });
}

function buildAlignedSourceManifest({ normalized, source, indexRoot, shards }) {
  const key = alignedManifestKey(indexRoot, normalized.scope);
  const payload = {
    ...commonPayload("observation_timeseries_aligned_source_manifest", normalized.scope),
    key,
    canonical_source_manifest: source,
    children: shards.map((entry) => ({
      ...identity(entry, "aligned shard"),
      range_start: entry.payload.range_start,
      range_end: entry.payload.range_end,
    })),
  };
  return artifact({
    kind: "observation_history_index_v3_aligned_source_manifest",
    key,
    payload,
    dependencies: [
      identity(source, "canonical manifest", "canonical_manifest"),
      ...shards.map((entry) => identity(entry, "aligned shard", "child_shard")),
    ],
    stage: "scoped_manifest",
  });
}

function buildExactLeaf({ normalized, indexRoot, timeseriesId, alignedShard }) {
  const entry = timeseriesEntry(timeseriesId, normalized.timeseries.get(timeseriesId));
  const fileKeys = new Set(entry.segments.map((segment) => segment.file_key));
  const files = [...normalized.files.values()]
    .filter((file) => fileKeys.has(file.key))
    .sort((left, right) => bytewiseCompare(left.key, right.key));
  const key = leafKey(indexRoot, normalized.scope, timeseriesId);
  const payload = {
    ...commonPayload(OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3, normalized.scope),
    key,
    timeseries_id: timeseriesId,
    row_count: entry.row_count,
    min_observed_at_utc: entry.min_observed_at_utc,
    max_observed_at_utc: entry.max_observed_at_utc,
    source_aligned_child: identity(alignedShard, "source aligned child"),
    files,
    segments: entry.segments,
  };
  return artifact({
    kind: "observation_history_index_v3_exact_leaf",
    key,
    payload,
    dependencies: [
      identity(alignedShard, "aligned shard", "child_shard"),
      ...files.map((file) => identity(file, "leaf file", "canonical_parquet")),
    ],
    stage: "child_shard",
  });
}

function buildExactScopedManifest({ normalized, indexRoot, alignedManifest, leaves }) {
  const key = scopedManifestKey(indexRoot, normalized.scope);
  const orderedLeaves = [...leaves].sort((left, right) =>
    left.payload.timeseries_id - right.payload.timeseries_id
  );
  const coverageMin = orderedLeaves.reduce((minimum, leaf) => {
    const candidate = leaf.payload.min_observed_at_utc;
    if (candidate === null || candidate === undefined) return minimum;
    return minimum === null || candidate < minimum ? candidate : minimum;
  }, null);
  const coverageMax = orderedLeaves.reduce((maximum, leaf) => {
    const candidate = leaf.payload.max_observed_at_utc;
    if (candidate === null || candidate === undefined) return maximum;
    return maximum === null || candidate > maximum ? candidate : maximum;
  }, null);
  const payload = {
    ...commonPayload(OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3, normalized.scope),
    key,
    source_aligned_scoped_manifest: identity(alignedManifest, "aligned manifest"),
    decode_profile: OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE,
    coverage: {
      row_count: normalized.row_count,
      timeseries_count: orderedLeaves.length,
      min_observed_at_utc: coverageMin,
      max_observed_at_utc: coverageMax,
      physical_file_count: normalized.files.size,
      physical_leaf_count: orderedLeaves.length,
    },
    leaf_descriptor_fields: ["key", "byte_size", "sha256"],
    leaves_by_timeseries_id: Object.fromEntries(orderedLeaves.map((leaf) => [
      String(leaf.payload.timeseries_id),
      [leaf.key, leaf.byte_size, leaf.sha256],
    ])),
  };
  return artifact({
    kind: "observation_history_index_v3_exact_leaf_scoped_manifest",
    key,
    payload,
    dependencies: [
      identity(alignedManifest, "aligned manifest", "scoped_manifest"),
      ...orderedLeaves.map((leaf) => identity(leaf, "exact leaf", "child_shard")),
    ],
    stage: "scoped_manifest",
  });
}

export function buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
  metadata,
  canonicalManifest,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
}) {
  const normalized = normalizedTarget(metadata);
  const source = canonicalManifestDescriptor(canonicalManifest, normalized);
  const root = normalizePrefix(indexRoot, "indexRoot");
  const starts = [...new Set([...normalized.timeseries.keys()].map(rangeStart))]
    .sort((left, right) => left - right);
  const alignedShards = starts.map((start) =>
    buildAlignedSourceShard({ normalized, source, indexRoot: root, start })
  );
  const alignedByStart = new Map(
    alignedShards.map((entry) => [entry.payload.range_start, entry]),
  );
  const alignedManifest = buildAlignedSourceManifest({
    normalized,
    source,
    indexRoot: root,
    shards: alignedShards,
  });
  const leaves = [...normalized.timeseries.keys()]
    .sort((left, right) => left - right)
    .map((timeseriesId) => buildExactLeaf({
      normalized,
      indexRoot: root,
      timeseriesId,
      alignedShard: alignedByStart.get(rangeStart(timeseriesId)),
    }));
  const scopedManifest = buildExactScopedManifest({
    normalized,
    indexRoot: root,
    alignedManifest,
    leaves,
  });
  const publicationObjects = [
    ...alignedShards,
    ...leaves,
    alignedManifest,
    scopedManifest,
  ];
  return Object.freeze({
    aligned_source_shards: Object.freeze(alignedShards),
    aligned_source_manifest: alignedManifest,
    exact_leaves: Object.freeze(leaves),
    child_shards: Object.freeze(leaves),
    scoped_manifest: scopedManifest,
    publication_objects: Object.freeze(publicationObjects),
  });
}

function artifactBodyIsExact(raw, expectedKind, expectedStage) {
  if (raw?.kind !== expectedKind || raw?.publication_stage !== expectedStage) {
    throw new Error(`unexpected exact-leaf artifact kind/stage: ${raw?.key || "unset"}`);
  }
  const body = String(raw.body || "");
  const bytes = Buffer.from(body, "utf8");
  if (
    body !== encodeObservationHistoryIndexV3Json(raw.payload) ||
    bytes.byteLength !== raw.byte_size || sha256Hex(bytes) !== raw.sha256
  ) throw new Error(`exact-leaf artifact identity mismatch: ${raw.key}`);
  return raw;
}

export function validateObservationHistoryExactLeafArtifactV3({ artifact: raw }) {
  const value = artifactBodyIsExact(
    raw,
    "observation_history_index_v3_exact_leaf",
    "child_shard",
  );
  if (
    value.payload?.kind !== OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3 ||
    value.payload?.physical_layout_version !== OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION ||
    value.payload?.aligned_row_cap !== OBSERVATION_HISTORY_ALIGNED_ROW_CAP ||
    value.payload?.exact_leaf_index_version !== OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION ||
    !Array.isArray(value.payload?.segments) || !Array.isArray(value.payload?.files)
  ) throw new Error(`exact-leaf payload is contradictory: ${value.key}`);
  return Object.freeze({ artifact: value });
}

export function validateObservationHistoryExactLeafScopedManifestArtifactV3({
  artifact: raw,
  exactLeaves,
}) {
  const value = artifactBodyIsExact(
    raw,
    "observation_history_index_v3_exact_leaf_scoped_manifest",
    "scoped_manifest",
  );
  if (
    value.payload?.kind !== OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3 ||
    encodeObservationHistoryIndexV3Json(value.payload?.decode_profile) !==
      encodeObservationHistoryIndexV3Json(OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE)
  ) throw new Error(`exact-leaf scoped payload is contradictory: ${value.key}`);
  const leaves = (Array.isArray(exactLeaves) ? exactLeaves : []).map((leaf) =>
    validateObservationHistoryExactLeafArtifactV3({ artifact: leaf }).artifact
  );
  const expected = Object.fromEntries(leaves
    .sort((left, right) => left.payload.timeseries_id - right.payload.timeseries_id)
    .map((leaf) => [
      String(leaf.payload.timeseries_id),
      [leaf.key, leaf.byte_size, leaf.sha256],
    ]));
  if (
    encodeObservationHistoryIndexV3Json(value.payload.leaves_by_timeseries_id) !==
      encodeObservationHistoryIndexV3Json(expected)
  ) throw new Error(`exact-leaf scoped membership is incomplete: ${value.key}`);
  return Object.freeze({ artifact: value });
}

function scopedRootDescriptor(scopedManifest) {
  const payload = scopedManifest.payload;
  return Object.freeze({
    day_utc: payload.day_utc,
    connector_id: payload.connector_id,
    pollutant_code: payload.pollutant_code,
    key: scopedManifest.key,
    byte_size: scopedManifest.byte_size,
    sha256: scopedManifest.sha256,
    row_count: payload.coverage.row_count,
    timeseries_count: payload.coverage.timeseries_count,
    child_shard_count: payload.coverage.physical_leaf_count,
    physical_leaf_count: payload.coverage.physical_leaf_count,
    physical_file_count: payload.coverage.physical_file_count,
    min_observed_at_utc: payload.coverage.min_observed_at_utc,
    max_observed_at_utc: payload.coverage.max_observed_at_utc,
  });
}

function latestPayload(roots, indexRoot, latestKey) {
  const byDay = new Map();
  for (const root of roots) {
    const list = byDay.get(root.day_utc) || [];
    list.push(root);
    byDay.set(root.day_utc, list);
  }
  const daySummaries = [...byDay.entries()]
    .sort(([left], [right]) => bytewiseCompare(left, right))
    .map(([dayUtc, scopedRoots]) => ({
      day_utc: dayUtc,
      row_count: scopedRoots.reduce((sum, entry) => sum + entry.row_count, 0),
      scoped_root_count: scopedRoots.length,
      connector_ids: [...new Set(scopedRoots.map((entry) => entry.connector_id))]
        .sort((left, right) => left - right),
      pollutant_codes: [...new Set(scopedRoots.map((entry) => entry.pollutant_code))]
        .sort(bytewiseCompare),
      scoped_roots: scopedRoots,
    }));
  const days = daySummaries.map((entry) => entry.day_utc);
  return {
    schema_version: 3,
    kind: "observation_timeseries_latest_global",
    index_generation: "v3",
    history_version: "v2",
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    aligned_row_cap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
    exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
    index_root: indexRoot,
    min_day_utc: days[0],
    max_day_utc: days.at(-1),
    day_count: days.length,
    scoped_root_count: roots.length,
    child_shard_count: roots.reduce((sum, entry) => sum + entry.child_shard_count, 0),
    physical_leaf_count: roots.reduce((sum, entry) => sum + entry.physical_leaf_count, 0),
    physical_file_reference_count:
      roots.reduce((sum, entry) => sum + entry.physical_file_count, 0),
    total_rows: roots.reduce((sum, entry) => sum + entry.row_count, 0),
    days,
    key_layout: {
      scoped_manifest_key_template:
        `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}` +
        "/pollutant_code={pollutant_code}/manifest.json",
      exact_leaf_key_template:
        `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}` +
        "/pollutant_code={pollutant_code}/timeseries_id={timeseries_id_9}.json",
      aligned_source_index_root: `${indexRoot}/_aligned`,
      latest_key: latestKey,
    },
    day_summaries: daySummaries,
  };
}

function rootsFromHierarchies(scopedHierarchies) {
  if (!Array.isArray(scopedHierarchies) || scopedHierarchies.length === 0) {
    throw new Error("exact-leaf latest requires scoped hierarchies");
  }
  const roots = scopedHierarchies.map((hierarchy) => {
    const scoped = validateObservationHistoryExactLeafScopedManifestArtifactV3({
      artifact: hierarchy.scoped_manifest,
      exactLeaves: hierarchy.exact_leaves ?? hierarchy.child_shards,
    }).artifact;
    return scopedRootDescriptor(scoped);
  });
  return roots.sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    left.connector_id - right.connector_id ||
    bytewiseCompare(left.pollutant_code, right.pollutant_code)
  );
}

function latestArtifactFromRoots(roots, indexRoot, latestKey) {
  return artifact({
    kind: "observation_history_index_v3_latest_global",
    key: latestKey,
    payload: latestPayload(roots, indexRoot, latestKey),
    dependencies: roots.map((root) => identity(root, "scoped root", "scoped_manifest")),
    stage: "latest_global",
  });
}

export function buildObservationHistoryExactLeafIndexV3Latest({
  scopedHierarchies,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
}) {
  return latestArtifactFromRoots(
    rootsFromHierarchies(scopedHierarchies),
    normalizePrefix(indexRoot, "indexRoot"),
    normalizeKey(latestKey, "latestKey"),
  );
}

function rootIdentity(scope) {
  return `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
}

function rootsFromLatestArtifact(existingLatest) {
  artifactBodyIsExact(
    existingLatest,
    "observation_history_index_v3_latest_global",
    "latest_global",
  );
  return (Array.isArray(existingLatest.payload?.day_summaries)
    ? existingLatest.payload.day_summaries
    : []).flatMap((day) => Array.isArray(day?.scoped_roots) ? day.scoped_roots : []);
}

export function updateObservationHistoryExactLeafIndexV3Latest({
  existingLatest,
  replacementScopedManifests = [],
  removedScopes = [],
  indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
}) {
  const byScope = new Map(
    rootsFromLatestArtifact(existingLatest).map((root) => [rootIdentity(root), root]),
  );
  for (const scoped of replacementScopedManifests) {
    artifactBodyIsExact(
      scoped,
      "observation_history_index_v3_exact_leaf_scoped_manifest",
      "scoped_manifest",
    );
    const descriptor = scopedRootDescriptor(scoped);
    byScope.set(rootIdentity(descriptor), descriptor);
  }
  for (const scope of removedScopes) byScope.delete(rootIdentity(normalizeScope(scope)));
  const roots = [...byScope.values()].sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    left.connector_id - right.connector_id ||
    bytewiseCompare(left.pollutant_code, right.pollutant_code)
  );
  if (!roots.length) throw new Error("exact-leaf latest update cannot remove every scoped root");
  return latestArtifactFromRoots(
    roots,
    normalizePrefix(indexRoot, "indexRoot"),
    normalizeKey(latestKey, "latestKey"),
  );
}

export function validateObservationHistoryExactLeafIndexV3LatestArtifact({
  artifact: raw,
  scopedHierarchies,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
}) {
  artifactBodyIsExact(raw, "observation_history_index_v3_latest_global", "latest_global");
  const expected = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies,
    indexRoot,
    latestKey,
  });
  if (raw.key !== expected.key || raw.body !== expected.body) {
    throw new Error("exact-leaf latest payload is contradictory");
  }
  return Object.freeze({ artifact: raw });
}
