import { getObservationHistoryGeneration, resolveObservationHistoryGeneration, assertObservationHistoryGenerationPrefixes } from "./uk_aq_observation_history_generation.mjs";
// @ts-nocheck -- disconnected post-cutover-only orchestration for Node writers.
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";

import {
  buildObservationHistoryIndexV3PublicationPlan,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  OBSERVATION_HISTORY_EXACT_LEAF_INDEX_GENERATION_V3,
} from "./uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
} from "./uk_aq_observation_history_target_writer.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
} from "./uk_aq_observation_history_schema.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
  buildObservationHistoryV3SteadyStatePartition,
  runIntegrityObservationHistoryV3Writer,
  runPruneDailyObservationHistoryV3ConnectorPublication,
  runPruneDailyObservationHistoryV3RunFinalization,
  runPruneDailyObservationHistoryV3Writer,
  runSosHistoricalReplacementObservationHistoryV3Writer,
  runSupportedBackfillObservationHistoryV3Writer,
} from "./uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "./uk_aq_r2_history_canonical.mjs";
import {
  r2GetObject,
  sha256Hex,
} from "./r2_sigv4.mjs";
import {
  r2PutObjectIfChanged,
} from "./uk_aq_r2_history_index.mjs";
import {
  finalizeR2HistoryV2ObservationsManifestHierarchy,
} from "./uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "./uk_aq_observation_history_writer_limits_v3.mjs";

export function resolveObservationHistoryIndexV3BuildConfig({
  env = typeof process !== "undefined" ? process.env : {},
  requestedIndexGeneration = null,
} = {}) {
  const generation = resolveObservationHistoryGeneration(env).version;
  if (requestedIndexGeneration !== null && requestedIndexGeneration !== generation) {
    throw new Error("Requested index generation contradicts complete observation generation");
  }
  if (generation !== OBSERVATION_HISTORY_EXACT_LEAF_INDEX_GENERATION_V3) {
    throw new Error(
      `Unsupported observation-history index generation for v3 builder: ${generation || "unset"}`,
    );
  }
  return Object.freeze({
    domain: "observations",
    history_version: "v2",
    index_generation: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_GENERATION_V3,
    index_root: DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
    latest_key: DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    aligned_row_cap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
    exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
  });
}

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
    ...(manifestKind !== "day"
      ? { connector_id: scope.connector_id }
      : {}),
    ...(manifestKind === "pollutant"
      ? { pollutant_code: scope.pollutant_code }
      : {}),
    manifest_key: key,
  });
  return payload;
}

