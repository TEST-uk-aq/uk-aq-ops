// @ts-nocheck -- disconnected post-cutover-only orchestration for Node writers.
import { Buffer } from "node:buffer";

import {
  resolveObservationHistoryIndexV3BuildConfig,
} from "./uk_aq_observation_history_index_v3.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
  runIntegrityObservationHistoryV3Writer,
  runPruneDailyObservationHistoryV3Writer,
  runSosHistoricalReplacementObservationHistoryV3Writer,
  runSupportedBackfillObservationHistoryV3Writer,
} from "./uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "./uk_aq_r2_history_canonical.mjs";
import { sha256Hex } from "./r2_sigv4.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "./uk_aq_observation_history_writer_limits_v3.mjs";

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function exactBody(value, key) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`Canonical observation-history body is unavailable: ${key}`);
}

function sortedPollutantCodes(values) {
  const codes = values.map((value) => String(value || "").trim().toLowerCase());
  if (codes.some((value) => !/^[a-z0-9_]+$/.test(value))) {
    throw new Error("Canonical connector state contains an invalid pollutant code");
  }
  const unique = [...new Set(codes)].sort(bytewiseCompare);
  if (unique.length !== codes.length) {
    throw new Error("Canonical connector state contains duplicate pollutant codes");
  }
  return unique;
}

