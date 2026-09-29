import assert from "node:assert/strict";
import test from "node:test";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";

import { computeObservationContentHash } from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
} from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import {
  serializeCanonicalObservationV2Parquet,
} from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  AUTHORISED_CONNECTOR_COUNTS,
  AUTHORISED_FROM_DAY,
  AUTHORISED_PARTITION_COUNT,
  AUTHORISED_TO_DAY,
  assertAuthorisedPartitionScope,
  assertCompleteAggregateChildSet,
  assertDurableDependencyRecords,
  assertKnownErroneousV2ManifestIdentity,
  assertPinnedPrestateRecords,
  buildPublicationSchedule,
  classifyV2MigrationPhysicalColumns,
  decodeV2MigrationParquet,
  parseMigrationArgs,
  selectAuthorisedAffectedPartitions,
  validateV2MigrationTarget,
} from "./uk_aq_migrate_observation_v2_september_2026_vstatus_to_verification_status.mjs";

const baseColumns = OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6);
const baseRow = {
  connector_id: 1,
  station_id: 2,
  timeseries_id: 3,
  pollutant_code: "no2",
  observed_at_utc: "2026-09-09T01:00:00.000Z",
  value: 12.5,
};

function physicalFixture(statusName, statuses) {
  const columns = {
    connector_id: arrow.vectorFromArray(statuses.map(() => 1), new arrow.Int32()),
    station_id: arrow.vectorFromArray(statuses.map(() => 2), new arrow.Int32()),
    timeseries_id: arrow.vectorFromArray(statuses.map((_, index) => 3 + index), new arrow.Int32()),
    pollutant_code: arrow.vectorFromArray(statuses.map(() => "no2"), new arrow.Utf8()),
    observed_at_utc: arrow.vectorFromArray(
      statuses.map((_, index) => new Date(Date.parse(baseRow.observed_at_utc) + index * 3600000)),
      new arrow.TimestampMillisecond(),
    ),
    value: arrow.vectorFromArray(statuses.map(() => 12.5), new arrow.Float64()),
    [statusName]: arrow.vectorFromArray(statuses, new arrow.Utf8()),
  };
  const table = parquetWasm.Table.fromIPCStream(
    arrow.tableToIPC(arrow.tableFromArrays(columns), "stream"),
  );
  return Buffer.from(
    parquetWasm.writeParquet(table, new parquetWasm.WriterPropertiesBuilder().build()),
  );
}

function authorisedInventory() {
  const entries = [];
  const connectorIds = [
    ...Array(185).fill(1),
    ...Array(20).fill(2),
    ...Array(10).fill(3),
    ...Array(79).fill(6),
  ];
  const dayCounts = [
    ["2026-09-09", 10],
    ["2026-09-10", 9],
    ["2026-09-11", 10],
    ["2026-09-12", 53],
    ["2026-09-13", 53],
    ["2026-09-14", 53],
    ["2026-09-15", 53],
    ["2026-09-16", 53],
  ];
  let ordinal = 0;
  for (const [dayUtc, count] of dayCounts) {
    for (let index = 0; index < count; index += 1) {
      entries.push({
        kind: "erroneous",
        scope: {
          day_utc: dayUtc,
          connector_id: connectorIds[ordinal],
          pollutant_code: `p${String(ordinal).padStart(3, "0")}`,
        },
      });
      ordinal += 1;
    }
  }
  return entries;
}

