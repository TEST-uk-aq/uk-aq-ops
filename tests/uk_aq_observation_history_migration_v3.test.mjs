import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildObservationHistoryIndexV3ChildShardKey,
  buildObservationHistoryIndexV3ScopedManifestKey,
  finalizeObservationHistoryIndexV3Publication,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  putAndVerifyR2ObjectWithSha256,
} from "../workers/shared/uk_aq_r2_checksum_publication.mjs";
import {
  buildCanonicalObservationTimeseriesBoundedFiles,
} from "../workers/shared/uk_aq_observation_history_target_writer.mjs";
import {
  validateObservationContentHashMetadata,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildHistoryV2TimeseriesLatestPayload,
  buildHistoryV2TimeseriesPollutantIndexPayload,
  buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey,
} from "../workers/shared/uk_aq_r2_history_index.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
  buildHistoryV2PollutantManifest,
  buildHistoryV2PollutantManifestKey,
  validateCanonicalHistoryV2Manifest,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  buildObservationMonthInventoryShard,
  buildHierarchicalInventoryRoot,
  completeObservationMonthState,
  emptyHierarchicalStateRoot,
  emptyObservationMonthState,
  markLatestTimeseriesProcessed,
  markObservationDayCopied,
  observationMonthInventoryShardKey,
  observationMonthStateShardKey,
  setStateRootProcessedHash,
  setStateYearProcessedHash,
  stableJson,
  upsertStateMonthSummary,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  DEFAULT_BACKUP_INVENTORY_ROOT_KEY,
  DEFAULT_BACKUP_STATE_ROOT_KEY,
  DEFAULT_V2_LATEST_KEY,
  DEFAULT_V3_LATEST_KEY,
  buildObservationHistoryV2RestorePlan,
  buildObservationHistoryV3MigrationAuditReport,
  buildObservationHistoryV3MigrationPlan,
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
  buildObservationHistoryV3RerunVerificationPlan,
  executeObservationHistoryV2Rollback,
  executeObservationHistoryV3MigrationPlan,
  inventoryAuthoritativeCanonicalObservationHistory,
  stableMigrationJson,
  validateObservationHistoryV3MigrationEnvironment,
  verifyObservationHistoryV2IndexCompleteness,
  verifyObservationHistoryV3CheckpointReuse,
  verifyObservationHistoryV3CurrentDependencies,
  verifyObservationHistoryV3MigrationResult,
} from "../scripts/backup_r2/lib/observation_history_migration_v3.mjs";
import {
  buildObservationsManifestHierarchy,
} from "../scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs";
import {
  buildObservationHistoryV3RecoveryProgressContext,
  buildObservationHistoryV3ReportOutput,
} from "../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const PREFIX = "history/v2/observations";
const DAY = "2026-01-02";
const LIMITS = Object.freeze({
  target_row_group_rows: 2,
  max_row_group_rows: 2,
  target_file_rows: 4,
  max_file_rows: 4,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});
const SOURCE_LIMITS = Object.freeze({
  ...LIMITS,
  target_row_group_rows: 4,
  max_row_group_rows: 4,
  max_row_groups_per_file: 1,
});
const ENVIRONMENT = Object.freeze({
  environment: "TEST",
  configuredEnvironment: "TEST",
  bucket: "fixture-test-bucket",
  expectedBucket: "fixture-test-bucket",
  historyVersion: "v2",
  indexVersion: "v2",
  integrityVersion: "v2",
});
const STALE_PARENT_SUMMARY_IDENTITY_FIELDS = Object.freeze([
  "pollutant_code",
  "manifest_key",
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
]);
const EMPTY_CONNECTOR_ZERO_FIELDS = Object.freeze([
  "source_row_count",
  "row_count",
  "file_count",
  "total_bytes",
  "bytes_per_row_estimate",
  "avg_file_bytes",
  "min_file_bytes",
  "max_file_bytes",
]);
const EMPTY_CONNECTOR_ARRAY_FIELDS = Object.freeze([
  "pollutant_codes",
  "pollutant_manifests",
  "child_manifests",
  "files",
  "parquet_object_keys",
]);
const EMPTY_CONNECTOR_NULL_FIELDS = Object.freeze([
  "pollutant_code",
  "timeseries_row_counts",
  "min_timeseries_id",
  "max_timeseries_id",
  "min_observed_at_utc",
  "max_observed_at_utc",
  "min_timestamp_hour_utc",
  "max_timestamp_hour_utc",
]);

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function metadataHash(metadata) {
  return {
    observation_content_hash: metadata.observation_content_hash,
    observation_content_hash_algorithm: metadata.observation_content_hash_algorithm,
    observation_content_hash_contract_version:
      metadata.observation_content_hash_contract_version,
    observation_content_hash_row_count:
      metadata.observation_content_hash_row_count,
    observation_content_hash_columns: [...metadata.observation_content_hash_columns],
    verification_status_counts: { ...metadata.verification_status_counts },
  };
}

function rehashManifest(manifest) {
  const { manifest_hash: _oldHash, ...payload } = manifest;
  return { ...payload, manifest_hash: sha256Hex(JSON.stringify(payload)) };
}

function fileEntry(file, pollutantCode) {
  return {
    key: file.key,
    row_count: file.row_count,
    bytes: file.byte_size,
    etag_or_hash: file.sha256,
    pollutant_codes: [pollutantCode],
    min_timeseries_id: Math.min(...file.row_groups.map((entry) => entry.min_timeseries_id)),
    max_timeseries_id: Math.max(...file.row_groups.map((entry) => entry.max_timeseries_id)),
    min_observed_at_utc: file.row_groups
      .map((entry) => entry.min_observed_at_utc).sort()[0],
    max_observed_at_utc: file.row_groups
      .map((entry) => entry.max_observed_at_utc).sort().at(-1),
    timeseries_row_counts: { ...file.timeseries_row_counts },
  };
}

function mapReader(objects) {
  return async ({ key }) => objects.has(key)
    ? { exists: true, body: Buffer.from(objects.get(key)) }
    : { exists: false, body: null };
}

function readerWithFailure(objects, shouldFail, errorForKey) {
  return async ({ key }) => {
    if (shouldFail(key)) throw errorForKey(key);
    return objects.has(key)
      ? { exists: true, body: Buffer.from(objects.get(key)) }
      : { exists: false, body: null };
  };
}

function realR2NotFoundError(key) {
  return new Error(
    `R2 GET failed (404) key=${key}: <?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`,
  );
}

async function buildFixture({
  pollutantCodes = ["pm25", "pm10"],
  manifestModes = {},
  parentReferenceOverrides = {},
  missingParentReferenceFields = {},
  staleParentHashes = {},
  emptyConnector = null,
} = {}) {
  const baseRows = [
    [100, "2026-01-02T00:00:00.000Z", 10, "P"],
    [100, "2026-01-02T01:00:00.000Z", 11, "R"],
    [1000, "2026-01-02T00:30:00.000Z", 20, "P"],
    [1000, "2026-01-02T01:30:00.000Z", 21, "R"],
  ];
  const pollutantInputs = pollutantCodes.map((pollutantCode, index) => [
    pollutantCode,
    baseRows.map(([timeseriesId, ...rest]) => [timeseriesId + (index * 2000), ...rest]),
  ]);
  const sources = [];
  const pollutants = [];
  const parentReferenceHashes = new Map();
  for (const [pollutantCode, inputRows] of pollutantInputs) {
    const rows = inputRows.map(([timeseriesId, observedAtUtc, value, verificationStatus]) => ({
    connector_id: 1,
    station_id: timeseriesId + 1,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    observed_at_utc: observedAtUtc,
    value,
    verification_status: verificationStatus,
    }));
    const source = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
      limits: SOURCE_LIMITS,
      fileKeyForOrdinal: (ordinal) =>
        `${PREFIX}/day_utc=${DAY}/connector_id=1/pollutant_code=${pollutantCode}/part-${String(ordinal).padStart(5, "0")}.parquet`,
    });
    const pollutantKey = buildHistoryV2PollutantManifestKey(
      PREFIX,
      DAY,
      1,
      pollutantCode,
    );
    let pollutant = buildHistoryV2PollutantManifest({
      domain: "observations",
      dayUtc: DAY,
      connectorId: 1,
      pollutantCode,
      manifestKey: pollutantKey,
      sourceRowCount: source.metadata.row_count,
      fileEntries: source.metadata.files.map((file) => fileEntry(file, pollutantCode)),
      writerGitSha: "fixture-source",
      backedUpAtUtc: "2026-01-03T00:00:00.000Z",
      observationContentHash: metadataHash(source.metadata),
      physicalSchema: {
        history_schema_version: source.metadata.history_schema_version,
        columns: [...source.metadata.columns],
        writer_version: source.metadata.writer_version,
      },
    });
    const manifestMode = manifestModes[pollutantCode] || "modern";
    if (
      manifestMode === "legacy_hashless" ||
      manifestMode === "legacy_hashless_null" ||
      manifestMode === "legacy_hashless_stale_parent"
    ) {
      pollutant = structuredClone(pollutant);
      for (const field of [
        "observation_content_hash",
        "observation_content_hash_algorithm",
        "observation_content_hash_contract_version",
        "observation_content_hash_row_count",
        "observation_content_hash_columns",
        "verification_status_counts",
      ]) {
        if (manifestMode === "legacy_hashless_null") pollutant[field] = null;
        else delete pollutant[field];
      }
      pollutant = rehashManifest(pollutant);
    } else if (
      manifestMode === "malformed_hash" ||
      manifestMode === "malformed_hash_stale_parent"
    ) {
      pollutant = rehashManifest({
        ...pollutant,
        observation_content_hash: "NOT-A-SHA256",
      });
    } else if (
      manifestMode === "partial_contract" ||
      manifestMode === "partial_contract_stale_parent"
    ) {
      pollutant = structuredClone(pollutant);
      delete pollutant.observation_content_hash_algorithm;
      pollutant = rehashManifest(pollutant);
    }
    let parentReferenceHash = pollutant.manifest_hash;
    if (
      manifestMode === "legacy_hashless_stale_parent" ||
      manifestMode === "modern_stale_parent" ||
      manifestMode === "malformed_hash_stale_parent" ||
      manifestMode === "partial_contract_stale_parent"
    ) {
      parentReferenceHash = staleParentHashes[pollutantCode] || "a".repeat(64);
    }
    sources.push(source);
    pollutants.push({ key: pollutantKey, payload: pollutant });
    parentReferenceHashes.set(pollutantCode, parentReferenceHash);
  }
  const connectorKey = buildHistoryV2ConnectorManifestKey(PREFIX, DAY, 1);
  let connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 1,
    manifestKey: connectorKey,
    pollutantManifests: pollutants.map((entry) => ({
      ...entry.payload,
      manifest_hash: parentReferenceHashes.get(entry.payload.pollutant_code),
      ...(parentReferenceOverrides[entry.payload.pollutant_code] || {}),
    })),
    writerGitSha: "fixture-source",
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
  if (Object.keys(missingParentReferenceFields).length) {
    connector = structuredClone(connector);
    for (const field of ["child_manifests", "pollutant_manifests"]) {
      for (const reference of connector[field] || []) {
        for (const missing of
          missingParentReferenceFields[reference.pollutant_code] || []) {
          delete reference[missing];
        }
      }
    }
    connector = rehashManifest(connector);
  }
  let emptyConnectorEntry = null;
  if (emptyConnector) {
    const connectorId = emptyConnector.connectorId || 2;
    const key = buildHistoryV2ConnectorManifestKey(PREFIX, DAY, connectorId);
    let payload = buildHistoryV2ConnectorManifest({
      domain: "observations",
      dayUtc: DAY,
      connectorId,
      manifestKey: key,
      pollutantManifests: [],
      writerGitSha: "fixture-source",
      backedUpAtUtc: "2026-01-03T00:00:00.000Z",
    });
    if (
      Object.keys(emptyConnector.overrides || {}).length ||
      (emptyConnector.missingFields || []).length
    ) {
      payload = structuredClone(payload);
      Object.assign(payload, emptyConnector.overrides || {});
      for (const field of emptyConnector.missingFields || []) delete payload[field];
      payload = rehashManifest(payload);
    }
    if (emptyConnector.invalidManifestHash) {
      payload = structuredClone(payload);
      payload.backed_up_at_utc = "2026-01-03T00:00:01.000Z";
    }
    emptyConnectorEntry = {
      key,
      connectorId,
      payload,
      dayReference: {
        ...payload,
        day_utc: DAY,
        connector_id: connectorId,
        manifest_key: key,
        manifest_hash:
          emptyConnector.dayReferenceHash || payload.manifest_hash,
      },
    };
  }
  const dayKey = buildHistoryV2DayManifestKey(PREFIX, DAY);
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    manifestKey: dayKey,
    connectorManifests: [
      connector,
      ...(emptyConnectorEntry ? [emptyConnectorEntry.dayReference] : []),
    ],
    writerGitSha: "fixture-source",
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
  const hierarchy = buildObservationsManifestHierarchy({
    observationsPrefix: PREFIX,
    dayManifests: [day],
  });
  const r2 = new Map();
  const backup = new Map();
  for (const source of sources) {
    for (const file of source.file_bodies) r2.set(file.key, Buffer.from(file.body));
  }
  for (const [key, value] of [
    ...pollutants.map((entry) => [entry.key, entry.payload]),
    [connectorKey, connector],
    ...(emptyConnectorEntry
      ? [[emptyConnectorEntry.key, emptyConnectorEntry.payload]]
      : []),
    [dayKey, day],
  ]) r2.set(key, jsonBody(value));
  for (const object of hierarchy.objects) r2.set(object.key, Buffer.from(object.body));
  r2.set(DEFAULT_V2_LATEST_KEY, jsonBody({ generation: "fixture-v2" }));
  for (const { payload } of pollutants) {
    r2.set(
      `history/_index_v2/observations_timeseries/day_utc=${DAY}/connector_id=1/pollutant_code=${payload.pollutant_code}/manifest.json`,
      jsonBody({ scope: `fixture-v2-${payload.pollutant_code}` }),
    );
  }
  for (const [key, value] of r2) {
    if (key.startsWith(PREFIX)) backup.set(key, Buffer.from(value));
  }
  const inventoryPrefix = "history/_index_v2/backup_inventory_v2";
  const statePrefix = "_ops/checkpoints/r2_history_backup_state_v2";
  const monthInventoryKey = observationMonthInventoryShardKey(
    inventoryPrefix,
    "2026",
    "01",
  );
  const monthManifest = hierarchy.months[0];
  const monthManifestKey = hierarchy.objects.find((entry) => entry.level === "month").key;
  const monthInventory = buildObservationMonthInventoryShard({
    observationsPrefix: PREFIX,
    year: "2026",
    month: "01",
    sourceMonthManifestKey: monthManifestKey,
    sourceMonthHash: monthManifest.content_hash,
    days: [{
      day_utc: DAY,
      manifest_key: dayKey,
      manifest_hash: day.manifest_hash,
      manifest_file_hash: sha256Hex(r2.get(dayKey)),
      manifest_size: r2.get(dayKey).byteLength,
    }],
  });
  const monthInventoryBody = Buffer.from(stableJson(monthInventory));
  r2.set(monthInventoryKey, monthInventoryBody);
  const latestBody = r2.get(DEFAULT_V2_LATEST_KEY);
  const inventoryRoot = buildHierarchicalInventoryRoot({
    observationsRootManifestKey: hierarchy.objects.find((entry) => entry.level === "root").key,
    observationsRootHash: hierarchy.root.content_hash,
    years: hierarchy.years.map((year) => ({
      year: year.year,
      manifest_key: hierarchy.objects.find((entry) =>
        entry.level === "year" && entry.manifest.year === year.year
      ).key,
      content_hash: year.content_hash,
      months: hierarchy.months.map((month) => ({
        month: month.month,
        manifest_key: hierarchy.objects.find((entry) =>
          entry.level === "month" &&
          entry.manifest.year === month.year &&
          entry.manifest.month === month.month
        ).key,
        content_hash: month.content_hash,
        inventory_shard_key: monthInventoryKey,
      })),
    })),
    runManifestInventoryShardKey: `${inventoryPrefix}/global/observation_run_manifests.json`,
    runManifestInventoryShardHash: "1".repeat(64),
    runManifestUnitCount: 0,
    latestTimeseries: {
      relative_path: DEFAULT_V2_LATEST_KEY,
      sha256: sha256Hex(latestBody),
      byte_size: latestBody.byteLength,
    },
  });
  const inventoryRootBody = Buffer.from(stableJson(inventoryRoot));
  r2.set(DEFAULT_BACKUP_INVENTORY_ROOT_KEY, inventoryRootBody);
  const monthStateKey = observationMonthStateShardKey(statePrefix, "2026", "01");
  let monthState = emptyObservationMonthState("2026", "01");
  monthState = markObservationDayCopied(
    monthState,
    monthInventory.days[0],
    "2026-01-03T01:00:00.000Z",
  );
  monthState = completeObservationMonthState(monthState, monthInventory);
  const monthStateBody = Buffer.from(stableJson(monthState));
  backup.set(monthStateKey, monthStateBody);
  const stateRoot = emptyHierarchicalStateRoot(statePrefix);
  upsertStateMonthSummary(stateRoot, {
    year: "2026",
    month: "01",
    stateShardKey: monthStateKey,
    processedSourceMonthHash: monthManifest.content_hash,
    stateShardHash: sha256Hex(monthStateBody),
  });
  setStateYearProcessedHash(stateRoot, "2026", hierarchy.years[0].content_hash);
  setStateRootProcessedHash(stateRoot, hierarchy.root.content_hash);
  markLatestTimeseriesProcessed(stateRoot, inventoryRoot.global_units.observations_timeseries_latest, "2026-01-03T01:00:00.000Z");
  const stateRootBody = Buffer.from(stableJson(stateRoot));
  backup.set(DEFAULT_BACKUP_STATE_ROOT_KEY, stateRootBody);
  return {
    r2,
    backup,
    source: sources[0],
    sources,
    connectorKey,
    emptyConnectorKey: emptyConnectorEntry?.key || null,
    pollutantKeys: new Map(
      pollutants.map((entry) => [entry.payload.pollutant_code, entry.key]),
    ),
    oldCanonical: new Map(
      [...backup].filter(([key]) => key.startsWith(PREFIX)),
    ),
    expectedInventoryRootSha256: sha256Hex(inventoryRootBody),
    expectedStateRootSha256: sha256Hex(stateRootBody),
  };
}

