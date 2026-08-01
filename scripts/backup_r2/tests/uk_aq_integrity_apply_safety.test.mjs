import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyValidatedProposal,
  applySosLightPerDayUnits,
  assertPublicationDependenciesVerified,
  createVerifiedGetBodyCache,
  prepareMergedDayManifest,
  putAndVerifyObject,
  publicationRank,
  validateDedicatedSosHistoricalProposal,
  validateFinalProposalGraph,
  validateLocalProposal,
  verifyLiveObservationPartition,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  assembleSosLightDayParents,
  createStagedObjectMap,
} from "../uk_aq_execute_v2_observations_repair_impl.mjs";
import {
  finaliseLegacyObservationManifestCompatibility,
} from "../../../workers/uk_aq_backfill_local/r2_history/metadata_repair.mjs";
import {
  inspectSourceDerivedObservationManifestOwner,
} from "../../../workers/uk_aq_backfill_local/r2_history/proposal_ownership.mjs";
import {
  computeEmptyObservationContentHash,
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  buildHistoryV2PollutantManifest,
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  serializeCanonicalObservationV2Parquet,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  updateR2HistoryIndexesTargeted,
} from "../../../workers/shared/uk_aq_r2_history_index.mjs";

function writeObject(root, key, body) {
  const filePath = path.join(root, ...key.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return filePath;
}

function stateEntry(filePath, key, dependencies = [], dependencyIdentities = {}) {
  const body = fs.readFileSync(filePath);
  return {
    object_key: key,
    local_path: filePath,
    proposed: true,
    built: true,
    structurally_validated: true,
    bytes: body.byteLength,
    sha256: sha256Hex(body),
    dependencies,
    dependency_identities: dependencyIdentities,
  };
}

function sosLightEvidence(dayUtc = "2026-06-17") {
  return {
    mode: "sos-light",
    protected_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    sos_light: {
      mode: "sos-light",
      validation_status: "complete_local_days_validated",
      old_live_r2_observation_bodies_used: false,
      no_old_live_r2_body_planning_or_preservation: true,
      dropbox_warning_count: 0,
      dropbox_omission_count: 0,
      days: [{ day_utc: dayUtc }],
    },
  };
}

async function observationFixture({ wrongManifest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-apply-safety-"));
  const overlay = path.join(root, "overlay");
  const dropbox = path.join(root, "dropbox");
  fs.mkdirSync(dropbox, { recursive: true });
  const dayUtc = "2026-06-17";
  const connectorId = 1;
  const pollutantCode = "pm25";
  const prefix = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const partKey = `${prefix}/part-00000.parquet`;
  const manifestKey = `${prefix}/manifest.json`;
  const rows = [
    { connector_id: 1, station_id: 10, timeseries_id: 100, pollutant_code: "pm25", observed_at_utc: "2026-06-17T00:00:00.000Z", value: 12.5, verification_status: "P" },
    { connector_id: 1, station_id: 10, timeseries_id: 100, pollutant_code: "pm25", observed_at_utc: "2026-06-17T01:00:00.000Z", value: 13.5, verification_status: "P" },
  ];
  const partBody = serializeCanonicalObservationV2Parquet(rows);
  const partPath = writeObject(overlay, partKey, partBody);
  const sourceComputed = computeObservationContentHash(rows);
  const manifestComputed = wrongManifest
    ? computeObservationContentHash(rows.map((row) => ({ ...row, value: row.value + 100 })))
    : sourceComputed;
  const { canonical_rows: _sourceRows, ...sourceMetadata } = sourceComputed;
  const { canonical_rows: _manifestRows, ...manifestMetadata } = manifestComputed;
  const fileEntry = {
    key: partKey,
    row_count: rows.length,
    bytes: partBody.byteLength,
    etag_or_hash: sha256Hex(partBody),
    pollutant_codes: [pollutantCode],
    min_timeseries_id: 100,
    max_timeseries_id: 100,
    min_observed_at_utc: rows[0].observed_at_utc,
    max_observed_at_utc: rows.at(-1).observed_at_utc,
    timeseries_row_counts: { "100": rows.length },
  };
  const manifest = buildHistoryV2PollutantManifest({
    domain: "observations",
    grain: null,
    profile: null,
    dayUtc,
    connectorId,
    pollutantCode,
    runId: "test-run",
    manifestKey,
    sourceRowCount: rows.length,
    fileEntries: [fileEntry],
    writerGitSha: "test",
    backedUpAtUtc: "2026-06-18T00:00:00.000Z",
    observationContentHash: manifestMetadata,
  });
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestPath = writeObject(overlay, manifestKey, manifestBody);
  const evidenceDirectory = path.join(overlay, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const storedRows = rows.map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: row.verification_status,
  }));
  const sourceRowsBody = Buffer.from(JSON.stringify(storedRows));
  const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
  fs.writeFileSync(rowsPath, sourceRowsBody);
  const evidence = {
    schema_version: 1,
    enumeration_complete: true,
    day_utc: dayUtc,
    connector_id: connectorId,
    canonical_rows_bytes: sourceRowsBody.byteLength,
    canonical_rows_sha256: sha256Hex(sourceRowsBody),
    total_rows: rows.length,
    per_pollutant_counts: { [pollutantCode]: rows.length },
    observation_content_hashes: { [pollutantCode]: sourceMetadata },
  };
  fs.writeFileSync(path.join(evidenceDirectory, "source-evidence.json"), JSON.stringify(evidence));
  const partEntry = {
    ...stateEntry(partPath, partKey),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  const manifestEntry = {
    ...stateEntry(manifestPath, manifestKey, [partKey], {
      [partKey]: { sha256: partEntry.sha256, bytes: partEntry.bytes, source: "overlay" },
    }),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  const runState = {
    environment: "CIC-Test",
    overlay_root: overlay,
    base_dropbox_root: dropbox,
    objects: { [partKey]: partEntry, [manifestKey]: manifestEntry },
    tombstone_prefixes: [{
      prefix,
      proposed: true,
      repair_pollutants: [pollutantCode],
    }],
  };
  const runStatePath = path.join(root, "run-state.json");
  fs.writeFileSync(runStatePath, JSON.stringify(runState));
  return {
    root,
    runState,
    runStatePath,
    partKey,
    partBody,
    manifestKey,
    manifestBody,
    rowsPath,
    evidencePath: path.join(evidenceDirectory, "source-evidence.json"),
    storedRows,
  };
}

function retainScopedEvidence(fixture, { dayUtc, connectorId, pollutantCode, evidencePath, rowsPath }) {
  const identity = `day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const directory = path.join(
    fixture.runState.overlay_root,
    "source-evidence",
    `day_utc=${dayUtc}`,
    `connector_id=${connectorId}`,
    `pollutant_code=${pollutantCode}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  const scopedEvidencePath = path.join(directory, "source-evidence.json");
  const scopedRowsPath = path.join(directory, "obs_history_rows.json");
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  evidence.requested_pollutant_set = [pollutantCode];
  evidence.missing_binding_rows = 0;
  fs.writeFileSync(scopedEvidencePath, JSON.stringify(evidence));
  fs.copyFileSync(rowsPath, scopedRowsPath);
  fixture.runState.source_evidence_partitions ||= {};
  fixture.runState.source_evidence_partitions[identity] = {
    identity,
    day_utc: dayUtc,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
    evidence_path: scopedEvidencePath,
    rows_path: scopedRowsPath,
    evidence_sha256: sha256Hex(fs.readFileSync(scopedEvidencePath)),
    rows_sha256: sha256Hex(fs.readFileSync(scopedRowsPath)),
  };
  return fixture.runState.source_evidence_partitions[identity];
}

function appendObservationPartition(fixture, { dayUtc, connectorId, pollutantCode, timeseriesId }) {
  const prefix = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const partKey = `${prefix}/part-00000.parquet`;
  const manifestKey = `${prefix}/manifest.json`;
  const rows = [{
    connector_id: connectorId,
    station_id: 20,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    observed_at_utc: `${dayUtc}T00:00:00.000Z`,
    value: 21.5,
    verification_status: "P",
  }];
  const partBody = serializeCanonicalObservationV2Parquet(rows);
  const partPath = writeObject(fixture.runState.overlay_root, partKey, partBody);
  const { canonical_rows: _rows, ...metadata } = computeObservationContentHash(rows);
  const manifest = buildHistoryV2PollutantManifest({
    domain: "observations",
    grain: null,
    profile: null,
    dayUtc,
    connectorId,
    pollutantCode,
    runId: "test-run",
    manifestKey,
    sourceRowCount: rows.length,
    fileEntries: [{
      key: partKey,
      row_count: rows.length,
      bytes: partBody.byteLength,
      etag_or_hash: sha256Hex(partBody),
      pollutant_codes: [pollutantCode],
      min_timeseries_id: timeseriesId,
      max_timeseries_id: timeseriesId,
      min_observed_at_utc: rows[0].observed_at_utc,
      max_observed_at_utc: rows[0].observed_at_utc,
      timeseries_row_counts: { [String(timeseriesId)]: rows.length },
    }],
    writerGitSha: "test",
    backedUpAtUtc: "2026-06-18T00:00:00.000Z",
    observationContentHash: metadata,
  });
  const manifestPath = writeObject(
    fixture.runState.overlay_root,
    manifestKey,
    Buffer.from(JSON.stringify(manifest, null, 2)),
  );
  const storedRows = rows.map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: row.verification_status,
  }));
  const rowsBody = Buffer.from(JSON.stringify(storedRows));
  const evidenceDirectory = fs.mkdtempSync(path.join(fixture.root, "evidence-"));
  const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
  const evidencePath = path.join(evidenceDirectory, "source-evidence.json");
  fs.writeFileSync(rowsPath, rowsBody);
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema_version: 1,
    enumeration_complete: true,
    requested_pollutant_set: [pollutantCode],
    day_utc: dayUtc,
    connector_id: connectorId,
    canonical_rows_bytes: rowsBody.byteLength,
    canonical_rows_sha256: sha256Hex(rowsBody),
    total_rows: rows.length,
    missing_binding_rows: 0,
    per_pollutant_counts: { [pollutantCode]: rows.length },
    observation_content_hashes: { [pollutantCode]: metadata },
  }));
  const partEntry = {
    ...stateEntry(partPath, partKey),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  fixture.runState.objects[partKey] = partEntry;
  fixture.runState.objects[manifestKey] = {
    ...stateEntry(manifestPath, manifestKey, [partKey], {
      [partKey]: { sha256: partEntry.sha256, bytes: partEntry.bytes, source: "overlay" },
    }),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  fixture.runState.tombstone_prefixes.push({
    prefix,
    proposed: true,
    repair_pollutants: [pollutantCode],
  });
  return {
    prefix,
    partKey,
    manifestKey,
    evidence: retainScopedEvidence(fixture, {
      dayUtc, connectorId, pollutantCode, evidencePath, rowsPath,
    }),
  };
}

function replaceStoredEvidenceRows(fixture, storedRows) {
  const body = Buffer.from(JSON.stringify(storedRows));
  fs.writeFileSync(fixture.rowsPath, body);
  const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
  evidence.canonical_rows_bytes = body.byteLength;
  evidence.canonical_rows_sha256 = sha256Hex(body);
  evidence.total_rows = storedRows.length;
  fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
}

async function compatibilityFixture({ contentMismatch = false, dependencyMismatch = false } = {}) {
  const fixture = await observationFixture();
  const owned = await inspectSourceDerivedObservationManifestOwner({
    state: fixture.runState,
    manifestKey: fixture.manifestKey,
    overlayRoot: fixture.runState.overlay_root,
  });
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  const root = fixture.root;
  const connectorPath = path.join(root, "connector-manifest.json");
  const key = fixture.manifestKey;
  const connectorKey = "history/v2/observations/day_utc=2026-06-17/connector_id=1/manifest.json";
  const payload = {
    ...owned.payload,
    run_id: "different-planner-run",
    backed_up_at_utc: "2026-06-19T00:00:00.000Z",
    writer_git_sha: "different-writer-sha",
    manifest_hash: "operationally-different-derived-hash",
    ...(contentMismatch ? { source_row_count: owned.payload.source_row_count + 1 } : {}),
  };
  const dependencyIdentities = structuredClone(owned.dependency_identities);
  if (dependencyMismatch) dependencyIdentities[fixture.partKey].sha256 = "a".repeat(64);
  const existing = {
    key,
    kind: "pollutant_manifest",
    proposed_body: JSON.stringify(payload),
    dependencies: owned.dependencies,
    dependency_identities: dependencyIdentities,
    provenance: { source: "source_derived_observation_repair" },
  };
  return {
    key,
    existing,
    output: {
      planning: {
        proposals: [
          existing,
          { key: connectorKey, kind: "connector_manifest", proposed_body: "{}" },
        ],
        days: [],
      },
      results: [],
    },
    preparation: {
      run_state_path: fixture.runStatePath,
      prepared: [{
        day_utc: "2026-06-17",
        connector_id: 1,
        connector_key: connectorKey,
        connector_overlay_path: connectorPath,
        pollutant_proposals: [{
          key,
          retained_source_derived: true,
          content_facts: owned.content_facts,
          dependencies: owned.dependencies,
          dependency_identities: owned.dependency_identities,
          source_manifest_key: key,
          raw_pollutant_code: "pm25",
          pollutant_code: "pm25",
          proposal_owner: "source_derived_observation_repair",
          compatibility_source: "dropbox_canonical_manifest",
        }],
      }],
    },
  };
}

test("compatibility retains an owned source-derived manifest across operational metadata differences", async () => {
  const compatible = await compatibilityFixture();
  const finalised = finaliseLegacyObservationManifestCompatibility(compatible);
  assert.equal(finalised.planning.proposals.find((proposal) => proposal.key === compatible.key), compatible.existing);
  assert.equal(finalised.planning.compatibility_preparation.collisions[0].status, "retained_source_derived");
});

test("compatibility rejects exact source-derived content and dependency mismatches", async () => {
  const contentMismatch = await compatibilityFixture({ contentMismatch: true });
  assert.throws(
    () => finaliseLegacyObservationManifestCompatibility(contentMismatch),
    /Integrity proposal collision:.*differing_fields=source_row_count.*compatibility_source=dropbox_canonical_manifest/,
  );
  const dependencyMismatch = await compatibilityFixture({ dependencyMismatch: true });
  assert.throws(
    () => finaliseLegacyObservationManifestCompatibility(dependencyMismatch),
    /Integrity proposal collision:.*differing_fields=dependency_identities\..*\.sha256.*compatibility_source=dropbox_canonical_manifest/,
  );
});

test("compatibility ownership is independently derived from final staged Parquet", async () => {
  const fixture = await observationFixture();
  const originalManifest = fs.readFileSync(
    fixture.runState.objects[fixture.manifestKey].local_path,
  );
  const owned = await inspectSourceDerivedObservationManifestOwner({
    state: fixture.runState,
    manifestKey: fixture.manifestKey,
    overlayRoot: fixture.runState.overlay_root,
  });
  assert.equal(owned.owner, "source_derived_observation_repair");
  assert.equal(owned.semantic.observation_content_hash, owned.payload.observation_content_hash);
  assert.deepEqual(
    fs.readFileSync(fixture.runState.objects[fixture.manifestKey].local_path),
    originalManifest,
  );
  assert.equal(fixture.runState.objects[fixture.partKey].proposal_owner, "source_derived_observation_repair");
});

test("final proposal graph requires immutable source, staged Parquet and final manifest equality before remote mutation", async () => {
  const valid = await observationFixture();
  const proposal = validateLocalProposal(valid.runState);
  const audit = await validateFinalProposalGraph({ runState: valid.runState, proposal });
  assert.equal(audit.status, "succeeded");
  assert.equal(audit.validated_partition_count, 1);

  const invalid = await observationFixture({ wrongManifest: true });
  let remoteCalls = 0;
  const remote = async () => { remoteCalls += 1; throw new Error("remote adapter must not run"); };
  await assert.rejects(
    applyValidatedProposal({
      runStatePath: invalid.runStatePath,
      r2: {},
      adapters: { deleteObjects: remote, getObject: remote, listAllObjects: remote, putObject: remote },
    }),
    /Final Integrity proposal graph mismatch:.*observation_content_hash/,
  );
  assert.equal(remoteCalls, 0);
  const persisted = JSON.parse(fs.readFileSync(invalid.runStatePath, "utf8"));
  assert.equal(persisted.final_proposal_graph_validation.status, "failed");
});

test("SOS-light same-day pollutants validate against distinct immutable source evidence", async () => {
  const fixture = await observationFixture();
  const dayUtc = "2026-06-17";
  const connectorId = 1;
  const firstEvidence = retainScopedEvidence(fixture, {
    dayUtc,
    connectorId,
    pollutantCode: "pm25",
    evidencePath: fixture.evidencePath,
    rowsPath: fixture.rowsPath,
  });
  const second = appendObservationPartition(fixture, {
    dayUtc,
    connectorId,
    pollutantCode: "no2",
    timeseriesId: 200,
  });
  Object.assign(fixture.runState, {
    execution_path: "sos_light",
    ...sosLightEvidence(dayUtc),
    mutation_connector_ids: [1],
    aqi_policy: "bypassed_observation_history_only",
    changed_scopes: {
      AQILEVELS_CHANGED: [],
      AQI_MANIFESTS_CHANGED: [],
      AQI_INDEXES_CHANGED: [],
    },
  });
  fixture.runState.tombstone_prefixes = [{
    prefix: `history/v2/observations/day_utc=${dayUtc}`,
    proposed: true,
    stage: "sos_light_complete_day",
  }];
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  const proposal = validateLocalProposal(fixture.runState);
  const audit = await validateFinalProposalGraph({
    runState: fixture.runState,
    proposal,
    runStatePath: fixture.runStatePath,
  });
  assert.equal(audit.status, "succeeded");
  assert.equal(audit.validated_partition_count, 2);
  assert.notEqual(firstEvidence.evidence_path, second.evidence.evidence_path);
  assert.notEqual(firstEvidence.rows_path, second.evidence.rows_path);
  assert.equal(fs.existsSync(firstEvidence.evidence_path), true);
  assert.equal(fs.existsSync(second.evidence.evidence_path), true);
  assert.deepEqual(
    fixture.runState.tombstone_prefixes.map((entry) => entry.prefix).sort(),
    ["history/v2/observations/day_utc=2026-06-17"],
  );
  assert.ok(fixture.runState.objects[fixture.partKey]);
  assert.ok(fixture.runState.objects[second.partKey]);
  assert.equal(
    fixture.runState.objects[fixture.manifestKey].immutable_source_evidence_path,
    firstEvidence.evidence_path,
  );
  assert.equal(
    fixture.runState.objects[second.manifestKey].immutable_source_evidence_path,
    second.evidence.evidence_path,
  );
});

test("SOS-light pollutant-scoped evidence accepts authoritative no-data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-empty-source-"));
  const overlay = path.join(root, "overlay");
  const dropbox = path.join(root, "dropbox");
  fs.mkdirSync(dropbox, { recursive: true });
  const dayUtc = "2026-06-17";
  const connectorId = 1;
  const pollutantCode = "o3";
  const prefix = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const manifestKey = `${prefix}/manifest.json`;
  const { canonical_rows: _rows, ...emptyMetadata } = computeEmptyObservationContentHash();
  const manifestPath = writeObject(overlay, manifestKey, Buffer.from(JSON.stringify(
    buildHistoryV2PollutantManifest({
      domain: "observations",
      grain: null,
      profile: null,
      dayUtc,
      connectorId,
      pollutantCode,
      runId: "test-run",
      manifestKey,
      sourceRowCount: 0,
      fileEntries: [],
      writerGitSha: "test",
      backedUpAtUtc: "2026-06-18T00:00:00.000Z",
      observationContentHash: emptyMetadata,
    }), null, 2,
  )));
  const rowsBody = Buffer.from("[]");
  const temporaryEvidenceDirectory = fs.mkdtempSync(path.join(root, "evidence-"));
  const rowsPath = path.join(temporaryEvidenceDirectory, "obs_history_rows.json");
  const evidencePath = path.join(temporaryEvidenceDirectory, "source-evidence.json");
  fs.writeFileSync(rowsPath, rowsBody);
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema_version: 1,
    enumeration_complete: true,
    requested_pollutant_set: [pollutantCode],
    day_utc: dayUtc,
    connector_id: connectorId,
    canonical_rows_bytes: rowsBody.byteLength,
    canonical_rows_sha256: sha256Hex(rowsBody),
    total_rows: 0,
    missing_binding_rows: 0,
    per_pollutant_counts: {},
    observation_content_hashes: {},
  }));
  const runState = {
    environment: "CIC-Test",
    execution_path: "sos_light",
    ...sosLightEvidence(dayUtc),
    mutation_connector_ids: [1],
    aqi_policy: "bypassed_observation_history_only",
    overlay_root: overlay,
    base_dropbox_root: dropbox,
    objects: {
      [manifestKey]: {
        ...stateEntry(manifestPath, manifestKey),
        stage: "observations_data",
        proposal_owner: "source_derived_observation_repair",
      },
    },
    tombstone_prefixes: [{
      prefix: `history/v2/observations/day_utc=${dayUtc}`,
      proposed: true,
      stage: "sos_light_complete_day",
    }],
    changed_scopes: {
      AQILEVELS_CHANGED: [],
      AQI_MANIFESTS_CHANGED: [],
      AQI_INDEXES_CHANGED: [],
    },
  };
  const fixture = { root, runState };
  retainScopedEvidence(fixture, {
    dayUtc, connectorId, pollutantCode, evidencePath, rowsPath,
  });
  const audit = await validateFinalProposalGraph({
    runState,
    proposal: validateLocalProposal(runState),
  });
  assert.equal(audit.status, "succeeded");
  assert.equal(audit.validated_partition_count, 1);
  assert.equal(audit.partitions[0].row_count, 0);
});

