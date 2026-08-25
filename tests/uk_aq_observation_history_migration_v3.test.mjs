import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
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
  buildObservationHistoryV2RestorePlan,
  buildObservationHistoryV3MigrationAuditReport,
  buildObservationHistoryV3MigrationPlan,
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
  buildObservationHistoryV3RerunVerificationPlan,
  executeObservationHistoryV2Rollback,
  executeObservationHistoryV3MigrationPlan,
  inventoryAuthoritativeCanonicalObservationHistory,
  stableMigrationJson,
  verifyObservationHistoryV2IndexCompleteness,
  verifyObservationHistoryV3CheckpointReuse,
  verifyObservationHistoryV3MigrationResult,
} from "../scripts/backup_r2/lib/observation_history_migration_v3.mjs";
import {
  buildObservationsManifestHierarchy,
} from "../scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs";

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
      manifestMode === "legacy_hashless_stale_timeseries_counts" ||
      manifestMode === "legacy_hashless_arbitrary_stale" ||
      manifestMode === "legacy_hashless_stale_other_field"
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
      if (manifestMode.includes("_stale_")) {
        delete pollutant.timeseries_row_counts;
      }
      pollutant = rehashManifest(pollutant);
    } else if (manifestMode === "modern_stale_timeseries_counts") {
      pollutant = structuredClone(pollutant);
      delete pollutant.timeseries_row_counts;
      pollutant = rehashManifest(pollutant);
    } else if (manifestMode === "malformed_hash") {
      pollutant = rehashManifest({
        ...pollutant,
        observation_content_hash: "NOT-A-SHA256",
      });
    } else if (manifestMode === "partial_contract") {
      pollutant = structuredClone(pollutant);
      delete pollutant.observation_content_hash_algorithm;
      pollutant = rehashManifest(pollutant);
    }
    let parentReferenceHash = pollutant.manifest_hash;
    if (
      manifestMode === "legacy_hashless_stale_timeseries_counts" ||
      manifestMode === "legacy_hashless_arbitrary_stale" ||
      manifestMode === "modern_stale_timeseries_counts"
    ) {
      const preAugmentationHash = pollutant.manifest_hash;
      const timeseriesRowCounts = {};
      for (const [timeseriesId] of inputRows) {
        const key = String(timeseriesId);
        timeseriesRowCounts[key] = (timeseriesRowCounts[key] || 0) + 1;
      }
      pollutant = rehashManifest({
        ...pollutant,
        timeseries_row_counts: timeseriesRowCounts,
      });
      parentReferenceHash = manifestMode === "legacy_hashless_arbitrary_stale"
        ? "a".repeat(64)
        : preAugmentationHash;
    } else if (manifestMode === "legacy_hashless_stale_other_field") {
      const preAugmentationHash = pollutant.manifest_hash;
      pollutant = rehashManifest({
        ...pollutant,
        unrelated_historical_metadata: { source: "fixture" },
      });
      parentReferenceHash = preAugmentationHash;
    }
    sources.push(source);
    pollutants.push({ key: pollutantKey, payload: pollutant });
    parentReferenceHashes.set(pollutantCode, parentReferenceHash);
  }
  const connectorKey = buildHistoryV2ConnectorManifestKey(PREFIX, DAY, 1);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 1,
    manifestKey: connectorKey,
    pollutantManifests: pollutants.map((entry) => ({
      ...entry.payload,
      manifest_hash: parentReferenceHashes.get(entry.payload.pollutant_code),
    })),
    writerGitSha: "fixture-source",
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
  const dayKey = buildHistoryV2DayManifestKey(PREFIX, DAY);
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    manifestKey: dayKey,
    connectorManifests: [connector],
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
    targetWriterGitSha: "fixture-target",
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
  let maxStagedUnits = 0;
  let maxStagedBodies = 0;
  const checkpoints = [];
  const getObject = mapReader(fixture.r2);
  return {
    storedSha,
    checkpoints,
    get putCalls() { return putCalls; },
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
    legacy_stale_after_timeseries_row_counts_patch: 0,
    unexplained: 0,
  });
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

test("Phase 6 accepts only the reconstructed legacy timeseries-counts stale reference and pins its proof", async () => {
  const fixture = await buildFixture({
    pollutantCodes: ["pm25", "h3cch2chch32"],
    manifestModes: {
      h3cch2chch32: "legacy_hashless_stale_timeseries_counts",
    },
  });
  const first = await buildPlan(fixture);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.deepEqual(first.source_manifest_reference_provenance_counts, {
    exact: 1,
    legacy_stale_after_timeseries_row_counts_patch: 1,
    unexplained: 0,
  });
  const unit = first.units.find(
    (entry) => entry.scope.pollutant_code === "h3cch2chch32",
  );
  const reference = unit.source_manifest_reference;
  assert.equal(
    reference.provenance,
    "legacy_stale_after_timeseries_row_counts_patch",
  );
  assert.notEqual(
    reference.referenced_child_manifest_hash,
    reference.current_child_manifest_hash,
  );
  assert.equal(
    reference.reconstructed_pre_augmentation_child_manifest_hash,
    reference.referenced_child_manifest_hash,
  );
  assert.deepEqual(reference.historical_metadata_augmentation_fields, [
    "timeseries_row_counts",
  ]);
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
  changedReference.provenance = "exact";
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
    partitionAudit.source_reconstructed_pre_augmentation_child_manifest_hash,
    reference.referenced_child_manifest_hash,
  );
});

test("Phase 6 rejects arbitrary, unrelated-field and modern stale child references", async () => {
  for (const manifestMode of [
    "legacy_hashless_arbitrary_stale",
    "legacy_hashless_stale_other_field",
    "modern_stale_timeseries_counts",
  ]) {
    const fixture = await buildFixture({
      manifestModes: { pm25: manifestMode },
    });
    await assert.rejects(
      buildPlan(fixture),
      /Observation connector\/pollutant identity mismatch/,
    );
  }
});

test("Phase 6 rejects malformed and partial non-legacy hash contracts", async () => {
  for (const [mode, expected] of [
    ["malformed_hash", /observation_content_hash must be lower-case SHA-256/],
    ["partial_contract", /unsupported observation content hash algorithm/],
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

test("Phase 6 preparation rejects changed stale-reference parent, child or pinned proof before PUT", async () => {
  for (const changedEvidence of ["parent", "child", "pinned_proof"]) {
    const fixture = await buildFixture({
      manifestModes: {
        pm25: "legacy_hashless_stale_timeseries_counts",
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
    } else {
      const partition = executionPlan.inventory.partitions.find(
        (entry) => entry.scope.pollutant_code === "pm25",
      );
      partition.source_manifest_reference
        .reconstructed_pre_augmentation_child_manifest_hash = "f".repeat(64);
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
      /Pinned source (parent manifest identity|child manifest identity|manifest reference evidence) changed/,
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
      h3cch2chch32: "legacy_hashless_stale_timeseries_counts",
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
