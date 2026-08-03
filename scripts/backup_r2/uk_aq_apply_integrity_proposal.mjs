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
  computeEmptyObservationContentHash,
  computeObservationContentHash,
  encodeCanonicalObservationRow,
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
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  compressors,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} from "./lib/uk_aq_parquet_dependencies.mjs";

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
  atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function atomicWriteBuffer(filePath, body) {
  const temporaryPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "w", 0o600);
    let offset = 0;
    while (offset < body.byteLength) {
      const written = fs.writeSync(descriptor, body, offset, body.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error(`Atomic write made no progress: ${filePath}`);
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
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

export function publicationRank(key) {
  const value = String(key || "");
  if (/^history\/v2\/observations\/.+\.parquet$/.test(value)) return 10;
  if (/^history\/v2\/observations\/.+\/pollutant_code=[^/]+\/manifest\.json$/.test(value)) return 20;
  if (/^history\/v2\/observations\/.+\/connector_id=\d+\/manifest\.json$/.test(value)) return 30;
  if (/^history\/_index_v2\/observations_.+/.test(value)) return 40;
  if (/^history\/v2\/aqilevels\/.+\.parquet$/.test(value)) return 50;
  if (/^history\/v2\/aqilevels\/.+\/pollutant_code=[^/]+\/manifest\.json$/.test(value)) return 60;
  if (/^history\/v2\/aqilevels\/.+\/connector_id=\d+\/manifest\.json$/.test(value)) return 70;
  if (/^history\/_index_v2\/aqilevels_.+/.test(value)) return 80;
  if (/^history\/v2\/observations\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(value)) return 90;
  if (/^history\/v2\/aqilevels\/.+\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(value)) return 100;
  if (value.includes("latest") || value.startsWith("history/_index_v2/")) return 120;
  return 110;
}

export const APPLY_PROGRESS_CHECKPOINT_OBJECT_INTERVAL = 50;
export const APPLY_PROGRESS_CHECKPOINT_ELAPSED_MS = 30_000;
export const APPLY_PROGRESS_LOG_OBJECT_INTERVAL = 50;
export const APPLY_PROGRESS_LOG_ELAPSED_MS = 30_000;
export const MUTATION_EVENT_HASH_CONTRACT_VERSION = "integrity-apply-mutation-event-v1";
export const PUBLICATION_SCHEDULE_CONTRACT_VERSION = "integrity-apply-publication-schedule-v1";

function recursivelySortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : recursivelySortJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, recursivelySortJsonValue(value[key])]));
  }
  return value;
}

function bytewiseKeyCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function publicationStageRank(stage) {
  const value = String(stage || "");
  if (value === "latest_snapshot") return 1000;
  if (value.includes("index")) return 900;
  if (value === "day_parent" || value.includes("day_manifest")) return 800;
  if (value.includes("connector") && value.includes("manifest")) return 700;
  if (value.includes("pollutant") && value.includes("manifest")) return 600;
  if (value.includes("parquet") || value.includes("data") || value.includes("baseline")) return 500;
  return 750;
}

function scheduleScope(object, selectedDays, publicationMode) {
  if (publicationMode === "generic") {
    if (objectPublicationStage(object) === "latest_snapshot") return [3, 0, 0];
    if (object.key.startsWith("history/_index_v2/")) return [2, 0, 0];
    const context = mutationContext(object.key);
    const dayIndex = context.day_utc ? selectedDays.indexOf(context.day_utc) : -1;
    if (dayIndex < 0) return [2, 0, 0];
    if (context.connector_id) return [0, dayIndex, context.connector_id];
    return [1, dayIndex, 0];
  }
  if (objectPublicationStage(object) === "latest_snapshot") return [selectedDays.length, 3, 0];
  if (object.key.startsWith("history/_index_v2/")) return [selectedDays.length, 2, 0];
  const context = mutationContext(object.key);
  const dayUtc = context.day_utc;
  const dayIndex = dayUtc ? selectedDays.indexOf(dayUtc) : -1;
  if (dayIndex < 0) return [selectedDays.length, 1, 0];
  if (context.connector_id) return [dayIndex, 0, context.connector_id];
  return [dayIndex, 1, 0];
}

function compareScheduleScope(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function assertNoPlaceholderGeneratedParent(object) {
  if ((object.entry.dependencies || []).length > 0) return;
  let payload;
  try {
    payload = JSON.parse(object.body.toString("utf8"));
  } catch {
    return;
  }
  const containsParentReferences = [
    payload?.day_summaries,
    payload?.child_manifests,
    payload?.connector_manifests,
    payload?.pollutant_manifests,
  ].some((value) => Array.isArray(value) && value.length > 0)
    || typeof payload?.pollutant_manifest_key === "string"
    || typeof payload?.connector_pollutant_manifest_key === "string";
  if (containsParentReferences) {
    throw new Error(`Generated parent has placeholder dependencies: ${object.key}`);
  }
}

export function canonicalPublicationScheduleHashInput(schedule) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error("Publication schedule hash input must be an object");
  }
  const { schedule_sha256: _excludedScheduleSha256, ...hashFields } = schedule;
  return Buffer.from(JSON.stringify(recursivelySortJsonValue(hashFields)), "utf8");
}

export function buildFrozenPublicationSchedule({
  proposal,
  selectedDays = [],
  publicationMode = "generic",
  runState = null,
}) {
  if (!["generic", "sos_light"].includes(publicationMode)) {
    throw new Error(`Unsupported publication schedule mode: ${publicationMode}`);
  }
  const objects = proposal?.objects || [];
  const byKey = new Map(objects.map((object) => [object.key, object]));
  if (byKey.size !== objects.length) throw new Error("Publication schedule contains duplicate object keys");
  const dayOrder = [...new Set(selectedDays)].sort();
  const indegree = new Map(objects.map((object) => [object.key, 0]));
  const outgoing = new Map(objects.map((object) => [object.key, []]));
  const externalDependencyCounts = {};
  let edgeCount = 0;
  for (const object of objects) {
    assertNoPlaceholderGeneratedParent(object);
    const canonicalIdentities = canonicalDependencyIdentities(object.entry);
    const dependencies = canonicalIdentities.map((identity) => identity.key);
    for (const dependencyKey of dependencies) {
      const dependency = byKey.get(dependencyKey);
      const identity = dependencyIdentity(object.entry, dependencyKey);
      if (!dependency) {
        validateExternalDependencyRoot({
          runState,
          objectKey: object.key,
          dependencyKey,
          identity,
        });
        externalDependencyCounts[identity.source] = (externalDependencyCounts[identity.source] || 0) + 1;
        continue;
      }
      const dependencyStage = objectPublicationStage(dependency);
      const parentStage = objectPublicationStage(object);
      const dependencyScope = scheduleScope(dependency, dayOrder, publicationMode);
      const parentScope = scheduleScope(object, dayOrder, publicationMode);
      const scopeComparison = compareScheduleScope(dependencyScope, parentScope);
      if (scopeComparison > 0
        || (scopeComparison === 0
          && publicationStageRank(dependencyStage) > publicationStageRank(parentStage))) {
        throw new Error(`Publication stage conflict: ${dependencyKey} (${dependencyStage}) -> ${object.key} (${parentStage})`);
      }
      outgoing.get(dependencyKey).push(object.key);
      indegree.set(object.key, indegree.get(object.key) + 1);
      edgeCount += 1;
    }
  }
  const ordered = [];
  const scheduledKeys = new Set();
  const eligibleCompare = (left, right) => compareScheduleScope(
    scheduleScope(left, dayOrder, publicationMode),
    scheduleScope(right, dayOrder, publicationMode),
  )
      || publicationStageRank(objectPublicationStage(left)) - publicationStageRank(objectPublicationStage(right))
      || bytewiseKeyCompare(left.key, right.key);
  const eligible = objects.filter((object) => indegree.get(object.key) === 0);
  eligible.sort((left, right) => -eligibleCompare(left, right));
  while (eligible.length) {
    const next = eligible.pop();
    ordered.push(next);
    scheduledKeys.add(next.key);
    let addedEligible = false;
    for (const parentKey of outgoing.get(next.key)) {
      indegree.set(parentKey, indegree.get(parentKey) - 1);
      if (indegree.get(parentKey) === 0) {
        eligible.push(byKey.get(parentKey));
        addedEligible = true;
      }
    }
    if (addedEligible) eligible.sort((left, right) => -eligibleCompare(left, right));
  }
  if (ordered.length !== objects.length) {
    const cycleKeys = objects.filter((object) => !scheduledKeys.has(object.key)).map((object) => object.key).sort(bytewiseKeyCompare);
    throw new Error(`Publication dependency cycle: ${cycleKeys.join(" -> ")}`);
  }
  const perStageCounts = {};
  const entries = ordered.map((object, index) => {
    const stage = objectPublicationStage(object);
    perStageCounts[stage] = (perStageCounts[stage] || 0) + 1;
    const canonicalIdentities = canonicalDependencyIdentities(object.entry);
    const dependencies = canonicalIdentities.map((identity) => identity.key);
    return {
      position: index + 1,
      canonical_key: object.key,
      proposed_sha256: object.entry.sha256,
      proposed_bytes: Number(object.entry.bytes),
      publication_stage: stage,
      direct_changed_dependencies: dependencies.filter((key) => byKey.has(key)),
      dependencies,
      dependency_identities: Object.fromEntries(canonicalIdentities.map(({ key, ...identity }) => [key, identity])),
      canonical_dependency_identities: canonicalIdentities,
    };
  });
  const schedule = {
    contract_version: PUBLICATION_SCHEDULE_CONTRACT_VERSION,
    publication_mode: publicationMode,
    tie_breaker: "bytewise_utf8_key_among_eligible_nodes",
    day_barrier_order: dayOrder,
    total_positions: entries.length,
    changed_dependency_edge_count: edgeCount,
    external_dependency_counts: externalDependencyCounts,
    per_stage_counts: perStageCounts,
    entries,
  };
  return { ...schedule, schedule_sha256: sha256Hex(canonicalPublicationScheduleHashInput(schedule)) };
}

export function canonicalMutationEventHashInput(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Mutation journal event hash input must be an object");
  }
  const { event_sha256: _excludedEventSha256, ...hashFields } = event;
  return Buffer.from(JSON.stringify(recursivelySortJsonValue(hashFields)), "utf8");
}

export function createInitialApplyProgressState({ runStatePath, runId, counts, selectedDays, schedule = null }) {
  const perDayStatus = Object.fromEntries(selectedDays.map((dayUtc) => [dayUtc, {
    day_utc: dayUtc,
    status: "not_started",
    completed_publication_level: "none",
    deletion_verified: false,
    day_parent_verified: false,
  }]));
  return {
    perDayStatus,
    progressState: {
      schema_version: 1,
      run_id: runId,
      status: "running",
      current_phase: "final_proposal_validated",
      current_day_utc: null,
      last_completed_day_utc: null,
      ...counts,
      current_object_key: null,
      current_deletion_prefix: null,
      current_publication_stage: "final_proposal_validation",
      publication_schedule_sha256: schedule?.schedule_sha256 || null,
      scheduled_changed_object_count: Number(schedule?.total_positions || 0),
      completed_scheduled_object_count: 0,
      last_completed_schedule_position: 0,
      next_schedule_position: Number(schedule?.total_positions || 0) ? 1 : null,
      index_publication_started: false,
      index_publication_completed: false,
      last_checkpoint_at_utc: null,
      mutation_journal_path: path.join(
        path.dirname(path.resolve(runStatePath)),
        "apply-mutation-events.jsonl",
      ),
      mutation_journal_event_count: 0,
      per_day_high_level_publication_status: perDayStatus,
      deletions: [],
    },
  };
}

function mutationContext(keyOrPrefix, stage = null) {
  const value = String(keyOrPrefix || "");
  const dayMatch = value.match(/day_utc=(\d{4}-\d{2}-\d{2})/);
  const connectorMatch = value.match(/connector_id=([1-9]\d*)/);
  return {
    day_utc: dayMatch ? dayMatch[1] : null,
    connector_id: connectorMatch ? Number(connectorMatch[1]) : null,
    publication_stage: stage || null,
  };
}

function objectPublicationStage(object) {
  const configured = String(object?.entry?.stage || "").trim();
  if (configured) return configured;
  const rank = publicationRank(object?.key);
  if (rank <= 10) return "observation_parquet";
  if (rank <= 20) return "observation_pollutant_manifest";
  if (rank <= 30) return "observation_connector_manifest";
  if (rank <= 40) return "observation_index";
  if (rank <= 50) return "aqi_parquet";
  if (rank <= 70) return "aqi_manifest";
  if (rank <= 100) return "day_parent";
  return "global_index";
}