async function buildPlan(fixture, overrides = {}) {
  return buildObservationHistoryV3MigrationPlan({
    getR2Object: mapReader(fixture.r2),
    getBackupObject: mapReader(fixture.backup),
    repositoryRoot: REPOSITORY_ROOT,
    environmentEvidence: ENVIRONMENT,
    migrationRunId: "fixture-migration",
    writerLimits: LIMITS,
    targetWriterGitSha: "a".repeat(40),
    expectedInventoryRootSha256: fixture.expectedInventoryRootSha256,
    expectedStateRootSha256: fixture.expectedStateRootSha256,
    ...overrides,
  });
}

async function publishCompleteFixtureV2Indexes(fixture) {
  const inventory = await inventoryAuthoritativeCanonicalObservationHistory({
    getR2Object: mapReader(fixture.r2),
  });
  const payloads = inventory.partitions.map((partition) => {
    const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
      domain: "observations",
      dayUtc: partition.scope.day_utc,
      connectorId: partition.scope.connector_id,
      pollutantCode: partition.scope.pollutant_code,
      generatedAt: "2026-01-03T00:00:00.000Z",
      bucket: ENVIRONMENT.bucket,
      dataPrefix: inventory.observations_prefix,
      pollutantManifestKey: partition.manifest_identity.key,
      pollutantManifest: partition.manifest,
    });
    const key = buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      "history/_index_v2/observations_timeseries",
      partition.scope.day_utc,
      partition.scope.connector_id,
      partition.scope.pollutant_code,
    );
    fixture.r2.set(key, jsonBody(payload));
    return { key, scope: partition.scope, payload };
  });
  const connector = inventory.connector_manifests[0];
  const day = inventory.day_manifests[0];
  const latest = buildHistoryV2TimeseriesLatestPayload({
    domain: "observations",
    bucket: ENVIRONMENT.bucket,
    generatedAt: "2026-01-03T00:00:00.000Z",
    indexPrefix: "history/_index_v2",
    dataPrefix: inventory.observations_prefix,
    timeseriesIndexPrefix: "history/_index_v2/observations_timeseries",
    daySummaries: [{
      day_utc: DAY,
      connector_count: 1,
      connector_ids: [1],
      connectors: [{
        connector_id: 1,
        row_count: payloads.reduce((sum, entry) => sum + entry.payload.source_row_count, 0),
      }],
      total_rows: payloads.reduce((sum, entry) => sum + entry.payload.source_row_count, 0),
      pollutant_codes: payloads.map((entry) => entry.scope.pollutant_code).sort(),
      pollutant_index_count: payloads.length,
      file_count: payloads.reduce((sum, entry) => sum + entry.payload.file_count, 0),
      indexed_file_count: payloads.reduce(
        (sum, entry) => sum + entry.payload.indexed_file_count,
        0,
      ),
      backed_up_at_utc:
        day.payload.backed_up_at_utc || connector.payload.backed_up_at_utc,
    }],
  });
  fixture.r2.set(DEFAULT_V2_LATEST_KEY, jsonBody(latest));
  return { inventory, payloads, latest };
}

function memoryAdapters(fixture, options = {}) {
  const storedSha = new Map();
  const stagedBodies = new Map();
  const activeStagedUnits = new Set();
  let rebuildCalls = 0;
  let putCalls = 0;
  let jsonPutCalls = 0;
  let maxStagedUnits = 0;
  let maxStagedBodies = 0;
  const checkpoints = [];
  const getObject = mapReader(fixture.r2);
  return {
    storedSha,
    checkpoints,
    get putCalls() { return putCalls; },
    get jsonPutCalls() { return jsonPutCalls; },
    get maxStagedUnits() { return maxStagedUnits; },
    get maxStagedBodies() { return maxStagedBodies; },
    get stagedBodyCount() { return stagedBodies.size; },
    get rebuildCalls() { return rebuildCalls; },
    getObject,
    headObject: async ({ key }) => fixture.r2.has(key)
      ? {
          exists: true,
          bytes: fixture.r2.get(key).byteLength,
          sha256: storedSha.get(key) || null,
        }
      : { exists: false },
    putChecksumObject: async (intent) => {
      putCalls += 1;
      if (options.failPutCall === putCalls) {
        throw new Error(`fixture deliberate PUT failure ${putCalls}`);
      }
      assert.equal(sha256Hex(intent.body), intent.sha256);
      fixture.r2.set(intent.key, Buffer.from(intent.body));
      storedSha.set(intent.key, intent.sha256);
      return {
        key: intent.key,
        byte_size: intent.byte_size,
        sha256: intent.sha256,
        stored_sha256_verified: true,
      };
    },
    putJsonObject: async (object) => {
      jsonPutCalls += 1;
      fixture.r2.set(object.key, Buffer.from(object.body));
      return { ok: true };
    },
    putIfChanged: async (object) => {
      fixture.r2.set(object.key, Buffer.from(object.body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async () => ({ durable: true }),
    writeCheckpoint: async (checkpoint) => {
      if (options.failCheckpointCall === checkpoints.length + 1) {
        throw new Error(`fixture deliberate checkpoint failure ${checkpoints.length + 1}`);
      }
      checkpoints.push(structuredClone(checkpoint));
    },
    stageUnit: async ({ unitId, intents }) => {
      activeStagedUnits.add(unitId);
      const staged = intents.map((intent, index) => {
        const stagingRef = `${unitId}:${index}`;
        stagedBodies.set(stagingRef, Buffer.from(intent.body));
        return {
          key: intent.key,
          byte_size: intent.byte_size,
          sha256: intent.sha256,
          staging_ref: stagingRef,
        };
      });
      maxStagedUnits = Math.max(maxStagedUnits, activeStagedUnits.size);
      maxStagedBodies = Math.max(maxStagedBodies, stagedBodies.size);
      return staged;
    },
    readStagedBody: async ({ staging_ref: stagingRef }) => {
      if (!stagedBodies.has(stagingRef)) throw new Error("fixture staged body missing");
      return Buffer.from(stagedBodies.get(stagingRef));
    },
    releaseStagedUnit: async ({ unitId, intents }) => {
      for (const intent of intents) stagedBodies.delete(intent.staging_ref);
      activeStagedUnits.delete(unitId);
    },
    getBackupObject: mapReader(fixture.backup),
    finalizeV3Publication: (options) => finalizeObservationHistoryIndexV3Publication(options),
    rebuildV2Indexes: async () => {
      rebuildCalls += 1;
      return {
        ok: true,
        history_version: "v2",
        domains: ["observations"],
        warning_count: options.rebuildWarning ? 1 : 0,
        warnings: options.rebuildWarning ? [options.rebuildWarning] : [],
      };
    },
    verifyV2IndexCompleteness: async () => {
      if (options.v2IndexCompletenessError) throw options.v2IndexCompletenessError;
      return options.v2IndexCompleteness || {
        ok: true,
        complete: true,
        pollutant_index_count: 2,
      };
    },
  };
}

function legacyPreparedPlanSha(record) {
  return sha256Hex(stableMigrationJson({
    unit_id: record.unit_id,
    scope: record.scope,
    target_metadata: record.target_metadata,
    target_manifest: record.target_manifest,
    target_file_intents: (record.target_file_intents || []).map(
      ({ key, byte_size, sha256 }) => ({ key, byte_size, sha256 }),
    ),
    v3_index_root: record.v3_index_root,
  }));
}

function planJsonObjects(plan) {
  return [
    ...plan.canonical_publication_objects,
    ...plan.v3_publication_plan.entries,
  ];
}

function authenticatedRecoveryAuthority(checkpoint) {
  return {
    authenticated: true,
    original_checkpoint_sha256: "c".repeat(64),
    immutable_authority_sha256: checkpoint.authority_sha256,
    migration_run_id: checkpoint.migration_run_id,
    plan_sha256: checkpoint.plan_sha256,
    last_sequence: 1,
    last_entry_sha256: "d".repeat(64),
  };
}

async function buildLegacyRecoveryOrderingFixture() {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture);
  const execution = await executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  const legacyCheckpoint = structuredClone(execution.checkpoint);
  for (const record of Object.values(legacyCheckpoint.prepared_units)) {
    delete record.target_manifest_body;
    delete record.target_manifest_byte_size;
    delete record.target_manifest_sha256;
    record.prepared_plan_sha256 = legacyPreparedPlanSha(record);
  }
  const recoveredCheckpoint = JSON.parse(stableMigrationJson(legacyCheckpoint));
  const recoveredPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: recoveredCheckpoint,
    requirePrepared: true,
    allowLegacyRecoveryOrdering: true,
  });
  for (const object of planJsonObjects(recoveredPlan)) {
    fixture.r2.set(object.key, Buffer.from(object.body));
  }
  const verificationPlan = buildObservationHistoryV3RerunVerificationPlan({
    checkpoint: recoveredCheckpoint,
    allowLegacyRecoveryOrdering: true,
    recoveryAuthority: authenticatedRecoveryAuthority(recoveredCheckpoint),
  });
  return {
    fixture,
    adapters,
    checkpoint: recoveredCheckpoint,
    recoveredPlan,
    verificationPlan,
  };
}

