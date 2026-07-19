import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function sha256Hex(body) {
  return createHash("sha256").update(body).digest("hex");
}

function positiveIds(values) {
  return [...new Set((values || []).map(Number).filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, encoded, "utf8");
  fs.renameSync(temporary, filePath);
}

export function chunkIdentity(timeseriesIds) {
  return sha256Hex(JSON.stringify(positiveIds(timeseriesIds)));
}

export function validateTargetedObservationTransactionState(state, expected = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Number(state.transaction_state_schema_version) !== 1
    || state.history_version !== "v2" || state.domain !== "observations") {
    throw new Error("invalid_targeted_observation_transaction_state");
  }
  if (expected.transactionId && state.transaction_id !== expected.transactionId) {
    throw new Error("targeted_observation_transaction_id_mismatch");
  }
  if (expected.dayUtc && state.day_utc !== expected.dayUtc) {
    throw new Error("targeted_observation_transaction_day_mismatch");
  }
  if (expected.connectorId && Number(state.connector_id) !== Number(expected.connectorId)) {
    throw new Error("targeted_observation_transaction_connector_mismatch");
  }
  const requested = positiveIds(state.complete_requested_timeseries_ids);
  if (!requested.length || !sameJson(requested, state.complete_requested_timeseries_ids)) {
    throw new Error("targeted_observation_transaction_requested_set_invalid");
  }
  const chunks = Array.isArray(state.chunks) ? state.chunks : [];
  if (!chunks.length || Number(state.expected_chunk_count) !== chunks.length) {
    throw new Error("targeted_observation_transaction_chunk_count_mismatch");
  }
  const seenIds = new Set();
  const seenIdentities = new Set();
  for (const chunk of chunks) {
    const ids = positiveIds(chunk?.timeseries_ids);
    const identity = chunkIdentity(ids);
    if (!ids.length || !sameJson(ids, chunk?.timeseries_ids)
      || chunk?.chunk_identity !== identity || seenIdentities.has(identity)) {
      throw new Error("targeted_observation_transaction_chunk_definition_conflict");
    }
    seenIdentities.add(identity);
    for (const id of ids) {
      if (seenIds.has(id)) throw new Error("targeted_observation_transaction_chunk_overlap");
      seenIds.add(id);
    }
  }
  if (!sameJson([...seenIds].sort((a, b) => a - b), requested)) {
    throw new Error("targeted_observation_transaction_chunk_union_mismatch");
  }
  return state;
}