async function assertApplyFailsBeforeRemote(fixture, expected) {
  let remoteCalls = 0;
  const remote = async () => {
    remoteCalls += 1;
    throw new Error("remote adapter must not run");
  };
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  await assert.rejects(applyValidatedProposal({
    runStatePath: fixture.runStatePath,
    r2: {},
    adapters: { deleteObjects: remote, getObject: remote, listAllObjects: remote, putObject: remote },
  }), expected);
  assert.equal(remoteCalls, 0);
}

test("immutable source adapter rejects invalid, out-of-day, and conflicting-connector stored rows", async () => {
  const invalidTimestamp = await observationFixture();
  assert.equal(Object.hasOwn(invalidTimestamp.storedRows[0], "connector_id"), false);
  assert.equal(Object.hasOwn(invalidTimestamp.storedRows[0], "observed_at_utc"), false);
  invalidTimestamp.storedRows[0].observed_at = "not-a-timestamp";
  replaceStoredEvidenceRows(invalidTimestamp, invalidTimestamp.storedRows);
  await assertApplyFailsBeforeRemote(invalidTimestamp, /observed_at is missing or invalid/);

  const outOfDay = await observationFixture();
  outOfDay.storedRows[0].observed_at = "2026-06-18T00:00:00.000Z";
  replaceStoredEvidenceRows(outOfDay, outOfDay.storedRows);
  await assertApplyFailsBeforeRemote(outOfDay, /observed_at is outside selected UTC day/);

  const conflictingConnector = await observationFixture();
  conflictingConnector.storedRows[0].connector_id = 7;
  replaceStoredEvidenceRows(conflictingConnector, conflictingConnector.storedRows);
  await assertApplyFailsBeforeRemote(conflictingConnector, /conflicting connector_id/);
});

