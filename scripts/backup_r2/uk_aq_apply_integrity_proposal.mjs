#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  r2DeleteObjects,
  r2GetObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
  resolveLegacyVerificationStatus,
  validateObservationContentHashMetadata,
} from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  runCanonicalConnectorDayWriter,
  runCanonicalDayFinalizer,
  runCanonicalGlobalIndexFinalizer,
  withHistoryWriterClient,
  mergeConnectorManifestReferences,
  readParentManifestForBoundedRecovery,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  buildHistoryV2DayManifest,
  validateCanonicalHistoryV2Manifest,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  resolveR2HistoryIndexConfig,
  updateR2HistoryIndexesTargeted,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  compressors,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} from "./lib/uk_aq_parquet_dependencies.mjs";

const TEST_BUCKET = "uk-aq-history-cic-test";

function parseArgs(argv) {
  const args = { runStateJson: "", writeR2: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-state-json") args.runStateJson = String(argv[++index] || "");
    else if (arg === "--write-r2") args.writeR2 = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.runStateJson) throw new Error("--run-state-json is required");
  if (!args.writeR2) throw new Error("canonical apply requires --write-r2");
  return args;
}

function safeKey(rawKey) {
  const key = String(rawKey || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe canonical object key: ${rawKey}`);
  }
  return key;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".parquet")) return "application/vnd.apache.parquet";
  return "application/octet-stream";
}

function objectDomain(key) {
  if (key.includes("/aqilevels_") || key.includes("/aqilevels/")) return "aqilevels";
  return "observations";
}

function objectRank(key) {
  const domainOffset = objectDomain(key) === "aqilevels" ? 100 : 0;
  if (key.endsWith(".parquet")) return domainOffset + 10;
  if (/\/pollutant_code=[^/]+\/manifest\.json$/.test(key)) return domainOffset + 20;
  if (/\/connector_id=\d+\/manifest\.json$/.test(key)) return domainOffset + 30;
  if (/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key)) return domainOffset + 40;
  if (/\/pollutant_code=[^/]+\.json$/.test(key)) return domainOffset + 50;
  if (key.endsWith("/latest.json")) return domainOffset + 60;
  return domainOffset + 55;
}

const OBSERVATION_INTEGRITY_POLLUTANTS = new Set(["pm25", "pm10", "no2", "o3"]);
const AQI_INTEGRITY_POLLUTANTS = new Set(["pm25", "pm10", "no2"]);
const CANONICAL_CONNECTOR_DAY_PREFIX_PATTERNS = Object.freeze([
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
  /^history\/v2\/aqilevels\/hourly\/data\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
  /^history\/v2\/aqilevels\/hourly\/debug\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
]);
const CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
const CANONICAL_AQI_POLLUTANT_PREFIX_PATTERN =
  /^history\/v2\/aqilevels\/hourly\/(data|debug)\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
const CANONICAL_OBSERVATION_POLLUTANT_MANIFEST_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)\/manifest\.json$/;

function validateDeletionDayConnector({ prefix, dayUtc, connectorIdRaw }) {
  const parsedDay = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayUtc) {
    throw new Error(`Deletion prefix has an invalid UTC day: ${prefix}`);
  }
  const connectorId = Number(connectorIdRaw);
  if (!Number.isSafeInteger(connectorId) || connectorId <= 0 || String(connectorId) !== connectorIdRaw) {
    throw new Error(`Deletion prefix has an invalid connector ID: ${prefix}`);
  }
}

function assertCanonicalDeletionPrefix(prefix, entry) {
  const observationPollutantMatch = prefix.match(CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN);
  const aqiPollutantMatch = prefix.match(CANONICAL_AQI_POLLUTANT_PREFIX_PATTERN);
  const pollutantMatch = observationPollutantMatch || aqiPollutantMatch;
  if (pollutantMatch) {
    const isObservation = Boolean(observationPollutantMatch);
    const [, ...parts] = pollutantMatch;
    const [dayUtc, connectorIdRaw, pollutant] = isObservation ? parts : parts.slice(1);
    const supportedPollutants = isObservation
      ? OBSERVATION_INTEGRITY_POLLUTANTS
      : AQI_INTEGRITY_POLLUTANTS;
    const domainName = isObservation ? "Observation" : "AQI";
    validateDeletionDayConnector({ prefix, dayUtc, connectorIdRaw });
    if (!supportedPollutants.has(pollutant)) {
      throw new Error(`${domainName} deletion prefix has an unsupported pollutant: ${prefix}`);
    }
    const repairPollutants = Array.isArray(entry?.repair_pollutants)
      ? entry.repair_pollutants.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).sort()
      : [];
    if (!repairPollutants.includes(pollutant) || repairPollutants.some((value) => !supportedPollutants.has(value))) {
      throw new Error(`${domainName} pollutant deletion prefix is not backed by matching repair_pollutants evidence: ${prefix}`);
    }
    return;
  }
  const match = CANONICAL_CONNECTOR_DAY_PREFIX_PATTERNS
    .map((pattern) => prefix.match(pattern))
    .find(Boolean);
  if (!match) {
    throw new Error(`Deletion prefix is outside the canonical allowlist: ${prefix}`);
  }
  const [, dayUtc, connectorIdRaw] = match;
  validateDeletionDayConnector({ prefix, dayUtc, connectorIdRaw });
  if (Array.isArray(entry?.repair_pollutants) && entry.repair_pollutants.length > 0) {
    throw new Error(`Pollutant-scoped repair cannot delete a connector-day prefix: ${prefix}`);
  }
}

function dependencyIdentity(entry, dependencyKey) {
  const identities = entry?.dependency_identities;
  if (!identities || typeof identities !== "object" || Array.isArray(identities)) return null;
  const identity = identities[dependencyKey];
  if (!identity || typeof identity !== "object") return null;
  const sha256 = String(identity.sha256 || "").trim().toLowerCase();
  const bytes = Number(identity.bytes);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  return { sha256, bytes };
}

export function validateLocalProposal(runState) {
  if (!runState || typeof runState !== "object") throw new Error("run state must be an object");
  if (runState.environment !== "CIC-Test") {
    throw new Error(`Refusing canonical apply outside CIC-Test: ${runState.environment || "(unset)"}`);
  }
  const objects = Object.entries(runState.objects || {}).sort(([left], [right]) => left.localeCompare(right));
  const prefixes = Array.isArray(runState.tombstone_prefixes) ? runState.tombstone_prefixes : [];
  if (!objects.length && !prefixes.length) throw new Error("canonical proposal has no planned operations");
  const normalizedObjects = [];
  const proposedPrefixes = prefixes
    .filter((entry) => entry?.proposed)
    .map((entry) => `${safeKey(entry.prefix).replace(/\/+$/, "")}/`);
  for (const [rawKey, entry] of objects) {
    const key = safeKey(rawKey);
    if (!(key.startsWith("history/v2/") || key.startsWith("history/_index_v2/"))
      || /\/(?:generation(?:=)|transactions\/)/.test(`/${key}`)) {
      throw new Error(`Non-canonical Integrity proposal key: ${key}`);
    }
    if (!entry?.proposed || !entry?.built || !entry?.structurally_validated) {
      throw new Error(`Local structural validation is incomplete: ${key}`);
    }
    const localPath = String(entry.local_path || "");
    if (!localPath || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Local proposal body is missing: ${key}`);
    }
    const body = fs.readFileSync(localPath);
    if (body.byteLength !== Number(entry.bytes) || sha256Hex(body) !== entry.sha256) {
      throw new Error(`Local proposal identity changed after validation: ${key}`);
    }
    for (const dependency of entry.dependencies || []) {
      const dependencyKey = safeKey(dependency);
      const stagedDependency = runState.objects?.[dependencyKey];
      if (stagedDependency) {
        if (!stagedDependency.structurally_validated
          || !fs.statSync(String(stagedDependency.local_path || ""), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Local proposal dependency is not structurally validated: ${key} -> ${dependencyKey}`);
        }
      } else {
        const expectedIdentity = dependencyIdentity(entry, dependencyKey);
        if (!expectedIdentity) {
          throw new Error(`Dropbox baseline dependency identity is not pinned: ${key} -> ${dependencyKey}`);
        }
        if (proposedPrefixes.some((prefix) => dependencyKey.startsWith(prefix))) {
          throw new Error(`Proposed deletion would remove an unstaged dependency: ${key} -> ${dependencyKey}`);
        }
        const baselinePath = path.join(String(runState.base_dropbox_root || ""), dependencyKey);
        if (!fs.statSync(baselinePath, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Dropbox baseline dependency is unavailable: ${key} -> ${dependencyKey}`);
        }
        const baselineBody = fs.readFileSync(baselinePath);
        if (baselineBody.byteLength !== expectedIdentity.bytes || sha256Hex(baselineBody) !== expectedIdentity.sha256) {
          throw new Error(`Dropbox baseline dependency identity changed after planning: ${key} -> ${dependencyKey}`);
        }
      }
    }
    normalizedObjects.push({ key, entry, localPath, body, domain: objectDomain(key) });
  }
  const normalizedPrefixes = prefixes.map((entry) => {
    const prefix = safeKey(entry?.prefix).replace(/\/+$/, "");
    if (!entry?.proposed) throw new Error(`Deletion prefix is not proposed: ${prefix}`);
    assertCanonicalDeletionPrefix(prefix, entry);
    return { entry, prefix, domain: objectDomain(prefix) };
  });
  const scopedPollutantGroups = new Map();
  for (const item of normalizedPrefixes) {
    const observationMatch = item.prefix.match(CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN);
    const aqiMatch = item.prefix.match(CANONICAL_AQI_POLLUTANT_PREFIX_PATTERN);
    const match = observationMatch || aqiMatch;
    if (!match) continue;
    const isObservation = Boolean(observationMatch);
    const [, ...parts] = match;
    const [dayUtc, connectorIdRaw, pollutant] = isObservation ? parts : parts.slice(1);
    const scopeName = isObservation ? "observations" : `aqilevels/${parts[0]}`;
    const repairPollutants = Array.isArray(item.entry?.repair_pollutants)
      ? item.entry.repair_pollutants.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).sort()
      : [];
    const groupKey = `${scopeName}|${dayUtc}|${connectorIdRaw}|${repairPollutants.join(",")}`;
    const group = scopedPollutantGroups.get(groupKey) || { repairPollutants, prefixes: new Map() };
    group.prefixes.set(pollutant, (group.prefixes.get(pollutant) || 0) + 1);
    scopedPollutantGroups.set(groupKey, group);
  }
  for (const [groupKey, group] of scopedPollutantGroups.entries()) {
    for (const pollutant of group.repairPollutants) {
      if (group.prefixes.get(pollutant) !== 1) {
        throw new Error(`Pollutant-scoped repair requires exactly one deletion prefix for ${pollutant}: ${groupKey}`);
      }
    }
  }
  return {
    objects: normalizedObjects.sort((left, right) => objectRank(left.key) - objectRank(right.key) || left.key.localeCompare(right.key)),
    prefixes: normalizedPrefixes.sort((left, right) => left.domain.localeCompare(right.domain) || left.prefix.localeCompare(right.prefix)),
  };
}

