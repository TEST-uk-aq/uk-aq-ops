import fs from "node:fs";
import path from "node:path";

import {
  createApplyPersistence,
  createInitialApplyProgressState,
} from "../uk_aq_apply_integrity_proposal.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

export const SOS_LIGHT_V3_APPLY_PERSISTENCE_CONTRACT =
  "sos-light-v3-apply-persistence-v1";

function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  const temporaryPath = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "w", 0o600);
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < body.byteLength) {
      const written = fs.writeSync(
        descriptor,
        body,
        offset,
        body.byteLength - offset,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error(`Atomic write made no progress: ${target}`);
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, target);
    const directoryDescriptor = fs.openSync(path.dirname(target), "r");
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

function exactBody(value, key) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`SOS-light-v3 publication body is unavailable: ${key}`);
}

function normalizedKey(raw) {
  const key = String(raw || "").trim().replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe SOS-light-v3 mutation key: ${String(raw)}`);
  }
  return key;
}

function mutationContext(keyOrPrefix, stage = null) {
  const value = String(keyOrPrefix || "");
  const dayMatch = value.match(/day_utc=(\d{4}-\d{2}-\d{2})/);
  const connectorMatch = value.match(/connector_id=([1-9]\d*)/);
  return {
    day_utc: dayMatch?.[1] || null,
    connector_id: connectorMatch ? Number(connectorMatch[1]) : null,
    publication_stage: stage,
  };
}

function publicationStage(key, supplied = null) {
  const configured = String(supplied || "").trim();
  if (configured) return configured;
  if (key.endsWith(".parquet")) return "observation_parquet";
  if (/\/pollutant_code=[^/]+\/manifest\.json$/.test(key)) {
    return "observation_pollutant_manifest";
  }
  if (/\/connector_id=\d+\/manifest\.json$/.test(key)) {
    return "observation_connector_manifest";
  }
  if (/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key)) {
    return "observation_day_manifest";
  }
  if (key === "history/_index_v3/observations_timeseries_latest.json") {
    return "observation_latest_index";
  }
  if (key.startsWith("history/_index_v3/")) return "observation_index";
  if (key.startsWith("history/v3/observations/")) {
    return "observation_aggregate_manifest";
  }
  throw new Error(`SOS-light-v3 mutation escaped fixed authority: ${key}`);
}

function selectedDays(runState) {
  return [...new Set((runState?.sos_light?.days || [])
    .map((entry) => String(entry?.day_utc || "").trim())
    .filter(Boolean))]
    .sort();
}

function isSkippedPut(result) {
  return result?.skipped === true ||
    String(result?.status || "") === "skipped_unchanged";
}

export async function runPersistedSosLightV3Apply({
  runStatePath,
  runState,
  proposal,
  r2,
  executeWriter,
  adapters,
  persistenceIo = {},
}) {
  if (typeof executeWriter !== "function") {
    throw new TypeError("SOS-light-v3 persisted apply requires executeWriter");
  }
  for (const name of [
    "getObject",
    "putObject",
    "putIfChanged",
    "listAllObjects",
    "deleteObjects",
  ]) {
    if (typeof adapters?.[name] !== "function") {
      throw new TypeError(`SOS-light-v3 persisted apply requires ${name}`);
    }
  }
  const days = selectedDays(runState);
  if (!days.length || proposal?.prefixes?.length !== days.length) {
    throw new Error("SOS-light-v3 persisted apply requires validated selected days");
  }
  const counts = {
    planned_deletions: proposal.prefixes.length,
    planned_writes: null,
    planned_post_put_verifications: null,
    completed_deletions: 0,
    deleted_objects: 0,
    completed_writes: 0,
    uploaded_writes: 0,
    skipped_unchanged_writes: 0,
    get_verified_writes: 0,
    completed_post_put_verifications: 0,
    failed_operations: 0,
  };
  const { progressState, perDayStatus } = createInitialApplyProgressState({
    runStatePath,
    runId: runState.run_id,
    counts,
    selectedDays: days,
  });
  progressState.current_phase = "fixed_v3_apply_intent";
  progressState.current_publication_stage = "fixed_v3_apply_intent";
  const startedAtUtc = new Date().toISOString();
  runState.apply = {
    status: "running",
    persistence_contract_version: SOS_LIGHT_V3_APPLY_PERSISTENCE_CONTRACT,
    current_phase: progressState.current_phase,
    started_at_utc: startedAtUtc,
    final_proposal_graph_validation: "succeeded",
    canonical_v3_writer_invoked: false,
    v3_publication_evidence: [],
    ...counts,
  };

  let persistence;
  let completeRunStateWriteCount = 0;
  try {
    persistence = createApplyPersistence({
      runStatePath,
      runId: runState.run_id,
      progressState,
      io: persistenceIo,
    });
  } catch (error) {
    runState.apply = {
      ...runState.apply,
      status: "failed",
      current_phase: "apply_persistence_initialization",
      error: error instanceof Error ? error.message : String(error),
      finished_at_utc: new Date().toISOString(),
      persistence: {
        contract_version: SOS_LIGHT_V3_APPLY_PERSISTENCE_CONTRACT,
        mutation_journal_failure:
          error instanceof Error ? error.message : String(error),
        compact_checkpoint_count: 0,
        node_complete_run_state_write_count: 1,
        coordinator_complete_run_state_write_count: 0,
        total_complete_run_state_write_count: 1,
        complete_run_state_write_count: 1,
      },
    };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }

  const publicationEvidence = [];
  const pendingByKey = new Map();
  let nextOperationId = 1;
  let currentOperation = null;

  const syncPersistence = () => {
    const coordinatorWrites = Number(
      runState.apply?.persistence?.coordinator_complete_run_state_write_count || 0,
    );
    runState.apply.persistence = {
      ...persistence.snapshot(),
      contract_version: SOS_LIGHT_V3_APPLY_PERSISTENCE_CONTRACT,
      node_complete_run_state_write_count: completeRunStateWriteCount,
      coordinator_complete_run_state_write_count: coordinatorWrites,
      total_complete_run_state_write_count:
        completeRunStateWriteCount + coordinatorWrites,
      complete_run_state_write_count:
        completeRunStateWriteCount + coordinatorWrites,
    };
    runState.apply_progress = {
      path: persistence.progressPath,
      status: progressState.status,
      current_phase: progressState.current_phase,
      last_completed_day_utc: progressState.last_completed_day_utc,
    };
  };
  const writeCompleteRunState = () => {
    completeRunStateWriteCount += 1;
    syncPersistence();
    runState.apply.persistence.node_complete_run_state_write_count =
      completeRunStateWriteCount;
    runState.apply.persistence.total_complete_run_state_write_count =
      completeRunStateWriteCount +
      Number(runState.apply.persistence.coordinator_complete_run_state_write_count || 0);
    runState.apply.persistence.complete_run_state_write_count =
      runState.apply.persistence.total_complete_run_state_write_count;
    atomicWriteJson(runStatePath, runState);
  };
  const checkpoint = (reason) => {
    Object.assign(progressState, counts, {
      current_phase: runState.apply.current_phase,
      current_publication_stage:
        currentOperation?.publication_stage || runState.apply.current_phase,
      current_object_key: currentOperation?.key || null,
    });
    persistence.checkpoint(reason);
    syncPersistence();
  };
  const appendFailure = (operation, error) => {
    if (operation?.failure_recorded === true) return;
    if (operation) operation.failure_recorded = true;
    try {
      persistence.appendEvent({
        event_type: "put_or_verification_failed",
        operation_id: operation?.operation_id || null,
        canonical_key: operation?.key || null,
        sha256: operation?.sha256 || null,
        byte_size: operation?.byte_size || null,
        ...mutationContext(
          operation?.key,
          operation?.publication_stage || progressState.current_publication_stage,
        ),
        status: "failed",
        failure_message: error instanceof Error ? error.message : String(error),
      });
      persistence.flush();
    } catch {
      // Terminal state below retains the persistence failure independently.
    }
  };
  const beginPut = (artifact, suppliedStage = null) => {
    const key = normalizedKey(artifact?.key);
    const body = exactBody(artifact?.body, key);
    const operation = {
      operation_id: nextOperationId,
      key,
      body,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
      content_type: String(
        artifact?.content_type || "application/octet-stream",
      ),
      publication_stage: publicationStage(
        key,
        suppliedStage || artifact?.publication_stage,
      ),
      put_status: null,
      uploaded: null,
      verified: false,
    };
    nextOperationId += 1;
    if (pendingByKey.has(key)) {
      throw new Error(`SOS-light-v3 publication key is already awaiting verification: ${key}`);
    }
    pendingByKey.set(key, operation);
    currentOperation = operation;
    progressState.current_object_key = key;
    progressState.current_publication_stage = operation.publication_stage;
    progressState.current_day_utc = mutationContext(key).day_utc;
    persistence.appendEvent({
      event_type: "put_started",
      operation_id: operation.operation_id,
      canonical_key: key,
      byte_size: operation.byte_size,
      sha256: operation.sha256,
      ...mutationContext(key, operation.publication_stage),
      status: "started",
    });
    return operation;
  };
  const completePut = (operation, result) => {
    operation.put_status = String(
      result?.status || (isSkippedPut(result) ? "skipped_unchanged" : "succeeded"),
    );
    operation.uploaded = !isSkippedPut(result);
    persistence.appendEvent({
      event_type: "put_completed",
      operation_id: operation.operation_id,
      canonical_key: operation.key,
      byte_size: operation.byte_size,
      sha256: operation.sha256,
      ...mutationContext(operation.key, operation.publication_stage),
      status: operation.put_status,
      uploaded: operation.uploaded,
    });
  };
  const trackedGetObject = async ({ key }) => {
    const normalized = normalizedKey(key);
    const operation = pendingByKey.get(normalized);
    if (!operation) return await adapters.getObject({ r2, key: normalized });
    persistence.appendEvent({
      event_type: "post_put_get_started",
      operation_id: operation.operation_id,
      canonical_key: operation.key,
      byte_size: operation.byte_size,
      sha256: operation.sha256,
      ...mutationContext(operation.key, operation.publication_stage),
      status: "started",
    });
    try {
      const stored = await adapters.getObject({ r2, key: normalized });
      const body = exactBody(stored?.body, normalized);
      if (
        stored?.exists === false ||
        body.byteLength !== operation.byte_size ||
        sha256Hex(body) !== operation.sha256
      ) {
        throw new Error(
          `SOS-light-v3 post-PUT GET verification failed: ${normalized}`,
        );
      }
      operation.verified = true;
      const evidence = Object.freeze({
        operation_id: operation.operation_id,
        object_key: operation.key,
        key: operation.key,
        bytes: operation.byte_size,
        byte_size: operation.byte_size,
        sha256: operation.sha256,
        publication_stage: operation.publication_stage,
        put_status: operation.put_status,
        uploaded: operation.uploaded,
        skipped_unchanged: !operation.uploaded,
        r2_verified: true,
        post_put_verification_get_count: 1,
        final_live_sha256: operation.sha256,
        durable: true,
      });
      persistence.appendEvent({
        event_type: "post_put_get_verified",
        operation_id: operation.operation_id,
        canonical_key: operation.key,
        byte_size: operation.byte_size,
        sha256: operation.sha256,
        ...mutationContext(operation.key, operation.publication_stage),
        status: "verified",
      });
      persistence.flush();
      publicationEvidence.push(evidence);
      pendingByKey.delete(normalized);
      counts.completed_writes += 1;
      counts.completed_post_put_verifications += 1;
      counts.get_verified_writes += 1;
      if (operation.uploaded) counts.uploaded_writes += 1;
      else counts.skipped_unchanged_writes += 1;
      return stored;
    } catch (error) {
      appendFailure(operation, error);
      throw error;
    }
  };
  const trackedPutObject = async (request, suppliedStage = null) => {
    const operation = beginPut(request, suppliedStage);
    try {
      const result = await adapters.putObject({ ...request, r2 });
      completePut(operation, result);
      return result;
    } catch (error) {
      appendFailure(operation, error);
      throw error;
    }
  };
  const trackedPutIfChanged = async (artifact) => {
    const operation = beginPut(artifact);
    try {
      const instrumentedR2 = {
        ...r2,
        canonical_mutation_sink: async (generated) => {
          const result = await adapters.putObject({
            r2,
            key: generated.key,
            body: generated.body,
            content_type: generated.content_type,
            sha256: generated.sha256,
          });
          return {
            ...result,
            key: generated.key,
            byte_size: generated.bytes,
            sha256: generated.sha256,
            skipped: false,
            status: "succeeded",
            write_r2: true,
            verified: false,
          };
        },
      };
      const result = await adapters.putIfChanged({
        r2: instrumentedR2,
        key: operation.key,
        body: operation.body,
        content_type: operation.content_type,
        writeR2: true,
      });
      completePut(operation, result);
      return {
        ...result,
        verified: false,
        post_put_get_verified: false,
      };
    } catch (error) {
      appendFailure(operation, error);
      throw error;
    }
  };
  const recordDurableEvidence = async (artifact) => {
    const key = normalizedKey(artifact?.key);
    const evidence = [...publicationEvidence].reverse().find(
      (entry) => entry.key === key,
    );
    if (
      !evidence ||
      evidence.byte_size !== Number(artifact?.byte_size) ||
      evidence.sha256 !== String(artifact?.sha256 || "")
    ) {
      throw new Error(
        `SOS-light-v3 durable publication evidence is incomplete: ${key}`,
      );
    }
    return {
      durable: true,
      key,
      byte_size: evidence.byte_size,
      sha256: evidence.sha256,
      evidence_kind: "r2_complete_body_readback",
    };
  };
  const putAndVerifyParquet = async ({ intent }) => {
    const operation = beginPut(intent, "observation_parquet");
    try {
      const result = await adapters.putObject({
        r2,
        key: operation.key,
        body: operation.body,
        content_type: operation.content_type,
        sha256: operation.sha256,
      });
      completePut(operation, result);
      await trackedGetObject({ key: operation.key });
      return {
        key: operation.key,
        byte_size: operation.byte_size,
        sha256: operation.sha256,
        verified: true,
        stored_sha256_verified: true,
        stored_byte_size_verified: true,
      };
    } catch (error) {
      if (!operation.verified) appendFailure(operation, error);
      throw error;
    }
  };
  const prepareCompleteDayReplacement = async ({ day_utc: dayUtc }) => {
    const prefix = `history/v3/observations/day_utc=${dayUtc}`;
    const tombstone = proposal.prefixes.find((entry) => entry.prefix === prefix);
    if (!tombstone) {
      throw new Error(
        `SOS-light-v3 complete-day tombstone is unavailable: ${dayUtc}`,
      );
    }
    currentOperation = {
      key: prefix,
      publication_stage: "sos_light_complete_day",
    };
    runState.apply.current_phase = "complete_day_deletion";
    progressState.current_day_utc = dayUtc;
    progressState.current_deletion_prefix = prefix;
    const existing = await adapters.listAllObjects({
      r2,
      prefix: `${prefix}/`,
      max_keys: 10_000,
    });
    const keys = existing.map((entry) => normalizedKey(entry.key)).sort();
    const sidecar = persistence.writeDeletedKeysSidecar({ prefix, keys });
    Object.assign(tombstone.entry, {
      status: "deleting",
      deletion_started_at_utc: new Date().toISOString(),
      ...sidecar,
    });
    persistence.appendEvent({
      event_type: "deletion_started",
      prefix,
      day_utc: dayUtc,
      connector_id: 1,
      publication_stage: "sos_light_complete_day",
      status: "started",
      deleted_object_count: keys.length,
      deleted_keys_sha256: sidecar.deleted_keys_sha256,
    });
    persistence.flush();
    checkpoint("before_complete_day_deletion");
    try {
      if (keys.length) await adapters.deleteObjects({ r2, keys });
      Object.assign(tombstone.entry, {
        status: "deleted",
        deleted_object_count: keys.length,
        deletion_completed_at_utc: new Date().toISOString(),
      });
      persistence.appendEvent({
        event_type: "deletion_completed",
        prefix,
        day_utc: dayUtc,
        connector_id: 1,
        publication_stage: "sos_light_complete_day",
        status: "completed",
        deleted_object_count: keys.length,
        deleted_keys_sha256: sidecar.deleted_keys_sha256,
      });
      const remaining = await adapters.listAllObjects({
        r2,
        prefix: `${prefix}/`,
        max_keys: 10_000,
      });
      if (remaining.length) {
        throw new Error(
          `SOS-light-v3 complete-day deletion verification failed: ${dayUtc}`,
        );
      }
      Object.assign(tombstone.entry, {
        status: "verified",
        deletion_verified: true,
      });
      counts.completed_deletions += 1;
      counts.deleted_objects += keys.length;
      persistence.appendEvent({
        event_type: "deletion_verified",
        prefix,
        day_utc: dayUtc,
        connector_id: 1,
        publication_stage: "sos_light_complete_day",
        status: "verified",
        deleted_object_count: keys.length,
        deleted_keys_sha256: sidecar.deleted_keys_sha256,
      });
      persistence.flush();
      perDayStatus[dayUtc].status = "deletion_verified";
      perDayStatus[dayUtc].deletion_verified = true;
      perDayStatus[dayUtc].completed_publication_level =
        "complete_day_deletion_verified";
      runState.apply.current_phase = "canonical_v3_publication";
      checkpoint("after_complete_day_deletion_verification");
      return {
        complete_day_replacement_verified: true,
        complete_partition_set: true,
        day_utc: dayUtc,
        deleted_object_count: keys.length,
        deleted_keys_sha256: sidecar.deleted_keys_sha256,
        deleted_keys_sidecar_path: sidecar.deleted_keys_sidecar_path,
        deleted_keys_sidecar_bytes: sidecar.deleted_keys_sidecar_bytes,
      };
    } catch (error) {
      tombstone.entry.status = "failed";
      tombstone.entry.error =
        error instanceof Error ? error.message : String(error);
      try {
        persistence.appendEvent({
          event_type: "deletion_failed",
          prefix,
          day_utc: dayUtc,
          connector_id: 1,
          publication_stage: "sos_light_complete_day",
          status: "failed",
          failure_message: tombstone.entry.error,
          deleted_object_count: keys.length,
          deleted_keys_sha256: sidecar.deleted_keys_sha256,
        });
        persistence.flush();
      } catch {
        // Terminal state below retains any persistence failure.
      }
      throw error;
    }
  };

  try {
    writeCompleteRunState();
    persistence.appendEvent({
      event_type: "canonical_apply_started",
      publication_stage: "fixed_v3_apply_intent",
      status: "started",
      planned_deletions: counts.planned_deletions,
      validated_proposal_object_count: proposal.objects.length,
    });
    persistence.flush();
    checkpoint("fixed_v3_apply_intent_before_first_mutation");
    runState.apply.canonical_v3_writer_invoked = true;
    const writerResult = await executeWriter({
      getObject: trackedGetObject,
      putObject: trackedPutObject,
      putIfChanged: trackedPutIfChanged,
      putAndVerifyParquet,
      recordDurableEvidence,
      prepareCompleteDayReplacement,
    });
    if (writerResult?.ok !== true || pendingByKey.size !== 0) {
      throw new Error(
        pendingByKey.size
          ? "SOS-light-v3 writer returned with unverified publications"
          : "SOS-light-v3 canonical writer did not report success",
      );
    }
    counts.planned_writes = publicationEvidence.length;
    counts.planned_post_put_verifications = publicationEvidence.length;
    runState.apply.current_phase = "canonical_v3_apply_completed";
    progressState.status = "succeeded";
    progressState.current_phase = runState.apply.current_phase;
    progressState.current_object_key = null;
    progressState.current_deletion_prefix = null;
    progressState.current_publication_stage = "complete";
    progressState.last_completed_day_utc = days.at(-1) || null;
    for (const day of days) {
      perDayStatus[day].status = "day_parent_verified";
      perDayStatus[day].day_parent_verified = true;
      perDayStatus[day].completed_publication_level = "day_parent_verified";
    }
    persistence.appendEvent({
      event_type: "canonical_apply_completed",
      publication_stage: "complete",
      status: "succeeded",
      ...counts,
    });
    persistence.close();
    checkpoint("canonical_v3_apply_successful_completion");
    runState.apply = {
      ...runState.apply,
      ...counts,
      status: "succeeded",
      finished_at_utc: new Date().toISOString(),
      v3_publication_evidence: publicationEvidence,
      canonical_v3_writer_result: writerResult,
    };
    writeCompleteRunState();
    return {
      ok: true,
      status: "succeeded",
      ...counts,
      persistence: runState.apply.persistence,
      canonical_v3_writer_result: writerResult,
    };
  } catch (error) {
    counts.failed_operations += 1;
    progressState.status = "failed";
    progressState.current_phase = "canonical_v3_apply_failed";
    runState.apply.current_phase = progressState.current_phase;
    try {
      persistence.appendEvent({
        event_type: "canonical_apply_failed",
        canonical_key: currentOperation?.key || null,
        ...mutationContext(
          currentOperation?.key,
          currentOperation?.publication_stage || progressState.current_publication_stage,
        ),
        status: "failed",
        failure_message: error instanceof Error ? error.message : String(error),
        ...counts,
      });
      persistence.flush();
    } catch {
      // closeAfterFailure exposes the journal failure in terminal state.
    }
    persistence.closeAfterFailure();
    let checkpointError = null;
    try {
      checkpoint("canonical_v3_apply_failure");
    } catch (failure) {
      checkpointError = failure instanceof Error ? failure.message : String(failure);
    }
    runState.apply = {
      ...runState.apply,
      ...counts,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finished_at_utc: new Date().toISOString(),
      v3_publication_evidence: publicationEvidence,
      canonical_v3_writer_result: null,
      failure_checkpoint: {
        attempted: true,
        succeeded: checkpointError === null,
        error: checkpointError,
      },
      failed_operation: currentOperation
        ? {
            canonical_key: currentOperation.key,
            day_utc: mutationContext(currentOperation.key).day_utc,
            publication_stage: currentOperation.publication_stage,
          }
        : null,
      later_selected_days_untouched: true,
      untouched_later_selected_days: days.filter(
        (day) => perDayStatus[day]?.status === "not_started",
      ),
    };
    writeCompleteRunState();
    throw error;
  }
}
