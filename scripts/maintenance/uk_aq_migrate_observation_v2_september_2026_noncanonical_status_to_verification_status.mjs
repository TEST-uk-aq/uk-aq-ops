#!/usr/bin/env node
// Temporary LIVE generation-v2 physical-name repair. Archive after verified migration and backup acceptance.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
} from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  observationHistoryPhysicalSchemaForColumns,
} from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
  serializeCanonicalObservationV2Parquet,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsYearManifest,
  serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  buildHistoryV2TimeseriesLatestPayload,
  buildHistoryV2TimeseriesPollutantIndexPayload,
  buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey,
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
  r2HeadObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  runCommandWithObservationsGlobalOperationLock,
} from "../operations/uk_aq_with_observations_global_operation_lock.mjs";
import {
  checkIntegrityDropboxCurrentness,
} from "../backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs";

export const AUTHORISED_FROM_DAY = "2026-09-09";
export const AUTHORISED_TO_DAY = "2026-09-16";
export const AUTHORISED_PARTITION_COUNT = 294;
export const AUTHORISED_CONNECTOR_COUNTS = Object.freeze({ 1: 185, 2: 20, 3: 10, 6: 79 });
export const AUTHORISED_DAY_COUNTS = Object.freeze({
  "2026-09-09": 10,
  "2026-09-10": 9,
  "2026-09-11": 10,
  "2026-09-12": 53,
  "2026-09-13": 53,
  "2026-09-14": 53,
  "2026-09-15": 53,
  "2026-09-16": 53,
});
// Must be populated only from the previously reviewed exact LIVE affected-scope set.
export const AUTHORISED_AFFECTED_SCOPE_SET_SHA256 = "62c23a1d25207bc0ac46d696ed611c8e920e1127067062ee7ba3fd2f23ab233d";

const GENERATION = getObservationHistoryGeneration("v2");
const PLAN_SCHEMA_VERSION = 2;
const PURPOSE = "live-v2-september-2026-noncanonical-physical-status-to-verification_status";
const SHA256 = /^[0-9a-f]{64}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INTEGRITY_PYTHON = path.join(REPO_ROOT, "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py");
const CODE_IDENTITY_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/maintenance/uk_aq_migrate_observation_v2_september_2026_noncanonical_status_to_verification_status.mjs",
  "scripts/backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs",
  "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
  "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
  "workers/shared/uk_aq_observation_content_hash.mjs",
  "workers/shared/uk_aq_observation_history_schema.mjs",
  "workers/shared/uk_aq_observation_history_generation.mjs",
  "workers/shared/uk_aq_r2_checksum_publication.mjs",
  "workers/shared/uk_aq_r2_history_canonical.mjs",
  "workers/shared/uk_aq_r2_history_index.mjs",
  "workers/shared/uk_aq_r2_history_writer.mjs",
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs",
  "workers/shared/r2_sigv4.mjs",
]);
const STAGE_RANK = Object.freeze({
  parquet: 0,
  pollutant: 1,
  connector: 2,
  scoped_index: 3,
  day: 4,
  month: 5,
  year: 6,
  root: 7,
  latest: 8,
});

function sameColumns(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function classifyV2MigrationPhysicalColumns(columns) {
  if (sameColumns(columns, OBSERVATION_HISTORY_COLUMNS_V3)) return "canonical";
  try {
    observationHistoryPhysicalSchemaForColumns(columns);
    return "historical";
  } catch {
    const canonicalValueColumns = OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6);
    if (Array.isArray(columns) && columns.length === 7 &&
        sameColumns(columns.slice(0, 6), canonicalValueColumns) &&
        columns[6] !== OBSERVATION_HISTORY_COLUMNS_V3[6]) {
      return "noncanonical_shape";
    }
    throw new Error(`Unsupported observation Parquet physical columns: ${
      Array.isArray(columns) ? columns.join(",") : String(columns)
    }`);
  }
}

export function assertKnownNoncanonicalV2ManifestIdentity(manifest, kind, label) {
  if (kind === "noncanonical_shape" && (manifest?.history_schema_version !== 3 ||
      manifest?.writer_version !== "parquet-wasm-zstd-v3" || manifest?.manifest_schema_version !== 3)) {
    throw new Error(`Noncanonical physical manifest has unsupported writer identity: ${label}`);
  }
}

function exactStatus(value) {
  if (value === null || value === "P" || value === "R") return value;
  throw new Error("Migration physical status must be exactly P, R or null");
}

function decodePhysicalRow(values, columns) {
  const kind = classifyV2MigrationPhysicalColumns(columns);
  if (!['noncanonical_shape', 'canonical'].includes(kind) || !Array.isArray(values) || values.length !== 7) {
    throw new Error("Migration row decoder requires an exact seven-column schema");
  }
  const [connectorId, stationId, timeseriesId, pollutantCode, observedAtUtc, value, physicalStatus] = values;
  const timestamp = observedAtUtc instanceof Date ? observedAtUtc : new Date(observedAtUtc);
  if (Number.isNaN(timestamp.getTime()) || typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Migration Parquet timestamp/value is invalid");
  }
  return normalizeCanonicalObservationRow({
    connector_id: Number(connectorId),
    station_id: stationId == null ? null : Number(stationId),
    timeseries_id: Number(timeseriesId),
    pollutant_code: pollutantCode,
    observed_at_utc: timestamp.toISOString(),
    value,
    verification_status: exactStatus(physicalStatus),
  });
}

export async function decodeV2MigrationParquet(body, expectedKind = null) {
  const bytes = Buffer.from(body);
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const metadata = await parquetMetadataAsync(file);
  const columns = parquetSchema(metadata).children.map((column) => String(column.element.name));
  const kind = classifyV2MigrationPhysicalColumns(columns);
  if (expectedKind && kind !== expectedKind) throw new Error("Manifest/Parquet physical schema mismatch");
  const rowCount = Number(metadata.num_rows);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) throw new Error("Migration Parquet row count is invalid");
  if (kind === "historical") return { kind, columns, rowCount, rows: null };
  let decoded = null;
  await parquetRead({ file, metadata, columns, rowStart: 0, rowEnd: rowCount, compressors,
    onComplete: (rows) => { decoded = rows; } });
  if (!Array.isArray(decoded) || decoded.length !== rowCount) throw new Error("Migration Parquet decode row count mismatch");
  return { kind, columns, rowCount, rows: decoded.map((row) => decodePhysicalRow(row, columns)) };
}

function scopeKey(scope) {
  return `${scope.day_utc}\u0000${scope.connector_id}\u0000${scope.pollutant_code}`;
}

function connectorScopeKey(scope) {
  return `${scope.day_utc}\u0000${scope.connector_id}`;
}

export function assertAuthorisedPartitionScope(scope) {
  const day = String(scope?.day_utc || "");
  const connectorId = Number(scope?.connector_id);
  const pollutantCode = String(scope?.pollutant_code || "");
  if (day < AUTHORISED_FROM_DAY || day > AUTHORISED_TO_DAY ||
      !Object.hasOwn(AUTHORISED_CONNECTOR_COUNTS, connectorId) ||
      !/^[a-z0-9_]+$/.test(pollutantCode)) {
    throw new Error(`Partition is outside the authorised September scope: ${scopeKey({ day_utc: day, connector_id: connectorId, pollutant_code: pollutantCode })}`);
  }
  return Object.freeze({ day_utc: day, connector_id: connectorId, pollutant_code: pollutantCode });
}

export function computeAuthorisedAffectedScopeSetSha256(scopes) {
  if (!Array.isArray(scopes)) throw new Error("Authorised affected scopes must be an array");
  const canonicalScopes = scopes.map((entry) => {
    const scope = assertAuthorisedPartitionScope(entry?.scope ?? entry);
    return [scope.day_utc, scope.connector_id, scope.pollutant_code];
  }).sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const serialisedScopes = canonicalScopes.map((scope) => JSON.stringify(scope));
  if (new Set(serialisedScopes).size !== serialisedScopes.length) {
    throw new Error("Authorised September repair contains duplicate partition scope");
  }
  return sha256Hex(Buffer.from(JSON.stringify(canonicalScopes)));
}

