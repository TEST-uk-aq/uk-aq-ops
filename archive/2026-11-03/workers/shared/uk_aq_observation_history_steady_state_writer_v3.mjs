import { getObservationHistoryGeneration, assertObservationHistoryGenerationPrefixes } from "./uk_aq_observation_history_generation.mjs";
// @ts-nocheck -- post-cutover-only Node writer shared by every canonical source.
import { Buffer } from "node:buffer";

import {
  buildObservationHistoryIndexV3PublicationPlan,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  updateObservationHistoryExactLeafIndexV3Latest,
} from "./uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  MAX_OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONCURRENCY,
} from "./uk_aq_observation_history_index_v3.mjs";
import {
  OBSERVATION_HISTORY_V3_INDEX_ROOT,
} from "./uk_aq_observation_history_reader_v3.mjs";
import {
  buildCanonicalObservationTimeseriesAlignedFiles,
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
  observationsGlobalOperationLockIdentity,
  requireObservationsGlobalOperationLockContext,
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
  "history/v3/observations";
export const DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_LATEST_KEY =
  "history/_index_v3/observations_timeseries_latest.json";
// Eight overlaps the small exact-v3 JSON request pipelines without coupling
// steady-state fan-out to the migration runner's separately bounded scheduler.
export const DEFAULT_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY = 8;
export const MAX_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY =
  MAX_OBSERVATION_HISTORY_INDEX_V3_PUBLICATION_CONCURRENCY;
export const MAX_PRUNE_V3_RUN_LOCAL_REFERENCE_EVIDENCE_ENTRIES = 16_384;

export const OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES = Object.freeze({
  pruneDaily: "prune_daily",
  integrity: "integrity",
  sosHistoricalReplacement: "sos_historical_replacement",
  supportedBackfill: "supported_backfill",
  selectedScopeReconciliation: "selected_scope_reconciliation",
});

const SELECTED_SCOPE_REMOVAL_AUTHORITY = Symbol(
  "uk_aq_observation_history_selected_scope_removal_authority",
);

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

function normalizeObservationScope(scope, fieldName) {
  const dayUtc = String(scope?.day_utc || "").trim();
  const parsedDay = new Date(`${dayUtc}T00:00:00.000Z`);
  const connectorId = Number(scope?.connector_id);
  const pollutantCode = String(scope?.pollutant_code || "").trim().toLowerCase();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) ||
    Number.isNaN(parsedDay.getTime()) ||
    parsedDay.toISOString().slice(0, 10) !== dayUtc
  ) {
    throw new TypeError(`${fieldName}.day_utc must be a canonical UTC day`);
  }
  if (!Number.isSafeInteger(connectorId) || connectorId <= 0) {
    throw new TypeError(`${fieldName}.connector_id must be a positive safe integer`);
  }
  if (!/^[a-z0-9_]+$/.test(pollutantCode)) {
    throw new TypeError(`${fieldName}.pollutant_code is invalid`);
  }
  return Object.freeze({
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
  });
}

