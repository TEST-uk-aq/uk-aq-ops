// @ts-nocheck -- pure scoped-manifest semantics shared by Node builders and Workers.
import {
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "./uk_aq_observation_history_schema.mjs";
import { normalizeObservationPropertyCode } from "./uk_aq_observation_property_code.mjs";

const INDEX_SCHEMA_VERSION = 3;
const INDEX_GENERATION = "v3";
const LOGICAL_HISTORY_VERSION = "v2";
const PHYSICAL_LAYOUT_VERSION = "timeseries-bounded-v1";
const SHARD_WIDTH = 1000;
const DEFAULT_INDEX_ROOT = "history/_index_v3/observations_timeseries";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function bytewiseCompare(left, right) {
  const leftBytes = textEncoder.encode(String(left));
  const rightBytes = textEncoder.encode(String(right));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(bytewiseCompare)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  if (typeof value === "string") return textEncoder.encode(value).buffer;
  throw new TypeError("Scoped v3 manifest body must be text or bytes");
}

function positiveSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return number;
}

function normalizeSha256(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must be lower-case SHA-256`);
  }
  return normalized;
}

function normalizeKey(value, fieldName) {
  const normalized = String(value || "").trim().replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) {
    throw new TypeError(`${fieldName} must be a non-empty object key`);
  }
  return normalized;
}

function normalizePrefix(value, fieldName) {
  const normalized = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new TypeError(`${fieldName} must be a prefix`);
  return normalized;
}

function normalizeIso(value, fieldName) {
  const normalized = String(value || "").trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new TypeError(`${fieldName} must be a canonical ISO timestamp`);
  }
  return normalized;
}

function normalizeDay(value, fieldName) {
  const normalized = String(value || "").trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    !ISO_DAY_PATTERN.test(normalized) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new TypeError(`${fieldName} must be a valid UTC day`);
  }
  return normalized;
}

function normalizeScope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Scoped v3 manifest scope must be an object");
  }
  const pollutantCode = normalizeObservationPropertyCode(raw.pollutant_code);
  if (!pollutantCode) {
    throw new TypeError("Scoped v3 manifest pollutant_code is invalid");
  }
  return Object.freeze({
    day_utc: normalizeDay(raw.day_utc, "scoped_manifest.day_utc"),
    connector_id: positiveSafeInteger(
      raw.connector_id,
      "scoped_manifest.connector_id",
    ),
    pollutant_code: pollutantCode,
  });
}

function rangeToken(rangeStart) {
  const rangeEnd = rangeStart + SHARD_WIDTH - 1;
  return `${String(rangeStart).padStart(6, "0")}-${String(rangeEnd).padStart(6, "0")}`;
}

function scopePrefix(scope, indexRoot) {
  return `${normalizePrefix(indexRoot, "index_root")}/day_utc=${scope.day_utc}` +
    `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`;
}

function scopedManifestKey(scope, indexRoot) {
  return `${scopePrefix(scope, indexRoot)}/manifest.json`;
}

function childShardKey(scope, rangeStart, indexRoot) {
  return `${scopePrefix(scope, indexRoot)}/range=${rangeToken(rangeStart)}.json`;
}

function identityDescriptor(raw, fieldName) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const descriptor = {
    key: normalizeKey(raw.key, `${fieldName}.key`),
    byte_size: positiveSafeInteger(raw.byte_size, `${fieldName}.byte_size`),
    sha256: normalizeSha256(raw.sha256, `${fieldName}.sha256`),
  };
  if (!sameJson(raw, descriptor)) {
    throw new Error(`${fieldName} has unsupported fields`);
  }
  return descriptor;
}

function canonicalSourceDescriptor(raw, scope) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("canonical_source_manifest must be an object");
  }
  const descriptor = {
    key: normalizeKey(raw.key, "canonical_source_manifest.key"),
    byte_size: positiveSafeInteger(
      raw.byte_size,
      "canonical_source_manifest.byte_size",
    ),
    sha256: normalizeSha256(raw.sha256, "canonical_source_manifest.sha256"),
    manifest_hash: normalizeSha256(
      raw.manifest_hash,
      "canonical_source_manifest.manifest_hash",
    ),
    row_count: nonNegativeSafeInteger(
      raw.row_count,
      "canonical_source_manifest.row_count",
    ),
    observation_content_hash: normalizeSha256(
      raw.observation_content_hash,
      "canonical_source_manifest.observation_content_hash",
    ),
  };
  const expectedScopeToken =
    `/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
  if (!descriptor.key.endsWith(expectedScopeToken)) {
    throw new Error("Canonical source manifest key disagrees with scoped identity");
  }
  if (!sameJson(raw, descriptor)) {
    throw new Error("Canonical source manifest descriptor has unsupported fields");
  }
  return descriptor;
}