export function selectAuthorisedAffectedPartitions(partitions, {
  expectedScopeSetSha256 = AUTHORISED_AFFECTED_SCOPE_SET_SHA256,
} = {}) {
  const selected = (Array.isArray(partitions) ? partitions : [])
    .filter((entry) => entry?.kind === "noncanonical_shape" &&
      String(entry?.scope?.day_utc || "") >= AUTHORISED_FROM_DAY &&
      String(entry?.scope?.day_utc || "") <= AUTHORISED_TO_DAY)
    .map((entry) => ({ ...entry, scope: assertAuthorisedPartitionScope(entry.scope) }))
    .sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
  if (selected.length !== AUTHORISED_PARTITION_COUNT) {
    throw new Error(`Authorised September repair requires exactly 294 affected authoritative partitions; found ${selected.length}`);
  }
  const keys = selected.map((entry) => scopeKey(entry.scope));
  if (new Set(keys).size !== keys.length) throw new Error("Authorised September repair contains duplicate partition scope");
  const counts = {};
  for (const entry of selected) counts[entry.scope.connector_id] = (counts[entry.scope.connector_id] || 0) + 1;
  if (JSON.stringify(counts) !== JSON.stringify(AUTHORISED_CONNECTOR_COUNTS)) {
    throw new Error(`Authorised September connector totals differ: ${JSON.stringify(counts)}`);
  }
  const dayCounts = {};
  for (const entry of selected) dayCounts[entry.scope.day_utc] = (dayCounts[entry.scope.day_utc] || 0) + 1;
  if (JSON.stringify(dayCounts) !== JSON.stringify(AUTHORISED_DAY_COUNTS)) {
    throw new Error(`Authorised September day totals differ: ${JSON.stringify(dayCounts)}`);
  }
  if (!SHA256.test(String(expectedScopeSetSha256 || ""))) {
    throw new Error("Authoritative September affected-scope SHA-256 is not configured");
  }
  const scopeSetSha256 = computeAuthorisedAffectedScopeSetSha256(selected);
  if (scopeSetSha256 !== expectedScopeSetSha256) {
    throw new Error(`Authorised September affected-scope set differs: ${scopeSetSha256}`);
  }
  return selected;
}

export function validateV2MigrationTarget({ args, env, resolvedR2 }) {
  if (args.expectedEnvironment !== "LIVE" || String(env.UK_AQ_ENV_NAME || "") !== "LIVE") {
    throw new Error("Migration requires the explicit LIVE environment");
  }
  if (env.UK_AQ_R2_HISTORY_VERSION !== "v2") throw new Error("Migration requires observation generation v2 and refuses v3");
  if (args.fromDay !== AUTHORISED_FROM_DAY || args.toDay !== AUTHORISED_TO_DAY ||
      Number(args.expectedAffectedPartitions) !== AUTHORISED_PARTITION_COUNT) {
    throw new Error("Migration invocation differs from the authorised September date/count boundary");
  }
  if (!args.expectedBucket || resolvedR2?.bucket !== args.expectedBucket || !hasRequiredR2Config(resolvedR2)) {
    throw new Error("Migration requires complete R2 configuration matching the operator-supplied expected bucket");
  }
  return resolvedR2;
}

export function buildPublicationSchedule(objects) {
  const byKey = new Map();
  for (const object of Array.isArray(objects) ? objects : []) {
    if (!object?.key || !Object.hasOwn(STAGE_RANK, object.stage) || byKey.has(object.key)) {
      throw new Error(`Invalid or duplicate migration publication object: ${String(object?.key || "")}`);
    }
    byKey.set(object.key, object);
  }
  for (const object of byKey.values()) {
    for (const dependency of object.dependencies || []) {
      const child = byKey.get(dependency);
      if (!child) throw new Error(`Unresolved migration publication dependency: ${dependency} -> ${object.key}`);
      if (STAGE_RANK[child.stage] >= STAGE_RANK[object.stage]) {
        throw new Error(`Migration publication stage contradicts dependency: ${dependency} -> ${object.key}`);
      }
    }
  }
  const remaining = new Map([...byKey].map(([key, object]) => [key, new Set(object.dependencies || [])]));
  const scheduled = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => byKey.get(key))
      .sort((left, right) => STAGE_RANK[left.stage] - STAGE_RANK[right.stage] || left.key.localeCompare(right.key));
    if (!ready.length) throw new Error(`Migration publication dependency cycle: ${[...remaining.keys()].sort().join(",")}`);
    for (const object of ready) {
      scheduled.push(object);
      remaining.delete(object.key);
      for (const dependencies of remaining.values()) dependencies.delete(object.key);
    }
  }
  if (scheduled.at(-1)?.stage !== "latest") throw new Error("Migration latest index must be published last");
  return scheduled;
}

function exactIdentity(key, body) {
  const bytes = Buffer.from(body);
  return { key, byte_size: bytes.byteLength, sha256: sha256Hex(bytes) };
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.key === right.key &&
    left.byte_size === right.byte_size && left.sha256 === right.sha256);
}

function objectKind(key) {
  if (String(key).endsWith(".parquet")) return "parquet";
  if (String(key).endsWith(".json")) return "json";
  throw new Error(`Unsupported migration R2 object type: ${String(key)}`);
}

async function readExactFromHead(r2, key, kind, head, expected = null) {
  const storedBytes = head?.bytes;
  const storedSha256 = head?.sha256;
  if (!head?.exists || (kind === "parquet" && storedBytes == null) ||
      (storedBytes != null && (!Number.isSafeInteger(storedBytes) || storedBytes < 0)) ||
      (storedSha256 != null && !SHA256.test(storedSha256)) ||
      (kind === "parquet" && storedSha256 == null)) {
    throw new Error(`Strong stored R2 identity unavailable: ${key}`);
  }
  const object = await r2GetObject({ r2, key });
  const body = Buffer.from(object.body);
  const identity = exactIdentity(key, body);
  if ((storedBytes != null && identity.byte_size !== storedBytes) ||
      (storedSha256 != null && identity.sha256 !== storedSha256) ||
      (expected && !sameIdentity(identity, expected))) {
    throw new Error(`R2 HEAD/GET or pinned identity mismatch: ${key}`);
  }
  return { ...identity, body };
}

function requireAuthoritativeParquetIdentity(key, expected) {
  if (expected?.key !== key || !String(key).endsWith(".parquet") ||
      !Number.isSafeInteger(expected?.byte_size) || expected.byte_size < 0 ||
      typeof expected?.sha256 !== "string" || !SHA256.test(expected.sha256)) {
    throw new Error(`Authoritative source Parquet identity is invalid: ${key}`);
  }
  return Object.freeze({ key, byte_size: expected.byte_size, sha256: expected.sha256 });
}

export async function readMigrationSourceParquetWithExpectedIdentity({
  r2,
  key,
  expected,
  head = null,
  headObject = r2HeadObject,
  getObject = r2GetObject,
}) {
  const authoritative = requireAuthoritativeParquetIdentity(key, expected);
  const stored = head ?? await headObject({ r2, key });
  if (!stored?.exists || !Number.isSafeInteger(stored?.bytes) || stored.bytes < 0 ||
      stored.bytes !== authoritative.byte_size) {
    throw new Error(`Authoritative source Parquet HEAD identity mismatch: ${key}`);
  }
  const hasStoredSha256 = stored.sha256 !== null && stored.sha256 !== undefined && stored.sha256 !== "";
  if (hasStoredSha256 && (!SHA256.test(stored.sha256) || stored.sha256 !== authoritative.sha256)) {
    throw new Error(`Authoritative source Parquet stored SHA-256 mismatch: ${key}`);
  }
  const object = await getObject({ r2, key });
  const body = Buffer.from(object.body);
  const identity = exactIdentity(key, body);
  if (!sameIdentity(identity, authoritative)) {
    throw new Error(`Authoritative source Parquet GET identity mismatch: ${key}`);
  }
  return { ...identity, body };
}

async function readExact(r2, key, expected = null) {
  const kind = objectKind(key);
  return readExactFromHead(r2, key, kind, await r2HeadObject({ r2, key }), expected);
}

export async function readMigrationTargetObjectStrict(r2, key, expected) {
  return readExact(r2, key, expected);
}

export async function readMigrationCurrentIdentity(r2, key, expectedLegacyParquetIdentity = null) {
  const kind = objectKind(key);
  const head = await r2HeadObject({ r2, key });
  if (head?.exists === false) return null;
  const hasStoredSha256 = head?.sha256 !== null && head?.sha256 !== undefined && head?.sha256 !== "";
  if (kind === "parquet" && !hasStoredSha256 && expectedLegacyParquetIdentity) {
    const object = await readMigrationSourceParquetWithExpectedIdentity({
      r2,
      key,
      expected: expectedLegacyParquetIdentity,
      head,
    });
    return { key, byte_size: object.byte_size, sha256: object.sha256 };
  }
  const object = await readExactFromHead(r2, key, kind, head);
  return { key, byte_size: object.byte_size, sha256: object.sha256 };
}