test("Phase 6 optional scoped v2 probes accept the real R2 404/NoSuchKey shape", async () => {
  const fixture = await buildFixture();
  const scopedPrefix = "history/_index_v2/observations_timeseries/day_utc=";
  const plan = await buildPlan(fixture, {
    getR2Object: readerWithFailure(
      fixture.r2,
      (key) => key.startsWith(scopedPrefix),
      realR2NotFoundError,
    ),
  });
  assert.equal(plan.units.length, 2);
  assert.ok(plan.inventory.partitions.every(
    (entry) => entry.existing_v2_index_identity === null,
  ));
});

test("Phase 6 optional latest-v2 probe accepts the real R2 404/NoSuchKey shape", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture, {
    getR2Object: readerWithFailure(
      fixture.r2,
      (key) => key === DEFAULT_V2_LATEST_KEY,
      realR2NotFoundError,
    ),
  });
  assert.equal(plan.units.length, 2);
  assert.equal(plan.inventory.existing_v2_latest_identity, null);
});

test("Phase 6 optional v2 probes still fail on non-404 R2 errors", async () => {
  const fixture = await buildFixture();
  const scopedPrefix = "history/_index_v2/observations_timeseries/day_utc=";
  for (const error of [
    Object.assign(new Error("R2 GET failed (403) key=scope: AccessDenied"), { status: 403 }),
    Object.assign(new Error("R2 GET failed (500) key=scope: InternalError"), { status: 500 }),
    new Error("network socket disconnected"),
  ]) {
    await assert.rejects(
      buildPlan(fixture, {
        getR2Object: readerWithFailure(
          fixture.r2,
          (key) => key.startsWith(scopedPrefix),
          () => error,
        ),
      }),
      (actual) => actual === error,
    );
  }
});

test("Phase 6 stale v2 audit objects cannot alter canonical v3 migration units", async () => {
  const fixture = await buildFixture();
  const first = await buildPlan(fixture);
  for (const key of [...fixture.r2.keys()]) {
    if (key.startsWith("history/_index_v2/observations_timeseries")) {
      fixture.r2.set(key, jsonBody({ deliberately_stale: key, rows: [999999] }));
    }
  }
  const second = await buildPlan(fixture);
  assert.deepEqual(second.units, first.units);
  assert.notDeepEqual(second.inventory, first.inventory);
});

test("Phase 6 rollback completeness verifies every canonical pollutant and v2 latest", async () => {
  const fixture = await buildFixture();
  const { inventory, payloads } = await publishCompleteFixtureV2Indexes(fixture);
  const result = await verifyObservationHistoryV2IndexCompleteness({
    getR2Object: mapReader(fixture.r2),
    bucket: ENVIRONMENT.bucket,
    expectedCanonicalRootIdentity: inventory.root_manifest,
  });
  assert.equal(result.complete, true);
  assert.equal(result.day_count, 1);
  assert.equal(result.connector_count, 1);
  assert.equal(result.pollutant_index_count, payloads.length);
});

test("Phase 6 rollback completeness rejects a missing rebuilt pollutant index", async () => {
  const fixture = await buildFixture();
  const { inventory, payloads } = await publishCompleteFixtureV2Indexes(fixture);
  fixture.r2.delete(payloads[0].key);
  await assert.rejects(
    verifyObservationHistoryV2IndexCompleteness({
      getR2Object: mapReader(fixture.r2),
      bucket: ENVIRONMENT.bucket,
      expectedCanonicalRootIdentity: inventory.root_manifest,
    }),
    new RegExp(`Rebuilt v2 observation-timeseries index object is missing: ${payloads[0].key}`),
  );
});

test("Phase 6 rollback completeness rejects missing v2 latest publication", async () => {
  const fixture = await buildFixture();
  const { inventory } = await publishCompleteFixtureV2Indexes(fixture);
  fixture.r2.delete(DEFAULT_V2_LATEST_KEY);
  await assert.rejects(
    verifyObservationHistoryV2IndexCompleteness({
      getR2Object: mapReader(fixture.r2),
      bucket: ENVIRONMENT.bucket,
      expectedCanonicalRootIdentity: inventory.root_manifest,
    }),
    new RegExp(
      `Rebuilt v2 observation-timeseries latest index object is missing: ${DEFAULT_V2_LATEST_KEY}`,
    ),
  );
});

test("Phase 6 rollback completeness rejects missing connector/day coverage in v2 latest", async () => {
  const fixture = await buildFixture();
  const { inventory, latest } = await publishCompleteFixtureV2Indexes(fixture);
  const incompleteLatest = structuredClone(latest);
  incompleteLatest.day_summaries[0].connector_ids = [];
  incompleteLatest.day_summaries[0].connector_count = 0;
  incompleteLatest.connector_index_count = 0;
  fixture.r2.set(DEFAULT_V2_LATEST_KEY, jsonBody(incompleteLatest));
  await assert.rejects(
    verifyObservationHistoryV2IndexCompleteness({
      getR2Object: mapReader(fixture.r2),
      bucket: ENVIRONMENT.bucket,
      expectedCanonicalRootIdentity: inventory.root_manifest,
    }),
    /latest index is incomplete or contradictory/,
  );
});

test("Phase 6 migration inventory keeps complete modern hash metadata strict and manifest-provided", async () => {
  const fixture = await buildFixture();
  let canonicalParquetReads = 0;
  const getR2Object = async ({ key }) => {
    if (key.endsWith(".parquet")) canonicalParquetReads += 1;
    return mapReader(fixture.r2)({ key });
  };
  const plan = await buildPlan(fixture, { getR2Object });
  assert.equal(canonicalParquetReads, 0);
  assert.deepEqual(plan.source_observation_content_hash_provenance_counts, {
    manifest: 2,
    derived_from_legacy_canonical_parquet: 0,
  });
  assert.deepEqual(plan.source_manifest_reference_provenance_counts, {
    exact: 2,
    legacy_stale_parent_manifest_hash: 0,
    unexplained: 0,
  });
  assert.equal(plan.empty_source_connector_count, 0);
  assert.deepEqual(plan.empty_source_connectors, []);
  for (const unit of plan.units) {
    assert.equal(unit.source_observation_content_hash_provenance, "manifest");
    assert.equal(
      unit.source_observation_content_hash,
      unit.source_manifest.observation_content_hash,
    );
    assert.equal(unit.source_manifest_reference.provenance, "exact");
    assert.equal(
      unit.source_manifest_reference.referenced_child_manifest_hash,
      unit.source_manifest_reference.current_child_manifest_hash,
    );
    assert.equal(
      unit.source_manifest_reference.compatibility_contract_version,
      null,
    );
    assert.equal(unit.source_manifest_reference.parent_summary_identity, null);
    assert.equal(
      unit.source_manifest_reference.current_child_summary_identity,
      null,
    );
  }
});

test("Phase 6 derives and pins genuine legacy hashless metadata for any canonical property code", async () => {
  const fixture = await buildFixture({
    pollutantCodes: ["pm25", "h3cch2chch32"],
    manifestModes: { h3cch2chch32: "legacy_hashless" },
  });
  let canonicalParquetReads = 0;
  const getR2Object = async ({ key }) => {
    if (key.endsWith(".parquet")) canonicalParquetReads += 1;
    return mapReader(fixture.r2)({ key });
  };
  const first = await buildPlan(fixture, { getR2Object });
  assert.equal(canonicalParquetReads, 1);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.deepEqual(first.source_observation_content_hash_provenance_counts, {
    manifest: 1,
    derived_from_legacy_canonical_parquet: 1,
  });
  const legacy = first.units.find(
    (unit) => unit.scope.pollutant_code === "h3cch2chch32",
  );
  assert.equal(
    legacy.source_observation_content_hash_provenance,
    "derived_from_legacy_canonical_parquet",
  );
  assert.deepEqual(
    legacy.source_observation_content_hash_metadata,
    metadataHash(fixture.sources[1].metadata),
  );
  assert.equal(
    legacy.source_observation_content_hash,
    fixture.sources[1].metadata.observation_content_hash,
  );
  assert.equal(
    first.units.find((unit) => unit.scope.pollutant_code === "pm25")
      .source_observation_content_hash_provenance,
    "manifest",
  );
  const audit = buildObservationHistoryV3MigrationAuditReport({
    plan: first,
    mode: "plan",
  });
  assert.deepEqual(
    audit.source_observation_content_hash_provenance_counts,
    first.source_observation_content_hash_provenance_counts,
  );
  assert.equal(
    audit.partition_results.find(
      (entry) => entry.scope.pollutant_code === "h3cch2chch32",
    ).source_observation_content_hash_provenance,
    "derived_from_legacy_canonical_parquet",
  );
  const nullFixture = await buildFixture({
    manifestModes: { pm25: "legacy_hashless_null" },
  });
  const nullPlan = await buildPlan(nullFixture);
  assert.equal(
    nullPlan.units.find((unit) => unit.scope.pollutant_code === "pm25")
      .source_observation_content_hash_provenance,
    "derived_from_legacy_canonical_parquet",
  );
});