async function deleteAndVerifyPrefix({ r2, runState, runStatePath, prefixEntry, adapters }) {
  const prefix = `${prefixEntry.prefix}/`;
  prefixEntry.entry.remote_attempted = true;
  prefixEntry.entry.status = "deleting";
  atomicWriteJson(runStatePath, runState);
  try {
    const entries = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    const keys = entries.map((entry) => safeKey(entry.key)).filter((key) => key.startsWith(prefix)).sort();
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      const result = await adapters.deleteObjects({ r2, keys: batch });
      if (Array.isArray(result?.errors) && result.errors.length) {
        throw new Error(`R2 prefix delete returned errors for ${prefixEntry.prefix}: ${JSON.stringify(result.errors)}`);
      }
    }
    const remaining = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    if (remaining.length) throw new Error(`R2 prefix deletion verification failed: ${prefixEntry.prefix}`);
    Object.assign(prefixEntry.entry, {
      deleted: true,
      deletion_verified: true,
      remote_completed: true,
      completed_at_utc: new Date().toISOString(),
      deleted_object_count: keys.length,
      deleted_object_keys: keys,
      status: "deletion_verified",
    });
    atomicWriteJson(runStatePath, runState);
    return keys.length;
  } catch (error) {
    Object.assign(prefixEntry.entry, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

async function putAndVerifyObject({ r2, runState, runStatePath, object, adapters }) {
  const entry = object.entry;
  Object.assign(entry, { remote_attempted: true, status: "uploading" });
  atomicWriteJson(runStatePath, runState);
  try {
    await adapters.putObject({ r2, key: object.key, body: object.body, content_type: contentTypeForKey(object.key) });
    Object.assign(entry, { uploaded: true, uploaded_at_utc: new Date().toISOString(), status: "uploaded" });
    atomicWriteJson(runStatePath, runState);
    const fresh = await adapters.getObject({ r2, key: object.key });
    if (Number(fresh.bytes) !== object.body.byteLength || sha256Hex(fresh.body) !== entry.sha256) {
      throw new Error(`R2 GET verification identity mismatch: ${object.key}`);
    }
    Object.assign(entry, {
      r2_verified: true,
      r2_verified_at_utc: new Date().toISOString(),
      remote_completed: true,
      status: "get_verified",
    });
    atomicWriteJson(runStatePath, runState);
  } catch (error) {
    Object.assign(entry, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

function parquetIso(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid observation Parquet timestamp");
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid observation Parquet timestamp");
  return parsed.toISOString();
}

async function readCanonicalObservationRows({ body, connectorId }) {
  const file = new Uint8Array(body).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Number(metadata.num_rows || 0);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
    throw new Error("Repaired observation Parquet must contain rows");
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
    throw new Error(`Repaired observation Parquet is missing canonical columns: ${missing.join(",")}`);
  }
  const statusColumn = schemaColumns.has("verification_status")
    ? "verification_status"
    : schemaColumns.has("status")
    ? "status"
    : null;
  const columns = [...required, ...(statusColumn ? [statusColumn] : [])];
  let decodedRows = [];
  await parquetRead({
    file,
    metadata,
    columns,
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (rows) => {
      decodedRows = Array.isArray(rows) ? rows : [];
    },
  });
  if (decodedRows.length !== rowCount) {
    throw new Error("Repaired observation Parquet row count changed while reading");
  }
  const sosConnectorId = Number.parseInt(
    process.env.UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK || "1",
    10,
  );
  return decodedRows.map((values) => {
    if (!Array.isArray(values)) throw new Error("Invalid repaired observation Parquet row");
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
        isSos: connectorId === sosConnectorId,
      }),
    });
  });
}