function parseJson(object) {
  try { return { ...object, payload: JSON.parse(object.body.toString("utf8")) }; }
  catch { throw new Error(`Invalid canonical JSON: ${object.key}`); }
}

function validateManifestHash(payload, key, kind) {
  if (payload?.manifest_key !== key || payload?.manifest_kind !== kind || payload?.domain !== "observations" ||
      payload?.history_version !== "v2" || !SHA256.test(String(payload?.manifest_hash || ""))) {
    throw new Error(`Invalid ${kind} manifest authority: ${key}`);
  }
  const { manifest_hash: manifestHash, ...unhashed } = payload;
  if (sha256Hex(JSON.stringify(unhashed)) !== manifestHash) throw new Error(`Manifest hash mismatch: ${key}`);
  return payload;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameSemanticJson(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function oldIdentity(object) {
  return object ? { key: object.key, byte_size: object.byte_size, sha256: object.sha256 } : null;
}

function requireChildren(manifest, label) {
  if (!Array.isArray(manifest?.child_manifests) || !manifest.child_manifests.length) {
    throw new Error(`Missing ${label} child set: ${manifest?.manifest_key || "unknown"}`);
  }
  const keys = manifest.child_manifests.map((entry) => String(entry?.manifest_key || ""));
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error(`Invalid ${label} child set`);
  return manifest.child_manifests;
}

function assertChildReference(parent, child, fields) {
  const matches = requireChildren(parent, parent.manifest_kind).filter((entry) => entry.manifest_key === child.manifest_key);
  if (matches.length !== 1 || fields.some((field) => JSON.stringify(matches[0][field] ?? null) !== JSON.stringify(child[field] ?? null))) {
    throw new Error(`Canonical parent/child descriptor mismatch: ${child.manifest_key}`);
  }
}

function assertAggregateReference(reference, child, hashField) {
  if (reference.manifest_key !== child.key || reference[hashField] !== child.payload[hashField]) {
    throw new Error(`Canonical aggregate child identity mismatch: ${child.key}`);
  }
}

export function assertCompleteAggregateChildSet(parent, children, hashField) {
  const references = Array.isArray(parent?.children) ? parent.children : null;
  if (!references || !(children instanceof Map) || references.length !== children.size) {
    throw new Error("Canonical complete aggregate child set is missing or has unexpected members");
  }
  const referencedKeys = references.map((entry) => String(entry?.manifest_key || ""));
  if (referencedKeys.some((key) => !key) || new Set(referencedKeys).size !== referencedKeys.length ||
      [...children.keys()].some((key) => !referencedKeys.includes(key))) {
    throw new Error("Canonical complete aggregate child set has invalid or unexpected members");
  }
  for (const reference of references) {
    const child = children.get(reference.manifest_key);
    if (!child) throw new Error(`Canonical complete aggregate child set is missing: ${reference.manifest_key}`);
    assertAggregateReference(reference, child, hashField);
  }
}

async function readAggregate(r2, reference, kind) {
  const object = parseJson(await readExact(r2, reference.manifest_key));
  object.payload = validateR2HistoryV2ObservationsAggregateManifest(object.payload, {
    basePrefix: GENERATION.observations_prefix,
  });
  if (object.payload.kind !== kind) throw new Error(`Unexpected aggregate kind: ${object.key}`);
  assertAggregateReference(reference, object, "content_hash");
  return object;
}

function logicalInvariants(rows) {
  const computed = computeObservationContentHash(rows);
  const timeseriesRowCounts = {};
  for (const row of rows) timeseriesRowCounts[String(row.timeseries_id)] = (timeseriesRowCounts[String(row.timeseries_id)] || 0) + 1;
  const sortedIds = rows.map((row) => row.timeseries_id).sort((a, b) => a - b);
  const sortedTimes = rows.map((row) => row.observed_at_utc).sort();
  return {
    row_count: computed.observation_content_hash_row_count,
    observation_content_hash: computed.observation_content_hash,
    observation_content_hash_algorithm: computed.observation_content_hash_algorithm,
    observation_content_hash_contract_version: computed.observation_content_hash_contract_version,
    observation_content_hash_row_count: computed.observation_content_hash_row_count,
    observation_content_hash_columns: computed.observation_content_hash_columns,
    verification_status_counts: computed.verification_status_counts,
    timeseries_row_counts: timeseriesRowCounts,
    min_timeseries_id: sortedIds[0],
    max_timeseries_id: sortedIds.at(-1),
    min_observed_at_utc: sortedTimes[0],
    max_observed_at_utc: sortedTimes.at(-1),
  };
}

function assertLogicalEqual(left, right, label) {
  for (const field of ["row_count", "observation_content_hash", "observation_content_hash_algorithm",
    "observation_content_hash_contract_version", "observation_content_hash_row_count",
    "observation_content_hash_columns", "verification_status_counts", "timeseries_row_counts",
    "min_timeseries_id", "max_timeseries_id", "min_observed_at_utc", "max_observed_at_utc"]) {
    if (!sameSemanticJson(left?.[field] ?? null, right?.[field] ?? null)) {
      throw new Error(`Physical rename changed ${field}: ${label}`);
    }
  }
}

function assertManifestInvariants(manifest, logical) {
  const mapping = {
    row_count: "row_count",
    source_row_count: "row_count",
    observation_content_hash: "observation_content_hash",
    observation_content_hash_algorithm: "observation_content_hash_algorithm",
    observation_content_hash_contract_version: "observation_content_hash_contract_version",
    observation_content_hash_row_count: "observation_content_hash_row_count",
    observation_content_hash_columns: "observation_content_hash_columns",
    verification_status_counts: "verification_status_counts",
    timeseries_row_counts: "timeseries_row_counts",
    min_timeseries_id: "min_timeseries_id",
    max_timeseries_id: "max_timeseries_id",
    min_observed_at_utc: "min_observed_at_utc",
    max_observed_at_utc: "max_observed_at_utc",
  };
  for (const [manifestField, logicalField] of Object.entries(mapping)) {
    if (!sameSemanticJson(manifest?.[manifestField] ?? null, logical?.[logicalField] ?? null)) {
      throw new Error(`Pre-migration logical invariant mismatch: ${manifest?.manifest_key}: ${manifestField}`);
    }
  }
}

async function inspectPollutant(r2, object, scope, pins) {
  const manifest = validateManifestHash(object.payload, object.key, "pollutant");
  if (manifest.day_utc !== scope.day_utc || manifest.connector_id !== scope.connector_id ||
      manifest.pollutant_code !== scope.pollutant_code) throw new Error(`Pollutant scope mismatch: ${object.key}`);
  const kind = classifyV2MigrationPhysicalColumns(manifest.columns);
  assertKnownNoncanonicalV2ManifestIdentity(manifest, kind, object.key);
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.file_count !== manifest.files.length) {
    throw new Error(`Invalid pollutant file set: ${object.key}`);
  }
  if (kind === "noncanonical_shape" && manifest.files.length !== 1) {
    throw new Error(`Authorised noncanonical partition must contain exactly one Parquet file: ${object.key}`);
  }
  const rows = [];
  const files = [];
  for (const file of manifest.files) {
    const key = String(file?.key || "");
    if (!key.startsWith(object.key.replace(/manifest\.json$/, "")) || !/\/part-\d{5}\.parquet$/.test(key)) {
      throw new Error(`Invalid authoritative Parquet key: ${key}`);
    }
    const part = await readMigrationSourceParquetWithExpectedIdentity({
      r2,
      key,
      expected: { key: file.key, byte_size: file.bytes, sha256: file.etag_or_hash },
    });
    pins.set(key, oldIdentity(part));
    if (file.bytes !== part.byte_size || file.etag_or_hash !== part.sha256) throw new Error(`Manifest/Parquet identity mismatch: ${key}`);
    const decoded = await decodeV2MigrationParquet(part.body);
    if (decoded.kind !== kind || !sameColumns(decoded.columns, manifest.columns) || decoded.rowCount !== file.row_count) {
      throw new Error(`Manifest/Parquet footer mismatch: ${key}`);
    }
    if (decoded.rows) {
      for (const row of decoded.rows) {
        if (row.connector_id !== scope.connector_id || row.pollutant_code !== scope.pollutant_code ||
            row.observed_at_utc.slice(0, 10) !== scope.day_utc) throw new Error(`Parquet row escaped partition: ${key}`);
      }
      rows.push(...decoded.rows);
    }
    files.push({ key, byte_size: part.byte_size, sha256: part.sha256, row_count: decoded.rowCount });
  }
  if (!Array.isArray(manifest.parquet_object_keys) ||
      !sameSemanticJson([...manifest.parquet_object_keys].sort(), files.map((entry) => entry.key).sort()) ||
      manifest.total_bytes !== files.reduce((sum, entry) => sum + entry.byte_size, 0)) {
    throw new Error(`Pollutant manifest file membership/size mismatch: ${object.key}`);
  }
  const logical = rows.length ? logicalInvariants(rows) : null;
  if (logical) assertManifestInvariants(manifest, logical);
  return { kind, scope, manifest: object, files, rows, logical };
}

async function inventoryAuthorisedRange(r2) {
  const pins = new Map();
  const root = parseJson(await readExact(r2, GENERATION.observations_root_key));
  root.payload = validateR2HistoryV2ObservationsAggregateManifest(root.payload, { basePrefix: GENERATION.observations_prefix });
  if (root.payload.kind !== OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.root) throw new Error("Canonical observations root kind is invalid");
  pins.set(root.key, oldIdentity(root));
  const years = new Map();
  for (const yearRef of root.payload.children) {
    const child = await readAggregate(r2, yearRef, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year);
    pins.set(child.key, oldIdentity(child));
    years.set(child.key, child);
  }
  assertCompleteAggregateChildSet(root.payload, years, "content_hash");
  const yearRef = root.payload.children.find((entry) => Number(entry.year) === 2026);
  const year = yearRef ? years.get(yearRef.manifest_key) : null;
  if (!year) throw new Error("Authoritative hierarchy is missing year 2026");
  const months = new Map();
  for (const monthRef of year.payload.children) {
    const child = await readAggregate(r2, monthRef, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month);
    pins.set(child.key, oldIdentity(child));
    months.set(child.key, child);
  }
  assertCompleteAggregateChildSet(year.payload, months, "content_hash");
  const monthRef = year.payload.children.find((entry) => String(entry.month) === "09");
  const month = monthRef ? months.get(monthRef.manifest_key) : null;
  if (!month) throw new Error("Authoritative hierarchy is missing September 2026");
  const days = new Map(), connectors = new Map(), pollutants = new Map();
  const daysByKey = new Map();
  for (const dayRef of month.payload.children) {
    const dayUtc = dayRef.day_utc;
    const expectedDayKey = buildHistoryV2DayManifestKey(GENERATION.observations_prefix, dayUtc);
    if (dayRef.manifest_key !== expectedDayKey) throw new Error(`Invalid canonical day key: ${dayUtc}`);
    const day = parseJson(await readExact(r2, expectedDayKey));
    validateManifestHash(day.payload, day.key, "day");
    if (day.payload.day_utc !== dayUtc) throw new Error(`Canonical day scope mismatch: ${day.key}`);
    assertAggregateReference(dayRef, day, "manifest_hash");
    pins.set(day.key, oldIdentity(day)); days.set(dayUtc, day); daysByKey.set(day.key, day);
    if (dayUtc < AUTHORISED_FROM_DAY || dayUtc > AUTHORISED_TO_DAY) continue;
    for (const connectorRef of requireChildren(day.payload, "day")) {
      const connectorId = Number(connectorRef.connector_id);
      const connectorKey = buildHistoryV2ConnectorManifestKey(GENERATION.observations_prefix, dayUtc, connectorId);
      if (connectorRef.manifest_key !== connectorKey) throw new Error(`Invalid canonical connector key: ${connectorKey}`);
      const connector = parseJson(await readExact(r2, connectorKey));
      validateManifestHash(connector.payload, connector.key, "connector");
      if (connector.payload.day_utc !== dayUtc || connector.payload.connector_id !== connectorId) {
        throw new Error(`Canonical connector scope mismatch: ${connector.key}`);
      }
      assertChildReference(day.payload, connector.payload, ["manifest_hash", "row_count", "file_count", "total_bytes"]);
      pins.set(connector.key, oldIdentity(connector)); connectors.set(`${dayUtc}\u0000${connectorId}`, connector);
      for (const pollutantRef of requireChildren(connector.payload, "connector")) {
        const pollutantCode = String(pollutantRef.pollutant_code || "");
        const pollutantKey = buildHistoryV2PollutantManifestKey(GENERATION.observations_prefix, dayUtc, connectorId, pollutantCode);
        if (pollutantRef.manifest_key !== pollutantKey) throw new Error(`Invalid canonical pollutant key: ${pollutantKey}`);
        const pollutant = parseJson(await readExact(r2, pollutantKey));
        assertChildReference(connector.payload, pollutant.payload, ["manifest_hash", "row_count", "file_count", "total_bytes"]);
        pins.set(pollutant.key, oldIdentity(pollutant));
        const scope = { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode };
        pollutants.set(scopeKey(scope), await inspectPollutant(r2, pollutant, scope, pins));
      }
    }
  }
  assertCompleteAggregateChildSet(month.payload, daysByKey, "manifest_hash");
  if (![...days.keys()].some((day) => day >= AUTHORISED_FROM_DAY && day <= AUTHORISED_TO_DAY)) {
    throw new Error("Authoritative hierarchy contains no days in the authorised September range");
  }
  return { root, years, year, months, month, days, connectors, pollutants, pins };
}

function jsonPut(key, payload, stage, old, dependencies = [], serializer = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)) {
  const body = Buffer.from(serializer(payload));
  return { key, stage, dependencies: [...new Set(dependencies)].sort(), old, target: exactIdentity(key, body), body_base64: body.toString("base64") };
}