test("Phase 6 accepts a generic legacy stale parent only when all summary identities match and pins the contract", async () => {
  const fixture = await buildFixture({
    pollutantCodes: ["pm25", "h3cch2chch32"],
    manifestModes: {
      h3cch2chch32: "legacy_hashless_stale_parent",
    },
    staleParentHashes: { h3cch2chch32: "b".repeat(64) },
  });
  const first = await buildPlan(fixture);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.deepEqual(first.source_manifest_reference_provenance_counts, {
    exact: 1,
    legacy_stale_parent_manifest_hash: 1,
    unexplained: 0,
  });
  const unit = first.units.find(
    (entry) => entry.scope.pollutant_code === "h3cch2chch32",
  );
  const reference = unit.source_manifest_reference;
  assert.equal(
    reference.provenance,
    "legacy_stale_parent_manifest_hash",
  );
  assert.notEqual(
    reference.referenced_child_manifest_hash,
    reference.current_child_manifest_hash,
  );
  assert.equal(reference.referenced_child_manifest_hash, "b".repeat(64));
  assert.equal(reference.current_child_genuine_legacy_hashless, true);
  assert.equal(
    reference.compatibility_contract_version,
    "legacy_stale_parent_manifest_hash_v1",
  );
  assert.equal(reference.summary_identity_all_match, true);
  assert.deepEqual(
    reference.compatibility_summary_identity_fields,
    STALE_PARENT_SUMMARY_IDENTITY_FIELDS,
  );
  assert.deepEqual(
    reference.parent_summary_identity,
    reference.current_child_summary_identity,
  );
  assert.equal(reference.parent_manifest_key, fixture.connectorKey);
  assert.equal(
    reference.current_child_manifest_key,
    fixture.pollutantKeys.get("h3cch2chch32"),
  );
  assert.equal(
    unit.source_observation_content_hash_provenance,
    "derived_from_legacy_canonical_parquet",
  );
  const expectedUnitId = sha256Hex(stableMigrationJson({
    source_manifest: unit.source_manifest_identity,
    source_files: unit.source_files,
    source_observation_content_hash_metadata:
      unit.source_observation_content_hash_metadata,
    source_observation_content_hash_provenance:
      unit.source_observation_content_hash_provenance,
    source_manifest_reference: unit.source_manifest_reference,
    writer_limits: first.target.writer_limits,
    target_writer_git_sha: first.target_writer_git_sha,
    target_schema: first.target.history_schema_version,
    target_writer: first.target.writer_version,
    target_layout: first.target.physical_layout_version,
  }));
  assert.equal(unit.unit_id, expectedUnitId);
  const changedReference = structuredClone(unit.source_manifest_reference);
  changedReference.parent_summary_identity.total_bytes += 1;
  assert.notEqual(
    unit.unit_id,
    sha256Hex(stableMigrationJson({
      source_manifest: unit.source_manifest_identity,
      source_files: unit.source_files,
      source_observation_content_hash_metadata:
        unit.source_observation_content_hash_metadata,
      source_observation_content_hash_provenance:
        unit.source_observation_content_hash_provenance,
      source_manifest_reference: changedReference,
      writer_limits: first.target.writer_limits,
      target_writer_git_sha: first.target_writer_git_sha,
      target_schema: first.target.history_schema_version,
      target_writer: first.target.writer_version,
      target_layout: first.target.physical_layout_version,
    })),
  );
  const alternateFixture = await buildFixture({
    pollutantCodes: ["pm25", "h3cch2chch32"],
    manifestModes: {
      h3cch2chch32: "legacy_hashless_stale_parent",
    },
    staleParentHashes: { h3cch2chch32: "c".repeat(64) },
  });
  const alternate = await buildPlan(alternateFixture);
  assert.notEqual(first.plan_sha256, alternate.plan_sha256);
  assert.notEqual(
    unit.unit_id,
    alternate.units.find(
      (entry) => entry.scope.pollutant_code === "h3cch2chch32",
    ).unit_id,
  );
  const audit = buildObservationHistoryV3MigrationAuditReport({
    plan: first,
    mode: "plan",
  });
  assert.deepEqual(
    audit.source_manifest_reference_provenance_counts,
    first.source_manifest_reference_provenance_counts,
  );
  const partitionAudit = audit.partition_results.find(
    (entry) => entry.scope.pollutant_code === "h3cch2chch32",
  );
  assert.equal(
    partitionAudit.source_manifest_reference_provenance,
    reference.provenance,
  );
  assert.equal(
    partitionAudit.source_manifest_reference_compatibility_contract_version,
    "legacy_stale_parent_manifest_hash_v1",
  );
  assert.equal(
    partitionAudit.source_manifest_reference_summary_identity_all_match,
    true,
  );
  assert.deepEqual(
    partitionAudit.source_manifest_reference_summary_identity_fields,
    STALE_PARENT_SUMMARY_IDENTITY_FIELDS,
  );
  assert.deepEqual(
    partitionAudit.source_parent_summary_identity,
    reference.parent_summary_identity,
  );
  assert.deepEqual(
    partitionAudit.source_current_child_summary_identity,
    reference.current_child_summary_identity,
  );
});

test("Phase 6 requires every stale-parent summary field and rejects missing evidence", async () => {
  for (const field of STALE_PARENT_SUMMARY_IDENTITY_FIELDS) {
    const mismatchedValue = field === "pollutant_code"
      ? "wrong_property"
      : field === "manifest_key"
        ? `${PREFIX}/wrong-manifest.json`
        : field.includes("count") || field.includes("bytes") || field.includes("timeseries_id")
          ? 999_999_999
          : "1999-01-01T00:00:00.000Z";
    const fixture = await buildFixture({
      manifestModes: { pm25: "legacy_hashless_stale_parent" },
      parentReferenceOverrides: { pm25: { [field]: mismatchedValue } },
    });
    await assert.rejects(
      buildPlan(fixture),
      /(Observation connector\/pollutant identity mismatch|pollutant reference key mismatch|R2 object is missing)/,
    );
  }
  const missing = await buildFixture({
    manifestModes: { pm25: "legacy_hashless_stale_parent" },
    missingParentReferenceFields: { pm25: ["total_bytes"] },
  });
  await assert.rejects(
    buildPlan(missing),
    /Observation connector\/pollutant identity mismatch/,
  );
});

test("Phase 6 rejects wrong scope, invalid child integrity and modern stale references", async () => {
  const wrongScope = await buildFixture({
    manifestModes: { pm25: "legacy_hashless_stale_parent" },
  });
  const wrongScopeKey = wrongScope.pollutantKeys.get("pm25");
  const wrongScopeChild = JSON.parse(wrongScope.r2.get(wrongScopeKey));
  wrongScopeChild.day_utc = "2026-01-01";
  wrongScope.r2.set(wrongScopeKey, jsonBody(rehashManifest(wrongScopeChild)));
  await assert.rejects(
    buildPlan(wrongScope),
    /Canonical history manifest day_utc identity mismatch/,
  );

  const invalidChild = await buildFixture({
    manifestModes: { pm25: "legacy_hashless_stale_parent" },
  });
  const invalidChildKey = invalidChild.pollutantKeys.get("pm25");
  const invalidChildPayload = JSON.parse(invalidChild.r2.get(invalidChildKey));
  invalidChildPayload.row_count += 1;
  invalidChild.r2.set(invalidChildKey, jsonBody(invalidChildPayload));
  await assert.rejects(
    buildPlan(invalidChild),
    /Canonical history manifest hash verification failed/,
  );

  const modern = await buildFixture({
    manifestModes: { pm25: "modern_stale_parent" },
  });
  await assert.rejects(
    buildPlan(modern),
    /Observation connector\/pollutant identity mismatch/,
  );
});

test("Phase 6 rejects malformed and partial non-legacy hash contracts", async () => {
  for (const [mode, expected] of [
    ["malformed_hash", /observation_content_hash must be lower-case SHA-256/],
    ["partial_contract", /unsupported observation content hash algorithm/],
    [
      "malformed_hash_stale_parent",
      /Observation connector\/pollutant identity mismatch/,
    ],
    [
      "partial_contract_stale_parent",
      /Observation connector\/pollutant identity mismatch/,
    ],
  ]) {
    const fixture = await buildFixture({
      manifestModes: { pm25: mode },
    });
    await assert.rejects(buildPlan(fixture), expected);
  }
});

test("Phase 6 preparation re-verifies a pinned legacy-derived logical identity and writes modern metadata", async () => {
  const fixture = await buildFixture({
    manifestModes: { pm25: "legacy_hashless" },
  });
  const plan = await buildPlan(fixture);
  const tampered = structuredClone(plan);
  const tamperedPartition = tampered.inventory.partitions.find(
    (partition) => partition.scope.pollutant_code === "pm25",
  );
  tamperedPartition.source_observation_content_hash_metadata
    .observation_content_hash = "f".repeat(64);
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan: tampered,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters: memoryAdapters(fixture),
    }),
    /Canonical source logical identity mismatch/,
  );

  const completeFixture = await buildFixture({
    manifestModes: { pm25: "legacy_hashless" },
  });
  const completePlan = await buildPlan(completeFixture);
  const execution = await executeObservationHistoryV3MigrationPlan({
    plan: completePlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters: memoryAdapters(completeFixture),
  });
  assert.equal(execution.verification.cutover_ready, true);
  const completedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: execution.checkpoint,
    requirePrepared: true,
  });
  const legacyUnit = completedPlan.units.find(
    (unit) => unit.scope.pollutant_code === "pm25",
  );
  validateObservationContentHashMetadata(legacyUnit.target_manifest, {
    rowCount: legacyUnit.target_manifest.row_count,
  });
  assert.equal(
    legacyUnit.target_manifest.observation_content_hash,
    completePlan.units.find((unit) => unit.scope.pollutant_code === "pm25")
      .source_observation_content_hash,
  );
});

test("Phase 6 preparation rejects changed stale-reference parent, child, Parquet, logical identity or pinned proof before PUT", async () => {
  for (const changedEvidence of [
    "parent",
    "child",
    "parquet",
    "logical_identity",
    "pinned_proof",
  ]) {
    const fixture = await buildFixture({
      manifestModes: {
        pm25: "legacy_hashless_stale_parent",
      },
    });
    const plan = await buildPlan(fixture);
    const executionPlan = structuredClone(plan);
    if (changedEvidence === "parent") {
      const connector = JSON.parse(fixture.r2.get(fixture.connectorKey));
      connector.backed_up_at_utc = "2026-01-03T00:00:01.000Z";
      fixture.r2.set(fixture.connectorKey, jsonBody(rehashManifest(connector)));
    } else if (changedEvidence === "child") {
      const childKey = fixture.pollutantKeys.get("pm25");
      const child = JSON.parse(fixture.r2.get(childKey));
      child.timeseries_row_counts["999999"] = 1;
      fixture.r2.set(childKey, jsonBody(rehashManifest(child)));
    } else if (changedEvidence === "parquet") {
      const sourceKey = plan.units.find(
        (entry) => entry.scope.pollutant_code === "pm25",
      ).source_files[0].key;
      fixture.r2.set(
        sourceKey,
        Buffer.concat([fixture.r2.get(sourceKey), Buffer.from([0])]),
      );
    } else if (changedEvidence === "logical_identity") {
      const partition = executionPlan.inventory.partitions.find(
        (entry) => entry.scope.pollutant_code === "pm25",
      );
      partition.source_observation_content_hash_metadata
        .observation_content_hash = "f".repeat(64);
    } else {
      const partition = executionPlan.inventory.partitions.find(
        (entry) => entry.scope.pollutant_code === "pm25",
      );
      partition.source_manifest_reference
        .parent_summary_identity.total_bytes += 1;
    }
    const adapters = memoryAdapters(fixture);
    await assert.rejects(
      executeObservationHistoryV3MigrationPlan({
        plan: executionPlan,
        apply: true,
        writersFrozen: true,
        environmentEvidence: ENVIRONMENT,
        adapters,
      }),
      /(Pinned source (parent manifest identity|child manifest identity|manifest reference evidence|unit identity) changed|Canonical source logical identity mismatch|byte count mismatch)/,
    );
    assert.equal(adapters.putCalls, 0);
    assert.equal(adapters.stagedBodyCount, 0);
    assert.equal(adapters.checkpoints.length, 1);
  }
});

test("Phase 6 stale source rewrites a consistent target hierarchy and rollback restores exact stale bytes", async () => {
  const fixture = await buildFixture({
    pollutantCodes: ["pm25", "h3cch2chch32"],
    manifestModes: {
      h3cch2chch32: "legacy_hashless_stale_parent",
    },
  });
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture);
  const migration = await executeObservationHistoryV3MigrationPlan({
    plan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  assert.equal(migration.verification.cutover_ready, true);
  const completedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: migration.checkpoint,
    requirePrepared: true,
  });
  const unit = completedPlan.units.find(
    (entry) => entry.scope.pollutant_code === "h3cch2chch32",
  );
  const targetConnector = completedPlan.canonical_publication_objects.find(
    (object) => object.publication_stage === "connector_manifest",
  ).payload;
  const targetReference = targetConnector.pollutant_manifests.find(
    (entry) => entry.pollutant_code === "h3cch2chch32",
  );
  assert.equal(targetReference.manifest_hash, unit.target_manifest.manifest_hash);
  assert.notEqual(
    targetReference.manifest_hash,
    unit.source_manifest_reference.referenced_child_manifest_hash,
  );

  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint: migration.checkpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  const rollback = await executeObservationHistoryV2Rollback({
    restorePlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: { ...ENVIRONMENT, indexVersion: "v3" },
    adapters,
  });
  assert.equal(rollback.ok, true);
  for (const [key, expected] of fixture.oldCanonical) {
    assert.equal(Buffer.compare(fixture.r2.get(key), expected), 0, key);
  }
  const restoredConnector = JSON.parse(fixture.r2.get(fixture.connectorKey));
  const restoredChild = JSON.parse(
    fixture.r2.get(fixture.pollutantKeys.get("h3cch2chch32")),
  );
  assert.notEqual(
    restoredConnector.pollutant_manifests.find(
      (entry) => entry.pollutant_code === "h3cch2chch32",
    ).manifest_hash,
    restoredChild.manifest_hash,
  );
});