test("final proposal graph requires source-derived partitions and pollutant tombstones in both directions", async () => {
  const missingTombstone = await observationFixture();
  missingTombstone.runState.tombstone_prefixes = [];
  await assertApplyFailsBeforeRemote(missingTombstone, /matching_pollutant_prefix_tombstone/);

  const unmatchedTombstone = await observationFixture();
  delete unmatchedTombstone.runState.objects[unmatchedTombstone.manifestKey];
  await assertApplyFailsBeforeRemote(unmatchedTombstone, /matching_staged_pollutant_manifest/);
});

test("live semantic verification trusts immutable source evidence and classifies a wrong manifest separately", async () => {
  const fixture = await observationFixture({ wrongManifest: true });
  const proposal = validateLocalProposal(fixture.runState);
  const manifestObject = proposal.objects.find((object) => object.key === fixture.manifestKey);
  fixture.runState.objects[fixture.partKey].r2_verified = true;
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  await assert.rejects(
    verifyLiveObservationPartition({
      r2: {},
      runState: fixture.runState,
      runStatePath: fixture.runStatePath,
      object: manifestObject,
      adapters: {
        getObject: async ({ key }) => {
          assert.equal(key, fixture.partKey);
          return { body: fixture.partBody, bytes: fixture.partBody.byteLength };
        },
      },
    }),
    /Proposed observation manifest does not match verified live source content/,
  );
  assert.equal(manifestObject.entry.live_observation_content_verified_against_source, true);
  assert.equal(manifestObject.entry.proposed_manifest_matches_live_observation, false);
  assert.equal(manifestObject.entry.live_observation_failure_classification, "proposal_manifest_defect");
  assert.equal(manifestObject.entry.live_observation_body_sources[0].source, "fresh_get");
});