function normalizeRemovedScopes(removedScopes) {
  if (removedScopes === undefined || removedScopes === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(removedScopes)) {
    throw new TypeError("removedScopes must be an array");
  }
  const seen = new Set();
  const normalized = removedScopes.map((scope, index) => {
    const value = normalizeObservationScope(scope, `removedScopes[${index}]`);
    const identity = scopeIdentity(value);
    if (seen.has(identity)) {
      throw new Error(
        `V3 steady-state writer received duplicate removal scope: ${identity.replaceAll("\u0000", "/")}`,
      );
    }
    seen.add(identity);
    return value;
  });
  normalized.sort((left, right) =>
    bytewiseCompare(left.day_utc, right.day_utc) ||
    left.connector_id - right.connector_id ||
    bytewiseCompare(left.pollutant_code, right.pollutant_code)
  );
  return Object.freeze(normalized);
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

function isPhaseBHistoryBudgetError(error) {
  return error?.name === "PhaseBHistoryBudgetExhaustedError" ||
    error?.code === "PHASE_B_HISTORY_BUDGET_EXHAUSTED";
}

function isPruneGlobalLockContext(context) {
  if (
    context?.valid !== true || context.owner !== "prune_daily" ||
    !String(context.run_id || "").trim() || !String(context.nonce || "").trim()
  ) {
    return false;
  }
  const identity = observationsGlobalOperationLockIdentity();
  return context.logical_identity === identity.logical_identity &&
    Number(context.class_id) === identity.class_id &&
    Number(context.object_id) === identity.object_id;
}

/**
 * Compact evidence for exact scoped roots, bound to one supervised Prune run.
 * The outer lock supervisor terminates the worker if the retained lock session
 * is lost, so this process-local object cannot survive a lock handoff/restart.
 */
export function createPruneDailyObservationHistoryV3RunLocalEvidenceCache({
  lockContext,
} = {}) {
  if (!isPruneGlobalLockContext(lockContext)) return null;

  const entries = new Map();
  let eligibleKeys = new Set();
  let active = true;
  let pendingInvalidations = 0;
  const lockIdentity = Object.freeze({
    owner: lockContext.owner,
    run_id: lockContext.run_id,
    nonce: lockContext.nonce,
    logical_identity: lockContext.logical_identity,
    class_id: Number(lockContext.class_id),
    object_id: Number(lockContext.object_id),
  });

  const cache = {
    matches(context) {
      return active && isPruneGlobalLockContext(context) &&
        context.owner === lockIdentity.owner &&
        context.run_id === lockIdentity.run_id &&
        context.nonce === lockIdentity.nonce &&
        context.logical_identity === lockIdentity.logical_identity &&
        Number(context.class_id) === lockIdentity.class_id &&
        Number(context.object_id) === lockIdentity.object_id;
    },
    getVerified(reference) {
      if (!active) return null;
      const key = typeof reference?.key === "string" ? reference.key : "";
      const existing = entries.get(key);
      if (!existing) return null;
      if (
        !eligibleKeys.has(key) ||
        existing.key !== key ||
        existing.byte_size !== reference?.byte_size ||
        existing.sha256 !== reference?.sha256
      ) {
        entries.delete(key);
        eligibleKeys.delete(key);
        pendingInvalidations += 1;
        return null;
      }
      return existing;
    },
    remember(reference, evidence) {
      if (!active) return false;
      const exact = assertEvidence(evidence, reference, "Prune run-local v3 dependency");
      const prior = entries.get(exact.key);
      if (prior && (
        prior.byte_size !== exact.byte_size || prior.sha256 !== exact.sha256
      )) {
        entries.delete(exact.key);
        eligibleKeys.delete(exact.key);
        pendingInvalidations += 1;
      }
      if (!entries.has(exact.key) &&
          entries.size >= MAX_PRUNE_V3_RUN_LOCAL_REFERENCE_EVIDENCE_ENTRIES) {
        return false;
      }
      entries.set(exact.key, exact);
      return true;
    },
    invalidateKey(keyValue) {
      if (!active) return false;
      const key = typeof keyValue === "string" ? keyValue : "";
      if (!key || !entries.has(key)) return false;
      entries.delete(key);
      eligibleKeys.delete(key);
      pendingInvalidations += 1;
      return true;
    },
    recordFinalizedDependencies(references) {
      if (!active || !Array.isArray(references)) return;
      const currentByKey = new Map(references.map((reference) => [reference.key, reference]));
      const nextEligibleKeys = new Set();
      for (const [key, evidence] of entries) {
        const current = currentByKey.get(key);
        if (
          !current || current.byte_size !== evidence.byte_size ||
          current.sha256 !== evidence.sha256
        ) {
          entries.delete(key);
          if (eligibleKeys.has(key)) pendingInvalidations += 1;
          continue;
        }
        nextEligibleKeys.add(key);
      }
      eligibleKeys = nextEligibleKeys;
    },
    takeInvalidationCount() {
      const count = pendingInvalidations;
      pendingInvalidations = 0;
      return count;
    },
    entryCount() {
      return active ? entries.size : 0;
    },
    clear() {
      active = false;
      entries.clear();
      eligibleKeys.clear();
      pendingInvalidations = 0;
    },
  };
  return Object.freeze(cache);
}

async function verifiedExternalReference(reference, getObject, {
  onGetStarted = null,
  onGetFinished = null,
} = {}) {
  let requestCounted = false;
  const markGetStarted = () => {
    if (requestCounted) return;
    requestCounted = true;
    onGetStarted?.();
  };
  let object;
  try {
    object = await getObject({
      key: reference.key,
      onR2GetAdmitted: markGetStarted,
    });
    // Test/custom adapters may not consume the admission callback. A returned
    // object still proves that an origin GET was issued.
    markGetStarted();
  } catch (error) {
    // Phase B invokes this callback only after its request-level budget check.
    // A budget rejection is therefore not counted as an R2 GET.
    if (!requestCounted && !isPhaseBHistoryBudgetError(error)) markGetStarted();
    throw error;
  } finally {
    if (requestCounted) onGetFinished?.();
  }
  if (!object || object.exists === false || object.body === null || object.body === undefined) {
    throw new Error(`V3 external publication reference is missing: ${reference.key}`);
  }
  const body = exactBuffer(object.body, reference.key);
  if (body.byteLength !== reference.byte_size || sha256Hex(body) !== reference.sha256) {
    const error = new Error(
      `V3 external publication reference identity changed: ${reference.key}`,
    );
    error.code = "V3_EXTERNAL_REFERENCE_IDENTITY_CHANGED";
    error.actual_reference = Object.freeze({
      key: reference.key,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
    });
    error.actual_body = body;
    throw error;
  }
  return Object.freeze({
    key: reference.key,
    byte_size: reference.byte_size,
    sha256: reference.sha256,
    verified: true,
    durable: true,
  });
}

async function verifyExternalReferencesBounded({
  references,
  getObject,
  evidenceCache = null,
  reuseEvidence = true,
  freshKeys = new Set(),
  onFailureBatch = null,
}) {
  const concurrency = Math.min(
    DEFAULT_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY,
    8,
  );
  const metrics = {
    dependency_count: references.length,
    actual_r2_get_count: 0,
    accepted_evidence_reuse_count: 0,
    maximum_active_verification_requests: 0,
    _active_verification_requests: 0,
  };
  const evidenceByKey = new Map();
  const failures = [];
  let failureFromBatchHandler = null;
  let batchHandlerFailed = false;

  for (let offset = 0; offset < references.length; offset += concurrency) {
    const batch = references.slice(offset, offset + concurrency);
    const batchFailures = [];
    const batchResults = await Promise.all(batch.map(async (reference, batchIndex) => {
      const position = offset + batchIndex;
      try {
        if (freshKeys.has(reference.key)) {
          evidenceCache?.invalidateKey(reference.key);
        }
        if (reuseEvidence && evidenceCache && !freshKeys.has(reference.key)) {
          const cached = evidenceCache.getVerified(reference);
          if (cached) {
            metrics.accepted_evidence_reuse_count += 1;
            return { position, reference, evidence: cached };
          }
        }
        let active = false;
        const evidence = await verifiedExternalReference(reference, getObject, {
          onGetStarted: () => {
            active = true;
            metrics.actual_r2_get_count += 1;
            const currentActive = ++metrics._active_verification_requests;
            metrics.maximum_active_verification_requests = Math.max(
              metrics.maximum_active_verification_requests,
              currentActive,
            );
          },
          onGetFinished: () => {
            if (!active) return;
            metrics._active_verification_requests -= 1;
            active = false;
          },
        });
        evidenceCache?.remember(reference, evidence);
        return { position, reference, evidence };
      } catch (error) {
        return { position, reference, failed: true, error };
      }
    }));

    batchResults.sort((left, right) => left.position - right.position);
    for (const result of batchResults) {
      if (result.failed === true) {
        batchFailures.push({
          position: result.position,
          reference: result.reference,
          error: result.error,
        });
      } else {
        evidenceByKey.set(result.reference.key, result.evidence);
      }
    }
    if (batchFailures.length === 0) continue;
    if (typeof onFailureBatch === "function") {
      let handled;
      try {
        handled = await onFailureBatch(Object.freeze(batchFailures));
      } catch (error) {
        failureFromBatchHandler = error;
        batchHandlerFailed = true;
      }
      if (handled === true) continue;
    }
    failures.push(...batchFailures);
    break;
  }
  delete metrics._active_verification_requests;
  return Object.freeze({
    evidence_by_key: evidenceByKey,
    metrics: Object.freeze(metrics),
    failures: Object.freeze(failures),
    has_failure: batchHandlerFailed || failures.length > 0,
    failure: batchHandlerFailed ? failureFromBatchHandler : failures[0]?.error,
  });
}

/**
 * Pure preparation for one complete canonical day/connector/pollutant scope.
 * Migration and supported steady-state adapters share the same target writer
 * and exact-leaf hierarchy builder through this preparation boundary.
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
  assertObservationHistoryGenerationPrefixes(getObservationHistoryGeneration("v3"), { observationsPrefix, indexRoot });
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
  const target = buildCanonicalObservationTimeseriesAlignedFiles(rows, {
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
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
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
  if (partitions === undefined || partitions === null) return [];
  if (!Array.isArray(partitions)) {
    throw new TypeError("V3 steady-state writer partitions must be an array");
  }
  return partitions.map((partition, index) => {
    if (Array.isArray(partition)) {
      if (partition.length === 0) {
        throw new TypeError(`V3 steady-state writer partition ${index} must be non-empty`);
      }
      return { rows: partition, scope: null, backed_up_at_utc: undefined };
    }
    if (!partition || typeof partition !== "object" || !Array.isArray(partition.rows)) {
      throw new TypeError(`V3 steady-state writer partition ${index} requires rows`);
    }
    if (partition.rows.length === 0) {
      throw new TypeError(`V3 steady-state writer partition ${index} must be non-empty`);
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
  diagnosticLog,
}) {
  const prepared = [];
  for (const partition of normalizePartitionInputs(partitions)) {
    const firstRow = partition.rows?.[0] || null;
    const scope = partition.scope || (firstRow ? {
      day_utc: firstRow.day_utc || String(firstRow.observed_at_utc || "").slice(0, 10),
      connector_id: firstRow.connector_id,
      pollutant_code: firstRow.pollutant_code,
    } : null);
    emitV3PublicationDiagnostic(diagnosticLog, "partition_prepare_start", {
      scope,
      row_count: partition.rows.length,
    });
    const startedAtMs = Date.now();
    let built;
    try {
      built = buildObservationHistoryV3SteadyStatePartition({
        source,
        rows: partition.rows,
        scope: partition.scope,
        writerLimits,
        targetWriterGitSha,
        backedUpAtUtc: partition.backed_up_at_utc ?? backedUpAtUtc,
        observationsPrefix,
        indexRoot,
      });
    } catch (error) {
      emitV3PublicationDiagnostic(diagnosticLog, "partition_prepare_failed", {
        scope,
        row_count: partition.rows.length,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    emitV3PublicationDiagnostic(diagnosticLog, "partition_prepare_complete", {
      scope: built.scope,
      row_count: built.target_metadata.row_count,
      file_count: built.file_intents.length,
      total_bytes: built.file_intents.reduce((sum, intent) => sum + intent.byte_size, 0),
      duration_ms: Math.max(0, Date.now() - startedAtMs),
    });
    prepared.push(built);
  }
  return validatePreparedPartitions(prepared.sort((left, right) =>
    bytewiseCompare(left.scope.day_utc, right.scope.day_utc) ||
    left.scope.connector_id - right.scope.connector_id ||
    bytewiseCompare(left.scope.pollutant_code, right.scope.pollutant_code)
  ));
}

function emitV3PublicationDiagnostic(diagnosticLog, event, fields = {}) {
  if (typeof diagnosticLog !== "function") return;
  try {
    diagnosticLog(event, fields);
  } catch {
    // Diagnostics must never change publication semantics.
  }
}

function assertV3PublicationStageBudget(beforePublicationStage, stage, fields) {
  if (typeof beforePublicationStage !== "function") return;
  beforePublicationStage({ stage, ...fields });
}

function validatePreparedPartitions(prepared) {
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

function assertReplacementRemovalDisjoint(prepared, removedScopes) {
  const replacements = new Set(prepared.map((partition) => scopeIdentity(partition.scope)));
  for (const scope of removedScopes) {
    const identity = scopeIdentity(scope);
    if (replacements.has(identity)) {
      throw new Error(
        `V3 steady-state writer scope cannot be both replaced and removed: ${identity.replaceAll("\u0000", "/")}`,
      );
    }
  }
}

function groupPreparedByConnectorDay(prepared, removedScopes = []) {
  const groups = new Map();
  for (const partition of prepared) {
    const identity = connectorDayIdentity(partition.scope);
    const existing = groups.get(identity) || {
      day_utc: partition.scope.day_utc,
      connector_id: partition.scope.connector_id,
      partitions: [],
      removed_scopes: [],
    };
    existing.partitions.push(partition);
    groups.set(identity, existing);
  }
  for (const scope of removedScopes) {
    const identity = connectorDayIdentity(scope);
    const existing = groups.get(identity) || {
      day_utc: scope.day_utc,
      connector_id: scope.connector_id,
      partitions: [],
      removed_scopes: [],
    };
    existing.removed_scopes.push(scope);
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
  const changedPollutants = [...group.partitions]
    .map((partition) => partition.scope.pollutant_code)
    .sort(bytewiseCompare);
  const requestedRemovalScopes = [...group.removed_scopes].sort((left, right) =>
    bytewiseCompare(left.pollutant_code, right.pollutant_code)
  );
  const requestedRemovalPollutants = requestedRemovalScopes.map(
    (scope) => scope.pollutant_code,
  );
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
  const selectedScopeReconciliation =
    source === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation;
  if (
    selectedScopeReconciliation &&
    result.current_day_authority_checked !== true
  ) {
    throw new Error(
      `Canonical connector finalizer did not verify current day authority: ${group.day_utc}/${group.connector_id}`,
    );
  }
  const changedPollutantSet = new Set(changedPollutants);
  const requestedRemovalSet = new Set(requestedRemovalPollutants);
  const mergedPollutants = [...new Set([...currentPollutants, ...changedPollutants])]
    .sort(bytewiseCompare);
  const expectedFinalPollutants = completeConnectorSnapshot
    ? [...changedPollutants]
    : selectedScopeReconciliation
      ? mergedPollutants.filter((pollutantCode) =>
        !requestedRemovalSet.has(pollutantCode)
      )
      : mergedPollutants;
  const expectedRemovedPollutants = completeConnectorSnapshot
    ? currentPollutants.filter((pollutantCode) =>
      !changedPollutantSet.has(pollutantCode)
    )
    : selectedScopeReconciliation
      ? requestedRemovalPollutants
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
        : selectedScopeReconciliation
          ? `Canonical connector finalizer did not apply the selected-scope delta: ${group.day_utc}/${group.connector_id}`
          : `Canonical connector finalizer did not preserve the current pollutant union: ${group.day_utc}/${group.connector_id}`,
    );
  }
  if (!sameArray(removedPollutants, expectedRemovedPollutants)) {
    throw new Error(
      `Canonical connector finalizer removed-pollutant evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  const removedScopes = Array.isArray(result.removed_scopes)
    ? result.removed_scopes.map((scope, index) =>
      normalizeObservationScope(scope, `result.removed_scopes[${index}]`)
    )
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
  const expectedRemovalResults = selectedScopeReconciliation
    ? requestedRemovalScopes.map((scope) => Object.freeze({
      ...scope,
      requested_removal: true,
      previously_authoritative: currentPollutants.includes(scope.pollutant_code),
      final_scope_present: false,
    }))
    : [];
  const removalResults = Array.isArray(result.removal_results)
    ? result.removal_results.map((entry, index) => {
      const scope = normalizeObservationScope(
        entry,
        `result.removal_results[${index}]`,
      );
      return Object.freeze({
        ...scope,
        requested_removal: entry.requested_removal === true,
        previously_authoritative: entry.previously_authoritative === true,
        final_scope_present: entry.final_scope_present === true,
      });
    })
    : [];
  if (JSON.stringify(removalResults) !== JSON.stringify(expectedRemovalResults)) {
    throw new Error(
      `Canonical connector finalizer removal evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  const connectorAuthorityPresent = finalPollutants.length > 0;
  if (
    result.connector_authority_present !== undefined &&
    result.connector_authority_present !== connectorAuthorityPresent
  ) {
    throw new Error(
      `Canonical connector finalizer presence evidence disagrees: ${group.day_utc}/${group.connector_id}`,
    );
  }
  let connectorManifest = null;
  if (connectorAuthorityPresent) {
    connectorManifest = assertDurableEvidence(
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
    if (!result.connector_manifest_payload) {
      throw new Error(
        `Canonical connector manifest payload is missing: ${group.day_utc}/${group.connector_id}`,
      );
    }
  } else if (
    result.connector_manifest !== null || result.connector_manifest_payload !== null
  ) {
    throw new Error(
      `Canonical connector finalizer must not publish an empty connector manifest: ${group.day_utc}/${group.connector_id}`,
    );
  }
  return Object.freeze({
    day_utc: group.day_utc,
    connector_id: group.connector_id,
    current_child_validation_mode:
      result.current_child_validation_mode ?? null,
    current_day_authority_checked:
      result.current_day_authority_checked === true,
    connector_manifest: connectorManifest,
    connector_manifest_payload: result.connector_manifest_payload ?? null,
    connector_authority_present: connectorAuthorityPresent,
    current_pollutant_codes: Object.freeze(currentPollutants),
    changed_pollutant_codes: Object.freeze(reportedChanged),
    final_pollutant_codes: Object.freeze(finalPollutants),
    removed_pollutant_codes: Object.freeze(removedPollutants),
    removed_scopes: Object.freeze(removedScopes.map((scope) =>
      Object.freeze({ ...scope })
    )),
    removal_results: Object.freeze(removalResults),
    pollutant_manifests: Object.freeze(pollutantManifests),
    connector_scope_verified: true,
    parent_state_reread_under_lock: true,
  });
}

function validateDayCanonicalResult({
  dayUtc,
  changedConnectors,
  result,
  observationsPrefix,
}) {
  const changedConnectorIds = changedConnectors.map((entry) => entry.connector_id);
  const absentChangedConnectorIds = changedConnectors
    .filter((entry) => entry.canonical.connector_authority_present === false)
    .map((entry) => entry.connector_id);
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
  const absentChangedSet = new Set(absentChangedConnectorIds);
  const expectedFinal = [...new Set([...current, ...changedConnectorIds])]
    .filter((connectorId) => !absentChangedSet.has(connectorId))
    .sort((left, right) => left - right);
  if (!sameArray(finalIds, expectedFinal)) {
    throw new Error(`Canonical day finalizer did not apply the changed connector set: ${dayUtc}`);
  }
  const dayManifest = assertDurableEvidence(result.day_manifest, "Canonical day manifest");
  if (dayManifest.key !== buildHistoryV2DayManifestKey(observationsPrefix, dayUtc)) {
    throw new Error(`Canonical day manifest key disagrees: ${dayUtc}`);
  }
  return Object.freeze({
    day_utc: dayUtc,
    changed_connector_ids: Object.freeze([...changedConnectorIds]),
    absent_changed_connector_ids: Object.freeze([...absentChangedConnectorIds]),
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
  publicationConcurrency,
  onProgress,
}) {
  const exactObjects = partitions.flatMap((partition) =>
    partition.v3_hierarchy.publication_objects
  );
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
    publicationConcurrency,
    onProgress,
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
  removedScopes,
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
  diagnosticLog,
  beforePublicationStage,
  lockTimeoutMs,
  prepareCompleteDayReplacement = null,
  exactV3PublicationConcurrency =
    DEFAULT_OBSERVATION_HISTORY_EXACT_V3_PUBLICATION_CONCURRENCY,
  selectedScopeRemovalAuthority = null,
}) {
  assertObservationHistoryGenerationPrefixes(getObservationHistoryGeneration("v3"), { observationsPrefix, indexRoot, latestKey });
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
  assertObservationHistoryGenerationPrefixes(getObservationHistoryGeneration("v3"), { observationsPrefix, indexRoot });
  const normalizedSource = normalizeSource(source);
  const normalizedRemovedScopes = normalizeRemovedScopes(removedScopes);
  const selectedScopeReconciliation = normalizedSource ===
    OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation;
  if (
    selectedScopeReconciliation &&
    selectedScopeRemovalAuthority !== SELECTED_SCOPE_REMOVAL_AUTHORITY
  ) {
    throw new Error(
      "Selected-scope reconciliation is available only through its fixed-authority adapter",
    );
  }
  if (!selectedScopeReconciliation && normalizedRemovedScopes.length > 0) {
    throw new Error(
      `Observation-history source ${normalizedSource} is not authorised for selected-scope removal`,
    );
  }
  const normalizedPartitionInputs = normalizePartitionInputs(partitions);
  if (normalizedPartitionInputs.length === 0 && normalizedRemovedScopes.length === 0) {
    throw new TypeError(
      "V3 steady-state writer requires at least one non-empty replacement partition or explicit removal scope",
    );
  }
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
    partitions: normalizedPartitionInputs,
    writerLimits,
    targetWriterGitSha,
    backedUpAtUtc,
    observationsPrefix,
    indexRoot,
    diagnosticLog,
  });
  assertReplacementRemovalDisjoint(prepared, normalizedRemovedScopes);
  const canonicalObservationsPrefix = normalizePrefix(
    observationsPrefix,
    "observationsPrefix",
  );
  const connectorGroups = groupPreparedByConnectorDay(
    prepared,
    normalizedRemovedScopes,
  );
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
      const canonicalFields = {
        publication_stage: "canonical_connector_publication",
        day_utc: group.day_utc,
        connector_id: group.connector_id,
        pollutant_count: partitionResults.length,
        affected_object_count: partitionResults.length + 1,
      };
      assertV3PublicationStageBudget(
        beforePublicationStage,
        "canonical_connector_publication",
        canonicalFields,
      );
      emitV3PublicationDiagnostic(diagnosticLog, "canonical_connector_publication_start", canonicalFields);
      const canonicalStartedAtMs = Date.now();
      let canonicalResult;
      let canonical;
      try {
        canonicalResult = await publishConnectorScopedCanonicalManifests({
          source: normalizedSource,
          day_utc: group.day_utc,
          connector_id: group.connector_id,
          partitions: Object.freeze(partitionResults),
          removed_scopes: Object.freeze([...group.removed_scopes]),
        });
        canonical = validateConnectorCanonicalResult({
          group,
          result: canonicalResult,
          observationsPrefix: canonicalObservationsPrefix,
          source: normalizedSource,
        });
        emitV3PublicationDiagnostic(diagnosticLog, "canonical_connector_publication_complete", {
          ...canonicalFields,
          current_child_validation_mode:
            canonical.current_child_validation_mode,
          duration_ms: Math.max(0, Date.now() - canonicalStartedAtMs),
        });
      } catch (error) {
        emitV3PublicationDiagnostic(diagnosticLog, "canonical_connector_publication_failed", {
          ...canonicalFields,
          duration_ms: Math.max(0, Date.now() - canonicalStartedAtMs),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const exactFields = {
        publication_stage: "exact_v3_connector_publication",
        day_utc: group.day_utc,
        connector_id: group.connector_id,
        pollutant_count: partitionResults.length,
        affected_object_count: partitionResults.reduce(
          (sum, partition) => sum + partition.v3_hierarchy.publication_objects.length,
          0,
        ),
        configured_concurrency: exactV3PublicationConcurrency,
      };
      assertV3PublicationStageBudget(
        beforePublicationStage,
        "exact_v3_connector_publication",
        exactFields,
      );
      emitV3PublicationDiagnostic(diagnosticLog, "exact_v3_connector_publication_start", exactFields);
      const exactStartedAtMs = Date.now();
      let exact;
      let exactProgress = null;
      let lastLoggedProgress = 0;
      try {
        exact = partitionResults.length === 0
          ? Object.freeze({
            publication: Object.freeze({
              ok: true,
              status: "no_replacement_scopes",
              objects: Object.freeze([]),
            }),
            scoped_roots: Object.freeze([]),
          })
          : await publishConnectorExactV3Scopes({
            partitions: partitionResults,
            canonical,
            getObject,
            putIfChanged,
            recordDurableEvidence,
            finalizeV3Publication,
            publicationConcurrency: exactV3PublicationConcurrency,
            onProgress: (progress) => {
              exactProgress = progress;
              if (
                progress?.status === "running" &&
                progress.completed_object_count > 0 &&
                progress.completed_object_count % 100 === 0 &&
                progress.completed_object_count !== lastLoggedProgress
              ) {
                lastLoggedProgress = progress.completed_object_count;
                emitV3PublicationDiagnostic(
                  diagnosticLog,
                  "exact_v3_connector_publication_progress",
                  {
                    ...exactFields,
                    completed: progress.completed_object_count,
                    total: progress.total_object_count,
                    active: progress.active_publication_count,
                    ready: progress.ready_object_count,
                    blocked: progress.blocked_object_count,
                    maximum_active_publications:
                      progress.maximum_active_publications,
                    reused_object_count: progress.reused_object_count,
                    newly_written_object_count:
                      progress.newly_written_object_count,
                    elapsed_ms: progress.elapsed_ms,
                  },
                );
              }
            },
          });
      } catch (error) {
        emitV3PublicationDiagnostic(diagnosticLog, "exact_v3_connector_publication_failed", {
          ...exactFields,
          ...(exactProgress || {}),
          duration_ms: Math.max(0, Date.now() - exactStartedAtMs),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      emitV3PublicationDiagnostic(diagnosticLog, "exact_v3_connector_publication_complete", {
        ...exactFields,
        ...(exact.publication.publication_diagnostics || {}),
        duration_ms: Math.max(0, Date.now() - exactStartedAtMs),
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
        removal_results: canonical.removal_results,
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
        (normalizedSource ===
          OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation &&
          result?.canonical?.current_day_authority_checked !== true) ||
        result?.v3_exact_publication?.ok !== true ||
        !Array.isArray(result?.partitions) ||
        (normalizedSource ===
          OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation &&
          !Array.isArray(result?.canonical?.removal_results)) ||
        (result.partitions.length === 0 &&
          (!Array.isArray(result?.canonical?.removal_results) ||
            result.canonical.removal_results.length === 0)) ||
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
          connector_authority_present:
            result.canonical.connector_authority_present,
          current_day_authority_checked:
            result.canonical.current_day_authority_checked,
          current_pollutant_codes:
            result.canonical.current_pollutant_codes,
          changed_pollutant_codes:
            result.canonical.changed_pollutant_codes,
          final_pollutant_codes:
            result.canonical.final_pollutant_codes,
          removed_pollutant_codes:
            result.canonical.removed_pollutant_codes,
          removed_scopes: result.canonical.removed_scopes,
          removal_results: result.canonical.removal_results ?? Object.freeze([]),
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
  diagnosticLog,
  beforePublicationStage,
  lockTimeoutMs,
  recoverLatestScopedReference = null,
  selectedScopeRemovalAuthority = null,
  runLocalReferenceEvidenceCache = null,
  globalOperationLockContext = null,
}) {
  assertObservationHistoryGenerationPrefixes(getObservationHistoryGeneration("v3"), { observationsPrefix, indexRoot, latestKey });
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
  const runEvidenceCache = normalizedSource ===
      OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily &&
      runLocalReferenceEvidenceCache?.matches?.(globalOperationLockContext) === true
    ? runLocalReferenceEvidenceCache
    : null;
  if (
    normalizedSource ===
      OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation &&
    selectedScopeRemovalAuthority !== SELECTED_SCOPE_REMOVAL_AUTHORITY
  ) {
    throw new Error(
      "Selected-scope reconciliation finalization is available only through its fixed-authority adapter",
    );
  }
  const connectorResults = publicationEvidence.connector_results;
  const completeDayReplacementResults =
    publicationEvidence.complete_day_replacement_results;
  const canonicalObservationsPrefix = normalizePrefix(
    observationsPrefix,
    "observationsPrefix",
  );

  const affectedDays = [...new Set(connectorResults.map((entry) => entry.day_utc))]
    .sort(bytewiseCompare);
  const partitionResults = connectorResults.flatMap(
    (connectorResult) => connectorResult.partitions,
  );
  const runFields = {
    affected_days_utc: Object.freeze([...affectedDays]),
    connector_count: connectorResults.length,
    affected_reference_count: partitionResults.length,
  };
  const runStartedAtMs = Date.now();
  const dayResults = [];
  const finalizationMetrics = {
    latest_global_dependency_count: 0,
    latest_global_dependency_r2_get_count: 0,
    accepted_same_run_evidence_reuse_count: 0,
    recovered_scoped_reference_count: 0,
    evidence_invalidation_count: runEvidenceCache?.takeInvalidationCount?.() || 0,
    maximum_active_verification_requests: 0,
  };
  const absorbVerificationMetrics = (metrics = {}) => {
    finalizationMetrics.latest_global_dependency_count = metrics.dependency_count || 0;
    finalizationMetrics.latest_global_dependency_r2_get_count += metrics.actual_r2_get_count || 0;
    finalizationMetrics.accepted_same_run_evidence_reuse_count =
      finalizationMetrics.accepted_same_run_evidence_reuse_count +
      (metrics.accepted_evidence_reuse_count || 0);
    finalizationMetrics.maximum_active_verification_requests =
      Math.max(
        finalizationMetrics.maximum_active_verification_requests,
        metrics.maximum_active_verification_requests || 0,
      );
  };
  const collectEvidenceInvalidations = () => {
    finalizationMetrics.evidence_invalidation_count +=
      runEvidenceCache?.takeInvalidationCount?.() || 0;
    return finalizationMetrics.evidence_invalidation_count;
  };
  const failureOutcome = (error) => isPhaseBHistoryBudgetError(error)
    ? "budget_stop"
    : "failed_closed";
  try {
    assertV3PublicationStageBudget(
      beforePublicationStage,
      "run_finalization",
      runFields,
    );
    emitV3PublicationDiagnostic(diagnosticLog, "run_finalization_start", runFields);
    for (const dayUtc of affectedDays) {
      const changedConnectors = connectorResults
        .filter((entry) => entry.day_utc === dayUtc)
        .sort((left, right) => left.connector_id - right.connector_id);
      const changedConnectorIds = changedConnectors.map((entry) => entry.connector_id);
      const dayFields = {
        day_utc: dayUtc,
        connector_count: changedConnectors.length,
        affected_reference_count: changedConnectors.reduce(
          (sum, entry) => sum + entry.partitions.length,
          0,
        ),
      };
      const dayStartedAtMs = Date.now();
      let result;
      try {
        assertV3PublicationStageBudget(
          beforePublicationStage,
          "canonical_day_finalization",
          dayFields,
        );
        emitV3PublicationDiagnostic(
          diagnosticLog,
          "canonical_day_finalization_start",
          dayFields,
        );
        result = await runDayFinalizer({
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
              changedConnectors,
              result: finalized,
              observationsPrefix: canonicalObservationsPrefix,
            });
          },
        });
        emitV3PublicationDiagnostic(
          diagnosticLog,
          "canonical_day_finalization_complete",
          {
            ...dayFields,
            duration_ms: Math.max(0, Date.now() - dayStartedAtMs),
          },
        );
      } catch (error) {
        emitV3PublicationDiagnostic(
          diagnosticLog,
          "canonical_day_finalization_failed",
          {
            ...dayFields,
            duration_ms: Math.max(0, Date.now() - dayStartedAtMs),
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
      dayResults.push(result);
    }

    const finalResult = await runGlobalFinalizer({
      client,
      diagnostics,
      diagnosticEnvironment,
      timeoutMs: lockTimeoutMs,
      finalize: async () => {
        const aggregateFields = {
          affected_days_utc: Object.freeze([...affectedDays]),
          connector_count: connectorResults.length,
          affected_reference_count: dayResults.length,
        };
        const aggregateStartedAtMs = Date.now();
        let aggregateResult;
        try {
          assertV3PublicationStageBudget(
            beforePublicationStage,
            "canonical_aggregate_finalization",
            aggregateFields,
          );
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "canonical_aggregate_finalization_start",
            aggregateFields,
          );
          aggregateResult = validateAggregateCanonicalResult({
            affectedDays,
            result: await finalizeCanonicalAggregateManifests({
              source: normalizedSource,
              affected_days_utc: Object.freeze([...affectedDays]),
              day_results: Object.freeze(dayResults),
            }),
          });
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "canonical_aggregate_finalization_complete",
            {
              ...aggregateFields,
              affected_object_count:
                aggregateResult.aggregate_manifests.length,
              duration_ms: Math.max(0, Date.now() - aggregateStartedAtMs),
            },
          );
        } catch (error) {
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "canonical_aggregate_finalization_failed",
            {
              ...aggregateFields,
              duration_ms: Math.max(0, Date.now() - aggregateStartedAtMs),
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }

        const latestFields = {
          affected_days_utc: Object.freeze([...affectedDays]),
          connector_count: connectorResults.length,
          changed_scoped_reference_count: partitionResults.length,
        };
        const latestStartedAtMs = Date.now();
        try {
          assertV3PublicationStageBudget(
            beforePublicationStage,
            "latest_global_exact_v3_finalization",
            latestFields,
          );
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "latest_global_exact_v3_finalization_start",
            latestFields,
          );
          const latestObject = await getObject({ key: latestKey });
          if (!latestObject || latestObject.exists === false) {
            throw new Error(`Post-cutover v3 latest object is missing: ${latestKey}`);
          }
          const existingLatest = latestArtifactFromStoredObject({
            key: latestKey,
            body: latestObject.body,
            latestKey,
          });
          const existingLatestRoots = (
            Array.isArray(existingLatest.payload.day_summaries)
              ? existingLatest.payload.day_summaries
              : []
          ).flatMap((day) =>
            Array.isArray(day?.scoped_roots) ? day.scoped_roots : []
          );
          const existingLatestScopeIdentities = new Set(
            existingLatestRoots.map((root) => scopeIdentity(root)),
          );
          const replacementScopedManifests = partitionResults.map(
            (partition) => partition.scoped_root.artifact,
          );
          const pruneRemovedScopes = obsoletePruneLatestScopes({
            source: normalizedSource,
            existingLatest,
            connectorResults,
          });
          const explicitRemovedScopes = normalizedSource ===
              OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation
            ? connectorResults.flatMap((entry) => entry.canonical.removed_scopes)
            : [];
          const removedScopes = Object.freeze([
            ...pruneRemovedScopes,
            ...explicitRemovedScopes,
          ].sort((left, right) =>
            bytewiseCompare(left.day_utc, right.day_utc) ||
            left.connector_id - right.connector_id ||
            bytewiseCompare(left.pollutant_code, right.pollutant_code)
          ));
          let updatedLatest = updateObservationHistoryExactLeafIndexV3Latest({
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
          const latestReferencesByKey = new Map();
          for (const reference of updatedLatest.dependencies) {
            const prior = latestReferencesByKey.get(reference.key);
            if (prior && (
              prior.byte_size !== reference.byte_size ||
              prior.sha256 !== reference.sha256
            )) {
              throw new Error(
                `Exact-v3 latest dependency identity is ambiguous: ${reference.key}`,
              );
            }
            if (!prior) latestReferencesByKey.set(reference.key, reference);
          }
          const latestReferences = [...latestReferencesByKey.values()];
          finalizationMetrics.latest_global_dependency_count = latestReferences.length;
          const latestExternalByKey = new Map();
          const recoveredScopedManifests = [];
          for (const reference of latestReferences) {
            const exact = changedScopedEvidenceByKey.get(reference.key);
            if (exact) {
              assertEvidence(exact, reference, "V3 latest scoped prerequisite");
            }
          }
          const recoverLatestScopedReferenceFailure = async ({ reference, error }) => {
            const exact = changedScopedEvidenceByKey.get(reference.key);
            if (
              exact ||
              normalizedSource !==
                OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily ||
              error?.code !== "V3_EXTERNAL_REFERENCE_IDENTITY_CHANGED" ||
              typeof recoverLatestScopedReference !== "function"
            ) {
              throw error;
            }
            if (!error.actual_reference || !error.actual_body) throw error;
            const matches = existingLatestRoots.filter((root) =>
              root.key === reference.key
            );
            if (matches.length !== 1) {
              throw new Error(
                `Prune latest-global recovery scope evidence is ambiguous: ${reference.key}`,
              );
            }
            const recovered = await recoverLatestScopedReference({
              source: normalizedSource,
              reference,
              latest_scope: matches[0],
              live_reference: error.actual_reference,
              live_body: error.actual_body,
              observations_prefix: canonicalObservationsPrefix,
              index_root: indexRoot,
            });
            const artifact = recovered?.artifact;
            if (
              !artifact || artifact.key !== reference.key ||
              artifact.sha256 === reference.sha256
            ) {
              throw new Error(
                `Prune latest-global recovery returned invalid replacement: ${reference.key}`,
              );
            }
            const evidence = assertEvidence(
              recovered?.evidence,
              artifact,
              "Prune latest-global recovered scoped prerequisite",
            );
            runEvidenceCache?.invalidateKey(reference.key);
            recoveredScopedManifests.push(artifact);
            latestExternalByKey.set(reference.key, evidence);
            finalizationMetrics.recovered_scoped_reference_count += 1;
            emitV3PublicationDiagnostic(
              diagnosticLog,
              "latest_global_exact_v3_scoped_reference_recovered",
              {
                day_utc: artifact.payload.day_utc,
                connector_id: artifact.payload.connector_id,
                pollutant_code: artifact.payload.pollutant_code,
                key: artifact.key,
                stale_latest_global_sha256: reference.sha256,
                canonically_proven_current_sha256: artifact.sha256,
                recovery_mode: "canonical_authority_same_key_recovery",
                ...(Number.isSafeInteger(recovered.verification_object_count)
                  ? {
                      verification_object_count:
                        recovered.verification_object_count,
                    }
                  : {}),
                ...(Number.isSafeInteger(recovered.verification_concurrency)
                  ? {
                      verification_concurrency:
                        recovered.verification_concurrency,
                    }
                  : {}),
                ...(Number.isSafeInteger(recovered.verification_duration_ms)
                  ? {
                      verification_duration_ms:
                        recovered.verification_duration_ms,
                    }
                  : {}),
              },
            );
          };
          const initialVerification = await verifyExternalReferencesBounded({
            references: latestReferences,
            getObject,
            evidenceCache: runEvidenceCache,
            freshKeys: new Set(changedScopedEvidenceByKey.keys()),
            onFailureBatch: async (batchFailures) => {
              for (const failure of batchFailures) {
                await recoverLatestScopedReferenceFailure(failure);
              }
              return true;
            },
          });
          absorbVerificationMetrics(initialVerification.metrics);
          for (const [key, evidence] of initialVerification.evidence_by_key) {
            latestExternalByKey.set(key, evidence);
          }
          if (initialVerification.has_failure) {
            throw initialVerification.failure;
          }
          if (recoveredScopedManifests.length > 0) {
            const replacementsByKey = new Map(
              replacementScopedManifests.map((artifact) => [artifact.key, artifact]),
            );
            for (const artifact of recoveredScopedManifests) {
              replacementsByKey.set(artifact.key, artifact);
            }
            updatedLatest = updateObservationHistoryExactLeafIndexV3Latest({
              existingLatest,
              replacementScopedManifests: [...replacementsByKey.values()],
              removedScopes,
              indexRoot,
              latestKey,
            });
            latestExternalByKey.clear();
            const strictReverification = await verifyExternalReferencesBounded({
              references: [...new Map(
                updatedLatest.dependencies.map((reference) => [reference.key, reference]),
              ).values()],
              getObject,
              evidenceCache: null,
              reuseEvidence: false,
              freshKeys: new Set(updatedLatest.dependencies.map((reference) => reference.key)),
            });
            absorbVerificationMetrics(strictReverification.metrics);
            if (strictReverification.has_failure) {
              throw strictReverification.failure;
            }
            for (const [key, evidence] of strictReverification.evidence_by_key) {
              latestExternalByKey.set(key, evidence);
            }
          }
          const finalLatestScopeIdentities = new Set(
            (Array.isArray(updatedLatest.payload?.day_summaries)
              ? updatedLatest.payload.day_summaries
              : []).flatMap((day) =>
              Array.isArray(day?.scoped_roots) ? day.scoped_roots : []
            ).map((root) => scopeIdentity(root)),
          );
          for (const scope of removedScopes) {
            if (finalLatestScopeIdentities.has(scopeIdentity(scope))) {
              throw new Error(
                `Exact-v3 latest finalization retained a removed scope: ${scopeIdentity(scope).replaceAll("\u0000", "/")}`,
              );
            }
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
          const dayResultByDay = new Map(
            dayResults.map((entry) => [entry.day_utc, entry]),
          );
          const removalResults = Object.freeze(
            connectorResults.flatMap((entry) =>
              (entry.canonical.removal_results || []).map((removal) => Object.freeze({
                ...removal,
                canonical_connector_result: Object.freeze({
                  connector_authority_present:
                    entry.canonical.connector_authority_present,
                  connector_manifest: entry.canonical.connector_manifest,
                  final_pollutant_codes:
                    entry.canonical.final_pollutant_codes,
                  connector_scope_verified:
                    entry.canonical.connector_scope_verified,
                }),
                canonical_day_result: dayResultByDay.get(entry.day_utc),
                aggregate_root_result: aggregateResult,
                exact_v3_removal_result: Object.freeze({
                  previously_exposed_in_latest:
                    existingLatestScopeIdentities.has(scopeIdentity(removal)),
                  removed_from_latest_global:
                    existingLatestScopeIdentities.has(scopeIdentity(removal)),
                  final_scope_present: false,
                  latest_global: latestPublication,
                }),
              })),
            ),
          );
          const runFinalizationOk = connectorResults.every((entry) =>
            entry.v3_exact_publication?.ok === true
          ) && latestPublication.ok === true;
          if (runFinalizationOk) {
            runEvidenceCache?.recordFinalizedDependencies?.(
              updatedLatest.dependencies,
            );
          }
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "latest_global_exact_v3_finalization_complete",
            {
              ...latestFields,
              ...finalizationMetrics,
              prerequisite_reference_count: updatedLatest.dependencies.length,
              removed_scope_count: removedScopes.length,
              duration_ms: Math.max(0, Date.now() - latestStartedAtMs),
              global_finalization_elapsed_ms: Math.max(0, Date.now() - runStartedAtMs),
              evidence_invalidation_count: collectEvidenceInvalidations(),
              outcome: runFinalizationOk ? "succeeded" : "failed_closed",
            },
          );
          return Object.freeze({
            ok: runFinalizationOk,
            status: latestPublication.status,
            source: normalizedSource,
            prune_eligibility_owner:
              normalizedSource === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
            complete_day_replacement_results: Object.freeze(
              completeDayReplacementResults,
            ),
            removed_scopes: removedScopes,
            removal_results: removalResults,
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
        } catch (error) {
          finalizationMetrics.evidence_invalidation_count = collectEvidenceInvalidations();
          emitV3PublicationDiagnostic(
            diagnosticLog,
            "latest_global_exact_v3_finalization_failed",
            {
              ...latestFields,
              ...finalizationMetrics,
              duration_ms: Math.max(0, Date.now() - latestStartedAtMs),
              global_finalization_elapsed_ms: Math.max(0, Date.now() - runStartedAtMs),
              failure_outcome: failureOutcome(error),
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }
      },
    });
    finalizationMetrics.evidence_invalidation_count = collectEvidenceInvalidations();
    emitV3PublicationDiagnostic(diagnosticLog, "run_finalization_complete", {
      ...runFields,
      duration_ms: Math.max(0, Date.now() - runStartedAtMs),
      global_finalization_elapsed_ms: Math.max(0, Date.now() - runStartedAtMs),
      ...finalizationMetrics,
      outcome: finalResult?.ok === true ? "succeeded" : "failed_closed",
    });
    return finalResult;
  } catch (error) {
    finalizationMetrics.evidence_invalidation_count = collectEvidenceInvalidations();
    emitV3PublicationDiagnostic(diagnosticLog, "run_finalization_failed", {
      ...runFields,
      duration_ms: Math.max(0, Date.now() - runStartedAtMs),
      global_finalization_elapsed_ms: Math.max(0, Date.now() - runStartedAtMs),
      ...finalizationMetrics,
      failure_outcome: failureOutcome(error),
      error: error instanceof Error ? error.message : String(error),
    });
    runEvidenceCache?.clear?.();
    throw error;
  }
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

export function runSelectedScopeReconciliationObservationHistoryV3Writer(options = {}) {
  requireObservationsGlobalOperationLockContext({
    env: options.env ?? (typeof process !== "undefined" ? process.env : {}),
    expectedOwner: options.expectedObservationsGlobalOperationLockOwner,
    expectedRunId: options.expectedObservationsGlobalOperationLockRunId,
  });
  return runObservationHistoryV3SteadyStateWriter({
    ...options,
    source:
      OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation,
    selectedScopeRemovalAuthority: SELECTED_SCOPE_REMOVAL_AUTHORITY,
  });
}
