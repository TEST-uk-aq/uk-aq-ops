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
  const rows = [
    [100, "2026-01-02T00:00:00.000Z", 10, "P"],
    [100, "2026-01-02T01:00:00.000Z", 11, "R"],
    [1000, "2026-01-02T00:30:00.000Z", 20, "P"],
    [1000, "2026-01-02T01:30:00.000Z", 21, "R"],
  ].map(([timeseriesId, observedAtUtc, value, verificationStatus]) => ({
    connector_id: 1,
    station_id: timeseriesId + 1,
    timeseries_id: timeseriesId,
    pollutant_code: "pm25",
    observed_at_utc: observedAtUtc,
    value,
    verification_status: verificationStatus,
  }));
  const source = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits: LIMITS,
    fileKeyForOrdinal: (ordinal) =>
      `${PREFIX}/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/part-${String(ordinal).padStart(5, "0")}.parquet`,
  });
  const pollutantKey = buildHistoryV2PollutantManifestKey(PREFIX, DAY, 1, "pm25");
  const pollutant = buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 1,
    pollutantCode: "pm25",
    manifestKey: pollutantKey,
    sourceRowCount: source.metadata.row_count,
    fileEntries: source.metadata.files.map((file) => fileEntry(file, "pm25")),
    writerGitSha: "fixture-source",
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
    observationContentHash: metadataHash(source.metadata),
    physicalSchema: {
      history_schema_version: source.metadata.history_schema_version,
      columns: [...source.metadata.columns],
      writer_version: source.metadata.writer_version,
    },
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(PREFIX, DAY, 1);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 1,
    manifestKey: connectorKey,
    pollutantManifests: [pollutant],
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
  for (const file of source.file_bodies) r2.set(file.key, Buffer.from(file.body));
  for (const [key, value] of [
    [pollutantKey, pollutant],
    [connectorKey, connector],
    [dayKey, day],
  ]) r2.set(key, jsonBody(value));
  for (const object of hierarchy.objects) r2.set(object.key, Buffer.from(object.body));
  r2.set(DEFAULT_V2_LATEST_KEY, jsonBody({ generation: "fixture-v2" }));
  r2.set(
    `history/_index_v2/observations_timeseries/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/manifest.json`,
    jsonBody({ scope: "fixture-v2" }),
  );
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
    source,
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

function memoryAdapters(fixture) {
  const storedSha = new Map();
  let rebuildCalls = 0;
  const checkpoints = [];
  const getObject = mapReader(fixture.r2);
  return {
    storedSha,
    checkpoints,
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
    writeCheckpoint: async (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    finalizeV3Publication: (options) => finalizeObservationHistoryIndexV3Publication(options),
    rebuildV2Indexes: async () => {
      rebuildCalls += 1;
      return { ok: true, history_version: "v2", domains: ["observations"] };
    },
  };
}

test("Phase 4 planner is deterministic, manifest-guided, checksum-aware and backup-gated", async () => {
  const fixture = await buildFixture();
  const first = await buildPlan(fixture);
  const second = await buildPlan(fixture);
  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.equal(first.units.length, 1);
  assert.deepEqual(first.units[0].scope, {
    day_utc: DAY,
    connector_id: 1,
    pollutant_code: "pm25",
  });
  assert.equal(first.units[0].source_row_count, first.units[0].target_metadata.row_count);
  assert.equal(
    first.units[0].source_observation_content_hash,
    first.units[0].target_metadata.observation_content_hash,
  );
  assert.equal(first.units[0].target_metadata.writer_version, "parquet-wasm-zstd-v3");
  assert.ok(first.units[0].v3_hierarchy.child_shards.length >= 2);
  for (const intent of first.units[0].target_file_intents) {
    assert.equal(intent.sha256, sha256Hex(intent.body));
    assert.equal(intent.byte_size, intent.body.byteLength);
  }
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

test("Phase 4 apply requires explicit guards, exact HEAD checksum and full v3 authority", async () => {
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
  const currentPlan = await buildPlan(fresh);
  assert.ok(currentPlan.blockers.every((entry) =>
    entry.startsWith("verified_dropbox_checkpoint_missing:")
  ));
  const rerunPlan = buildObservationHistoryV3RerunVerificationPlan({
    currentPlan,
    checkpoint: execution.checkpoint,
  });
  const rerun = await verifyObservationHistoryV3MigrationResult({
    plan: rerunPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true, checkpoint_evidence: true },
  });
  assert.equal(rerun.cutover_ready, true);

  fresh.r2.delete(freshPlan.v3_latest.key);
  const incomplete = await verifyObservationHistoryV3MigrationResult({
    plan: freshPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true },
  });
  assert.equal(incomplete.cutover_ready, false);
  assert.ok(incomplete.blockers.some((entry) => entry.includes("v3_latest")));
  fresh.r2.set(freshPlan.v3_latest.key, Buffer.from(freshPlan.v3_latest.body));
  const child = freshPlan.units[0].v3_hierarchy.child_shards[0];
  fresh.r2.set(child.key, Buffer.from(`${child.body} `));
  const mismatched = await verifyObservationHistoryV3MigrationResult({
    plan: freshPlan,
    getObject: adapters.getObject,
    headObject: adapters.headObject,
    publicationResult: { ok: true },
  });
  assert.equal(mismatched.cutover_ready, false);
  assert.ok(mismatched.blockers.some((entry) =>
    entry.startsWith("scoped_root_child_authority_mismatch:")
  ));
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

test("Phase 4 rollback is backup-manifest driven and rebuilds observation _index_v2", async () => {
  const fixture = await buildFixture();
  const plan = await buildPlan(fixture);
  const restorePlan = await buildObservationHistoryV2RestorePlan({
    migrationPlan: plan,
    getBackupObject: mapReader(fixture.backup),
  });
  assert.equal(restorePlan.ready, true);
  assert.ok(restorePlan.objects.some((entry) => entry.stage === "canonical_parquet"));
  assert.ok(restorePlan.objects.some((entry) => entry.stage === "root_manifest"));
  assert.equal(restorePlan.v2_index_strategy.mode, "rebuild");
  const adapters = memoryAdapters(fixture);
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
  assert.equal(rollback.configuration_changed, false);
  assert.equal(rollback.scheduler_changed, false);
  assert.equal(rollback.deployment_changed, false);
});