test("live semantic verification reuses only the exact post-PUT verified body", async () => {
  const fixture = await observationFixture();
  const proposal = validateLocalProposal(fixture.runState);
  const manifestObject = proposal.objects.find((object) => object.key === fixture.manifestKey);
  fixture.runState.objects[fixture.partKey].r2_verified = true;
  const cache = createVerifiedGetBodyCache();
  cache.store({
    key: fixture.partKey,
    sha256: fixture.runState.objects[fixture.partKey].sha256,
    body: fixture.partBody,
  });
  await verifyLiveObservationPartition({
    r2: {},
    runState: fixture.runState,
    runStatePath: fixture.runStatePath,
    object: manifestObject,
    verifiedBodyCache: cache,
    adapters: { getObject: async () => { throw new Error("fresh GET must not run"); } },
  });
  assert.equal(manifestObject.entry.live_observation_content_verified_against_source, true);
  assert.equal(manifestObject.entry.proposed_manifest_matches_live_observation, true);
  assert.equal(manifestObject.entry.live_observation_body_sources[0].source, "verified_get_cache");
  assert.equal(cache.snapshot().current_entries, 0);
});

test("publication order and dependencies prevent indexes preceding manifests", async () => {
  const keys = [
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/manifest.json",
    "history/_index_v2/observations_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/manifest.json",
    "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
  ];
  assert.deepEqual(keys.map(publicationRank), [10, 20, 30, 40, 50, 60, 70, 80]);
  const manifestKey = keys[1];
  const indexObject = { key: keys[3], entry: { dependencies: [manifestKey] } };
  const runState = { objects: { [manifestKey]: { proposed: true, structurally_validated: true, r2_verified: false } } };
  assert.throws(
    () => assertPublicationDependenciesVerified({ object: indexObject, runState }),
    /Publication dependency is not GET-verified/,
  );
  runState.objects[manifestKey].r2_verified = true;
  assert.doesNotThrow(() => assertPublicationDependenciesVerified({ object: indexObject, runState }));

  const manifestBody = Buffer.from("{}");
  const planner = createStagedObjectMap({
    r2: {},
    store: {
      getObjectIfExists: (key) => key === manifestKey
        ? { key, body: manifestBody, bytes: manifestBody.byteLength, source: "overlay", content_sha256: sha256Hex(manifestBody) }
        : null,
    },
  });
  await planner.stagedR2.proposal_sink({ key: keys[3], body: "{}", content_type: "application/json" });
  assert.deepEqual(planner.proposals.get(keys[3]).dependencies, [manifestKey]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-index-"));
  const dropbox = path.join(root, "dropbox");
  const overlay = path.join(root, "overlay");
  const childManifest = {
    manifest_hash: "b".repeat(64),
    source_row_count: 2,
    timeseries_row_counts: { "100": 2 },
    files: [{ key: keys[0], row_count: 2, bytes: 10, etag_or_hash: "c".repeat(64) }],
  };
  const childBody = Buffer.from(JSON.stringify(childManifest));
  writeObject(dropbox, manifestKey, childBody);
  const indexPayload = {
    pollutant_manifest_key: manifestKey,
    connector_pollutant_manifest_key: manifestKey,
    pollutant_manifest_hash: childManifest.manifest_hash,
    source_row_count: childManifest.source_row_count,
    timeseries_row_counts: childManifest.timeseries_row_counts,
    files: childManifest.files,
  };
  const indexPath = writeObject(overlay, keys[3], Buffer.from(JSON.stringify(indexPayload)));
  const indexState = {
    environment: "CIC-Test",
    base_dropbox_root: dropbox,
    overlay_root: overlay,
    objects: {
      [keys[3]]: stateEntry(indexPath, keys[3], [manifestKey], {
        [manifestKey]: { sha256: sha256Hex(childBody), bytes: childBody.byteLength, source: "dropbox" },
      }),
    },
    tombstone_prefixes: [],
  };
  await assert.doesNotReject(validateFinalProposalGraph({
    runState: indexState,
    proposal: validateLocalProposal(indexState),
  }));
  indexPayload.source_row_count += 1;
  fs.writeFileSync(indexPath, JSON.stringify(indexPayload));
  indexState.objects[keys[3]] = stateEntry(indexPath, keys[3], [manifestKey], {
    [manifestKey]: { sha256: sha256Hex(childBody), bytes: childBody.byteLength, source: "dropbox" },
  });
  await assert.rejects(validateFinalProposalGraph({
    runState: indexState,
    proposal: validateLocalProposal(indexState),
  }), /manifest_counts/);
});

test("mixed changed and unchanged latest-index dependencies retain strict final validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-mixed-index-provenance-"));
  const overlay = path.join(root, "overlay");
  const dropbox = path.join(root, "dropbox");
  const prefix = "history/_index_v2/observations_timeseries/";
  const changedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=pm25/manifest.json`;
  const unchangedKey = `${prefix}day_utc=2026-07-07/connector_id=1/pollutant_code=123c6h3ch33/manifest.json`;
  const latestKey = "history/_index_v2/observations_timeseries_latest.json";
  const changedPath = writeObject(overlay, changedKey, Buffer.from(JSON.stringify({ version: "new" })));
  const unchangedPath = writeObject(dropbox, unchangedKey, Buffer.from(JSON.stringify({ version: "same" })));
  const latestPath = writeObject(overlay, latestKey, Buffer.from(JSON.stringify({ version: "new-latest" })));
  const changedEntry = stateEntry(changedPath, changedKey);
  const unchangedBody = fs.readFileSync(unchangedPath);
  const latestEntry = stateEntry(latestPath, latestKey, [changedKey, unchangedKey], {
    [changedKey]: {
      source: "planned_overlay",
      sha256: changedEntry.sha256,
      bytes: changedEntry.bytes,
    },
    [unchangedKey]: {
      source: "dropbox",
      sha256: sha256Hex(unchangedBody),
      bytes: unchangedBody.byteLength,
    },
  });
  const runState = {
    environment: "CIC-Test",
    base_dropbox_root: dropbox,
    objects: {
      [changedKey]: changedEntry,
      [latestKey]: latestEntry,
    },
    tombstone_prefixes: [],
  };

  const proposal = validateLocalProposal(runState);
  assert.deepEqual(proposal.objects.map((object) => object.key).sort(),
    [changedKey, latestKey].sort());
  assert.equal(proposal.objects.some((object) => object.key === unchangedKey), false);

  runState.objects[latestKey].dependency_identities[unchangedKey].source = "planned_overlay";
  assert.throws(
    () => validateLocalProposal(runState),
    /Dropbox baseline dependency identity is not pinned/,
  );
});

test("verified GET cache requires exact key and SHA, invalidates on mutation, and stays bounded to its scope", () => {
  const cache = createVerifiedGetBodyCache({ maxBytes: 8, maxEntries: 2 });
  const first = Buffer.from("1234");
  const second = Buffer.from("5678");
  const third = Buffer.from("abcd");
  const firstSha = sha256Hex(first);
  assert.equal(cache.store({ key: "history/v2/observations/a.parquet", sha256: firstSha, body: first }), true);
  assert.equal(cache.get("history/v2/observations/a.parquet", firstSha), first);
  assert.equal(cache.get("history/v2/observations/b.parquet", firstSha), null);
  assert.equal(cache.get("history/v2/observations/a.parquet", "f".repeat(64)), null);
  cache.invalidateKey("history/v2/observations/a.parquet", "later_put_same_key");
  assert.equal(cache.get("history/v2/observations/a.parquet", firstSha), null);
  cache.store({ key: "history/v2/observations/b.parquet", sha256: sha256Hex(second), body: second });
  cache.store({ key: "history/v2/observations/c.parquet", sha256: sha256Hex(third), body: third });
  cache.store({ key: "history/v2/observations/d.parquet", sha256: sha256Hex(first), body: first });
  const bounded = cache.snapshot();
  assert.ok(bounded.current_bytes <= bounded.max_bytes);
  assert.ok(bounded.current_entries <= bounded.max_entries);
  assert.ok(bounded.peak_bytes <= bounded.max_bytes);
  assert.ok(bounded.peak_entries <= bounded.max_entries);
  cache.clear("connector_day_scope_complete");
  assert.equal(cache.snapshot().current_entries, 0);
  assert.equal(cache.snapshot().current_bytes, 0);
});

test("SOS-light proposal requires one complete-day tombstone and complete local parents", async () => {
  const fixture = await observationFixture();
  const dayUtc = "2026-06-17";
  const connectorKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`;
  const dayKey = `history/v2/observations/day_utc=${dayUtc}/manifest.json`;
  const pollutant = JSON.parse(fs.readFileSync(fixture.runState.objects[fixture.manifestKey].local_path));
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId: 1, runId: "test-run",
    manifestKey: connectorKey, pollutantManifests: [pollutant], writerGitSha: "test",
    backedUpAtUtc: "2026-06-18T00:00:00.000Z",
  });
  const connectorPath = writeObject(fixture.runState.overlay_root, connectorKey, Buffer.from(JSON.stringify(connector, null, 2)));
  const connectorEntry = stateEntry(connectorPath, connectorKey, [fixture.manifestKey], {
    [fixture.manifestKey]: {
      sha256: fixture.runState.objects[fixture.manifestKey].sha256,
      bytes: fixture.runState.objects[fixture.manifestKey].bytes,
      source: "overlay",
    },
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc, runId: "test-run", manifestKey: dayKey,
    connectorManifests: [connector], writerGitSha: "test",
    backedUpAtUtc: "2026-06-18T00:00:00.000Z",
  });
  const dayPath = writeObject(fixture.runState.overlay_root, dayKey, Buffer.from(JSON.stringify(day, null, 2)));
  const dayEntry = stateEntry(dayPath, dayKey, [connectorKey], {
    [connectorKey]: { sha256: connectorEntry.sha256, bytes: connectorEntry.bytes, source: "overlay" },
  });
  Object.assign(fixture.runState.objects, { [connectorKey]: connectorEntry, [dayKey]: dayEntry });
  Object.assign(fixture.runState, {
    execution_path: "sos_light",
    ...sosLightEvidence(dayUtc),
    mutation_connector_ids: [1],
    aqi_policy: "bypassed_observation_history_only",
    changed_scopes: {
      AQILEVELS_CHANGED: [],
      AQI_MANIFESTS_CHANGED: [],
      AQI_INDEXES_CHANGED: [],
    },
  });
  fixture.runState.tombstone_prefixes = [{
    prefix: `history/v2/observations/day_utc=${dayUtc}`,
    proposed: true,
    stage: "sos_light_complete_day",
  }];
  const proposal = validateLocalProposal(fixture.runState);
  const validated = validateDedicatedSosHistoricalProposal({
    runState: fixture.runState,
    proposal,
  });
  assert.equal(validated.dedicated, true);
  assert.equal(validated.connector_id, 1);
  assert.equal(validated.complete_day_prefix_count, 1);
  fixture.runState.tombstone_prefixes[0] = {
    prefix: `${fixture.runState.tombstone_prefixes[0].prefix}/connector_id=1/pollutant_code=pm25`,
    proposed: true,
    stage: "observations_data",
    repair_pollutants: ["pm25"],
  };
  const invalidProposal = validateLocalProposal(fixture.runState);
  assert.throws(
    () => validateDedicatedSosHistoricalProposal({
      runState: fixture.runState,
      proposal: invalidProposal,
    }),
    /not a complete observation day/,
  );

  fixture.runState.tombstone_prefixes[0] = {
    prefix: `history/v2/observations/day_utc=${dayUtc}`,
    proposed: true,
    stage: "sos_light_complete_day",
  };
  fs.writeFileSync(connectorPath, "{}");
  Object.assign(fixture.runState.objects[connectorKey], {
    bytes: 2,
    sha256: sha256Hex(Buffer.from("{}")),
  });
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  let remoteCalls = 0;
  const remote = async () => { remoteCalls += 1; throw new Error("remote must not run"); };
  await assert.rejects(applyValidatedProposal({
    runStatePath: fixture.runStatePath,
    r2: {},
    adapters: { deleteObjects: remote, getObject: remote, listAllObjects: remote, putObject: remote },
  }), /dependency identity is invalid|manifest_contract/);
  assert.equal(remoteCalls, 0);
});

