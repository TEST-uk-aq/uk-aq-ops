import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} from "hyparquet";

import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
  resolveLegacyVerificationStatus,
  validateObservationContentHashMetadata,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildObservationHistoryIndexV3Latest,
  buildObservationHistoryIndexV3PublicationPlan,
  buildObservationHistoryIndexV3ScopedHierarchy,
  validateObservationHistoryIndexV3ChildShardArtifact,
  validateObservationHistoryIndexV3LatestArtifact,
  validateObservationHistoryIndexV3ScopedManifestArtifact,
} from "../../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
  OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
  OBSERVATION_HISTORY_WRITER_VERSION_V3,
} from "../../../workers/shared/uk_aq_observation_history_schema.mjs";
import {
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
  buildCanonicalObservationTimeseriesBoundedFiles,
} from "../../../workers/shared/uk_aq_observation_history_target_writer.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  classifyManifestFileIdentity,
  verifyManifestFileIdentity,
} from "../../../workers/shared/uk_aq_r2_file_identity.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  verifyR2StoredSha256Head,
} from "../../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import {
  buildHistoryV2TimeseriesLatestPayload,
  buildHistoryV2TimeseriesPollutantIndexPayload,
} from "../../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  isConfirmedR2ObjectAbsentError,
} from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  monthStateIsComplete,
  validateHierarchicalInventoryRoot,
  validateHierarchicalStateRoot,
  validateLatestTimeseriesState,
  validateObservationMonthInventoryShard,
  validateObservationMonthState,
} from "./hierarchical_backup_v2.mjs";
import { compressors } from "./uk_aq_parquet_dependencies.mjs";
import { buildObservationsManifestHierarchy } from "../uk_aq_observations_manifest_hierarchy.mjs";

export const OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION = 1;
export const DEFAULT_OBSERVATIONS_PREFIX = "history/v2/observations";
export const DEFAULT_V2_INDEX_ROOT = "history/_index_v2/observations_timeseries";
export const DEFAULT_V2_LATEST_KEY =
  "history/_index_v2/observations_timeseries_latest.json";
export const DEFAULT_V3_INDEX_ROOT = "history/_index_v3/observations_timeseries";
export const DEFAULT_V3_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";
export const DEFAULT_BACKUP_INVENTORY_ROOT_KEY =
  "history/_index_v2/backup_inventory_v2/root.json";
export const DEFAULT_BACKUP_STATE_ROOT_KEY =
  "_ops/checkpoints/r2_history_backup_state_v2/root.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OBSERVATION_CONTENT_HASH_METADATA_FIELDS = Object.freeze([
  "observation_content_hash",
  "observation_content_hash_algorithm",
  "observation_content_hash_contract_version",
  "observation_content_hash_row_count",
  "observation_content_hash_columns",
  "verification_status_counts",
]);
const SOURCE_HASH_PROVENANCE_MANIFEST = "manifest";
const SOURCE_HASH_PROVENANCE_LEGACY_PARQUET =
  "derived_from_legacy_canonical_parquet";
const SOURCE_MANIFEST_REFERENCE_PROVENANCE_EXACT = "exact";
const SOURCE_MANIFEST_REFERENCE_PROVENANCE_LEGACY_STALE_PARENT =
  "legacy_stale_parent_manifest_hash";
const LEGACY_STALE_PARENT_MANIFEST_HASH_CONTRACT_VERSION =
  "legacy_stale_parent_manifest_hash_v1";
const LEGACY_STALE_PARENT_SUMMARY_IDENTITY_FIELDS = Object.freeze([
  "pollutant_code",
  "manifest_key",
  "source_row_count",
  "row_count",
  "file_count",
  "total_bytes",
  "min_timeseries_id",
  "max_timeseries_id",
  "min_observed_at_utc",
  "max_observed_at_utc",
  "min_timestamp_hour_utc",
  "max_timestamp_hour_utc",
]);
const EMPTY_SOURCE_CONNECTOR_CONTRACT_VERSION =
  "canonical_empty_observation_connector_v1";
const EMPTY_SOURCE_CONNECTOR_ZERO_FIELDS = Object.freeze([
  "source_row_count",
  "row_count",
  "file_count",
  "total_bytes",
  "bytes_per_row_estimate",
  "avg_file_bytes",
  "min_file_bytes",
  "max_file_bytes",
]);
const EMPTY_SOURCE_CONNECTOR_ARRAY_FIELDS = Object.freeze([
  "pollutant_codes",
  "pollutant_manifests",
  "child_manifests",
  "files",
  "parquet_object_keys",
]);
const EMPTY_SOURCE_CONNECTOR_NULL_FIELDS = Object.freeze([
  "pollutant_code",
  "timeseries_row_counts",
  "min_timeseries_id",
  "max_timeseries_id",
  "min_observed_at_utc",
  "max_observed_at_utc",
  "min_timestamp_hour_utc",
  "max_timestamp_hour_utc",
]);
const CANONICAL_STAGE_RANK = Object.freeze({
  pollutant_manifest: 10,
  connector_manifest: 20,
  day_manifest: 30,
  month_manifest: 40,
  year_manifest: 50,
  root_manifest: 60,
});

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
    );
  }
  return value;
}

export function stableMigrationJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePrefix(value, fieldName) {
  const normalized = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (
    !normalized ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${fieldName} is invalid`);
  }
  return normalized;
}

function requireSha256(value, fieldName) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must be lowercase SHA-256`);
  }
  return normalized;
}

function requirePositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return number;
}

