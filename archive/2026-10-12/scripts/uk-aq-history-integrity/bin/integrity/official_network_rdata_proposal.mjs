#!/usr/bin/env node
// Build a local canonical v2 or v3 proposal from already pinned/decoded RData rows.
// This helper has no R2 client and cannot publish; the Integrity coordinator
// retains ownership of APPLY and final verification.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildCanonicalObservationTimeseriesAlignedFiles,
} from "../../../../workers/shared/uk_aq_observation_history_target_writer.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../../../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import {
  getObservationHistoryGeneration,
} from "../../../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  computeEmptyObservationContentHash,
  computeObservationContentHash,
} from "../../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
} from "../../../../workers/shared/uk_aq_r2_history_canonical.mjs";

import {
  OFFICIAL_RDATA_V8_SEMANTIC_EVIDENCE_FIELDS,
  officialRdataAvailabilitySemanticIdentity,
  officialRdataPreservedBaselineSemanticIdentity,
} from "../../../../scripts/backup_r2/lib/official_rdata_semantic_projection.mjs";

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function canonicalUtf8Bytes(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        throw new Error("canonical evidence string contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("canonical evidence string contains an unpaired UTF-16 surrogate");
    }
  }
  return Buffer.from(text, "utf8");
}

function compareCanonicalUtf8(left, right) {
  return Buffer.compare(canonicalUtf8Bytes(left), canonicalUtf8Bytes(right));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareCanonicalUtf8).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  if (typeof value === "string") canonicalUtf8Bytes(value);
  return JSON.stringify(value);
}

const OFFICIAL_RDATA_SOURCE_EVIDENCE_CONTRACT_VERSION = 8;
const OFFICIAL_RDATA_SOURCE_AVAILABILITY_CONTRACT_VERSION = 5;
const OFFICIAL_RDATA_PRESERVED_BASELINE_CONTRACT_VERSION = 1;
const OFFICIAL_RDATA_DECODER_CONTRACT_VERSION = 1;
const OFFICIAL_RDATA_ACQUISITION_AUDIT_CONTRACT_VERSION = 1;
const OFFICIAL_RDATA_TIMESTAMP_MAPPING =
  "rdata_posixct_gmt_instant_to_observed_at_utc";


function officialRdataV8SemanticEvidenceProjection(evidence) {
  const projection = {};
  for (const field of OFFICIAL_RDATA_V8_SEMANTIC_EVIDENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(evidence, field)) {
      throw new Error(`official RData v8 semantic evidence field is missing: ${field}`);
    }
    projection[field] = evidence[field];
  }
  return projection;
}

function canonicalAuditEntries(values) {
  return [...(values || [])].sort((left, right) =>
    compareCanonicalUtf8(canonicalJson(left), canonicalJson(right)));
}

function writeAtomic(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, filePath);
}

function writeObject(stageRoot, key, body) {
  const normalized = String(key || "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "..")) {
    throw new Error(`unsafe proposal object key: ${key}`);
  }
  writeAtomic(path.join(stageRoot, "generated-objects", ...normalized.split("/")), body);
}

function fileEntry(file, pollutantCode) {
  return {
    key: file.key,
    row_count: file.row_count,
    bytes: file.byte_size,
    etag_or_hash: file.sha256,
    pollutant_codes: [pollutantCode],
    min_timeseries_id: file.row_groups.reduce((value, group) =>
      value === null ? group.min_timeseries_id : Math.min(value, group.min_timeseries_id), null),
    max_timeseries_id: file.row_groups.reduce((value, group) =>
      value === null ? group.max_timeseries_id : Math.max(value, group.max_timeseries_id), null),
    min_observed_at_utc: file.row_groups.reduce((value, group) =>
      value === null || group.min_observed_at_utc < value ? group.min_observed_at_utc : value, null),
    max_observed_at_utc: file.row_groups.reduce((value, group) =>
      value === null || group.max_observed_at_utc > value ? group.max_observed_at_utc : value, null),
    timeseries_row_counts: { ...file.timeseries_row_counts },
  };
}

function contentHashMetadata(metadata) {
  return {
    observation_content_hash: metadata.observation_content_hash,
    observation_content_hash_algorithm: metadata.observation_content_hash_algorithm,
    observation_content_hash_contract_version: metadata.observation_content_hash_contract_version,
    observation_content_hash_row_count: metadata.observation_content_hash_row_count,
    observation_content_hash_columns: [...metadata.observation_content_hash_columns],
    verification_status_counts: { ...metadata.verification_status_counts },
  };
}