function jsonArtifact({ key, payload, stage, kind = null, dependencies = [] }) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  return Object.freeze({
    kind: kind || (stage === "pollutant_manifest"
      ? "canonical_observation_pollutant_manifest"
      : "canonical_observation_connector_manifest"),
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

function isMissingObjectError(error) {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status !== undefined && status !== null && status !== "") {
    return Number(status) === 404;
  }
  return /NoSuchKey|not[ _-]?found|R2 GET failed \(404\)/i.test(
    error instanceof Error ? error.message : String(error || ""),
  );
}

async function getOptionalObject(getObject, key) {
  try {
    const object = await getObject({ key });
    return object?.exists === false ? null : object;
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

let latestRecoveryParquetWasmInitialized = false;

function ensureLatestRecoveryParquetWasmInitialized() {
  if (latestRecoveryParquetWasmInitialized) return;
  parquetWasm.initSync({
    module: fs.readFileSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm",
    )),
  });
  latestRecoveryParquetWasmInitialized = true;
}

function exactScopeFromScopedManifestKey(key, indexRoot) {
  const normalizedRoot = String(indexRoot || "").trim().replace(/^\/+|\/+$/g, "");
  const normalizedKey = String(key || "").trim().replace(/^\/+/, "");
  const prefix = `${normalizedRoot}/day_utc=`;
  if (!normalizedRoot || !normalizedKey.startsWith(prefix)) {
    throw new Error(`Prune latest-global recovery dependency key is invalid: ${normalizedKey}`);
  }
  const suffix = normalizedKey.slice(prefix.length);
  const match = suffix.match(
    /^(\d{4}-\d{2}-\d{2})\/connector_id=(\d+)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/,
  );
  const dayUtc = match?.[1];
  const parsedDay = new Date(`${dayUtc}T00:00:00.000Z`);
  const connectorId = Number(match?.[2]);
  if (
    !match || Number.isNaN(parsedDay.getTime()) ||
    parsedDay.toISOString().slice(0, 10) !== dayUtc ||
    !Number.isSafeInteger(connectorId) || connectorId <= 0
  ) {
    throw new Error(`Prune latest-global recovery dependency key is invalid: ${normalizedKey}`);
  }
  return Object.freeze({
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: match[3],
  });
}

function assertCurrentPollutantDescriptor(descriptor, pollutantManifest) {
  for (const field of [
    "pollutant_code",
    "manifest_key",
    "manifest_hash",
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
  ]) {
    if ((descriptor?.[field] ?? null) !== (pollutantManifest?.[field] ?? null)) {
      throw new Error(
        `Current canonical pollutant child contradicts its connector descriptor: ${pollutantManifest?.manifest_key || "unknown"}`,
      );
    }
  }
}

function decodeAcceptedCanonicalObservationRows(body, key) {
  ensureLatestRecoveryParquetWasmInitialized();
  let table;
  try {
    const wasmTable = parquetWasm.readParquet(body);
    table = arrow.tableFromIPC(wasmTable.intoIPCStream());
  } catch (error) {
    throw new Error(
      `Current canonical Parquet is unreadable: ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const columns = table.schema.fields.map((field) => field.name);
  if (
    columns.length !== OBSERVATION_HISTORY_COLUMNS_V3.length ||
    columns.some((column, index) => column !== OBSERVATION_HISTORY_COLUMNS_V3[index])
  ) {
    throw new Error(`Current canonical Parquet schema is unsupported: ${key}`);
  }
  const vectors = Object.fromEntries(columns.map((column) => [
    column,
    table.getChild(column),
  ]));
  return Array.from({ length: table.numRows }, (_, index) => {
    const timestamp = Number(vectors.observed_at_utc.get(index));
    const observedAtUtc = new Date(timestamp);
    if (!Number.isFinite(timestamp) || Number.isNaN(observedAtUtc.getTime())) {
      throw new Error(`Current canonical Parquet timestamp is invalid: ${key}`);
    }
    return {
      connector_id: Number(vectors.connector_id.get(index)),
      station_id: Number(vectors.station_id.get(index)),
      timeseries_id: Number(vectors.timeseries_id.get(index)),
      pollutant_code: String(vectors.pollutant_code.get(index)),
      observed_at_utc: observedAtUtc.toISOString(),
      value: Number(vectors.value.get(index)),
      verification_status: vectors.verification_status.get(index) === null
        ? null
        : String(vectors.verification_status.get(index)),
    };
  });
}

async function exactLiveEvidence(getObject, expected, suppliedBody = null) {
  const object = suppliedBody === null
    ? await getObject({ key: expected.key })
    : { exists: true, body: suppliedBody };
  if (!object || object.exists === false || object.body === null || object.body === undefined) {
    throw new Error(`Canonically rebuilt exact-v3 dependency is missing: ${expected.key}`);
  }
  const body = exactBody(object.body, expected.key);
  if (body.byteLength !== expected.byte_size || sha256Hex(body) !== expected.sha256) {
    throw new Error(
      `Canonically rebuilt exact-v3 dependency identity disagrees: ${expected.key}`,
    );
  }
  return Object.freeze({
    key: expected.key,
    byte_size: expected.byte_size,
    sha256: expected.sha256,
    verified: true,
    durable: true,
  });
}

export function createObservationHistoryV3LatestScopedReferenceRecovery({
  getObject,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  writerLimits = ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
}) {
  if (typeof getObject !== "function") {
    throw new TypeError("Prune latest-global recovery requires getObject");
  }
  const acceptedLimits = assertAcceptedObservationHistoryWriterLimitsV3(
    writerLimits,
    "Prune latest-global recovery writer limits",
  );
  return async function recoverLatestScopedReference({
    source,
    reference,
    latest_scope: latestScope,
    live_reference: liveReference,
    live_body: liveBody,
    observations_prefix: requestedObservationsPrefix,
    index_root: requestedIndexRoot,
  }) {
    if (source !== OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily) {
      throw new Error("Latest-global scoped-reference recovery is Prune-only");
    }
    if (
      requestedObservationsPrefix !== observationsPrefix ||
      requestedIndexRoot !== indexRoot
    ) {
      throw new Error("Prune latest-global recovery authority roots disagree");
    }
    const scope = exactScopeFromScopedManifestKey(reference?.key, indexRoot);
    const liveBytes = liveBody === null || liveBody === undefined
      ? null
      : exactBody(liveBody, reference.key);
    if (
      latestScope?.day_utc !== scope.day_utc ||
      Number(latestScope?.connector_id) !== scope.connector_id ||
      latestScope?.pollutant_code !== scope.pollutant_code ||
      latestScope?.key !== reference.key ||
      Number(latestScope?.byte_size) !== Number(reference?.byte_size) ||
      latestScope?.sha256 !== reference?.sha256
    ) {
      throw new Error(
        `Prune latest-global dependency key and payload scope disagree: ${reference?.key}`,
      );
    }
    if (
      liveReference?.key !== reference.key || liveBytes === null ||
      liveBytes.byteLength !== liveReference.byte_size ||
      sha256Hex(liveBytes) !== liveReference.sha256
    ) {
      throw new Error(`Prune latest-global live mismatch evidence is invalid: ${reference?.key}`);
    }

    const connectorKey = buildHistoryV2ConnectorManifestKey(
      observationsPrefix,
      scope.day_utc,
      scope.connector_id,
    );
    const connectorObject = await getObject({ key: connectorKey });
    if (!connectorObject || connectorObject.exists === false) {
      throw new Error(`Current canonical connector manifest is missing: ${connectorKey}`);
    }
    const connectorManifest = parseCanonicalManifest({
      body: connectorObject.body,
      key: connectorKey,
      manifestKind: "connector",
      scope,
    });
    const descriptors = Array.isArray(connectorManifest.pollutant_manifests)
      ? connectorManifest.pollutant_manifests
      : connectorManifest.child_manifests;
    if (!Array.isArray(descriptors)) {
      throw new Error(`Current canonical connector has no pollutant authority: ${connectorKey}`);
    }
    const matches = descriptors.filter((entry) =>
      entry?.pollutant_code === scope.pollutant_code
    );
    if (matches.length !== 1) {
      throw new Error(
        `Current canonical connector does not authorise pollutant ${scope.pollutant_code}: ${connectorKey}`,
      );
    }
    const descriptor = matches[0];
    const pollutantKey = buildHistoryV2PollutantManifestKey(
      observationsPrefix,
      scope.day_utc,
      scope.connector_id,
      scope.pollutant_code,
    );
    if (descriptor.manifest_key !== pollutantKey) {
      throw new Error(`Current canonical pollutant descriptor key disagrees: ${connectorKey}`);
    }
    const pollutantObject = await getObject({ key: pollutantKey });
    if (!pollutantObject || pollutantObject.exists === false) {
      throw new Error(`Current canonical pollutant manifest is missing: ${pollutantKey}`);
    }
    const pollutantBody = exactBody(pollutantObject.body, pollutantKey);
    const pollutantManifest = parseCanonicalManifest({
      body: pollutantBody,
      key: pollutantKey,
      manifestKind: "pollutant",
      scope,
    });
    assertCurrentPollutantDescriptor(descriptor, pollutantManifest);

    const files = Array.isArray(pollutantManifest.files)
      ? pollutantManifest.files
      : [];
    if (files.length === 0 || files.length !== Number(pollutantManifest.file_count)) {
      throw new Error(`Current canonical pollutant Parquet evidence is incomplete: ${pollutantKey}`);
    }
    const canonicalBodies = [];
    const canonicalRows = [];
    const externalReferences = [{
      key: pollutantKey,
      byte_size: pollutantBody.byteLength,
      sha256: sha256Hex(pollutantBody),
      verified: true,
      durable: true,
    }];
    for (const file of files) {
      const key = String(file?.key || "").trim();
      const expectedBytes = Number(file?.bytes);
      const expectedSha256 = String(file?.etag_or_hash || "").trim().toLowerCase();
      if (
        !key || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(expectedSha256)
      ) {
        throw new Error(`Current canonical pollutant Parquet evidence is invalid: ${pollutantKey}`);
      }
      const object = await getObject({ key });
      if (!object || object.exists === false) {
        throw new Error(`Current canonical Parquet is missing: ${key}`);
      }
      const body = exactBody(object.body, key);
      if (body.byteLength !== expectedBytes || sha256Hex(body) !== expectedSha256) {
        throw new Error(`Current canonical Parquet identity disagrees: ${key}`);
      }
      canonicalBodies.push({ key, body });
      canonicalRows.push(...decodeAcceptedCanonicalObservationRows(body, key));
      externalReferences.push({
        key,
        byte_size: expectedBytes,
        sha256: expectedSha256,
        verified: true,
        durable: true,
      });
    }
    const rebuilt = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily,
      rows: canonicalRows,
      writerLimits: acceptedLimits,
      targetWriterGitSha: pollutantManifest.writer_git_sha,
      backedUpAtUtc: pollutantManifest.backed_up_at_utc,
      observationsPrefix,
      indexRoot,
    });
    if (
      rebuilt.file_intents.length !== canonicalBodies.length ||
      rebuilt.file_intents.some((entry, index) =>
        entry.key !== canonicalBodies[index].key ||
        !exactBody(entry.body, entry.key).equals(canonicalBodies[index].body)
      ) ||
      !exactBody(
        rebuilt.canonical_pollutant_manifest.body,
        pollutantKey,
      ).equals(pollutantBody)
    ) {
      throw new Error(
        `Current canonical pollutant scope does not match the accepted deterministic writer: ${pollutantKey}`,
      );
    }
    const hierarchy = rebuilt.v3_hierarchy;
    buildObservationHistoryIndexV3PublicationPlan({
      objects: hierarchy.publication_objects,
      externalReferences,
    });
    if (
      hierarchy.scoped_manifest.key !== reference.key ||
      hierarchy.scoped_manifest.byte_size !== liveReference.byte_size ||
      hierarchy.scoped_manifest.sha256 !== liveReference.sha256
    ) {
      throw new Error(
        `Live exact-v3 scoped identity does not match current canonical authority: ${reference.key}`,
      );
    }
    for (const artifact of hierarchy.publication_objects) {
      await exactLiveEvidence(
        getObject,
        artifact,
        artifact.key === reference.key ? liveBytes : null,
      );
    }
    return Object.freeze({
      artifact: hierarchy.scoped_manifest,
      evidence: Object.freeze({
        key: hierarchy.scoped_manifest.key,
        byte_size: hierarchy.scoped_manifest.byte_size,
        sha256: hierarchy.scoped_manifest.sha256,
        verified: true,
        durable: true,
      }),
    });
  };
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
  completeConnectorSnapshot,
}) {
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    observationsPrefix,
    dayUtc,
    connectorId,
  );
  const current = await getOptionalObject(getObject, connectorKey);
  if (!current) {
    return Object.freeze({
      connector_manifest: null,
      current_pollutant_codes: Object.freeze([]),
      pollutant_manifests: Object.freeze([]),
      child_validation_mode: completeConnectorSnapshot
        ? "parent_descriptors_only_complete_snapshot"
        : "strict_live_child_identity",
    });
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
  if (completeConnectorSnapshot) {
    return Object.freeze({
      connector_manifest: connectorManifest,
      current_pollutant_codes: Object.freeze(codes),
      pollutant_manifests: Object.freeze([]),
      child_validation_mode: "parent_descriptors_only_complete_snapshot",
    });
  }
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
    current_pollutant_codes: Object.freeze(codes),
    pollutant_manifests: Object.freeze(manifests),
    child_validation_mode: "strict_live_child_identity",
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

function createR2ReadbackDurabilityRecorder(getObject) {
  return async function recordR2ReadbackDurability(evidence) {
    const key = String(evidence?.key || "").trim();
    if (!key) {
      throw new Error("Canonical observation-history durability evidence has no key");
    }
    const stored = await getObject({ key });
    if (!stored || stored.exists === false) {
      throw new Error(`Canonical observation-history durable object is missing: ${key}`);
    }
    const body = exactBody(stored.body, key);
    const byteSize = Number(evidence?.byte_size);
    const expectedSha256 = String(evidence?.sha256 || "").trim().toLowerCase();
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      !/^[0-9a-f]{64}$/.test(expectedSha256) ||
      body.byteLength !== byteSize ||
      sha256Hex(body) !== expectedSha256
    ) {
      throw new Error(`Canonical observation-history durable identity changed: ${key}`);
    }
    return Object.freeze({
      durable: true,
      key,
      byte_size: byteSize,
      sha256: expectedSha256,
      evidence_kind: "r2_complete_body_readback",
    });
  };
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
    // Prune owns a complete frozen connector-day snapshot. Its current parent
    // descriptors identify the previously authoritative pollutant set, but a
    // retry may find newer orphan child bodies left below that old parent.
    // Targeted repair modes still need the live child bodies to preserve peers.
    const completeConnectorSnapshot =
      source === OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.pruneDaily;
    const current = await readCurrentPollutantManifests({
      getObject,
      observationsPrefix,
      dayUtc,
      connectorId,
      completeConnectorSnapshot,
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
      completeConnectorSnapshot
        ? []
        : current.pollutant_manifests.map((manifest) => [manifest.pollutant_code, manifest]),
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
    const currentCodes = [...current.current_pollutant_codes];
    const finalCodes = finalPollutants.map(
      (manifest) => manifest.pollutant_code,
    ).sort(bytewiseCompare);
    const finalCodeSet = new Set(finalCodes);
    const removedCodes = completeConnectorSnapshot
      ? currentCodes.filter((pollutantCode) => !finalCodeSet.has(pollutantCode))
      : [];
    return Object.freeze({
      connector_scope_verified: true,
      parent_state_reread_under_lock: true,
      day_utc: dayUtc,
      connector_id: connectorId,
      current_child_validation_mode: current.child_validation_mode,
      current_pollutant_codes: Object.freeze(currentCodes),
      changed_pollutant_codes: Object.freeze(changedCodes),
      final_pollutant_codes: Object.freeze(finalCodes),
      removed_pollutant_codes: Object.freeze(removedCodes),
      removed_scopes: Object.freeze(removedCodes.map((pollutantCode) =>
        Object.freeze({
          day_utc: dayUtc,
          connector_id: connectorId,
          pollutant_code: pollutantCode,
        })
      )),
      pollutant_manifests: Object.freeze(changedEvidence),
      connector_manifest: connectorEvidence,
      connector_manifest_payload: connectorPayload,
      prune_eligibility_created: false,
    });
  };
}

export function createObservationHistoryV3CanonicalDayPublisher({
  getObject,
  putIfChanged,
  recordDurableEvidence,
  targetWriterGitSha,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
}) {
  const writerGitSha = String(targetWriterGitSha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(writerGitSha)) {
    throw new TypeError("targetWriterGitSha must be a full lower-case Git SHA");
  }
  return async function finalizeCanonicalDayManifests({
    day_utc: dayUtc,
    changed_connectors: changedConnectors,
  }) {
    const dayKey = buildHistoryV2DayManifestKey(observationsPrefix, dayUtc);
    const currentObject = await getOptionalObject(getObject, dayKey);
    const currentManifest = currentObject
      ? parseCanonicalManifest({
        body: currentObject.body,
        key: dayKey,
        manifestKind: "day",
        scope: { day_utc: dayUtc },
      })
      : null;
    const currentReferences = Array.isArray(currentManifest?.connector_manifests)
      ? currentManifest.connector_manifests
      : Array.isArray(currentManifest?.child_manifests)
        ? currentManifest.child_manifests
        : [];
    const currentConnectorIds = currentReferences.map((entry) => Number(entry.connector_id));
    const changedByConnector = new Map();
    for (const entry of changedConnectors) {
      const connectorId = Number(entry?.connector_id);
      if (!Number.isSafeInteger(connectorId) || connectorId <= 0) {
        throw new Error(`Changed canonical connector ID is invalid: ${dayUtc}/${entry?.connector_id}`);
      }
      if (changedByConnector.has(connectorId)) {
        throw new Error(`Changed canonical connector is duplicated: ${dayUtc}/${connectorId}`);
      }
      const key = buildHistoryV2ConnectorManifestKey(
        observationsPrefix,
        dayUtc,
        connectorId,
      );
      const payload = entry?.canonical?.connector_manifest_payload;
      const evidence = entry?.canonical?.connector_manifest;
      if (!payload) {
        throw new Error(`Changed canonical connector payload is missing: ${dayUtc}/${connectorId}`);
      }
      validateCanonicalHistoryV2Manifest(payload, {
        history_version: "v2",
        domain: "observations",
        manifest_kind: "connector",
        day_utc: dayUtc,
        connector_id: connectorId,
        manifest_key: key,
      });
      const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
      if (
        evidence?.verified !== true || evidence?.durable !== true ||
        evidence?.key !== key || Number(evidence?.byte_size) !== body.byteLength ||
        evidence?.sha256 !== sha256Hex(body)
      ) {
        throw new Error(`Changed canonical connector evidence disagrees: ${dayUtc}/${connectorId}`);
      }
      changedByConnector.set(connectorId, Object.freeze({ payload, evidence, body }));
    }
    const finalByConnector = new Map();
    const seenCurrentConnectorIds = new Set();
    for (const reference of currentReferences) {
      const connectorId = Number(reference.connector_id);
      if (seenCurrentConnectorIds.has(connectorId)) {
        throw new Error(`Current canonical day contains a duplicate connector: ${dayKey}`);
      }
      seenCurrentConnectorIds.add(connectorId);
      const key = buildHistoryV2ConnectorManifestKey(
        observationsPrefix,
        dayUtc,
        connectorId,
      );
      if (reference.manifest_key !== key) {
        throw new Error(`Current canonical day child key disagrees: ${dayKey}`);
      }
      const object = await getObject({ key });
      const liveBody = exactBody(object.body, key);
      const payload = parseCanonicalManifest({
        body: liveBody,
        key,
        manifestKind: "connector",
        scope: { day_utc: dayUtc, connector_id: connectorId },
      });
      const changed = changedByConnector.get(connectorId);
      if (changed) {
        if (
          payload.manifest_hash !== changed.payload.manifest_hash ||
          liveBody.byteLength !== changed.evidence.byte_size ||
          sha256Hex(liveBody) !== changed.evidence.sha256 ||
          !liveBody.equals(changed.body)
        ) {
          throw new Error(`Changed canonical day child identity disagrees: ${key}`);
        }
        finalByConnector.set(connectorId, changed.payload);
      } else if (payload.manifest_hash !== reference.manifest_hash) {
        throw new Error(`Current canonical day child identity disagrees: ${key}`);
      } else {
        finalByConnector.set(connectorId, payload);
      }
    }
    const changedConnectorIds = changedConnectors.map((entry) => Number(entry.connector_id));
    for (const [connectorId, changed] of changedByConnector) {
      if (seenCurrentConnectorIds.has(connectorId)) continue;
      const key = changed.evidence.key;
      const object = await getObject({ key });
      const liveBody = exactBody(object.body, key);
      const payload = parseCanonicalManifest({
        body: liveBody,
        key,
        manifestKind: "connector",
        scope: { day_utc: dayUtc, connector_id: connectorId },
      });
      if (
        payload.manifest_hash !== changed.payload.manifest_hash ||
        liveBody.byteLength !== changed.evidence.byte_size ||
        sha256Hex(liveBody) !== changed.evidence.sha256 ||
        !liveBody.equals(changed.body)
      ) {
        throw new Error(`Changed canonical day child identity disagrees: ${key}`);
      }
      finalByConnector.set(connectorId, changed.payload);
    }
    const finalManifests = [...finalByConnector.values()].sort(
      (left, right) => Number(left.connector_id) - Number(right.connector_id),
    );
    const payload = buildHistoryV2DayManifest({
      domain: "observations",
      dayUtc,
      runId: null,
      manifestKey: dayKey,
      connectorManifests: finalManifests,
      writerGitSha,
      backedUpAtUtc: maxBackedUpAtUtc(finalManifests),
    });
    const artifact = jsonArtifact({
      key: dayKey,
      payload,
      stage: "canonical_day_manifest",
      kind: "canonical_observation_day_manifest",
      dependencies: finalManifests.map((manifest) => ({
        kind: "canonical_observation_connector_manifest",
        key: manifest.manifest_key,
        manifest_hash: manifest.manifest_hash,
      })),
    });
    const dayEvidence = await publishVerifiedJsonArtifact({
      artifact,
      putIfChanged,
      getObject,
      recordDurableEvidence,
    });
    return Object.freeze({
      canonical_day_authority_verified: true,
      parent_state_reread_under_lock: true,
      prune_eligibility_created: false,
      day_utc: dayUtc,
      current_connector_ids: Object.freeze([...currentConnectorIds].sort((a, b) => a - b)),
      changed_connector_ids: Object.freeze([...changedConnectorIds].sort((a, b) => a - b)),
      final_connector_ids: Object.freeze([...finalByConnector.keys()].sort((a, b) => a - b)),
      day_manifest: dayEvidence,
      day_manifest_payload: payload,
    });
  };
}

export function createObservationHistoryV3CanonicalAggregatePublisher({
  r2,
  getObject,
  putObject,
  listAllCommonPrefixes,
  recordDurableEvidence,
  observationsPrefix = DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX,
  hierarchyFinalizer = finalizeR2HistoryV2ObservationsManifestHierarchy,
}) {
  return async function finalizeCanonicalAggregateManifests({
    affected_days_utc: affectedDaysUtc,
  }) {
    const result = await hierarchyFinalizer({
      r2,
      observationsPrefix,
      affectedDaysUtc,
      writeR2: true,
      adapters: {
        getObject,
        putObject,
        listAllCommonPrefixes,
      },
    });
    if (result?.ok !== true) {
      throw new Error("Canonical observation aggregate finalisation failed");
    }
    const aggregateManifests = [];
    for (const entry of result.objects || []) {
      const key = String(entry?.key || "").trim();
      const object = await getObject({ key });
      const body = exactBody(object?.body, key);
      const evidence = {
        key,
        byte_size: body.byteLength,
        sha256: sha256Hex(body),
        verified: true,
        durable: true,
      };
      const durable = await recordDurableEvidence(evidence);
      if (durable?.durable !== true) {
        throw new Error(`Canonical aggregate manifest is not durable: ${key}`);
      }
      aggregateManifests.push(Object.freeze(evidence));
    }
    return Object.freeze({
      canonical_aggregate_authority_verified: true,
      parent_state_reread_under_lock: true,
      prune_eligibility_created: false,
      affected_days_utc: Object.freeze([...affectedDaysUtc]),
      aggregate_manifests: Object.freeze(aggregateManifests),
      hierarchy: result,
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
  assertObservationHistoryGenerationPrefixes(getObservationHistoryGeneration("v3"), options);
  const acceptedLimits = assertAcceptedObservationHistoryWriterLimitsV3(
    writerLimits,
    "disconnected operational observation-history v3 writer limits",
  );
  const getObject = options.getObject || (({ key }) => r2GetObject({ r2: options.r2, key }));
  const putIfChanged = options.putIfChanged || ((object) => r2PutObjectIfChanged({
    r2: options.r2,
    key: object.key,
    body: object.body,
    content_type: object.content_type,
    writeR2: true,
  }));
  const recordDurableEvidence = options.recordDurableEvidence ||
    createR2ReadbackDurabilityRecorder(getObject);
  const connectorPublisher = publishConnectorScopedCanonicalManifests ||
    createObservationHistoryV3CanonicalConnectorPublisher({
      getObject,
      putIfChanged,
      recordDurableEvidence,
      targetWriterGitSha: options.targetWriterGitSha,
      observationsPrefix: options.observationsPrefix,
    });
  const dayPublisher = options.finalizeCanonicalDayManifests ||
    createObservationHistoryV3CanonicalDayPublisher({
      getObject,
      putIfChanged,
      recordDurableEvidence,
      targetWriterGitSha: options.targetWriterGitSha,
      observationsPrefix: options.observationsPrefix,
    });
  const aggregatePublisher = options.finalizeCanonicalAggregateManifests ||
    createObservationHistoryV3CanonicalAggregatePublisher({
      r2: options.r2,
      getObject,
      putObject: options.putObject,
      listAllCommonPrefixes: options.listAllCommonPrefixes,
      recordDurableEvidence,
      observationsPrefix: options.observationsPrefix,
    });
  const latestScopedReferenceRecovery = options.recoverLatestScopedReference ||
    createObservationHistoryV3LatestScopedReferenceRecovery({
      getObject,
      observationsPrefix: options.observationsPrefix,
      indexRoot: options.indexRoot,
      writerLimits: acceptedLimits,
    });
  return {
    ...options,
    getObject,
    putIfChanged,
    recordDurableEvidence,
    writerLimits: acceptedLimits,
    publishConnectorScopedCanonicalManifests: connectorPublisher,
    finalizeCanonicalDayManifests: dayPublisher,
    finalizeCanonicalAggregateManifests: aggregatePublisher,
    recoverLatestScopedReference: latestScopedReferenceRecovery,
  };
}

export function runDisconnectedPruneDailyObservationHistoryV3Writer(options) {
  return runPruneDailyObservationHistoryV3Writer(v3OnlyOptions(options));
}

export const runOperationalPruneDailyObservationHistoryV3Writer =
  runDisconnectedPruneDailyObservationHistoryV3Writer;

export function runDisconnectedPruneDailyObservationHistoryV3ConnectorPublication(options) {
  return runPruneDailyObservationHistoryV3ConnectorPublication(
    v3OnlyOptions(options),
  );
}

export const runOperationalPruneDailyObservationHistoryV3ConnectorPublication =
  runDisconnectedPruneDailyObservationHistoryV3ConnectorPublication;

export function runDisconnectedPruneDailyObservationHistoryV3RunFinalization(options) {
  return runPruneDailyObservationHistoryV3RunFinalization(v3OnlyOptions(options));
}

export const runOperationalPruneDailyObservationHistoryV3RunFinalization =
  runDisconnectedPruneDailyObservationHistoryV3RunFinalization;

export function runDisconnectedIntegrityObservationHistoryV3Writer(options) {
  return runIntegrityObservationHistoryV3Writer(v3OnlyOptions(options));
}

export function runDisconnectedSosHistoricalReplacementObservationHistoryV3Writer(options) {
  return runSosHistoricalReplacementObservationHistoryV3Writer(v3OnlyOptions(options));
}

export function runDisconnectedSupportedBackfillObservationHistoryV3Writer(options) {
  return runSupportedBackfillObservationHistoryV3Writer(v3OnlyOptions(options));
}