export function createApplyPersistence({
  runStatePath,
  runId,
  progressState,
  io = {},
}) {
  if (!String(runId ?? "").trim()) throw new Error("Apply persistence requires run_id");
  const runRoot = path.dirname(path.resolve(runStatePath));
  const progressPath = path.join(runRoot, "apply-progress.json");
  const journalPath = path.join(runRoot, "apply-mutation-events.jsonl");
  const deletionDirectory = path.join(runRoot, "apply-evidence", "deletions");
  const openSync = io.openSync || fs.openSync;
  const writeSync = io.writeSync || fs.writeSync;
  const fsyncSync = io.fsyncSync || fs.fsyncSync;
  const closeSync = io.closeSync || fs.closeSync;
  const atomicJson = io.atomicWriteJson || atomicWriteJson;
  const atomicBuffer = io.atomicWriteBuffer || atomicWriteBuffer;
  const readFileSync = io.readFileSync || fs.readFileSync;
  fs.mkdirSync(deletionDirectory, { recursive: true });
  const descriptor = openSync(journalPath, "wx", 0o600);
  let journalDescriptor = descriptor;
  let eventCount = 0;
  let durableEventCount = 0;
  let journalBytes = 0;
  let durableJournalBytes = 0;
  let tailEventSha256 = null;
  let durableTailEventSha256 = null;
  let flushCount = 0;
  let checkpointCount = 0;
  let sidecarCount = 0;
  let journalFailure = null;
  let finalJournalSha256 = null;
  const sidecars = [];

  const snapshot = () => ({
    compact_checkpoint_count: checkpointCount,
    complete_run_state_write_count: 0,
    node_complete_run_state_write_count: 0,
    coordinator_complete_run_state_write_count: 0,
    total_complete_run_state_write_count: 0,
    mutation_journal_event_count: eventCount,
    mutation_journal_flush_count: flushCount,
    deleted_key_sidecar_count: sidecarCount,
    mutation_journal_path: journalPath,
    mutation_journal_bytes: journalBytes,
    mutation_journal_sha256: finalJournalSha256,
    mutation_journal_tail_event_sha256: tailEventSha256,
    mutation_journal_durable_event_count: durableEventCount,
    mutation_journal_durable_bytes: durableJournalBytes,
    mutation_journal_durable_tail_event_sha256: durableTailEventSha256,
    mutation_journal_failure: journalFailure,
    apply_progress_path: progressPath,
    deletion_sidecars: sidecars.map((entry) => ({ ...entry })),
  });

  const appendEvent = (event) => {
    if (journalDescriptor === null) throw new Error("Mutation journal is closed");
    if (journalFailure) throw new Error(`Mutation journal is unusable: ${journalFailure}`);
    const baseEvent = {
      event_type: String(event?.event_type || ""),
      timestamp_utc: new Date().toISOString(),
      ...event,
      run_id: runId,
      event_hash_contract_version: MUTATION_EVENT_HASH_CONTRACT_VERSION,
      previous_event_sha256: tailEventSha256,
    };
    if (!baseEvent.event_type) throw new Error("Mutation journal event_type is required");
    const identityBody = canonicalMutationEventHashInput(baseEvent);
    const eventSha256 = sha256Hex(identityBody);
    const line = Buffer.from(`${JSON.stringify({ ...baseEvent, event_sha256: eventSha256 })}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < line.byteLength) {
        const written = writeSync(journalDescriptor, line, offset, line.byteLength - offset);
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new Error("Mutation journal append made no progress");
        }
        offset += written;
      }
    } catch (error) {
      journalFailure = error instanceof Error ? error.message : String(error);
      throw new Error(`Mutation journal append failed: ${journalFailure}`, { cause: error });
    }
    eventCount += 1;
    journalBytes += line.byteLength;
    tailEventSha256 = eventSha256;
    return { event_count: eventCount, event_sha256: eventSha256 };
  };

  const flush = () => {
    if (journalDescriptor === null) throw new Error("Mutation journal is closed");
    if (journalFailure) throw new Error(`Mutation journal is unusable: ${journalFailure}`);
    try {
      fsyncSync(journalDescriptor);
    } catch (error) {
      journalFailure = error instanceof Error ? error.message : String(error);
      throw new Error(`Mutation journal durability barrier failed: ${journalFailure}`, { cause: error });
    }
    flushCount += 1;
    durableEventCount = eventCount;
    durableJournalBytes = journalBytes;
    durableTailEventSha256 = tailEventSha256;
    return snapshot();
  };

  const checkpoint = (reason) => {
    const nextCheckpointCount = checkpointCount + 1;
    const checkpointState = {
      ...progressState,
      last_checkpoint_at_utc: new Date().toISOString(),
      last_checkpoint_reason: String(reason || "progress"),
      mutation_journal_path: journalPath,
      mutation_journal_event_count: eventCount,
      mutation_journal_bytes: journalBytes,
      mutation_journal_sha256: finalJournalSha256,
      mutation_journal_tail_event_sha256: tailEventSha256,
      mutation_journal_durable_event_count: durableEventCount,
      mutation_journal_durable_bytes: durableJournalBytes,
      mutation_journal_durable_tail_event_sha256: durableTailEventSha256,
      compact_checkpoint_count: nextCheckpointCount,
      mutation_journal_flush_count: flushCount,
      deleted_key_sidecar_count: sidecarCount,
      deletion_sidecars: sidecars.map((entry) => ({ ...entry })),
    };
    atomicJson(progressPath, checkpointState);
    Object.assign(progressState, checkpointState);
    checkpointCount = nextCheckpointCount;
    return progressState;
  };

  const writeDeletedKeysSidecar = ({ prefix, keys }) => {
    const sortedKeys = [...keys].map(safeKey).sort();
    const prefixHash = sha256Hex(Buffer.from(String(prefix), "utf8")).slice(0, 16);
    const day = mutationContext(prefix).day_utc || "no-day";
    const sidecarPath = path.join(deletionDirectory, `${day}-${prefixHash}.json`);
    const body = Buffer.from(`${JSON.stringify(sortedKeys)}\n`, "utf8");
    atomicBuffer(sidecarPath, body);
    const persisted = readFileSync(sidecarPath);
    const identity = {
      prefix: String(prefix).replace(/\/+$/, ""),
      deleted_object_count: sortedKeys.length,
      deleted_keys_sha256: sha256Hex(body),
      deleted_keys_sidecar_path: sidecarPath,
      deleted_keys_sidecar_bytes: body.byteLength,
    };
    if (persisted.byteLength !== identity.deleted_keys_sidecar_bytes
      || sha256Hex(persisted) !== identity.deleted_keys_sha256) {
      throw new Error(`Deleted-key sidecar verification failed: ${prefix}`);
    }
    sidecars.push(identity);
    sidecarCount += 1;
    return identity;
  };

  const close = () => {
    if (journalDescriptor === null) return snapshot();
    flush();
    const descriptorToClose = journalDescriptor;
    journalDescriptor = null;
    try {
      closeSync(descriptorToClose);
    } catch (error) {
      journalFailure = error instanceof Error ? error.message : String(error);
      throw new Error(`Mutation journal close failed: ${journalFailure}`, { cause: error });
    }
    const journalBody = readFileSync(journalPath);
    if (journalBody.byteLength !== journalBytes) {
      throw new Error(`Mutation journal byte-length verification failed: ${journalPath}`);
    }
    finalJournalSha256 = sha256Hex(journalBody);
    return snapshot();
  };

  const closeAfterFailure = () => {
    if (journalDescriptor !== null) {
      if (!journalFailure) {
        try {
          flush();
        } catch {
          // Continue to close and retain whatever journal bytes reached disk.
        }
      }
      const descriptorToClose = journalDescriptor;
      journalDescriptor = null;
      try {
        closeSync(descriptorToClose);
      } catch (error) {
        journalFailure ||= error instanceof Error ? error.message : String(error);
      }
    }
    try {
      const journalBody = readFileSync(journalPath);
      finalJournalSha256 = sha256Hex(journalBody);
      journalBytes = journalBody.byteLength;
    } catch (error) {
      journalFailure ||= error instanceof Error ? error.message : String(error);
    }
    return snapshot();
  };

  return {
    progressPath,
    journalPath,
    appendEvent,
    flush,
    checkpoint,
    writeDeletedKeysSidecar,
    close,
    closeAfterFailure,
    snapshot,
  };
}

export function createBoundedProgressReporter({
  log,
  now = () => Date.now(),
  objectInterval = APPLY_PROGRESS_LOG_OBJECT_INTERVAL,
  elapsedMs = APPLY_PROGRESS_LOG_ELAPSED_MS,
} = {}) {
  let lastLoggedCompleted = 0;
  let lastLoggedAt = now();
  return ({ message, completedObjects = 0, force = false }) => {
    const currentTime = now();
    if (!force
      && completedObjects - lastLoggedCompleted < objectInterval
      && currentTime - lastLoggedAt < elapsedMs) return false;
    (log || ((line) => process.stderr.write(`[canonical-apply] ${line}\n`)))(message);
    lastLoggedCompleted = completedObjects;
    lastLoggedAt = currentTime;
    return true;
  };
}

export function createCanonicalGeneratedIndexMutationAdapter({
  r2,
  runState,
  persistence,
  executeOperation,
}) {
  const audit = runState.apply.generated_generic_index_objects ||= {};
  const schedule = runState.apply.publication_schedule;
  const scheduleByKey = new Map((schedule?.entries || []).map((entry) => [entry.canonical_key, entry]));
  return {
    audit,
    r2: {
      ...r2,
      proposal_sink: async (generated) => {
        const key = safeKey(generated?.key);
        const body = Buffer.from(String(generated?.body ?? ""), "utf8");
        const changed = generated?.status !== "skipped_unchanged";
        if (changed && !scheduleByKey.has(key)) {
          throw new Error(`Generated callback attempted unscheduled changed key: ${key}`);
        }
        audit[key] = {
          proposed: true,
          built: true,
          structurally_validated: true,
          changed,
          status: String(generated?.status || "planned"),
          bytes: body.byteLength,
          sha256: sha256Hex(body),
          content_type: String(generated?.content_type || contentTypeForKey(key)),
          included_in_write_set: changed,
          publication_stage: scheduleByKey.get(key)?.publication_stage || null,
        };
        await r2?.proposal_sink?.(generated);
      },
      canonical_mutation_sink: async (generated) => {
        const key = safeKey(generated?.key);
        const body = Buffer.from(String(generated?.body ?? ""), "utf8");
        const sha256 = sha256Hex(body);
        const scheduled = scheduleByKey.get(key);
        if (!scheduled) throw new Error(`Generated callback attempted unscheduled changed key: ${key}`);
        if (body.byteLength !== Number(generated?.bytes) || sha256 !== generated?.sha256
          || body.byteLength !== scheduled.proposed_bytes || sha256 !== scheduled.proposed_sha256) {
          throw new Error(`Generated generic index identity mismatch: ${key}`);
        }
        if (audit[key]?.status === "succeeded") {
          throw new Error(`Generated generic index was published more than once: ${key}`);
        }
        const entry = runState.objects?.[key];
        if (!entry) throw new Error(`Frozen generated proposal is unavailable: ${key}`);
        const callbackSuppliedDependencyContract = Object.hasOwn(generated, "dependencies")
          || Object.hasOwn(generated, "dependency_identities");
        if (callbackSuppliedDependencyContract) {
          if (!Object.hasOwn(generated, "dependencies")
            || !Object.hasOwn(generated, "dependency_identities")) {
            throw new Error(`Generated generic index dependency identities are incomplete: ${key}`);
          }
          assertFrozenScheduleOperation({
            object: {
              key,
              body,
              entry: {
                ...entry,
                dependencies: generated.dependencies,
                dependency_identities: generated.dependency_identities,
              },
            },
            scheduled,
          });
        }
        assertFrozenScheduleOperation({ object: { key, entry, body }, scheduled });
        Object.assign(audit[key] ||= {}, entry, { included_in_write_set: true });
        await executeOperation({
          kind: "put",
          key,
          object: { key, entry, body, domain: objectDomain(key), schedule: scheduled },
        });
        persistence.flush();
        Object.assign(audit[key], {
          status: "succeeded",
          remote_completed: true,
          r2_verified: true,
          post_put_verification_get_attempt_count:
            entry.post_put_verification_get_attempt_count,
          post_put_verification_get_count: entry.post_put_verification_get_count,
        });
        return {
          key,
          bytes: body.byteLength,
          sha256,
          skipped: false,
          status: "succeeded",
          write_r2: true,
          verified: true,
          verification_status: "succeeded",
        };
      },
    },
  };
}

export const VERIFIED_GET_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const VERIFIED_GET_CACHE_MAX_ENTRIES = 32;

export function createVerifiedGetBodyCache({
  maxBytes = VERIFIED_GET_CACHE_MAX_BYTES,
  maxEntries = VERIFIED_GET_CACHE_MAX_ENTRIES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Verified GET cache bounds must be positive integers");
  }
  const entries = new Map();
  const events = [];
  let totalBytes = 0;
  let peakBytes = 0;
  let peakEntries = 0;
  const record = (event) => {
    events.push(event);
    if (events.length > 50) events.shift();
  };
  const invalidateKey = (key, reason) => {
    let removed = 0;
    for (const [cacheKey, entry] of entries) {
      if (entry.key !== key) continue;
      entries.delete(cacheKey);
      totalBytes -= entry.body.byteLength;
      removed += 1;
    }
    if (removed) record({ key, reason, invalidated_entries: removed });
    return removed;
  };
  const evictOldest = (reason) => {
    const oldest = entries.entries().next().value;
    if (!oldest) return false;
    const [cacheKey, entry] = oldest;
    entries.delete(cacheKey);
    totalBytes -= entry.body.byteLength;
    record({ key: entry.key, verified_sha256: entry.sha256, reason });
    return true;
  };
  return {
    maxBytes,
    maxEntries,
    store({ key, sha256, body }) {
      const normalizedKey = safeKey(key);
      const normalizedSha = String(sha256 || "").toLowerCase();
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (!/^[a-f0-9]{64}$/.test(normalizedSha) || sha256Hex(buffer) !== normalizedSha) {
        throw new Error(`Refusing unverified body cache entry: ${normalizedKey}`);
      }
      invalidateKey(normalizedKey, "later_put_same_key");
      if (buffer.byteLength > maxBytes) {
        record({ key: normalizedKey, verified_sha256: normalizedSha, reason: "body_exceeds_cache_bound" });
        return false;
      }
      while (entries.size >= maxEntries || totalBytes + buffer.byteLength > maxBytes) {
        if (!evictOldest("bounded_cache_eviction")) break;
      }
      entries.set(`${normalizedKey}\u0000${normalizedSha}`, {
        key: normalizedKey,
        sha256: normalizedSha,
        body: buffer,
      });
      totalBytes += buffer.byteLength;
      peakBytes = Math.max(peakBytes, totalBytes);
      peakEntries = Math.max(peakEntries, entries.size);
      return true;
    },
    get(key, expectedSha256) {
      const normalizedKey = safeKey(key);
      const normalizedSha = String(expectedSha256 || "").toLowerCase();
      const entry = entries.get(`${normalizedKey}\u0000${normalizedSha}`);
      return entry && sha256Hex(entry.body) === normalizedSha ? entry.body : null;
    },
    invalidateKey,
    invalidatePrefix(prefix, reason) {
      const normalizedPrefix = `${safeKey(prefix).replace(/\/+$/, "")}/`;
      let removed = 0;
      for (const entry of [...entries.values()]) {
        if (entry.key.startsWith(normalizedPrefix)) {
          removed += invalidateKey(entry.key, reason);
        }
      }
      return removed;
    },
    clear(reason = "connector_day_scope_complete") {
      for (const entry of [...entries.values()]) invalidateKey(entry.key, reason);
    },
    snapshot() {
      return {
        max_bytes: maxBytes,
        max_entries: maxEntries,
        current_bytes: totalBytes,
        current_entries: entries.size,
        peak_bytes: peakBytes,
        peak_entries: peakEntries,
        recent_events: [...events],
      };
    },
  };
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
const CANONICAL_OBSERVATION_DAY_PREFIX_PATTERN =
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})$/;
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
  const observationDayMatch = prefix.match(CANONICAL_OBSERVATION_DAY_PREFIX_PATTERN);
  if (observationDayMatch) {
    const dayUtc = observationDayMatch[1];
    const parsedDay = new Date(`${dayUtc}T00:00:00.000Z`);
    if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayUtc
      || entry?.stage !== "sos_light_complete_day") {
      throw new Error(`SOS-light complete-day deletion evidence is invalid: ${prefix}`);
    }
    return;
  }
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
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const sha256 = String(identity.sha256 || "").trim().toLowerCase();
  const bytes = Number(identity.bytes);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const source = String(identity.source || "").trim();
  if (!source) return null;
  if (Object.hasOwn(identity, "key")) return null;
  return recursivelySortJsonValue({ ...identity, sha256, bytes, source });
}

export function canonicalDependencyIdentities(entry) {
  if (entry?.dependencies != null && !Array.isArray(entry.dependencies)) {
    throw new Error("Publication dependencies must be an array");
  }
  const dependencies = (entry?.dependencies || []).map((dependency) => safeKey(dependency));
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("Publication dependency identity list contains a duplicate dependency key");
  }
  const identities = entry?.dependency_identities;
  if (dependencies.length === 0 && identities == null) return [];
  if (!identities || typeof identities !== "object" || Array.isArray(identities)) {
    throw new Error("Publication dependency identities must be an object");
  }
  const dependencySet = new Set(dependencies);
  const rawIdentityKeys = Object.keys(identities);
  const identityKeys = rawIdentityKeys.map((key) => safeKey(key));
  if (rawIdentityKeys.some((key, index) => key !== identityKeys[index])
    || new Set(identityKeys).size !== identityKeys.length
    || identityKeys.length !== dependencies.length) {
    throw new Error("Publication dependency identity keys are not an exact unique dependency set");
  }
  const unexpected = identityKeys.filter((key) => !dependencySet.has(key));
  if (unexpected.length) {
    throw new Error(`Publication dependency identity is not declared: ${unexpected.sort(bytewiseKeyCompare)[0]}`);
  }
  const canonical = dependencies.map((dependencyKey) => {
    const identity = dependencyIdentity(entry, dependencyKey);
    if (!identity) {
      throw new Error(`Publication dependency identity is unresolved: ${dependencyKey}`);
    }
    return { key: dependencyKey, ...identity };
  });
  canonical.sort((left, right) => bytewiseKeyCompare(left.key, right.key));
  return canonical;
}

export function assertFrozenScheduleOperation({ object, scheduled, expectedPosition = null }) {
  if (!scheduled) throw new Error(`Unscheduled changed PUT rejected: ${object?.key || "(unknown)"}`);
  if (expectedPosition !== null && scheduled.position !== expectedPosition) {
    throw new Error(`Out-of-order scheduled PUT rejected: expected position ${expectedPosition}, received ${scheduled.position} (${object.key})`);
  }
  const actualIdentities = canonicalDependencyIdentities(object.entry);
  const frozenIdentities = recursivelySortJsonValue(scheduled.canonical_dependency_identities || []);
  if (object.body.byteLength !== scheduled.proposed_bytes
    || object.entry.sha256 !== scheduled.proposed_sha256
    || objectPublicationStage(object) !== scheduled.publication_stage
    || JSON.stringify(recursivelySortJsonValue(actualIdentities)) !== JSON.stringify(frozenIdentities)) {
    throw new Error(`Frozen publication schedule identity mismatch: ${object.key}`);
  }
  return true;
}

function changedScopeDeclaresKey(runState, dependencyKey) {
  const matches = (value) => {
    if (typeof value === "string") return value === dependencyKey;
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(matches);
    if ([value.key, value.object_key, value.canonical_key].some((key) => key === dependencyKey)) return true;
    return Object.values(value).some(matches);
  };
  return matches(runState?.changed_scopes || {});
}

function proposedDeletionPrefixes(runState) {
  return (runState?.tombstone_prefixes || [])
    .filter((entry) => entry?.proposed)
    .map((entry) => `${safeKey(entry.prefix).replace(/\/+$/, "")}/`);
}

export function validateExternalDependencyRoot({
  runState,
  objectKey,
  dependencyKey,
  identity,
}) {
  const key = safeKey(dependencyKey);
  if (!identity || !["dropbox", "overlay"].includes(identity.source)) {
    throw new Error(`Changed publication dependency is missing from write set: ${objectKey} -> ${key}`);
  }
  if (!runState) {
    throw new Error(`External dependency cannot be pinned without proposal state: ${objectKey} -> ${key}`);
  }
  if (runState.objects?.[key]) {
    throw new Error(`External dependency is also present in the changed write set: ${objectKey} -> ${key}`);
  }
  if (changedScopeDeclaresKey(runState, key)) {
    throw new Error(`Changed object was omitted from the write set: ${objectKey} -> ${key}`);
  }
  if (proposedDeletionPrefixes(runState).some((prefix) => key.startsWith(prefix))) {
    throw new Error(`Proposed deletion would remove an unstaged dependency: ${objectKey} -> ${key}`);
  }
  const root = identity.source === "dropbox"
    ? String(runState.base_dropbox_root || "")
    : String(runState.overlay_root || "");
  if (!root) {
    throw new Error(`${identity.source} external dependency root is unavailable: ${objectKey} -> ${key}`);
  }
  const resolvedRoot = path.resolve(root);
  const localPath = path.resolve(resolvedRoot, ...key.split("/"));
  if (!localPath.startsWith(`${resolvedRoot}${path.sep}`)
    || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${identity.source} external dependency is unavailable: ${objectKey} -> ${key}`);
  }
  const body = fs.readFileSync(localPath);
  if (body.byteLength !== identity.bytes || sha256Hex(body) !== identity.sha256) {
    throw new Error(`${identity.source} external dependency identity changed after planning: ${objectKey} -> ${key}`);
  }
  return { key, local_path: localPath, ...identity };
}

