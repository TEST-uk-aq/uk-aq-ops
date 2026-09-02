// @ts-nocheck -- post-cutover-only Node writer shared by every canonical source.
import { Buffer } from "node:buffer";

import {
  buildObservationHistoryIndexV3PublicationPlan,
  buildObservationHistoryIndexV3ScopedHierarchy,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
  updateObservationHistoryIndexV3Latest,
} from "./uk_aq_observation_history_index_v3.mjs";
import {
  OBSERVATION_HISTORY_V3_INDEX_ROOT,
} from "./uk_aq_observation_history_reader_v3.mjs";
import {
  buildCanonicalObservationTimeseriesBoundedFiles,
} from "./uk_aq_observation_history_target_writer.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "./uk_aq_observation_history_writer_limits_v3.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
} from "./uk_aq_r2_checksum_publication.mjs";
import {
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
} from "./uk_aq_r2_history_canonical.mjs";
import {
  runCanonicalDayFinalizer,
  runCanonicalGlobalIndexFinalizer,
  withConnectorDayHistoryLock,
} from "./uk_aq_r2_history_writer.mjs";
import {
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "./r2_sigv4.mjs";

export const OBSERVATION_HISTORY_V3_STEADY_STATE_WRITER_GENERATION = "v3";
export const OBSERVATION_HISTORY_V3_STEADY_STATE_HISTORY_VERSION = "v2";
export const DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX =
  "history/v2/observations";
export const DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";

export const OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES = Object.freeze({
  pruneDaily: "prune_daily",
  integrity: "integrity",
  sosHistoricalReplacement: "sos_historical_replacement",
  supportedBackfill: "supported_backfill",
});

const ALLOWED_SOURCES = new Set(
  Object.values(OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES),
);

function exactBuffer(value, fieldName) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${fieldName} body is unavailable`);
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (!ALLOWED_SOURCES.has(source)) {
    throw new Error(`Unsupported observation-history v3 writer source: ${source || "unset"}`);
  }
  return source;
}

function normalizePrefix(value, fieldName) {
  const prefix = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(`${fieldName} is invalid`);
  }
  return prefix;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function scopeIdentity(scope) {
  return [scope.day_utc, scope.connector_id, scope.pollutant_code].join("\u0000");
}

function connectorDayIdentity(scope) {
  return [scope.day_utc, scope.connector_id].join("\u0000");
}

function sortedUniqueConnectorIds(values, fieldName) {
  if (!Array.isArray(values)) throw new TypeError(`${fieldName} must be an array`);
  const ids = values.map((value) => Number(value));
  if (ids.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${fieldName} contains an invalid connector ID`);
  }
  const unique = [...new Set(ids)].sort((left, right) => left - right);
  if (unique.length !== ids.length) throw new Error(`${fieldName} contains duplicate connector IDs`);
  return unique;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertDurableEvidence(value, label) {
  const key = String(value?.key || "").trim();
  const byteSize = Number(value?.byte_size);
  const sha256 = String(value?.sha256 || "").trim();
  if (
    value?.verified !== true || value?.durable !== true || !key ||
    !Number.isSafeInteger(byteSize) || byteSize <= 0 ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new Error(`${label} is not exact verified durable evidence`);
  }
  return Object.freeze({
    key,
    byte_size: byteSize,
    sha256,
    verified: true,
    durable: true,
  });
}

function canonicalJsonArtifact({ key, payload, dependencies }) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return Object.freeze({
    kind: "canonical_observation_pollutant_manifest",
    key,
    payload,
    body,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
    content_type: "application/json; charset=utf-8",
    publication_stage: "pollutant_manifest",
    dependencies: Object.freeze(dependencies.map((entry) => ({ ...entry }))),
    publication_prerequisites: Object.freeze([]),
  });
}

function contentHashMetadata(metadata) {
  return {
    observation_content_hash: metadata.observation_content_hash,
    observation_content_hash_algorithm: metadata.observation_content_hash_algorithm,
    observation_content_hash_contract_version:
      metadata.observation_content_hash_contract_version,
    observation_content_hash_row_count:
      metadata.observation_content_hash_row_count,
    observation_content_hash_columns: [...metadata.observation_content_hash_columns],
    verification_status_counts: { ...metadata.verification_status_counts },
  };
}

function fileEntry(file, pollutantCode) {
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

function canonicalManifestDescriptor(artifact) {
  return Object.freeze({
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
    manifest_hash: artifact.payload.manifest_hash,
    row_count: artifact.payload.row_count,
    observation_content_hash: artifact.payload.observation_content_hash,
  });
}

function latestArtifactFromStoredObject({ key, body, latestKey }) {
  if (key !== latestKey) throw new Error(`Unexpected v3 latest key: ${key}`);
  const bytes = exactBuffer(body, key);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Stored v3 latest object is invalid JSON: ${key}`);
  }
  const canonicalBody = encodeObservationHistoryIndexV3Json(payload);
  if (bytes.toString("utf8") !== canonicalBody) {
    throw new Error(`Stored v3 latest object is not canonical JSON: ${key}`);
  }
  const roots = (Array.isArray(payload.day_summaries) ? payload.day_summaries : [])
    .flatMap((day) => Array.isArray(day?.scoped_roots) ? day.scoped_roots : []);
  return Object.freeze({
    kind: "observation_history_index_v3_latest_global",
    key,
    payload,
    body: canonicalBody,
    byte_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    content_type: "application/json; charset=utf-8",
    publication_stage: "latest_global",
    dependencies: Object.freeze(roots.map((root) => ({
      kind: "scoped_manifest",
      key: root.key,
      byte_size: root.byte_size,
      sha256: root.sha256,
    })).sort((left, right) =>
      Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
    )),
    publication_prerequisites: Object.freeze([]),
  });
}

function assertEvidence(actual, expected, label) {
  if (
    !actual || actual.verified !== true || actual.durable !== true
    || actual.key !== expected.key
    || Number(actual.byte_size) !== expected.byte_size
    || actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} did not return exact verified durable identity: ${expected.key}`);
  }
  return Object.freeze({
    key: expected.key,
    byte_size: expected.byte_size,
    sha256: expected.sha256,
    verified: true,
    durable: true,
  });
}