test("SOS-light first-day upload failure leaves every later day undeleted", async () => {
  const days = ["2026-07-29", "2026-07-30"];
  const dayGroups = new Map(days.map((dayUtc) => [dayUtc, [
    { kind: "delete", key: `history/v2/observations/day_utc=${dayUtc}` },
    { kind: "put", key: `history/v2/observations/day_utc=${dayUtc}/manifest.json` },
  ]]));
  const connectorGroups = new Map(days.map((dayUtc) => [`${dayUtc}|1`, {
    day_utc: dayUtc,
    connector_id: 1,
    operations: [{ kind: "put", key: `history/v2/observations/day_utc=${dayUtc}/connector_id=1/manifest.json` }],
  }]));
  const events = [];
  const publicationState = {};
  await assert.rejects(applySosLightPerDayUnits({
    selectedDays: days,
    dayGroups,
    connectorGroups,
    publicationState,
    applyDeletion: async ({ dayUtc }) => events.push(`delete ${dayUtc}`),
    applyConnectorGroup: async (group) => {
      events.push(`upload ${group.day_utc}`);
      throw new Error("simulated first-day upload failure");
    },
    applyDayFinalization: async ({ dayUtc }) => events.push(`day-parent ${dayUtc}`),
    publishAffectedIndexes: async () => events.push("publish indexes"),
  }), /simulated first-day upload failure/);
  assert.deepEqual(events, [
    "delete 2026-07-29",
    "upload 2026-07-29",
  ]);
  assert.equal(publicationState["2026-07-29"].deletion_verified, true);
  assert.equal(publicationState["2026-07-29"].status, "failed");
  assert.equal(publicationState["2026-07-29"].completed_publication_level,
    "complete_day_deletion_verified");
  assert.equal(Object.hasOwn(publicationState, "2026-07-30"), false);
});

