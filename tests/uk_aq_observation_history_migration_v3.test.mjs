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
  buildObservationHistoryV3MigrationPlan,
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
  buildObservationHistoryV3RerunVerificationPlan,
  executeObservationHistoryV2Rollback,
  executeObservationHistoryV3MigrationPlan,
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
  environment: "CIC-Test",
  configuredEnvironment: "CIC-Test",
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

async function buildFixture() {
  const baseRows = [
    [100, "2026-01-02T00:00:00.000Z", 10, "P"],
    [100, "2026-01-02T01:00:00.000Z", 11, "R"],
    [1000, "2026-01-02T00:30:00.000Z", 20, "P"],
    [1000, "2026-01-02T01:30:00.000Z", 21, "R"],
  ];
  const pollutantInputs = [
    ["pm25", baseRows],
    ["pm10", baseRows.map(([timeseriesId, ...rest]) => [timeseriesId + 2000, ...rest])],
  ];
  const sources = [];
  const pollutants = [];
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
    const pollutant = buildHistoryV2PollutantManifest({
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
    sources.push(source);
    pollutants.push({ key: pollutantKey, payload: pollutant });
  }
  const connectorKey = buildHistoryV2ConnectorManifestKey(PREFIX, DAY, 1);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 1,
    manifestKey: connectorKey,
    pollutantManifests: pollutants.map((entry) => entry.payload),
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
      return { ok: true, history_version: "v2", domains: ["observations"] };
    },
  };
}

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
  const adapters = memoryAdapters(fixture);
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
  for (const [key, expected] of fixture.oldCanonical) {
    assert.equal(Buffer.compare(fixture.r2.get(key), expected), 0, key);
  }
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