async function verifyLiveObservationPartition({
  r2,
  runState,
  runStatePath,
  object,
  adapters,
}) {
  const match = object.key.match(CANONICAL_OBSERVATION_POLLUTANT_MANIFEST_PATTERN);
  if (!match) return;
  const [, dayUtc, connectorIdRaw, pollutantCode] = match;
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(object.body));
  } catch {
    throw new Error(`Proposed observation pollutant manifest is not valid JSON: ${object.key}`);
  }
  const connectorId = Number(connectorIdRaw);
  if (
    manifest?.day_utc !== dayUtc ||
    Number(manifest?.connector_id) !== connectorId ||
    manifest?.pollutant_code !== pollutantCode
  ) {
    throw new Error(`Proposed observation pollutant manifest scope mismatch: ${object.key}`);
  }
  validateObservationContentHashMetadata(manifest, {
    rowCount: Number(manifest.source_row_count),
  });
  const partKeys = Array.isArray(manifest.parquet_object_keys)
    ? manifest.parquet_object_keys.map(safeKey)
    : [];
  if (!partKeys.length || partKeys.some((key) =>
    !key.startsWith(object.key.slice(0, -"/manifest.json".length) + "/") ||
    !key.endsWith(".parquet")
  )) {
    throw new Error(`Proposed observation pollutant manifest has invalid Parquet keys: ${object.key}`);
  }
  const canonicalRows = [];
  for (const key of partKeys) {
    const live = await adapters.getObject({ r2, key });
    canonicalRows.push(...await readCanonicalObservationRows({
      body: live.body,
      connectorId,
    }));
  }
  const liveMetadata = computeObservationContentHash(canonicalRows);
  if (
    liveMetadata.observation_content_hash !== manifest.observation_content_hash ||
    liveMetadata.observation_content_hash_row_count !==
      manifest.observation_content_hash_row_count ||
    ["P", "R", "null"].some((key) =>
      liveMetadata.verification_status_counts[key] !==
        manifest.verification_status_counts[key]
    )
  ) {
    throw new Error(
      `Live repaired observation content does not match source truth: day=${dayUtc} connector=${connectorId} pollutant=${pollutantCode}`,
    );
  }
  Object.assign(object.entry, {
    live_observation_content_verified: true,
    live_observation_content_verified_at_utc: new Date().toISOString(),
    live_observation_content_hash: liveMetadata.observation_content_hash,
    live_verification_status_counts: liveMetadata.verification_status_counts,
  });
  atomicWriteJson(runStatePath, runState);
}