function parquetPut(key, body, old) {
  return { key, stage: "parquet", dependencies: [], old, target: exactIdentity(key, body) };
}

function stableCodeIdentity() {
  return CODE_IDENTITY_FILES.map((relativePath) => {
    const body = fs.readFileSync(path.join(REPO_ROOT, relativePath));
    return { path: relativePath, byte_size: body.byteLength, sha256: sha256Hex(body) };
  });
}

function sealPlan(core) {
  return { ...core, plan_sha256: sha256Hex(Buffer.from(JSON.stringify(core))) };
}

function stagedParquetPath(planPath, sha256) {
  return path.join(`${path.resolve(planPath)}.payloads`, `${sha256}.parquet`);
}

function writePrivateFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    if (!fs.readFileSync(filePath).equals(body)) throw new Error(`Existing migration file differs: ${filePath}`);
    return;
  }
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temp, filePath);
  const directory = fs.openSync(path.dirname(filePath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function storedBody(planPath, put) {
  const body = put.stage === "parquet"
    ? fs.readFileSync(stagedParquetPath(planPath, put.target.sha256))
    : Buffer.from(put.body_base64, "base64");
  if (body.byteLength !== put.target.byte_size || sha256Hex(body) !== put.target.sha256) {
    throw new Error(`Prepared migration body identity mismatch: ${put.key}`);
  }
  return body;
}

function daySummary(dayUtc, day, connectors, pollutants, bucket) {
  const connectorEntries = requireChildren(day.payload, "day").map((reference) => {
    const connector = connectors.get(`${dayUtc}\u0000${reference.connector_id}`);
    if (!connector) throw new Error(`Missing final connector for latest summary: ${reference.manifest_key}`);
    return connector.payload;
  });
  const indexPayloads = [];
  for (const connector of connectorEntries) {
    for (const reference of requireChildren(connector, "connector")) {
      const inspected = pollutants.get(`${dayUtc}\u0000${connector.connector_id}\u0000${reference.pollutant_code}`);
      if (!inspected) throw new Error(`Missing final pollutant for latest summary: ${reference.manifest_key}`);
      indexPayloads.push(buildHistoryV2TimeseriesPollutantIndexPayload({
        domain: "observations", dayUtc, connectorId: connector.connector_id,
        pollutantCode: reference.pollutant_code, generatedAt: null, bucket,
        dataPrefix: GENERATION.observations_prefix, pollutantManifestKey: reference.manifest_key,
        pollutantManifest: inspected.manifest.payload,
      }));
    }
  }
  return {
    day_utc: dayUtc,
    connector_count: connectorEntries.length,
    connector_ids: connectorEntries.map((entry) => entry.connector_id).sort((a, b) => a - b),
    connectors: connectorEntries.map((entry) => ({ connector_id: entry.connector_id, row_count: entry.row_count })).sort((a, b) => a.connector_id - b.connector_id),
    total_rows: connectorEntries.reduce((sum, entry) => sum + entry.row_count, 0),
    pollutant_codes: [...new Set(indexPayloads.map((entry) => entry.pollutant_code))].sort(),
    pollutant_index_count: indexPayloads.length,
    file_count: indexPayloads.reduce((sum, entry) => sum + entry.file_count, 0),
    indexed_file_count: indexPayloads.reduce((sum, entry) => sum + entry.indexed_file_count, 0),
    backed_up_at_utc: day.payload.backed_up_at_utc,
  };
}

function assertScopedIndexMatches(indexPayload, inspected, bucket) {
  const scope = inspected.scope;
  const expected = buildHistoryV2TimeseriesPollutantIndexPayload({
    domain: "observations", dayUtc: scope.day_utc, connectorId: scope.connector_id,
    pollutantCode: scope.pollutant_code, generatedAt: null, bucket,
    dataPrefix: GENERATION.observations_prefix,
    pollutantManifestKey: inspected.manifest.key,
    pollutantManifest: inspected.manifest.payload,
  });
  if (!sameSemanticJson(indexPayload, expected)) {
    throw new Error(`Existing v2 scoped index does not agree with its authoritative pollutant manifest: ${scopeKey(scope)}`);
  }
}

function assertLatestDaySummaryMatches(actual, expected) {
  const fields = ["day_utc", "connector_count", "connector_ids", "connectors", "total_rows",
    "pollutant_codes", "pollutant_index_count", "file_count", "indexed_file_count", "backed_up_at_utc"];
  for (const field of fields) {
    if (!sameSemanticJson(actual?.[field] ?? null, expected?.[field] ?? null)) {
      throw new Error(`Existing v2 latest day summary mismatch: ${expected.day_utc}: ${field}`);
    }
  }
}

function summariseScopes(scopes) {
  const byDay = {}, byConnector = {};
  for (const entry of scopes) {
    byDay[entry.scope.day_utc] = (byDay[entry.scope.day_utc] || 0) + 1;
    byConnector[entry.scope.connector_id] = (byConnector[entry.scope.connector_id] || 0) + 1;
  }
  return { affected_partition_count: scopes.length, by_day: byDay, by_connector: byConnector };
}

function readinessFromIntegrityPython(startedAt) {
  const script = [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('uk_aq_integrity_gate',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name]=module",
    "spec.loader.exec_module(module)",
    "url,key=module.resolve_backup_gate_credentials()",
    "result=module.check_dropbox_backup_ready(supabase_url=url,service_role_key=key,integrity_started_at_utc=sys.argv[2],allow_stale_dropbox=False)",
    "print(json.dumps(result,separators=(',',':')))",
  ].join("\n");
  const result = JSON.parse(execFileSync("python3", ["-c", script, INTEGRITY_PYTHON, startedAt], {
    cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  }));
  if (result.backup_ready !== true || result.allow_stale_dropbox !== false || !result.backup_run_id) {
    throw new Error(`Existing Integrity latest-writer backup gate blocked migration: ${result.blocked_reason || "unknown"}`);
  }
  return { backup_run_id: result.backup_run_id, backup_started_at: result.backup_started_at,
    backup_finished_at: result.backup_finished_at, latest_writer_finished_at: result.latest_writer_finished_at };
}

async function backupGate(args, env, r2, lockContext) {
  const currentness = await checkIntegrityDropboxCurrentness({
    dropboxRoot: args.dropboxRoot, observationGeneration: "v2",
    timeseriesBindingBackupMode: args.bindingBackupMode, env, lockContext,
    getLiveRoot: async ({ key }) => readExact(r2, key),
  });
  if (!currentness.allowed || !currentness.checkpoint_live_root_match) {
    throw new Error("Existing Dropbox checkpoint/R2 currentness gate blocked migration");
  }
  return { checkpoint: currentness.checkpoint, live_observations_root: currentness.live_observations_root,
    readiness: readinessFromIntegrityPython(new Date().toISOString()) };
}

function buildFileEntry(key, body, logical) {
  return {
    key, row_count: logical.row_count, bytes: body.byteLength, etag_or_hash: sha256Hex(body),
    pollutant_codes: [], min_timeseries_id: logical.min_timeseries_id,
    max_timeseries_id: logical.max_timeseries_id, min_observed_at_utc: logical.min_observed_at_utc,
    max_observed_at_utc: logical.max_observed_at_utc, timeseries_row_counts: logical.timeseries_row_counts,
  };
}

async function makePlan(args, env, r2, lockContext) {
  if (!SHA256.test(String(AUTHORISED_AFFECTED_SCOPE_SET_SHA256 || ""))) {
    throw new Error("Authoritative September affected-scope SHA-256 is not configured");
  }
  const gate = await backupGate(args, env, r2, lockContext);
  const inventory = await inventoryAuthorisedRange(r2);
  if (inventory.root.payload.content_hash !== gate.live_observations_root.content_hash) {
    throw new Error("Locked inventory root changed after backup/currentness gate");
  }
  const affected = selectAuthorisedAffectedPartitions([...inventory.pollutants.values()]);
  const latest = parseJson(await readExact(r2, GENERATION.observations_timeseries_latest_key));
  inventory.pins.set(latest.key, oldIdentity(latest));
  if (latest.payload?.history_version !== "v2" || latest.payload?.domain !== "observations" ||
      latest.payload?.key_layout?.latest_key !== GENERATION.observations_timeseries_latest_key) {
    throw new Error("Existing v2 observations-timeseries latest index is invalid");
  }
  const scopedIndexes = new Map();
  for (const inspected of inventory.pollutants.values()) {
    const scope = inspected.scope;
    const indexKey = buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      GENERATION.observations_timeseries_index_prefix, scope.day_utc, scope.connector_id, scope.pollutant_code,
    );
    const index = parseJson(await readExact(r2, indexKey));
    assertScopedIndexMatches(index.payload, inspected, r2.bucket);
    inventory.pins.set(indexKey, oldIdentity(index));
    scopedIndexes.set(scopeKey(scope), index);
  }
  for (const dayUtc of [...new Set(affected.map((entry) => entry.scope.day_utc))].sort()) {
    const actual = (latest.payload.day_summaries || []).find((entry) => entry.day_utc === dayUtc);
    const expected = daySummary(dayUtc, inventory.days.get(dayUtc), inventory.connectors, inventory.pollutants, r2.bucket);
    if (!actual) throw new Error(`Existing v2 latest index is missing affected day: ${dayUtc}`);
    assertLatestDaySummaryMatches(actual, expected);
  }

  const puts = [];
  const finalPollutants = new Map(inventory.pollutants);
  const changedPollutantsByConnector = new Map();
  const affectedScopes = [];
  for (const inspected of affected) {
    const scope = assertAuthorisedPartitionScope(inspected.scope);
    const oldFile = inspected.files[0];
    const targetBody = serializeCanonicalObservationV2Parquet(inspected.rows);
    const decodedTarget = await decodeV2MigrationParquet(targetBody, "canonical");
    const targetLogical = logicalInvariants(decodedTarget.rows);
    assertLogicalEqual(inspected.logical, targetLogical, scopeKey(scope));
    const fileEntry = buildFileEntry(oldFile.key, targetBody, targetLogical);
    fileEntry.pollutant_codes = [scope.pollutant_code];
    const { canonical_rows: _rows, ...observationContentHash } = computeObservationContentHash(decodedTarget.rows);
    const targetManifestPayload = buildHistoryV2PollutantManifest({
      domain: "observations", dayUtc: scope.day_utc, connectorId: scope.connector_id,
      pollutantCode: scope.pollutant_code, runId: inspected.manifest.payload.run_id,
      manifestKey: inspected.manifest.key, sourceRowCount: targetLogical.row_count,
      fileEntries: [fileEntry], writerGitSha: args.targetWriterGitSha,
      backedUpAtUtc: inspected.manifest.payload.backed_up_at_utc, observationContentHash,
    });
    assertManifestInvariants(targetManifestPayload, targetLogical);
    const parquet = parquetPut(oldFile.key, targetBody, oldFile);
    writePrivateFile(stagedParquetPath(args.planPath, parquet.target.sha256), targetBody);
    puts.push(parquet);
    const manifestPut = jsonPut(inspected.manifest.key, targetManifestPayload, "pollutant",
      oldIdentity(inspected.manifest), [parquet.key], (value) => Buffer.from(JSON.stringify(value, null, 2)));
    puts.push(manifestPut);
    const targetInspected = { ...inspected, kind: "canonical", rows: [], logical: targetLogical,
      files: [{ ...parquet.target, row_count: targetLogical.row_count }],
      manifest: { ...manifestPut.target, key: manifestPut.key, payload: targetManifestPayload } };
    finalPollutants.set(scopeKey(scope), targetInspected);
    const ckey = connectorScopeKey(scope);
    if (!changedPollutantsByConnector.has(ckey)) changedPollutantsByConnector.set(ckey, new Map());
    changedPollutantsByConnector.get(ckey).set(scope.pollutant_code, targetManifestPayload);
    affectedScopes.push({ scope, logical_invariants: inspected.logical,
      old_parquet_file: oldFile, target_parquet_file: { ...parquet.target, row_count: targetLogical.row_count },
      old_pollutant_manifest: oldIdentity(inspected.manifest), target_pollutant_manifest: manifestPut.target });
    inspected.rows = [];
  }

  const finalConnectors = new Map(inventory.connectors);
  const changedConnectorsByDay = new Map();
  for (const [ckey, replacements] of [...changedPollutantsByConnector].sort(([a], [b]) => a.localeCompare(b))) {
    const original = inventory.connectors.get(ckey);
    const children = requireChildren(original.payload, "connector").map((entry) =>
      replacements.get(entry.pollutant_code) || inventory.pollutants.get(`${ckey}\u0000${entry.pollutant_code}`).manifest.payload);
    const payload = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: original.payload.day_utc,
      connectorId: original.payload.connector_id, runId: original.payload.run_id, manifestKey: original.key,
      pollutantManifests: children, writerGitSha: args.targetWriterGitSha,
      backedUpAtUtc: original.payload.backed_up_at_utc });
    const dependencies = [...replacements.values()].map((entry) => entry.manifest_key);
    const put = jsonPut(original.key, payload, "connector", oldIdentity(original), dependencies,
      (value) => Buffer.from(JSON.stringify(value, null, 2)));
    puts.push(put);
    finalConnectors.set(ckey, { ...put.target, key: put.key, payload });
    if (!changedConnectorsByDay.has(payload.day_utc)) changedConnectorsByDay.set(payload.day_utc, new Map());
    changedConnectorsByDay.get(payload.day_utc).set(payload.connector_id, payload);
  }

  const indexPutKeysByDay = new Map();
  for (const entry of affectedScopes) {
    const scope = entry.scope;
    const target = finalPollutants.get(scopeKey(scope));
    const indexKey = buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      GENERATION.observations_timeseries_index_prefix, scope.day_utc, scope.connector_id, scope.pollutant_code,
    );
    const oldIndex = scopedIndexes.get(scopeKey(scope));
    if (!oldIndex || oldIndex.key !== indexKey) throw new Error(`Pinned v2 scoped index is missing: ${indexKey}`);
    const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
      domain: "observations", dayUtc: scope.day_utc, connectorId: scope.connector_id,
      pollutantCode: scope.pollutant_code, generatedAt: null, bucket: r2.bucket,
      dataPrefix: GENERATION.observations_prefix, pollutantManifestKey: target.manifest.key,
      pollutantManifest: target.manifest.payload,
    });
    const connectorKey = buildHistoryV2ConnectorManifestKey(GENERATION.observations_prefix, scope.day_utc, scope.connector_id);
    const put = jsonPut(indexKey, payload, "scoped_index", oldIdentity(oldIndex),
      [target.manifest.key, connectorKey]);
    puts.push(put);
    entry.old_scoped_index = oldIdentity(oldIndex);
    entry.target_scoped_index = put.target;
    if (!indexPutKeysByDay.has(scope.day_utc)) indexPutKeysByDay.set(scope.day_utc, []);
    indexPutKeysByDay.get(scope.day_utc).push(indexKey);
  }

  const finalDays = new Map(inventory.days);
  for (const [dayUtc, replacements] of [...changedConnectorsByDay].sort(([a], [b]) => a.localeCompare(b))) {
    const original = inventory.days.get(dayUtc);
    const children = requireChildren(original.payload, "day").map((entry) =>
      replacements.get(Number(entry.connector_id)) || inventory.connectors.get(`${dayUtc}\u0000${entry.connector_id}`).payload);
    const payload = buildHistoryV2DayManifest({ domain: "observations", dayUtc, runId: original.payload.run_id,
      manifestKey: original.key, connectorManifests: children, writerGitSha: args.targetWriterGitSha,
      backedUpAtUtc: original.payload.backed_up_at_utc });
    const dependencies = [
      ...[...replacements.values()].map((entry) => entry.manifest_key),
      ...(indexPutKeysByDay.get(dayUtc) || []),
    ];
    const put = jsonPut(original.key, payload, "day", oldIdentity(original), dependencies,
      (value) => Buffer.from(JSON.stringify(value, null, 2)));
    puts.push(put);
    finalDays.set(dayUtc, { ...put.target, key: put.key, payload });
  }

  const changedDayPuts = puts.filter((entry) => entry.stage === "day");
  const monthPayload = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: GENERATION.observations_prefix, year: 2026, month: "09",
    dayManifests: inventory.month.payload.children.map((entry) => {
      const day = finalDays.get(entry.day_utc);
      if (!day) throw new Error(`Missing pinned September day dependency: ${entry.manifest_key}`);
      return day.payload;
    }),
  });
  const monthPut = jsonPut(inventory.month.key, monthPayload, "month", oldIdentity(inventory.month),
    changedDayPuts.map((entry) => entry.key),
    (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix }));
  puts.push(monthPut);
  const yearPayload = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: GENERATION.observations_prefix, year: 2026,
    monthManifests: inventory.year.payload.children.map((entry) => {
      if (entry.month === "09") return monthPayload;
      const child = inventory.months.get(entry.manifest_key);
      if (!child) throw new Error(`Missing pinned 2026 month dependency: ${entry.manifest_key}`);
      return child.payload;
    }),
  });
  const yearPut = jsonPut(inventory.year.key, yearPayload, "year", oldIdentity(inventory.year), [monthPut.key],
    (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix }));
  puts.push(yearPut);
  const rootPayload = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: GENERATION.observations_prefix,
    yearManifests: inventory.root.payload.children.map((entry) => {
      if (Number(entry.year) === 2026) return yearPayload;
      const child = inventory.years.get(entry.manifest_key);
      if (!child) throw new Error(`Missing pinned root year dependency: ${entry.manifest_key}`);
      return child.payload;
    }),
  });
  const rootPut = jsonPut(inventory.root.key, rootPayload, "root", oldIdentity(inventory.root), [yearPut.key],
    (value) => serializeR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: GENERATION.observations_prefix }));
  puts.push(rootPut);

  const daySummaryMap = new Map((latest.payload.day_summaries || []).map((entry) => [entry.day_utc, entry]));
  for (const dayUtc of changedConnectorsByDay.keys()) {
    daySummaryMap.set(dayUtc, daySummary(dayUtc, finalDays.get(dayUtc), finalConnectors, finalPollutants, r2.bucket));
  }
  const latestPayload = buildHistoryV2TimeseriesLatestPayload({
    domain: "observations", bucket: r2.bucket, generatedAt: null,
    existingGeneratedAt: latest.payload.generated_at, indexPrefix: GENERATION.index_root_prefix,
    dataPrefix: GENERATION.observations_prefix,
    timeseriesIndexPrefix: GENERATION.observations_timeseries_index_prefix,
    daySummaries: [...daySummaryMap.values()],
  });
  const latestPut = jsonPut(latest.key, latestPayload, "latest", oldIdentity(latest),
    [...puts.map((entry) => entry.key)]);
  puts.push(latestPut);
  const schedule = buildPublicationSchedule(puts);
  const publicationKeys = schedule.map((entry) => entry.key);
  const publicationScheduleSha256 = sha256Hex(Buffer.from(JSON.stringify(publicationKeys)));
  const repositoryHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  if (args.targetWriterGitSha !== repositoryHead) throw new Error("Target writer Git SHA must equal the current repository HEAD");
  const core = {
    plan_schema_version: PLAN_SCHEMA_VERSION, purpose: PURPOSE, environment: "LIVE", bucket: r2.bucket,
    generation: "v2", from_day: AUTHORISED_FROM_DAY, to_day: AUTHORISED_TO_DAY,
    expected_affected_partition_count: AUTHORISED_PARTITION_COUNT,
    authorised_affected_scope_set_sha256: computeAuthorisedAffectedScopeSetSha256(affectedScopes),
    repository_head: repositoryHead, target_writer_git_sha: args.targetWriterGitSha,
    code_identity: stableCodeIdentity(), backup_evidence: gate,
    pre_migration_observations_root: { ...oldIdentity(inventory.root), content_hash: inventory.root.payload.content_hash },
    old_latest_index: oldIdentity(latest), pinned_authoritative_objects: [...inventory.pins.values()].sort((a, b) => a.key.localeCompare(b.key)),
    affected_scopes: affectedScopes, planned_puts: schedule,
    publication_schedule: publicationKeys, publication_schedule_sha256: publicationScheduleSha256,
    planned_deletions: [], final_observations_root: rootPut.target,
    final_observations_root_content_hash: rootPayload.content_hash, final_latest_index: latestPut.target,
    totals: summariseScopes(affectedScopes),
  };
  const plan = sealPlan(core);
  writePrivateFile(args.planPath, Buffer.from(`${JSON.stringify(plan, null, 2)}\n`));
  return { plan, summary: { status: "planned", plan_path: path.resolve(args.planPath), plan_sha256: plan.plan_sha256,
    publication_schedule_sha256: publicationScheduleSha256, ...plan.totals } };
}

