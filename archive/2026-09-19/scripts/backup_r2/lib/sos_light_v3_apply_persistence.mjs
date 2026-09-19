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
  adapters,
  persistenceIo = {},
}) {
  for (const name of [
    "getObject",
    "putObject",
    "putAndVerifyParquet",
    "listAllObjects",
    "deleteObjects",
  ]) {
    if (typeof adapters?.[name] !== "function") {
      throw new TypeError(`SOS-light-v3 persisted apply requires ${name}`);
    }
  }
  const days = selectedDays(runState);
  const dayDeletionPrefixes = (proposal?.prefixes || [])
    .filter(({ entry }) => entry?.stage === "sos_light_complete_day");
  const exactScopeRemovalPrefixes = (proposal?.prefixes || [])
    .filter(({ entry }) => entry?.stage === "sos_light_exact_v3_scope_removal");
  if (!days.length || dayDeletionPrefixes.length !== days.length) {
    throw new Error("SOS-light-v3 persisted apply requires validated selected days");
  }
  const counts = {
    planned_deletions: proposal.prefixes.length,
    planned_writes: proposal.objects.length,
    planned_post_put_verifications: proposal.objects.length,
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
    frozen_proposal_apply: true,
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
        stored_sha256_verified: operation.stored_sha256_verified === true,
        stored_byte_size_verified: operation.stored_byte_size_verified === true,
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
  const trackedPutAndVerifyParquet = async (object) => {
    const operation = beginPut({
      key: object.key,
      body: object.body,
      content_type: object.entry.content_type,
      sha256: object.entry.sha256,
      byte_size: object.entry.bytes,
    }, "observation_parquet");
    try {
      const result = await adapters.putAndVerifyParquet({
        r2,
        intent: {
          key: operation.key,
          body: operation.body,
          content_type: operation.content_type,
          sha256: operation.sha256,
          byte_size: operation.byte_size,
        },
      });
      completePut(operation, result);
      if (result?.stored_sha256_verified !== true
          || result?.stored_byte_size_verified !== true
          || result?.sha256 !== operation.sha256
          || Number(result?.byte_size) !== operation.byte_size) {
        throw new Error(
          `SOS-light-v3 checksum-aware Parquet verification failed: ${operation.key}`,
        );
      }
      operation.stored_sha256_verified = true;
      operation.stored_byte_size_verified = true;
      await trackedGetObject({ key: operation.key });
      return result;
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

  const executePlannedExactScopeRemoval = async ({ prefix, entry }) => {
    currentOperation = {
      key: prefix,
      publication_stage: "sos_light_exact_v3_scope_removal",
    };
    const existing = await adapters.listAllObjects({
      r2,
      prefix: `${prefix}/`,
      max_keys: 10_000,
    });
    const keys = existing.map((object) => normalizedKey(object.key)).sort();
    const sidecar = persistence.writeDeletedKeysSidecar({ prefix, keys });
    Object.assign(entry, {
      status: "deleting",
      deletion_started_at_utc: new Date().toISOString(),
      ...sidecar,
    });
    persistence.appendEvent({
      event_type: "exact_v3_scope_deletion_started",
      prefix,
      ...mutationContext(prefix, "sos_light_exact_v3_scope_removal"),
      status: "started",
      deleted_object_count: keys.length,
      deleted_keys_sha256: sidecar.deleted_keys_sha256,
    });
    persistence.flush();
    if (keys.length) await adapters.deleteObjects({ r2, keys });
    const remaining = await adapters.listAllObjects({
      r2,
      prefix: `${prefix}/`,
      max_keys: 10_000,
    });
    if (remaining.length) {
      throw new Error(`SOS-light-v3 exact scope deletion verification failed: ${prefix}`);
    }
    Object.assign(entry, {
      status: "verified",
      deletion_verified: true,
      deleted_object_count: keys.length,
      deletion_completed_at_utc: new Date().toISOString(),
    });
    counts.completed_deletions += 1;
    counts.deleted_objects += keys.length;
    persistence.appendEvent({
      event_type: "exact_v3_scope_deletion_verified",
      prefix,
      ...mutationContext(prefix, "sos_light_exact_v3_scope_removal"),
      status: "verified",
      deleted_object_count: keys.length,
      deleted_keys_sha256: sidecar.deleted_keys_sha256,
    });
    persistence.flush();
  };

  const frozenPublicationOrder = () => {
    const byKey = new Map(proposal.objects.map((object) => [object.key, object]));
    const remaining = new Map(byKey);
    const ordered = [];
    while (remaining.size) {
      const ready = [...remaining.values()].filter((object) =>
        (object.entry.dependencies || []).every((key) => !remaining.has(key))
      ).sort((left, right) => left.key.localeCompare(right.key));
      if (!ready.length) {
        throw new Error("SOS-light-v3 frozen proposal has a publication dependency cycle");
      }
      for (const object of ready) {
        ordered.push(object);
        remaining.delete(object.key);
      }
    }
    return ordered;
  };

  try {
    // Freeze and validate the complete publication schedule before the first
    // R2 DELETE/PUT. Apply never discovers or adds objects from live R2.
    const orderedObjects = frozenPublicationOrder();
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
    for (const day of days) await prepareCompleteDayReplacement({ day_utc: day });
    for (const removal of exactScopeRemovalPrefixes) {
      await executePlannedExactScopeRemoval(removal);
    }
    for (const object of orderedObjects) {
      if (object.key.endsWith(".parquet")) {
        await trackedPutAndVerifyParquet(object);
      } else {
        await trackedPutObject({
          key: object.key,
          body: object.body,
          content_type: object.entry.content_type,
        }, object.entry.publication_stage);
        await trackedGetObject({ key: object.key });
      }
    }
    if (pendingByKey.size !== 0) {
      throw new Error("SOS-light-v3 frozen proposal returned with unverified publications");
    }
    const writerResult = {
      ok: true,
      status: "frozen_proposal_applied",
      object_count: orderedObjects.length,
      authority: "dropbox_baseline_plus_repair_overlay",
    };
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