export function readTargetedObservationTransactionState(filePath, expected = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`targeted_observation_transaction_state_unavailable:${filePath || "(unset)"}`);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`targeted_observation_transaction_state_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  return validateTargetedObservationTransactionState(state, expected);
}

export function recordTargetedObservationChunkCompletion({
  filePath,
  transactionId,
  dayUtc,
  connectorId,
  chunkTimeseriesIds,
  affectedPollutantCodes,
  sourceTimeseriesRowCounts,
  sourceRowCount,
  stagedMergedRowCount,
  stagedMergedRowsSha256,
}) {
  const state = readTargetedObservationTransactionState(filePath, { transactionId, dayUtc, connectorId });
  const ids = positiveIds(chunkTimeseriesIds);
  const identity = chunkIdentity(ids);
  const chunk = state.chunks.find((entry) => entry?.chunk_identity === identity);
  if (!chunk || !sameJson(ids, chunk.timeseries_ids)) {
    throw new Error("targeted_observation_transaction_current_chunk_not_declared");
  }
  const evidence = {
    chunk_identity: identity,
    timeseries_ids: ids,
    source_row_count: Number(sourceRowCount || 0),
    source_timeseries_row_counts: Object.fromEntries(Object.entries(sourceTimeseriesRowCounts || {})
      .map(([key, value]) => [String(Number(key)), Number(value)])
      .filter(([key, value]) => Number.isInteger(Number(key)) && Number(key) > 0 && Number.isInteger(value) && value >= 0)
      .sort(([left], [right]) => Number(left) - Number(right))),
    affected_pollutant_codes: [...new Set((affectedPollutantCodes || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))].sort(),
  };
  const previous = (state.completed_chunks || []).find((entry) => entry?.chunk_identity === identity);
  if (previous && !sameJson(previous, evidence)) {
    throw new Error("targeted_observation_transaction_completed_chunk_conflict");
  }
  const completed = (state.completed_chunks || []).filter((entry) => entry?.chunk_identity !== identity);
  completed.push(evidence);
  completed.sort((left, right) => left.chunk_identity.localeCompare(right.chunk_identity));
  const affected = [...new Set(completed.flatMap((entry) => entry.affected_pollutant_codes || []))].sort();
  const completedIdentities = new Set(completed.map((entry) => entry.chunk_identity));
  const incomplete = state.chunks.map((entry) => entry.chunk_identity)
    .filter((value) => !completedIdentities.has(value)).sort();
  const next = {
    ...state,
    completed_chunks: completed,
    completed_chunk_identities: [...completedIdentities].sort(),
    incomplete_chunk_identities: incomplete,
    failed_chunks: (state.failed_chunks || []).filter((entry) => entry?.chunk_identity !== identity),
    affected_pollutant_codes: affected,
    source_row_count: completed.reduce((total, entry) => total + Number(entry.source_row_count || 0), 0),
    source_timeseries_row_counts: Object.fromEntries(completed.flatMap((entry) => Object.entries(entry.source_timeseries_row_counts || {}))
      .reduce((counts, [key, value]) => counts.set(key, Number(counts.get(key) || 0) + Number(value || 0)), new Map())
      .entries()),
    staged_merged_row_identity: {
      row_count: Number(stagedMergedRowCount),
      content_sha256: String(stagedMergedRowsSha256 || ""),
    },
    finalisation_status: incomplete.length ? "chunks_in_progress" : "ready_for_data_publication",
  };
  atomicWriteJson(filePath, next);
  return next;
}

export function validateTargetedObservationFinalisation({
  filePath,
  transactionId,
  dayUtc,
  connectorId,
  stagedMergedRowCount,
  stagedMergedRowsSha256,
}) {
  const state = readTargetedObservationTransactionState(filePath, { transactionId, dayUtc, connectorId });
  const expected = new Set(state.chunks.map((entry) => entry.chunk_identity));
  const completed = new Set((state.completed_chunks || []).map((entry) => entry?.chunk_identity));
  if (expected.size !== completed.size || [...expected].some((value) => !completed.has(value))
    || (state.failed_chunks || []).length || (state.incomplete_chunk_identities || []).length) {
    throw new Error("targeted_observation_transaction_incomplete");
  }
  const staged = state.staged_merged_row_identity || {};
  if (Number(staged.row_count) !== Number(stagedMergedRowCount)
    || staged.content_sha256 !== String(stagedMergedRowsSha256 || "")) {
    throw new Error("targeted_observation_transaction_staged_identity_mismatch");
  }
  if (!Array.isArray(state.affected_pollutant_codes) || !state.affected_pollutant_codes.length) {
    throw new Error("targeted_observation_transaction_has_no_affected_pollutants");
  }
  return state;
}

export function markTargetedObservationTransactionFinalised(filePath, receiptKey, receiptSha256) {
  const state = readTargetedObservationTransactionState(filePath);
  const existing = state.permanent_data_receipt || null;
  const evidence = {
    key: String(receiptKey),
    content_sha256: String(receiptSha256),
  };
  if (existing && !sameJson(existing, evidence)) {
    throw new Error("targeted_observation_transaction_receipt_identity_conflict");
  }
  const next = {
    ...state,
    permanent_data_receipt: evidence,
    finalisation_status: "permanent_data_receipt_get_verified",
  };
  atomicWriteJson(filePath, next);
  return next;
}

export function buildTargetedObservationPermanentReceiptKey(basePrefix, dayUtc, connectorId, transactionId) {
  return `${String(basePrefix).replace(/\/+$/, "")}/day_utc=${dayUtc}/connector_id=${connectorId}/transactions/transaction_id=${transactionId}/data-receipt.json`;
}

export function selectCompleteAffectedPollutantRows(rows, affectedPollutantCodes) {
  const affected = new Set((affectedPollutantCodes || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
  return (rows || []).filter((row) => affected.has(String(row?.pollutant_code || "").trim().toLowerCase()));
}

export function targetedObservationWriterEvidence({ objectsWritten, plannedManifestKey, plannedDayManifestKey, receiptKey, receiptSha256 }) {
  return {
    objects_written_r2: Number(objectsWritten || 0),
    observation_manifest_key: null,
    day_observation_manifest_key: null,
    planned_observation_manifest_key: String(plannedManifestKey),
    planned_day_observation_manifest_key: String(plannedDayManifestKey),
    observation_manifest_owner: "integrity_metadata_executor",
    permanent_data_receipt_key: String(receiptKey),
    permanent_data_receipt_sha256: String(receiptSha256),
  };
}

export async function inspectImmutableObject({ key, body, r2, headObject, getObject }) {
  const expected = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const expectedSha256 = sha256Hex(expected);
  const head = await headObject({ r2, key });
  if (!head?.exists) {
    return { key, exists: false, identical: false, bytes: expected.byteLength, content_sha256: expectedSha256 };
  }
  const actual = await getObject({ r2, key });
  const identical = Number(actual.bytes) === expected.byteLength && sha256Hex(actual.body) === expectedSha256;
  if (!identical) throw new Error(`immutable_targeted_observation_object_conflict:${key}`);
  return { key, exists: true, identical: true, bytes: expected.byteLength, content_sha256: expectedSha256 };
}

export async function publishImmutableObject({ key, body, contentType, r2, inspection, putObject, getObject }) {
  const expected = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!inspection?.exists) {
    await putObject({ r2, key, body: expected, content_type: contentType });
  }
  const actual = await getObject({ r2, key });
  if (Number(actual.bytes) !== expected.byteLength || sha256Hex(actual.body) !== inspection.content_sha256) {
    throw new Error(`immutable_targeted_observation_object_get_verification_failed:${key}`);
  }
  return {
    key,
    bytes: expected.byteLength,
    content_sha256: inspection.content_sha256,
    put_performed: !inspection.exists,
    idempotent_reuse: inspection.exists,
    fresh_get_verified: true,
    etag: actual.etag || null,
  };
}

export function writeJsonFileIdempotent(filePath, payload) {
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, "utf8") !== encoded) {
      throw new Error(`conflicting_local_targeted_observation_receipt:${filePath}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encoded, "utf8");
}
