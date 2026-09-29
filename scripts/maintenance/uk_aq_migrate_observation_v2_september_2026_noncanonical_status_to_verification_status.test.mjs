import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  AUTHORISED_DAY_COUNTS,
  AUTHORISED_AFFECTED_SCOPE_SET_SHA256,
  AUTHORISED_FROM_DAY,
  AUTHORISED_PARTITION_COUNT,
  AUTHORISED_TO_DAY,
  assertAuthorisedPartitionScope,
  assertCompleteAggregateChildSet,
  assertDurableDependencyRecords,
  assertKnownNoncanonicalV2ManifestIdentity,
  assertPinnedPrestateRecords,
  buildPublicationSchedule,
  classifyV2MigrationPhysicalColumns,
  computeAuthorisedAffectedScopeSetSha256,
  decodeV2MigrationParquet,
  parseMigrationArgs,
  prepareApplyInvocation,
  readMigrationCurrentIdentity,
  readMigrationSourceParquetWithDropboxEvidence,
  readMigrationTargetObjectStrict,
  selectAuthorisedAffectedPartitions,
  validateV2MigrationTarget,
} from "./uk_aq_migrate_observation_v2_september_2026_noncanonical_status_to_verification_status.mjs";

const baseColumns = OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6);
const DETERMINISTIC_SCOPE_FIXTURE_SHA256 = "484c4c6ccc7bf953aa35bc899f4cf9f3d96105ca61a4cbd6be63dd0f29d713bf";
const baseRow = {
  connector_id: 1,
  station_id: 2,
  timeseries_id: 3,
  pollutant_code: "no2",
  observed_at_utc: "2026-09-09T01:00:00.000Z",
  value: 12.5,
};