test("Phase 6 accepts and separately pins a canonical empty connector without creating a unit", async () => {
  const fixture = await buildFixture({ emptyConnector: {} });
  const first = await buildPlan(fixture);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.equal(first.inventory.connector_manifests.length, 2);
  assert.equal(first.inventory.partitions.length, 2);
  assert.equal(first.units.length, 2);
  assert.equal(first.empty_source_connector_count, 1);
  assert.equal(first.estimated.empty_source_connectors, 1);
  assert.ok(first.units.every((unit) => unit.scope.connector_id === 1));
  const empty = first.empty_source_connectors[0];
  assert.deepEqual(empty.scope, { day_utc: DAY, connector_id: 2 });
  assert.equal(empty.source_manifest_key, fixture.emptyConnectorKey);
  assert.equal(empty.source_manifest_identity.key, fixture.emptyConnectorKey);
  assert.equal(empty.classification, "canonical_empty_observation_connector");
  assert.equal(
    empty.contract_version,
    "canonical_empty_observation_connector_v1",
  );
  for (const field of EMPTY_CONNECTOR_ZERO_FIELDS) {
    assert.equal(empty.zero_state_evidence[field], 0, field);
  }
  for (const field of EMPTY_CONNECTOR_ARRAY_FIELDS) {
    assert.deepEqual(empty.zero_state_evidence[field], [], field);
  }
  for (const field of EMPTY_CONNECTOR_NULL_FIELDS) {
    assert.equal(empty.zero_state_evidence[field], null, field);
  }
  const changed = await buildFixture({
    emptyConnector: {
      overrides: { backed_up_at_utc: "2026-01-03T00:00:01.000Z" },
    },
  });
  const changedPlan = await buildPlan(changed);
  assert.notEqual(first.plan_sha256, changedPlan.plan_sha256);
  assert.notEqual(
    empty.source_manifest_identity.sha256,
    changedPlan.empty_source_connectors[0].source_manifest_identity.sha256,
  );
  const audit = buildObservationHistoryV3MigrationAuditReport({
    plan: first,
    mode: "plan",
  });
  assert.equal(audit.empty_source_connector_count, 1);
  assert.deepEqual(audit.empty_source_connectors[0].scope, empty.scope);
  assert.equal(
    audit.empty_source_connectors[0].contract_version,
    "canonical_empty_observation_connector_v1",
  );
});

test("Phase 6 rejects every inconsistent or malformed no-child connector zero state", async () => {
  for (const field of EMPTY_CONNECTOR_ZERO_FIELDS) {
    const overrides = field === "source_row_count"
      ? { source_row_count: 1, row_count: 1 }
      : { [field]: 1 };
    const fixture = await buildFixture({ emptyConnector: { overrides } });
    await assert.rejects(buildPlan(fixture));
  }
  for (const field of [
    "pollutant_codes",
    "child_manifests",
    "files",
    "parquet_object_keys",
  ]) {
    const fixture = await buildFixture({
      emptyConnector: { overrides: { [field]: [{ unexpected: true }] } },
    });
    await assert.rejects(buildPlan(fixture));
  }
  for (const field of EMPTY_CONNECTOR_NULL_FIELDS) {
    const fixture = await buildFixture({
      emptyConnector: { overrides: { [field]: "unexpected" } },
    });
    await assert.rejects(buildPlan(fixture));
  }
  for (const value of ["", "pm25"]) {
    const fixture = await buildFixture({
      emptyConnector: { overrides: { pollutant_code: value } },
    });
    await assert.rejects(buildPlan(fixture));
  }
  for (const value of [{}, { 123: 1 }]) {
    const fixture = await buildFixture({
      emptyConnector: { overrides: { timeseries_row_counts: value } },
    });
    await assert.rejects(buildPlan(fixture));
  }
  const nullStatistic = await buildFixture({
    emptyConnector: { overrides: { bytes_per_row_estimate: null } },
  });
  await assert.rejects(buildPlan(nullStatistic));
  for (const field of [
    ...EMPTY_CONNECTOR_ZERO_FIELDS,
    ...EMPTY_CONNECTOR_ARRAY_FIELDS,
    ...EMPTY_CONNECTOR_NULL_FIELDS,
  ]) {
    const fixture = await buildFixture({
      emptyConnector: { missingFields: [field] },
    });
    await assert.rejects(buildPlan(fixture));
  }
  const invalidHash = await buildFixture({
    emptyConnector: { invalidManifestHash: true },
  });
  await assert.rejects(
    buildPlan(invalidHash),
    /Canonical history manifest hash verification failed/,
  );
  for (const overrides of [
    { day_utc: "2026-01-01" },
    { connector_id: 999 },
  ]) {
    const fixture = await buildFixture({ emptyConnector: { overrides } });
    await assert.rejects(
      buildPlan(fixture),
      /Canonical history manifest (day_utc|connector_id) identity mismatch/,
    );
  }
  const dayMismatch = await buildFixture({
    emptyConnector: { dayReferenceHash: "d".repeat(64) },
  });
  await assert.rejects(
    buildPlan(dayMismatch),
    /Observation day\/connector identity mismatch/,
  );
});

test("Phase 6 rebuilds, orders and exactly rolls back a canonical empty connector", async () => {
  const fixture = await buildFixture({ emptyConnector: {} });
  const sourceEmptyBody = Buffer.from(fixture.r2.get(fixture.emptyConnectorKey));
  const sourceEmpty = JSON.parse(sourceEmptyBody);
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture);
  const migration = await executeObservationHistoryV3MigrationPlan({
    plan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  assert.equal(migration.verification.cutover_ready, true);
  const completed = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: migration.checkpoint,
    requirePrepared: true,
  });
  assert.ok(completed.units.every((unit) => unit.scope.connector_id === 1));
  const targetEmptyObject = completed.canonical_publication_objects.find(
    (object) =>
      object.publication_stage === "connector_manifest" &&
      object.payload.connector_id === 2,
  );
  assert.ok(targetEmptyObject);
  assert.deepEqual(targetEmptyObject.dependencies, []);
  const expectedTargetEmpty = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 2,
    runId: null,
    manifestKey: fixture.emptyConnectorKey,
    pollutantManifests: [],
    writerGitSha: "a".repeat(40),
    backedUpAtUtc: sourceEmpty.backed_up_at_utc,
  });
  assert.deepEqual(targetEmptyObject.payload, expectedTargetEmpty);
  for (const field of EMPTY_CONNECTOR_ZERO_FIELDS) {
    assert.equal(targetEmptyObject.payload[field], 0, field);
  }
  for (const field of EMPTY_CONNECTOR_NULL_FIELDS) {
    assert.equal(targetEmptyObject.payload[field], null, field);
  }
  for (const field of EMPTY_CONNECTOR_ARRAY_FIELDS) {
    assert.deepEqual(targetEmptyObject.payload[field], [], field);
  }
  assert.equal(
    targetEmptyObject.payload.history_schema_version,
    completed.target.history_schema_version,
  );
  assert.equal(
    targetEmptyObject.payload.writer_version,
    completed.target.writer_version,
  );
  validateCanonicalHistoryV2Manifest(targetEmptyObject.payload, {
    domain: "observations",
    manifest_kind: "connector",
    day_utc: DAY,
    connector_id: 2,
    manifest_key: fixture.emptyConnectorKey,
  });
  const targetDayObject = completed.canonical_publication_objects.find(
    (object) => object.publication_stage === "day_manifest",
  );
  const targetDayReference = targetDayObject.payload.connector_manifests.find(
    (entry) => entry.connector_id === 2,
  );
  assert.equal(
    targetDayReference.manifest_hash,
    targetEmptyObject.payload.manifest_hash,
  );
  assert.ok(targetDayObject.dependencies.some(
    (entry) => entry.key === fixture.emptyConnectorKey,
  ));
  const emptyPosition = completed.canonical_publication_objects.findIndex(
    (object) => object.key === fixture.emptyConnectorKey,
  );
  const dayPosition = completed.canonical_publication_objects.findIndex(
    (object) => object.key === targetDayObject.key,
  );
  assert.ok(emptyPosition >= 0 && emptyPosition < dayPosition);
  const targetParquetObjects = completed.units.flatMap(
    (unit) => unit.target_file_intents,
  );
  assert.equal(
    completed.estimated.new_parquet_objects,
    targetParquetObjects.length,
  );
  assert.ok(targetParquetObjects.every(
    (entry) => !entry.key.includes("connector_id=2/"),
  ));
  assert.ok(completed.canonical_publication_objects.every(
    (entry) => !entry.key.includes("connector_id=2/pollutant_code="),
  ));
  assert.equal(completed.estimated.v3_scopes, 2);

  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint: migration.checkpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  assert.ok(restorePlan.objects.some(
    (entry) => entry.key === fixture.emptyConnectorKey,
  ));
  assert.equal(restorePlan.objects.filter(
    (entry) => entry.key.includes("connector_id=2/pollutant_code="),
  ).length, 0);
  const rollback = await executeObservationHistoryV2Rollback({
    restorePlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: { ...ENVIRONMENT, indexVersion: "v3" },
    adapters,
  });
  assert.equal(rollback.ok, true);
  assert.equal(
    Buffer.compare(fixture.r2.get(fixture.emptyConnectorKey), sourceEmptyBody),
    0,
  );
});

test("Phase 6 empty-connector preparation rejects source drift before PUT", async () => {
  const fixture = await buildFixture({ emptyConnector: {} });
  const plan = await buildPlan(fixture);
  const changed = JSON.parse(fixture.r2.get(fixture.emptyConnectorKey));
  changed.backed_up_at_utc = "2026-01-03T00:00:01.000Z";
  fixture.r2.set(fixture.emptyConnectorKey, jsonBody(rehashManifest(changed)));
  const adapters = memoryAdapters(fixture);
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /Pinned empty source connector identity changed/,
  );
  assert.equal(adapters.putCalls, 0);
  assert.equal(adapters.stagedBodyCount, 0);
  assert.equal(adapters.checkpoints.length, 1);
});

test("Phase 6 empty-connector preparation rejects newly pinned zero-state drift before PUT", async () => {
  for (const [field, value] of [
    ["pollutant_code", "pm25"],
    ["timeseries_row_counts", {}],
    ["bytes_per_row_estimate", 1],
    ["avg_file_bytes", 1],
    ["min_file_bytes", 1],
    ["max_file_bytes", 1],
  ]) {
    const fixture = await buildFixture({ emptyConnector: {} });
    const plan = await buildPlan(fixture);
    const changed = JSON.parse(fixture.r2.get(fixture.emptyConnectorKey));
    changed[field] = value;
    fixture.r2.set(fixture.emptyConnectorKey, jsonBody(rehashManifest(changed)));
    const adapters = memoryAdapters(fixture);
    await assert.rejects(
      executeObservationHistoryV3MigrationPlan({
        plan,
        apply: true,
        writersFrozen: true,
        environmentEvidence: ENVIRONMENT,
        adapters,
      }),
      /Pinned empty source connector identity changed/,
    );
    assert.equal(adapters.putCalls, 0, field);
    assert.equal(adapters.stagedBodyCount, 0, field);
    assert.equal(adapters.checkpoints.length, 1, field);
  }
});

test("Phase 4 planner is deterministic, backup-gated and retains no target archive bodies", async () => {
  const fixture = await buildFixture();
  const first = await buildPlan(fixture);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.equal(first.units.length, 2);
  assert.deepEqual(first.units[0].scope, {
    day_utc: DAY,
    connector_id: 1,
    pollutant_code: "pm10",
  });
  assert.equal(first.units[0].target_metadata, undefined);
  assert.equal(first.canonical_publication_objects.length, 0);
  assert.equal(first.v3_publication_plan, null);
  assert.equal(first.estimated.new_parquet_objects, null);
  assert.ok(first.units.every((unit) =>
    unit.source_files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))
  ));
  assert.ok(first.rollback_preflight.objects.every((entry) => entry.body === undefined));
  assert.equal(first.backup_gate.verified, true);
  assert.deepEqual(
    first.writer_freeze_plan.entries.map((entry) => entry.id),
    [
      "prune_daily_phase_b",
      "write_enabled_integrity",
      "sos_historical_replacement",
      "supported_observation_backfill",
      "manual_observation_repair_and_migration",
    ],
  );
  const blocked = await buildPlan(fixture, {
    expectedStateRootSha256: "f".repeat(64),
  });
  assert.equal(blocked.mutation_allowed, false);
  assert.ok(blocked.blockers.some((entry) => entry.startsWith("verified_dropbox_checkpoint_missing:")));
});

test("Phase 4 persists immutable authority before the first PUT and preserves apply guards", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const dryRun = await executeObservationHistoryV3MigrationPlan({
    plan,
    apply: false,
    adapters: new Proxy({}, { get: () => { throw new Error("mutation adapter used"); } }),
  });
  assert.equal(dryRun.mutation_calls, 0);
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: false,
      environmentEvidence: ENVIRONMENT,
      adapters: {},
    }),
    /writers are frozen/,
  );
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: { ...ENVIRONMENT, bucket: "wrong" },
      adapters: {},
    }),
    /environment guard failed/,
  );
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: { ...ENVIRONMENT, indexVersion: "v3" },
      adapters: {},
    }),
    /deployed_observation_index_must_remain_v2/,
  );
  const checkpointFailure = memoryAdapters(fixture, { failCheckpointCall: 1 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters: checkpointFailure,
    }),
    /deliberate checkpoint failure/,
  );
  assert.equal(checkpointFailure.putCalls, 0);
  assert.equal(checkpointFailure.stagedBodyCount, 0);

  const missingShaAdapters = memoryAdapters(fixture);
  missingShaAdapters.headObject = async ({ key }) => fixture.r2.has(key)
    ? { exists: true, bytes: fixture.r2.get(key).byteLength, sha256: null }
    : { exists: false };
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters: missingShaAdapters,
    }),
    /stored R2 SHA-256/,
  );
});