async function verifiedExternalReference(reference, getObject) {
  const object = await getObject({ key: reference.key });
  if (!object || object.exists === false || object.body === null || object.body === undefined) {
    throw new Error(`V3 external publication reference is missing: ${reference.key}`);
  }
  const body = exactBuffer(object.body, reference.key);
  if (body.byteLength !== reference.byte_size || sha256Hex(body) !== reference.sha256) {
    throw new Error(`V3 external publication reference identity changed: ${reference.key}`);
  }
  return Object.freeze({
    key: reference.key,
    byte_size: reference.byte_size,
    sha256: reference.sha256,
    verified: true,
    durable: true,
  });
}

/**
 * Pure preparation for one complete canonical day/connector/pollutant scope.
 * No scheduled v2 writer imports this module during Phase 5.
 */
export function buildObservationHistoryV3SteadyStatePartition({
  source,
  rows,
  scope = null,
  writerLimits = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  targetWriterGitSha,
  backedUpAtUtc,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
}) {
  const normalizedSource = normalizeSource(source);
  const writerGitSha = String(targetWriterGitSha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(writerGitSha)) {
    throw new TypeError("targetWriterGitSha must be a full lower-case Git SHA");
  }
  const prefix = normalizePrefix(observationsPrefix, "observationsPrefix");
  const normalizedIndexRoot = normalizePrefix(indexRoot, "indexRoot");
  if (normalizedIndexRoot !== OBSERVATION_HISTORY_V3_INDEX_ROOT) {
    throw new Error(`Steady-state v3 writer requires index root ${OBSERVATION_HISTORY_V3_INDEX_ROOT}`);
  }
  const acceptedWriterLimits = assertAcceptedObservationHistoryWriterLimitsV3(
    writerLimits,
    "steady-state observation-history v3 writer limits",
  );
  const firstRow = rows?.[0] || null;
  const requestedScope = scope || (firstRow ? {
    day_utc: firstRow.day_utc || String(firstRow.observed_at_utc || "").slice(0, 10),
    connector_id: firstRow.connector_id,
    pollutant_code: firstRow.pollutant_code,
  } : null);
  const target = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits: acceptedWriterLimits,
    partition: requestedScope,
    fileKeyForOrdinal: (ordinal) => {
      return buildHistoryV2PartKey(
        prefix,
        requestedScope?.day_utc,
        requestedScope?.connector_id,
        requestedScope?.pollutant_code,
        ordinal,
      );
    },
  });
  const partitionScope = target.metadata.partition;
  const fileIntents = target.file_bodies.map((file) =>
    buildR2ChecksumAwarePutIntent({ key: file.key, body: file.body })
  );
  const manifestKey = buildHistoryV2PollutantManifestKey(
    prefix,
    partitionScope.day_utc,
    partitionScope.connector_id,
    partitionScope.pollutant_code,
  );
  const manifestPayload = buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc: partitionScope.day_utc,
    connectorId: partitionScope.connector_id,
    pollutantCode: partitionScope.pollutant_code,
    runId: null,
    manifestKey,
    sourceRowCount: target.metadata.row_count,
    fileEntries: target.metadata.files.map((file) =>
      fileEntry(file, partitionScope.pollutant_code)
    ),
    writerGitSha,
    backedUpAtUtc: backedUpAtUtc ?? null,
    observationContentHash: contentHashMetadata(target.metadata),
    physicalSchema: {
      history_schema_version: target.metadata.history_schema_version,
      columns: [...target.metadata.columns],
      writer_version: target.metadata.writer_version,
    },
  });
  const manifestArtifact = canonicalJsonArtifact({
    key: manifestKey,
    payload: manifestPayload,
    dependencies: fileIntents.map((intent) => ({
      kind: "canonical_parquet",
      key: intent.key,
      byte_size: intent.byte_size,
      sha256: intent.sha256,
    })),
  });
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: target.metadata,
    canonicalManifest: canonicalManifestDescriptor(manifestArtifact),
    indexRoot: normalizedIndexRoot,
  });
  return Object.freeze({
    source: normalizedSource,
    prune_eligibility_owner:
      normalizedSource === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
    scope: Object.freeze({ ...partitionScope }),
    target_metadata: target.metadata,
    file_intents: Object.freeze(fileIntents),
    canonical_pollutant_manifest: manifestArtifact,
    v3_hierarchy: hierarchy,
  });
}