test("SOS-light completes and verifies each day before deleting the next and publishes indexes last", async () => {
  const days = ["2026-07-29", "2026-07-30"];
  const dayGroups = new Map(days.map((dayUtc) => [dayUtc, [
    { kind: "delete", key: `history/v2/observations/day_utc=${dayUtc}` },
    { kind: "put", key: `history/v2/observations/day_utc=${dayUtc}/manifest.json` },
  ]]));
  const connectorGroups = new Map(days.map((dayUtc) => [`${dayUtc}|1`, {
    day_utc: dayUtc,
    connector_id: 1,
    operations: [{ kind: "put", key: `history/v2/observations/day_utc=${dayUtc}/connector_id=1/manifest.json` }],
  }]));
  const events = [];
  const publicationState = {};
  await applySosLightPerDayUnits({
    selectedDays: days,
    dayGroups,
    connectorGroups,
    publicationState,
    applyDeletion: async ({ dayUtc }) => events.push(`delete ${dayUtc}`),
    applyConnectorGroup: async (group) => events.push(`publish children ${group.day_utc}`),
    applyDayFinalization: async ({ dayUtc }) => events.push(`publish and verify day ${dayUtc}`),
    publishAffectedIndexes: async () => events.push("publish affected indexes"),
  });
  assert.deepEqual(events, [
    "delete 2026-07-29",
    "publish children 2026-07-29",
    "publish and verify day 2026-07-29",
    "delete 2026-07-30",
    "publish children 2026-07-30",
    "publish and verify day 2026-07-30",
    "publish affected indexes",
  ]);
  for (const dayUtc of days) {
    assert.equal(publicationState[dayUtc].status, "succeeded");
    assert.equal(publicationState[dayUtc].deletion_verified, true);
    assert.equal(publicationState[dayUtc].day_parent_verified, true);
    assert.equal(publicationState[dayUtc].completed_publication_level, "day_parent_verified");
  }
});