test("Phase 4 multi-partition apply is bounded, exact and byte-identical on rerun", async () => {
  const fresh = await buildFixture();
  const freshPlan = await buildPlan(fresh);
  const adapters = memoryAdapters(fresh);
  const execution = await executeObservationHistoryV3MigrationPlan({
    plan: freshPlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  assert.equal(execution.verification.cutover_ready, true);
  assert.equal(execution.checkpoint.full_verification_complete, true);
  assert.ok(adapters.checkpoints.length > 0);
  assert.equal(adapters.maxStagedUnits, 1);
  assert.equal(adapters.maxStagedBodies, 1);
  assert.equal(adapters.stagedBodyCount, 0);
  assert.equal(execution.checkpoint.preparation_order.length, 2);
  assert.ok(Object.values(execution.checkpoint.prepared_units).every((unit) =>
    unit.target_file_intents.every((intent) => intent.staging_ref === undefined)
  ));
  const missingCanonicalEvidence = structuredClone(execution.checkpoint);
  delete missingCanonicalEvidence.completed_objects[
    buildObservationHistoryV3MigrationPlanFromCheckpoint({
      checkpoint: execution.checkpoint,
      requirePrepared: true,
    }).canonical_publication_objects[0].key
  ];
  assert.throws(
    () => buildObservationHistoryV3RerunVerificationPlan({
      checkpoint: missingCanonicalEvidence,
    }),
    /exact durable completed-object evidence/,
  );
  const rerunPlan = buildObservationHistoryV3RerunVerificationPlan({
    checkpoint: execution.checkpoint,
  });
  const rerun = await verifyObservationHistoryV3MigrationResult({
    plan: rerunPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  assert.equal(rerun.cutover_ready, true);
  for (const unit of rerunPlan.units) {
    assert.equal(unit.source_row_count, unit.target_metadata.row_count);
    assert.equal(
      unit.source_observation_content_hash,
      unit.target_metadata.observation_content_hash,
    );
    assert.deepEqual(
      unit.source_verification_status_counts,
      unit.target_metadata.verification_status_counts,
    );
  }
  const beforeRerun = new Map(
    [...fresh.r2].map(([key, body]) => [key, Buffer.from(body)]),
  );
  const checksumPutsBeforeRerun = adapters.putCalls;
  const pinnedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: execution.checkpoint,
  });
  const noOp = await executeObservationHistoryV3MigrationPlan({
    plan: pinnedPlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    checkpoint: execution.checkpoint,
    adapters,
  });
  assert.equal(noOp.verification.cutover_ready, true);
  assert.equal(adapters.putCalls, checksumPutsBeforeRerun);
  assert.deepEqual([...fresh.r2.keys()].sort(), [...beforeRerun.keys()].sort());
  for (const [key, expected] of beforeRerun) {
    assert.equal(Buffer.compare(fresh.r2.get(key), expected), 0, key);
  }

  fresh.r2.delete(rerunPlan.v3_latest.key);
  const incomplete = await verifyObservationHistoryV3MigrationResult({
    plan: rerunPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true },
  });
  assert.equal(incomplete.cutover_ready, false);
  assert.ok(incomplete.blockers.some((entry) => entry.includes("v3_latest")));
  fresh.r2.set(rerunPlan.v3_latest.key, Buffer.from(rerunPlan.v3_latest.body));
  const child = rerunPlan.units[0].v3_hierarchy.child_shards[0];
  fresh.r2.set(child.key, Buffer.from(`${child.body} `));
  const mismatched = await verifyObservationHistoryV3MigrationResult({
    plan: rerunPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true },
  });
  assert.equal(mismatched.cutover_ready, false);
  assert.ok(mismatched.blockers.some((entry) =>
    entry.startsWith("scoped_root_child_authority_mismatch:")
  ));
});

test("current dependency verification admits only explicit v2 or v3 observation authority", () => {
  for (const indexVersion of ["v2", "v3"]) {
    const result = validateObservationHistoryV3MigrationEnvironment({
      ...ENVIRONMENT,
      indexVersion,
      operation: "verification",
    });
    assert.equal(result.ok, true);
  }
  const invalid = validateObservationHistoryV3MigrationEnvironment({
    ...ENVIRONMENT,
    indexVersion: "v4",
    operation: "verification",
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.blockers, ["verification_observation_index_must_be_v2_or_v3"]);
});

test("Phase 4 resumes after an early PUT failure without rereading overwritten source", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 2/,
  );
  const interrupted = adapters.checkpoints.at(-1);
  assert.equal(interrupted.preparation_order.length, 2);
  assert.equal(Object.keys(interrupted.completed_objects).filter((key) =>
    key.endsWith(".parquet")
  ).length, 1);
  const sourceKeys = new Set(plan.units.flatMap((unit) =>
    unit.source_files.map((file) => file.key)
  ));
  let sourceReadsDuringResume = 0;
  const originalGetObject = adapters.getObject;
  adapters.getObject = async ({ key }) => {
    if (sourceKeys.has(key)) sourceReadsDuringResume += 1;
    return originalGetObject({ key });
  };
  const resumed = await executeObservationHistoryV3MigrationPlan({
    plan: buildObservationHistoryV3MigrationPlanFromCheckpoint({
      checkpoint: interrupted,
    }),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    checkpoint: interrupted,
    adapters,
  });
  assert.equal(resumed.verification.cutover_ready, true);
  assert.equal(sourceReadsDuringResume, 0);
  assert.equal(adapters.putCalls, 3);
});

test("prepared canonical manifest exact bytes survive stable recovery serialization", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 2/,
  );
  const preparedCheckpoint = adapters.checkpoints.at(-1);
  const beforeRecovery = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: preparedCheckpoint,
    requirePrepared: true,
  });
  const recoveredCheckpoint = JSON.parse(stableMigrationJson(preparedCheckpoint));
  const afterRecovery = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: recoveredCheckpoint,
    requirePrepared: true,
  });
  assert.equal(
    afterRecovery.units[0].target_manifest_object.sha256,
    beforeRecovery.units[0].target_manifest_object.sha256,
  );
  assert.equal(
    Buffer.compare(
      afterRecovery.units[0].target_manifest_object.body,
      beforeRecovery.units[0].target_manifest_object.body,
    ),
    0,
  );
});

test("recovery persistence rejects changed evidence for an already completed key", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 2/,
  );
  const originalCheckpoint = structuredClone(adapters.checkpoints.at(-1));
  const completedKey = Object.keys(originalCheckpoint.completed_objects)[0];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-evidence-"));
  try {
    const checkpointPath = path.join(temporaryRoot, "migration_checkpoint.json");
    fs.writeFileSync(checkpointPath, stableMigrationJson(originalCheckpoint), { mode: 0o600 });
    const context = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath,
      checkpoint: originalCheckpoint,
      repositoryRoot: REPOSITORY_ROOT,
      create: true,
    });
    const changed = structuredClone(context.checkpoint);
    changed.completed_objects[completedKey] = {
      ...changed.completed_objects[completedKey],
      sha256: "f".repeat(64),
    };
    await assert.rejects(
      context.persistCheckpoint(changed),
      new RegExp(`Completed-object evidence changed.*${completedKey}`),
    );
    const changedSize = structuredClone(context.checkpoint);
    changedSize.completed_objects[completedKey].byte_size += 1;
    await assert.rejects(
      context.persistCheckpoint(changedSize),
      new RegExp(`Completed-object evidence changed.*${completedKey}`),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("legacy recovery ordering reconciles complete dependency closure without semantic fallback", async () => {
  const legacy = await buildLegacyRecoveryOrderingFixture();
  const result = await verifyObservationHistoryV3CurrentDependencies({
    plan: legacy.verificationPlan,
    checkpoint: legacy.checkpoint,
    getObject: legacy.adapters.getObject,
    headObject: legacy.adapters.headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovery_reconciliation.counts.fail, 0);
  assert.equal(
    result.recovery_reconciliation.counts.total,
    Object.keys(legacy.checkpoint.completed_objects).length,
  );
  assert.ok(result.recovery_reconciliation.counts.exact > 0);
  assert.ok(result.recovery_reconciliation.counts.legacy_recovery_ordering > 0);
  const legacyKeys = result.recovery_reconciliation.classifications
    .filter((entry) => entry.classification === "LEGACY_RECOVERY_ORDERING")
    .map((entry) => entry.key);
  assert.ok(legacyKeys.some((key) => key.includes("/connector_id=")));
  assert.ok(legacyKeys.some((key) => key.includes("/_manifests/")));
  assert.ok(legacyKeys.some((key) => key.includes("/_index_v3/")));
});

test("legacy recovery ordering requires authenticated recovery authority", async () => {
  const legacy = await buildLegacyRecoveryOrderingFixture();
  assert.throws(
    () => buildObservationHistoryV3RerunVerificationPlan({
      checkpoint: legacy.checkpoint,
      allowLegacyRecoveryOrdering: true,
      recoveryAuthority: null,
    }),
    /recovery_evidence_invalid:authenticated recovery journal is required/,
  );
  const live = structuredClone(legacy.checkpoint);
  live.authority.environment.environment = "LIVE";
  assert.throws(
    () => buildObservationHistoryV3RerunVerificationPlan({
      checkpoint: live,
      allowLegacyRecoveryOrdering: true,
      recoveryAuthority: authenticatedRecoveryAuthority(live),
    }),
    /recovery_evidence_invalid:legacy recovery ordering is TEST-only/,
  );
});

test("unaffected completed migration classifies every dependency EXACT", async () => {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture);
  const execution = await executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  const verificationPlan = buildObservationHistoryV3RerunVerificationPlan({
    checkpoint: execution.checkpoint,
  });
  const result = await verifyObservationHistoryV3CurrentDependencies({
    plan: verificationPlan,
    checkpoint: execution.checkpoint,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recovery_reconciliation.counts, {
    total: Object.keys(execution.checkpoint.completed_objects).length,
    exact: Object.keys(execution.checkpoint.completed_objects).length,
    legacy_recovery_ordering: 0,
    fail: 0,
  });
  assert.equal(result.failure_category, null);
});

test("legacy recovery ordering never permits binary evidence fallback", async () => {
  const legacy = await buildLegacyRecoveryOrderingFixture();
  const parquetKey = Object.keys(legacy.checkpoint.completed_objects)
    .find((key) => key.endsWith(".parquet"));
  legacy.checkpoint.completed_objects[parquetKey].sha256 = "f".repeat(64);
  assert.throws(
    () => buildObservationHistoryV3RerunVerificationPlan({
      checkpoint: legacy.checkpoint,
      allowLegacyRecoveryOrdering: true,
      recoveryAuthority: authenticatedRecoveryAuthority(legacy.checkpoint),
    }),
    new RegExp(`recovery_evidence_invalid:.*${parquetKey}`),
  );
});

test("legacy recovery ordering rejects arbitrary semantically equal R2 JSON", async () => {
  const legacy = await buildLegacyRecoveryOrderingFixture();
  const key = legacy.verificationPlan.canonical_publication_objects[0].key;
  const payload = JSON.parse(legacy.fixture.r2.get(key));
  legacy.fixture.r2.set(key, Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
  const result = await verifyObservationHistoryV3CurrentDependencies({
    plan: legacy.verificationPlan,
    checkpoint: legacy.checkpoint,
    getObject: legacy.adapters.getObject,
    headObject: legacy.adapters.headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((entry) =>
    entry === `legacy_reconciliation_failed:${key}` ||
    entry.startsWith(`canonical_manifest_identity_mismatch:${key}:`)
  ));
});

test("legacy recovery ordering fails semantic, manifest-hash and Parquet-reference drift", async (t) => {
  for (const [name, mutate] of [
    ["semantic JSON", (payload) => { payload.row_count += 1; }],
    ["manifest_hash", (payload) => { payload.manifest_hash = "f".repeat(64); }],
    ["referenced Parquet", (payload) => { payload.files[0].etag_or_hash = "f".repeat(64); }],
  ]) {
    await t.test(name, async () => {
      const legacy = await buildLegacyRecoveryOrderingFixture();
      const object = legacy.verificationPlan.canonical_publication_objects.find(
        (entry) => entry.publication_stage === "pollutant_manifest",
      );
      const payload = JSON.parse(legacy.fixture.r2.get(object.key));
      mutate(payload);
      legacy.fixture.r2.set(object.key, jsonBody(payload));
      const result = await verifyObservationHistoryV3CurrentDependencies({
        plan: legacy.verificationPlan,
        checkpoint: legacy.checkpoint,
        getObject: legacy.adapters.getObject,
        headObject: legacy.adapters.headObject,
        publicationResult: { ok: true, checkpoint_evidence: true },
      });
      assert.equal(result.ok, false);
      assert.equal(result.failure_category, "legacy_reconciliation_failed");
      assert.ok(result.recovery_reconciliation.counts.fail > 0);
    });
  }
});

test("prepared canonical body byte size, SHA, JSON and semantics are fail-closed", async (t) => {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  }), /deliberate PUT failure 2/);
  const checkpoint = adapters.checkpoints.at(-1);
  const unitId = checkpoint.preparation_order[0];
  for (const [name, mutate, pattern] of [
    ["byte size", (record) => { record.target_manifest_byte_size += 1; }, /target_manifest_exact_identity_mismatch/],
    ["SHA", (record) => { record.target_manifest_sha256 = "f".repeat(64); }, /target_manifest_exact_identity_mismatch/],
    ["JSON", (record) => {
      record.target_manifest_body = "{";
      record.target_manifest_byte_size = 1;
      record.target_manifest_sha256 = sha256Hex("{");
    }, /target_manifest_body_invalid_json/],
    ["semantics", (record) => {
      const payload = JSON.parse(record.target_manifest_body);
      payload.source_row_count += 1;
      record.target_manifest_body = JSON.stringify(payload, null, 2);
      record.target_manifest_byte_size = Buffer.byteLength(record.target_manifest_body);
      record.target_manifest_sha256 = sha256Hex(record.target_manifest_body);
    }, /target_manifest_semantic_mismatch/],
  ]) {
    await t.test(name, () => {
      const changed = structuredClone(checkpoint);
      mutate(changed.prepared_units[unitId]);
      assert.throws(
        () => buildObservationHistoryV3MigrationPlanFromCheckpoint({
          checkpoint: changed,
          requirePrepared: true,
        }),
        pattern,
      );
    });
  }
});

test("prepared plan SHA binds exact canonical body identity and key ordering", async () => {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  }), /deliberate PUT failure 2/);
  const changed = structuredClone(adapters.checkpoints.at(-1));
  const record = changed.prepared_units[changed.preparation_order[0]];
  record.target_manifest_body = stableMigrationJson(record.target_manifest);
  record.target_manifest_byte_size = Buffer.byteLength(record.target_manifest_body);
  record.target_manifest_sha256 = sha256Hex(record.target_manifest_body);
  assert.throws(
    () => buildObservationHistoryV3MigrationPlanFromCheckpoint({
      checkpoint: changed,
      requirePrepared: true,
    }),
    /prepared_plan_sha256_mismatch/,
  );
});