function normalizePartitionInputs(partitions) {
  if (!Array.isArray(partitions) || partitions.length === 0) {
    throw new TypeError("V3 steady-state writer requires a non-empty partitions array");
  }
  return partitions.map((partition, index) => {
    if (Array.isArray(partition)) {
      return { rows: partition, scope: null, backed_up_at_utc: undefined };
    }
    if (!partition || typeof partition !== "object" || !Array.isArray(partition.rows)) {
      throw new TypeError(`V3 steady-state writer partition ${index} requires rows`);
    }
    return {
      rows: partition.rows,
      scope: partition.scope ?? null,
      backed_up_at_utc: partition.backed_up_at_utc ?? partition.backedUpAtUtc,
    };
  });
}

function prepareRunPartitions({
  source,
  partitions,
  writerLimits,
  targetWriterGitSha,
  backedUpAtUtc,
  observationsPrefix,
  indexRoot,
}) {
  const prepared = normalizePartitionInputs(partitions).map((partition) =>
    buildObservationHistoryV3SteadyStatePartition({
      source,
      rows: partition.rows,
      scope: partition.scope,
      writerLimits,
      targetWriterGitSha,
      backedUpAtUtc: partition.backed_up_at_utc ?? backedUpAtUtc,
      observationsPrefix,
      indexRoot,
    })
  ).sort((left, right) =>
    bytewiseCompare(left.scope.day_utc, right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id ||
    bytewiseCompare(left.scope.pollutant_code, right.scope.pollutant_code)
  );
  const seen = new Set();
  for (const partition of prepared) {
    const identity = scopeIdentity(partition.scope);
    if (seen.has(identity)) {
      throw new Error(
        `V3 steady-state writer received duplicate partition scope: ${identity.replaceAll("\u0000", "/")}`,
      );
    }
    seen.add(identity);
  }
  return prepared;
}

function groupPreparedByConnectorDay(prepared) {
  const groups = new Map();
  for (const partition of prepared) {
    const identity = connectorDayIdentity(partition.scope);
    const existing = groups.get(identity) || {
      day_utc: partition.scope.day_utc,
      connector_id: partition.scope.connector_id,
      partitions: [],
    };
    existing.partitions.push(partition);
    groups.set(identity, existing);
  }
  return [...groups.values()].sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    left.connector_id - right.connector_id
  );
}