function physicalFixture(finalColumnName, statuses) {
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
    [finalColumnName]: arrow.vectorFromArray(statuses, new arrow.Utf8()),
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
        kind: "noncanonical_shape",
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
  assert.deepEqual(AUTHORISED_DAY_COUNTS, {
    "2026-09-09": 10,
    "2026-09-10": 9,
    "2026-09-11": 10,
    "2026-09-12": 53,
    "2026-09-13": 53,
    "2026-09-14": 53,
    "2026-09-15": 53,
    "2026-09-16": 53,
  });
  assert.equal(
    AUTHORISED_AFFECTED_SCOPE_SET_SHA256,
    "62c23a1d25207bc0ac46d696ed611c8e920e1127067062ee7ba3fd2f23ab233d",
  );

  const structurallyAuthorisedUnsupportedColumns = [...baseColumns, "unsupported_final_column"];
  assert.equal(classifyV2MigrationPhysicalColumns(structurallyAuthorisedUnsupportedColumns), "noncanonical_shape");
  assert.equal(classifyV2MigrationPhysicalColumns(OBSERVATION_HISTORY_COLUMNS_V3), "canonical");
  assert.equal(classifyV2MigrationPhysicalColumns(baseColumns), "historical");
  assert.equal(classifyV2MigrationPhysicalColumns([...baseColumns, "status"]), "historical");
  assert.throws(
    () => classifyV2MigrationPhysicalColumns(["unexpected_id", ...baseColumns.slice(1), "unsupported_final_column"]),
    /unsupported/i,
  );
  const knownNoncanonicalIdentity = {
    history_schema_version: 3,
    writer_version: "parquet-wasm-zstd-v3",
    manifest_schema_version: 3,
  };
  assert.doesNotThrow(() => assertKnownNoncanonicalV2ManifestIdentity(
    knownNoncanonicalIdentity,
    "noncanonical_shape",
    "known.json",
  ));
  for (const invalid of [
    { ...knownNoncanonicalIdentity, history_schema_version: 2 },
    { ...knownNoncanonicalIdentity, writer_version: "parquet-wasm-zstd-v2" },
    { ...knownNoncanonicalIdentity, manifest_schema_version: 2 },
  ]) {
    assert.throws(
      () => assertKnownNoncanonicalV2ManifestIdentity(invalid, "noncanonical_shape", "invalid.json"),
      /unsupported writer identity/i,
    );
  }
  assert.doesNotThrow(() => assertKnownNoncanonicalV2ManifestIdentity({}, "canonical", "canonical.json"));

  // Initialise the same shared parquet-wasm runtime used by the canonical writer.
  serializeCanonicalObservationV2Parquet([{ ...baseRow, verification_status: "R" }]);
  const oldBody = physicalFixture(structurallyAuthorisedUnsupportedColumns[6], ["P", "R", null]);
  const decodedOld = await decodeV2MigrationParquet(oldBody, "noncanonical_shape");
  assert.deepEqual(decodedOld.rows.map((row) => row.verification_status), ["P", "R", null]);
  assert.deepEqual(decodedOld.rows.map(Object.keys), decodedOld.rows.map(() => OBSERVATION_HISTORY_COLUMNS_V3));
  await assert.rejects(
    () => decodeV2MigrationParquet(
      physicalFixture(structurallyAuthorisedUnsupportedColumns[6], ["invalid"]),
      "noncanonical_shape",
    ),
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

  const deterministicScopeFixture = authorisedInventory();
  assert.equal(
    computeAuthorisedAffectedScopeSetSha256(deterministicScopeFixture),
    DETERMINISTIC_SCOPE_FIXTURE_SHA256,
  );
  assert.equal(
    computeAuthorisedAffectedScopeSetSha256([...deterministicScopeFixture].reverse()),
    DETERMINISTIC_SCOPE_FIXTURE_SHA256,
  );
  const inventory = [...deterministicScopeFixture];
  inventory.push({
    kind: "noncanonical_shape",
    scope: { day_utc: "2025-01-01", connector_id: 1, pollutant_code: "outside" },
  });
  const selected = selectAuthorisedAffectedPartitions(inventory, {
    expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
  });
  assert.equal(selected.length, 294);
  assert.equal(selected.some((entry) => entry.scope.pollutant_code === "outside"), false);
  const wrongDayDistribution = authorisedInventory();
  wrongDayDistribution[0] = {
    ...wrongDayDistribution[0],
    scope: { ...wrongDayDistribution[0].scope, day_utc: "2026-09-10" },
  };
  assert.throws(
    () => selectAuthorisedAffectedPartitions(wrongDayDistribution, {
      expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
    }),
    /day totals differ/i,
  );
  assert.throws(
    () => selectAuthorisedAffectedPartitions(inventory.slice(0, -2), {
      expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
    }),
    /exactly 294/i,
  );
  const wrongConnectorDistribution = authorisedInventory();
  wrongConnectorDistribution[0] = {
    ...wrongConnectorDistribution[0],
    scope: { ...wrongConnectorDistribution[0].scope, connector_id: 2 },
  };
  assert.throws(
    () => selectAuthorisedAffectedPartitions(wrongConnectorDistribution, {
      expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
    }),
    /connector totals differ/i,
  );
  const wrongPollutantScope = authorisedInventory();
  wrongPollutantScope[0] = {
    ...wrongPollutantScope[0],
    scope: { ...wrongPollutantScope[0].scope, pollutant_code: "changed_pollutant" },
  };
  assert.throws(
    () => selectAuthorisedAffectedPartitions(wrongPollutantScope, {
      expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
    }),
    /affected-scope set differs/i,
  );
  const duplicateScope = authorisedInventory();
  duplicateScope[1] = { ...duplicateScope[1], scope: { ...duplicateScope[0].scope } };
  assert.throws(
    () => selectAuthorisedAffectedPartitions(duplicateScope, {
      expectedScopeSetSha256: DETERMINISTIC_SCOPE_FIXTURE_SHA256,
    }),
    /duplicate partition scope/i,
  );
  assert.throws(
    () => selectAuthorisedAffectedPartitions(authorisedInventory()),
    /affected-scope set differs/i,
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

  const legacyParquetKey = "history/v2/observations/day_utc=2026-09-09/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const legacyParquetBody = Buffer.from("legacy-source-parquet-body");
  const legacyParquetIdentity = {
    key: legacyParquetKey,
    byte_size: legacyParquetBody.byteLength,
    sha256: createHash("sha256").update(legacyParquetBody).digest("hex"),
  };
  const historicalEtag = "72d6d9fc012462f36e0fdac7f305e01d";
  const historicalManifestFile = {
    key: legacyParquetKey,
    bytes: legacyParquetBody.byteLength,
    etag_or_hash: `"${historicalEtag}"`,
  };
  const checksumManifestFile = {
    ...historicalManifestFile,
    etag_or_hash: legacyParquetIdentity.sha256,
  };
  const migrationR2 = (head, body) => ({
    adapter: {
      headObject: async ({ key }) => ({ key, ...head }),
      getObject: async () => ({ body }),
    },
  });
  const checksumlessLegacyR2 = migrationR2({
    exists: true,
    bytes: legacyParquetIdentity.byte_size,
    etag: historicalEtag,
    sha256: null,
  }, legacyParquetBody);
  const dropboxDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-september-source-"));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-september-outside-"));
  const dropboxParquetPath = path.join(dropboxDirectory, ...legacyParquetKey.split("/"));
  try {
    fs.mkdirSync(path.dirname(dropboxParquetPath), { recursive: true });
    fs.writeFileSync(dropboxParquetPath, legacyParquetBody);
    const verifiedLegacy = await readMigrationSourceParquetWithDropboxEvidence({
      r2: checksumlessLegacyR2,
      key: legacyParquetKey,
      manifestFile: historicalManifestFile,
      dropboxRoot: dropboxDirectory,
    });
    assert.deepEqual(
      { key: verifiedLegacy.key, byte_size: verifiedLegacy.byte_size, sha256: verifiedLegacy.sha256 },
      legacyParquetIdentity,
    );
    assert.equal(verifiedLegacy.historical_etag, historicalEtag);

    const differentR2Body = Buffer.alloc(legacyParquetBody.byteLength, 0x78);
    const verifiedChecksumManifest = await readMigrationSourceParquetWithDropboxEvidence({
      r2: migrationR2({
        exists: true,
        bytes: legacyParquetIdentity.byte_size,
        etag: '"ordinary-unrelated-etag"',
        sha256: null,
      }, legacyParquetBody),
      key: legacyParquetKey,
      manifestFile: checksumManifestFile,
      dropboxRoot: dropboxDirectory,
    });
    assert.equal(verifiedChecksumManifest.sha256, legacyParquetIdentity.sha256);
    assert.equal(verifiedChecksumManifest.historical_etag, null);

    const verifiedChecksumManifestWithStoredSha = await readMigrationSourceParquetWithDropboxEvidence({
      r2: migrationR2({
        exists: true,
        bytes: legacyParquetIdentity.byte_size,
        etag: '"another-unrelated-etag"',
        sha256: legacyParquetIdentity.sha256,
      }, legacyParquetBody),
      key: legacyParquetKey,
      manifestFile: checksumManifestFile,
      dropboxRoot: dropboxDirectory,
    });
    assert.equal(verifiedChecksumManifestWithStoredSha.sha256, legacyParquetIdentity.sha256);

    fs.writeFileSync(dropboxParquetPath, differentR2Body);
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: legacyParquetKey,
        manifestFile: checksumManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /Manifest Parquet SHA-256 disagrees with Dropbox/i,
    );
    fs.writeFileSync(dropboxParquetPath, legacyParquetBody);

    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: migrationR2({
          exists: true,
          bytes: legacyParquetIdentity.byte_size,
          etag: '"ordinary-unrelated-etag"',
          sha256: "0".repeat(64),
        }, legacyParquetBody),
        key: legacyParquetKey,
        manifestFile: checksumManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /stored SHA-256 disagrees with Dropbox/i,
    );

    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: migrationR2({
          exists: true, bytes: legacyParquetIdentity.byte_size, etag: `"${historicalEtag}"`, sha256: null,
        }, differentR2Body),
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /R2 GET disagrees with Dropbox/i,
    );

    fs.writeFileSync(dropboxParquetPath, Buffer.concat([legacyParquetBody, Buffer.from("x")]));
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /Dropbox source Parquet.*byte-size mismatch/i,
    );
    fs.writeFileSync(dropboxParquetPath, legacyParquetBody);

    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: migrationR2({
          exists: true, bytes: legacyParquetIdentity.byte_size + 1, etag: historicalEtag, sha256: null,
        }, legacyParquetBody),
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /R2 HEAD byte-size mismatch/i,
    );
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: migrationR2({
          exists: true, bytes: legacyParquetIdentity.byte_size, etag: '"different-etag"', sha256: null,
        }, legacyParquetBody),
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /historical ETag mismatch/i,
    );
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: migrationR2({
          exists: true, bytes: legacyParquetIdentity.byte_size, etag: historicalEtag, sha256: "0".repeat(64),
        }, legacyParquetBody),
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /stored SHA-256 disagrees with Dropbox/i,
    );

    const storedChecksumR2 = migrationR2({
      exists: true,
      bytes: legacyParquetIdentity.byte_size,
      etag: `"${historicalEtag}"`,
      sha256: legacyParquetIdentity.sha256,
    }, legacyParquetBody);
    const verifiedStoredChecksum = await readMigrationSourceParquetWithDropboxEvidence({
      r2: storedChecksumR2,
      key: legacyParquetKey,
      manifestFile: historicalManifestFile,
      dropboxRoot: dropboxDirectory,
    });
    assert.equal(verifiedStoredChecksum.sha256, legacyParquetIdentity.sha256);

    fs.unlinkSync(dropboxParquetPath);
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /missing or unreadable/i,
    );
    fs.mkdirSync(dropboxParquetPath);
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /missing, unreadable, or has a byte-size mismatch/i,
    );
    fs.rmdirSync(dropboxParquetPath);
    fs.writeFileSync(dropboxParquetPath, legacyParquetBody);

    const escapingKey = "../escape.parquet";
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: escapingKey,
        manifestFile: { ...historicalManifestFile, key: escapingKey },
        dropboxRoot: dropboxDirectory,
      }),
      /escapes configured root/i,
    );

    const outsideParquetPath = path.join(outsideDirectory, "outside.parquet");
    fs.writeFileSync(outsideParquetPath, legacyParquetBody);
    fs.unlinkSync(dropboxParquetPath);
    fs.symlinkSync(outsideParquetPath, dropboxParquetPath);
    await assert.rejects(
      () => readMigrationSourceParquetWithDropboxEvidence({
        r2: checksumlessLegacyR2,
        key: legacyParquetKey,
        manifestFile: historicalManifestFile,
        dropboxRoot: dropboxDirectory,
      }),
      /escapes configured root/i,
    );
  } finally {
    fs.rmSync(dropboxDirectory, { recursive: true, force: true });
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }

  assert.deepEqual(
    await readMigrationCurrentIdentity(checksumlessLegacyR2, legacyParquetKey, legacyParquetIdentity),
    legacyParquetIdentity,
  );
  const targetParquetBody = Buffer.from("canonical-target-parquet");
  const targetParquetIdentity = {
    key: legacyParquetKey,
    byte_size: targetParquetBody.byteLength,
    sha256: createHash("sha256").update(targetParquetBody).digest("hex"),
  };
  const storedTargetR2 = migrationR2({
    exists: true,
    bytes: targetParquetIdentity.byte_size,
    sha256: targetParquetIdentity.sha256,
  }, targetParquetBody);
  assert.deepEqual(
    await readMigrationCurrentIdentity(storedTargetR2, legacyParquetKey, legacyParquetIdentity),
    targetParquetIdentity,
  );
  const thirdBody = Buffer.alloc(legacyParquetBody.byteLength, 0x78);
  await assert.rejects(
    () => readMigrationCurrentIdentity(
      migrationR2({ exists: true, bytes: thirdBody.byteLength, sha256: null }, thirdBody),
      legacyParquetKey,
      legacyParquetIdentity,
    ),
    /GET identity mismatch/i,
  );
  await assert.rejects(
    () => readMigrationTargetObjectStrict(
      checksumlessLegacyR2,
      legacyParquetKey,
      legacyParquetIdentity,
    ),
    /Strong stored R2 identity unavailable/i,
  );
  const strictTarget = await readMigrationTargetObjectStrict(
    storedTargetR2,
    legacyParquetKey,
    targetParquetIdentity,
  );
  assert.equal(strictTarget.sha256, targetParquetIdentity.sha256);

  const checkpointDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-september-repair-"));
  try {
    const checkpointPath = path.join(checkpointDirectory, "root.json");
    const checkpointBody = Buffer.from('{"checkpoint":"pinned"}\n');
    fs.writeFileSync(checkpointPath, checkpointBody);
    const checkpointSha256 = createHash("sha256").update(checkpointBody).digest("hex");
    const applyPlanFixture = {
      plan_sha256: "a".repeat(64),
      backup_evidence: {
        checkpoint: {
          path: checkpointPath,
          byte_size: checkpointBody.byteLength,
          sha256: checkpointSha256,
        },
        readiness: { backup_run_id: "pinned-backup-run" },
      },
      pre_migration_observations_root: { content_hash: "pre-migration-root" },
    };
    const applyArgsFixture = { planPath: path.join(checkpointDirectory, "plan.json") };
    const firstApplyEvents = [];
    const firstJournal = await prepareApplyInvocation({
      plan: applyPlanFixture,
      args: applyArgsFixture,
      env: {},
      r2: {},
      lockContext: {},
      dependencies: {
        loadJournal: () => { firstApplyEvents.push("load-journal"); return null; },
        backupGate: async () => {
          firstApplyEvents.push("backup-gate");
          return {
            checkpoint: { sha256: checkpointSha256 },
            live_observations_root: { content_hash: "pre-migration-root" },
            readiness: { backup_run_id: "pinned-backup-run" },
          };
        },
        assertOldOrTargetPrestate: async () => { firstApplyEvents.push("old-or-target"); },
        saveJournal: () => { firstApplyEvents.push("save-journal"); },
      },
    });
    assert.equal(firstJournal.initial_gate_verified, true);
    assert.deepEqual(firstApplyEvents, ["load-journal", "backup-gate", "old-or-target", "save-journal"]);

    const resumedJournal = { ...firstJournal, verified_objects: { already: "partial-target" } };
    let resumedPrestateChecks = 0;
    const resumed = await prepareApplyInvocation({
      plan: applyPlanFixture,
      args: applyArgsFixture,
      env: {},
      r2: { observations_root: "partially-migrated-target" },
      lockContext: {},
      dependencies: {
        loadJournal: () => resumedJournal,
        backupGate: async () => { throw new Error("resumed APPLY must not run the live-root backup gate"); },
        assertOldOrTargetPrestate: async () => { resumedPrestateChecks += 1; },
        saveJournal: () => { throw new Error("resumed APPLY must not replace its journal"); },
      },
    });
    assert.equal(resumed, resumedJournal);
    assert.equal(resumedPrestateChecks, 1);

    fs.writeFileSync(checkpointPath, Buffer.from("changed"));
    let changedCheckpointLoadedJournal = false;
    await assert.rejects(
      () => prepareApplyInvocation({
        plan: applyPlanFixture,
        args: applyArgsFixture,
        env: {},
        r2: {},
        lockContext: {},
        dependencies: {
          loadJournal: () => { changedCheckpointLoadedJournal = true; return resumedJournal; },
        },
      }),
      /Pinned Dropbox checkpoint changed/i,
    );
    assert.equal(changedCheckpointLoadedJournal, false);

    fs.unlinkSync(checkpointPath);
    for (const journal of [null, resumedJournal]) {
      await assert.rejects(
        () => prepareApplyInvocation({
          plan: applyPlanFixture,
          args: applyArgsFixture,
          env: {},
          r2: {},
          lockContext: {},
          dependencies: { loadJournal: () => journal },
        }),
        /Pinned Dropbox checkpoint is missing or unreadable/i,
      );
    }
  } finally {
    fs.rmSync(checkpointDirectory, { recursive: true, force: true });
  }

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