export function validateLocalProposal(runState) {
  if (!runState || typeof runState !== "object") throw new Error("run state must be an object");
  if (runState.environment !== "CIC-Test") {
    throw new Error(`Refusing canonical apply outside CIC-Test: ${runState.environment || "(unset)"}`);
  }
  const objects = Object.entries(runState.objects || {}).sort(([left], [right]) => bytewiseKeyCompare(left, right));
  const prefixes = Array.isArray(runState.tombstone_prefixes) ? runState.tombstone_prefixes : [];
  if (!objects.length && !prefixes.length) throw new Error("canonical proposal has no planned operations");
  const normalizedObjects = [];
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
    const canonicalIdentities = canonicalDependencyIdentities(entry);
    for (const expectedIdentity of canonicalIdentities) {
      const dependencyKey = expectedIdentity.key;
      const stagedDependency = runState.objects?.[dependencyKey];
      if (stagedDependency) {
        if (!stagedDependency.structurally_validated
          || !fs.statSync(String(stagedDependency.local_path || ""), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Local proposal dependency is not structurally validated: ${key} -> ${dependencyKey}`);
        }
        const dependencyBody = fs.readFileSync(String(stagedDependency.local_path));
        if (expectedIdentity.source !== "planned_overlay"
          || dependencyBody.byteLength !== expectedIdentity.bytes
          || sha256Hex(dependencyBody) !== expectedIdentity.sha256) {
          throw new Error(`Staged current-run dependency identity is invalid: ${key} -> ${dependencyKey}`);
        }
      } else {
        validateExternalDependencyRoot({
          runState,
          objectKey: key,
          dependencyKey,
          identity: expectedIdentity,
        });
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
    objects: normalizedObjects.sort((left, right) => bytewiseKeyCompare(left.key, right.key)),
    prefixes: normalizedPrefixes.sort((left, right) => left.domain.localeCompare(right.domain) || left.prefix.localeCompare(right.prefix)),
  };
}

export function validateDedicatedSosHistoricalProposal({ runState, proposal }) {
  if (runState?.execution_path !== "sos_light") {
    return { dedicated: false };
  }
  const audit = runState.sos_light;
  if (runState.environment !== "CIC-Test"
    || runState.mode !== "sos-light"
    || JSON.stringify(runState.mutation_connector_ids) !== "[1]"
    || JSON.stringify(runState.selected_mutation_connector_ids) !== "[1]"
    || JSON.stringify(runState.protected_connector_ids) !== "[1]"
    || audit?.mode !== "sos-light"
    || audit?.validation_status !== "complete_local_days_validated"
    || audit?.old_live_r2_observation_bodies_used !== false
    || audit?.no_old_live_r2_body_planning_or_preservation !== true
    || runState.aqi_policy !== "bypassed_observation_history_only") {
    throw new Error("SOS-light proposal has invalid execution-scope or authority evidence");
  }
  const aqiScopeSets = ["AQILEVELS_CHANGED", "AQI_MANIFESTS_CHANGED", "AQI_INDEXES_CHANGED"];
  if (aqiScopeSets.some((scope) => (runState.changed_scopes?.[scope] || []).length > 0)) {
    throw new Error("SOS-light proposal must not contain AQI changed scopes");
  }
  const selectedDays = [...new Set((audit.days || []).map((entry) => String(entry?.day_utc || "")))].sort();
  const deletionDays = proposal.prefixes.map((item) => {
    const match = item.prefix.match(CANONICAL_OBSERVATION_DAY_PREFIX_PATTERN);
    if (!match || item.domain !== "observations") {
      throw new Error(`SOS-light deletion is not a complete observation day: ${item.prefix}`);
    }
    return match[1];
  }).sort();
  if (!selectedDays.length || JSON.stringify(selectedDays) !== JSON.stringify(deletionDays)) {
    throw new Error("SOS-light requires exactly one complete-day deletion per assembled day");
  }
  const proposedKeys = new Set(proposal.objects.map((object) => object.key));
  for (const day of selectedDays) {
    const dayPrefix = `history/v2/observations/day_utc=${day}`;
    if (!proposedKeys.has(`${dayPrefix}/manifest.json`)
      || !proposedKeys.has(`${dayPrefix}/connector_id=1/manifest.json`)) {
      throw new Error(`SOS-light complete assembled day is missing required parents: ${day}`);
    }
  }
  if (proposal.objects.some((object) => object.domain !== "observations" || object.key.includes("aqilevels"))) {
    throw new Error("SOS-light proposal contains an AQI object");
  }
  return {
    dedicated: true,
    mode: "sos-light",
    connector_id: 1,
    observation_object_count: proposal.objects.length,
    complete_day_prefix_count: proposal.prefixes.length,
    selected_days: selectedDays,
    protected_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    dropbox_warning_count: Number(audit.dropbox_warning_count || 0),
    dropbox_omission_count: Number(audit.dropbox_omission_count || 0),
    old_live_r2_observation_bodies_used: false,
  };
}

export async function deleteAndVerifyPrefix({
  r2,
  prefixEntry,
  adapters,
  persistence,
  checkpoint,
  verifiedBodyCache = null,
}) {
  const prefix = `${prefixEntry.prefix}/`;
  const context = mutationContext(prefixEntry.prefix, prefixEntry.entry?.stage || "prefix_deletion");
  verifiedBodyCache?.invalidatePrefix(prefixEntry.prefix, "delete_prefix");
  try {
    const entries = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    const keys = entries.map((entry) => safeKey(entry.key)).filter((key) => key.startsWith(prefix)).sort();
    const sidecar = persistence.writeDeletedKeysSidecar({ prefix: prefixEntry.prefix, keys });
    delete prefixEntry.entry.deleted_object_keys;
    const startedAt = new Date().toISOString();
    Object.assign(prefixEntry.entry, {
      ...sidecar,
      remote_attempted: false,
      deletion_started_at_utc: startedAt,
      deletion_completed_at_utc: null,
      deletion_verified: false,
      status: "deletion_prepared",
    });
    persistence.appendEvent({
      event_type: "deletion_started",
      prefix: prefixEntry.prefix,
      ...context,
      bytes: sidecar.deleted_keys_sidecar_bytes,
      sha256: sidecar.deleted_keys_sha256,
      status: "started",
      ...sidecar,
    });
    persistence.flush();
    await checkpoint("before_destructive_deletion");
    prefixEntry.entry.remote_attempted = true;
    prefixEntry.entry.status = "deleting";
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      const result = await adapters.deleteObjects({ r2, keys: batch });
      if (Array.isArray(result?.errors) && result.errors.length) {
        throw new Error(`R2 prefix delete returned errors for ${prefixEntry.prefix}: ${JSON.stringify(result.errors)}`);
      }
    }
    const completedAt = new Date().toISOString();
    prefixEntry.entry.deletion_completed_at_utc = completedAt;
    persistence.appendEvent({
      event_type: "deletion_completed",
      prefix: prefixEntry.prefix,
      ...context,
      bytes: prefixEntry.entry.deleted_keys_sidecar_bytes,
      sha256: prefixEntry.entry.deleted_keys_sha256,
      status: "completed",
      deleted_object_count: keys.length,
      deleted_keys_sidecar_path: prefixEntry.entry.deleted_keys_sidecar_path,
    });
    const remaining = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    if (remaining.length) throw new Error(`R2 prefix deletion verification failed: ${prefixEntry.prefix}`);
    Object.assign(prefixEntry.entry, {
      deleted: true,
      deletion_verified: true,
      remote_completed: true,
      completed_at_utc: completedAt,
      deleted_object_count: keys.length,
      status: "deletion_verified",
    });
    persistence.appendEvent({
      event_type: "deletion_verified",
      prefix: prefixEntry.prefix,
      ...context,
      bytes: prefixEntry.entry.deleted_keys_sidecar_bytes,
      sha256: prefixEntry.entry.deleted_keys_sha256,
      status: "verified",
      deleted_object_count: keys.length,
      deleted_keys_sidecar_path: prefixEntry.entry.deleted_keys_sidecar_path,
      remaining_object_count: 0,
    });
    persistence.flush();
    return keys.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(prefixEntry.entry, {
      status: "failed",
      error: message,
    });
    try {
      persistence.appendEvent({
        event_type: "deletion_failed",
        prefix: prefixEntry.prefix,
        ...context,
        bytes: prefixEntry.entry.deleted_keys_sidecar_bytes ?? null,
        sha256: prefixEntry.entry.deleted_keys_sha256 ?? null,
        status: "failed",
        failure_message: message,
        deleted_object_count: prefixEntry.entry.deleted_object_count ?? null,
        deleted_keys_sidecar_path: prefixEntry.entry.deleted_keys_sidecar_path ?? null,
      });
      persistence.flush();
    } catch {
      // The outer failure checkpoint records an unusable journal explicitly.
    }
    throw error;
  }
}

export async function putAndVerifyObject({
  r2,
  runState,
  object,
  adapters,
  persistence = null,
  verifiedBodyCache = null,
}) {
  const entry = object.entry;
  const context = mutationContext(object.key, objectPublicationStage(object));
  const scheduleEvidence = {
    publication_schedule_sha256: runState?.apply?.publication_schedule?.schedule_sha256 || null,
    schedule_position: Number(object?.schedule?.position || 0),
    total_schedule_positions: Number(runState?.apply?.publication_schedule?.total_positions || 0),
  };
  if (!scheduleEvidence.publication_schedule_sha256
    || scheduleEvidence.schedule_position <= 0
    || scheduleEvidence.total_schedule_positions <= 0) {
    throw new Error(`Scheduled PUT evidence is unavailable: ${object.key}`);
  }
  if (Number(entry.post_put_verification_get_attempt_count || 0) !== 0
    || Number(entry.post_put_verification_get_count || 0) !== 0) {
    throw new Error(`Changed object already has post-PUT GET bookkeeping: ${object.key}`);
  }
  verifiedBodyCache?.invalidateKey(object.key, "later_put_same_key");
  Object.assign(entry, { remote_attempted: true, status: "uploading" });
  persistence?.appendEvent({
    event_type: "put_started",
    canonical_key: object.key,
    ...context,
    ...scheduleEvidence,
    bytes: object.body.byteLength,
    sha256: entry.sha256,
    status: "started",
    post_put_verification_count: 0,
  });
  try {
    await adapters.putObject({ r2, key: object.key, body: object.body, content_type: contentTypeForKey(object.key) });
    Object.assign(entry, { uploaded: true, uploaded_at_utc: new Date().toISOString(), status: "uploaded" });
    persistence?.appendEvent({
      event_type: "put_completed",
      canonical_key: object.key,
      ...context,
      ...scheduleEvidence,
      bytes: object.body.byteLength,
      sha256: entry.sha256,
      status: "completed",
      post_put_verification_count: 0,
    });
    entry.post_put_verification_get_attempt_count = 1;
    persistence?.appendEvent({
      event_type: "post_put_get_started",
      canonical_key: object.key,
      ...context,
      ...scheduleEvidence,
      bytes: object.body.byteLength,
      sha256: entry.sha256,
      status: "started",
      post_put_verification_count: 0,
      post_put_verification_attempt_count: 1,
    });
    const fresh = await adapters.getObject({ r2, key: object.key });
    if (Number(fresh.bytes) !== object.body.byteLength || sha256Hex(fresh.body) !== entry.sha256) {
      throw new Error(`R2 GET verification identity mismatch: ${object.key}`);
    }
    Object.assign(entry, {
      r2_verified: true,
      r2_verified_at_utc: new Date().toISOString(),
      remote_completed: true,
      status: "get_verified",
      post_put_verification_get_count: 1,
    });
    if (/^history\/v2\/observations\/.+\.parquet$/.test(object.key)
      && (runState.execution_path !== "sos_light" || entry.stage === "observations_data")) {
      const cached = verifiedBodyCache?.store({
        key: object.key,
        sha256: entry.sha256,
        body: fresh.body,
      }) || false;
      Object.assign(entry, {
        verified_get_body_cached: cached,
        verified_get_cache_key: cached ? object.key : null,
        verified_get_cache_sha256: cached ? entry.sha256 : null,
      });
    }
    persistence?.appendEvent({
      event_type: "post_put_get_verified",
      canonical_key: object.key,
      ...context,
      ...scheduleEvidence,
      bytes: object.body.byteLength,
      sha256: entry.sha256,
      status: "verified",
      post_put_verification_count: 1,
      post_put_verification_attempt_count: 1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(entry, {
      status: "failed",
      error: message,
    });
    try {
      persistence?.appendEvent({
        event_type: "put_or_verification_failed",
        canonical_key: object.key,
        ...context,
        ...scheduleEvidence,
        bytes: object.body.byteLength,
        sha256: entry.sha256,
        status: "failed",
        failure_message: message,
        put_completed: entry.uploaded === true,
        post_put_verification_count: Number(entry.post_put_verification_get_count || 0),
        post_put_verification_attempt_count: Number(entry.post_put_verification_get_attempt_count || 0),
      });
      persistence?.flush();
    } catch {
      // The outer failure checkpoint records an unusable journal explicitly.
    }
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

function timeseriesRowCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const key = String(row.timeseries_id);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => Number(left) - Number(right)));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function semanticMetadata(value) {
  return {
    observation_content_hash: value.observation_content_hash,
    observation_content_hash_algorithm: value.observation_content_hash_algorithm,
    observation_content_hash_contract_version: value.observation_content_hash_contract_version,
    observation_content_hash_row_count: value.observation_content_hash_row_count,
    observation_content_hash_columns: value.observation_content_hash_columns,
    verification_status_counts: value.verification_status_counts,
  };
}

function semanticDifferences(left, right) {
  const fields = [
    "observation_content_hash",
    "observation_content_hash_algorithm",
    "observation_content_hash_contract_version",
    "observation_content_hash_row_count",
    "observation_content_hash_columns",
    "verification_status_counts",
  ];
  return fields.filter((field) => !sameJson(left?.[field], right?.[field]));
}

function proposalOwners(object) {
  const values = [
    object?.entry?.proposal_owner,
    object?.entry?.source,
    object?.entry?.provenance?.source,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return [...new Set(values.length ? values : ["final_metadata_proposal"])];
}

function finalProposalError({ key, object, differingFields, compatibilitySource = null }) {
  const suffix = compatibilitySource ? ` compatibility_source=${compatibilitySource}` : "";
  return new Error(
    `Final Integrity proposal graph mismatch: key=${key} owners=${proposalOwners(object).join(",")} differing_fields=${[...new Set(differingFields)].join(",")}${suffix}`,
  );
}

function parseFinalJsonBody({ key, object, body, differingField }) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw finalProposalError({ key, object, differingFields: [differingField] });
  }
}

function sourceEvidencePaths(runState, dayUtc, connectorId, pollutantCode) {
  const configuredRoot = String(runState.overlay_root || "").trim();
  if (!configuredRoot) throw new Error("Final proposal graph has no overlay root");
  const root = path.resolve(configuredRoot);
  const identity = `day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const retained = runState.source_evidence_partitions?.[identity];
  if (retained) {
    const expectedDirectory = path.join(
      root,
      "source-evidence",
      `day_utc=${dayUtc}`,
      `connector_id=${connectorId}`,
      `pollutant_code=${pollutantCode}`,
    );
    const evidencePath = path.resolve(String(retained.evidence_path || ""));
    const rowsPath = path.resolve(String(retained.rows_path || ""));
    if (retained.identity !== identity
      || retained.day_utc !== dayUtc
      || Number(retained.connector_id) !== connectorId
      || retained.pollutant_code !== pollutantCode
      || evidencePath !== path.join(expectedDirectory, "source-evidence.json")
      || rowsPath !== path.join(expectedDirectory, "obs_history_rows.json")) {
      throw new Error(`Pollutant-scoped source evidence identity is invalid: ${identity}`);
    }
    return {
      evidencePath,
      rowsPath,
      identity,
      pollutantScoped: true,
      retainedEvidenceSha256: String(retained.evidence_sha256 || ""),
      retainedRowsSha256: String(retained.rows_sha256 || ""),
    };
  }
  if (runState.execution_path === "sos_light") {
    throw new Error(`Pollutant-scoped source evidence is missing: ${identity}`);
  }
  const directory = path.join(root, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  return {
    evidencePath: path.join(directory, "source-evidence.json"),
    rowsPath: path.join(directory, "obs_history_rows.json"),
    identity: `day_utc=${dayUtc}/connector_id=${connectorId}`,
    pollutantScoped: false,
    retainedEvidenceSha256: null,
    retainedRowsSha256: null,
  };
}

function loadImmutableSourcePartition({ runState, dayUtc, connectorId, pollutantCode }) {
  const {
    evidencePath,
    rowsPath,
    identity,
    pollutantScoped,
    retainedEvidenceSha256,
    retainedRowsSha256,
  } = sourceEvidencePaths(runState, dayUtc, connectorId, pollutantCode);
  const evidenceBody = fs.readFileSync(evidencePath);
  const rowsBody = fs.readFileSync(rowsPath);
  if (pollutantScoped && (
    sha256Hex(evidenceBody) !== retainedEvidenceSha256
    || sha256Hex(rowsBody) !== retainedRowsSha256
  )) {
    throw new Error(`Pollutant-scoped source evidence changed after capture: ${identity}`);
  }
  const evidence = JSON.parse(evidenceBody.toString("utf8"));
  const rows = JSON.parse(rowsBody.toString("utf8"));
  if (evidence?.schema_version !== 1
    || evidence?.enumeration_complete !== true
    || evidence?.day_utc !== dayUtc
    || Number(evidence?.connector_id) !== connectorId
    || !Array.isArray(rows)
    || rowsBody.byteLength !== Number(evidence.canonical_rows_bytes)
    || sha256Hex(rowsBody) !== evidence.canonical_rows_sha256
    || rows.length !== Number(evidence.total_rows)) {
    throw new Error(`Immutable source evidence identity is invalid: day=${dayUtc} connector=${connectorId}`);
  }
  if (pollutantScoped && !sameJson(
    [...new Set((evidence.requested_pollutant_set || []).map(String))].sort(),
    [pollutantCode],
  )) {
    throw new Error(`Immutable source evidence selected pollutant is invalid: ${identity}`);
  }
  const reconstructedRows = rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Immutable source evidence row is invalid: day=${dayUtc} connector=${connectorId} row=${index}`);
    }
    if (Object.hasOwn(row, "connector_id") && Number(row.connector_id) !== connectorId) {
      throw new Error(`Immutable source evidence row has conflicting connector_id: day=${dayUtc} connector=${connectorId} row=${index}`);
    }
    if (typeof row.observed_at !== "string" || !row.observed_at.trim()) {
      throw new Error(`Immutable source evidence observed_at is missing or invalid: day=${dayUtc} connector=${connectorId} row=${index}`);
    }
    const observedAt = new Date(row.observed_at);
    if (Number.isNaN(observedAt.getTime())) {
      throw new Error(`Immutable source evidence observed_at is missing or invalid: day=${dayUtc} connector=${connectorId} row=${index}`);
    }
    const observedAtUtc = observedAt.toISOString();
    if (observedAtUtc.slice(0, 10) !== dayUtc) {
      throw new Error(`Immutable source evidence observed_at is outside selected UTC day: day=${dayUtc} connector=${connectorId} row=${index}`);
    }
    return normalizeCanonicalObservationRow({
      connector_id: connectorId,
      station_id: row.station_id,
      timeseries_id: row.timeseries_id,
      pollutant_code: row.pollutant_code,
      observed_at_utc: observedAtUtc,
      value: row.value,
      verification_status: row.verification_status,
    });
  });
  const reconstructedByPollutant = new Map();
  for (const row of reconstructedRows) {
    const partitionRows = reconstructedByPollutant.get(row.pollutant_code) || [];
    partitionRows.push(row);
    reconstructedByPollutant.set(row.pollutant_code, partitionRows);
  }
  const reconstructedCounts = Object.fromEntries([...reconstructedByPollutant.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, partitionRows]) => [code, partitionRows.length]));
  const recordedCounts = Object.fromEntries(Object.entries(evidence?.per_pollutant_counts || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => [code, Number(count)]));
  if (!sameJson(reconstructedCounts, recordedCounts)) {
    throw new Error(`Immutable source evidence per-pollutant counts changed: day=${dayUtc} connector=${connectorId}`);
  }
  const recordedHashCodes = Object.keys(evidence?.observation_content_hashes || {}).sort();
  if (!sameJson(Object.keys(reconstructedCounts), recordedHashCodes)) {
    throw new Error(`Immutable source evidence content-hash partitions changed: day=${dayUtc} connector=${connectorId}`);
  }
  for (const [code, partitionRows] of reconstructedByPollutant) {
    const computedPartition = computeObservationContentHash(partitionRows);
    const recordedPartition = evidence?.observation_content_hashes?.[code];
    validateObservationContentHashMetadata(recordedPartition, { rowCount: partitionRows.length });
    const partitionDifferences = semanticDifferences(computedPartition, recordedPartition);
    if (partitionDifferences.length) {
      throw new Error(
        `Immutable source evidence semantic identity changed: day=${dayUtc} connector=${connectorId} pollutant=${code} differing_fields=${partitionDifferences.join(",")}`,
      );
    }
  }
  const selectedRows = reconstructedByPollutant.get(pollutantCode) || [];
  const missingBindingRows = Number(evidence.missing_binding_rows || 0);
  if (!selectedRows.length && missingBindingRows > 0) {
    throw new Error(`Immutable source evidence is all-unmapped rather than authoritative no-data: ${identity}`);
  }
  const computed = selectedRows.length
    ? computeObservationContentHash(selectedRows)
    : computeEmptyObservationContentHash();
  const recorded = evidence?.observation_content_hashes?.[pollutantCode];
  if (selectedRows.length || recorded != null) {
    validateObservationContentHashMetadata(recorded, { rowCount: selectedRows.length });
    const differingFields = semanticDifferences(computed, recorded);
    if (differingFields.length) {
      throw new Error(
        `Immutable source evidence semantic identity changed: day=${dayUtc} connector=${connectorId} pollutant=${pollutantCode} differing_fields=${differingFields.join(",")}`,
      );
    }
  }
  return {
    evidence,
    evidencePath,
    rowsPath,
    evidenceSha256: sha256Hex(evidenceBody),
    rowsSha256: sha256Hex(rowsBody),
    rows: selectedRows,
    identity,
    encodedRows: selectedRows.map(encodeCanonicalObservationRow).sort(),
    metadata: semanticMetadata(computed),
    timeseriesRowCounts: timeseriesRowCounts(selectedRows),
  };
}

function parseManifestObject(object, expectedKind) {
  const payload = parseFinalJsonBody({
    key: object.key,
    object,
    body: object.body,
    differingField: "manifest_json",
  });
  try {
    validateCanonicalHistoryV2Manifest(payload, {
      history_version: "v2",
      domain: payload.domain,
      grain: payload.grain ?? null,
      profile: payload.profile ?? null,
      manifest_kind: expectedKind,
      day_utc: payload.day_utc,
      connector_id: payload.connector_id ?? undefined,
      pollutant_code: payload.pollutant_code ?? undefined,
      manifest_key: object.key,
    });
  } catch {
    throw finalProposalError({ key: object.key, object, differingFields: ["manifest_contract"] });
  }
  return payload;
}

function validateFinalParentReferences({ proposal, runState }) {
  const objects = new Map(proposal.objects.map((object) => [object.key, object]));
  for (const object of proposal.objects) {
    if (!object.key.endsWith("/manifest.json") || object.key.startsWith("history/_index_v2/")) continue;
    const expectedParentKind = /\/connector_id=\d+\/manifest\.json$/.test(object.key)
      ? "connector"
      : /\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(object.key)
      ? "day"
      : null;
    if (!expectedParentKind) continue;
    const payload = parseManifestObject(object, expectedParentKind);
    if (runState.execution_path === "sos_light"
      && expectedParentKind === "connector"
      && Number(payload.connector_id) !== 1) {
      // Dropbox is warning-only preservation authority for unprotected
      // connectors; a usable parent does not require descendant certification.
      continue;
    }
    const rawReferences = payload.manifest_kind === "connector"
      ? [...(payload.pollutant_manifests || []), ...(payload.child_manifests || [])]
      : [...(payload.connector_manifests || []), ...(payload.child_manifests || [])];
    const references = new Map();
    for (const reference of rawReferences) {
      const key = String(reference?.manifest_key || "");
      if (!key) continue;
      const prior = references.get(key);
      if (prior && prior.manifest_hash !== reference.manifest_hash) {
        throw finalProposalError({ key: object.key, object, differingFields: [`duplicate_child_identity:${key}`] });
      }
      references.set(key, reference);
    }
    const dependencies = new Set((object.entry.dependencies || []).map(String));
    const expectedChildKeys = object.entry?.local_dependency_snapshot?.expected_child_keys;
    if (Array.isArray(expectedChildKeys)
      && !sameJson([...new Set(expectedChildKeys.map(String))].sort(), [...references.keys()].sort())) {
      throw finalProposalError({
        key: object.key,
        object,
        differingFields: ["preserved_child_accounting"],
      });
    }
    for (const [key, reference] of references) {
      if (!dependencies.has(key)) {
        throw finalProposalError({ key: object.key, object, differingFields: [`missing_child_dependency:${key}`] });
      }
      const child = objects.get(key);
      const identity = dependencyIdentity(object.entry, key);
      let childPayload;
      if (child) {
        childPayload = parseFinalJsonBody({
          key: child.key,
          object: child,
          body: child.body,
          differingField: "child_manifest_json",
        });
      } else {
        const external = validateExternalDependencyRoot({
          runState,
          objectKey: object.key,
          dependencyKey: key,
          identity,
        });
        const baselineBody = fs.readFileSync(external.local_path);
        childPayload = parseFinalJsonBody({
          key,
          object,
          body: baselineBody,
          differingField: `preserved_child_json:${key}`,
        });
      }
      if (reference.manifest_hash !== childPayload.manifest_hash) {
        throw finalProposalError({ key: object.key, object, differingFields: [`child_manifest_hash:${key}`] });
      }
      if (child && (!identity || identity.sha256 !== child.entry.sha256 || identity.bytes !== child.body.byteLength
        || identity.source !== "planned_overlay")) {
        throw finalProposalError({ key: object.key, object, differingFields: [`child_dependency_identity:${key}`] });
      }
    }
    for (const dependency of dependencies) {
      if (dependency.endsWith("/manifest.json") && !references.has(dependency)) {
        throw finalProposalError({ key: object.key, object, differingFields: [`unrepresented_child_dependency:${dependency}`] });
      }
    }
  }
  for (const object of proposal.objects.filter((candidate) => candidate.key.startsWith("history/_index_v2/")
    && candidate.key.includes("/day_utc=") && candidate.key.includes("/connector_id=")
    && candidate.key.includes("/pollutant_code="))) {
    const observation = object.key.match(/^history\/_index_v2\/observations_timeseries\/day_utc=([^/]+)\/connector_id=([^/]+)\/pollutant_code=([^/]+)\/manifest\.json$/);
    const aqi = object.key.match(/^history\/_index_v2\/aqilevels_hourly_data_timeseries\/day_utc=([^/]+)\/connector_id=([^/]+)\/pollutant_code=([^/]+)\/manifest\.json$/);
    const match = observation || aqi;
    if (!match) continue;
    const manifestKey = observation
      ? `history/v2/observations/day_utc=${match[1]}/connector_id=${match[2]}/pollutant_code=${match[3]}/manifest.json`
      : `history/v2/aqilevels/hourly/data/day_utc=${match[1]}/connector_id=${match[2]}/pollutant_code=${match[3]}/manifest.json`;
    if (!(object.entry.dependencies || []).includes(manifestKey)) {
      throw finalProposalError({ key: object.key, object, differingFields: [`missing_index_manifest_dependency:${manifestKey}`] });
    }
    const stagedManifest = runState.objects?.[manifestKey];
    const identity = dependencyIdentity(object.entry, manifestKey);
    let manifestBody;
    if (stagedManifest) {
      manifestBody = fs.readFileSync(String(stagedManifest.local_path));
      if (!identity || identity.sha256 !== stagedManifest.sha256
        || identity.bytes !== Number(stagedManifest.bytes)
        || identity.source !== "planned_overlay") {
        throw finalProposalError({ key: object.key, object, differingFields: [`index_manifest_identity:${manifestKey}`] });
      }
    } else {
      const external = validateExternalDependencyRoot({
        runState,
        objectKey: object.key,
        dependencyKey: manifestKey,
        identity,
      });
      manifestBody = fs.readFileSync(external.local_path);
    }
    const manifest = parseFinalJsonBody({
      key: manifestKey,
      object,
      body: manifestBody,
      differingField: `index_source_manifest_json:${manifestKey}`,
    });
    const indexPayload = parseFinalJsonBody({
      key: object.key,
      object,
      body: object.body,
      differingField: "scoped_index_json",
    });
    const indexDifferences = [];
    const declaredManifestKeys = [
      indexPayload.pollutant_manifest_key,
      indexPayload.connector_pollutant_manifest_key,
    ].filter(Boolean);
    if (!declaredManifestKeys.length || declaredManifestKeys.some((key) => key !== manifestKey)) {
      indexDifferences.push("pollutant_manifest_key");
    }
    if (indexPayload.pollutant_manifest_hash !== manifest.manifest_hash) {
      indexDifferences.push("pollutant_manifest_hash");
    }
    if (Number(indexPayload.source_row_count) !== Number(manifest.source_row_count)
      || !sameJson(indexPayload.timeseries_row_counts, manifest.timeseries_row_counts)) {
      indexDifferences.push("manifest_counts");
    }
    const fileIdentity = (entry) => ({
      key: String(entry?.key || ""),
      row_count: Number(entry?.row_count),
      bytes: Number(entry?.bytes),
      etag_or_hash: String(entry?.etag_or_hash || ""),
    });
    const indexFiles = (indexPayload.files || []).map(fileIdentity).sort((left, right) => left.key.localeCompare(right.key));
    const manifestFiles = (manifest.files || []).map(fileIdentity).sort((left, right) => left.key.localeCompare(right.key));
    if (!sameJson(indexFiles, manifestFiles)) indexDifferences.push("manifest_file_identities");
    if (indexDifferences.length) {
      throw finalProposalError({ key: object.key, object, differingFields: indexDifferences });
    }
  }
}

export async function validateFinalProposalGraph({ runState, proposal, runStatePath = null }) {
  const audit = {
    status: "running",
    started_at_utc: new Date().toISOString(),
    selected_partition_count: 0,
    validated_partition_count: 0,
    partitions: [],
  };
  runState.final_proposal_graph_validation = audit;
  if (runStatePath) atomicWriteJson(runStatePath, runState);
  try {
    const sosLight = runState.execution_path === "sos_light";
    const selectedPrefixes = sosLight
      ? Object.keys(runState.source_evidence_partitions || {}).map((identity) => ({
        prefix: `history/v2/observations/${identity}`,
      }))
      : proposal.prefixes.filter((item) =>
        CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN.test(item.prefix));
    audit.selected_partition_count = selectedPrefixes.length;
    const objects = new Map(proposal.objects.map((object) => [object.key, object]));
    const tombstoneCounts = new Map();
    for (const selected of proposal.prefixes) {
      tombstoneCounts.set(selected.prefix, (tombstoneCounts.get(selected.prefix) || 0) + 1);
    }
    const sourceDerivedPrefixes = new Map();
    for (const object of proposal.objects) {
      if (!object.key.endsWith(".parquet")
        || object.entry?.stage !== "observations_data") continue;
      const partitionPrefix = object.key.slice(0, object.key.lastIndexOf("/"));
      if (!CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN.test(partitionPrefix)) continue;
      if (!sourceDerivedPrefixes.has(partitionPrefix)) sourceDerivedPrefixes.set(partitionPrefix, object);
    }
    for (const [partitionPrefix, partObject] of sourceDerivedPrefixes) {
      const partitionDayPrefix = partitionPrefix.slice(0, partitionPrefix.indexOf("/connector_id="));
      const hasRequiredTombstone = sosLight
        ? tombstoneCounts.get(partitionDayPrefix) === 1
        : tombstoneCounts.get(partitionPrefix) === 1;
      if (!hasRequiredTombstone) {
        throw finalProposalError({
          key: `${partitionPrefix}/manifest.json`,
          object: partObject,
          differingFields: [sosLight
            ? "matching_complete_day_prefix_tombstone"
            : "matching_pollutant_prefix_tombstone"],
        });
      }
    }
    for (const selected of selectedPrefixes) {
      const manifestKey = `${selected.prefix}/manifest.json`;
      const manifestObject = objects.get(manifestKey);
      const stagedParts = proposal.objects.filter((object) =>
        object.key.startsWith(`${selected.prefix}/`) && object.key.endsWith(".parquet"));
      const dedicatedEmptyAllowed = runState.execution_path === "sos_light";
      if (!manifestObject || (!stagedParts.length && !dedicatedEmptyAllowed)) {
        throw finalProposalError({
          key: manifestKey,
          object: manifestObject,
          differingFields: [
            ...(!manifestObject ? ["matching_staged_pollutant_manifest"] : []),
            ...(!stagedParts.length && !dedicatedEmptyAllowed
              ? ["matching_staged_parquet"] : []),
          ],
        });
      }
    }
    for (const selected of selectedPrefixes) {
      const match = selected.prefix.match(CANONICAL_OBSERVATION_POLLUTANT_PREFIX_PATTERN);
      const [, dayUtc, connectorIdRaw, pollutantCode] = match;
      const connectorId = Number(connectorIdRaw);
      const manifestKey = `${selected.prefix}/manifest.json`;
      const manifestObject = objects.get(manifestKey);
      if (!manifestObject) {
        throw finalProposalError({ key: manifestKey, object: null, differingFields: ["missing_final_pollutant_manifest"] });
      }
      const partObjects = proposal.objects.filter((object) =>
        object.key.startsWith(`${selected.prefix}/`) && object.key.endsWith(".parquet"));
      let source;
      try {
        source = loadImmutableSourcePartition({ runState, dayUtc, connectorId, pollutantCode });
      } catch (error) {
        throw finalProposalError({
          key: manifestKey,
          object: manifestObject,
          differingFields: [`immutable_source_evidence:${error instanceof Error ? error.message : String(error)}`],
        });
      }
      if (!partObjects.length && source.rows.length) {
        throw finalProposalError({
          key: manifestKey,
          object: manifestObject,
          differingFields: ["missing_final_staged_parquet"],
        });
      }
      const stagedRows = [];
      const partRows = new Map();
      for (const part of partObjects) {
        let rows;
        try {
          rows = await readCanonicalObservationRows({ body: part.body, connectorId });
        } catch (error) {
          throw finalProposalError({
            key: part.key,
            object: part,
            differingFields: [`staged_parquet:${error instanceof Error ? error.message : String(error)}`],
          });
        }
        if (rows.some((row) => row.connector_id !== connectorId || row.pollutant_code !== pollutantCode)) {
          throw finalProposalError({ key: part.key, object: part, differingFields: ["parquet_scope_identity"] });
        }
        partRows.set(part.key, rows);
        stagedRows.push(...rows);
      }
      const staged = stagedRows.length
        ? computeObservationContentHash(stagedRows)
        : computeEmptyObservationContentHash();
      const stagedEncodedRows = stagedRows.map(encodeCanonicalObservationRow).sort();
      const stagedDifferences = semanticDifferences(source.metadata, staged);
      if (!sameJson(source.encodedRows, stagedEncodedRows)) stagedDifferences.push("canonical_row_identity_and_duplicate_multiplicity");
      if (stagedDifferences.length) {
        throw finalProposalError({ key: manifestKey, object: manifestObject, differingFields: stagedDifferences });
      }
      const manifest = parseManifestObject(manifestObject, "pollutant");
      const manifestDifferences = semanticDifferences(source.metadata, manifest);
      if (manifest.day_utc !== dayUtc || Number(manifest.connector_id) !== connectorId
        || manifest.pollutant_code !== pollutantCode || manifest.manifest_key !== manifestKey) {
        manifestDifferences.push("manifest_scope_identity");
      }
      if (Number(manifest.source_row_count) !== source.rows.length
        || Number(manifest.row_count) !== source.rows.length) {
        manifestDifferences.push("manifest_row_count");
      }
      const manifestTimeseriesRowCounts = manifest.timeseries_row_counts
        ?? (source.rows.length === 0 ? {} : null);
      if (!sameJson(manifestTimeseriesRowCounts, source.timeseriesRowCounts)) {
        manifestDifferences.push("manifest_timeseries_row_counts");
      }
      const manifestPartKeys = [...new Set((manifest.parquet_object_keys || []).map(String))].sort();
      const stagedPartKeys = partObjects.map((part) => part.key).sort();
      if (!sameJson(manifestPartKeys, stagedPartKeys)) manifestDifferences.push("manifest_parquet_object_keys");
      const fileEntries = new Map((manifest.files || []).map((entry) => [String(entry?.key || ""), entry]));
      if (fileEntries.size !== partObjects.length) manifestDifferences.push("manifest_files");
      for (const part of partObjects) {
        const fileEntry = fileEntries.get(part.key);
        const expectedPartCounts = timeseriesRowCounts(partRows.get(part.key));
        if (!fileEntry || Number(fileEntry.bytes) !== part.body.byteLength
          || String(fileEntry.etag_or_hash || "") !== part.entry.sha256
          || Number(fileEntry.row_count) !== partRows.get(part.key).length
          || !sameJson(fileEntry.timeseries_row_counts, expectedPartCounts)) {
          manifestDifferences.push(`manifest_part_identity:${part.key}`);
        }
      }
      if (manifestDifferences.length) {
        throw finalProposalError({
          key: manifestKey,
          object: manifestObject,
          differingFields: manifestDifferences,
          compatibilitySource: manifestObject.entry?.dependency_identities
            && Object.values(manifestObject.entry.dependency_identities).some((identity) => identity?.source === "dropbox")
            ? "dropbox"
            : null,
        });
      }
      Object.assign(manifestObject.entry, {
        proposal_owner: "source_derived_observation_repair",
        final_proposal_graph_validated: true,
        immutable_source_evidence_path: source.evidencePath,
        immutable_source_rows_path: source.rowsPath,
        immutable_source_evidence_sha256: source.evidenceSha256,
        immutable_source_rows_sha256: source.rowsSha256,
        immutable_source_content_hash: source.metadata.observation_content_hash,
        immutable_source_row_count: source.rows.length,
        immutable_source_verification_status_counts: source.metadata.verification_status_counts,
      });
      for (const part of partObjects) {
        Object.assign(part.entry, {
          proposal_owner: "source_derived_observation_repair",
          final_proposal_graph_validated: true,
        });
      }
      audit.partitions.push({
        manifest_key: manifestKey,
        proposal_owner: "source_derived_observation_repair",
        source_content_hash: source.metadata.observation_content_hash,
        staged_content_hash: staged.observation_content_hash,
        proposed_manifest_content_hash: manifest.observation_content_hash,
        row_count: source.rows.length,
        status: "validated",
      });
      audit.validated_partition_count += 1;
    }
    validateFinalParentReferences({ proposal, runState });
    Object.assign(audit, {
      status: "succeeded",
      finished_at_utc: new Date().toISOString(),
      parent_and_index_dependencies_validated: true,
      tombstones_validated: true,
    });
    if (runStatePath) atomicWriteJson(runStatePath, runState);
    return audit;
  } catch (error) {
    Object.assign(audit, {
      status: "failed",
      finished_at_utc: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    if (runStatePath) atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

export async function verifyLiveObservationPartition({
  r2,
  runState,
  object,
  adapters,
  persistence = null,
  verifiedBodyCache = null,
}) {
  const match = object.key.match(CANONICAL_OBSERVATION_POLLUTANT_MANIFEST_PATTERN);
  if (!match) return;
  const [, dayUtc, connectorIdRaw, pollutantCode] = match;
  const sourceIdentity = `day_utc=${dayUtc}/connector_id=${connectorIdRaw}/pollutant_code=${pollutantCode}`;
  if (runState.execution_path === "sos_light"
    && !Object.hasOwn(runState.source_evidence_partitions || {}, sourceIdentity)) return;
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
  const source = loadImmutableSourcePartition({
    runState,
    dayUtc,
    connectorId,
    pollutantCode,
  });
  const partKeys = Array.isArray(manifest.parquet_object_keys)
    ? manifest.parquet_object_keys.map(safeKey)
    : [];
  const dedicatedEmptyAllowed = runState.execution_path === "sos_light";
  if ((!partKeys.length && (source.rows.length > 0 || !dedicatedEmptyAllowed))
    || partKeys.some((key) =>
    !key.startsWith(object.key.slice(0, -"/manifest.json".length) + "/") ||
    !key.endsWith(".parquet")
  )) {
    throw new Error(`Proposed observation pollutant manifest has invalid Parquet keys: ${object.key}`);
  }
  const canonicalRows = [];
  const bodySources = [];
  for (const key of partKeys) {
    const stagedEntry = runState.objects?.[key];
    const expectedSha = String(stagedEntry?.sha256 || "");
    if (!stagedEntry?.r2_verified || !/^[a-f0-9]{64}$/.test(expectedSha)) {
      throw new Error(`Live semantic verification requires a GET-verified staged Parquet: ${key}`);
    }
    let body = verifiedBodyCache?.get(key, expectedSha) || null;
    let sourceKind = "verified_get_cache";
    if (!body) {
      if (runState?.execution_path === "sos_light") {
        throw new Error(
          `Dedicated SOS semantic verification refuses a second GET for changed Parquet: ${key}`,
        );
      }
      const live = await adapters.getObject({ r2, key });
      body = live.body;
      sourceKind = "fresh_get";
      if (Number(live.bytes) !== Number(stagedEntry.bytes) || sha256Hex(body) !== expectedSha) {
        throw new Error(`Live semantic verification R2 identity mismatch: ${key}`);
      }
    }
    bodySources.push({ key, verified_sha256: expectedSha, source: sourceKind });
    canonicalRows.push(...await readCanonicalObservationRows({
      body,
      connectorId,
    }));
  }
  const liveMetadata = canonicalRows.length
    ? computeObservationContentHash(canonicalRows)
    : computeEmptyObservationContentHash();
  const liveSourceDifferences = semanticDifferences(source.metadata, liveMetadata);
  Object.assign(object.entry, {
    live_observation_body_sources: bodySources,
    live_observation_content_hash: liveMetadata.observation_content_hash,
    live_verification_status_counts: liveMetadata.verification_status_counts,
    live_observation_source_evidence_hash: source.metadata.observation_content_hash,
    live_observation_content_verified_against_source: liveSourceDifferences.length === 0,
  });
  if (liveSourceDifferences.length) {
    object.entry.live_observation_failure_classification = "live_observation_content_mismatch";
    persistence?.appendEvent({
      event_type: "semantic_verification_failed",
      canonical_key: object.key,
      ...mutationContext(object.key, "observation_semantic_verification"),
      bytes: object.body.byteLength,
      sha256: object.entry.sha256,
      status: "failed",
      failure_message: `immutable_source_mismatch:${liveSourceDifferences.join(",")}`,
      live_observation_content_hash: liveMetadata.observation_content_hash,
      immutable_source_content_hash: source.metadata.observation_content_hash,
    });
    persistence?.flush();
    throw new Error(
      `Live repaired observation content does not match immutable source evidence: day=${dayUtc} connector=${connectorId} pollutant=${pollutantCode} differing_fields=${liveSourceDifferences.join(",")}`,
    );
  }
  const manifestDifferences = semanticDifferences(liveMetadata, manifest);
  if (Number(manifest.source_row_count) !== liveMetadata.observation_content_hash_row_count
    || Number(manifest.row_count) !== liveMetadata.observation_content_hash_row_count) {
    manifestDifferences.push("manifest_row_count");
  }
  if (manifestDifferences.length) {
    Object.assign(object.entry, {
      live_observation_content_verified: true,
      proposed_manifest_matches_live_observation: false,
      live_observation_failure_classification: "proposal_manifest_defect",
      proposal_manifest_differing_fields: [...new Set(manifestDifferences)],
    });
    persistence?.appendEvent({
      event_type: "semantic_verification_failed",
      canonical_key: object.key,
      ...mutationContext(object.key, "observation_semantic_verification"),
      bytes: object.body.byteLength,
      sha256: object.entry.sha256,
      status: "failed",
      failure_message: `proposal_manifest_mismatch:${[...new Set(manifestDifferences)].join(",")}`,
      live_observation_content_hash: liveMetadata.observation_content_hash,
      immutable_source_content_hash: source.metadata.observation_content_hash,
    });
    persistence?.flush();
    throw new Error(
      `Proposed observation manifest does not match verified live source content: day=${dayUtc} connector=${connectorId} pollutant=${pollutantCode} differing_fields=${[...new Set(manifestDifferences)].join(",")}`,
    );
  }
  Object.assign(object.entry, {
    live_observation_content_verified: true,
    live_observation_content_verified_at_utc: new Date().toISOString(),
    proposed_manifest_matches_live_observation: true,
    live_observation_failure_classification: null,
  });
  for (const key of partKeys) {
    verifiedBodyCache?.invalidateKey(key, "semantic_verification_complete");
  }
  persistence?.appendEvent({
    event_type: "semantic_verification_completed",
    canonical_key: object.key,
    ...mutationContext(object.key, "observation_semantic_verification"),
    bytes: object.body.byteLength,
    sha256: object.entry.sha256,
    status: "verified",
    live_observation_content_hash: liveMetadata.observation_content_hash,
    immutable_source_content_hash: source.metadata.observation_content_hash,
    proposed_manifest_matches_live_observation: true,
    body_sources: bodySources,
  });
}

export async function prepareMergedDayManifest({ r2, object, adapters, exactProposedConnectorSet = false }) {
  if (!/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(object.key)) return;
  const proposed = JSON.parse(object.body.toString("utf8"));
  const dayPrefix = object.key.slice(0, -"manifest.json".length);
  const currentRead = exactProposedConnectorSet ? { state: "not_read", value: [] }
    : await readParentManifestForBoundedRecovery({
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
  if (!exactProposedConnectorSet && currentRead.state !== "valid") {
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
  const mergedReferences = exactProposedConnectorSet
    ? references(proposed)
    : mergeConnectorManifestReferences(currentReferences, references(proposed));
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

export function assertPublicationDependenciesVerified({ object, runState }) {
  for (const dependencyKey of object?.entry?.dependencies || []) {
    const dependency = runState?.objects?.[dependencyKey];
    if (dependency?.proposed && dependency?.structurally_validated && dependency.r2_verified !== true) {
      throw new Error(`Publication dependency is not GET-verified: ${object.key} -> ${dependencyKey}`);
    }
  }
}

export function enforcePublicationDependencyDurability({ object, runState, persistence }) {
  assertPublicationDependenciesVerified({ object, runState });
  if ((object?.entry?.dependencies || []).length > 0) persistence.flush();
}

export async function applySosLightPerDayUnits({
  selectedDays,
  dayGroups,
  connectorGroups,
  applyDeletion,
  applyConnectorGroup,
  applyDayFinalization,
  publishAffectedIndexes,
  publicationState = {},
  persist = async () => {},
  durabilityBarrier = async () => {},
  appendEvent = () => {},
  reportProgress = () => {},
}) {
  const units = [...selectedDays].sort().map((dayUtc) => {
    const dayOperations = dayGroups.get(dayUtc) || [];
    const deletionOperations = dayOperations.filter((operation) => operation.kind === "delete");
    const parentOperations = dayOperations.filter((operation) => operation.kind !== "delete");
    const expectedDayParent = `history/v2/observations/day_utc=${dayUtc}/manifest.json`;
    if (deletionOperations.length !== 1) {
      throw new Error(`SOS-light requires one complete-day deletion before upload: ${dayUtc}`);
    }
    if (parentOperations.length !== 1
      || parentOperations[0].kind !== "put"
      || parentOperations[0].key !== expectedDayParent) {
      throw new Error(`SOS-light requires one final assembled day parent: ${dayUtc}`);
    }
    const dayConnectorGroups = Array.from(connectorGroups.values())
      .filter((group) => group.day_utc === dayUtc)
      .sort((left, right) => left.connector_id - right.connector_id);
    if (!dayConnectorGroups.some((group) => group.connector_id === 1)) {
      throw new Error(`SOS-light requires a connector 1 publication group: ${dayUtc}`);
    }
    return {
      dayUtc,
      deletionOperation: deletionOperations[0],
      parentOperations,
      dayConnectorGroups,
    };
  });

  for (let dayIndex = 0; dayIndex < units.length; dayIndex += 1) {
    const { dayUtc, deletionOperation, parentOperations, dayConnectorGroups } = units[dayIndex];
    const state = publicationState[dayUtc] = {
      day_utc: dayUtc,
      status: "not_started",
      completed_publication_level: "none",
      deletion_verified: false,
      connector_group_count: dayConnectorGroups.length,
      completed_connector_group_count: 0,
      day_parent_verified: false,
    };
    try {
      state.status = "deleting";
      reportProgress(`day deletion started day=${dayUtc} day_progress=${dayIndex + 1}/${units.length}`);
      await persist("before_day_deletion");
      await applyDeletion({ dayUtc, operation: deletionOperation });
      state.deletion_verified = true;
      state.completed_publication_level = "complete_day_deletion_verified";
      state.status = "deletion_verified";
      await durabilityBarrier("day_deletion_verified");
      await persist("after_deletion_verification");
      reportProgress(`day deletion verified day=${dayUtc} day_progress=${dayIndex + 1}/${units.length}`);
      state.status = "publishing_children";
      reportProgress(`day publication started day=${dayUtc} day_progress=${dayIndex + 1}/${units.length}`);
      for (const group of dayConnectorGroups) {
        await applyConnectorGroup(group);
        state.completed_connector_group_count += 1;
        state.completed_publication_level = "connector_parents_verified";
        state.status = "publishing_connector_parents";
      }
      state.status = "publishing_day_parent";
      await applyDayFinalization({ dayUtc, operations: parentOperations });
      state.day_parent_verified = true;
      state.completed_publication_level = "day_parent_verified";
      state.status = "day_parent_verified";
      state.completed_at_utc = new Date().toISOString();
      appendEvent({
        event_type: "sos_light_day_completed",
        day_utc: dayUtc,
        connector_id: 1,
        publication_stage: "day_parent",
        status: "verified",
        completed_publication_level: "day_parent_verified",
      });
      await durabilityBarrier("day_parent_verified");
      await persist("after_day_parent_verified");
      reportProgress(`day parent verified day=${dayUtc} day_progress=${dayIndex + 1}/${units.length}`);
      reportProgress(`day completed day=${dayUtc} day_progress=${dayIndex + 1}/${units.length}`);
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.failed_at_utc = new Date().toISOString();
      try {
        appendEvent({
          event_type: "sos_light_day_failed",
          day_utc: dayUtc,
          connector_id: 1,
          publication_stage: state.completed_publication_level,
          status: "failed",
          failure_message: state.error,
          completed_publication_level: state.completed_publication_level,
        });
        await durabilityBarrier("day_failure");
        await persist("day_failed");
      } catch {
        // The canonical outer failure handler records the checkpoint failure.
      }
      throw error;
    }
  }
  await publishAffectedIndexes();
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
  const dedicatedSosProposal = validateDedicatedSosHistoricalProposal({
    runState,
    proposal,
  });
  try {
    await validateFinalProposalGraph({ runState, proposal });
  } catch (error) {
    runState.apply = {
      status: "failed",
      current_phase: "final_proposal_validation",
      error: error instanceof Error ? error.message : String(error),
      finished_at_utc: new Date().toISOString(),
      persistence: {
        compact_checkpoint_count: 0,
        complete_run_state_write_count: 1,
        node_complete_run_state_write_count: 1,
        coordinator_complete_run_state_write_count: 0,
        total_complete_run_state_write_count: 1,
        mutation_journal_event_count: 0,
        mutation_journal_flush_count: 0,
        deleted_key_sidecar_count: 0,
      },
    };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
  const selectedDays = dedicatedSosProposal.dedicated
    ? dedicatedSosProposal.selected_days
    : [...new Set([
      ...proposal.prefixes.map((entry) => mutationContext(entry.prefix).day_utc),
      ...proposal.objects.map((entry) => mutationContext(entry.key).day_utc),
    ].filter(Boolean))].sort();
  let publicationSchedule;
  try {
    publicationSchedule = buildFrozenPublicationSchedule({
      proposal,
      selectedDays,
      publicationMode: dedicatedSosProposal.dedicated ? "sos_light" : "generic",
      runState,
    });
  } catch (error) {
    runState.apply = {
      status: "failed",
      current_phase: "publication_schedule_validation",
      publication_schedule_validation: "failed",
      error: error instanceof Error ? error.message : String(error),
      finished_at_utc: new Date().toISOString(),
      persistence: {
        compact_checkpoint_count: 0,
        complete_run_state_write_count: 1,
        node_complete_run_state_write_count: 1,
        coordinator_complete_run_state_write_count: 0,
        total_complete_run_state_write_count: 1,
        mutation_journal_event_count: 0,
        mutation_journal_flush_count: 0,
        deleted_key_sidecar_count: 0,
      },
    };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
  const counts = {
    planned_deletions: proposal.prefixes.length,
    planned_writes: publicationSchedule.total_positions,
    planned_post_put_verifications: publicationSchedule.total_positions,
    scheduled_changed_objects: publicationSchedule.total_positions,
    completed_scheduled_objects: 0,
    last_completed_schedule_position: 0,
    deleted_objects: 0,
    completed_deletions: 0,
    completed_writes: 0,
    get_verified_writes: 0,
    completed_post_put_verifications: 0,
    failed_operations: 0,
  };
  const { progressState, perDayStatus } = createInitialApplyProgressState({
    runStatePath,
    runId: runState.run_id,
    counts,
    selectedDays,
    schedule: publicationSchedule,
  });
  runState.apply = {
    status: "running",
    started_at_utc: new Date().toISOString(),
    final_proposal_graph_validation: "succeeded",
    publication_schedule_validation: "succeeded",
    publication_schedule: publicationSchedule,
    dedicated_sos_historical_proposal: dedicatedSosProposal,
    connector_day_publication: {},
    ...counts,
  };
  runState.writer_locks = [];
  let persistence;
  try {
    persistence = createApplyPersistence({
      runStatePath,
      runId: runState.run_id,
      progressState,
      io: adapters.persistenceIo || {},
    });
  } catch (error) {
    runState.apply = {
      ...runState.apply,
      status: "failed",
      current_phase: "apply_persistence_initialization",
      error: error instanceof Error ? error.message : String(error),
      finished_at_utc: new Date().toISOString(),
      persistence: {
        compact_checkpoint_count: 0,
        complete_run_state_write_count: 1,
        node_complete_run_state_write_count: 1,
        coordinator_complete_run_state_write_count: 0,
        total_complete_run_state_write_count: 1,
        mutation_journal_event_count: 0,
        mutation_journal_flush_count: 0,
        deleted_key_sidecar_count: 0,
        mutation_journal_failure: error instanceof Error ? error.message : String(error),
      },
    };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
  let completeRunStateWriteCount = 0;
  const syncProgress = () => {
    Object.assign(progressState, counts);
    const completedDays = selectedDays.filter((dayUtc) =>
      perDayStatus[dayUtc]?.status === "day_parent_verified");
    progressState.last_completed_day_utc = completedDays.at(-1) || null;
    const activeDay = selectedDays.find((dayUtc) =>
      !["not_started", "day_parent_verified"].includes(perDayStatus[dayUtc]?.status));
    if (activeDay && progressState.status === "running") {
      progressState.current_day_utc = activeDay;
      progressState.current_phase = perDayStatus[activeDay].status;
    }
    progressState.deletions = proposal.prefixes.map(({ entry, prefix }) => ({
      prefix,
      deleted_object_count: Number(entry.deleted_object_count || 0),
      deleted_keys_sha256: entry.deleted_keys_sha256 || null,
      deleted_keys_sidecar_path: entry.deleted_keys_sidecar_path || null,
      deleted_keys_sidecar_bytes: Number(entry.deleted_keys_sidecar_bytes || 0),
      deletion_started_at_utc: entry.deletion_started_at_utc || null,
      deletion_completed_at_utc: entry.deletion_completed_at_utc || null,
      deletion_verified: entry.deletion_verified === true,
      status: entry.status || "planned",
    }));
  };
  const syncPersistenceDiagnostics = () => {
    const coordinatorWriteCount = Number(
      runState.apply.persistence?.coordinator_complete_run_state_write_count || 0,
    );
    runState.apply.persistence = {
      ...persistence.snapshot(),
      complete_run_state_write_count: completeRunStateWriteCount + coordinatorWriteCount,
      node_complete_run_state_write_count: completeRunStateWriteCount,
      coordinator_complete_run_state_write_count: coordinatorWriteCount,
      total_complete_run_state_write_count:
        completeRunStateWriteCount + coordinatorWriteCount,
    };
    runState.apply_progress = {
      path: persistence.progressPath,
      status: progressState.status,
      current_phase: progressState.current_phase,
      last_completed_day_utc: progressState.last_completed_day_utc,
    };
  };
  const writeCompleteRunState = () => {
    const nextWriteCount = completeRunStateWriteCount + 1;
    syncPersistenceDiagnostics();
    runState.apply.persistence.node_complete_run_state_write_count = nextWriteCount;
    runState.apply.persistence.total_complete_run_state_write_count = nextWriteCount
      + Number(runState.apply.persistence.coordinator_complete_run_state_write_count || 0);
    runState.apply.persistence.complete_run_state_write_count =
      runState.apply.persistence.total_complete_run_state_write_count;
    atomicWriteJson(runStatePath, runState);
    completeRunStateWriteCount = nextWriteCount;
  };
  const checkpoint = async (reason) => {
    syncProgress();
    persistence.checkpoint(reason);
    syncPersistenceDiagnostics();
  };
  const startedAtMs = Date.now();
  const report = createBoundedProgressReporter({ log: adapters.progressLog });
  const elapsedSeconds = () => Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
  const progressMessage = (label) => `${label} completed_objects=${counts.completed_writes}/${counts.planned_writes} `
    + `completed_verifications=${counts.completed_post_put_verifications}/${counts.planned_post_put_verifications} `
    + `elapsed_seconds=${elapsedSeconds()}`;
  let lastOptionalCheckpointAt = Date.now();
  let lastOptionalCheckpointWrites = 0;
  const maybeCheckpointAndLog = async () => {
    const now = Date.now();
    const objectThresholdReached = counts.completed_writes - lastOptionalCheckpointWrites
      >= APPLY_PROGRESS_CHECKPOINT_OBJECT_INTERVAL;
    const timeThresholdReached = now - lastOptionalCheckpointAt
      >= APPLY_PROGRESS_CHECKPOINT_ELAPSED_MS;
    if (objectThresholdReached || timeThresholdReached) {
      await checkpoint("bounded_within_scope_progress");
      lastOptionalCheckpointAt = now;
      lastOptionalCheckpointWrites = counts.completed_writes;
    }
    const progressLabel = progressState.current_phase === "publishing_affected_indexes"
      ? "bounded index progress"
      : "within-day object progress";
    report({
      message: progressMessage(progressLabel),
      completedObjects: counts.completed_writes,
    });
  };
  try {
    writeCompleteRunState();
    persistence.appendEvent({
      event_type: "canonical_apply_started",
      publication_stage: "final_proposal_validated",
      status: "started",
      publication_schedule_sha256: publicationSchedule.schedule_sha256,
      total_schedule_positions: publicationSchedule.total_positions,
      planned_deletions: counts.planned_deletions,
      planned_writes: counts.planned_writes,
      planned_post_put_verifications: counts.planned_post_put_verifications,
    });
    persistence.flush();
    await checkpoint("final_proposal_validated_before_first_mutation");
    report({ message: progressMessage("canonical apply started"), completedObjects: 0, force: true });
    const historyWriterClient = adapters.historyWriterClient;
    if (!historyWriterClient) throw new Error("canonical apply requires one retained PostgreSQL history-writer session");
    const operations = [];
    for (const prefixEntry of proposal.prefixes) {
      operations.push({ kind: "delete", key: prefixEntry.prefix, prefixEntry });
    }
    const objectByKey = new Map(proposal.objects.map((object) => [object.key, object]));
    for (const scheduleEntry of publicationSchedule.entries) {
      const object = objectByKey.get(scheduleEntry.canonical_key);
      if (!object) throw new Error(`Scheduled object is unavailable during apply setup: ${scheduleEntry.canonical_key}`);
      object.schedule = scheduleEntry;
      operations.push({ kind: "put", key: object.key, object });
    }
    const connectorGroups = new Map();
    const dayGroups = new Map();
    const globalOperations = [];
    for (const operation of operations) {
      if (operation.key.startsWith("history/_index_v2/")) {
        globalOperations.push(operation);
        continue;
      }
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
    const scheduleByKey = new Map(publicationSchedule.entries.map((entry) => [entry.canonical_key, entry]));
    let nextSchedulePosition = 1;
    const executeOperation = async (operation, verifiedBodyCache = null) => {
      progressState.current_object_key = operation.kind === "put" ? operation.key : null;
      progressState.current_deletion_prefix = operation.kind === "delete" ? operation.key : null;
      progressState.current_day_utc = mutationContext(operation.key).day_utc;
      progressState.current_publication_stage = operation.kind === "put"
        ? objectPublicationStage(operation.object)
        : operation.prefixEntry.entry?.stage || "prefix_deletion";
      if (operation.kind === "delete") {
        const { prefixEntry } = operation;
        counts.deleted_objects += await deleteAndVerifyPrefix({
          r2,
          prefixEntry,
          adapters: resolvedAdapters,
          persistence,
          checkpoint,
          verifiedBodyCache,
        });
        counts.completed_deletions += 1;
        if (!dedicatedSosProposal.dedicated) await checkpoint("after_deletion_verification");
      } else {
        const { object } = operation;
        const scheduled = scheduleByKey.get(object.key);
        assertFrozenScheduleOperation({ object, scheduled, expectedPosition: nextSchedulePosition });
        assertPublicationDependenciesVerified({ object, runState });
        await verifyLiveObservationPartition({
          r2,
          runState,
          object,
          adapters: resolvedAdapters,
          persistence,
          verifiedBodyCache,
        });
        enforcePublicationDependencyDurability({ object, runState, persistence });
        await putAndVerifyObject({
          r2,
          runState,
          object,
          adapters: resolvedAdapters,
          persistence,
          verifiedBodyCache,
        });
        counts.completed_writes += 1;
        counts.get_verified_writes += 1;
        counts.completed_post_put_verifications += 1;
        counts.completed_scheduled_objects += 1;
        counts.last_completed_schedule_position = scheduled.position;
        progressState.completed_scheduled_object_count = counts.completed_scheduled_objects;
        progressState.last_completed_schedule_position = scheduled.position;
        nextSchedulePosition += 1;
        progressState.next_schedule_position = nextSchedulePosition <= publicationSchedule.total_positions
          ? nextSchedulePosition : null;
        await maybeCheckpointAndLog();
      }
    };
    const executeConnectorGroup = async (group) => {
      const groupKey = `${group.day_utc}|${group.connector_id}`;
      const verifiedBodyCache = dedicatedSosProposal.dedicated && group.connector_id !== 1
        ? null : createVerifiedGetBodyCache();
      runState.apply.connector_day_publication[groupKey] = {
        day_utc: group.day_utc,
        connector_id: group.connector_id,
        status: "running",
        completed_publication_level: "none",
      };
      await runCanonicalConnectorDayWriter({
        client: historyWriterClient,
        dayUtc: group.day_utc,
        connectorId: group.connector_id,
        diagnosticEnvironment: runState.environment,
        diagnostics: runState.writer_locks,
        write: async () => {
          try {
            for (const operation of group.operations) {
              await executeOperation(operation, verifiedBodyCache);
              const publication = runState.apply.connector_day_publication[groupKey];
              publication.completed_publication_level = operation.kind === "delete"
                ? "selected_prefix_deletion"
                : publicationRank(operation.key) <= 10
                ? "observation_parquet"
                : publicationRank(operation.key) <= 20
                ? "observation_pollutant_manifest"
                : publicationRank(operation.key) <= 30
                ? "observation_connector_manifest"
                : publicationRank(operation.key) <= 40
                ? "observation_indexes"
                : publicationRank(operation.key) <= 70
                ? "aqi_manifests_and_data"
                : "aqi_indexes";
            }
            runState.apply.connector_day_publication[groupKey].status = "succeeded";
            return { operation_count: group.operations.length };
          } catch (error) {
            runState.apply.connector_day_publication[groupKey].status = "failed";
            runState.apply.connector_day_publication[groupKey].error = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            verifiedBodyCache?.clear(
              runState.apply.connector_day_publication[groupKey].status === "succeeded"
                ? "connector_day_scope_complete"
                : "connector_day_scope_failed",
            );
            runState.apply.connector_day_publication[groupKey].verified_get_cache = verifiedBodyCache?.snapshot() || null;
          }
        },
        verify: async (written) => ({ ...written, get_verified: true }),
      });
    };
    const executeDayFinalization = async ({ dayUtc, operations: dayOperations }) => {
      await runCanonicalDayFinalizer({
        client: historyWriterClient,
        dayUtc,
        diagnosticEnvironment: runState.environment,
        diagnostics: runState.writer_locks,
        finalize: async () => {
          for (const operation of dayOperations) {
            await executeOperation(operation);
          }
          return { operation_count: dayOperations.length };
        },
      });
    };
    const affectedDays = Array.from(new Set([
      ...Array.from(connectorGroups.values()).map((group) => group.day_utc),
      ...dayGroups.keys(),
    ])).sort();
    const publishAffectedIndexes = async () => {
      if (!globalOperations.length && !affectedDays.length) return;
      progressState.current_phase = "publishing_affected_indexes";
      progressState.current_day_utc = null;
      progressState.current_publication_stage = "affected_indexes";
      progressState.index_publication_started = true;
      persistence.appendEvent({
        event_type: "index_publication_started",
        publication_stage: "affected_indexes",
        status: "started",
        planned_index_object_count: globalOperations.length,
      });
      persistence.flush();
      await checkpoint("before_affected_index_publication");
      report({ message: progressMessage("index publication started"), completedObjects: counts.completed_writes, force: true });
      await runCanonicalGlobalIndexFinalizer({
          client: historyWriterClient,
          diagnosticEnvironment: runState.environment,
          diagnostics: runState.writer_locks,
          finalize: async () => {
            for (const operation of globalOperations) await executeOperation(operation);
            if (affectedDays.length) {
              runState.global_index_finalization = {
                status: "succeeded",
                mode: dedicatedSosProposal.dedicated ? "sos-light" : "canonical-preflight",
                authority: "frozen_preflight_publication_schedule",
                affected_days_utc: affectedDays,
                planned_index_object_count: globalOperations.length,
                live_generated_object_discovery_used: false,
                publication_schedule_sha256: publicationSchedule.schedule_sha256,
              };
            }
          },
        });
      progressState.index_publication_completed = true;
      progressState.current_publication_stage = "affected_indexes_verified";
      persistence.appendEvent({
        event_type: "index_publication_completed",
        publication_stage: "affected_indexes",
        status: "verified",
        completed_index_object_count: globalOperations.length,
        publication_schedule_sha256: publicationSchedule.schedule_sha256,
      });
      persistence.flush();
      await checkpoint("after_affected_index_publication");
      report({ message: progressMessage("index publication completed"), completedObjects: counts.completed_writes, force: true });
    };
    if (dedicatedSosProposal.dedicated) {
      runState.apply.sos_light_day_publication = perDayStatus;
      await applySosLightPerDayUnits({
        selectedDays: dedicatedSosProposal.selected_days,
        dayGroups,
        connectorGroups,
        applyDeletion: async ({ dayUtc, operation }) => {
          await runCanonicalDayFinalizer({
            client: historyWriterClient,
            dayUtc,
            diagnosticEnvironment: runState.environment,
            diagnostics: runState.writer_locks,
            finalize: async () => {
              await executeOperation(operation);
              return { operation_count: 1, complete_day_deleted: true };
            },
          });
        },
        applyConnectorGroup: executeConnectorGroup,
        applyDayFinalization: executeDayFinalization,
        publishAffectedIndexes,
        publicationState: runState.apply.sos_light_day_publication,
        persist: checkpoint,
        durabilityBarrier: async () => persistence.flush(),
        appendEvent: persistence.appendEvent,
        reportProgress: (message) => report({
          message: progressMessage(message),
          completedObjects: counts.completed_writes,
          force: true,
        }),
      });
    } else {
      for (const group of Array.from(connectorGroups.values()).sort((left, right) =>
        left.day_utc.localeCompare(right.day_utc) || left.connector_id - right.connector_id)) {
        await executeConnectorGroup(group);
      }
      for (const [dayUtc, dayOperations] of Array.from(dayGroups.entries())
        .sort(([left], [right]) => left.localeCompare(right))) {
        await executeDayFinalization({ dayUtc, operations: dayOperations });
      }
      await publishAffectedIndexes();
    }
    if (dedicatedSosProposal.dedicated) {
      Object.assign(runState.sos_light, {
        complete_day_deletion_prefix_count: proposal.prefixes.length,
        complete_day_deleted_object_count: counts.deleted_objects,
        complete_day_uploaded_object_count: proposal.objects.filter((object) =>
          proposal.prefixes.some((item) => object.key.startsWith(`${item.prefix}/`))
            && object.entry.r2_verified === true
        ).length,
        changed_object_verification_status:
          counts.get_verified_writes === counts.completed_writes ? "succeeded" : "failed",
        affected_observation_index_object_count: globalOperations.length,
        affected_observation_index_status: globalOperations.every((operation) =>
          operation.kind === "put" && operation.object.entry.r2_verified === true
        ) ? "succeeded" : "failed",
      });
    }
    if (counts.completed_scheduled_objects !== publicationSchedule.total_positions
      || nextSchedulePosition !== publicationSchedule.total_positions + 1) {
      throw new Error(`Publication schedule execution incomplete: completed ${counts.completed_scheduled_objects}/${publicationSchedule.total_positions}`);
    }
    progressState.status = "succeeded";
    progressState.current_phase = "canonical_apply_completed";
    progressState.current_day_utc = null;
    progressState.current_object_key = null;
    progressState.current_deletion_prefix = null;
    progressState.current_publication_stage = "complete";
    persistence.appendEvent({
      event_type: "canonical_apply_completed",
      publication_stage: "complete",
      status: "succeeded",
      publication_schedule_sha256: publicationSchedule.schedule_sha256,
      last_completed_schedule_position: counts.last_completed_schedule_position,
      ...counts,
    });
    persistence.close();
    await checkpoint("canonical_apply_successful_completion");
    runState.apply = {
      ...runState.apply,
      ...counts,
      status: "succeeded",
      finished_at_utc: new Date().toISOString(),
    };
    writeCompleteRunState();
    report({ message: progressMessage("canonical apply completed"), completedObjects: counts.completed_writes, force: true });
    return {
      ok: true,
      status: "succeeded",
      ...counts,
      persistence: runState.apply.persistence,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedKey = progressState.current_object_key;
    const failedPrefix = progressState.current_deletion_prefix;
    const failedDayUtc = progressState.current_day_utc;
    const failedStage = progressState.current_publication_stage;
    const activeDayState = failedDayUtc ? perDayStatus[failedDayUtc] : null;
    let lastSuccessfulCheckpoint = progressState.last_checkpoint_at_utc ? {
      path: persistence.progressPath,
      reason: progressState.last_checkpoint_reason || null,
      timestamp_utc: progressState.last_checkpoint_at_utc,
      checkpoint_count: Number(progressState.compact_checkpoint_count || 0),
    } : null;
    counts.failed_operations += 1;
    progressState.status = "failed";
    progressState.current_phase = "canonical_apply_failed";
    progressState.failed_operations = counts.failed_operations;
    try {
      persistence.appendEvent({
        event_type: "canonical_apply_failed",
        canonical_key: progressState.current_object_key,
        prefix: progressState.current_deletion_prefix,
        day_utc: progressState.current_day_utc,
        connector_id: mutationContext(
          progressState.current_object_key || progressState.current_deletion_prefix,
        ).connector_id,
        publication_stage: progressState.current_publication_stage,
        status: "failed",
        failure_message: message,
        publication_schedule_sha256: publicationSchedule.schedule_sha256,
        last_completed_schedule_position: counts.last_completed_schedule_position,
        next_schedule_position: nextSchedulePosition <= publicationSchedule.total_positions
          ? nextSchedulePosition : null,
        last_completed_day_utc: progressState.last_completed_day_utc,
      });
      persistence.flush();
    } catch {
      // The compact failure checkpoint exposes the journal failure.
    }
    persistence.closeAfterFailure();
    let failureCheckpointError = null;
    let failureCheckpointSucceeded = false;
    try {
      await checkpoint("canonical_apply_failure");
      failureCheckpointSucceeded = true;
      lastSuccessfulCheckpoint = {
        path: persistence.progressPath,
        reason: progressState.last_checkpoint_reason || null,
        timestamp_utc: progressState.last_checkpoint_at_utc,
        checkpoint_count: Number(progressState.compact_checkpoint_count || 0),
      };
    } catch (checkpointError) {
      failureCheckpointError = checkpointError instanceof Error
        ? checkpointError.message : String(checkpointError);
      progressState.checkpoint_failure = failureCheckpointError;
    }
    const failureCheckpoint = {
      attempted: true,
      succeeded: failureCheckpointSucceeded,
      error: failureCheckpointError,
      last_successfully_written_checkpoint: lastSuccessfulCheckpoint,
    };
    runState.apply = {
      ...runState.apply,
      ...counts,
      status: "failed",
      error: message,
      failure_checkpoint: failureCheckpoint,
      failed_operation: {
        canonical_key: failedKey,
        prefix: failedPrefix,
        day_utc: failedDayUtc,
        publication_stage: failedStage,
      },
      finished_at_utc: new Date().toISOString(),
      last_completed_day_utc: progressState.last_completed_day_utc,
      last_completed_publication_level:
        activeDayState?.completed_publication_level
        || (progressState.index_publication_completed ? "affected_indexes_verified" : "none"),
      later_selected_days_untouched: dedicatedSosProposal.dedicated,
      untouched_later_selected_days: dedicatedSosProposal.dedicated
        ? selectedDays.filter((dayUtc) => perDayStatus[dayUtc]?.status === "not_started")
        : [],
    };
    writeCompleteRunState();
    report({ message: progressMessage(`canonical apply failed error=${message}`), completedObjects: counts.completed_writes, force: true });
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStatePath = path.resolve(args.runStateJson);
  const config = resolveR2HistoryIndexConfig(process.env);
  if (!hasRequiredR2Config(config.r2)) throw new Error("canonical apply requires complete R2 configuration");
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