function parseCanonicalManifest({ body, key, manifestKind, scope }) {
  const bytes = exactBody(body, key);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Canonical observation manifest is invalid JSON: ${key}`);
  }
  validateCanonicalHistoryV2Manifest(payload, {
    history_version: "v2",
    domain: "observations",
    manifest_kind: manifestKind,
    day_utc: scope.day_utc,
    connector_id: scope.connector_id,
    ...(manifestKind === "pollutant"
      ? { pollutant_code: scope.pollutant_code }
      : {}),
    manifest_key: key,
  });
  return payload;
}

function jsonArtifact({ key, payload, stage, dependencies = [] }) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return Object.freeze({
    kind: stage === "pollutant_manifest"
      ? "canonical_observation_pollutant_manifest"
      : "canonical_observation_connector_manifest",
    key,
    payload,
    body,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
    content_type: "application/json; charset=utf-8",
    publication_stage: stage,
    dependencies: Object.freeze([...dependencies]),
    publication_prerequisites: Object.freeze([]),
  });
}

function maxBackedUpAtUtc(manifests) {
  return manifests.reduce((latest, manifest) => {
    const value = typeof manifest?.backed_up_at_utc === "string"
      ? manifest.backed_up_at_utc
      : null;
    return !latest || (value && value > latest) ? value : latest;
  }, null);
}

async function readCurrentPollutantManifests({
  getObject,
  observationsPrefix,
  dayUtc,
  connectorId,
}) {
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    observationsPrefix,
    dayUtc,
    connectorId,
  );
  const current = await getObject({ key: connectorKey });
  if (!current || current.exists === false) {
    return Object.freeze({ connector_manifest: null, pollutant_manifests: [] });
  }
  const connectorManifest = parseCanonicalManifest({
    body: current.body,
    key: connectorKey,
    manifestKind: "connector",
    scope: { day_utc: dayUtc, connector_id: connectorId },
  });
  const descriptors = Array.isArray(connectorManifest.pollutant_manifests)
    ? connectorManifest.pollutant_manifests
    : connectorManifest.child_manifests;
  if (!Array.isArray(descriptors)) {
    throw new Error(`Canonical connector manifest has no pollutant children: ${connectorKey}`);
  }
  const codes = sortedPollutantCodes(
    descriptors.map((entry) => entry?.pollutant_code),
  );
  const manifests = [];
  for (const code of codes) {
    const descriptor = descriptors.find((entry) => entry.pollutant_code === code);
    const key = String(descriptor?.manifest_key || "").trim();
    const object = await getObject({ key });
    if (!object || object.exists === false) {
      throw new Error(`Current canonical pollutant manifest is missing: ${key}`);
    }
    const payload = parseCanonicalManifest({
      body: object.body,
      key,
      manifestKind: "pollutant",
      scope: {
        day_utc: dayUtc,
        connector_id: connectorId,
        pollutant_code: code,
      },
    });
    if (payload.manifest_hash !== descriptor.manifest_hash) {
      throw new Error(`Current pollutant child identity disagrees: ${key}`);
    }
    manifests.push(payload);
  }
  return Object.freeze({
    connector_manifest: connectorManifest,
    pollutant_manifests: Object.freeze(manifests),
  });
}

async function publishVerifiedJsonArtifact({
  artifact,
  putIfChanged,
  getObject,
  recordDurableEvidence,
}) {
  await putIfChanged(artifact);
  const stored = await getObject({ key: artifact.key });
  if (!stored || stored.exists === false) {
    throw new Error(`Published canonical manifest is missing: ${artifact.key}`);
  }
  const body = exactBody(stored.body, artifact.key);
  if (body.byteLength !== artifact.byte_size || sha256Hex(body) !== artifact.sha256) {
    throw new Error(`Published canonical manifest identity changed: ${artifact.key}`);
  }
  const durable = await recordDurableEvidence(artifact);
  if (durable?.durable !== true) {
    throw new Error(`Published canonical manifest is not durable: ${artifact.key}`);
  }
  return Object.freeze({
    key: artifact.key,
    byte_size: artifact.byte_size,
    sha256: artifact.sha256,
    verified: true,
    durable: true,
  });
}

export function createObservationHistoryV3CanonicalConnectorPublisher({
  getObject,
  putIfChanged,
  recordDurableEvidence,
  targetWriterGitSha,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
}) {
  for (const [name, adapter] of Object.entries({
    getObject,
    putIfChanged,
    recordDurableEvidence,
  })) {
    if (typeof adapter !== "function") {
      throw new TypeError(`V3 canonical connector publisher requires ${name}`);
    }
  }
  const writerGitSha = String(targetWriterGitSha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(writerGitSha)) {
    throw new TypeError("targetWriterGitSha must be a full lower-case Git SHA");
  }

  return async function publishConnectorScopedCanonicalManifests({
    source,
    day_utc: dayUtc,
    connector_id: connectorId,
    partitions,
  }) {
    const current = await readCurrentPollutantManifests({
      getObject,
      observationsPrefix,
      dayUtc,
      connectorId,
    });
    if (
      source === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement &&
      current.connector_manifest !== null
    ) {
      throw new Error(
        `SOS complete-day replacement found live connector state after deletion: ${dayUtc}/${connectorId}`,
      );
    }
    const finalByCode = new Map(
      current.pollutant_manifests.map((manifest) => [manifest.pollutant_code, manifest]),
    );
    const changedCodes = sortedPollutantCodes(
      partitions.map((partition) => partition.scope.pollutant_code),
    );
    for (const partition of partitions) {
      const artifact = partition.pollutant_manifest;
      const expectedDependencies = new Map(
        artifact.dependencies.map((entry) => [entry.key, entry]),
      );
      if (
        partition.file_evidence.length !== expectedDependencies.size ||
        partition.file_evidence.some((entry) => {
          const expected = expectedDependencies.get(entry.key);
          return !expected || entry.byte_size !== expected.byte_size ||
            entry.sha256 !== expected.sha256 || entry.verified !== true ||
            entry.durable !== true;
        })
      ) {
        throw new Error(
          `Canonical pollutant manifest Parquet evidence is incomplete: ${artifact.key}`,
        );
      }
      finalByCode.set(partition.scope.pollutant_code, artifact.payload);
    }

    const finalPollutants = [...finalByCode.values()].sort((left, right) =>
      bytewiseCompare(left.pollutant_code, right.pollutant_code)
    );
    const changedEvidence = [];
    for (const partition of partitions) {
      changedEvidence.push(await publishVerifiedJsonArtifact({
        artifact: partition.pollutant_manifest,
        putIfChanged,
        getObject,
        recordDurableEvidence,
      }));
    }
    const connectorKey = buildHistoryV2ConnectorManifestKey(
      observationsPrefix,
      dayUtc,
      connectorId,
    );
    const connectorPayload = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      runId: null,
      manifestKey: connectorKey,
      pollutantManifests: finalPollutants,
      writerGitSha,
      backedUpAtUtc: maxBackedUpAtUtc(finalPollutants),
    });
    const connectorArtifact = jsonArtifact({
      key: connectorKey,
      payload: connectorPayload,
      stage: "connector_manifest",
      dependencies: finalPollutants.map((manifest) => ({
        kind: "canonical_observation_pollutant_manifest",
        key: manifest.manifest_key,
        manifest_hash: manifest.manifest_hash,
      })),
    });
    const connectorEvidence = await publishVerifiedJsonArtifact({
      artifact: connectorArtifact,
      putIfChanged,
      getObject,
      recordDurableEvidence,
    });
    const currentCodes = current.pollutant_manifests.map(
      (manifest) => manifest.pollutant_code,
    ).sort(bytewiseCompare);
    const finalCodes = finalPollutants.map(
      (manifest) => manifest.pollutant_code,
    ).sort(bytewiseCompare);
    return Object.freeze({
      connector_scope_verified: true,
      parent_state_reread_under_lock: true,
      day_utc: dayUtc,
      connector_id: connectorId,
      current_pollutant_codes: Object.freeze(currentCodes),
      changed_pollutant_codes: Object.freeze(changedCodes),
      final_pollutant_codes: Object.freeze(finalCodes),
      pollutant_manifests: Object.freeze(changedEvidence),
      connector_manifest: connectorEvidence,
      connector_manifest_payload: connectorPayload,
      prune_eligibility_created: false,
    });
  };
}

function v3OnlyOptions({
  env = typeof process !== "undefined" ? process.env : {},
  writerLimits = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  publishConnectorScopedCanonicalManifests = null,
  ...options
}) {
  resolveObservationHistoryIndexV3BuildConfig({ env });
  const acceptedLimits = assertAcceptedObservationHistoryWriterLimitsV3(
    writerLimits,
    "disconnected operational observation-history v3 writer limits",
  );
  const connectorPublisher = publishConnectorScopedCanonicalManifests ||
    createObservationHistoryV3CanonicalConnectorPublisher({
      getObject: options.getObject,
      putIfChanged: options.putIfChanged,
      recordDurableEvidence: options.recordDurableEvidence,
      targetWriterGitSha: options.targetWriterGitSha,
      observationsPrefix: options.observationsPrefix,
    });
  return {
    ...options,
    writerLimits: acceptedLimits,
    publishConnectorScopedCanonicalManifests: connectorPublisher,
  };
}

export function runDisconnectedPruneDailyObservationHistoryV3Writer(options) {
  return runPruneDailyObservationHistoryV3Writer(v3OnlyOptions(options));
}

export function runDisconnectedIntegrityObservationHistoryV3Writer(options) {
  return runIntegrityObservationHistoryV3Writer(v3OnlyOptions(options));
}

export function runDisconnectedSosHistoricalReplacementObservationHistoryV3Writer(options) {
  return runSosHistoricalReplacementObservationHistoryV3Writer(v3OnlyOptions(options));
}

export function runDisconnectedSupportedBackfillObservationHistoryV3Writer(options) {
  return runSupportedBackfillObservationHistoryV3Writer(v3OnlyOptions(options));
}
