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
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
} from "./uk_aq_r2_checksum_publication.mjs";
import {
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
} from "./uk_aq_r2_history_canonical.mjs";
import {
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
  writerLimits,
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
  const target = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits: writerLimits,
    fileKeyForOrdinal: (ordinal) => {
      const first = rows?.[0] || {};
      return buildHistoryV2PartKey(
        prefix,
        first.day_utc || String(first.observed_at_utc || "").slice(0, 10),
        first.connector_id,
        first.pollutant_code,
        ordinal,
      );
    },
  });
  const scope = target.metadata.partition;
  const fileIntents = target.file_bodies.map((file) =>
    buildR2ChecksumAwarePutIntent({ key: file.key, body: file.body })
  );
  const manifestKey = buildHistoryV2PollutantManifestKey(
    prefix,
    scope.day_utc,
    scope.connector_id,
    scope.pollutant_code,
  );
  const manifestPayload = buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc: scope.day_utc,
    connectorId: scope.connector_id,
    pollutantCode: scope.pollutant_code,
    runId: null,
    manifestKey,
    sourceRowCount: target.metadata.row_count,
    fileEntries: target.metadata.files.map((file) =>
      fileEntry(file, scope.pollutant_code)
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
    scope: Object.freeze({ ...scope }),
    target_metadata: target.metadata,
    file_intents: Object.freeze(fileIntents),
    canonical_pollutant_manifest: manifestArtifact,
    v3_hierarchy: hierarchy,
  });
}

/**
 * The one post-cutover publication path for Prune, Integrity, SOS and supported
 * backfills. Callers supply their existing canonical parent-manifest finalizer;
 * it must return exact durable evidence before the v3 index can advance.
 */
export async function runObservationHistoryV3SteadyStatePartitionWriter({
  client,
  source,
  rows,
  writerLimits,
  targetWriterGitSha,
  backedUpAtUtc,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  indexRoot = OBSERVATION_HISTORY_V3_INDEX_ROOT,
  latestKey = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_LATEST_KEY,
  r2,
  putObject = r2PutObject,
  headObject = r2HeadObject,
  getObject,
  publishCanonicalManifests,
  putIfChanged,
  recordDurableEvidence,
  finalizeV3Publication = finalizeObservationHistoryIndexV3Publication,
  diagnostics,
  diagnosticEnvironment,
  lockTimeoutMs,
}) {
  if (!client?.query) throw new Error("V3 steady-state writer requires PostgreSQL lock client");
  if (!r2 || typeof r2 !== "object") throw new Error("V3 steady-state writer requires R2 configuration");
  for (const [name, adapter] of Object.entries({
    getObject,
    publishCanonicalManifests,
    putIfChanged,
    recordDurableEvidence,
    finalizeV3Publication,
  })) {
    if (typeof adapter !== "function") throw new TypeError(`V3 steady-state writer adapter is missing: ${name}`);
  }
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source,
    rows,
    writerLimits,
    targetWriterGitSha,
    backedUpAtUtc,
    observationsPrefix,
    indexRoot,
  });
  return await withConnectorDayHistoryLock({
    client,
    dayUtc: prepared.scope.day_utc,
    connectorId: prepared.scope.connector_id,
    diagnostics,
    diagnosticEnvironment,
    timeoutMs: lockTimeoutMs,
  }, async () => {
    const fileEvidence = [];
    for (const intent of prepared.file_intents) {
      const verified = await putAndVerifyR2ObjectWithSha256({
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
    const expectedCanonical = prepared.canonical_pollutant_manifest;
    const canonicalResult = await publishCanonicalManifests({
      source: prepared.source,
      prune_eligibility_owner: prepared.prune_eligibility_owner,
      scope: prepared.scope,
      pollutant_manifest: expectedCanonical,
      file_evidence: Object.freeze(fileEvidence),
    });
    if (canonicalResult?.canonical_hierarchy_verified !== true) {
      throw new Error(
        "Canonical manifest finalizer must verify pollutant, connector, day and aggregate publication",
      );
    }
    if (
      prepared.prune_eligibility_owner !== true
      && canonicalResult?.prune_eligibility_created === true
    ) {
      throw new Error(
        `Writer source ${prepared.source} must not create Prune Daily eligibility`,
      );
    }
    const canonicalEvidence = assertEvidence(
      canonicalResult?.pollutant_manifest ?? canonicalResult,
      expectedCanonical,
      "Canonical manifest finalizer",
    );

    return await runCanonicalGlobalIndexFinalizer({
      client,
      diagnostics,
      diagnosticEnvironment,
      timeoutMs: lockTimeoutMs,
      finalize: async () => {
        const latestObject = await getObject({ key: latestKey });
        if (!latestObject || latestObject.exists === false) {
          throw new Error(`Post-cutover v3 latest object is missing: ${latestKey}`);
        }
        const existingLatest = latestArtifactFromStoredObject({
          key: latestKey,
          body: latestObject.body,
          latestKey,
        });
        const updatedLatest = updateObservationHistoryIndexV3Latest({
          existingLatest,
          replacementScopedManifests: [prepared.v3_hierarchy.scoped_manifest],
          indexRoot,
          latestKey,
        });
        const changedObjects = [
          ...prepared.v3_hierarchy.child_shards,
          prepared.v3_hierarchy.scoped_manifest,
          updatedLatest,
        ];
        const changedKeys = new Set(changedObjects.map((object) => object.key));
        const knownEvidence = new Map([
          ...fileEvidence.map((entry) => [entry.key, entry]),
          [canonicalEvidence.key, canonicalEvidence],
        ]);
        const externalByKey = new Map();
        for (const object of changedObjects) {
          for (const reference of [
            ...(object.dependencies || []),
            ...(object.publication_prerequisites || []),
          ]) {
            if (changedKeys.has(reference.key) || externalByKey.has(reference.key)) continue;
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
          objects: changedObjects,
          externalReferences: [...externalByKey.values()],
        });
        const publication = await finalizeV3Publication({
          plan,
          putIfChanged,
          getObject,
          recordDurableEvidence,
        });
        return Object.freeze({
          ok: publication.ok === true,
          status: publication.status,
          source: prepared.source,
          prune_eligibility_owner: prepared.prune_eligibility_owner,
          scope: prepared.scope,
          target_metadata: prepared.target_metadata,
          file_evidence: Object.freeze(fileEvidence),
          canonical_manifest_evidence: canonicalEvidence,
          v3_publication: publication,
        });
      },
    });
  });
}

// Named, fixed-authority adapters are the Phase 6 import surface. They avoid a
// runtime writer-generation selector and prevent each caller from reimplementing
// target construction or v3 publication semantics.
export function runPruneDailyObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStatePartitionWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
  });
}

export function runIntegrityObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStatePartitionWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
  });
}

export function runSosHistoricalReplacementObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStatePartitionWriter({
    ...options,
    source:
      OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
  });
}

export function runSupportedBackfillObservationHistoryV3Writer(options) {
  return runObservationHistoryV3SteadyStatePartitionWriter({
    ...options,
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.supportedBackfill,
  });
}