function normalizeChildDescriptor(raw, scope, indexRoot) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Scoped v3 child descriptor must be an object");
  }
  const rangeStart = nonNegativeSafeInteger(
    raw.range_start,
    "child_descriptor.range_start",
  );
  if (rangeStart % SHARD_WIDTH !== 0) {
    throw new Error("Scoped v3 child range is not shard-aligned");
  }
  const rangeEnd = rangeStart + SHARD_WIDTH - 1;
  const timeseriesIds = (Array.isArray(raw.timeseries_ids)
    ? raw.timeseries_ids
    : []).map((value) =>
      positiveSafeInteger(value, "child_descriptor.timeseries_id")
    );
  for (const [index, timeseriesId] of timeseriesIds.entries()) {
    if (
      timeseriesId < rangeStart ||
      timeseriesId > rangeEnd ||
      (index > 0 && timeseriesIds[index - 1] >= timeseriesId)
    ) {
      throw new Error("Scoped v3 child descriptor has invalid timeseries coverage");
    }
  }
  const files = (Array.isArray(raw.files) ? raw.files : []).map(
    (file, index) => identityDescriptor(file, `child_descriptor.files[${index}]`),
  );
  for (let index = 1; index < files.length; index += 1) {
    if (bytewiseCompare(files[index - 1].key, files[index].key) >= 0) {
      throw new Error("Scoped v3 child file identities are not deterministic");
    }
  }
  const descriptor = {
    key: normalizeKey(raw.key, "child_descriptor.key"),
    byte_size: positiveSafeInteger(
      raw.byte_size,
      "child_descriptor.byte_size",
    ),
    sha256: normalizeSha256(raw.sha256, "child_descriptor.sha256"),
    range_start: rangeStart,
    range_end: Number(raw.range_end),
    timeseries_count: positiveSafeInteger(
      raw.timeseries_count,
      "child_descriptor.timeseries_count",
    ),
    timeseries_ids: timeseriesIds,
    row_count: positiveSafeInteger(
      raw.row_count,
      "child_descriptor.row_count",
    ),
    min_observed_at_utc: normalizeIso(
      raw.min_observed_at_utc,
      "child_descriptor.min_observed_at_utc",
    ),
    max_observed_at_utc: normalizeIso(
      raw.max_observed_at_utc,
      "child_descriptor.max_observed_at_utc",
    ),
    file_count: positiveSafeInteger(
      raw.file_count,
      "child_descriptor.file_count",
    ),
    files,
  };
  if (
    descriptor.range_end !== rangeEnd ||
    descriptor.timeseries_count !== timeseriesIds.length ||
    descriptor.file_count !== files.length ||
    descriptor.min_observed_at_utc > descriptor.max_observed_at_utc ||
    descriptor.key !== childShardKey(scope, rangeStart, indexRoot)
  ) {
    throw new Error("Scoped v3 child descriptor is contradictory");
  }
  if (!sameJson(raw, descriptor)) {
    throw new Error("Scoped v3 child descriptor has unsupported fields");
  }
  return descriptor;
}