async function prepareMergedDayManifest({ r2, object, adapters }) {
  if (!/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(object.key)) return;
  const proposed = JSON.parse(object.body.toString("utf8"));
  const dayPrefix = object.key.slice(0, -"manifest.json".length);
  const currentRead = await readParentManifestForBoundedRecovery({
    getObject: adapters.getObject,
    r2,
    key: object.key,
    validate: (current) => {
      validateCanonicalHistoryV2Manifest(current, {
        history_version: "v2",
        domain: proposed.domain,
        grain: proposed.grain ?? null,
        profile: proposed.profile ?? null,
        manifest_kind: "day",
        day_utc: proposed.day_utc,
        manifest_key: object.key,
      });
      const values = Array.isArray(current?.connector_manifests)
        ? current.connector_manifests
        : Array.isArray(current?.child_manifests) ? current.child_manifests : null;
      if (!values) throw new Error("Current day manifest has no connector references");
      const references = values.map((entry) => ({
        connector_id: Number(entry.connector_id),
        manifest_key: String(entry.manifest_key || ""),
      }));
      if (references.some((entry) =>
        !Number.isInteger(entry.connector_id) || entry.connector_id <= 0 ||
        !entry.manifest_key.startsWith(dayPrefix) ||
        !entry.manifest_key.endsWith(`/connector_id=${entry.connector_id}/manifest.json`)
      )) {
        throw new Error("Current day manifest has invalid connector references");
      }
      return references;
    },
  });
  let currentReferences = currentRead.state === "valid" ? currentRead.value : [];
  if (currentRead.state !== "valid") {
    const discovered = await adapters.listAllObjects({ r2, prefix: dayPrefix, max_keys: 10_000 });
    currentReferences = discovered.flatMap((entry) => {
      const key = String(entry.key || "");
      const match = key.match(/\/connector_id=([1-9]\d*)\/manifest\.json$/);
      return match ? [{ connector_id: Number(match[1]), manifest_key: key }] : [];
    });
  }
  const references = (manifest) => {
    const values = Array.isArray(manifest?.connector_manifests)
      ? manifest.connector_manifests
      : Array.isArray(manifest?.child_manifests) ? manifest.child_manifests : [];
    return values.map((entry) => ({ connector_id: Number(entry.connector_id), manifest_key: String(entry.manifest_key || "") }));
  };
  const mergedReferences = mergeConnectorManifestReferences(currentReferences, references(proposed));
  const connectorManifests = [];
  for (const reference of mergedReferences) {
    const child = JSON.parse((await adapters.getObject({ r2, key: reference.manifest_key })).body.toString("utf8"));
    validateCanonicalHistoryV2Manifest(child, {
      history_version: "v2",
      domain: proposed.domain,
      manifest_kind: "connector",
      day_utc: proposed.day_utc,
      connector_id: reference.connector_id,
      manifest_key: reference.manifest_key,
    });
    connectorManifests.push({ ...child, manifest_key: reference.manifest_key });
  }
  const merged = buildHistoryV2DayManifest({
    domain: proposed.domain,
    grain: proposed.grain ?? null,
    profile: proposed.profile ?? null,
    dayUtc: proposed.day_utc,
    runId: proposed.run_id,
    manifestKey: object.key,
    connectorManifests,
    writerGitSha: proposed.writer_git_sha ?? null,
    backedUpAtUtc: proposed.backed_up_at_utc ?? new Date().toISOString(),
  });
  validateCanonicalHistoryV2Manifest(merged, {
    domain: proposed.domain,
    manifest_kind: "day",
    day_utc: proposed.day_utc,
  });
  object.body = Buffer.from(JSON.stringify(merged, null, 2), "utf8");
  Object.assign(object.entry, {
    bytes: object.body.byteLength,
    sha256: sha256Hex(object.body),
    day_finalizer_regenerated_from_live_connectors: true,
    merged_connector_ids: mergedReferences.map((entry) => entry.connector_id),
  });
}