test("bounded v2 September physical-name migration preserves content and publication safety", async () => {
  const parsedDefaults = parseMigrationArgs([
    "--mode", "plan",
    "--plan-path", "/private/tmp/plan.json",
    "--expected-environment", "LIVE",
    "--expected-bucket", "operator-supplied-live-bucket",
    "--target-writer-git-sha", "a".repeat(40),
    "--dropbox-root", "/private/tmp/dropbox",
    "--from-day", "2026-09-09",
    "--to-day", "2026-09-16",
    "--expected-affected-partitions", "294",
  ]);
  assert.equal(parsedDefaults.bindingBackupMode, "individual");

  assert.equal(AUTHORISED_FROM_DAY, "2026-09-09");
  assert.equal(AUTHORISED_TO_DAY, "2026-09-16");
  assert.equal(AUTHORISED_PARTITION_COUNT, 294);
  assert.deepEqual(AUTHORISED_CONNECTOR_COUNTS, { 1: 185, 2: 20, 3: 10, 6: 79 });

  assert.equal(classifyV2MigrationPhysicalColumns([...baseColumns, "vstatus"]), "erroneous");
  assert.equal(classifyV2MigrationPhysicalColumns(OBSERVATION_HISTORY_COLUMNS_V3), "canonical");
  assert.equal(classifyV2MigrationPhysicalColumns(baseColumns), "historical");
  assert.throws(
    () => classifyV2MigrationPhysicalColumns([...baseColumns, "vstatus", "verification_status"]),
    /unsupported/i,
  );
  const knownErroneousIdentity = {
    history_schema_version: 3,
    writer_version: "parquet-wasm-zstd-v3",
    manifest_schema_version: 3,
  };
  assert.doesNotThrow(() => assertKnownErroneousV2ManifestIdentity(
    knownErroneousIdentity,
    "erroneous",
    "known.json",
  ));
  for (const invalid of [
    { ...knownErroneousIdentity, history_schema_version: 2 },
    { ...knownErroneousIdentity, writer_version: "parquet-wasm-zstd-v2" },
    { ...knownErroneousIdentity, manifest_schema_version: 2 },
  ]) {
    assert.throws(
      () => assertKnownErroneousV2ManifestIdentity(invalid, "erroneous", "invalid.json"),
      /unsupported writer identity/i,
    );
  }
  assert.doesNotThrow(() => assertKnownErroneousV2ManifestIdentity({}, "canonical", "canonical.json"));

  // Initialise the same shared parquet-wasm runtime used by the canonical writer.
  serializeCanonicalObservationV2Parquet([{ ...baseRow, verification_status: "R" }]);
  const oldBody = physicalFixture("vstatus", ["P", "R", null]);
  const decodedOld = await decodeV2MigrationParquet(oldBody, "erroneous");
  assert.deepEqual(decodedOld.rows.map((row) => row.verification_status), ["P", "R", null]);
  assert.deepEqual(decodedOld.rows.map(Object.keys), decodedOld.rows.map(() => OBSERVATION_HISTORY_COLUMNS_V3));
  await assert.rejects(
    () => decodeV2MigrationParquet(physicalFixture("vstatus", ["invalid"]), "erroneous"),
    /exactly P, R or null/i,
  );

  const oldLogical = computeObservationContentHash(decodedOld.rows);
  const targetBody = serializeCanonicalObservationV2Parquet(decodedOld.rows);
  const decodedTarget = await decodeV2MigrationParquet(targetBody, "canonical");
  const targetLogical = computeObservationContentHash(decodedTarget.rows);
  assert.equal(targetLogical.observation_content_hash, oldLogical.observation_content_hash);
  assert.equal(targetLogical.observation_content_hash_row_count, oldLogical.observation_content_hash_row_count);
  assert.deepEqual(targetLogical.verification_status_counts, { P: 1, R: 1, null: 1 });
  assert.deepEqual(decodedTarget.rows.map((row) => row.verification_status), ["P", "R", null]);

  const inventory = authorisedInventory();
  inventory.push({
    kind: "erroneous",
    scope: { day_utc: "2025-01-01", connector_id: 1, pollutant_code: "outside" },
  });
  const selected = selectAuthorisedAffectedPartitions(inventory);
  assert.equal(selected.length, 294);
  assert.equal(selected.some((entry) => entry.scope.pollutant_code === "outside"), false);
  const wrongDayDistribution = authorisedInventory();
  wrongDayDistribution[0] = {
    ...wrongDayDistribution[0],
    scope: { ...wrongDayDistribution[0].scope, day_utc: "2026-09-10" },
  };
  assert.throws(
    () => selectAuthorisedAffectedPartitions(wrongDayDistribution),
    /day totals differ/i,
  );
  assert.throws(
    () => selectAuthorisedAffectedPartitions(inventory.slice(0, -2)),
    /exactly 294/i,
  );
  assert.throws(
    () => assertAuthorisedPartitionScope({ day_utc: "2026-09-17", connector_id: 1, pollutant_code: "no2" }),
    /authorised September scope/i,
  );

  assert.doesNotThrow(() => validateV2MigrationTarget({
    args: {
      expectedEnvironment: "LIVE",
      expectedBucket: "operator-supplied-live-bucket",
      fromDay: AUTHORISED_FROM_DAY,
      toDay: AUTHORISED_TO_DAY,
      expectedAffectedPartitions: AUTHORISED_PARTITION_COUNT,
    },
    env: { UK_AQ_ENV_NAME: "LIVE", UK_AQ_R2_HISTORY_VERSION: "v2" },
    resolvedR2: { bucket: "operator-supplied-live-bucket", region: "auto", access_key_id: "x", secret_access_key: "y", endpoint: "https://example.invalid" },
  }));
  assert.throws(() => validateV2MigrationTarget({
    args: {
      expectedEnvironment: "LIVE",
      expectedBucket: "operator-supplied-live-bucket",
      fromDay: AUTHORISED_FROM_DAY,
      toDay: AUTHORISED_TO_DAY,
      expectedAffectedPartitions: AUTHORISED_PARTITION_COUNT,
    },
    env: { UK_AQ_ENV_NAME: "LIVE", UK_AQ_R2_HISTORY_VERSION: "v3" },
    resolvedR2: { bucket: "operator-supplied-live-bucket", region: "auto", access_key_id: "x", secret_access_key: "y", endpoint: "https://example.invalid" },
  }), /generation v2/i);

  const scheduled = buildPublicationSchedule([
    { key: "latest", stage: "latest", dependencies: ["root"] },
    { key: "root", stage: "root", dependencies: ["year"] },
    { key: "year", stage: "year", dependencies: ["month"] },
    { key: "month", stage: "month", dependencies: ["day"] },
    { key: "day", stage: "day", dependencies: ["index"] },
    { key: "index", stage: "scoped_index", dependencies: ["connector"] },
    { key: "connector", stage: "connector", dependencies: ["pollutant"] },
    { key: "pollutant", stage: "pollutant", dependencies: ["parquet"] },
    { key: "parquet", stage: "parquet", dependencies: [] },
  ]);
  assert.deepEqual(scheduled.map((entry) => entry.key), [
    "parquet", "pollutant", "connector", "index", "day", "month", "year", "root", "latest",
  ]);
  assert.throws(() => buildPublicationSchedule([
    { key: "latest", stage: "latest", dependencies: ["missing"] },
  ]), /unresolved/i);
  assert.throws(() => buildPublicationSchedule([
    { key: "pollutant", stage: "pollutant", dependencies: ["connector"] },
    { key: "connector", stage: "connector", dependencies: ["pollutant"] },
    { key: "latest", stage: "latest", dependencies: ["connector"] },
  ]), /contradicts dependency|cycle/i);
  assert.throws(() => buildPublicationSchedule([
    { key: "day", stage: "day", dependencies: ["latest"] },
    { key: "latest", stage: "latest", dependencies: [] },
  ]), /contradicts dependency/i);

  const aggregateParent = {
    children: [{ manifest_key: "child.json", content_hash: "a".repeat(64) }],
  };
  const aggregateChild = { key: "child.json", payload: { content_hash: "a".repeat(64) } };
  assert.doesNotThrow(() => assertCompleteAggregateChildSet(
    aggregateParent,
    new Map([[aggregateChild.key, aggregateChild]]),
    "content_hash",
  ));
  assert.throws(() => assertCompleteAggregateChildSet(
    aggregateParent,
    new Map(),
    "content_hash",
  ), /complete aggregate child set/i);

  const oldIdentity = { key: "child.json", byte_size: 10, sha256: "a".repeat(64) };
  const targetIdentity = { key: "child.json", byte_size: 11, sha256: "b".repeat(64) };
  const thirdIdentity = { key: "child.json", byte_size: 12, sha256: "c".repeat(64) };
  const childPut = { key: "child.json", old: oldIdentity, target: targetIdentity, dependencies: [] };
  assert.doesNotThrow(() => assertPinnedPrestateRecords(
    [oldIdentity], [childPut], [targetIdentity],
  ));
  assert.throws(() => assertPinnedPrestateRecords(
    [oldIdentity], [childPut], [thirdIdentity],
  ), /third identity/i);

  const parentPut = { key: "parent.json", dependencies: [childPut.key] };
  assert.doesNotThrow(() => assertDurableDependencyRecords(
    parentPut, [childPut], [targetIdentity], { [childPut.key]: targetIdentity },
  ));
  assert.throws(() => assertDurableDependencyRecords(
    parentPut, [childPut], [targetIdentity], {},
  ), /unverified dependency/i);
});