test("identical completed evidence is a recovery journal no-op", async () => {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  }), /deliberate PUT failure 2/);
  const checkpoint = structuredClone(adapters.checkpoints.at(-1));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-noop-"));
  try {
    const checkpointPath = path.join(temporaryRoot, "migration_checkpoint.json");
    fs.writeFileSync(checkpointPath, stableMigrationJson(checkpoint), { mode: 0o600 });
    const context = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath,
      checkpoint,
      repositoryRoot: REPOSITORY_ROOT,
      create: true,
    });
    await context.persistCheckpoint(structuredClone(context.checkpoint));
    assert.equal(context.sequence, 0);
    assert.deepEqual(fs.readdirSync(context.paths.entries), []);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("authenticated recovery replay rejects a later changed completion identity", async () => {
  const fixture = await buildFixture();
  const adapters = memoryAdapters(fixture, { failPutCall: 1 });
  await assert.rejects(executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(fixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  }), /deliberate PUT failure 1/);
  const checkpoint = structuredClone(adapters.checkpoints.at(-1));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-v3-replay-"));
  try {
    const checkpointPath = path.join(temporaryRoot, "migration_checkpoint.json");
    fs.writeFileSync(checkpointPath, stableMigrationJson(checkpoint), { mode: 0o600 });
    const context = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath,
      checkpoint,
      repositoryRoot: REPOSITORY_ROOT,
      create: true,
    });
    const key = "history/_index_v3/observations_timeseries/fixture.json";
    const first = structuredClone(context.checkpoint);
    first.completed_objects[key] = {
      byte_size: 10,
      sha256: "a".repeat(64),
      verified: true,
      durable: true,
      stored_sha256_verified: false,
    };
    await context.persistCheckpoint(first);
    const entryOne = JSON.parse(fs.readFileSync(
      path.join(context.paths.entries, "0000000001.json"),
      "utf8",
    ));
    const payload = {
      sequence: 2,
      previous_entry_sha256: entryOne.payload_sha256,
      original_checkpoint_sha256: context.manifest.payload.original_checkpoint.sha256,
      immutable_authority_sha256: context.manifest.payload.immutable_authority_sha256,
      updates: {
        completed_objects: [{
          key,
          evidence: {
            ...first.completed_objects[key],
            sha256: "b".repeat(64),
          },
        }],
      },
    };
    const entryTwo = {
      schema_version: 1,
      kind: "uk_aq_observation_history_v3_recovery_entry",
      payload,
      payload_sha256: sha256Hex(stableMigrationJson(payload)),
    };
    fs.writeFileSync(
      path.join(context.paths.entries, "0000000002.json"),
      stableMigrationJson(entryTwo),
      { mode: 0o600 },
    );
    const headPayload = {
      original_checkpoint_sha256: context.manifest.payload.original_checkpoint.sha256,
      immutable_authority_sha256: context.manifest.payload.immutable_authority_sha256,
      last_sequence: 2,
      last_entry_sha256: entryTwo.payload_sha256,
    };
    fs.writeFileSync(context.paths.head, stableMigrationJson({
      schema_version: 1,
      kind: "uk_aq_observation_history_v3_recovery_head",
      payload: headPayload,
      payload_sha256: sha256Hex(stableMigrationJson(headPayload)),
    }), { mode: 0o600 });
    assert.throws(
      () => buildObservationHistoryV3RecoveryProgressContext({
        checkpointPath,
        checkpoint,
        repositoryRoot: REPOSITORY_ROOT,
      }),
      new RegExp(`Recovery completed-object evidence changed.*${key}`),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("local interruption seams resume after each durable migration boundary", async (t) => {
  for (const hookName of [
    "afterPreparation",
    "afterParquetPublication",
    "afterCanonicalManifestPublication",
    "afterParentPublication",
    "afterV3Finalization",
  ]) {
    await t.test(hookName, async () => {
      const fixture = await buildFixture();
      const adapters = memoryAdapters(fixture);
      let interrupted = false;
      await assert.rejects(
        executeObservationHistoryV3MigrationPlan({
          plan: await buildPlan(fixture),
          apply: true,
          writersFrozen: true,
          environmentEvidence: ENVIRONMENT,
          adapters,
          testHooks: {
            [hookName]: async () => {
              if (interrupted) return;
              interrupted = true;
              throw new Error(`fixture interruption ${hookName}`);
            },
          },
        }),
        new RegExp(`fixture interruption ${hookName}`),
      );
      const checkpoint = adapters.checkpoints.at(-1);
      const resumed = await executeObservationHistoryV3MigrationPlan({
        plan: buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint }),
        apply: true,
        writersFrozen: true,
        environmentEvidence: ENVIRONMENT,
        checkpoint,
        adapters,
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.verification.cutover_ready, true);
      assert.equal(resumed.checkpoint.full_verification_complete, true);
    });
  }
});

test("interrupted resume is byte-identical to uninterrupted and reuses published canonical JSON", async () => {
  const uninterruptedFixture = await buildFixture();
  const uninterruptedAdapters = memoryAdapters(uninterruptedFixture);
  const uninterrupted = await executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(uninterruptedFixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters: uninterruptedAdapters,
  });
  const resumedFixture = await buildFixture();
  const resumedAdapters = memoryAdapters(resumedFixture);
  let stopped = false;
  await assert.rejects(executeObservationHistoryV3MigrationPlan({
    plan: await buildPlan(resumedFixture),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters: resumedAdapters,
    testHooks: {
      afterCanonicalManifestPublication: async () => {
        if (stopped) return;
        stopped = true;
        throw new Error("fixture canonical stop");
      },
    },
  }), /fixture canonical stop/);
  assert.equal(resumedAdapters.jsonPutCalls, 1);
  const checkpoint = resumedAdapters.checkpoints.at(-1);
  const resumed = await executeObservationHistoryV3MigrationPlan({
    plan: buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint }),
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    checkpoint,
    adapters: resumedAdapters,
  });
  const uninterruptedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: uninterrupted.checkpoint,
    requirePrepared: true,
  });
  const resumedPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
    checkpoint: resumed.checkpoint,
    requirePrepared: true,
  });
  assert.deepEqual(
    planJsonObjects(resumedPlan).map(({ key, byte_size, sha256 }) => ({ key, byte_size, sha256 })),
    planJsonObjects(uninterruptedPlan).map(({ key, byte_size, sha256 }) => ({ key, byte_size, sha256 })),
  );
  assert.equal(resumedAdapters.jsonPutCalls, resumedPlan.canonical_publication_objects.length);
  assert.equal(resumed.verification.cutover_ready, true);
});

test("Phase 4 checkpoint reuse requires exact current stored identity", async () => {
  const expected = {
    key: "history/v2/observations/fixture.parquet",
    byte_size: 7,
    sha256: sha256Hex("fixture"),
  };
  const checkpointEntry = {
    byte_size: expected.byte_size,
    sha256: expected.sha256,
    verified: true,
    durable: true,
  };
  let suppliedPutSha256 = null;
  const publication = await putAndVerifyR2ObjectWithSha256({
    r2: { adapter: {} },
    intent: { key: expected.key, body: Buffer.from("fixture") },
    putObject: async ({ sha256 }) => {
      suppliedPutSha256 = sha256;
      return { ok: true };
    },
    headObject: async () => ({
      exists: true,
      bytes: expected.byte_size,
      sha256: expected.sha256,
    }),
  });
  assert.equal(suppliedPutSha256, expected.sha256);
  assert.equal(publication.stored_sha256_verified, true);
  const reusable = await verifyObservationHistoryV3CheckpointReuse({
    checkpointEntry,
    expected,
    requireStoredSha256: true,
    headObject: async () => ({
      exists: true,
      bytes: expected.byte_size,
      sha256: expected.sha256,
    }),
  });
  assert.equal(reusable.reusable, true);
  const stale = await verifyObservationHistoryV3CheckpointReuse({
    checkpointEntry,
    expected,
    requireStoredSha256: true,
    headObject: async () => ({
      exists: true,
      bytes: expected.byte_size,
      sha256: "0".repeat(64),
    }),
  });
  assert.equal(stale.reusable, false);
});

test("Phase 4 rollback restores from the checkpoint after partial migration with index v3", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 2 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 2/,
  );
  const checkpoint = adapters.checkpoints.at(-1);
  const overwrittenKey = plan.units[0].source_files[0].key;
  assert.notEqual(
    sha256Hex(fixture.r2.get(overwrittenKey)),
    sha256Hex(fixture.oldCanonical.get(overwrittenKey)),
  );
  assert.equal(
    sha256Hex(fixture.r2.get(plan.inventory.root_manifest.key)),
    plan.inventory.root_manifest.sha256,
  );
  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  assert.equal(restorePlan.ready, true);
  assert.ok(restorePlan.objects.some((entry) => entry.stage === "canonical_parquet"));
  assert.ok(restorePlan.objects.some((entry) => entry.stage === "root_manifest"));
  assert.equal(restorePlan.v2_index_strategy.mode, "rebuild");
  const rollback = await executeObservationHistoryV2Rollback({
    restorePlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: { ...ENVIRONMENT, indexVersion: "v3" },
    adapters,
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.observed_starting_index_version, "v3");
  assert.equal(adapters.rebuildCalls, 1);
  for (const [key, expected] of fixture.oldCanonical) {
    assert.equal(Buffer.compare(fixture.r2.get(key), expected), 0, key);
  }
  assert.equal(rollback.configuration_changed, false);
  assert.equal(rollback.scheduler_changed, false);
  assert.equal(rollback.deployment_changed, false);
});

test("Phase 4 rollback restores from the same checkpoint after completed migration", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, {
    rebuildWarning: "Retained byte-identical existing index objects",
  });
  const migration = await executeObservationHistoryV3MigrationPlan({
    plan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  assert.equal(migration.verification.cutover_ready, true);
  assert.notEqual(
    sha256Hex(fixture.r2.get(plan.inventory.root_manifest.key)),
    plan.inventory.root_manifest.sha256,
  );
  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint: migration.checkpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  const rollback = await executeObservationHistoryV2Rollback({
    restorePlan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters,
  });
  assert.equal(rollback.ok, true);
  assert.equal(adapters.rebuildCalls, 1);
  assert.equal(rollback.v2_index_rebuild.warning_count, 1);
  assert.equal(rollback.v2_index_completeness.complete, true);
  for (const [key, expected] of fixture.oldCanonical) {
    assert.equal(Buffer.compare(fixture.r2.get(key), expected), 0, key);
  }
});

test("Phase 6 rollback cannot accept a soft-skipped canonical v2 index scope", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const migrationAdapters = memoryAdapters(fixture);
  const migration = await executeObservationHistoryV3MigrationPlan({
    plan,
    apply: true,
    writersFrozen: true,
    environmentEvidence: ENVIRONMENT,
    adapters: migrationAdapters,
  });
  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint: migration.checkpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  const rollbackAdapters = memoryAdapters(fixture, {
    rebuildWarning: "Skipped observations v2 pollutant timeseries index",
    v2IndexCompleteness: { ok: false, complete: false },
  });
  await assert.rejects(
    executeObservationHistoryV2Rollback({
      restorePlan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters: rollbackAdapters,
    }),
    /completeness verification failed/,
  );
  assert.equal(rollbackAdapters.rebuildCalls, 1);
});