test("SOS-light connector 1 parent uses every final local child and warns on unusable Dropbox peers", async () => {
  const dayUtc = "2026-07-12";
  const base = `history/v2/observations/day_utc=${dayUtc}`;
  const contentHash = computeEmptyObservationContentHash();
  delete contentHash.canonical_rows;
  const pollutants = ["pm25", "pm10", "no2", "o3"].map((pollutantCode) => {
    const manifestKey = `${base}/connector_id=1/pollutant_code=${pollutantCode}/manifest.json`;
    return buildHistoryV2PollutantManifest({
      domain: "observations", dayUtc, connectorId: 1, pollutantCode,
      runId: "test-run", manifestKey, sourceRowCount: 0, fileEntries: [],
      writerGitSha: "test", backedUpAtUtc: "2026-07-13T00:00:00.000Z",
      observationContentHash: contentHash,
    });
  });
  const connectorKey = `${base}/connector_id=1/manifest.json`;
  const oldConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId: 1, runId: "old-dropbox",
    manifestKey: connectorKey, pollutantManifests: pollutants.slice(0, 3),
    writerGitSha: "old", backedUpAtUtc: "2026-07-13T00:00:00.000Z",
  });
  const objects = new Map(pollutants.map((payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    return [payload.manifest_key, {
      key: payload.manifest_key, body, bytes: body.byteLength,
      source: "overlay", content_sha256: sha256Hex(body),
    }];
  }));
  const oldBody = Buffer.from(JSON.stringify(oldConnector));
  objects.set(connectorKey, {
    key: connectorKey, body: oldBody, bytes: oldBody.byteLength,
    source: "dropbox", content_sha256: sha256Hex(oldBody),
  });
  const invalidKey = `${base}/connector_id=7/manifest.json`;
  const invalidBody = Buffer.from("{\"not\":\"canonical\"}");
  objects.set(invalidKey, {
    key: invalidKey, body: invalidBody, bytes: invalidBody.byteLength,
    source: "dropbox", content_sha256: sha256Hex(invalidBody),
  });
  const store = {
    getObjectIfExists: (key) => objects.get(key) || null,
    listAllObjects: ({ prefix }) => [...objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .map((object) => ({ key: object.key, size: object.bytes, source: object.source })),
  };
  const staged = createStagedObjectMap({ r2: {}, store });
  const finalConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId: 1, runId: "test-run",
    manifestKey: connectorKey, pollutantManifests: pollutants,
    writerGitSha: "test", backedUpAtUtc: "2026-07-13T00:00:00.000Z",
  });
  await staged.stage({
    key: connectorKey,
    body: JSON.stringify(finalConnector, null, 2),
    kind: "connector_manifest",
    dayUtc,
    dependencies: pollutants.map((payload) => payload.manifest_key),
  });
  const audit = {
    days: [], dropbox_warnings: [], dropbox_warning_count: 0,
    dropbox_omission_count: 0,
  };
  const assembled = await assembleSosLightDayParents({
    staged, base, dayUtc, protectedConnectorIds: [1],
    selectedMutationConnectorIds: [1], audit,
  });
  assert.deepEqual(
    assembled.children[0].pollutant_codes,
    ["no2", "o3", "pm10", "pm25"],
  );
  assert.deepEqual(
    staged.proposals.get(connectorKey).dependencies,
    pollutants.map((payload) => payload.manifest_key).sort(),
  );
  assert.deepEqual(audit.days[0].final_connector_1_child_set,
    pollutants.map((payload) => payload.manifest_key).sort());
  assert.deepEqual(audit.days[0].final_assembled_connector_ids, [1]);
  assert.deepEqual(audit.days[0].omitted_dropbox_connector_ids, [7]);
  assert.equal(audit.dropbox_warning_count, 1);
});

