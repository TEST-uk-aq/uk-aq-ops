#!/usr/bin/env node
// Build a local canonical v2 proposal from already pinned/decoded RData rows.
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
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
} from "../../../../workers/shared/uk_aq_r2_history_canonical.mjs";

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
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

function main() {
  const [inputPath, stageRoot, observationsPrefix, writerGitSha] = process.argv.slice(2);
  if (!inputPath || !stageRoot || !observationsPrefix || !/^[0-9a-f]{40}$/.test(writerGitSha || "")) {
    throw new Error("usage: official_network_rdata_proposal.mjs INPUT STAGE_ROOT PREFIX WRITER_GIT_SHA");
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const dayUtc = String(input.day_utc || "");
  const connectorId = Number(input.connector_id);
  const sourceAdapter = String(input.source_adapter || "");
  const requestedPollutants = [...new Set(input.requested_pollutant_set || [])].sort();
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

  const pollutantManifests = [];
  const observationContentHashes = {};
  for (const pollutantCode of requestedPollutants) {
    const pollutantRows = rows.filter((row) => row.pollutant_code === pollutantCode);
    if (pollutantRows.length === 0) continue;
    const target = buildCanonicalObservationTimeseriesAlignedFiles(pollutantRows, {
      limits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
      partition: { day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode },
      fileKeyForOrdinal: (ordinal) => buildHistoryV2PartKey(
        observationsPrefix, dayUtc, connectorId, pollutantCode, ordinal,
      ),
    });
    for (const file of target.file_bodies) writeObject(stageRoot, file.key, file.body);
    const manifestKey = buildHistoryV2PollutantManifestKey(
      observationsPrefix, dayUtc, connectorId, pollutantCode,
    );
    const hashMetadata = contentHashMetadata(target.metadata);
    observationContentHashes[pollutantCode] = hashMetadata;
    const manifest = buildHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc,
      connectorId,
      pollutantCode,
      runId: null,
      manifestKey,
      sourceRowCount: target.metadata.row_count,
      fileEntries: target.metadata.files.map((file) => fileEntry(file, pollutantCode)),
      writerGitSha,
      backedUpAtUtc,
      observationContentHash: hashMetadata,
      physicalSchema: {
        history_schema_version: target.metadata.history_schema_version,
        columns: [...target.metadata.columns],
        writer_version: target.metadata.writer_version,
      },
    });
    writeObject(stageRoot, manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    pollutantManifests.push(manifest);
  }
  if (pollutantManifests.length === 0) throw new Error("canonical proposal contains no rows");

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
  const identities = [...(input.source_file_identities || [])].map((identity) => ({
    source_file: String(identity.source_file || ""),
    sha256: String(identity.sha256 || ""),
    bytes: Number(identity.bytes),
  })).sort((left, right) => left.source_file.localeCompare(right.source_file));
  const requiredSourceFiles = [...new Set(
    (input.required_source_files || identities.map((identity) => identity.source_file))
      .map((value) => String(value)),
  )].sort();
  const absentSourceFiles = [...new Set(
    (input.authoritatively_absent_source_files || []).map((value) => String(value)),
  )].sort();
  const readSourceFiles = identities.map((identity) => identity.source_file);
  if (requiredSourceFiles.some((value) =>
      !readSourceFiles.includes(value) && !absentSourceFiles.includes(value)) ||
      readSourceFiles.some((value) => absentSourceFiles.includes(value))) {
    throw new Error("source file evidence is incomplete or contradictory");
  }
  const identityBody = Buffer.from(JSON.stringify(identities), "utf8");
  const perTimeseries = {};
  const perPollutant = {};
  const verificationStatusCounts = { P: 0, R: 0 };
  for (const row of evidenceRows) {
    perTimeseries[String(row.timeseries_id)] = (perTimeseries[String(row.timeseries_id)] || 0) + 1;
    perPollutant[row.pollutant_code] = (perPollutant[row.pollutant_code] || 0) + 1;
    if (!(row.verification_status in verificationStatusCounts)) {
      throw new Error(`invalid verification_status: ${row.verification_status}`);
    }
    verificationStatusCounts[row.verification_status] += 1;
  }
  const contract = "pollutant_scoped_authoritative_connector_day_source_rows";
  const evidenceInput = {
    source_adapter: sourceAdapter,
    day_utc: dayUtc,
    connector_id: connectorId,
    source_file_identities_sha256: sha256(identityBody),
    requested_pollutant_set: requestedPollutants,
    contract,
    evidence_contract_version: 4,
    source_label_registry_snapshot_content_sha256: null,
    authoritative_station_timeseries_mapping_sha256: input.authoritative_mapping_sha256 || null,
    sos_site_ref_bridge_mapping_identity: null,
    sos_site_ref_bridge_artifact_sha256: null,
    observed_property_mapping_sha256: input.observed_property_mapping_sha256 || null,
  };
  const evidence = {
    schema_version: 1,
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
    per_pollutant_counts: Object.fromEntries(Object.entries(perPollutant).sort(([a], [b]) => a.localeCompare(b))),
    observation_content_hashes: Object.fromEntries(Object.entries(observationContentHashes).sort(([a], [b]) => a.localeCompare(b))),
    pollutant_set: Object.keys(perPollutant).sort(),
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
    ratification_audit: input.ratification_audit || [],
    source_verification_status_counts: verificationStatusCounts,
    rscript_identity: input.rscript_identity || null,
    timestamp_mapping: "rdata_date_beginning_plus_one_hour_to_observed_at_utc",
  };
  const evidenceDir = path.join(stageRoot, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  writeAtomic(path.join(evidenceDir, "obs_history_rows.json"), rowsBody);
  writeAtomic(path.join(evidenceDir, "source-evidence.json"), Buffer.from(JSON.stringify(evidence), "utf8"));
  process.stdout.write(JSON.stringify({
    status: "ok",
    day_utc: dayUtc,
    connector_id: connectorId,
    rows_observations: evidenceRows.length,
    source_connector_day_complete_events: 1,
    source_connector_day_failed_events: 0,
    source_connector_day_pending_events: 0,
    source_connector_day_skipped_events: 0,
    source_mapped_rows: evidenceRows.length,
    source_timeseries_row_counts: evidence.per_timeseries_counts,
    source_pollutant_codes: evidence.pollutant_set,
    objects_staged_local: pollutantManifests.reduce((count, manifest) => count + manifest.file_count + 1, 1),
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