test("Phase 4 rejects a checkpoint whose immutable authority was tampered", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 1 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 1/,
  );
  const tampered = structuredClone(adapters.checkpoints.at(-1));
  const validCheckpoint = structuredClone(adapters.checkpoints.at(-1));
  const restorePlan = await buildObservationHistoryV2RestorePlan({
    checkpoint: validCheckpoint,
    getBackupObject: mapReader(fixture.backup),
  });
  const wrongBucketAdapters = memoryAdapters(fixture);
  await assert.rejects(
    executeObservationHistoryV2Rollback({
      restorePlan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: {
        ...ENVIRONMENT,
        bucket: "wrong-fixture-bucket",
        expectedBucket: "wrong-fixture-bucket",
      },
      adapters: wrongBucketAdapters,
    }),
    /environment\/bucket authority mismatch/,
  );
  assert.equal(wrongBucketAdapters.putCalls, 0);
  tampered.authority.inventory.root_manifest.sha256 = "0".repeat(64);
  assert.throws(
    () => buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint: tampered }),
    /immutable authority is missing or invalid/,
  );
  await assert.rejects(
    buildObservationHistoryV2RestorePlan({
      checkpoint: tampered,
      getBackupObject: mapReader(fixture.backup),
    }),
    /immutable authority is missing or invalid/,
  );
});

function syntheticMigrationAudit(partitionCount = 1, blockers = []) {
  return {
    schema_version: 1,
    kind: "uk_aq_observation_history_v3_migration_audit",
    environment: "TEST",
    migration_run_id: "synthetic-report-run",
    partitions_attempted: partitionCount,
    partitions_succeeded: partitionCount,
    partitions_failed: 0,
    empty_source_connector_count: 0,
    empty_source_connectors: [],
    partition_results: Array.from({ length: partitionCount }, (_, index) => ({
      scope: { connector_id: 1, pollutant_code: `p${index}` },
      old_row_count: 10,
      new_row_count: 10,
      old_observation_content_hash: "a".repeat(64),
      new_observation_content_hash: "a".repeat(64),
      old_file_count: 2,
      new_file_count: 1,
      new_row_group_count: 1,
      verification_status_counts: { verified: 10 },
      deliberately_large_detail: "x".repeat(1_000),
    })),
    publication_verification: true,
    cutover_ready: true,
    rollback_ready: true,
    blockers,
  };
}

function syntheticMigrationResult(objectCount = 1) {
  const checkpointEntries = Object.fromEntries(
    Array.from({ length: objectCount }, (_, index) => [
      `history/v2/observations/object-${index}.parquet`,
      { byte_size: 50, deliberately_large_detail: "x".repeat(1_000) },
    ]),
  );
  const preparedUnits = Object.fromEntries(
    Array.from({ length: objectCount }, (_, index) => [
      `unit-${index}`,
      { deliberately_large_detail: "x".repeat(1_000) },
    ]),
  );
  return {
    ok: true,
    status: "cutover_ready",
    dry_run: false,
    checkpoint: {
      migration_run_id: "synthetic-report-run",
      authority_sha256: "b".repeat(64),
      plan_sha256: "c".repeat(64),
      full_verification_complete: true,
      cutover_ready: true,
      prepared_units: preparedUnits,
      completed_objects: checkpointEntries,
    },
    parquet_evidence: Array.from({ length: objectCount }, (_, index) => ({
      key: `history/v2/observations/object-${index}.parquet`,
      byte_size: 50,
      stored_sha256_verified: true,
      reused: index % 2 === 0,
      deliberately_large_detail: "x".repeat(1_000),
    })),
    v3_publication: {
      ok: true,
      status: "succeeded",
      schedule_sha256: "d".repeat(64),
      published_object_count: objectCount,
      objects: Array.from({ length: objectCount }, (_, index) => ({
        key: `history/_index_v3/child-${index}.json`,
        publication_stage: "child_shard",
        verified: true,
        durable: true,
        deliberately_large_detail: "x".repeat(1_000),
      })),
    },
    verification: {
      ok: true,
      cutover_ready: true,
      blockers: [],
      partition_count: objectCount,
      v3_child_count: objectCount,
      v3_scoped_root_count: objectCount,
      v3_latest_count: 1,
      r2_stored_sha_verification: "verified",
      scoped_root_child_verification: "verified",
    },
  };
}

test("migration report output excludes large execution and partition detail", () => {
  const output = buildObservationHistoryV3ReportOutput({
    result: syntheticMigrationResult(500),
    audit: syntheticMigrationAudit(500),
    mode: "migrate",
  });
  assert.equal(Object.hasOwn(output.result, "checkpoint"), false);
  assert.equal(Object.hasOwn(output.result, "parquet_evidence"), false);
  assert.equal(Object.hasOwn(output.result.v3_publication, "objects"), false);
  assert.equal(Object.hasOwn(output.audit, "partition_results"), false);
  assert.equal(output.result.checkpoint_summary.full_verification_complete, true);
  assert.equal(output.result.checkpoint_summary.cutover_ready, true);
  assert.equal(output.result.checkpoint_summary.prepared_unit_count, 500);
  assert.equal(output.result.checkpoint_summary.completed_object_count, 500);
  assert.equal(output.result.parquet_evidence_summary.object_count, 500);
  assert.equal(output.result.v3_publication.published_object_count, 500);
  assert.equal(output.result.v3_publication.publication_stage_counts.child_shard, 500);
  assert.equal(output.audit.partition_result_summary.partition_count, 500);
  assert.equal(output.audit.partition_result_summary.row_count_match_count, 500);
  assert.equal(
    output.audit.partition_result_summary.observation_content_hash_match_count,
    500,
  );
  assert.ok(stableMigrationJson(output).length < 20_000);
});

test("completed checkpoint objects are classified by deterministic key namespace", () => {
  const scope = {
    day_utc: DAY,
    connector_id: 1,
    pollutant_code: "pm25",
  };
  const keys = [
    `${PREFIX}/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/part-00000.parquet`,
    buildHistoryV2PollutantManifestKey(PREFIX, DAY, 1, "pm25"),
    buildHistoryV2ConnectorManifestKey(PREFIX, DAY, 1),
    buildHistoryV2DayManifestKey(PREFIX, DAY),
    buildObservationHistoryIndexV3ChildShardKey({ scope, rangeStart: 0 }),
    buildObservationHistoryIndexV3ScopedManifestKey({ scope }),
    DEFAULT_V3_LATEST_KEY,
    "history/_index_v3/observations_timeseries/unknown.json",
  ];
  const checkpoint = {
    ...syntheticMigrationResult().checkpoint,
    prepared_units: {},
    completed_objects: Object.fromEntries(keys.map((key) => [
      key,
      {
        byte_size: 50,
        sha256: "e".repeat(64),
        verified: true,
        durable: true,
        stored_sha256_verified: key.endsWith(".parquet"),
      },
    ])),
  };
  const output = buildObservationHistoryV3ReportOutput({
    result: { ok: true, cutover_ready: false, blockers: [] },
    audit: syntheticMigrationAudit(),
    mode: "verify",
    checkpoint,
  });
  assert.deepEqual(
    output.result.checkpoint_summary.completed_object_counts,
    {
      total: 8,
      parquet: 1,
      canonical_manifest: 3,
      v3_child_shard: 1,
      v3_scoped_manifest: 1,
      v3_latest_global: 1,
      other: 1,
    },
  );
});

test("small success, failure and verify reports retain bounded evidence", () => {
  const success = buildObservationHistoryV3ReportOutput({
    result: syntheticMigrationResult(),
    audit: syntheticMigrationAudit(),
    mode: "migrate",
  });
  assert.equal(success.result.ok, true);
  assert.equal(success.result.status, "cutover_ready");
  assert.equal(success.result.verification.r2_stored_sha_verification, "verified");
  assert.equal(success.audit.publication_verification, true);
  assert.equal(success.audit.rollback_ready, true);

  const manyBlockers = Array.from(
    { length: 150 },
    (_, index) => `synthetic_blocker_${index}:${"x".repeat(3_000)}`,
  );
  const failure = buildObservationHistoryV3ReportOutput({
    result: {
      ok: false,
      status: "failed",
      error: "x".repeat(3_000),
      verification: { blockers: manyBlockers },
    },
    audit: syntheticMigrationAudit(500, manyBlockers),
    mode: "migrate",
  });
  assert.equal(failure.result.error.endsWith("...[truncated]"), true);
  assert.equal(failure.result.verification.blockers.length, 100);
  assert.equal(failure.result.verification.blockers_omitted, 50);
  assert.equal(failure.audit.blockers.length, 100);
  assert.equal(failure.audit.blockers_omitted, 50);
  assert.ok(stableMigrationJson(failure).length < 500_000);

  const verify = buildObservationHistoryV3ReportOutput({
    result: {
      ok: false,
      cutover_ready: false,
      blockers: manyBlockers,
      partition_count: 500,
      r2_stored_sha_verification: "failed",
    },
    audit: syntheticMigrationAudit(500, manyBlockers),
    mode: "verify",
    checkpoint: syntheticMigrationResult().checkpoint,
  });
  assert.equal(verify.result.partition_count, 500);
  assert.equal(verify.result.blockers.length, 100);
  assert.equal(verify.result.blockers_omitted, 50);
  assert.equal(verify.result.checkpoint_summary.prepared_unit_count, 1);
  assert.equal(Object.hasOwn(verify.audit, "partition_results"), false);
  assert.ok(stableMigrationJson(verify).length < 500_000);
});

test("verify report preserves the precise pre-R2 failure category", () => {
  const output = buildObservationHistoryV3ReportOutput({
    result: {
      ok: false,
      cutover_ready: false,
      blockers: ["operation_failed:recovery_evidence_invalid:fixture"],
      failure_category: "recovery_evidence_invalid",
    },
    audit: syntheticMigrationAudit(1, ["recovery_evidence_invalid:fixture"]),
    mode: "verify",
    checkpoint: syntheticMigrationResult().checkpoint,
  });
  assert.equal(output.result.failure_category, "recovery_evidence_invalid");
  assert.doesNotMatch(output.result.blockers.join("\n"), /R2 drift/i);
});

test("recovery journal schema and final-state replay remain structurally compatible", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const adapters = memoryAdapters(fixture, { failPutCall: 1 });
  await assert.rejects(
    executeObservationHistoryV3MigrationPlan({
      plan,
      apply: true,
      writersFrozen: true,
      environmentEvidence: ENVIRONMENT,
      adapters,
    }),
    /deliberate PUT failure 1/,
  );
  const originalCheckpoint = structuredClone(adapters.checkpoints.at(-1));
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "uk-aq-v3-report-recovery-"),
  );
  try {
    const checkpointPath = path.join(temporaryRoot, "migration_checkpoint.json");
    fs.writeFileSync(checkpointPath, stableMigrationJson(originalCheckpoint), {
      mode: 0o600,
    });
    const context = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath,
      checkpoint: originalCheckpoint,
      repositoryRoot: REPOSITORY_ROOT,
      create: true,
    });
    const completedCheckpoint = structuredClone(context.checkpoint);
    completedCheckpoint.full_verification_complete = true;
    completedCheckpoint.cutover_ready = true;
    await context.persistCheckpoint(completedCheckpoint);

    const manifest = JSON.parse(fs.readFileSync(context.paths.manifest, "utf8"));
    manifest.payload.recovery_implementation.repository_head = "f".repeat(40);
    manifest.payload_sha256 = sha256Hex(stableMigrationJson(manifest.payload));
    fs.writeFileSync(context.paths.manifest, stableMigrationJson(manifest), {
      mode: 0o600,
    });
    assert.throws(
      () => buildObservationHistoryV3RecoveryProgressContext({
        checkpointPath,
        checkpoint: originalCheckpoint,
        repositoryRoot: REPOSITORY_ROOT,
      }),
      /Recovery manifest does not match/,
    );
    const replayed = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath,
      checkpoint: originalCheckpoint,
      repositoryRoot: REPOSITORY_ROOT,
      requireCurrentImplementation: false,
    });
    assert.equal(replayed.sequence, 1);
    assert.equal(replayed.checkpoint.full_verification_complete, true);
    assert.equal(replayed.checkpoint.cutover_ready, true);
    const journalEntry = JSON.parse(fs.readFileSync(
      path.join(replayed.paths.entries, "0000000001.json"),
      "utf8",
    ));
    assert.equal(journalEntry.schema_version, 1);
    assert.equal(
      journalEntry.kind,
      "uk_aq_observation_history_v3_recovery_entry",
    );
    assert.deepEqual(journalEntry.payload.updates.final_state, {
      cutover_ready: true,
      full_verification_complete: true,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