export function parseMigrationArgs(argv) {
  const args = { mode: null, planPath: null, expectedPlanSha256: null, expectedEnvironment: null,
    expectedBucket: null, targetWriterGitSha: null, dropboxRoot: null, bindingBackupMode: "individual",
    fromDay: null, toDay: null, expectedAffectedPartitions: null, apply: false };
  const mapping = { "--mode": "mode", "--plan-path": "planPath", "--expected-plan-sha256": "expectedPlanSha256",
    "--expected-environment": "expectedEnvironment", "--expected-bucket": "expectedBucket",
    "--target-writer-git-sha": "targetWriterGitSha", "--dropbox-root": "dropboxRoot",
    "--binding-backup-mode": "bindingBackupMode", "--from-day": "fromDay", "--to-day": "toDay",
    "--expected-affected-partitions": "expectedAffectedPartitions" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { args.apply = true; continue; }
    const property = mapping[flag];
    if (!property) throw new Error(`Unknown migration argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (args[property] && property !== "bindingBackupMode") throw new Error(`Duplicate ${flag}`);
    args[property] = property === "expectedAffectedPartitions" ? Number(value) : value;
  }
  if (!['plan', 'apply', 'verify'].includes(args.mode)) throw new Error("--mode must be plan, apply or verify");
  for (const field of ["planPath", "expectedEnvironment", "expectedBucket", "targetWriterGitSha", "dropboxRoot", "fromDay", "toDay", "expectedAffectedPartitions"]) {
    if (args[field] == null || args[field] === "") throw new Error(`Required migration argument is missing: ${field}`);
  }
  if (!/^[0-9a-f]{40}$/.test(args.targetWriterGitSha)) throw new Error("Target writer Git SHA must be a full lower-case SHA");
  if (!['pack', 'individual'].includes(args.bindingBackupMode)) throw new Error("Unsupported binding backup mode");
  if (args.mode === "apply") {
    if (!args.apply || !SHA256.test(String(args.expectedPlanSha256 || ""))) {
      throw new Error("APPLY requires --apply and --expected-plan-sha256");
    }
  } else if (args.apply || args.expectedPlanSha256) throw new Error("--apply and --expected-plan-sha256 are APPLY-only");
  return Object.freeze(args);
}

function readPlan(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const { plan_sha256: hash, ...core } = plan;
  if (!SHA256.test(String(hash || "")) || sealPlan(core).plan_sha256 !== hash ||
      plan.plan_schema_version !== PLAN_SCHEMA_VERSION || plan.purpose !== PURPOSE) {
    throw new Error("Migration plan identity is invalid");
  }
  return plan;
}

function assertPlanMatchesInvocation(plan, args, r2) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const plannedScopeSetSha256 = computeAuthorisedAffectedScopeSetSha256(plan.affected_scopes);
  if (plan.environment !== "LIVE" || plan.bucket !== args.expectedBucket || r2.bucket !== plan.bucket ||
      plan.generation !== "v2" || plan.from_day !== AUTHORISED_FROM_DAY || plan.to_day !== AUTHORISED_TO_DAY ||
      plan.expected_affected_partition_count !== AUTHORISED_PARTITION_COUNT || plan.affected_scopes.length !== AUTHORISED_PARTITION_COUNT ||
      !SHA256.test(String(AUTHORISED_AFFECTED_SCOPE_SET_SHA256 || "")) ||
      plan.authorised_affected_scope_set_sha256 !== AUTHORISED_AFFECTED_SCOPE_SET_SHA256 ||
      plannedScopeSetSha256 !== AUTHORISED_AFFECTED_SCOPE_SET_SHA256 ||
      plan.repository_head !== head || plan.target_writer_git_sha !== args.targetWriterGitSha ||
      JSON.stringify(plan.code_identity) !== JSON.stringify(stableCodeIdentity())) {
    throw new Error("Migration plan does not match LIVE bucket, repository, code or generation-v2 target");
  }
  const schedule = buildPublicationSchedule(plan.planned_puts).map((entry) => entry.key);
  if (JSON.stringify(schedule) !== JSON.stringify(plan.publication_schedule) ||
      sha256Hex(Buffer.from(JSON.stringify(schedule))) !== plan.publication_schedule_sha256) {
    throw new Error("Migration publication schedule identity is invalid");
  }
}

function journalPath(planPath) { return `${path.resolve(planPath)}.progress.json`; }

function loadJournal(planPath, plan) {
  const location = journalPath(planPath);
  if (!fs.existsSync(location)) return null;
  const journal = JSON.parse(fs.readFileSync(location, "utf8"));
  if (journal.plan_sha256 !== plan.plan_sha256 || journal.initial_gate_verified !== true ||
      journal.checkpoint_sha256 !== plan.backup_evidence.checkpoint.sha256 ||
      journal.backup_run_id !== plan.backup_evidence.readiness.backup_run_id) {
    throw new Error("Migration progress journal does not match pinned plan/backup");
  }
  return journal;
}

function saveJournal(planPath, journal) {
  const location = journalPath(planPath);
  const body = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  if (fs.existsSync(location)) {
    const temp = `${location}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temp, location);
    const directory = fs.openSync(path.dirname(location), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return;
  }
  writePrivateFile(location, body);
}

function initialJournal(plan) {
  return { plan_sha256: plan.plan_sha256, checkpoint_sha256: plan.backup_evidence.checkpoint.sha256,
    backup_run_id: plan.backup_evidence.readiness.backup_run_id, initial_gate_verified: true,
    verified_objects: {} };
}

export function assertPinnedCheckpoint(plan) {
  const checkpoint = plan.backup_evidence.checkpoint;
  let body;
  try {
    body = fs.readFileSync(checkpoint.path);
  } catch {
    throw new Error("Pinned Dropbox checkpoint is missing or unreadable");
  }
  if (body.byteLength !== checkpoint.byte_size || sha256Hex(body) !== checkpoint.sha256) {
    throw new Error("Pinned Dropbox checkpoint changed after migration PLAN");
  }
}

export function assertPinnedPrestateRecords(pinnedObjects, plannedPuts, currentObjects) {
  const puts = new Map(plannedPuts.map((entry) => [entry.key, entry]));
  const pins = new Map(pinnedObjects.map((entry) => [entry.key, entry]));
  const currents = new Map(currentObjects.map((entry) => [entry?.key, entry]));
  for (const put of plannedPuts) {
    if (!pins.has(put.key) || !sameIdentity(pins.get(put.key), put.old)) {
      throw new Error(`Planned mutation lacks its exact pinned old identity: ${put.key}`);
    }
  }
  for (const [key, pinned] of pins) {
    const current = currents.get(key) || null;
    const target = puts.get(key)?.target || null;
    if (!sameIdentity(current, pinned) && !sameIdentity(current, target)) {
      throw new Error(`Pinned migration prestate has a third identity: ${key}`);
    }
  }
}

async function assertOldOrTargetPrestate(r2, plan) {
  const currents = [];
  for (const pinned of [...plan.pinned_authoritative_objects].sort((left, right) => left.key.localeCompare(right.key))) {
    currents.push(await readMigrationCurrentIdentity(r2, pinned.key, pinned));
  }
  assertPinnedPrestateRecords(plan.pinned_authoritative_objects, plan.planned_puts, currents);
}

export async function prepareApplyInvocation({
  plan,
  args,
  env,
  r2,
  lockContext,
  dependencies = {},
}) {
  const loadJournalFn = dependencies.loadJournal ?? loadJournal;
  const backupGateFn = dependencies.backupGate ?? backupGate;
  const assertOldOrTargetPrestateFn = dependencies.assertOldOrTargetPrestate ?? assertOldOrTargetPrestate;
  const saveJournalFn = dependencies.saveJournal ?? saveJournal;
  assertPinnedCheckpoint(plan);
  let journal = loadJournalFn(args.planPath, plan);
  if (!journal) {
    const gate = await backupGateFn(args, env, r2, lockContext);
    if (gate.checkpoint.sha256 !== plan.backup_evidence.checkpoint.sha256 ||
        gate.live_observations_root.content_hash !== plan.pre_migration_observations_root.content_hash ||
        gate.readiness.backup_run_id !== plan.backup_evidence.readiness.backup_run_id) {
      throw new Error("Current backup evidence differs from pinned PLAN");
    }
    await assertOldOrTargetPrestateFn(r2, plan);
    journal = initialJournal(plan);
    saveJournalFn(args.planPath, journal);
  } else {
    await assertOldOrTargetPrestateFn(r2, plan);
  }
  return journal;
}

export function assertDurableDependencyRecords(put, plannedPuts, currentObjects, verifiedObjects) {
  const byKey = new Map(plannedPuts.map((entry) => [entry.key, entry]));
  const currents = new Map(currentObjects.map((entry) => [entry?.key, entry]));
  for (const key of put.dependencies || []) {
    const dependency = byKey.get(key);
    if (!dependency) throw new Error(`Migration parent has an unresolved dependency: ${key} -> ${put.key}`);
    const current = currents.get(key) || null;
    const durable = verifiedObjects[key];
    if (!sameIdentity(current, dependency.target) || !sameIdentity(durable, dependency.target)) {
      throw new Error(`Migration parent blocked by unverified dependency: ${key} -> ${put.key}`);
    }
  }
}

async function assertDependenciesPublished(r2, put, byKey, journal) {
  const currents = [];
  for (const key of put.dependencies || []) {
    currents.push(await readMigrationCurrentIdentity(r2, key));
  }
  assertDurableDependencyRecords(put, [...byKey.values()], currents, journal.verified_objects);
}

async function verifyPut(r2, put, body, plan) {
  const published = await readMigrationTargetObjectStrict(r2, put.key, put.target);
  if (!published.body.equals(body)) throw new Error(`Published object bytes changed: ${put.key}`);
  if (put.stage === "parquet") {
    const scope = plan.affected_scopes.find((entry) => entry.target_parquet_file.key === put.key);
    const decoded = await decodeV2MigrationParquet(published.body, "canonical");
    if (!scope || decoded.rowCount !== scope.logical_invariants.row_count) throw new Error(`Published Parquet scope mismatch: ${put.key}`);
    assertLogicalEqual(scope.logical_invariants, logicalInvariants(decoded.rows), scopeKey(scope.scope));
  } else {
    const parsed = parseJson(published);
    if (['pollutant', 'connector', 'day'].includes(put.stage)) validateManifestHash(parsed.payload, put.key, put.stage);
    if (put.stage === "pollutant" && !sameColumns(parsed.payload.columns, OBSERVATION_HISTORY_COLUMNS_V3)) {
      throw new Error(`Published pollutant schema is not canonical: ${put.key}`);
    }
    if (['month', 'year', 'root'].includes(put.stage)) {
      validateR2HistoryV2ObservationsAggregateManifest(parsed.payload, { basePrefix: GENERATION.observations_prefix });
    }
  }
}

async function applyPlan(args, env, r2, lockContext) {
  const plan = readPlan(args.planPath);
  if (plan.plan_sha256 !== args.expectedPlanSha256) throw new Error("Expected migration plan SHA-256 disagrees");
  assertPlanMatchesInvocation(plan, args, r2);
  for (const put of plan.planned_puts) storedBody(args.planPath, put);
  const journal = await prepareApplyInvocation({ plan, args, env, r2, lockContext });
  const byKey = new Map(plan.planned_puts.map((entry) => [entry.key, entry]));
  for (const key of plan.publication_schedule) {
    requireObservationsGlobalOperationLockContext({ env, expectedOwner: "migration" });
    const put = byKey.get(key);
    await assertDependenciesPublished(r2, put, byKey, journal);
    const body = storedBody(args.planPath, put);
    const current = await readMigrationCurrentIdentity(
      r2,
      put.key,
      put.stage === "parquet" ? put.old : null,
    );
    if (!sameIdentity(current, put.target)) {
      if (!sameIdentity(current, put.old)) throw new Error(`Migration PUT key has a third identity: ${put.key}`);
      const intent = buildR2ChecksumAwarePutIntent({ key: put.key, body,
        contentType: put.stage === "parquet" ? "application/octet-stream" : "application/json; charset=utf-8" });
      await putAndVerifyR2ObjectWithSha256({
        r2, intent,
        ...(put.stage === "parquet" ? {} : { headObject: async ({ r2: verifyR2, key: verifyKey }) => {
          const verified = await readExact(verifyR2, verifyKey, put.target);
          return { exists: true, key: verifyKey, bytes: verified.byte_size, sha256: verified.sha256 };
        } }),
      });
    }
    await verifyPut(r2, put, body, plan);
    journal.verified_objects[put.key] = put.target;
    saveJournal(args.planPath, journal);
  }
  return { status: "applied", plan_sha256: plan.plan_sha256, ...plan.totals };
}

async function verifyPlan(args, r2) {
  const plan = readPlan(args.planPath);
  assertPlanMatchesInvocation(plan, args, r2);
  const inventory = await inventoryAuthorisedRange(r2);
  if (!sameIdentity(inventory.root, plan.final_observations_root) ||
      inventory.root.payload.content_hash !== plan.final_observations_root_content_hash) {
    throw new Error("Verified observations root differs from planned target");
  }
  let canonicalCount = 0;
  for (const planned of plan.affected_scopes) {
    const current = inventory.pollutants.get(scopeKey(planned.scope));
    if (!current || current.kind !== "canonical" || !sameIdentity(current.manifest, planned.target_pollutant_manifest)) {
      throw new Error(`Migrated authoritative partition verification failed: ${scopeKey(planned.scope)}`);
    }
    assertLogicalEqual(planned.logical_invariants, current.logical, scopeKey(planned.scope));
    const indexKey = buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      GENERATION.observations_timeseries_index_prefix,
      planned.scope.day_utc,
      planned.scope.connector_id,
      planned.scope.pollutant_code,
    );
    const index = parseJson(await readExact(r2, indexKey, planned.target_scoped_index));
    assertScopedIndexMatches(index.payload, current, r2.bucket);
    canonicalCount += 1;
  }
  const boundedResiduals = [...inventory.pollutants.values()].filter((entry) => entry.kind === "noncanonical_shape");
  if (boundedResiduals.length) throw new Error(`Authoritative noncanonical physical status remains inside authorised range: ${boundedResiduals.length}`);
  const latest = parseJson(await readExact(r2, plan.final_latest_index.key, plan.final_latest_index));
  for (const dayUtc of [...new Set(plan.affected_scopes.map((entry) => entry.scope.day_utc))].sort()) {
    const actual = (latest.payload.day_summaries || []).find((entry) => entry.day_utc === dayUtc);
    if (!actual) throw new Error(`Verified v2 latest index is missing affected day: ${dayUtc}`);
    const expected = daySummary(dayUtc, inventory.days.get(dayUtc), inventory.connectors, inventory.pollutants, r2.bucket);
    assertLatestDaySummaryMatches(actual, expected);
  }
  for (const put of plan.planned_puts) await verifyPut(r2, put, storedBody(args.planPath, put), plan);
  for (const obsolete of plan.planned_deletions || []) {
    if (await readMigrationCurrentIdentity(r2, obsolete.key)) throw new Error(`Obsolete replaced object remains: ${obsolete.key}`);
  }
  return { status: "verified", plan_sha256: plan.plan_sha256,
    migrated_partition_count: canonicalCount, bounded_noncanonical_status_partition_count: 0, ...plan.totals };
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseMigrationArgs(argv);
  const r2 = validateV2MigrationTarget({ args, env, resolvedR2: resolveR2HistoryIndexConfig(env).r2 });
  const lockContext = requireObservationsGlobalOperationLockContext({ env, expectedOwner: "migration" });
  const result = args.mode === "plan" ? (await makePlan(args, env, r2, lockContext)).summary
    : args.mode === "apply" ? await applyPlan(args, env, r2, lockContext)
    : await verifyPlan(args, r2);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseMigrationArgs(argv);
    validateV2MigrationTarget({ args, env: process.env, resolvedR2: resolveR2HistoryIndexConfig(process.env).r2 });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  if (args) {
    const operation = process.env.UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_HELD === "true"
      ? main({ argv, env: process.env })
      : runCommandWithObservationsGlobalOperationLock({
        databaseUrl: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
        owner: "migration", runId: randomUUID(), command: process.execPath,
        commandArgs: [fileURLToPath(import.meta.url), ...argv], env: process.env,
      });
    operation.then((code) => { process.exitCode = typeof code === "number" ? code : 0; })
      .catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
  }
}