function canonicalIdentity(row) {
  return `${row.timeseries_id}|${row.observed_at_utc}|${row.pollutant_code}`;
}

function rowIsSourceUnavailable(row, scopes) {
  return scopes.some((scope) => {
    if (Number(scope.timeseries_id) !== row.timeseries_id ||
        String(scope.pollutant_code || "") !== row.pollutant_code) {
      return false;
    }
    const observedAt = Date.parse(row.observed_at_utc);
    if (!Number.isFinite(observedAt)) throw new Error("invalid canonical observation timestamp");
    return (scope.canonical_unavailable_windows || []).some((window) => {
      const start = Date.parse(String(window.canonical_start_utc || ""));
      const end = Date.parse(String(window.canonical_end_exclusive_utc || ""));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error("invalid canonical source-unavailable window");
      }
      return start <= observedAt && observedAt < end;
    });
  });
}

function main() {
  const [inputPath, stageRoot, observationsPrefix, writerGitSha, generationArg] = process.argv.slice(2);
  if (!inputPath || !stageRoot || !observationsPrefix || !/^[0-9a-f]{40}$/.test(writerGitSha || "")) {
    throw new Error("usage: official_network_rdata_proposal.mjs INPUT STAGE_ROOT PREFIX WRITER_GIT_SHA GENERATION");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const historyGeneration = String(generationArg || input.history_generation || "").trim();
  if (historyGeneration !== String(input.history_generation || "").trim()) {
    throw new Error("proposal generation argument disagrees with the pinned input");
  }
  const generation = getObservationHistoryGeneration(historyGeneration);
  if (observationsPrefix !== generation.observations_prefix) {
    throw new Error(
      `proposal observations prefix does not belong to ${historyGeneration}: ${observationsPrefix}`,
    );
  }
  const dayUtc = String(input.day_utc || "");
  const connectorId = Number(input.connector_id);
  const sourceAdapter = String(input.source_adapter || "");
  const requestedPollutants = [...new Set(input.requested_pollutant_set || [])]
    .sort(compareCanonicalUtf8);
  const backedUpAtUtc = String(input.backed_up_at_utc || "");
  const rows = (input.rows || []).map((row) => ({
    connector_id: Number(row.connector_id),
    station_id: Number(row.station_id),
    timeseries_id: Number(row.timeseries_id),
    pollutant_code: String(row.pollutant_code),
    observed_at_utc: String(row.observed_at_utc),
    value: Number(row.value),
    verification_status: row.verification_status,
  }));
  const preservedBaselineRows = (input.preserved_baseline_rows || []).map((row) => ({
    connector_id: Number(row.connector_id),
    station_id: Number(row.station_id),
    timeseries_id: Number(row.timeseries_id),
    pollutant_code: String(row.pollutant_code),
    observed_at_utc: String(row.observed_at_utc),
    value: Number(row.value),
    verification_status: row.verification_status ?? null,
  }));
  const targetRows = [...rows, ...preservedBaselineRows];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || !Number.isSafeInteger(connectorId) || connectorId <= 0) {
    throw new Error("invalid proposal scope");
  }
  if (!sourceAdapter || requestedPollutants.length === 0) {
    throw new Error("source adapter and requested pollutant set are required");
  }
  if (rows.some((row) => row.connector_id !== connectorId ||
      row.observed_at_utc.slice(0, 10) !== dayUtc ||
      !requestedPollutants.includes(row.pollutant_code))) {
    throw new Error("proposal row escaped selected connector/day/pollutant scope");
  }
  if (preservedBaselineRows.some((row) => row.connector_id !== connectorId ||
      row.observed_at_utc.slice(0, 10) !== dayUtc ||
      !requestedPollutants.includes(row.pollutant_code))) {
    throw new Error("preserved baseline row escaped selected connector/day/pollutant scope");
  }
  const unavailableTimeseriesIds = new Set(
    (input.source_unavailable_timeseries_ids || []).map((value) => Number(value)),
  );
  const unavailableScopes = (input.source_unavailable_scopes || []).map((scope) => ({
    ...scope,
    canonical_unavailable_windows: scope.canonical_unavailable_windows || [],
  }));
  if (unavailableScopes.some((scope) => scope.canonical_unavailable_windows.length === 0)) {
    throw new Error("source-unavailable scope has no canonical timestamp window");
  }
  const sourceIdentities = new Set(rows.map(canonicalIdentity));
  if (preservedBaselineRows.some((row) => sourceIdentities.has(canonicalIdentity(row)))) {
    throw new Error("source and preserved baseline rows contain a duplicate canonical identity");
  }
  if (preservedBaselineRows.some((row) => !rowIsSourceUnavailable(row, unavailableScopes)) ||
      rows.some((row) => rowIsSourceUnavailable(row, unavailableScopes))) {
    throw new Error("source or preserved baseline row escaped its availability window");
  }
  const sourceAvailablePollutantCodes = new Set(
    (input.source_available_pollutant_codes || []).map((value) => String(value)),
  );
  const pollutantManifests = [];
  const sourceObservationContentHashes = {};
  const finalTargetObservationContentHashes = {};
  const emptyFinalTargetPollutantCodes = [];
  for (const pollutantCode of requestedPollutants) {
    const pollutantRows = targetRows.filter((row) => row.pollutant_code === pollutantCode);
    const sourcePollutantRows = rows.filter((row) => row.pollutant_code === pollutantCode);
    if (sourcePollutantRows.length > 0) {
      sourceObservationContentHashes[pollutantCode] = contentHashMetadata(
        computeObservationContentHash(sourcePollutantRows),
      );
    } else if (sourceAvailablePollutantCodes.has(pollutantCode)) {
      sourceObservationContentHashes[pollutantCode] = contentHashMetadata(
        computeEmptyObservationContentHash(),
      );
    }
    if (pollutantRows.length === 0) {
      if (sourceAvailablePollutantCodes.has(pollutantCode)) {
        finalTargetObservationContentHashes[pollutantCode] = contentHashMetadata(
          computeEmptyObservationContentHash(),
        );
        emptyFinalTargetPollutantCodes.push(pollutantCode);
      }
      continue;
    }
    if (!sourceAvailablePollutantCodes.has(pollutantCode)) {
      // A wholly unavailable selected pollutant remains pinned baseline content.
      // It has no replacement object or deletion authority.
      finalTargetObservationContentHashes[pollutantCode] = contentHashMetadata(
        computeObservationContentHash(pollutantRows),
      );
      continue;
    }
    let targetMetadata;
    let manifest;
    let manifestKey;
    if (historyGeneration === "v3") {
      const prepared = buildObservationHistoryV3SteadyStatePartition({
        source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
        rows: pollutantRows,
        scope: { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode },
        targetWriterGitSha: writerGitSha,
        backedUpAtUtc,
        observationsPrefix,
      });
      for (const intent of prepared.file_intents) {
        writeObject(stageRoot, intent.key, intent.body);
      }
      targetMetadata = prepared.target_metadata;
      manifestKey = prepared.canonical_pollutant_manifest.key;
      manifest = prepared.canonical_pollutant_manifest.payload;
      writeObject(stageRoot, manifestKey, prepared.canonical_pollutant_manifest.body);
    } else {
      const target = buildCanonicalObservationTimeseriesAlignedFiles(pollutantRows, {
        limits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
        partition: { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode },
        fileKeyForOrdinal: (ordinal) => buildHistoryV2PartKey(
          observationsPrefix, dayUtc, connectorId, pollutantCode, ordinal,
        ),
      });
      targetMetadata = target.metadata;
      for (const file of target.file_bodies) writeObject(stageRoot, file.key, file.body);
      manifestKey = buildHistoryV2PollutantManifestKey(
        observationsPrefix, dayUtc, connectorId, pollutantCode,
      );
      const v2HashMetadata = contentHashMetadata(targetMetadata);
      manifest = buildHistoryV2PollutantManifest({
        domain: "observations",
        dayUtc,
        connectorId,
        pollutantCode,
        runId: null,
        manifestKey,
        sourceRowCount: targetMetadata.row_count,
        fileEntries: targetMetadata.files.map((file) => fileEntry(file, pollutantCode)),
        writerGitSha,
        backedUpAtUtc,
        observationContentHash: v2HashMetadata,
        physicalSchema: {
          history_schema_version: targetMetadata.history_schema_version,
          columns: [...targetMetadata.columns],
          writer_version: targetMetadata.writer_version,
        },
      });
      writeObject(stageRoot, manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    }
    const hashMetadata = contentHashMetadata(targetMetadata);
    finalTargetObservationContentHashes[pollutantCode] = hashMetadata;
    pollutantManifests.push(manifest);
  }
  if (pollutantManifests.length === 0 && emptyFinalTargetPollutantCodes.length === 0) {
    throw new Error("canonical proposal contains neither rows nor a source-available empty target");
  }

  if (pollutantManifests.length > 0) {
    const connectorManifestKey = buildHistoryV2ConnectorManifestKey(
      observationsPrefix, dayUtc, connectorId,
    );
    const connectorManifest = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      runId: null,
      manifestKey: connectorManifestKey,
      pollutantManifests,
      writerGitSha,
      backedUpAtUtc,
    });
    writeObject(stageRoot, connectorManifestKey, Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"));
  }

  const evidenceRows = rows.map((row) => ({
    connector_id: row.connector_id,
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: row.verification_status,
  }));
  const rowsBody = Buffer.from(JSON.stringify(evidenceRows), "utf8");
  const preservedEvidenceRows = preservedBaselineRows.map((row) => ({
    connector_id: row.connector_id,
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: row.verification_status,
  }));
  const preservedRowsBody = Buffer.from(JSON.stringify(preservedEvidenceRows), "utf8");
  const identities = [...(input.source_file_identities || [])].map((identity) => ({
    source_file: String(identity.source_file || ""),
    sha256: String(identity.sha256 || ""),
    bytes: Number(identity.bytes),
  })).sort((left, right) => compareCanonicalUtf8(left.source_file, right.source_file));
  const requiredSourceFiles = [...new Set(
    (input.required_source_files || identities.map((identity) => identity.source_file))
      .map((value) => String(value)),
  )].sort(compareCanonicalUtf8);
  const absentSourceFiles = [...new Set(
    (input.authoritatively_absent_source_files || []).map((value) => String(value)),
  )].sort(compareCanonicalUtf8);
  const readSourceFiles = identities.map((identity) => identity.source_file);
  if (requiredSourceFiles.some((value) =>
      !readSourceFiles.includes(value) && !absentSourceFiles.includes(value)) ||
      readSourceFiles.some((value) => absentSourceFiles.includes(value))) {
    throw new Error("source file evidence is incomplete or contradictory");
  }
  const identityBody = Buffer.from(JSON.stringify(identities), "utf8");
  const perTimeseries = {};
  const perPollutant = {};
  const finalTargetPerTimeseries = {};
  const finalTargetPerPollutant = {};
  const verificationStatusCounts = { P: 0, R: 0 };
  for (const row of evidenceRows) {
    perTimeseries[String(row.timeseries_id)] = (perTimeseries[String(row.timeseries_id)] || 0) + 1;
    perPollutant[row.pollutant_code] = (perPollutant[row.pollutant_code] || 0) + 1;
    if (!(row.verification_status in verificationStatusCounts)) {
      throw new Error(`invalid verification_status: ${row.verification_status}`);
    }
    verificationStatusCounts[row.verification_status] += 1;
  }
  for (const row of targetRows) {
    finalTargetPerTimeseries[String(row.timeseries_id)] =
      (finalTargetPerTimeseries[String(row.timeseries_id)] || 0) + 1;
    finalTargetPerPollutant[row.pollutant_code] =
      (finalTargetPerPollutant[row.pollutant_code] || 0) + 1;
  }
  for (const pollutantCode of emptyFinalTargetPollutantCodes) {
    finalTargetPerPollutant[pollutantCode] = 0;
  }
  const contract = "pollutant_scoped_authoritative_connector_day_source_rows";
  // Build a semantic record before hashing; never change the projection of a
  // previously persisted v8 record. Full request diagnostics remain in the audit.
  const sourceArtifactAvailabilityIdentity = officialRdataAvailabilitySemanticIdentity(
    input.source_unavailable_scopes || [],
  );
  const preservedBaselineIdentity = officialRdataPreservedBaselineSemanticIdentity(
    input.preserved_baseline_identity || { source: "dropbox", partition_identities: [] },
  );
  const preservedBaselineDependencySha256 = sha256(Buffer.from(canonicalJson({
    preserved_baseline_identity: preservedBaselineIdentity,
    preserved_baseline_rows_sha256: sha256(preservedRowsBody),
    source_unavailable_scopes: sourceArtifactAvailabilityIdentity,
  }), "utf8"));
  const evidenceInput = {
    source_adapter: sourceAdapter,
    day_utc: dayUtc,
    connector_id: connectorId,
    source_file_identities_sha256: sha256(identityBody),
    requested_pollutant_set: requestedPollutants,
    contract,
    evidence_contract_version: OFFICIAL_RDATA_SOURCE_EVIDENCE_CONTRACT_VERSION,
    history_generation: historyGeneration,
    source_label_registry_snapshot_content_sha256: null,
    authoritative_station_timeseries_mapping_sha256: input.authoritative_mapping_sha256 || null,
    sos_site_ref_bridge_mapping_identity: null,
    sos_site_ref_bridge_artifact_sha256: null,
    observed_property_mapping_sha256: input.observed_property_mapping_sha256 || null,
    source_artifact_availability_sha256: sha256(Buffer.from(
      canonicalJson(sourceArtifactAvailabilityIdentity), "utf8",
    )),
    source_artifact_availability_contract_version:
      OFFICIAL_RDATA_SOURCE_AVAILABILITY_CONTRACT_VERSION,
    preserved_baseline_dependency_sha256: preservedBaselineDependencySha256,
    preserved_baseline_dependency_contract_version:
      OFFICIAL_RDATA_PRESERVED_BASELINE_CONTRACT_VERSION,
    rdata_decoder_contract_version: OFFICIAL_RDATA_DECODER_CONTRACT_VERSION,
    timestamp_mapping: OFFICIAL_RDATA_TIMESTAMP_MAPPING,
    observation_content_hash_contract_version: 1,
  };
  const semanticEvidence = {
    schema_version: 1,
    semantic_evidence_contract: "official_rdata_semantic_evidence",
    ...evidenceInput,
    source_evidence_input_sha256: sha256(Buffer.from(canonicalJson(evidenceInput), "utf8")),
    enumeration_complete: true,
    files_enumerated: requiredSourceFiles,
    files_required: requiredSourceFiles,
    files_read: readSourceFiles,
    files_authoritatively_absent: absentSourceFiles,
    source_file_identities: identities,
    source_records_examined: evidenceRows.length,
    source_csv_records_scanned: evidenceRows.length,
    canonical_rows_mapped: evidenceRows.length,
    missing_binding_groups: 0,
    missing_binding_rows: 0,
    canonical_rows_file: "obs_history_rows.json",
    canonical_rows_sha256: sha256(rowsBody),
    canonical_rows_bytes: rowsBody.byteLength,
    total_rows: evidenceRows.length,
    per_timeseries_counts: Object.fromEntries(Object.entries(perTimeseries).sort(([a], [b]) => Number(a) - Number(b))),
    per_pollutant_counts: Object.fromEntries(Object.entries(perPollutant).sort(([a], [b]) => compareCanonicalUtf8(a, b))),
    observation_content_hashes: Object.fromEntries(Object.entries(sourceObservationContentHashes).sort(([a], [b]) => compareCanonicalUtf8(a, b))),
    pollutant_set: Object.keys(perPollutant).sort(compareCanonicalUtf8),
    source_available_timeseries_ids: [...new Set(
      (input.source_available_timeseries_ids || []).map((value) => Number(value)),
    )].sort((a, b) => a - b),
    source_available_pollutant_codes: [...sourceAvailablePollutantCodes].sort(compareCanonicalUtf8),
    source_unavailable_timeseries_ids: [...unavailableTimeseriesIds].sort((a, b) => a - b),
    source_unavailable_scopes: sourceArtifactAvailabilityIdentity,
    preserved_baseline_rows_file: "preserved_baseline_rows.json",
    preserved_baseline_rows_sha256: sha256(preservedRowsBody),
    preserved_baseline_rows_bytes: preservedRowsBody.byteLength,
    preserved_baseline_row_count: preservedEvidenceRows.length,
    preserved_baseline_identity: preservedBaselineIdentity,
    final_target_row_count: targetRows.length,
    final_target_timeseries_row_counts: Object.fromEntries(Object.entries(finalTargetPerTimeseries).sort(([a], [b]) => Number(a) - Number(b))),
    final_target_pollutant_counts: Object.fromEntries(Object.entries(finalTargetPerPollutant).sort(([a], [b]) => compareCanonicalUtf8(a, b))),
    empty_final_target_pollutant_codes: [...emptyFinalTargetPollutantCodes].sort(compareCanonicalUtf8),
    final_target_observation_content_hashes: Object.fromEntries(Object.entries(finalTargetObservationContentHashes).sort(([a], [b]) => compareCanonicalUtf8(a, b))),
    source_rows_before_canonical_dedupe: evidenceRows.length,
    duplicate_rows_removed_by_canonical_normalisation: 0,
    duplicate_canonical_row_count: 0,
    duplicate_canonical_row_identity_samples: [],
    uncanonicalisable_source_row_count: 0,
    source_adapter_blocked_row_count: 0,
    source_adapter_blocked_row_samples: [],
    out_of_scope_source_adapter_blocked_row_count: 0,
    blocked_row_count: 0,
    blocked_row_samples: [],
    skipped_row_count: 0,
    inactive_identity_rows_skipped: 0,
    source_label_classification_counts: { no_authoritative_timeseries_binding: 0 },
    source_label_target_day_row_counts: { no_authoritative_timeseries_binding: 0 },
    source_label_summary: {},
    source_label_classifications: [],
    mapping_audit: input.mapping_audit || {
      mapped_source_groups: [],
      excluded_source_groups: [],
    },
    source_verification_status_counts: verificationStatusCounts,
  };
  const semanticEvidenceSha256 = sha256(Buffer.from(
    canonicalJson(officialRdataV8SemanticEvidenceProjection(semanticEvidence)),
    "utf8",
  ));
  const acquisitionAudit = {
    schema_version: 1,
    audit_contract: "official_rdata_run_acquisition_audit",
    audit_contract_version: OFFICIAL_RDATA_ACQUISITION_AUDIT_CONTRACT_VERSION,
    source_adapter: sourceAdapter,
    day_utc: dayUtc,
    connector_id: connectorId,
    history_generation: historyGeneration,
    source_evidence_input_sha256: semanticEvidence.source_evidence_input_sha256,
    semantic_evidence_sha256: semanticEvidenceSha256,
    source_file_acquisition_audit: canonicalAuditEntries(
      input.source_file_identities || [],
    ),
    source_unavailable_scope_acquisition_audit: canonicalAuditEntries(
      input.source_unavailable_scopes || [],
    ),
    ratification_audit: canonicalAuditEntries(input.ratification_audit || []),
    rscript_identity: input.rscript_identity || null,
    backed_up_at_utc: backedUpAtUtc,
    proposal_writer_git_sha: writerGitSha,
  };
  const evidence = {
    ...semanticEvidence,
    semantic_evidence_sha256: semanticEvidenceSha256,
    acquisition_audit: acquisitionAudit,
    acquisition_audit_sha256: sha256(Buffer.from(
      canonicalJson(acquisitionAudit), "utf8",
    )),
  };
  const evidenceDir = path.join(stageRoot, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  writeAtomic(path.join(evidenceDir, "obs_history_rows.json"), rowsBody);
  writeAtomic(path.join(evidenceDir, "preserved_baseline_rows.json"), preservedRowsBody);
  writeAtomic(path.join(evidenceDir, "source-evidence.json"), Buffer.from(JSON.stringify(evidence), "utf8"));
  process.stdout.write(JSON.stringify({
    status: "ok",
    day_utc: dayUtc,
    connector_id: connectorId,
    rows_observations: evidenceRows.length,
    final_target_rows_observations: targetRows.length,
    preserved_baseline_rows: preservedEvidenceRows.length,
    source_connector_day_complete_events: 1,
    source_connector_day_failed_events: 0,
    source_connector_day_pending_events: 0,
    source_connector_day_skipped_events: 0,
    source_mapped_rows: evidenceRows.length,
    source_timeseries_row_counts: evidence.per_timeseries_counts,
    final_target_timeseries_row_counts: evidence.final_target_timeseries_row_counts,
    source_pollutant_codes: evidence.pollutant_set,
    objects_staged_local: pollutantManifests.reduce(
      (count, manifest) => count + manifest.file_count + 1,
      pollutantManifests.length > 0 ? 1 : 0,
    ),
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