export function buildObservationHistoryIndexV3ScopedManifestPayload({
  scope,
  canonicalSource,
  childDescriptors,
}) {
  const source = canonicalSource;
  const descriptors = childDescriptors;
  const timeseriesIds = [];
  const filesByKey = new Map();
  for (const [index, descriptor] of descriptors.entries()) {
    if (
      index > 0 &&
      descriptors[index - 1].range_start >= descriptor.range_start
    ) {
      throw new Error("Scoped v3 child descriptors are not deterministically ordered");
    }
    timeseriesIds.push(...descriptor.timeseries_ids);
    for (const file of descriptor.files) {
      const previous = filesByKey.get(file.key);
      if (previous && !sameJson(previous, file)) {
        throw new Error("Scoped v3 child descriptors contradict file identity");
      }
      filesByKey.set(file.key, file);
    }
  }
  if (new Set(timeseriesIds).size !== timeseriesIds.length) {
    throw new Error("Scoped v3 child descriptors duplicate timeseries coverage");
  }
  const coverage = {
    timeseries_count: timeseriesIds.length,
    timeseries_ids: [...timeseriesIds].sort((left, right) => left - right),
    row_count: descriptors.reduce((total, entry) => total + entry.row_count, 0),
    min_observed_at_utc: descriptors.reduce(
      (value, entry) =>
        value === null || entry.min_observed_at_utc < value
          ? entry.min_observed_at_utc
          : value,
      null,
    ),
    max_observed_at_utc: descriptors.reduce(
      (value, entry) =>
        value === null || entry.max_observed_at_utc > value
          ? entry.max_observed_at_utc
          : value,
      null,
    ),
    child_shard_count: descriptors.length,
    physical_file_count: filesByKey.size,
  };
  if (coverage.row_count !== source.row_count) {
    throw new Error("Scoped v3 descriptor rows disagree with canonical source");
  }
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    kind: "observation_timeseries_scoped_manifest",
    index_generation: INDEX_GENERATION,
    history_version: LOGICAL_HISTORY_VERSION,
    domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: PHYSICAL_LAYOUT_VERSION,
    shard_width: SHARD_WIDTH,
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    pollutant_code: scope.pollutant_code,
    canonical_source_manifest: source,
    coverage,
    children: descriptors,
  };
}

export function validateObservationHistoryIndexV3ScopedManifestBody({
  key,
  body,
  indexRoot = DEFAULT_INDEX_ROOT,
}) {
  const bodyBuffer = exactArrayBuffer(body);
  let bodyText;
  let payload;
  try {
    bodyText = textDecoder.decode(bodyBuffer);
    payload = JSON.parse(bodyText);
  } catch (_error) {
    throw new Error("Scoped v3 manifest body is not valid UTF-8 canonical JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Scoped v3 manifest payload must be an object");
  }
  const scope = normalizeScope(payload);
  const source = canonicalSourceDescriptor(
    payload.canonical_source_manifest,
    scope,
  );
  const descriptors = (Array.isArray(payload.children)
    ? payload.children
    : []).map((descriptor) =>
      normalizeChildDescriptor(descriptor, scope, indexRoot)
    );
  if (descriptors.length === 0 && source.row_count !== 0) {
    throw new Error("Scoped v3 manifest requires child descriptors");
  }
  const expectedPayload = buildObservationHistoryIndexV3ScopedManifestPayload({
    scope,
    canonicalSource: source,
    childDescriptors: descriptors,
  });
  if (!sameJson(payload, expectedPayload)) {
    throw new Error(
      "Scoped v3 manifest payload has contradictory identity, coverage, or children",
    );
  }
  const expectedKey = scopedManifestKey(scope, indexRoot);
  if (normalizeKey(key, "scoped manifest key") !== expectedKey) {
    throw new Error("Scoped v3 manifest key is non-canonical");
  }
  if (bodyText !== canonicalJson(payload)) {
    throw new Error("Scoped v3 manifest body is not canonical JSON");
  }
  return Object.freeze({
    key: expectedKey,
    scope,
    payload,
    source: Object.freeze(source),
    descriptors: Object.freeze(descriptors),
    coverage: Object.freeze(expectedPayload.coverage),
  });
}