test("day finalizer can retain an exact validated connector set for generic callers", async () => {
  const dayUtc = "2026-07-12";
  const pollutantCode = "pm25";
  const connectorId = 1;
  const pollutantKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
  const { canonical_rows: _rows, ...contentHash } = computeObservationContentHash([{
    connector_id: connectorId,
    station_id: 1,
    timeseries_id: 1,
    pollutant_code: pollutantCode,
    observed_at_utc: `${dayUtc}T00:00:00.000Z`,
    value: 1,
    verification_status: null,
  }]);
  const pollutant = buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    pollutantCode,
    manifestKey: pollutantKey,
    sourceRowCount: 1,
    fileEntries: [{
      key: pollutantKey.replace("manifest.json", "part-00000.parquet"),
      row_count: 1,
      bytes: 1,
      min_timeseries_id: 1,
      max_timeseries_id: 1,
      min_observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      max_observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      timeseries_row_counts: { "1": 1 },
    }],
    writerGitSha: "test",
    backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
    observationContentHash: contentHash,
  });
  const connectorKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc,
    connectorId,
    manifestKey: connectorKey,
    pollutantManifests: [pollutant],
    writerGitSha: "test",
    backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
  });
  const dayKey = `history/v2/observations/day_utc=${dayUtc}/manifest.json`;
  const proposed = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc,
    manifestKey: dayKey,
    connectorManifests: [connector],
    writerGitSha: "test",
    backedUpAtUtc: `${dayUtc}T23:00:00.000Z`,
  });
  const object = {
    key: dayKey,
    body: Buffer.from(JSON.stringify(proposed)),
    entry: {},
  };
  let listCalls = 0;
  await prepareMergedDayManifest({
    r2: {},
    object,
    exactProposedConnectorSet: true,
    adapters: {
      getObject: async ({ key }) => {
        assert.equal(key, connectorKey);
        return { body: Buffer.from(JSON.stringify(connector)) };
      },
      listAllObjects: async () => { listCalls += 1; return []; },
    },
  });
  const finalDay = JSON.parse(object.body.toString("utf8"));
  assert.deepEqual(finalDay.connector_ids, [1]);
  assert.equal(finalDay.connector_manifests.some((item) => item.connector_id === 7), false);
  assert.equal(listCalls, 0);
});

test("changed-object apply records exactly one post-PUT verification GET", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-get-once-"));
  const runStatePath = path.join(root, "run-state.json");
  const key = "history/_index_v2/observations_timeseries_latest.json";
  const body = Buffer.from('{"ok":true}');
  const entry = { bytes: body.byteLength, sha256: sha256Hex(body) };
  const runState = { objects: { [key]: entry } };
  fs.writeFileSync(runStatePath, JSON.stringify(runState));
  let putCount = 0;
  let getCount = 0;
  const adapters = {
    putObject: async () => { putCount += 1; },
    getObject: async () => {
      getCount += 1;
      return { body, bytes: body.byteLength };
    },
  };
  const object = { key, body, entry };
  await putAndVerifyObject({
    r2: {},
    runState,
    runStatePath,
    object,
    adapters,
  });
  assert.equal(putCount, 1);
  assert.equal(getCount, 1);
  assert.equal(entry.post_put_verification_get_attempt_count, 1);
  assert.equal(entry.post_put_verification_get_count, 1);
  await assert.rejects(
    putAndVerifyObject({
      r2: {},
      runState,
      runStatePath,
      object,
      adapters,
    }),
    /already has post-PUT GET bookkeeping/,
  );
  assert.equal(putCount, 1);
  assert.equal(getCount, 1);
});

test("shared index builder retains its existing latest-only option for generic callers", async () => {
  const fixture = await observationFixture();
  const pollutant = JSON.parse(fixture.manifestBody.toString("utf8"));
  const dayUtc = pollutant.day_utc;
  const connectorId = pollutant.connector_id;
  const connectorKey = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`;
  const dayKey = `history/v2/observations/day_utc=${dayUtc}/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    grain: null,
    profile: null,
    dayUtc,
    connectorId,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [pollutant],
    writerGitSha: null,
    backedUpAtUtc: pollutant.backed_up_at_utc,
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    grain: null,
    profile: null,
    dayUtc,
    runId: null,
    manifestKey: dayKey,
    connectorManifests: [connector],
    writerGitSha: null,
    backedUpAtUtc: connector.backed_up_at_utc,
  });
  const objects = new Map([
    [fixture.manifestKey, fixture.manifestBody],
    [connectorKey, Buffer.from(JSON.stringify(connector))],
    [dayKey, Buffer.from(JSON.stringify(day))],
  ]);
  const putKeys = [];
  const r2 = {
    endpoint: "https://example.invalid",
    region: "auto",
    access_key_id: "test",
    secret_access_key: "test",
    bucket: "uk-aq-history-cic-test",
    adapter: {
      getObject: async ({ key }) => {
        const body = objects.get(key);
        if (!body) {
          const error = new Error(`missing ${key}`);
          error.code = "OBJECT_NOT_FOUND";
          throw error;
        }
        return { key, body, bytes: body.byteLength };
      },
      headObject: async ({ key }) => ({ exists: objects.has(key), key, etag: null }),
      putObject: async ({ key, body }) => {
        putKeys.push(key);
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
        return { key };
      },
      listAllObjects: async () => {
        throw new Error("scoped pollutant indexes must not be listed or rewritten");
      },
    },
  };
  const result = await updateR2HistoryIndexesTargeted({
    env: {},
    r2,
    historyVersion: "v2",
    domains: ["observations"],
    affectedDaysUtc: [dayUtc],
    updateLatestIndex: true,
    writePollutantIndexes: false,
    strictMissingTimeseriesCounts: true,
    writeR2: true,
  });
  assert.deepEqual(putKeys, ["history/_index_v2/observations_timeseries_latest.json"]);
  assert.equal(result.observations_timeseries.wrote_pollutant_indexes, false);
  assert.equal(result.observations_timeseries.latest_index_verified, true);
  assert.equal(result.observations_timeseries.latest_index_put_skipped, false);
});