export async function applyValidatedProposal({ runStatePath, r2, adapters = {} }) {
  const resolvedAdapters = {
    deleteObjects: adapters.deleteObjects || r2DeleteObjects,
    getObject: adapters.getObject || r2GetObject,
    listAllObjects: adapters.listAllObjects || r2ListAllObjects,
    putObject: adapters.putObject || r2PutObject,
  };
  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  const proposal = validateLocalProposal(runState);
  const counts = { planned_deletions: proposal.prefixes.length, planned_writes: proposal.objects.length, deleted_objects: 0, completed_deletions: 0, completed_writes: 0, get_verified_writes: 0 };
  runState.apply = { status: "running", started_at_utc: new Date().toISOString(), ...counts };
  runState.writer_locks = [];
  atomicWriteJson(runStatePath, runState);
  try {
    const historyWriterClient = adapters.historyWriterClient;
    if (!historyWriterClient) throw new Error("canonical apply requires one retained PostgreSQL history-writer session");
    const operations = [];
    for (const domain of ["observations", "aqilevels"]) {
      for (const prefixEntry of proposal.prefixes.filter((entry) => entry.domain === domain)) {
        operations.push({ kind: "delete", key: prefixEntry.prefix, prefixEntry });
      }
      for (const object of proposal.objects.filter((entry) => entry.domain === domain)) {
        operations.push({ kind: "put", key: object.key, object });
      }
    }
    const connectorGroups = new Map();
    const dayGroups = new Map();
    const globalOperations = [];
    for (const operation of operations) {
      const connectorMatch = operation.key.match(/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)/);
      const dayMatch = operation.key.match(/day_utc=(\d{4}-\d{2}-\d{2})/);
      if (connectorMatch) {
        const groupKey = `${connectorMatch[1]}|${connectorMatch[2]}`;
        if (!connectorGroups.has(groupKey)) connectorGroups.set(groupKey, { day_utc: connectorMatch[1], connector_id: Number(connectorMatch[2]), operations: [] });
        connectorGroups.get(groupKey).operations.push(operation);
      } else if (dayMatch) {
        if (!dayGroups.has(dayMatch[1])) dayGroups.set(dayMatch[1], []);
        dayGroups.get(dayMatch[1]).push(operation);
      } else {
        globalOperations.push(operation);
      }
    }
    const executeOperation = async (operation) => {
      if (operation.kind === "delete") {
        const { prefixEntry } = operation;
        counts.deleted_objects += await deleteAndVerifyPrefix({ r2, runState, runStatePath, prefixEntry, adapters: resolvedAdapters });
        counts.completed_deletions += 1;
      } else {
        const { object } = operation;
        await verifyLiveObservationPartition({
          r2,
          runState,
          runStatePath,
          object,
          adapters: resolvedAdapters,
        });
        await putAndVerifyObject({ r2, runState, runStatePath, object, adapters: resolvedAdapters });
        counts.completed_writes += 1;
        counts.get_verified_writes += 1;
      }
      atomicWriteJson(runStatePath, runState);
    };
    for (const group of Array.from(connectorGroups.values()).sort((left, right) =>
      left.day_utc.localeCompare(right.day_utc) || left.connector_id - right.connector_id)) {
      await runCanonicalConnectorDayWriter({
        client: historyWriterClient,
        dayUtc: group.day_utc,
        connectorId: group.connector_id,
        diagnosticEnvironment: runState.environment,
        diagnostics: runState.writer_locks,
        write: async () => {
          for (const operation of group.operations) await executeOperation(operation);
          return { operation_count: group.operations.length };
        },
        verify: async (written) => ({ ...written, get_verified: true }),
      });
    }
    for (const [dayUtc, dayOperations] of Array.from(dayGroups.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      await runCanonicalDayFinalizer({
        client: historyWriterClient,
        dayUtc,
        diagnosticEnvironment: runState.environment,
        diagnostics: runState.writer_locks,
        finalize: async () => {
        for (const operation of dayOperations) {
          if (operation.kind === "put") {
            await prepareMergedDayManifest({ r2, object: operation.object, adapters: resolvedAdapters });
          }
          await executeOperation(operation);
        }
          return { operation_count: dayOperations.length };
        },
      });
    }
    const affectedDays = Array.from(new Set([
      ...Array.from(connectorGroups.values()).map((group) => group.day_utc),
      ...dayGroups.keys(),
    ])).sort();
    if (globalOperations.length || affectedDays.length) {
      await runCanonicalGlobalIndexFinalizer({
        client: historyWriterClient,
        diagnosticEnvironment: runState.environment,
        diagnostics: runState.writer_locks,
        finalize: async () => {
        for (const operation of globalOperations) await executeOperation(operation);
        if (affectedDays.length) {
          runState.global_index_finalization = await updateR2HistoryIndexesTargeted({
            env: process.env,
            r2,
            historyVersion: "v2",
            domains: ["observations", "aqilevels"],
            affectedDaysUtc: affectedDays,
            connectorId: null,
            updateLatestIndex: true,
            strictMissingTimeseriesCounts: true,
            writeR2: true,
          });
        }
        },
      });
    }
    runState.apply = { ...runState.apply, ...counts, status: "succeeded", finished_at_utc: new Date().toISOString() };
    atomicWriteJson(runStatePath, runState);
    return { ok: true, status: "succeeded", ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runState.apply = { ...runState.apply, ...counts, status: "failed", error: message, finished_at_utc: new Date().toISOString() };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStatePath = path.resolve(args.runStateJson);
  const config = resolveR2HistoryIndexConfig(process.env);
  if (!hasRequiredR2Config(config.r2)) throw new Error("canonical apply requires complete R2 configuration");
  if (config.r2.bucket !== TEST_BUCKET) throw new Error(`Refusing canonical apply for non-TEST bucket: ${config.r2.bucket || "(unset)"}`);
  return await withHistoryWriterClient(
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    async (historyWriterClient) => await applyValidatedProposal({
      runStatePath,
      r2: config.r2,
      adapters: { historyWriterClient },
    }),
    { applicationName: "uk-aq-integrity-history-writer" },
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