function requireIsoDay(value, fieldName = "day_utc") {
  const day = String(value || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (
    !ISO_DAY_PATTERN.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    throw new TypeError(`${fieldName} must be a valid YYYY-MM-DD date`);
  }
  return day;
}

function exactBuffer(value, fieldName) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${fieldName} body is unavailable`);
}

function bodyIdentity(key, body) {
  const bytes = exactBuffer(body, key);
  return Object.freeze({
    key,
    byte_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  });
}

function parseJsonBody(key, body) {
  try {
    return JSON.parse(exactBuffer(body, key).toString("utf8"));
  } catch {
    throw new Error(`JSON object is invalid: ${key}`);
  }
}

async function getRequiredObject(getObject, key, sourceName) {
  const result = await getObject({ key });
  if (!result || result.exists === false || result.body === null || result.body === undefined) {
    throw new Error(`${sourceName} object is missing: ${key}`);
  }
  const body = exactBuffer(result.body, key);
  return Object.freeze({
    ...result,
    key,
    body,
    bytes: Number(result.bytes ?? body.byteLength),
    ...bodyIdentity(key, body),
  });
}

async function getOptionalObject(getObject, key) {
  try {
    const result = await getObject({ key });
    if (!result || result.exists === false || result.body === null || result.body === undefined) {
      return null;
    }
    const body = exactBuffer(result.body, key);
    return Object.freeze({
      ...result,
      key,
      body,
      bytes: Number(result.bytes ?? body.byteLength),
      ...bodyIdentity(key, body),
    });
  } catch (error) {
    if (isConfirmedR2ObjectAbsentError(error)) {
      return null;
    }
    throw error;
  }
}

function canonicalJsonObject({ key, payload, stage, dependencies = [] }) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return Object.freeze({
    kind: `canonical_observation_${stage}`,
    key,
    payload,
    body,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage,
    dependencies: Object.freeze(dependencies.map((entry) => ({ ...entry }))),
    publication_prerequisites: Object.freeze([]),
  });
}

function manifestReferenceIdentity(reference, expectedKey, fieldName) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error(`${fieldName} reference is invalid`);
  }
  if (String(reference.manifest_key || "") !== expectedKey) {
    throw new Error(`${fieldName} reference key mismatch: ${expectedKey}`);
  }
  return requireSha256(reference.manifest_hash, `${fieldName} manifest_hash`);
}

function assertCanonicalAggregate(payload, options) {
  const canonical = validateR2HistoryV2ObservationsAggregateManifest(
    payload,
    options,
  );
  if (!sameJson(payload, canonical)) {
    throw new Error("Observations aggregate manifest has unsupported fields or ordering");
  }
  return canonical;
}

function v2ScopedIndexKey(indexRoot, scope) {
  return `${normalizePrefix(indexRoot, "v2 index root")}` +
    `/day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}/manifest.json`;
}

function canonicalManifestDescriptor(object, payload) {
  return Object.freeze({
    key: object.key,
    byte_size: object.byte_size,
    sha256: object.sha256,
    manifest_hash: payload.manifest_hash,
    row_count: payload.row_count,
    observation_content_hash: payload.observation_content_hash,
  });
}

function contentHashMetadata(metadata) {
  return {
    observation_content_hash: metadata.observation_content_hash,
    observation_content_hash_algorithm:
      metadata.observation_content_hash_algorithm,
    observation_content_hash_contract_version:
      metadata.observation_content_hash_contract_version,
    observation_content_hash_row_count:
      metadata.observation_content_hash_row_count,
    observation_content_hash_columns:
      [...metadata.observation_content_hash_columns],
    verification_status_counts: { ...metadata.verification_status_counts },
  };
}

function isGenuineLegacyHashlessObservationManifest(manifest) {
  return OBSERVATION_CONTENT_HASH_METADATA_FIELDS.every(
    (field) => !Object.hasOwn(manifest, field) || manifest[field] === null,
  );
}

function sourceManifestReferenceMismatch(pollutantKey) {
  return new Error(
    `Observation connector/pollutant identity mismatch: ${pollutantKey}`,
  );
}

function buildEmptySourceConnectorEvidence({
  connectorManifest,
  connectorManifestIdentity,
  dayUtc,
  connectorId,
  connectorKey,
}) {
  const fail = () => {
    throw new Error(
      `Observation connector with no pollutant manifests is not canonical empty: ${connectorKey}`,
    );
  };
  for (const field of EMPTY_SOURCE_CONNECTOR_ZERO_FIELDS) {
    if (!Object.hasOwn(connectorManifest, field) || connectorManifest[field] !== 0) {
      fail();
    }
  }
  for (const field of EMPTY_SOURCE_CONNECTOR_ARRAY_FIELDS) {
    if (
      !Object.hasOwn(connectorManifest, field) ||
      !Array.isArray(connectorManifest[field]) ||
      connectorManifest[field].length !== 0
    ) {
      fail();
    }
  }
  for (const field of EMPTY_SOURCE_CONNECTOR_NULL_FIELDS) {
    if (!Object.hasOwn(connectorManifest, field) || connectorManifest[field] !== null) {
      fail();
    }
  }
  const zeroStateEvidence = {};
  for (const field of EMPTY_SOURCE_CONNECTOR_ZERO_FIELDS) {
    zeroStateEvidence[field] = connectorManifest[field];
  }
  for (const field of EMPTY_SOURCE_CONNECTOR_ARRAY_FIELDS) {
    zeroStateEvidence[field] = Object.freeze([...connectorManifest[field]]);
  }
  for (const field of EMPTY_SOURCE_CONNECTOR_NULL_FIELDS) {
    zeroStateEvidence[field] = connectorManifest[field];
  }
  return Object.freeze({
    scope: Object.freeze({
      day_utc: dayUtc,
      connector_id: connectorId,
    }),
    source_manifest_key: connectorKey,
    source_manifest_identity: connectorManifestIdentity,
    source_manifest_hash: connectorManifest.manifest_hash,
    classification: "canonical_empty_observation_connector",
    contract_version: EMPTY_SOURCE_CONNECTOR_CONTRACT_VERSION,
    zero_state_evidence: Object.freeze(zeroStateEvidence),
  });
}

function requiredManifestSummaryIdentity(manifest, pollutantKey) {
  const summary = {};
  for (const field of LEGACY_STALE_PARENT_SUMMARY_IDENTITY_FIELDS) {
    if (!Object.hasOwn(manifest, field)) {
      throw sourceManifestReferenceMismatch(pollutantKey);
    }
    summary[field] = manifest[field];
  }
  return Object.freeze(summary);
}

function buildSourceManifestReferenceEvidence({
  connectorManifest,
  connectorManifestIdentity,
  pollutantReference,
  pollutantManifest,
  pollutantManifestIdentity,
  pollutantKey,
}) {
  const referencedChildHash = requireSha256(
    pollutantReference.manifest_hash,
    "pollutant manifest_hash",
  );
  const currentChildHash = requireSha256(
    pollutantManifest.manifest_hash,
    "current pollutant manifest_hash",
  );
  if (
    pollutantReference.manifest_key !== pollutantKey ||
    pollutantManifest.manifest_key !== pollutantKey
  ) {
    throw sourceManifestReferenceMismatch(pollutantKey);
  }
  const currentChildLegacyHashless =
    isGenuineLegacyHashlessObservationManifest(pollutantManifest);
  let provenance = SOURCE_MANIFEST_REFERENCE_PROVENANCE_EXACT;
  let compatibilityContractVersion = null;
  let compatibilitySummaryFields = [];
  let parentSummaryIdentity = null;
  let currentChildSummaryIdentity = null;
  let summaryIdentityAllMatch = null;
  if (currentChildHash !== referencedChildHash) {
    if (!currentChildLegacyHashless) {
      throw sourceManifestReferenceMismatch(pollutantKey);
    }
    parentSummaryIdentity = requiredManifestSummaryIdentity(
      pollutantReference,
      pollutantKey,
    );
    currentChildSummaryIdentity = requiredManifestSummaryIdentity(
      pollutantManifest,
      pollutantKey,
    );
    summaryIdentityAllMatch =
      LEGACY_STALE_PARENT_SUMMARY_IDENTITY_FIELDS.every((field) =>
        parentSummaryIdentity[field] === currentChildSummaryIdentity[field]
      );
    if (!summaryIdentityAllMatch) {
      throw sourceManifestReferenceMismatch(pollutantKey);
    }
    provenance = SOURCE_MANIFEST_REFERENCE_PROVENANCE_LEGACY_STALE_PARENT;
    compatibilityContractVersion =
      LEGACY_STALE_PARENT_MANIFEST_HASH_CONTRACT_VERSION;
    compatibilitySummaryFields =
      LEGACY_STALE_PARENT_SUMMARY_IDENTITY_FIELDS;
  }
  return Object.freeze({
    parent_manifest_identity: connectorManifestIdentity,
    parent_manifest_key: connectorManifestIdentity.key,
    parent_manifest_hash: connectorManifest.manifest_hash,
    referenced_child_manifest_key: pollutantKey,
    referenced_child_manifest_hash: referencedChildHash,
    current_child_manifest_identity: pollutantManifestIdentity,
    current_child_manifest_key: pollutantKey,
    current_child_manifest_hash: currentChildHash,
    current_child_genuine_legacy_hashless: currentChildLegacyHashless,
    provenance,
    compatibility_contract_version: compatibilityContractVersion,
    compatibility_summary_identity_fields: Object.freeze(
      [...compatibilitySummaryFields],
    ),
    parent_summary_identity: parentSummaryIdentity,
    current_child_summary_identity: currentChildSummaryIdentity,
    summary_identity_all_match: summaryIdentityAllMatch,
  });
}

async function reverifyPinnedSourceManifestReference({
  sourcePartition,
  getR2Object,
}) {
  const pinned = sourcePartition.source_manifest_reference;
  if (!pinned) {
    throw new Error(
      `Pinned source manifest reference is missing: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const connectorObject = await getRequiredObject(
    getR2Object,
    pinned.parent_manifest_identity.key,
    "canonical R2",
  );
  const connectorIdentity = bodyIdentity(
    pinned.parent_manifest_identity.key,
    connectorObject.body,
  );
  if (!sameJson(connectorIdentity, pinned.parent_manifest_identity)) {
    throw new Error(
      `Pinned source parent manifest identity changed: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const connectorManifest = parseJsonBody(
    pinned.parent_manifest_identity.key,
    connectorObject.body,
  );
  validateCanonicalHistoryV2Manifest(connectorManifest, {
    domain: "observations",
    manifest_kind: "connector",
    day_utc: sourcePartition.scope.day_utc,
    connector_id: sourcePartition.scope.connector_id,
    manifest_key: pinned.parent_manifest_identity.key,
  });
  const matchingReferences = (connectorManifest.pollutant_manifests || [])
    .filter((reference) =>
      reference?.pollutant_code === sourcePartition.scope.pollutant_code &&
      reference?.manifest_key === pinned.referenced_child_manifest_key
    );
  if (matchingReferences.length !== 1) {
    throw sourceManifestReferenceMismatch(
      pinned.referenced_child_manifest_key,
    );
  }
  const pollutantObject = await getRequiredObject(
    getR2Object,
    pinned.referenced_child_manifest_key,
    "canonical R2",
  );
  const pollutantIdentity = bodyIdentity(
    pinned.referenced_child_manifest_key,
    pollutantObject.body,
  );
  if (!sameJson(pollutantIdentity, pinned.current_child_manifest_identity)) {
    throw new Error(
      `Pinned source child manifest identity changed: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const pollutantManifest = parseJsonBody(
    pinned.referenced_child_manifest_key,
    pollutantObject.body,
  );
  validateCanonicalHistoryV2Manifest(pollutantManifest, {
    domain: "observations",
    manifest_kind: "pollutant",
    day_utc: sourcePartition.scope.day_utc,
    connector_id: sourcePartition.scope.connector_id,
    pollutant_code: sourcePartition.scope.pollutant_code,
    manifest_key: pinned.referenced_child_manifest_key,
  });
  const currentEvidence = buildSourceManifestReferenceEvidence({
    connectorManifest,
    connectorManifestIdentity: connectorIdentity,
    pollutantReference: matchingReferences[0],
    pollutantManifest,
    pollutantManifestIdentity: pollutantIdentity,
    pollutantKey: pinned.referenced_child_manifest_key,
  });
  if (!sameJson(currentEvidence, pinned)) {
    throw new Error(
      `Pinned source manifest reference evidence changed: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  return currentEvidence;
}

async function reverifyPinnedCompatibleSourceUnitsBeforeMutation({
  plan,
  getR2Object,
}) {
  for (const sourcePartition of plan.inventory.partitions) {
    if (
      sourcePartition.source_manifest_reference.provenance !==
        SOURCE_MANIFEST_REFERENCE_PROVENANCE_LEGACY_STALE_PARENT
    ) {
      continue;
    }
    const authorityUnit = plan.units.find((unit) =>
      unit.source_manifest_identity.key === sourcePartition.manifest_identity.key &&
      unit.source_manifest_identity.sha256 === sourcePartition.manifest_identity.sha256
    );
    if (!authorityUnit) {
      throw new Error(
        `Pinned compatible source unit is unavailable: ${partitionIdentity(sourcePartition.scope)}`,
      );
    }
    const rewritten = await rewritePartition({
      sourcePartition,
      getR2Object,
      writerLimits: plan.target.writer_limits,
      observationsPrefix: plan.inventory.observations_prefix,
      targetWriterGitSha: plan.target_writer_git_sha,
      sosConnectorId: plan.sos_connector_id,
      v3IndexRoot: plan.v3_index_root,
    });
    if (rewritten.unit_id !== authorityUnit.unit_id) {
      throw new Error(`Pinned source unit identity changed: ${authorityUnit.unit_id}`);
    }
    if (!sameJson(rewritten.source_files, authorityUnit.source_files)) {
      throw new Error(`Pinned source file identity changed: ${authorityUnit.unit_id}`);
    }
  }
}

async function reverifyPinnedEmptySourceConnectorsBeforeMutation({
  plan,
  getR2Object,
}) {
  for (const pinned of plan.empty_source_connectors || []) {
    const connectorObject = await getRequiredObject(
      getR2Object,
      pinned.source_manifest_key,
      "canonical R2",
    );
    const currentIdentity = bodyIdentity(
      pinned.source_manifest_key,
      connectorObject.body,
    );
    if (!sameJson(currentIdentity, pinned.source_manifest_identity)) {
      throw new Error(
        `Pinned empty source connector identity changed: ${pinned.source_manifest_key}`,
      );
    }
    const connectorManifest = parseJsonBody(
      pinned.source_manifest_key,
      connectorObject.body,
    );
    validateCanonicalHistoryV2Manifest(connectorManifest, {
      domain: "observations",
      manifest_kind: "connector",
      day_utc: pinned.scope.day_utc,
      connector_id: pinned.scope.connector_id,
      manifest_key: pinned.source_manifest_key,
    });
    const current = buildEmptySourceConnectorEvidence({
      connectorManifest,
      connectorManifestIdentity: currentIdentity,
      dayUtc: pinned.scope.day_utc,
      connectorId: pinned.scope.connector_id,
      connectorKey: pinned.source_manifest_key,
    });
    if (!sameJson(current, pinned)) {
      throw new Error(
        `Pinned empty source connector evidence changed: ${pinned.source_manifest_key}`,
      );
    }
  }
}

function assertRowsMatchSourcePartition(rows, { scope, manifest }) {
  if (rows.length !== manifest.row_count) {
    throw new Error(
      `Canonical source row count mismatch: ${partitionIdentity(scope)}`,
    );
  }
  for (const row of rows) {
    if (
      row.connector_id !== scope.connector_id ||
      row.pollutant_code !== scope.pollutant_code ||
      row.observed_at_utc.slice(0, 10) !== scope.day_utc
    ) {
      throw new Error(
        `Canonical source row scope mismatch: ${partitionIdentity(scope)}`,
      );
    }
  }
}

async function deriveLegacyObservationContentHashMetadata({
  getR2Object,
  manifest,
  scope,
  sosConnectorId,
}) {
  const rows = [];
  for (const file of [...manifest.files].sort((left, right) =>
    String(left.key).localeCompare(String(right.key))
  )) {
    const object = await getRequiredObject(getR2Object, file.key, "canonical R2");
    verifyManifestFileIdentity({
      manifestIdentity: file.etag_or_hash,
      expectedBytes: file.bytes,
      liveObject: object,
      objectKey: file.key,
    });
    rows.push(...await readCanonicalObservationRowsFromParquetBytes({
      body: object.body,
      connectorId: scope.connector_id,
      sosConnectorId,
    }));
  }
  assertRowsMatchSourcePartition(rows, { scope, manifest });
  const metadata = contentHashMetadata(computeObservationContentHash(rows));
  validateObservationContentHashMetadata(metadata, {
    rowCount: manifest.row_count,
  });
  return Object.freeze(metadata);
}

async function effectiveSourceObservationContentHash({
  getR2Object,
  manifest,
  scope,
  sosConnectorId,
}) {
  if (!isGenuineLegacyHashlessObservationManifest(manifest)) {
    validateObservationContentHashMetadata(manifest, {
      rowCount: manifest.row_count,
    });
    return Object.freeze({
      metadata: Object.freeze(contentHashMetadata(manifest)),
      provenance: SOURCE_HASH_PROVENANCE_MANIFEST,
    });
  }
  return Object.freeze({
    metadata: await deriveLegacyObservationContentHashMetadata({
      getR2Object,
      manifest,
      scope,
      sosConnectorId,
    }),
    provenance: SOURCE_HASH_PROVENANCE_LEGACY_PARQUET,
  });
}

function fileEntryFromTargetMetadata(file, pollutantCode) {
  return {
    key: file.key,
    row_count: file.row_count,
    bytes: file.byte_size,
    etag_or_hash: file.sha256,
    pollutant_codes: [pollutantCode],
    min_timeseries_id: file.row_groups.reduce(
      (value, group) => value === null
        ? group.min_timeseries_id
        : Math.min(value, group.min_timeseries_id),
      null,
    ),
    max_timeseries_id: file.row_groups.reduce(
      (value, group) => value === null
        ? group.max_timeseries_id
        : Math.max(value, group.max_timeseries_id),
      null,
    ),
    min_observed_at_utc: file.row_groups.reduce(
      (value, group) => value === null || group.min_observed_at_utc < value
        ? group.min_observed_at_utc
        : value,
      null,
    ),
    max_observed_at_utc: file.row_groups.reduce(
      (value, group) => value === null || group.max_observed_at_utc > value
        ? group.max_observed_at_utc
        : value,
      null,
    ),
    timeseries_row_counts: { ...file.timeseries_row_counts },
  };
}

function parquetIso(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Observation Parquet timestamp is invalid");
  }
  return parsed.toISOString();
}

export async function readCanonicalObservationRowsFromParquetBytes({
  body,
  connectorId,
  sosConnectorId = 1,
}) {
  const bytes = exactBuffer(body, "observation Parquet");
  const file = new Uint8Array(bytes).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Number(metadata.num_rows || 0);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
    throw new Error("Canonical observation Parquet must contain rows");
  }
  const schemaColumns = new Set(
    parquetSchema(metadata).children.map((column) => String(column.element.name)),
  );
  const required = [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
  ];
  const missing = required.filter((column) => !schemaColumns.has(column));
  if (missing.length) {
    throw new Error(
      `Canonical observation Parquet is missing columns: ${missing.join(",")}`,
    );
  }
  const statusColumn = schemaColumns.has("verification_status")
    ? "verification_status"
    : schemaColumns.has("status")
    ? "status"
    : null;
  const columns = [...required, ...(statusColumn ? [statusColumn] : [])];
  let decoded = [];
  await parquetRead({
    file,
    metadata,
    columns,
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (rows) => {
      decoded = Array.isArray(rows) ? rows : [];
    },
  });
  if (decoded.length !== rowCount) {
    throw new Error("Canonical observation Parquet row count changed while reading");
  }
  return Object.freeze(decoded.map((values) => {
    if (!Array.isArray(values)) {
      throw new Error("Canonical observation Parquet contains an invalid row");
    }
    const statusRow = statusColumn
      ? { [statusColumn]: values[required.length] ?? null }
      : {};
    return normalizeCanonicalObservationRow({
      connector_id: Number(values[0]),
      station_id: values[1] === null || values[1] === undefined
        ? null
        : Number(values[1]),
      timeseries_id: Number(values[2]),
      pollutant_code: values[3],
      observed_at_utc: parquetIso(values[4]),
      value: Number(values[5]),
      verification_status: resolveLegacyVerificationStatus(statusRow, {
        isSos: Number(connectorId) === Number(sosConnectorId),
      }),
    });
  }));
}

export function validateObservationHistoryV3MigrationEnvironment({
  environment,
  configuredEnvironment,
  bucket,
  expectedBucket,
  historyVersion,
  indexVersion,
  integrityVersion,
  apply = false,
  operation = "migration",
}) {
  const requested = String(environment || "").trim();
  const configured = String(configuredEnvironment || "").trim();
  const actualBucket = String(bucket || "").trim();
  const pinnedBucket = String(expectedBucket || "").trim();
  const blockers = [];
  if (requested !== "TEST") blockers.push("environment_must_be_TEST");
  if (configured !== requested) blockers.push("configured_environment_mismatch");
  if (!actualBucket || !pinnedBucket || actualBucket !== pinnedBucket) {
    blockers.push("r2_bucket_identity_mismatch");
  }
  if (String(historyVersion || "").trim() !== "v2") {
    blockers.push("logical_history_version_must_remain_v2");
  }
  const deployedIndexVersion = String(indexVersion || "").trim();
  if (
    operation === "rollback"
      ? !new Set(["v2", "v3"]).has(deployedIndexVersion)
      : deployedIndexVersion !== "v2"
  ) {
    blockers.push(
      operation === "rollback"
        ? "rollback_observation_index_must_be_v2_or_v3"
        : "deployed_observation_index_must_remain_v2",
    );
  }
  if (!String(integrityVersion || "").trim()) {
    blockers.push("integrity_version_identity_missing");
  }
  if (apply && blockers.length) {
    throw new Error(`TEST migration environment guard failed: ${blockers.join(",")}`);
  }
  return Object.freeze({
    ok: blockers.length === 0,
    environment: requested,
    configured_environment: configured,
    bucket: actualBucket,
    expected_bucket: pinnedBucket,
    history_version: String(historyVersion || "").trim(),
    index_version: deployedIndexVersion,
    integrity_version: String(integrityVersion || "").trim(),
    blockers: Object.freeze(blockers),
  });
}

const WRITER_FREEZE_EVIDENCE = Object.freeze([
  {
    id: "prune_daily_phase_b",
    kind: "scheduled_workflow",
    schedule_file: "cloudflare/scheduler/jobs.toml",
    workflow_file: ".github/workflows/uk_aq_prune_daily.yml",
    implementation_file: "workers/uk_aq_prune_daily/phase_b_history_r2.mjs",
    markers: [
      "[jobs.uk_aq_prune_daily]",
      "cron_expr = \"30 2 * * *\"",
      "github_workflow_file = \"uk_aq_prune_daily.yml\"",
      "workers/uk_aq_prune_daily/job.mjs",
      "completion_source: \"prune_daily_phase_b\"",
    ],
  },
  {
    id: "write_enabled_integrity",
    kind: "coordinated_external_runner",
    schedule_file: "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
    workflow_file: "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-runner.sh",
    implementation_file: "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs",
    markers: [
      "DAILY_TASK_HEALTH_TASK_KEY = \"ops.history_integrity\"",
      "--run-backfill",
      "uk_aq_apply_integrity_proposal.mjs",
    ],
  },
  {
    id: "sos_historical_replacement",
    kind: "coordinated_external_runner",
    schedule_file: "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
    workflow_file: "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-runner.sh",
    implementation_file: "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs",
    markers: [
      "SOS_HISTORICAL_REPLACEMENT_EXECUTION_PATH",
      "sos_light",
      "dedicated_sos_historical_proposal",
    ],
  },
  {
    id: "supported_observation_backfill",
    kind: "manual_or_integrity_child",
    schedule_file: "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh",
    workflow_file: "scripts/uk_aq_backfill_local.sh",
    implementation_file: "workers/uk_aq_backfill_local/run_job.ts",
    markers: [
      "UK_AQ_BACKFILL_RUN_MODE=\"source_to_r2\"",
      "UK_AQ_BACKFILL_RUN_MODE",
      "source_to_r2",
      "obs_aqi_to_r2",
    ],
  },
  {
    id: "manual_observation_repair_and_migration",
    kind: "manual_mutation_entrypoints",
    schedule_file: "scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs",
    workflow_file: "scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs",
    implementation_file: "scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs",
    markers: [
      "runV2ObservationsRepair",
      "uk_aq_build_v2_observations_from_dropbox_v1.mjs",
      "--write-r2",
    ],
  },
]);

export function deriveObservationHistoryV3WriterFreezePlan({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot || ".");
  const entries = WRITER_FREEZE_EVIDENCE.map((definition) => {
    const files = [
      definition.schedule_file,
      definition.workflow_file,
      definition.implementation_file,
    ];
    const contents = files.map((relative) => {
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) {
        throw new Error(`Writer-freeze evidence file is missing: ${relative}`);
      }
      return fs.readFileSync(absolute, "utf8");
    });
    const combined = contents.join("\n");
    const missingMarkers = definition.markers.filter(
      (marker) => !combined.includes(marker),
    );
    if (missingMarkers.length) {
      throw new Error(
        `Writer-freeze evidence drift for ${definition.id}: ${missingMarkers.join(" | ")}`,
      );
    }
    return Object.freeze({
      id: definition.id,
      kind: definition.kind,
      evidence_files: Object.freeze(files),
      pause_required: true,
      resume_only_after: "accepted_v3_cutover_or_completed_v2_rollback",
      operator_confirmation_required: true,
    });
  });
  return Object.freeze({
    derived_from_repository: true,
    entries: Object.freeze(entries),
    pause_order: Object.freeze(entries.map((entry) => entry.id)),
    resume_order: Object.freeze([...entries].reverse().map((entry) => entry.id)),
  });
}

export async function inventoryAuthoritativeCanonicalObservationHistory({
  getR2Object,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  v2IndexRoot = DEFAULT_V2_INDEX_ROOT,
  v2LatestKey = DEFAULT_V2_LATEST_KEY,
  sosConnectorId = 1,
}) {
  if (typeof getR2Object !== "function") {
    throw new TypeError("Canonical inventory requires getR2Object adapter");
  }
  const prefix = normalizePrefix(observationsPrefix, "observations prefix");
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const rootObject = await getRequiredObject(getR2Object, rootKey, "R2");
  const rootPayload = assertCanonicalAggregate(
    parseJsonBody(rootKey, rootObject.body),
    { basePrefix: prefix },
  );
  const hierarchyObjects = [
    { level: "root", ...bodyIdentity(rootKey, rootObject.body), payload: rootPayload },
  ];
  const days = [];
  const connectors = [];
  const emptyConnectors = [];
  const partitions = [];
  for (const yearReference of rootPayload.children) {
    const yearKey = buildR2HistoryV2ObservationsYearManifestKey(
      prefix,
      yearReference.year,
    );
    if (yearReference.manifest_key !== yearKey) {
      throw new Error(`Observation year key is non-canonical: ${yearReference.manifest_key}`);
    }
    const yearObject = await getRequiredObject(getR2Object, yearKey, "R2");
    const yearPayload = assertCanonicalAggregate(
      parseJsonBody(yearKey, yearObject.body),
      { basePrefix: prefix },
    );
    if (yearPayload.content_hash !== yearReference.content_hash) {
      throw new Error(`Observation root/year identity mismatch: ${yearKey}`);
    }
    hierarchyObjects.push({
      level: "year",
      ...bodyIdentity(yearKey, yearObject.body),
      payload: yearPayload,
    });
    for (const monthReference of yearPayload.children) {
      const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(
        prefix,
        yearPayload.year,
        monthReference.month,
      );
      if (monthReference.manifest_key !== monthKey) {
        throw new Error(`Observation month key is non-canonical: ${monthReference.manifest_key}`);
      }
      const monthObject = await getRequiredObject(getR2Object, monthKey, "R2");
      const monthPayload = assertCanonicalAggregate(
        parseJsonBody(monthKey, monthObject.body),
        { basePrefix: prefix },
      );
      if (monthPayload.content_hash !== monthReference.content_hash) {
        throw new Error(`Observation year/month identity mismatch: ${monthKey}`);
      }
      hierarchyObjects.push({
        level: "month",
        ...bodyIdentity(monthKey, monthObject.body),
        payload: monthPayload,
      });
      for (const dayReference of monthPayload.children) {
        const dayUtc = requireIsoDay(dayReference.day_utc);
        const dayKey = buildHistoryV2DayManifestKey(prefix, dayUtc);
        if (dayReference.manifest_key !== dayKey) {
          throw new Error(`Observation day key is non-canonical: ${dayReference.manifest_key}`);
        }
        const dayObject = await getRequiredObject(getR2Object, dayKey, "R2");
        const dayPayload = parseJsonBody(dayKey, dayObject.body);
        validateCanonicalHistoryV2Manifest(dayPayload, {
          domain: "observations",
          manifest_kind: "day",
          day_utc: dayUtc,
          manifest_key: dayKey,
        });
        if (dayPayload.manifest_hash !== dayReference.manifest_hash) {
          throw new Error(`Observation month/day identity mismatch: ${dayKey}`);
        }
        const dayRecord = {
          ...bodyIdentity(dayKey, dayObject.body),
          day_utc: dayUtc,
          payload: dayPayload,
        };
        days.push(dayRecord);
        const connectorReferences = Array.isArray(dayPayload.connector_manifests)
          ? dayPayload.connector_manifests
          : [];
        if (!connectorReferences.length) {
          throw new Error(`Observation day has no connector manifests: ${dayKey}`);
        }
        for (const connectorReference of connectorReferences) {
          const connectorId = requirePositiveInteger(
            connectorReference.connector_id,
            "connector_id",
          );
          const connectorKey = buildHistoryV2ConnectorManifestKey(
            prefix,
            dayUtc,
            connectorId,
          );
          const expectedConnectorHash = manifestReferenceIdentity(
            connectorReference,
            connectorKey,
            "connector",
          );
          const connectorObject = await getRequiredObject(
            getR2Object,
            connectorKey,
            "R2",
          );
          const connectorPayload = parseJsonBody(connectorKey, connectorObject.body);
          validateCanonicalHistoryV2Manifest(connectorPayload, {
            domain: "observations",
            manifest_kind: "connector",
            day_utc: dayUtc,
            connector_id: connectorId,
            manifest_key: connectorKey,
          });
          if (connectorPayload.manifest_hash !== expectedConnectorHash) {
            throw new Error(`Observation day/connector identity mismatch: ${connectorKey}`);
          }
          const connectorIdentity = bodyIdentity(
            connectorKey,
            connectorObject.body,
          );
          const connectorRecord = {
            ...connectorIdentity,
            day_utc: dayUtc,
            connector_id: connectorId,
            payload: connectorPayload,
          };
          connectors.push(connectorRecord);
          if (!Array.isArray(connectorPayload.pollutant_manifests)) {
            throw new Error(
              `Observation connector pollutant_manifests is not an array: ${connectorKey}`,
            );
          }
          const pollutantReferences = connectorPayload.pollutant_manifests;
          if (!pollutantReferences.length) {
            emptyConnectors.push(buildEmptySourceConnectorEvidence({
              connectorManifest: connectorPayload,
              connectorManifestIdentity: connectorIdentity,
              dayUtc,
              connectorId,
              connectorKey,
            }));
            continue;
          }
          for (const pollutantReference of pollutantReferences) {
            const pollutantCode = String(
              pollutantReference.pollutant_code || "",
            ).trim();
            const pollutantKey = buildHistoryV2PollutantManifestKey(
              prefix,
              dayUtc,
              connectorId,
              pollutantCode,
            );
            const expectedPollutantHash = manifestReferenceIdentity(
              pollutantReference,
              pollutantKey,
              "pollutant",
            );
            const pollutantObject = await getRequiredObject(
              getR2Object,
              pollutantKey,
              "R2",
            );
            const pollutantPayload = parseJsonBody(
              pollutantKey,
              pollutantObject.body,
            );
            validateCanonicalHistoryV2Manifest(pollutantPayload, {
              domain: "observations",
              manifest_kind: "pollutant",
              day_utc: dayUtc,
              connector_id: connectorId,
              pollutant_code: pollutantCode,
              manifest_key: pollutantKey,
            });
            const pollutantIdentity = bodyIdentity(
              pollutantKey,
              pollutantObject.body,
            );
            const sourceManifestReference =
              buildSourceManifestReferenceEvidence({
                connectorManifest: connectorPayload,
                connectorManifestIdentity: connectorIdentity,
                pollutantReference,
                pollutantManifest: pollutantPayload,
                pollutantManifestIdentity: pollutantIdentity,
                pollutantKey,
              });
            if (
              sourceManifestReference.referenced_child_manifest_hash !==
                expectedPollutantHash
            ) {
              throw sourceManifestReferenceMismatch(pollutantKey);
            }
            if (pollutantPayload.row_count <= 0 || pollutantPayload.file_count <= 0) {
              throw new Error(`Canonical migration partition must be non-empty: ${pollutantKey}`);
            }
            const scope = { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode };
            const effectiveSourceHash =
              await effectiveSourceObservationContentHash({
                getR2Object,
                manifest: pollutantPayload,
                scope,
                sosConnectorId,
              });
            const v2IndexKey = v2ScopedIndexKey(v2IndexRoot, scope);
            const v2IndexObject = await getOptionalObject(getR2Object, v2IndexKey);
            partitions.push(Object.freeze({
              scope: Object.freeze(scope),
              manifest: pollutantPayload,
              manifest_identity: pollutantIdentity,
              source_manifest_reference: sourceManifestReference,
              source_observation_content_hash_metadata:
                effectiveSourceHash.metadata,
              source_observation_content_hash_provenance:
                effectiveSourceHash.provenance,
              canonical_files: Object.freeze(
                pollutantPayload.files.map((file) => Object.freeze({ ...file })),
              ),
              existing_v2_index_identity: v2IndexObject
                ? bodyIdentity(v2IndexKey, v2IndexObject.body)
                : null,
            }));
          }
        }
      }
    }
  }
  emptyConnectors.sort((left, right) =>
    left.scope.day_utc.localeCompare(right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id
  );
  partitions.sort((left, right) =>
    left.scope.day_utc.localeCompare(right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id ||
    left.scope.pollutant_code.localeCompare(right.scope.pollutant_code)
  );
  const latestObject = await getOptionalObject(getR2Object, v2LatestKey);
  return Object.freeze({
    observations_prefix: prefix,
    root_manifest: Object.freeze(hierarchyObjects[0]),
    hierarchy_objects: Object.freeze(hierarchyObjects),
    day_manifests: Object.freeze(days),
    connector_manifests: Object.freeze(connectors),
    empty_source_connectors: Object.freeze(emptyConnectors),
    partitions: Object.freeze(partitions),
    existing_v2_latest_identity: latestObject
      ? bodyIdentity(v2LatestKey, latestObject.body)
      : null,
  });
}

function maxCanonicalIso(values) {
  const normalized = values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return normalized.at(-1) || null;
}

function buildObservationHistoryV2CompletenessExpectation({
  canonicalInventory,
  bucket,
  v2IndexRoot,
  v2LatestKey,
}) {
  const normalizedBucket = String(bucket || "").trim();
  if (!normalizedBucket) {
    throw new TypeError("Rollback v2 completeness verification requires the R2 bucket");
  }
  const connectorByScope = new Map(
    canonicalInventory.connector_manifests.map((entry) => [
      `${entry.day_utc}|${entry.connector_id}`,
      entry,
    ]),
  );
  const dayByDayUtc = new Map(
    canonicalInventory.day_manifests.map((entry) => [entry.day_utc, entry]),
  );
  const pollutantIndexes = canonicalInventory.partitions.map((partition) => {
    const { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode } =
      partition.scope;
    const key = v2ScopedIndexKey(v2IndexRoot, partition.scope);
    const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      generatedAt: null,
      bucket: normalizedBucket,
      dataPrefix: canonicalInventory.observations_prefix,
      pollutantManifestKey: partition.manifest_identity.key,
      pollutantManifest: partition.manifest,
    });
    return Object.freeze({
      key,
      scope: partition.scope,
      payload: Object.freeze(payload),
    });
  });

  const pollutantsByConnector = new Map();
  for (const entry of pollutantIndexes) {
    const connectorScope = `${entry.scope.day_utc}|${entry.scope.connector_id}`;
    const values = pollutantsByConnector.get(connectorScope) || [];
    values.push(entry);
    pollutantsByConnector.set(connectorScope, values);
  }
  const connectorsByDay = new Map();
  for (const [connectorScope, entries] of pollutantsByConnector) {
    const [dayUtc, connectorIdText] = connectorScope.split("|");
    const connectorId = Number(connectorIdText);
    const connectorManifest = connectorByScope.get(connectorScope);
    if (!connectorManifest) {
      throw new Error(`Canonical connector manifest is missing for ${connectorScope}`);
    }
    const connectorSummary = Object.freeze({
      connector_id: connectorId,
      row_count: entries.reduce((sum, entry) => sum + entry.payload.source_row_count, 0),
      pollutant_indexes: Object.freeze(entries),
      backed_up_at_utc:
        String(connectorManifest.payload?.backed_up_at_utc || "").trim() ||
        maxCanonicalIso(entries.map((entry) => entry.payload.backed_up_at_utc)),
    });
    const values = connectorsByDay.get(dayUtc) || [];
    values.push(connectorSummary);
    connectorsByDay.set(dayUtc, values);
  }

  const daySummaries = [...connectorsByDay]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dayUtc, connectors]) => {
      connectors.sort((left, right) => left.connector_id - right.connector_id);
      const pollutantEntries = connectors.flatMap((entry) => entry.pollutant_indexes);
      const dayManifest = dayByDayUtc.get(dayUtc);
      if (!dayManifest) throw new Error(`Canonical day manifest is missing for ${dayUtc}`);
      return Object.freeze({
        day_utc: dayUtc,
        connector_count: connectors.length,
        connector_ids: connectors.map((entry) => entry.connector_id),
        connectors: connectors.map((entry) => ({
          connector_id: entry.connector_id,
          row_count: entry.row_count,
        })),
        total_rows: connectors.reduce((sum, entry) => sum + entry.row_count, 0),
        pollutant_codes: Array.from(new Set(
          pollutantEntries.map((entry) => entry.scope.pollutant_code),
        )).sort((left, right) => left.localeCompare(right)),
        pollutant_index_count: pollutantEntries.length,
        file_count: pollutantEntries.reduce(
          (sum, entry) => sum + entry.payload.file_count,
          0,
        ),
        indexed_file_count: pollutantEntries.reduce(
          (sum, entry) => sum + entry.payload.indexed_file_count,
          0,
        ),
        backed_up_at_utc:
          String(dayManifest.payload?.backed_up_at_utc || "").trim() ||
          maxCanonicalIso(connectors.map((entry) => entry.backed_up_at_utc)),
      });
    });

  return Object.freeze({
    pollutant_indexes: Object.freeze(pollutantIndexes),
    day_summaries: Object.freeze(daySummaries),
    latest_key: v2LatestKey,
  });
}

export async function verifyObservationHistoryV2IndexCompleteness({
  getR2Object,
  bucket,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  v2IndexRoot = DEFAULT_V2_INDEX_ROOT,
  v2LatestKey = DEFAULT_V2_LATEST_KEY,
  expectedCanonicalRootIdentity = null,
}) {
  const canonicalInventory = await inventoryAuthoritativeCanonicalObservationHistory({
    getR2Object,
    observationsPrefix,
    v2IndexRoot,
    v2LatestKey,
  });
  if (
    expectedCanonicalRootIdentity &&
    (
      canonicalInventory.root_manifest.key !== expectedCanonicalRootIdentity.key ||
      canonicalInventory.root_manifest.byte_size !== expectedCanonicalRootIdentity.byte_size ||
      canonicalInventory.root_manifest.sha256 !== expectedCanonicalRootIdentity.sha256
    )
  ) {
    throw new Error("Rollback canonical root identity changed before v2 index verification");
  }
  const expectation = buildObservationHistoryV2CompletenessExpectation({
    canonicalInventory,
    bucket,
    v2IndexRoot,
    v2LatestKey,
  });
  const verifiedPollutants = [];
  for (const expected of expectation.pollutant_indexes) {
    if (
      expected.payload.index_coverage !== "complete" ||
      expected.payload.indexed_file_count !== expected.payload.file_count
    ) {
      throw new Error(
        `Restored canonical scope cannot produce complete v2 index coverage: ${expected.key}`,
      );
    }
    const object = await getRequiredObject(
      getR2Object,
      expected.key,
      "Rebuilt v2 observation-timeseries index",
    );
    const actual = parseJsonBody(expected.key, object.body);
    const expectedPayload = expected.payload.generated_at
      ? expected.payload
      : { ...expected.payload, generated_at: actual.generated_at ?? null };
    if (
      actual.index_coverage !== "complete" ||
      actual.indexed_file_count !== actual.file_count ||
      stableMigrationJson(actual) !== stableMigrationJson(expectedPayload)
    ) {
      throw new Error(
        `Rebuilt v2 observation-timeseries pollutant index is incomplete or contradictory: ${expected.key}`,
      );
    }
    verifiedPollutants.push(bodyIdentity(expected.key, object.body));
  }

  const latestObject = await getRequiredObject(
    getR2Object,
    expectation.latest_key,
    "Rebuilt v2 observation-timeseries latest index",
  );
  const actualLatest = parseJsonBody(expectation.latest_key, latestObject.body);
  const expectedLatest = buildHistoryV2TimeseriesLatestPayload({
    domain: "observations",
    bucket,
    generatedAt: actualLatest.generated_at,
    indexPrefix: path.posix.dirname(expectation.latest_key),
    dataPrefix: canonicalInventory.observations_prefix,
    timeseriesIndexPrefix: v2IndexRoot,
    daySummaries: expectation.day_summaries,
  });
  if (stableMigrationJson(actualLatest) !== stableMigrationJson(expectedLatest)) {
    throw new Error(
      `Rebuilt v2 observation-timeseries latest index is incomplete or contradictory: ${expectation.latest_key}`,
    );
  }
  return Object.freeze({
    ok: true,
    complete: true,
    canonical_root_identity: Object.freeze({
      key: canonicalInventory.root_manifest.key,
      byte_size: canonicalInventory.root_manifest.byte_size,
      sha256: canonicalInventory.root_manifest.sha256,
    }),
    day_count: expectation.day_summaries.length,
    connector_count: canonicalInventory.connector_manifests.length,
    pollutant_index_count: verifiedPollutants.length,
    pollutant_indexes: Object.freeze(verifiedPollutants),
    latest_index: Object.freeze(bodyIdentity(expectation.latest_key, latestObject.body)),
  });
}

export async function verifyObservationHistoryDropboxCheckpoint({
  getR2Object,
  getBackupObject,
  canonicalInventory,
  expectedInventoryRootSha256,
  expectedStateRootSha256,
  inventoryRootKey = DEFAULT_BACKUP_INVENTORY_ROOT_KEY,
  stateRootKey = DEFAULT_BACKUP_STATE_ROOT_KEY,
}) {
  if (!expectedInventoryRootSha256 || !expectedStateRootSha256) {
    throw new Error("Explicit backup inventory and checkpoint SHA-256 identities are required");
  }
  const inventoryObject = await getRequiredObject(
    getR2Object,
    inventoryRootKey,
    "R2 backup inventory",
  );
  if (inventoryObject.sha256 !== requireSha256(
    expectedInventoryRootSha256,
    "expected inventory root SHA-256",
  )) {
    throw new Error("Pinned R2 backup inventory root identity changed");
  }
  const inventory = validateHierarchicalInventoryRoot(
    parseJsonBody(inventoryRootKey, inventoryObject.body),
  );
  if (
    inventory.observations.source_root_manifest_key !==
      canonicalInventory.root_manifest.key ||
    inventory.observations.source_root_hash !==
      canonicalInventory.root_manifest.payload.content_hash
  ) {
    throw new Error("Dropbox inventory does not cover the authoritative observation root");
  }
  const stateObject = await getRequiredObject(
    getBackupObject,
    stateRootKey,
    "Dropbox checkpoint",
  );
  if (stateObject.sha256 !== requireSha256(
    expectedStateRootSha256,
    "expected Dropbox state root SHA-256",
  )) {
    throw new Error("Pinned Dropbox checkpoint root identity changed");
  }
  const state = validateHierarchicalStateRoot(
    parseJsonBody(stateRootKey, stateObject.body),
  );
  if (
    state.observations.processed_source_root_hash !==
      inventory.observations.source_root_hash
  ) {
    throw new Error("Dropbox checkpoint has not processed the current observation root");
  }
  const monthInventoryShards = [];
  const monthStateShards = [];
  for (const year of inventory.observations.years) {
    const stateYear = state.observations.years.find(
      (entry) => entry.year === year.year,
    );
    if (!stateYear || stateYear.processed_source_year_hash !== year.content_hash) {
      throw new Error(`Dropbox checkpoint year is incomplete: ${year.year}`);
    }
    for (const month of year.months) {
      const inventoryShardObject = await getRequiredObject(
        getR2Object,
        month.inventory_shard_key,
        "R2 backup inventory shard",
      );
      const inventoryShard = validateObservationMonthInventoryShard(
        parseJsonBody(month.inventory_shard_key, inventoryShardObject.body),
      );
      if (inventoryShard.source_month_hash !== month.content_hash) {
        throw new Error(
          `Backup month inventory identity mismatch: ${year.year}-${month.month}`,
        );
      }
      const stateMonthReference = stateYear.months.find(
        (entry) => entry.month === month.month,
      );
      if (!stateMonthReference) {
        throw new Error(`Dropbox month checkpoint is missing: ${year.year}-${month.month}`);
      }
      const stateShardObject = await getRequiredObject(
        getBackupObject,
        stateMonthReference.state_shard_key,
        "Dropbox month checkpoint",
      );
      if (
        stateMonthReference.state_shard_hash &&
        stateMonthReference.state_shard_hash !== stateShardObject.sha256
      ) {
        throw new Error(
          `Dropbox month checkpoint strong identity mismatch: ${year.year}-${month.month}`,
        );
      }
      const stateShard = validateObservationMonthState(
        parseJsonBody(stateMonthReference.state_shard_key, stateShardObject.body),
        year.year,
        month.month,
      );
      if (
        stateShard.processed_source_month_hash !== inventoryShard.source_month_hash ||
        !monthStateIsComplete(stateShard, inventoryShard)
      ) {
        throw new Error(`Dropbox month checkpoint is incomplete: ${year.year}-${month.month}`);
      }
      monthInventoryShards.push(Object.freeze({
        key: month.inventory_shard_key,
        identity: bodyIdentity(month.inventory_shard_key, inventoryShardObject.body),
        payload: inventoryShard,
      }));
      monthStateShards.push(Object.freeze({
        key: stateMonthReference.state_shard_key,
        identity: bodyIdentity(stateMonthReference.state_shard_key, stateShardObject.body),
        payload: stateShard,
      }));
    }
  }
  const latestState = validateLatestTimeseriesState(
    state.global_units.observations_timeseries_latest,
  );
  const latestInventory = inventory.global_units.observations_timeseries_latest;
  if (
    latestState.verified !== true ||
    latestState.processed_source_sha256 !== latestInventory.sha256 ||
    latestState.byte_size !== latestInventory.byte_size
  ) {
    throw new Error("Dropbox checkpoint latest-timeseries unit is incomplete");
  }
  return Object.freeze({
    verified: true,
    inventory_root: Object.freeze({
      ...bodyIdentity(inventoryRootKey, inventoryObject.body),
      payload: inventory,
    }),
    state_root: Object.freeze({
      ...bodyIdentity(stateRootKey, stateObject.body),
      payload: state,
    }),
    month_inventory_shards: Object.freeze(monthInventoryShards),
    month_state_shards: Object.freeze(monthStateShards),
    observations_source_root_hash: inventory.observations.source_root_hash,
  });
}

function partitionIdentity(scope) {
  return `${scope.day_utc}|${scope.connector_id}|${scope.pollutant_code}`;
}

async function rewritePartition({
  sourcePartition,
  getR2Object,
  writerLimits,
  observationsPrefix,
  targetWriterGitSha,
  sosConnectorId,
  v3IndexRoot,
}) {
  await reverifyPinnedSourceManifestReference({
    sourcePartition,
    getR2Object,
  });
  const rows = [];
  const sourceFiles = [];
  for (const file of [...sourcePartition.canonical_files].sort((a, b) =>
    String(a.key).localeCompare(String(b.key))
  )) {
    const object = await getRequiredObject(getR2Object, file.key, "canonical R2");
    verifyManifestFileIdentity({
      manifestIdentity: file.etag_or_hash,
      expectedBytes: file.bytes,
      liveObject: object,
      objectKey: file.key,
    });
    const decoded = await readCanonicalObservationRowsFromParquetBytes({
      body: object.body,
      connectorId: sourcePartition.scope.connector_id,
      sosConnectorId,
    });
    rows.push(...decoded);
    sourceFiles.push(Object.freeze({
      key: file.key,
      byte_size: object.body.byteLength,
      sha256: sha256Hex(object.body),
      manifest_identity_type: classifyManifestFileIdentity(
        file.etag_or_hash,
        { objectKey: file.key },
      ).type,
    }));
  }
  const sourceLogical = computeObservationContentHash(rows);
  assertRowsMatchSourcePartition(rows, {
    scope: sourcePartition.scope,
    manifest: sourcePartition.manifest,
  });
  const effectiveSourceHash =
    sourcePartition.source_observation_content_hash_metadata;
  validateObservationContentHashMetadata(effectiveSourceHash, {
    rowCount: sourcePartition.manifest.row_count,
  });
  if (
    sourcePartition.source_observation_content_hash_provenance ===
      SOURCE_HASH_PROVENANCE_MANIFEST
  ) {
    validateObservationContentHashMetadata(sourcePartition.manifest, {
      rowCount: sourcePartition.manifest.row_count,
    });
    if (!sameJson(contentHashMetadata(sourcePartition.manifest), effectiveSourceHash)) {
      throw new Error(
        `Manifest source logical identity changed: ${partitionIdentity(sourcePartition.scope)}`,
      );
    }
  } else if (
    sourcePartition.source_observation_content_hash_provenance !==
      SOURCE_HASH_PROVENANCE_LEGACY_PARQUET ||
    !isGenuineLegacyHashlessObservationManifest(sourcePartition.manifest)
  ) {
    throw new Error(
      `Canonical source hash provenance is invalid: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const computedSourceHash = contentHashMetadata(sourceLogical);
  if (
    !sameJson(computedSourceHash, effectiveSourceHash)
  ) {
    throw new Error(
      `Canonical source logical identity mismatch: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const target = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits: writerLimits,
    fileKeyForOrdinal: (ordinal) => buildHistoryV2PartKey(
      observationsPrefix,
      sourcePartition.scope.day_utc,
      sourcePartition.scope.connector_id,
      sourcePartition.scope.pollutant_code,
      ordinal,
    ),
  });
  if (
    !sameJson(contentHashMetadata(target.metadata), effectiveSourceHash)
  ) {
    throw new Error(
      `Target rewrite logical identity mismatch: ${partitionIdentity(sourcePartition.scope)}`,
    );
  }
  const fileIntents = target.file_bodies.map((file) =>
    buildR2ChecksumAwarePutIntent({ key: file.key, body: file.body })
  );
  const fileEntries = target.metadata.files.map((file) =>
    fileEntryFromTargetMetadata(file, sourcePartition.scope.pollutant_code)
  );
  const manifestKey = buildHistoryV2PollutantManifestKey(
    observationsPrefix,
    sourcePartition.scope.day_utc,
    sourcePartition.scope.connector_id,
    sourcePartition.scope.pollutant_code,
  );
  const manifestPayload = buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc: sourcePartition.scope.day_utc,
    connectorId: sourcePartition.scope.connector_id,
    pollutantCode: sourcePartition.scope.pollutant_code,
    runId: null,
    manifestKey,
    sourceRowCount: target.metadata.row_count,
    fileEntries,
    writerGitSha: targetWriterGitSha,
    backedUpAtUtc: sourcePartition.manifest.backed_up_at_utc,
    observationContentHash: contentHashMetadata(target.metadata),
    physicalSchema: {
      history_schema_version: target.metadata.history_schema_version,
      columns: [...target.metadata.columns],
      writer_version: target.metadata.writer_version,
    },
  });
  const manifestObject = canonicalJsonObject({
    key: manifestKey,
    payload: manifestPayload,
    stage: "pollutant_manifest",
    dependencies: fileIntents.map((intent) => ({
      kind: "canonical_parquet",
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
    })),
  });
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: target.metadata,
    canonicalManifest: canonicalManifestDescriptor(
      manifestObject,
      manifestPayload,
    ),
    indexRoot: v3IndexRoot,
  });
  const rowGroupCount = target.metadata.files.reduce(
    (total, file) => total + file.row_group_count,
    0,
  );
  return Object.freeze({
    unit_id: sha256Hex(stableMigrationJson({
      source_manifest: sourcePartition.manifest_identity,
      source_files: sourceFiles,
      source_observation_content_hash_metadata: effectiveSourceHash,
      source_observation_content_hash_provenance:
        sourcePartition.source_observation_content_hash_provenance,
      source_manifest_reference:
        sourcePartition.source_manifest_reference,
      writer_limits: writerLimits,
      target_writer_git_sha: targetWriterGitSha,
      target_schema: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
      target_writer: OBSERVATION_HISTORY_WRITER_VERSION_V3,
      target_layout: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    })),
    scope: sourcePartition.scope,
    source_manifest: sourcePartition.manifest,
    source_manifest_identity: sourcePartition.manifest_identity,
    source_manifest_reference: sourcePartition.source_manifest_reference,
    source_files: Object.freeze(sourceFiles),
    source_row_count: sourcePartition.manifest.row_count,
    source_observation_content_hash:
      effectiveSourceHash.observation_content_hash,
    source_observation_content_hash_metadata: effectiveSourceHash,
    source_observation_content_hash_provenance:
      sourcePartition.source_observation_content_hash_provenance,
    source_verification_status_counts: Object.freeze({
      ...effectiveSourceHash.verification_status_counts,
    }),
    target_metadata: target.metadata,
    target_file_intents: Object.freeze(fileIntents),
    target_manifest: manifestPayload,
    target_manifest_object: manifestObject,
    v3_hierarchy: hierarchy,
    logical_identity_verified: true,
    target_file_count: target.metadata.file_count,
    target_row_group_count: rowGroupCount,
  });
}

function dependenciesFromObjects(objects, kind) {
  return objects.map((object) => ({
    kind,
    key: object.key,
    byte_size: object.byte_size,
    sha256: object.sha256,
  }));
}

function buildCanonicalParents({ inventory, units, observationsPrefix, targetWriterGitSha }) {
  const unitsByDayConnector = new Map();
  for (const unit of units) {
    const key = `${unit.scope.day_utc}|${unit.scope.connector_id}`;
    if (!unitsByDayConnector.has(key)) unitsByDayConnector.set(key, []);
    unitsByDayConnector.get(key).push(unit);
  }
  const emptyConnectorScopes = new Set(
    (inventory.empty_source_connectors || []).map((entry) =>
      `${entry.scope.day_utc}|${entry.scope.connector_id}`
    ),
  );
  const connectorObjects = [];
  const sourceConnectors = [...inventory.connector_manifests].sort((left, right) =>
    left.day_utc.localeCompare(right.day_utc) ||
    left.connector_id - right.connector_id
  );
  const sourceConnectorScopes = new Set();
  for (const old of sourceConnectors) {
    const dayUtc = old.day_utc;
    const connectorId = old.connector_id;
    const key = `${dayUtc}|${connectorId}`;
    sourceConnectorScopes.add(key);
    const scopedUnits = unitsByDayConnector.get(key) || [];
    const isEmpty = emptyConnectorScopes.has(key);
    if ((isEmpty && scopedUnits.length) || (!isEmpty && !scopedUnits.length)) {
      throw new Error(`Target connector source coverage is inconsistent: ${key}`);
    }
    const manifestKey = buildHistoryV2ConnectorManifestKey(
      observationsPrefix,
      dayUtc,
      connectorId,
    );
    const payload = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      runId: null,
      manifestKey,
      pollutantManifests: scopedUnits.map((unit) => unit.target_manifest),
      writerGitSha: targetWriterGitSha,
      backedUpAtUtc: old.payload.backed_up_at_utc,
    });
    connectorObjects.push(canonicalJsonObject({
      key: manifestKey,
      payload,
      stage: "connector_manifest",
      dependencies: dependenciesFromObjects(
        scopedUnits.map((unit) => unit.target_manifest_object),
        "pollutant_manifest",
      ),
    }));
  }
  for (const key of unitsByDayConnector.keys()) {
    if (!sourceConnectorScopes.has(key)) {
      throw new Error(`Pre-state connector manifest is missing: ${key}`);
    }
  }
  const connectorsByDay = new Map();
  for (const object of connectorObjects) {
    const dayUtc = object.payload.day_utc;
    if (!connectorsByDay.has(dayUtc)) connectorsByDay.set(dayUtc, []);
    connectorsByDay.get(dayUtc).push(object);
  }
  const dayObjects = [];
  for (const [dayUtc, scopedConnectors] of [...connectorsByDay.entries()].sort()) {
    const old = inventory.day_manifests.find((entry) => entry.day_utc === dayUtc);
    if (!old) throw new Error(`Pre-state day manifest is missing: ${dayUtc}`);
    const manifestKey = buildHistoryV2DayManifestKey(observationsPrefix, dayUtc);
    const payload = buildHistoryV2DayManifest({
      domain: "observations",
      dayUtc,
      runId: null,
      manifestKey,
      connectorManifests: scopedConnectors.map((object) => object.payload),
      writerGitSha: targetWriterGitSha,
      backedUpAtUtc: old.payload.backed_up_at_utc,
    });
    dayObjects.push(canonicalJsonObject({
      key: manifestKey,
      payload,
      stage: "day_manifest",
      dependencies: dependenciesFromObjects(
        scopedConnectors,
        "connector_manifest",
      ),
    }));
  }
  const aggregate = buildObservationsManifestHierarchy({
    observationsPrefix,
    dayManifests: dayObjects.map((object) => object.payload),
  });
  const aggregateObjects = aggregate.objects.map((entry) => {
    let dependencies;
    if (entry.level === "month") {
      dependencies = dependenciesFromObjects(
        dayObjects.filter((object) =>
          object.payload.day_utc.startsWith(
            `${entry.manifest.year}-${entry.manifest.month}`,
          )
        ),
        "day_manifest",
      );
    } else if (entry.level === "year") {
      dependencies = dependenciesFromObjects(
        aggregateObjectsPlaceholder(aggregate.objects, "month", entry.manifest.year),
        "month_manifest",
      );
    } else {
      dependencies = dependenciesFromObjects(
        aggregateObjectsPlaceholder(aggregate.objects, "year"),
        "year_manifest",
      );
    }
    const body = exactBuffer(entry.body, entry.key);
    return Object.freeze({
      kind: `canonical_observation_${entry.level}_manifest`,
      key: entry.key,
      payload: entry.manifest,
      body,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
      content_type: "application/json; charset=utf-8",
      publication_stage: `${entry.level}_manifest`,
      dependencies: Object.freeze(dependencies),
      publication_prerequisites: Object.freeze([]),
    });
  });
  return Object.freeze({
    connector_objects: Object.freeze(connectorObjects),
    day_objects: Object.freeze(dayObjects),
    aggregate_objects: Object.freeze(aggregateObjects),
  });
}

function aggregateObjectsPlaceholder(entries, level, year = null) {
  return entries.filter((entry) =>
    entry.level === level &&
    (year === null || Number(entry.manifest.year) === Number(year))
  ).map((entry) => {
    const body = exactBuffer(entry.body, entry.key);
    return {
      key: entry.key,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
    };
  });
}

function buildCanonicalPublicationSchedule(objects) {
  const sorted = [...objects].sort((left, right) =>
    CANONICAL_STAGE_RANK[left.publication_stage] -
      CANONICAL_STAGE_RANK[right.publication_stage] ||
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
  );
  const position = new Map(sorted.map((object, index) => [object.key, index]));
  for (const object of sorted) {
    for (const dependency of object.dependencies) {
      if (dependency.kind === "canonical_parquet" && !position.has(dependency.key)) {
        continue;
      }
      if (!position.has(dependency.key) || position.get(dependency.key) >= position.get(object.key)) {
        throw new Error(
          `Canonical publication dependency order is invalid: ${dependency.key} -> ${object.key}`,
        );
      }
    }
  }
  return Object.freeze(sorted);
}

function sourceUnitFromPartition({
  sourcePartition,
  rollbackObjectsByKey,
  writerLimits,
  targetWriterGitSha,
}) {
  const sourceFiles = sourcePartition.canonical_files.map((file) => {
    const rollbackObject = rollbackObjectsByKey.get(file.key);
    if (!rollbackObject || rollbackObject.stage !== "canonical_parquet") {
      throw new Error(`Rollback authority lacks canonical Parquet: ${file.key}`);
    }
    return Object.freeze({
      key: file.key,
      byte_size: rollbackObject.byte_size,
      sha256: rollbackObject.sha256,
      manifest_identity_type: classifyManifestFileIdentity(
        file.etag_or_hash,
        { objectKey: file.key },
      ).type,
    });
  });
  return Object.freeze({
    unit_id: sha256Hex(stableMigrationJson({
      source_manifest: sourcePartition.manifest_identity,
      source_files: sourceFiles,
      source_observation_content_hash_metadata:
        sourcePartition.source_observation_content_hash_metadata,
      source_observation_content_hash_provenance:
        sourcePartition.source_observation_content_hash_provenance,
      source_manifest_reference:
        sourcePartition.source_manifest_reference,
      writer_limits: writerLimits,
      target_writer_git_sha: targetWriterGitSha,
      target_schema: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
      target_writer: OBSERVATION_HISTORY_WRITER_VERSION_V3,
      target_layout: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    })),
    scope: sourcePartition.scope,
    source_manifest: sourcePartition.manifest,
    source_manifest_identity: sourcePartition.manifest_identity,
    source_manifest_reference: sourcePartition.source_manifest_reference,
    source_files: Object.freeze(sourceFiles),
    source_row_count: sourcePartition.manifest.row_count,
    source_observation_content_hash:
      sourcePartition.source_observation_content_hash_metadata
        .observation_content_hash,
    source_observation_content_hash_metadata:
      sourcePartition.source_observation_content_hash_metadata,
    source_observation_content_hash_provenance:
      sourcePartition.source_observation_content_hash_provenance,
    source_verification_status_counts: Object.freeze({
      ...sourcePartition.source_observation_content_hash_metadata
        .verification_status_counts,
    }),
    logical_identity_verified: false,
    target_file_count: null,
    target_row_group_count: null,
  });
}

function buildRollbackAuthority({ migrationRunId, environment, inventory, backupGate }) {
  return Object.freeze({
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    kind: "uk_aq_observation_history_v2_rollback_authority",
    migration_run_id: migrationRunId,
    environment,
    inventory,
    backup_gate: backupGate,
  });
}

export async function buildObservationHistoryV3MigrationPlan({
  getR2Object,
  getBackupObject,
  repositoryRoot,
  environmentEvidence,
  migrationRunId,
  writerLimits,
  targetWriterGitSha,
  expectedInventoryRootSha256,
  expectedStateRootSha256,
  observationsPrefix = DEFAULT_OBSERVATIONS_PREFIX,
  v2IndexRoot = DEFAULT_V2_INDEX_ROOT,
  v2LatestKey = DEFAULT_V2_LATEST_KEY,
  v3IndexRoot = DEFAULT_V3_INDEX_ROOT,
  v3LatestKey = DEFAULT_V3_LATEST_KEY,
  sosConnectorId = 1,
}) {
  const environment = validateObservationHistoryV3MigrationEnvironment({
    ...environmentEvidence,
    apply: false,
  });
  const runId = String(migrationRunId || "").trim();
  if (!runId) throw new TypeError("migrationRunId is required for audit evidence");
  if (!writerLimits || typeof writerLimits !== "object") {
    throw new TypeError("Explicit Phase 1 writerLimits are required");
  }
  const writerFreezePlan = deriveObservationHistoryV3WriterFreezePlan({
    repositoryRoot,
  });
  const inventory = await inventoryAuthoritativeCanonicalObservationHistory({
    getR2Object,
    observationsPrefix,
    v2IndexRoot,
    v2LatestKey,
    sosConnectorId,
  });
  let backupGate = null;
  const blockers = [...environment.blockers];
  try {
    backupGate = await verifyObservationHistoryDropboxCheckpoint({
      getR2Object,
      getBackupObject,
      canonicalInventory: inventory,
      expectedInventoryRootSha256,
      expectedStateRootSha256,
    });
  } catch (error) {
    blockers.push(
      `verified_dropbox_checkpoint_missing:${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const rollbackAuthority = backupGate
    ? buildRollbackAuthority({
        migrationRunId: runId,
        environment,
        inventory,
        backupGate,
      })
    : null;
  let rollbackPreflight = null;
  if (rollbackAuthority) {
    try {
      const restorePlan = await buildObservationHistoryV2RestorePlan({
        rollbackAuthority,
        getBackupObject,
      });
      rollbackPreflight = Object.freeze({
        verified: restorePlan.ready === true,
        object_count: restorePlan.objects.length,
        objects: Object.freeze(restorePlan.objects.map((object) => ({
          key: object.key,
          byte_size: object.byte_size,
          sha256: object.sha256,
          stage: object.stage,
        }))),
        v2_index_strategy: restorePlan.v2_index_strategy,
      });
      if (!rollbackPreflight.verified) {
        blockers.push("manifest_guided_rollback_preflight_incomplete");
      }
    } catch (error) {
      blockers.push(
        `manifest_guided_rollback_preflight_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const rollbackObjectsByKey = new Map(
    (rollbackPreflight?.objects || []).map((entry) => [entry.key, entry]),
  );
  const units = rollbackPreflight?.verified
    ? inventory.partitions.map((sourcePartition) => sourceUnitFromPartition({
        sourcePartition,
        rollbackObjectsByKey,
        writerLimits,
        targetWriterGitSha,
      }))
    : [];
  const sourceObservationContentHashProvenanceCounts = Object.freeze({
    manifest: inventory.partitions.filter((partition) =>
      partition.source_observation_content_hash_provenance ===
        SOURCE_HASH_PROVENANCE_MANIFEST
    ).length,
    derived_from_legacy_canonical_parquet: inventory.partitions.filter(
      (partition) =>
        partition.source_observation_content_hash_provenance ===
          SOURCE_HASH_PROVENANCE_LEGACY_PARQUET,
    ).length,
  });
  const sourceManifestReferenceProvenanceCounts = Object.freeze({
    exact: inventory.partitions.filter((partition) =>
      partition.source_manifest_reference.provenance ===
        SOURCE_MANIFEST_REFERENCE_PROVENANCE_EXACT
    ).length,
    legacy_stale_parent_manifest_hash:
      inventory.partitions.filter((partition) =>
        partition.source_manifest_reference.provenance ===
          SOURCE_MANIFEST_REFERENCE_PROVENANCE_LEGACY_STALE_PARENT
      ).length,
    unexplained: 0,
  });
  const emptySourceConnectors = inventory.empty_source_connectors;
  const planIdentityPayload = {
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    environment: environment.environment,
    bucket: environment.bucket,
    source_root: inventory.root_manifest.payload.content_hash,
    backup_inventory: backupGate?.inventory_root.sha256 || null,
    backup_checkpoint: backupGate?.state_root.sha256 || null,
    writer_limits: writerLimits,
    target_writer_git_sha: targetWriterGitSha,
    unit_ids: units.map((unit) => unit.unit_id),
    source_files: units.flatMap((unit) => unit.source_files),
    source_observation_content_hash_provenance_counts:
      sourceObservationContentHashProvenanceCounts,
    source_manifest_reference_provenance_counts:
      sourceManifestReferenceProvenanceCounts,
    empty_source_connectors: emptySourceConnectors,
    observations_prefix: inventory.observations_prefix,
    v3_index_root: v3IndexRoot,
    v3_latest_key: v3LatestKey,
    rollback_objects: rollbackPreflight?.objects || null,
  };
  const uniqueBlockers = [...new Set(blockers)].sort();
  return Object.freeze({
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    kind: "uk_aq_observation_history_v3_migration_plan",
    mode: "plan",
    migration_run_id: runId,
    plan_sha256: sha256Hex(stableMigrationJson(planIdentityPayload)),
    environment,
    target: Object.freeze({
      history_version: "v2",
      history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
      writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
      physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
      index_generation: "v3",
      writer_limits: Object.freeze({ ...writerLimits }),
    }),
    target_writer_git_sha: String(targetWriterGitSha || "").trim(),
    writer_freeze_plan: writerFreezePlan,
    inventory,
    backup_gate: backupGate,
    rollback_authority: rollbackAuthority,
    rollback_preflight: rollbackPreflight,
    units: Object.freeze(units),
    source_observation_content_hash_provenance_counts:
      sourceObservationContentHashProvenanceCounts,
    source_manifest_reference_provenance_counts:
      sourceManifestReferenceProvenanceCounts,
    empty_source_connector_count: emptySourceConnectors.length,
    empty_source_connectors: emptySourceConnectors,
    canonical_publication_objects: Object.freeze([]),
    v3_latest: null,
    v3_publication_plan: null,
    v3_index_root: normalizePrefix(v3IndexRoot, "v3 index root"),
    v3_latest_key: String(v3LatestKey),
    sos_connector_id: Number(sosConnectorId),
    blockers: Object.freeze(uniqueBlockers),
    mutation_allowed: uniqueBlockers.length === 0,
    estimated: Object.freeze({
      partitions: units.length,
      source_files: units.reduce((sum, unit) => sum + unit.source_files.length, 0),
      source_bytes: units.reduce(
        (sum, unit) => sum + unit.source_files.reduce((subtotal, file) => subtotal + file.byte_size, 0),
        0,
      ),
      new_parquet_objects: null,
      new_row_groups: null,
      v3_scopes: units.length,
      v3_child_shards: null,
      v3_scoped_roots: units.length,
      v3_latest_objects: 1,
      empty_source_connectors: emptySourceConnectors.length,
    }),
  });
}

function checkpointObjectMap(checkpoint) {
  return new Map(
    Object.entries(checkpoint?.completed_objects || {}).map(([key, value]) => [key, value]),
  );
}

function preparedUnitPlanIdentity(record) {
  return sha256Hex(stableMigrationJson({
    unit_id: record.unit_id,
    scope: record.scope,
    target_metadata: record.target_metadata,
    target_manifest: record.target_manifest,
    target_file_intents: (record.target_file_intents || []).map(
      ({ key, byte_size, sha256 }) => ({ key, byte_size, sha256 }),
    ),
    v3_index_root: record.v3_index_root,
  }));
}

function preparedUnitFromRecord(authorityUnit, record) {
  if (
    !record ||
    record.unit_id !== authorityUnit.unit_id ||
    !record.target_metadata ||
    !record.target_manifest ||
    !Array.isArray(record.target_file_intents) ||
    record.prepared_plan_sha256 !== preparedUnitPlanIdentity(record)
  ) {
    throw new Error(`Prepared unit checkpoint is invalid: ${authorityUnit.unit_id}`);
  }
  if (
    record.target_metadata.row_count !== authorityUnit.source_row_count ||
    stableMigrationJson(contentHashMetadata(record.target_metadata)) !==
      stableMigrationJson(authorityUnit.source_observation_content_hash_metadata)
  ) {
    throw new Error(`Prepared unit logical identity changed: ${authorityUnit.unit_id}`);
  }
  const targetManifestObject = canonicalJsonObject({
    key: authorityUnit.source_manifest_identity.key,
    payload: record.target_manifest,
    stage: "pollutant_manifest",
    dependencies: record.target_file_intents.map((intent) => ({
      kind: "canonical_parquet",
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
    })),
  });
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: record.target_metadata,
    canonicalManifest: canonicalManifestDescriptor(
      targetManifestObject,
      record.target_manifest,
    ),
    indexRoot: record.v3_index_root,
  });
  return Object.freeze({
    ...authorityUnit,
    target_metadata: record.target_metadata,
    target_file_intents: Object.freeze(
      record.target_file_intents.map((entry) => Object.freeze({ ...entry })),
    ),
    target_manifest: record.target_manifest,
    target_manifest_object: targetManifestObject,
    v3_hierarchy: hierarchy,
    logical_identity_verified: true,
    target_file_count: record.target_metadata.file_count,
    target_row_group_count: record.target_metadata.files.reduce(
      (sum, file) => sum + file.row_group_count,
      0,
    ),
  });
}

export function buildObservationHistoryV3MigrationPlanFromCheckpoint({
  checkpoint,
  requirePrepared = false,
}) {
  const authority = checkpoint?.authority;
  if (
    checkpoint?.kind !== "uk_aq_observation_history_v3_migration_checkpoint" ||
    !authority ||
    checkpoint.plan_sha256 !== authority.plan_sha256 ||
    checkpoint.migration_run_id !== authority.migration_run_id ||
    checkpoint.authority_sha256 !== sha256Hex(stableMigrationJson(authority))
  ) {
    throw new Error("Migration checkpoint immutable authority is missing or invalid");
  }
  if (!requirePrepared) return Object.freeze(structuredClone(authority));
  const prepared = checkpoint.prepared_units || {};
  const units = authority.units.map((unit) =>
    preparedUnitFromRecord(unit, prepared[unit.unit_id])
  );
  const parents = buildCanonicalParents({
    inventory: authority.inventory,
    units,
    observationsPrefix: authority.inventory.observations_prefix,
    targetWriterGitSha: authority.target_writer_git_sha,
  });
  const canonicalObjects = buildCanonicalPublicationSchedule([
    ...units.map((unit) => unit.target_manifest_object),
    ...parents.connector_objects,
    ...parents.day_objects,
    ...parents.aggregate_objects,
  ]);
  const latest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: units.map((unit) => unit.v3_hierarchy),
    indexRoot: authority.v3_index_root,
    latestKey: authority.v3_latest_key,
  });
  const v3Objects = [
    ...units.flatMap((unit) => unit.v3_hierarchy.child_shards),
    ...units.map((unit) => unit.v3_hierarchy.scoped_manifest),
    latest,
  ];
  const externalReferences = [
    ...units.flatMap((unit) => unit.target_file_intents.map((intent) => ({
      kind: "canonical_parquet",
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
      verified: true,
      durable: true,
    }))),
    ...units.map((unit) => ({
      kind: "canonical_manifest",
      key: unit.target_manifest_object.key,
      byte_size: unit.target_manifest_object.byte_size,
      sha256: unit.target_manifest_object.sha256,
      verified: true,
      durable: true,
    })),
  ];
  const v3PublicationPlan = buildObservationHistoryIndexV3PublicationPlan({
    objects: v3Objects,
    externalReferences,
  });
  return Object.freeze({
    ...authority,
    units: Object.freeze(units),
    canonical_publication_objects: canonicalObjects,
    v3_latest: latest,
    v3_publication_plan: v3PublicationPlan,
    estimated: Object.freeze({
      ...authority.estimated,
      new_parquet_objects: units.reduce(
        (sum, unit) => sum + unit.target_file_intents.length,
        0,
      ),
      new_row_groups: units.reduce(
        (sum, unit) => sum + unit.target_row_group_count,
        0,
      ),
      v3_child_shards: units.reduce(
        (sum, unit) => sum + unit.v3_hierarchy.child_shards.length,
        0,
      ),
    }),
  });
}

export async function verifyObservationHistoryV3CheckpointReuse({
  checkpointEntry,
  expected,
  headObject,
  getObject,
  requireStoredSha256 = false,
}) {
  if (
    !checkpointEntry ||
    checkpointEntry.verified !== true ||
    checkpointEntry.durable !== true ||
    checkpointEntry.byte_size !== expected.byte_size ||
    checkpointEntry.sha256 !== expected.sha256
  ) {
    return Object.freeze({ reusable: false, reason: "checkpoint_identity_mismatch" });
  }
  if (requireStoredSha256) {
    const head = await headObject({ key: expected.key });
    try {
      verifyR2StoredSha256Head({ head, intent: expected });
      return Object.freeze({ reusable: true, reason: "current_head_identity_verified" });
    } catch (error) {
      return Object.freeze({
        reusable: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const current = await getObject({ key: expected.key });
  if (!current || current.exists === false || current.body === null || current.body === undefined) {
    return Object.freeze({ reusable: false, reason: "current_object_missing" });
  }
  const identity = bodyIdentity(expected.key, current.body);
  return Object.freeze({
    reusable: identity.byte_size === expected.byte_size && identity.sha256 === expected.sha256,
    reason: identity.byte_size === expected.byte_size && identity.sha256 === expected.sha256
      ? "current_object_identity_verified"
      : "current_object_identity_mismatch",
  });
}

function emptyCheckpoint(plan) {
  const authority = structuredClone(plan);
  return {
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    kind: "uk_aq_observation_history_v3_migration_checkpoint",
    migration_run_id: plan.migration_run_id,
    plan_sha256: plan.plan_sha256,
    authority,
    authority_sha256: sha256Hex(stableMigrationJson(authority)),
    pre_state: {
      canonical_root_key: plan.inventory.root_manifest.key,
      canonical_root_content_hash: plan.inventory.root_manifest.payload.content_hash,
      canonical_root_sha256: plan.inventory.root_manifest.sha256,
    },
    backup_gate: plan.backup_gate
      ? {
          verified: plan.backup_gate.verified === true,
          inventory_root: {
            key: plan.backup_gate.inventory_root.key,
            byte_size: plan.backup_gate.inventory_root.byte_size,
            sha256: plan.backup_gate.inventory_root.sha256,
          },
          state_root: {
            key: plan.backup_gate.state_root.key,
            byte_size: plan.backup_gate.state_root.byte_size,
            sha256: plan.backup_gate.state_root.sha256,
          },
        }
      : null,
    rollback_preflight: plan.rollback_preflight
      ? {
          verified: plan.rollback_preflight.verified === true,
          object_count: plan.rollback_preflight.object_count,
          objects: plan.rollback_preflight.objects,
          v2_index_strategy: plan.rollback_preflight.v2_index_strategy,
        }
      : null,
    completed_objects: {},
    prepared_units: {},
    preparation_order: [],
    full_verification_complete: false,
    cutover_ready: false,
  };
}

async function persistCompletedObject({ checkpoint, evidence, writeCheckpoint }) {
  checkpoint.completed_objects[evidence.key] = {
    byte_size: evidence.byte_size,
    sha256: evidence.sha256,
    verified: true,
    durable: true,
    stored_sha256_verified: evidence.stored_sha256_verified === true,
  };
  await writeCheckpoint(checkpoint);
}

export async function executeObservationHistoryV3MigrationPlan({
  plan,
  apply = false,
  writersFrozen = false,
  environmentEvidence,
  checkpoint: rawCheckpoint = null,
  adapters,
}) {
  if (!apply) {
    return Object.freeze({
      ok: plan.blockers.length === 0,
      status: plan.blockers.length ? "blocked" : "planned",
      dry_run: true,
      mutation_calls: 0,
      blockers: plan.blockers,
    });
  }
  const currentEnvironment = validateObservationHistoryV3MigrationEnvironment({
    ...environmentEvidence,
    apply: true,
  });
  if (
    plan.environment.environment !== currentEnvironment.environment ||
    plan.environment.bucket !== currentEnvironment.bucket
  ) {
    throw new Error("Migration checkpoint environment/bucket authority mismatch");
  }
  if (writersFrozen !== true) {
    throw new Error("Migration apply requires explicit confirmation that all planned writers are frozen");
  }
  if (!plan.backup_gate?.verified || plan.blockers.length || plan.mutation_allowed !== true) {
    throw new Error("Migration apply is blocked by incomplete plan or backup evidence");
  }
  for (const name of [
    "putChecksumObject",
    "putJsonObject",
    "headObject",
    "getObject",
    "putIfChanged",
    "recordDurableEvidence",
    "writeCheckpoint",
    "finalizeV3Publication",
    "stageUnit",
    "readStagedBody",
    "releaseStagedUnit",
  ]) {
    if (typeof adapters?.[name] !== "function") {
      throw new TypeError(`Migration apply adapter is missing: ${name}`);
    }
  }
  const checkpoint = rawCheckpoint ? structuredClone(rawCheckpoint) : emptyCheckpoint(plan);
  if (
    checkpoint.plan_sha256 !== plan.plan_sha256 ||
    checkpoint.migration_run_id !== plan.migration_run_id
  ) {
    throw new Error("Migration checkpoint belongs to a different deterministic plan");
  }
  if (rawCheckpoint) {
    buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint });
  } else {
    await adapters.writeCheckpoint(checkpoint);
    await reverifyPinnedEmptySourceConnectorsBeforeMutation({
      plan,
      getR2Object: adapters.getObject,
    });
    await reverifyPinnedCompatibleSourceUnitsBeforeMutation({
      plan,
      getR2Object: adapters.getObject,
    });
  }
  const parquetEvidence = [];
  for (const authorityUnit of plan.units) {
    let record = checkpoint.prepared_units[authorityUnit.unit_id] || null;
    if (!record) {
      const sourcePartition = plan.inventory.partitions.find((partition) =>
        partition.manifest_identity.key === authorityUnit.source_manifest_identity.key &&
        partition.manifest_identity.sha256 === authorityUnit.source_manifest_identity.sha256
      );
      if (!sourcePartition) {
        throw new Error(`Pinned source partition is unavailable: ${authorityUnit.unit_id}`);
      }
      const rewritten = await rewritePartition({
        sourcePartition,
        getR2Object: adapters.getObject,
        writerLimits: plan.target.writer_limits,
        observationsPrefix: plan.inventory.observations_prefix,
        targetWriterGitSha: plan.target_writer_git_sha,
        sosConnectorId: plan.sos_connector_id,
        v3IndexRoot: plan.v3_index_root,
      });
      if (rewritten.unit_id !== authorityUnit.unit_id) {
        throw new Error(`Pinned source unit identity changed: ${authorityUnit.unit_id}`);
      }
      if (!sameJson(rewritten.source_files, authorityUnit.source_files)) {
        throw new Error(`Pinned source file identity changed: ${authorityUnit.unit_id}`);
      }
      const staged = await adapters.stageUnit({
        unitId: authorityUnit.unit_id,
        intents: rewritten.target_file_intents,
      });
      if (!Array.isArray(staged) || staged.length !== rewritten.target_file_intents.length) {
        throw new Error(`Prepared unit staging is incomplete: ${authorityUnit.unit_id}`);
      }
      for (let index = 0; index < staged.length; index += 1) {
        const expected = rewritten.target_file_intents[index];
        const actual = staged[index];
        if (
          actual.key !== expected.key ||
          actual.byte_size !== expected.byte_size ||
          actual.sha256 !== expected.sha256 ||
          !actual.staging_ref
        ) {
          throw new Error(`Prepared unit staging identity mismatch: ${expected.key}`);
        }
      }
      record = {
        unit_id: authorityUnit.unit_id,
        scope: authorityUnit.scope,
        target_metadata: rewritten.target_metadata,
        target_manifest: rewritten.target_manifest,
        target_file_intents: staged.map((entry) => ({ ...entry })),
        v3_index_root: plan.v3_index_root,
        files_published: false,
      };
      record.prepared_plan_sha256 = preparedUnitPlanIdentity(record);
      checkpoint.prepared_units[authorityUnit.unit_id] = record;
      checkpoint.preparation_order.push(authorityUnit.unit_id);
      await adapters.writeCheckpoint(checkpoint);
    }
    const preparedUnit = preparedUnitFromRecord(authorityUnit, record);
    for (const intent of preparedUnit.target_file_intents) {
      const completed = checkpointObjectMap(checkpoint);
      const reuse = await verifyObservationHistoryV3CheckpointReuse({
        checkpointEntry: completed.get(intent.key),
        expected: intent,
        headObject: adapters.headObject,
        getObject: adapters.getObject,
        requireStoredSha256: true,
      });
      let evidence;
      if (reuse.reusable) {
        evidence = {
          key: intent.key,
          byte_size: intent.byte_size,
          sha256: intent.sha256,
          stored_sha256_verified: true,
          reused: true,
        };
      } else {
        const body = await adapters.readStagedBody(intent);
        const publicationIntent = buildR2ChecksumAwarePutIntent({
          key: intent.key,
          body,
        });
        if (
          publicationIntent.byte_size !== intent.byte_size ||
          publicationIntent.sha256 !== intent.sha256
        ) {
          throw new Error(`Prepared Parquet staging identity changed: ${intent.key}`);
        }
        const putEvidence = await adapters.putChecksumObject(publicationIntent);
        const head = await adapters.headObject({ key: intent.key });
        evidence = {
          ...verifyR2StoredSha256Head({ head, intent: publicationIntent }),
          put_status: String(putEvidence?.status || "succeeded"),
          reused: false,
        };
      }
      parquetEvidence.push(evidence);
      await persistCompletedObject({
        checkpoint,
        evidence: { ...evidence, stored_sha256_verified: true },
        writeCheckpoint: adapters.writeCheckpoint,
      });
    }
    record.files_published = true;
    await adapters.writeCheckpoint(checkpoint);
    await adapters.releaseStagedUnit({
      unitId: authorityUnit.unit_id,
      intents: record.target_file_intents,
    });
    record.target_file_intents = record.target_file_intents.map(
      ({ staging_ref: _stagingRef, ...entry }) => entry,
    );
    await adapters.writeCheckpoint(checkpoint);
  }
  const completedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint,
    requirePrepared: true,
  });
  for (const object of completedPlan.canonical_publication_objects) {
    const completed = checkpointObjectMap(checkpoint);
    const reuse = await verifyObservationHistoryV3CheckpointReuse({
      checkpointEntry: completed.get(object.key),
      expected: object,
      headObject: adapters.headObject,
      getObject: adapters.getObject,
    });
    if (!reuse.reusable) {
      await adapters.putJsonObject(object);
      const current = await adapters.getObject({ key: object.key });
      const currentIdentity = bodyIdentity(object.key, current.body);
      if (
        currentIdentity.byte_size !== object.byte_size ||
        currentIdentity.sha256 !== object.sha256
      ) {
        throw new Error(`Canonical manifest post-PUT verification failed: ${object.key}`);
      }
    }
    await persistCompletedObject({
      checkpoint,
      evidence: object,
      writeCheckpoint: adapters.writeCheckpoint,
    });
  }
  const v3Publication = await adapters.finalizeV3Publication({
    plan: completedPlan.v3_publication_plan,
    putIfChanged: adapters.putIfChanged,
    getObject: adapters.getObject,
    recordDurableEvidence: adapters.recordDurableEvidence,
  });
  for (const evidence of v3Publication.objects || []) {
    await persistCompletedObject({
      checkpoint,
      evidence,
      writeCheckpoint: adapters.writeCheckpoint,
    });
  }
  const verification = await verifyObservationHistoryV3MigrationResult({
    plan: completedPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: v3Publication,
  });
  checkpoint.full_verification_complete = verification.ok;
  checkpoint.cutover_ready = verification.cutover_ready;
  await adapters.writeCheckpoint(checkpoint);
  return Object.freeze({
    ok: verification.ok,
    status: verification.cutover_ready ? "cutover_ready" : "blocked",
    dry_run: false,
    parquet_evidence: Object.freeze(parquetEvidence),
    v3_publication: v3Publication,
    verification,
    checkpoint: Object.freeze(checkpoint),
  });
}

export async function verifyObservationHistoryV3MigrationResult({
  plan,
  getObject,
  headObject,
  publicationResult = null,
}) {
  const blockers = [];
  for (const unit of plan.units) {
    if (
      unit.source_row_count !== unit.target_metadata.row_count ||
      !sameJson(
        unit.source_observation_content_hash_metadata,
        contentHashMetadata(unit.target_metadata),
      )
    ) {
      blockers.push(`logical_identity_mismatch:${partitionIdentity(unit.scope)}`);
    }
    for (const intent of unit.target_file_intents) {
      try {
        const head = await headObject({ key: intent.key });
        verifyR2StoredSha256Head({ head, intent });
      } catch (error) {
        blockers.push(
          `parquet_stored_sha_mismatch:${intent.key}:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  for (const expected of plan.canonical_publication_objects) {
    try {
      const current = await getRequiredObject(
        getObject,
        expected.key,
        "published canonical manifest",
      );
      if (
        current.byte_size !== expected.byte_size ||
        current.sha256 !== expected.sha256
      ) {
        throw new Error("published canonical manifest identity differs from plan");
      }
    } catch (error) {
      blockers.push(
        `canonical_manifest_identity_mismatch:${expected.key}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const actualArtifacts = new Map();
  for (const entry of plan.v3_publication_plan.entries) {
    try {
      const current = await getRequiredObject(getObject, entry.key, "published v3");
      if (current.byte_size !== entry.byte_size || current.sha256 !== entry.sha256) {
        throw new Error("published identity differs from plan");
      }
      actualArtifacts.set(entry.key, current.body);
    } catch (error) {
      blockers.push(
        `v3_publication_identity_mismatch:${entry.key}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (const unit of plan.units) {
    try {
      const children = unit.v3_hierarchy.child_shards.map((artifact) => {
        const body = actualArtifacts.get(artifact.key);
        if (!body) throw new Error(`missing child ${artifact.key}`);
        const actual = {
          ...artifact,
          body: body.toString("utf8"),
          byte_size: body.byteLength,
          sha256: sha256Hex(body),
          payload: parseJsonBody(artifact.key, body),
        };
        validateObservationHistoryIndexV3ChildShardArtifact({ artifact: actual });
        return actual;
      });
      const rootArtifact = unit.v3_hierarchy.scoped_manifest;
      const rootBody = actualArtifacts.get(rootArtifact.key);
      if (!rootBody) throw new Error(`missing scoped root ${rootArtifact.key}`);
      const actualRoot = {
        ...rootArtifact,
        body: rootBody.toString("utf8"),
        byte_size: rootBody.byteLength,
        sha256: sha256Hex(rootBody),
        payload: parseJsonBody(rootArtifact.key, rootBody),
      };
      validateObservationHistoryIndexV3ScopedManifestArtifact({
        artifact: actualRoot,
        childShards: children,
      });
    } catch (error) {
      blockers.push(
        `scoped_root_child_authority_mismatch:${partitionIdentity(unit.scope)}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  try {
    const latestBody = actualArtifacts.get(plan.v3_latest.key);
    if (!latestBody) throw new Error("v3 latest object is missing");
    const actualHierarchies = plan.units.map((unit) => ({
      child_shards: unit.v3_hierarchy.child_shards,
      scoped_manifest: {
        ...unit.v3_hierarchy.scoped_manifest,
        body: actualArtifacts.get(unit.v3_hierarchy.scoped_manifest.key)
          ?.toString("utf8"),
      },
    }));
    validateObservationHistoryIndexV3LatestArtifact({
      artifact: {
        ...plan.v3_latest,
        body: latestBody.toString("utf8"),
        byte_size: latestBody.byteLength,
        sha256: sha256Hex(latestBody),
        payload: parseJsonBody(plan.v3_latest.key, latestBody),
      },
      scopedHierarchies: actualHierarchies,
    });
  } catch (error) {
    blockers.push(
      `v3_latest_verification_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!publicationResult || publicationResult.ok !== true) {
    blockers.push("v3_durable_publication_evidence_incomplete");
  }
  if (!plan.backup_gate?.verified) blockers.push("verified_dropbox_checkpoint_missing");
  if (!plan.rollback_preflight?.verified) {
    blockers.push("manifest_guided_rollback_preflight_incomplete");
  }
  if (!plan.writer_freeze_plan?.entries?.length) blockers.push("writer_freeze_plan_missing");
  const uniqueBlockers = [...new Set(blockers)].sort();
  return Object.freeze({
    ok: uniqueBlockers.length === 0,
    cutover_ready: uniqueBlockers.length === 0,
    blockers: Object.freeze(uniqueBlockers),
    partition_count: plan.units.length,
    v3_child_count: plan.units.reduce(
      (sum, unit) => sum + unit.v3_hierarchy.child_shards.length,
      0,
    ),
    v3_scoped_root_count: plan.units.length,
    v3_latest_count: 1,
    r2_stored_sha_verification: uniqueBlockers.some((entry) =>
      entry.startsWith("parquet_stored_sha_mismatch:"))
      ? "failed"
      : "verified",
    scoped_root_child_verification: uniqueBlockers.some((entry) =>
      entry.startsWith("scoped_root_child_authority_mismatch:"))
      ? "failed"
      : "verified",
  });
}

export function buildObservationHistoryV3RerunVerificationPlan({
  currentPlan = null,
  checkpoint,
}) {
  const pinnedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint,
    requirePrepared: true,
  });
  if (
    checkpoint?.migration_run_id !== pinnedPlan.migration_run_id ||
    checkpoint?.backup_gate?.verified !== true ||
    checkpoint?.rollback_preflight?.verified !== true ||
    checkpoint?.full_verification_complete !== true
  ) {
    throw new Error(
      "Rerun verification requires a matching completed checkpoint with verified pre-state backup evidence",
    );
  }
  if (
    currentPlan &&
    currentPlan.plan_sha256 !== pinnedPlan.plan_sha256
  ) {
    throw new Error("Current plan does not match the pinned migration authority");
  }
  for (const entry of pinnedPlan.v3_publication_plan.entries) {
    const completed = checkpoint.completed_objects?.[entry.key];
    if (
      completed?.verified !== true ||
      completed?.durable !== true ||
      completed.byte_size !== entry.byte_size ||
      completed.sha256 !== entry.sha256
    ) {
      throw new Error(
        `Checkpoint lacks exact durable v3 publication evidence: ${entry.key}`,
      );
    }
  }
  return Object.freeze({
    ...pinnedPlan,
    blockers: Object.freeze([]),
  });
}

function restoreStageForKey(key) {
  if (key.endsWith(".parquet")) return "canonical_parquet";
  if (/\/pollutant_code=[^/]+\/manifest\.json$/.test(key)) return "pollutant_manifest";
  if (/\/connector_id=\d+\/manifest\.json$/.test(key)) return "connector_manifest";
  if (/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key)) return "day_manifest";
  if (/\/_manifests\/year=\d{4}\/month=\d{2}\/manifest\.json$/.test(key)) return "month_manifest";
  if (/\/_manifests\/year=\d{4}\/manifest\.json$/.test(key)) return "year_manifest";
  if (/\/_manifests\/manifest\.json$/.test(key)) return "root_manifest";
  throw new Error(`Unsupported canonical restore object key: ${key}`);
}

async function addBackupObjectToRestore({ getBackupObject, objects, key, expected = null }) {
  const object = await getRequiredObject(getBackupObject, key, "Dropbox backup");
  if (expected?.byte_size !== undefined && object.byte_size !== expected.byte_size) {
    throw new Error(`Dropbox restore object byte-size mismatch: ${key}`);
  }
  if (expected?.sha256 && object.sha256 !== expected.sha256) {
    throw new Error(`Dropbox restore object SHA-256 mismatch: ${key}`);
  }
  const descriptor = Object.freeze({
    key,
    byte_size: object.byte_size,
    sha256: object.sha256,
    content_type: key.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "application/octet-stream",
    stage: restoreStageForKey(key),
  });
  const existing = objects.get(key);
  if (existing && !sameJson(existing, descriptor)) {
    throw new Error(`Dropbox restore object identity is inconsistent: ${key}`);
  }
  objects.set(key, descriptor);
  return Object.freeze({ ...descriptor, body: object.body });
}

export async function buildObservationHistoryV2RestorePlan({
  migrationPlan = null,
  rollbackAuthority = null,
  checkpoint = null,
  getBackupObject,
}) {
  const checkpointPlan = checkpoint
    ? buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint })
    : null;
  const authority = rollbackAuthority ||
    checkpointPlan?.rollback_authority ||
    migrationPlan?.rollback_authority ||
    (migrationPlan
      ? {
          migration_run_id: migrationPlan.migration_run_id,
          environment: migrationPlan.environment,
          inventory: migrationPlan.inventory,
          backup_gate: migrationPlan.backup_gate,
        }
      : null);
  const backupGate = authority?.backup_gate;
  if (!backupGate?.verified) {
    throw new Error("Rollback planning requires the verified pre-migration Dropbox checkpoint");
  }
  if (!authority?.inventory) {
    throw new Error("Rollback planning requires immutable pre-migration inventory authority");
  }
  const objects = new Map();
  const preStateIdentityByKey = new Map([
    ...authority.inventory.hierarchy_objects.map((entry) => [entry.key, entry]),
    ...authority.inventory.day_manifests.map((entry) => [entry.key, entry]),
    ...authority.inventory.connector_manifests.map((entry) => [entry.key, entry]),
    ...authority.inventory.partitions.map((entry) => [
      entry.manifest_identity.key,
      entry.manifest_identity,
    ]),
  ]);
  const sourcePartitionByManifestKey = new Map(
    authority.inventory.partitions.map((partition) => [
      partition.manifest_identity.key,
      partition,
    ]),
  );
  const requirePreStateIdentity = (key) => {
    const identity = preStateIdentityByKey.get(key);
    if (!identity?.sha256 || !Number.isSafeInteger(Number(identity.byte_size))) {
      throw new Error(`Rollback pre-state strong identity is missing: ${key}`);
    }
    return identity;
  };
  for (const aggregate of authority.inventory.hierarchy_objects) {
    await addBackupObjectToRestore({
      getBackupObject,
      objects,
      key: aggregate.key,
      expected: aggregate,
    });
  }
  for (const shard of backupGate.month_inventory_shards) {
    for (const dayEntry of shard.payload.days) {
      const dayIntent = await addBackupObjectToRestore({
        getBackupObject,
        objects,
        key: dayEntry.manifest_key,
        expected: requirePreStateIdentity(dayEntry.manifest_key),
      });
      if (
        dayIntent.sha256 !== dayEntry.manifest_file_hash ||
        (
          dayEntry.manifest_size !== null &&
          dayIntent.byte_size !== dayEntry.manifest_size
        )
      ) {
        throw new Error(`Dropbox day inventory physical identity mismatch: ${dayIntent.key}`);
      }
      const day = parseJsonBody(dayIntent.key, dayIntent.body);
      validateCanonicalHistoryV2Manifest(day, {
        domain: "observations",
        manifest_kind: "day",
        day_utc: dayEntry.day_utc,
        manifest_key: dayEntry.manifest_key,
      });
      if (day.manifest_hash !== dayEntry.manifest_hash) {
        throw new Error(`Dropbox day logical manifest identity mismatch: ${dayIntent.key}`);
      }
      for (const connectorReference of day.connector_manifests || []) {
        const connectorIntent = await addBackupObjectToRestore({
          getBackupObject,
          objects,
          key: connectorReference.manifest_key,
          expected: requirePreStateIdentity(connectorReference.manifest_key),
        });
        const connector = parseJsonBody(connectorIntent.key, connectorIntent.body);
        validateCanonicalHistoryV2Manifest(connector, {
          domain: "observations",
          manifest_kind: "connector",
          day_utc: dayEntry.day_utc,
          connector_id: connectorReference.connector_id,
          manifest_key: connectorReference.manifest_key,
        });
        if (connector.manifest_hash !== connectorReference.manifest_hash) {
          throw new Error(`Dropbox connector logical manifest identity mismatch: ${connectorIntent.key}`);
        }
        for (const pollutantReference of connector.pollutant_manifests || []) {
          const pollutantIntent = await addBackupObjectToRestore({
            getBackupObject,
            objects,
            key: pollutantReference.manifest_key,
            expected: requirePreStateIdentity(pollutantReference.manifest_key),
          });
          const pollutant = parseJsonBody(pollutantIntent.key, pollutantIntent.body);
          validateCanonicalHistoryV2Manifest(pollutant, {
            domain: "observations",
            manifest_kind: "pollutant",
            day_utc: dayEntry.day_utc,
            connector_id: connectorReference.connector_id,
            pollutant_code: pollutantReference.pollutant_code,
            manifest_key: pollutantReference.manifest_key,
          });
          if (!isGenuineLegacyHashlessObservationManifest(pollutant)) {
            validateObservationContentHashMetadata(pollutant, {
              rowCount: pollutant.row_count,
            });
          }
          const sourcePartition = sourcePartitionByManifestKey.get(
            pollutantIntent.key,
          );
          if (!sourcePartition) {
            throw new Error(
              `Rollback source partition authority is missing: ${pollutantIntent.key}`,
            );
          }
          const restoredReferenceEvidence =
            buildSourceManifestReferenceEvidence({
              connectorManifest: connector,
              connectorManifestIdentity: bodyIdentity(
                connectorIntent.key,
                connectorIntent.body,
              ),
              pollutantReference,
              pollutantManifest: pollutant,
              pollutantManifestIdentity: bodyIdentity(
                pollutantIntent.key,
                pollutantIntent.body,
              ),
              pollutantKey: pollutantIntent.key,
            });
          if (
            !sameJson(
              restoredReferenceEvidence,
              sourcePartition.source_manifest_reference,
            )
          ) {
            throw new Error(
              `Dropbox source manifest reference evidence changed: ${pollutantIntent.key}`,
            );
          }
          for (const file of pollutant.files || []) {
            const manifestIdentity = classifyManifestFileIdentity(
              file.etag_or_hash,
              { objectKey: file.key },
            );
            const fileIntent = await addBackupObjectToRestore({
              getBackupObject,
              objects,
              key: file.key,
              expected: {
                byte_size: file.bytes,
              },
            });
            if (manifestIdentity.type === "sha256") {
              verifyManifestFileIdentity({
                manifestIdentity: file.etag_or_hash,
                expectedBytes: file.bytes,
                liveObject: {
                  bytes: fileIntent.byte_size,
                  body: fileIntent.body,
                },
                objectKey: file.key,
              });
            }
          }
        }
      }
    }
  }
  const stageRank = {
    canonical_parquet: 10,
    pollutant_manifest: 20,
    connector_manifest: 30,
    day_manifest: 40,
    month_manifest: 50,
    year_manifest: 60,
    root_manifest: 70,
  };
  const ordered = [...objects.values()].sort((left, right) =>
    stageRank[left.stage] - stageRank[right.stage] ||
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
  );
  if (checkpointPlan) {
    const pinnedObjects = checkpointPlan.rollback_preflight?.objects || [];
    const identities = ordered.map(({ key, byte_size, sha256, stage }) => ({
      key,
      byte_size,
      sha256,
      stage,
    }));
    if (!sameJson(identities, pinnedObjects)) {
      throw new Error(
        "Dropbox rollback objects differ from the immutable checkpoint authority",
      );
    }
  }
  return Object.freeze({
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    kind: "uk_aq_observation_history_v2_restore_plan",
    migration_run_id: authority.migration_run_id,
    environment: authority.environment,
    backup_checkpoint: Object.freeze({
      inventory_root: backupGate.inventory_root,
      state_root: backupGate.state_root,
    }),
    objects: Object.freeze(ordered),
    v2_index_strategy: Object.freeze({
      mode: "rebuild",
      retained_index_assumed_valid: false,
      command:
        "node scripts/backup_r2/uk_aq_build_r2_history_index.mjs " +
        "--history-version v2 --domain observations --write-r2",
    }),
    ready: ordered.length > 0,
  });
}

export async function executeObservationHistoryV2Rollback({
  restorePlan,
  apply = false,
  writersFrozen = false,
  environmentEvidence,
  adapters,
}) {
  if (!apply) {
    return Object.freeze({
      ok: restorePlan.ready,
      status: restorePlan.ready ? "rollback_planned" : "blocked",
      dry_run: true,
      mutation_calls: 0,
      object_count: restorePlan.objects.length,
      v2_index_strategy: restorePlan.v2_index_strategy,
    });
  }
  const environment = validateObservationHistoryV3MigrationEnvironment({
    ...environmentEvidence,
    apply: true,
    operation: "rollback",
  });
  if (
    restorePlan.environment?.environment !== environment.environment ||
    restorePlan.environment?.bucket !== environment.bucket
  ) {
    throw new Error("Rollback checkpoint environment/bucket authority mismatch");
  }
  if (writersFrozen !== true) {
    throw new Error("Rollback apply requires explicit confirmation that writers remain frozen");
  }
  for (const name of [
    "putChecksumObject",
    "putJsonObject",
    "getObject",
    "headObject",
    "rebuildV2Indexes",
    "verifyV2IndexCompleteness",
    "getBackupObject",
  ]) {
    if (typeof adapters?.[name] !== "function") {
      throw new TypeError(`Rollback apply adapter is missing: ${name}`);
    }
  }
  const evidence = [];
  for (const descriptor of restorePlan.objects) {
    const backupObject = await getRequiredObject(
      adapters.getBackupObject,
      descriptor.key,
      "Dropbox rollback authority",
    );
    if (
      backupObject.byte_size !== descriptor.byte_size ||
      backupObject.sha256 !== descriptor.sha256
    ) {
      throw new Error(`Dropbox rollback object identity changed: ${descriptor.key}`);
    }
    const object = { ...descriptor, body: backupObject.body };
    if (object.stage === "canonical_parquet") {
      const putEvidence = await adapters.putChecksumObject(object);
      const head = await adapters.headObject({ key: object.key });
      evidence.push({
        ...verifyR2StoredSha256Head({ head, intent: object }),
        put_status: String(putEvidence?.status || "succeeded"),
      });
    } else {
      await adapters.putJsonObject(object);
      const current = await adapters.getObject({ key: object.key });
      const identity = bodyIdentity(object.key, current.body);
      if (identity.byte_size !== object.byte_size || identity.sha256 !== object.sha256) {
        throw new Error(`Restored canonical object verification failed: ${object.key}`);
      }
      evidence.push(identity);
    }
  }
  const indexResult = await adapters.rebuildV2Indexes();
  if (
    !indexResult ||
    indexResult.ok === false ||
    indexResult.history_version !== "v2" ||
    (indexResult.write_r2 !== undefined && indexResult.write_r2 !== true)
  ) {
    throw new Error("Rollback v2 observation-timeseries index rebuild failed");
  }
  const v2IndexCompleteness = await adapters.verifyV2IndexCompleteness({
    restorePlan,
    indexResult,
  });
  if (
    !v2IndexCompleteness ||
    v2IndexCompleteness.ok === false ||
    v2IndexCompleteness.complete !== true
  ) {
    throw new Error("Rollback v2 observation-timeseries index completeness verification failed");
  }
  return Object.freeze({
    ok: true,
    status: "rollback_canonical_restored_v2_index_rebuilt",
    dry_run: false,
    observed_starting_index_version: environment.index_version,
    restored_objects: Object.freeze(evidence),
    v2_index_rebuild: indexResult,
    v2_index_completeness: v2IndexCompleteness,
    configuration_changed: false,
    scheduler_changed: false,
    deployment_changed: false,
  });
}

export function buildObservationHistoryV3MigrationAuditReport({
  plan,
  mode,
  startedAt,
  completedAt,
  execution = null,
  rollback = null,
}) {
  const failed = execution?.verification?.blockers || plan.blockers;
  const identity = (entry) => entry
    ? {
        key: entry.key,
        byte_size: entry.byte_size,
        sha256: entry.sha256,
      }
    : null;
  return {
    schema_version: OBSERVATION_HISTORY_V3_MIGRATION_SCHEMA_VERSION,
    kind: "uk_aq_observation_history_v3_migration_audit",
    environment: plan.environment.environment,
    migration_run_id: plan.migration_run_id,
    start_utc: startedAt || null,
    end_utc: completedAt || null,
    mode,
    pre_state_identities: {
      observation_root: {
        ...identity(plan.inventory.root_manifest),
        content_hash: plan.inventory.root_manifest.payload.content_hash,
      },
      v2_latest: plan.inventory.existing_v2_latest_identity,
    },
    dropbox_checkpoint_identity: plan.backup_gate
      ? {
          inventory_root: identity(plan.backup_gate.inventory_root),
          state_root: identity(plan.backup_gate.state_root),
        }
      : null,
    partitions_attempted: plan.units.length,
    partitions_succeeded: plan.units.filter((unit) => unit.logical_identity_verified).length,
    partitions_failed: plan.units.filter((unit) => !unit.logical_identity_verified).length,
    empty_source_connector_count: plan.empty_source_connector_count,
    empty_source_connectors: plan.empty_source_connectors.map((entry) => ({
      scope: entry.scope,
      source_manifest_key: entry.source_manifest_key,
      source_manifest_identity: entry.source_manifest_identity,
      source_manifest_hash: entry.source_manifest_hash,
      classification: entry.classification,
      contract_version: entry.contract_version,
    })),
    partition_results: plan.units.map((unit) => ({
      scope: unit.scope,
      old_row_count: unit.source_row_count,
      new_row_count: unit.target_metadata?.row_count ?? null,
      old_observation_content_hash: unit.source_observation_content_hash,
      new_observation_content_hash:
        unit.target_metadata?.observation_content_hash ?? null,
      old_file_count: unit.source_files.length,
      new_file_count: unit.target_file_count ?? null,
      new_row_group_count: unit.target_row_group_count ?? null,
      verification_status_counts:
        unit.target_metadata?.verification_status_counts ?? null,
      source_observation_content_hash_provenance:
        unit.source_observation_content_hash_provenance,
      source_manifest_reference_provenance:
        unit.source_manifest_reference.provenance,
      source_parent_manifest_key:
        unit.source_manifest_reference.parent_manifest_key,
      source_parent_referenced_child_manifest_hash:
        unit.source_manifest_reference.referenced_child_manifest_hash,
      source_current_child_manifest_key:
        unit.source_manifest_reference.current_child_manifest_key,
      source_current_child_manifest_hash:
        unit.source_manifest_reference.current_child_manifest_hash,
      source_current_child_genuine_legacy_hashless:
        unit.source_manifest_reference.current_child_genuine_legacy_hashless,
      source_manifest_reference_compatibility_contract_version:
        unit.source_manifest_reference.compatibility_contract_version,
      source_manifest_reference_summary_identity_all_match:
        unit.source_manifest_reference.summary_identity_all_match,
      source_manifest_reference_summary_identity_fields:
        unit.source_manifest_reference.compatibility_summary_identity_fields,
      source_parent_summary_identity:
        unit.source_manifest_reference.parent_summary_identity,
      source_current_child_summary_identity:
        unit.source_manifest_reference.current_child_summary_identity,
    })),
    source_observation_content_hash_provenance_counts:
      plan.source_observation_content_hash_provenance_counts,
    source_manifest_reference_provenance_counts:
      plan.source_manifest_reference_provenance_counts,
    target_writer_version: plan.target.writer_version,
    target_history_schema_version: plan.target.history_schema_version,
    target_physical_layout_version: plan.target.physical_layout_version,
    r2_stored_sha_verification:
      execution?.verification?.r2_stored_sha_verification || "not_run",
    v3_child_count: plan.estimated.v3_child_shards,
    v3_scoped_root_count: plan.estimated.v3_scoped_roots,
    v3_latest_count: plan.estimated.v3_latest_objects,
    publication_verification: execution?.v3_publication?.ok === true,
    cutover_ready: execution?.verification?.cutover_ready === true,
    blockers: [...failed],
    rollback_ready: Boolean(
      plan.backup_gate?.verified && plan.rollback_preflight?.verified,
    ),
    rollback_required: rollback?.required === true,
    rollback_status: rollback?.status || "not_run",
    rollback_observed_starting_index_version:
      rollback?.observed_starting_index_version || null,
  };
}