function validateConnectorCanonicalResult({
  group,
  result,
  observationsPrefix,
  source,
}) {
  if (
    result?.connector_scope_verified !== true ||
    result?.parent_state_reread_under_lock !== true ||
    result?.day_utc !== group.day_utc ||
    Number(result?.connector_id) !== group.connector_id
  ) {
    throw new Error(
      `Connector-scoped canonical finalizer did not verify ${group.day_utc}/${group.connector_id}`,
    );
  }
  if (result?.prune_eligibility_created === true) {
    throw new Error("Shared v3 writer canonical stages must not create Prune Daily eligibility");
  }
  if (!Array.isArray(result.pollutant_manifests)) {
    throw new TypeError("Connector-scoped canonical finalizer must return pollutant_manifests");
  }
  const actualByKey = new Map();
  for (const evidence of result.pollutant_manifests) {
    const normalized = assertDurableEvidence(evidence, "Canonical pollutant manifest");
    if (actualByKey.has(normalized.key)) {
      throw new Error(`Duplicate canonical pollutant manifest evidence: ${normalized.key}`);
    }
    actualByKey.set(normalized.key, normalized);
  }
  if (actualByKey.size !== group.partitions.length) {
    throw new Error("Connector-scoped canonical finalizer returned the wrong pollutant manifest set");
  }
  const pollutantManifests = group.partitions.map((partition) => {
    const expected = partition.canonical_pollutant_manifest;
    return assertEvidence(
      actualByKey.get(expected.key),
      expected,
      "Connector-scoped canonical finalizer",
    );
  });
  const connectorManifest = assertDurableEvidence(
    result.connector_manifest,
    "Canonical connector manifest",
  );
  const expectedConnectorManifestKey = buildHistoryV2ConnectorManifestKey(
    observationsPrefix,
    group.day_utc,
    group.connector_id,
  );
  if (connectorManifest.key !== expectedConnectorManifestKey) {
    throw new Error(`Canonical connector manifest key disagrees: ${group.day_utc}/${group.connector_id}`);
  }
  const changedPollutants = [...group.partitions]
    .map((partition) => partition.scope.pollutant_code)
    .sort(bytewiseCompare);
  const reportedPollutantCodes = (values, fieldName) => {
    if (!Array.isArray(values)) {
      throw new TypeError(`Canonical connector finalizer ${fieldName} must be an array`);
    }
    const normalized = values.map((value) =>
      String(value || "").trim().toLowerCase()
    );
    if (
      normalized.some((value) => !/^[a-z0-9_]+$/.test(value)) ||
      new Set(normalized).size !== normalized.length
    ) {
      throw new Error(
        `Canonical connector finalizer ${fieldName} must contain unique canonical pollutant codes`,
      );
    }
    return normalized.sort(bytewiseCompare);
  };
  const reportedChanged = reportedPollutantCodes(
    result.changed_pollutant_codes,
    "changed_pollutant_codes",
  );
  const currentPollutants = reportedPollutantCodes(
    result.current_pollutant_codes,
    "current_pollutant_codes",
  );
  const finalPollutants = reportedPollutantCodes(
    result.final_pollutant_codes,
    "final_pollutant_codes",
  );
  const removedPollutants = reportedPollutantCodes(
    result.removed_pollutant_codes,
    "removed_pollutant_codes",
  );
  const completeConnectorSnapshot =
    source === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily;
  const changedPollutantSet = new Set(changedPollutants);
  const expectedFinalPollutants = completeConnectorSnapshot
    ? [...changedPollutants]
    : [...new Set([...currentPollutants, ...changedPollutants])]
      .sort(bytewiseCompare);
  const expectedRemovedPollutants = completeConnectorSnapshot
    ? currentPollutants.filter((pollutantCode) =>
      !changedPollutantSet.has(pollutantCode)
    )
    : [];
  if (!sameArray(reportedChanged, changedPollutants)) {
    throw new Error(
      `Canonical connector finalizer changed-pollutant evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  if (!sameArray(finalPollutants, expectedFinalPollutants)) {
    throw new Error(
      completeConnectorSnapshot
        ? `Canonical connector finalizer did not publish the complete Prune pollutant set: ${group.day_utc}/${group.connector_id}`
        : `Canonical connector finalizer did not preserve the current pollutant union: ${group.day_utc}/${group.connector_id}`,
    );
  }
  if (!sameArray(removedPollutants, expectedRemovedPollutants)) {
    throw new Error(
      `Canonical connector finalizer removed-pollutant evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  const removedScopes = Array.isArray(result.removed_scopes)
    ? result.removed_scopes.map((scope) => ({
      day_utc: String(scope?.day_utc || ""),
      connector_id: Number(scope?.connector_id),
      pollutant_code: String(scope?.pollutant_code || "").trim().toLowerCase(),
    }))
    : null;
  const expectedRemovedScopes = expectedRemovedPollutants.map((pollutantCode) => ({
    day_utc: group.day_utc,
    connector_id: group.connector_id,
    pollutant_code: pollutantCode,
  }));
  if (
    removedScopes === null ||
    JSON.stringify(removedScopes) !== JSON.stringify(expectedRemovedScopes)
  ) {
    throw new Error(
      `Canonical connector finalizer removed-scope evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  return Object.freeze({
    day_utc: group.day_utc,
    connector_id: group.connector_id,
    connector_manifest: connectorManifest,
    connector_manifest_payload: result.connector_manifest_payload ?? null,
    current_pollutant_codes: Object.freeze(currentPollutants),
    changed_pollutant_codes: Object.freeze(reportedChanged),
    final_pollutant_codes: Object.freeze(finalPollutants),
    removed_pollutant_codes: Object.freeze(removedPollutants),
    removed_scopes: Object.freeze(removedScopes.map((scope) =>
      Object.freeze({ ...scope })
    )),
    pollutant_manifests: Object.freeze(pollutantManifests),
    connector_scope_verified: true,
    parent_state_reread_under_lock: true,
  });
}

function validateDayCanonicalResult({
  dayUtc,
  changedConnectorIds,
  result,
  observationsPrefix,
}) {
  if (
    result?.canonical_day_authority_verified !== true ||
    result?.parent_state_reread_under_lock !== true ||
    result?.day_utc !== dayUtc
  ) {
    throw new Error(`Canonical day finalizer did not establish locked current-parent authority: ${dayUtc}`);
  }
  if (result?.prune_eligibility_created === true) {
    throw new Error("Shared v3 writer day finalization must not create Prune Daily eligibility");
  }
  const reportedChanged = sortedUniqueConnectorIds(
    result.changed_connector_ids,
    "changed_connector_ids",
  );
  if (!sameArray(reportedChanged, changedConnectorIds)) {
    throw new Error(`Canonical day finalizer changed-connector evidence disagrees: ${dayUtc}`);
  }
  const current = sortedUniqueConnectorIds(
    result.current_connector_ids,
    "current_connector_ids",
  );
  const finalIds = sortedUniqueConnectorIds(
    result.final_connector_ids,
    "final_connector_ids",
  );
  const expectedFinal = [...new Set([...current, ...changedConnectorIds])]
    .sort((left, right) => left - right);
  if (!sameArray(finalIds, expectedFinal)) {
    throw new Error(`Canonical day finalizer did not preserve the current connector set: ${dayUtc}`);
  }
  const dayManifest = assertDurableEvidence(result.day_manifest, "Canonical day manifest");
  if (dayManifest.key !== buildHistoryV2DayManifestKey(observationsPrefix, dayUtc)) {
    throw new Error(`Canonical day manifest key disagrees: ${dayUtc}`);
  }
  return Object.freeze({
    day_utc: dayUtc,
    changed_connector_ids: Object.freeze([...changedConnectorIds]),
    current_connector_ids: Object.freeze(current),
    final_connector_ids: Object.freeze(finalIds),
    day_manifest: dayManifest,
    canonical_day_authority_verified: true,
    parent_state_reread_under_lock: true,
  });
}

function validateAggregateCanonicalResult({ affectedDays, result }) {
  if (
    result?.canonical_aggregate_authority_verified !== true ||
    result?.parent_state_reread_under_lock !== true
  ) {
    throw new Error("Canonical aggregate finalizer did not establish locked current-parent authority");
  }
  if (result?.prune_eligibility_created === true) {
    throw new Error("Shared v3 writer aggregate finalization must not create Prune Daily eligibility");
  }
  const reportedDays = [...new Set(
    (Array.isArray(result.affected_days_utc) ? result.affected_days_utc : [])
      .map((value) => String(value || "").trim()),
  )].sort(bytewiseCompare);
  if (!sameArray(reportedDays, affectedDays)) {
    throw new Error("Canonical aggregate finalizer affected-day evidence disagrees");
  }
  const manifests = (Array.isArray(result.aggregate_manifests)
    ? result.aggregate_manifests
    : []).map((entry) => assertDurableEvidence(entry, "Canonical aggregate manifest"));
  manifests.sort((left, right) => bytewiseCompare(left.key, right.key));
  return Object.freeze({
    affected_days_utc: Object.freeze([...affectedDays]),
    aggregate_manifests: Object.freeze(manifests),
    canonical_aggregate_authority_verified: true,
    parent_state_reread_under_lock: true,
  });
}

async function publishConnectorExactV3Scopes({
  partitions,
  canonical,
  getObject,
  putIfChanged,
  recordDurableEvidence,
  finalizeV3Publication,
}) {
  const exactObjects = partitions.flatMap((partition) => [
    ...partition.v3_hierarchy.child_shards,
    partition.v3_hierarchy.scoped_manifest,
  ]);
  const knownEvidence = new Map();
  for (const partition of partitions) {
    for (const evidence of partition.file_evidence) {
      knownEvidence.set(evidence.key, evidence);
    }
  }
  for (const evidence of canonical.pollutant_manifests) {
    knownEvidence.set(evidence.key, evidence);
  }
  const exactKeys = new Set(exactObjects.map((object) => object.key));
  const externalByKey = new Map();
  for (const object of exactObjects) {
    for (const reference of [
      ...(object.dependencies || []),
      ...(object.publication_prerequisites || []),
    ]) {
      if (exactKeys.has(reference.key) || externalByKey.has(reference.key)) continue;
      const known = knownEvidence.get(reference.key);
      externalByKey.set(
        reference.key,
        known
          ? assertEvidence(known, reference, "V3 publication prerequisite")
          : await verifiedExternalReference(reference, getObject),
      );
    }
  }
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects: exactObjects,
    externalReferences: [...externalByKey.values()],
  });
  const publication = await finalizeV3Publication({
    plan,
    putIfChanged,
    getObject,
    recordDurableEvidence,
  });
  if (publication?.ok !== true || !Array.isArray(publication.objects)) {
    throw new Error("Connector-scoped v3 publication did not return verified object evidence");
  }
  const evidenceByKey = new Map(
    publication.objects.map((entry) => [entry.key, entry]),
  );
  const scopedRoots = partitions.map((partition) => {
    const artifact = partition.v3_hierarchy.scoped_manifest;
    return Object.freeze({
      scope: partition.scope,
      artifact,
      evidence: assertEvidence(
        evidenceByKey.get(artifact.key),
        artifact,
        "Connector-scoped v3 root publication",
      ),
    });
  });
  return Object.freeze({
    publication,
    scoped_roots: Object.freeze(scopedRoots),
  });
}

/**
 * Publish one bounded set of connector-scoped canonical leaves and exact v3
 * scopes. This phase deliberately does not publish day, aggregate or latest
 * authority; callers retain only its durable lightweight evidence for the
 * coordinated run finalizer.
 */
export async function runObservationHistoryV3ConnectorPublication({
  client,
  source,
  partitions,
  writerLimits = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  targetWriterGitSha,
  backedUpAtUtc,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_LATEST_KEY,
  r2,
  putObject = r2PutObject,
  headObject = r2HeadObject,
  getObject,
  publishConnectorScopedCanonicalManifests,
  putIfChanged,
  recordDurableEvidence,
  finalizeV3Publication = finalizeObservationHistoryIndexV3Publication,
  putAndVerifyParquet = putAndVerifyR2ObjectWithSha256,
  withConnectorDayLock = withConnectorDayHistoryLock,
  runDayFinalizer = runCanonicalDayFinalizer,
  diagnostics,
  diagnosticEnvironment,
  lockTimeoutMs,
  prepareCompleteDayReplacement = null,
}) {
  if (!client?.query) throw new Error("V3 steady-state writer requires PostgreSQL lock client");
  if (!r2 || typeof r2 !== "object") throw new Error("V3 steady-state writer requires R2 configuration");
  for (const [name, adapter] of Object.entries({
    getObject,
    publishConnectorScopedCanonicalManifests,
    putIfChanged,
    recordDurableEvidence,
    finalizeV3Publication,
    putAndVerifyParquet,
    withConnectorDayLock,
    runDayFinalizer,
  })) {
    if (typeof adapter !== "function") throw new TypeError(`V3 steady-state writer adapter is missing: ${name}`);
  }
  const normalizedSource = normalizeSource(source);
  const sosReplacement =
    normalizedSource === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement;
  if (sosReplacement && typeof prepareCompleteDayReplacement !== "function") {
    throw new TypeError(
      "SOS historical replacement requires complete-day deletion/reconstruction preparation",
    );
  }
  if (!sosReplacement && prepareCompleteDayReplacement !== null) {
    throw new Error(
      "Complete-day replacement preparation is reserved for SOS historical replacement",
    );
  }
  const prepared = prepareRunPartitions({
    source,
    partitions,
    writerLimits,
    targetWriterGitSha,
    backedUpAtUtc,
    observationsPrefix,
    indexRoot,
  });
  const canonicalObservationsPrefix = normalizePrefix(
    observationsPrefix,
    "observationsPrefix",
  );
  const connectorGroups = groupPreparedByConnectorDay(prepared);
  prepared.length = 0;
  const connectorResults = [];
  const completeDayReplacementResults = [];
  const replacementDaysPrepared = new Set();
  for (const group of connectorGroups) {
    if (sosReplacement && !replacementDaysPrepared.has(group.day_utc)) {
      const replacement = await runDayFinalizer({
        client,
        dayUtc: group.day_utc,
        diagnostics,
        diagnosticEnvironment,
        timeoutMs: lockTimeoutMs,
        finalize: async () => await prepareCompleteDayReplacement({
          source: normalizedSource,
          day_utc: group.day_utc,
          complete_day_partitions: Object.freeze(
            connectorGroups
              .filter((entry) => entry.day_utc === group.day_utc)
              .flatMap((entry) => entry.partitions),
          ),
        }),
      });
      if (
        replacement?.complete_day_replacement_verified !== true ||
        replacement?.day_utc !== group.day_utc ||
        replacement?.complete_partition_set !== true
      ) {
        throw new Error(
          `SOS complete-day replacement preparation was not verified: ${group.day_utc}`,
        );
      }
      completeDayReplacementResults.push(Object.freeze({ ...replacement }));
      replacementDaysPrepared.add(group.day_utc);
    }
    const result = await withConnectorDayLock({
      client,
      dayUtc: group.day_utc,
      connectorId: group.connector_id,
      diagnostics,
      diagnosticEnvironment,
      timeoutMs: lockTimeoutMs,
    }, async () => {
      const partitionResults = [];
      for (const partition of group.partitions) {
        const fileEvidence = [];
        for (const intent of partition.file_intents) {
          const verified = await putAndVerifyParquet({
            r2,
            intent,
            putObject,
            headObject,
          });
          fileEvidence.push(Object.freeze({
            ...verified,
            verified: true,
            durable: true,
          }));
        }
        partitionResults.push(Object.freeze({
          scope: partition.scope,
          target_metadata: partition.target_metadata,
          pollutant_manifest: partition.canonical_pollutant_manifest,
          file_evidence: Object.freeze(fileEvidence),
          v3_hierarchy: partition.v3_hierarchy,
        }));
      }
      const canonicalResult = await publishConnectorScopedCanonicalManifests({
        source: normalizedSource,
        day_utc: group.day_utc,
        connector_id: group.connector_id,
        partitions: Object.freeze(partitionResults),
      });
      const canonical = validateConnectorCanonicalResult({
        group,
        result: canonicalResult,
        observationsPrefix: canonicalObservationsPrefix,
        source: normalizedSource,
      });
      const exact = await publishConnectorExactV3Scopes({
        partitions: partitionResults,
        canonical,
        getObject,
        putIfChanged,
        recordDurableEvidence,
        finalizeV3Publication,
      });
      const scopedRootByIdentity = new Map(
        exact.scoped_roots.map((root) => [scopeIdentity(root.scope), root]),
      );
      return Object.freeze({
        day_utc: group.day_utc,
        connector_id: group.connector_id,
        partitions: Object.freeze(partitionResults.map((partition) =>
          Object.freeze({
            scope: partition.scope,
            target_metadata: partition.target_metadata,
            pollutant_manifest: partition.pollutant_manifest,
            file_evidence: partition.file_evidence,
            scoped_root: scopedRootByIdentity.get(scopeIdentity(partition.scope)),
          })
        )),
        canonical,
        v3_exact_publication: exact.publication,
      });
    });
    connectorResults.push(result);
    group.partitions.length = 0;
  }

  const connectorPublication = {
    ok: connectorResults.every((entry) =>
      entry.v3_exact_publication?.ok === true
    ),
    status: "connector_publication_complete",
    source: normalizedSource,
    prune_eligibility_owner:
      normalizedSource === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
    connector_publication_complete: true,
    connector_results: Object.freeze(connectorResults),
    complete_day_replacement_results: Object.freeze(
      completeDayReplacementResults,
    ),
  };
  return Object.freeze({
    ...connectorPublication,
    run_finalization_evidence:
      buildRunFinalizationEvidence(connectorPublication),
  });
}

function collectVerifiedConnectorPublications({ source, connectorPublications }) {
  const normalizedSource = normalizeSource(source);
  if (!Array.isArray(connectorPublications) || connectorPublications.length === 0) {
    throw new TypeError("V3 run finalization requires connector publication evidence");
  }
  const connectorResults = [];
  const completeDayReplacementResults = [];
  const seenConnectorDays = new Set();
  for (const publication of connectorPublications) {
    if (
      publication?.ok !== true ||
      publication?.connector_publication_complete !== true ||
      publication?.source !== normalizedSource ||
      !Array.isArray(publication.connector_results) ||
      publication.connector_results.length === 0
    ) {
      throw new Error("V3 run finalization received incomplete connector publication evidence");
    }
    for (const result of publication.connector_results) {
      const identity = `${result?.day_utc}\u0000${result?.connector_id}`;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(String(result?.day_utc || "")) ||
        !Number.isInteger(Number(result?.connector_id)) ||
        Number(result.connector_id) <= 0 ||
        result?.canonical?.connector_scope_verified !== true ||
        result?.canonical?.parent_state_reread_under_lock !== true ||
        result?.v3_exact_publication?.ok !== true ||
        !Array.isArray(result?.partitions) ||
        result.partitions.length === 0 ||
        seenConnectorDays.has(identity)
      ) {
        throw new Error("V3 run finalization received contradictory connector publication evidence");
      }
      seenConnectorDays.add(identity);
      connectorResults.push(result);
    }
    completeDayReplacementResults.push(
      ...(publication.complete_day_replacement_results || []),
    );
  }
  connectorResults.sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    left.connector_id - right.connector_id
  );
  return Object.freeze({
    source: normalizedSource,
    connector_results: Object.freeze(connectorResults),
    complete_day_replacement_results: Object.freeze(
      completeDayReplacementResults,
    ),
  });
}

function buildRunFinalizationEvidence(connectorPublication) {
  return Object.freeze({
    ok: connectorPublication.ok,
    status: connectorPublication.status,
    source: connectorPublication.source,
    prune_eligibility_owner: connectorPublication.prune_eligibility_owner,
    connector_publication_complete:
      connectorPublication.connector_publication_complete,
    connector_results: Object.freeze(
      connectorPublication.connector_results.map((result) => Object.freeze({
        day_utc: result.day_utc,
        connector_id: result.connector_id,
        partitions: Object.freeze(result.partitions.map((partition) =>
          Object.freeze({
            scope: partition.scope,
            scoped_root: partition.scoped_root,
          })
        )),
        canonical: Object.freeze({
          connector_manifest: result.canonical.connector_manifest,
          connector_manifest_payload:
            result.canonical.connector_manifest_payload,
          removed_pollutant_codes:
            result.canonical.removed_pollutant_codes,
          removed_scopes: result.canonical.removed_scopes,
          connector_scope_verified:
            result.canonical.connector_scope_verified,
          parent_state_reread_under_lock:
            result.canonical.parent_state_reread_under_lock,
        }),
        v3_exact_publication: Object.freeze({
          ok: result.v3_exact_publication?.ok === true,
          status: result.v3_exact_publication?.status ?? null,
        }),
      })),
    ),
    complete_day_replacement_results:
      connectorPublication.complete_day_replacement_results,
  });
}

function obsoletePruneLatestScopes({ source, existingLatest, connectorResults }) {
  if (source !== OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily) {
    return Object.freeze([]);
  }
  const completeConnectorDays = new Set(
    connectorResults.map((result) => connectorDayIdentity({
      day_utc: result.day_utc,
      connector_id: result.connector_id,
    })),
  );
  const replacementScopes = new Set(
    connectorResults.flatMap((result) => result.partitions)
      .map((partition) => scopeIdentity(partition.scope)),
  );
  // Derive removals from latest as well as connector publication evidence so a
  // retry still converges after canonical connector authority already advanced.
  const removals = (Array.isArray(existingLatest?.payload?.day_summaries)
    ? existingLatest.payload.day_summaries
    : [])
    .flatMap((day) => Array.isArray(day?.scoped_roots) ? day.scoped_roots : [])
    .filter((root) =>
      completeConnectorDays.has(connectorDayIdentity(root)) &&
      !replacementScopes.has(scopeIdentity(root))
    )
    .map((root) => Object.freeze({
      day_utc: root.day_utc,
      connector_id: root.connector_id,
      pollutant_code: root.pollutant_code,
    }))
    .sort((left, right) =>
      bytewiseCompare(left.day_utc, right.day_utc) ||
      left.connector_id - right.connector_id ||
      bytewiseCompare(left.pollutant_code, right.pollutant_code)
    );
  return Object.freeze(removals);
}

/**
 * Finalize exact affected days once, then aggregate/root and latest/global
 * authority once, from verified connector publication evidence only.
 */
export async function runObservationHistoryV3RunFinalization({
  client,
  source,
  connectorPublications,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_LATEST_KEY,
  r2,
  getObject,
  finalizeCanonicalDayManifests,
  finalizeCanonicalAggregateManifests,
  putIfChanged,
  recordDurableEvidence,
  finalizeV3Publication = finalizeObservationHistoryIndexV3Publication,
  runDayFinalizer = runCanonicalDayFinalizer,
  runGlobalFinalizer = runCanonicalGlobalIndexFinalizer,
  diagnostics,
  diagnosticEnvironment,
  lockTimeoutMs,
}) {
  if (!client?.query) throw new Error("V3 run finalization requires PostgreSQL lock client");
  if (!r2 || typeof r2 !== "object") throw new Error("V3 run finalization requires R2 configuration");
  for (const [name, adapter] of Object.entries({
    getObject,
    finalizeCanonicalDayManifests,
    finalizeCanonicalAggregateManifests,
    putIfChanged,
    recordDurableEvidence,
    finalizeV3Publication,
    runDayFinalizer,
    runGlobalFinalizer,
  })) {
    if (typeof adapter !== "function") {
      throw new TypeError(`V3 run finalization adapter is missing: ${name}`);
    }
  }
  const publicationEvidence = collectVerifiedConnectorPublications({
    source,
    connectorPublications,
  });
  const normalizedSource = publicationEvidence.source;
  const connectorResults = publicationEvidence.connector_results;
  const completeDayReplacementResults =
    publicationEvidence.complete_day_replacement_results;
  const canonicalObservationsPrefix = normalizePrefix(
    observationsPrefix,
    "observationsPrefix",
  );

  const affectedDays = [...new Set(connectorResults.map((entry) => entry.day_utc))]
    .sort(bytewiseCompare);
  const dayResults = [];
  for (const dayUtc of affectedDays) {
    const changedConnectors = connectorResults
      .filter((entry) => entry.day_utc === dayUtc)
      .sort((left, right) => left.connector_id - right.connector_id);
    const changedConnectorIds = changedConnectors.map((entry) => entry.connector_id);
    const result = await runDayFinalizer({
      client,
      dayUtc,
      diagnostics,
      diagnosticEnvironment,
      timeoutMs: lockTimeoutMs,
      finalize: async () => {
        const finalized = await finalizeCanonicalDayManifests({
          source: normalizedSource,
          day_utc: dayUtc,
          changed_connectors: Object.freeze(changedConnectors),
        });
        return validateDayCanonicalResult({
          dayUtc,
          changedConnectorIds,
          result: finalized,
          observationsPrefix: canonicalObservationsPrefix,
        });
      },
    });
    dayResults.push(result);
  }

  return await runGlobalFinalizer({
    client,
    diagnostics,
    diagnosticEnvironment,
    timeoutMs: lockTimeoutMs,
    finalize: async () => {
      const partitionResults = connectorResults.flatMap(
        (connectorResult) => connectorResult.partitions,
      );
      const aggregateResult = validateAggregateCanonicalResult({
        affectedDays,
        result: await finalizeCanonicalAggregateManifests({
          source: normalizedSource,
          affected_days_utc: Object.freeze([...affectedDays]),
          day_results: Object.freeze(dayResults),
        }),
      });

      const latestObject = await getObject({ key: latestKey });
      if (!latestObject || latestObject.exists === false) {
        throw new Error(`Post-cutover v3 latest object is missing: ${latestKey}`);
      }
      const existingLatest = latestArtifactFromStoredObject({
        key: latestKey,
        body: latestObject.body,
        latestKey,
      });
      const replacementScopedManifests = partitionResults.map(
        (partition) => partition.scoped_root.artifact,
      );
      const removedScopes = obsoletePruneLatestScopes({
        source: normalizedSource,
        existingLatest,
        connectorResults,
      });
      const updatedLatest = updateObservationHistoryIndexV3Latest({
        existingLatest,
        replacementScopedManifests,
        removedScopes,
        indexRoot,
        latestKey,
      });
      const changedScopedEvidenceByKey = new Map(
        partitionResults.map((partition) => [
          partition.scoped_root.evidence.key,
          partition.scoped_root.evidence,
        ]),
      );
      const latestExternalByKey = new Map();
      for (const reference of updatedLatest.dependencies) {
        const exact = changedScopedEvidenceByKey.get(reference.key);
        if (exact) {
          assertEvidence(exact, reference, "V3 latest scoped prerequisite");
        }
        latestExternalByKey.set(
          reference.key,
          await verifiedExternalReference(reference, getObject),
        );
      }
      const latestPlan = buildObservationHistoryIndexV3PublicationPlan({
        objects: [updatedLatest],
        externalReferences: [...latestExternalByKey.values()],
      });
      const latestPublication = await finalizeV3Publication({
        plan: latestPlan,
        putIfChanged,
        getObject,
        recordDurableEvidence,
      });
      return Object.freeze({
        ok: connectorResults.every((entry) =>
          entry.v3_exact_publication?.ok === true
        ) && latestPublication.ok === true,
        status: latestPublication.status,
        source: normalizedSource,
        prune_eligibility_owner:
          normalizedSource === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
        complete_day_replacement_results: Object.freeze(
          completeDayReplacementResults,
        ),
        removed_scopes: removedScopes,
        affected_partition_count: partitionResults.length,
        affected_connector_days: Object.freeze(connectorResults.map((entry) => ({
          day_utc: entry.day_utc,
          connector_id: entry.connector_id,
        }))),
        affected_days_utc: Object.freeze([...affectedDays]),
        connector_results: Object.freeze(connectorResults),
        day_results: Object.freeze(dayResults),
        canonical_aggregate_result: aggregateResult,
        v3_publication: Object.freeze({
          exact_scopes: Object.freeze(connectorResults.map((entry) =>
            entry.v3_exact_publication
          )),
          latest_global: latestPublication,
        }),
      });
    },
  });
}

/**
 * The one post-cutover run-level publication path for Prune, Integrity, SOS and
 * supported backfills. It composes bounded connector publication with one
 * coordinated exact-day, aggregate and latest/global finalization.
 */
export async function runObservationHistoryV3SteadyStateWriter(options) {
  const connectorPublication = await runObservationHistoryV3ConnectorPublication(
    options,
  );
  return await runObservationHistoryV3RunFinalization({
    ...options,
    connectorPublications: [connectorPublication.run_finalization_evidence],
  });
}

// Named, fixed-authority adapters are the Phase 6 import surface. They avoid a
// runtime writer-generation selector and prevent each caller from reimplementing
// target construction or v3 publication semantics.
export function runPruneDailyObservationHistoryV3ConnectorPublication(options) {
  return runObservationHistoryV3ConnectorPublication({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
  });
}

export function runPruneDailyObservationHistoryV3RunFinalization(options) {
  return runObservationHistoryV3RunFinalization({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
  });
}

export function runPruneDailyObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStateWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
  });
}

export function runIntegrityObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStateWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
  });
}

export function runSosHistoricalReplacementObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStateWriter({
    ...options,
    source:
      OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
  });
}

export function runSupportedBackfillObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStateWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.supportedBackfill,
  });
}
