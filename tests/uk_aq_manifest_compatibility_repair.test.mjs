import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
  rowsToObservationV2LegacyParquetBufferForTest,
  rowsToObservationV2ParquetBufferForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V2,
  OBSERVATION_HISTORY_COLUMNS_V2_STATUS,
  OBSERVATION_HISTORY_COLUMNS_V3,
  observationHistoryPhysicalSchemaForColumns,
} from "../workers/shared/uk_aq_observation_history_schema.mjs";
import { runV2ObservationsRepair } from "../scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs";
import {
  observationContentHashFromLocalParquet,
} from "../scripts/backup_r2/lib/uk_aq_observation_parquet_content_hash.mjs";
import {
  classifyRepairableV2ObservationsConnectorManifest,
  validateV2ObservationsChildManifest,
} from "../workers/uk_aq_backfill_local/r2_history/manifest_validation.mjs";

const DAY = "2026-07-12";
const PREFIX = "history/v2/observations";

function resolverFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-manifest-compatibility-"));
  const overlayRoot = path.join(root, "overlay");
  const dropboxRoot = path.join(root, "dropbox");
  const runStateJson = path.join(root, "run-state.json");
  fs.mkdirSync(overlayRoot, { recursive: true });
  fs.mkdirSync(dropboxRoot, { recursive: true });
  fs.writeFileSync(runStateJson, JSON.stringify({ objects: {}, tombstones: {} }));
  return {
    env: {
      UK_AQ_ENV_NAME: "CIC-Test",
      CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
      CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
      CFLARE_R2_ACCESS_KEY_ID: "unused",
      CFLARE_R2_SECRET_ACCESS_KEY: "unused",
      UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT: overlayRoot,
      UK_AQ_R2_HISTORY_DROPBOX_ROOT: dropboxRoot,
      UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON: runStateJson,
    },
    overlayRoot,
    dropboxRoot,
    runStateJson,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeObjects(root, objects) {
  for (const [key, value] of Object.entries(objects)) {
    const target = path.join(root, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}

function dayRepairPlan() {
  return {
    history_version: "v2",
    domain: "observations",
    repair_plan: [{
      kind: "observation_day_manifest_repair",
      status: "planned",
      executes: false,
      data_changes_required: false,
      operator_action_required: false,
      day_utc: DAY,
      connector_id: null,
      pollutant_code: null,
      requires_index_rebuild: false,
      gap_types: ["day_manifest_schema_mismatch"],
    }],
  };
}

function canonicalPollutant(connectorId, pollutantCode, physicalSchema = null) {
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
  return buildHistoryV2PollutantManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId,
    pollutantCode,
    runId: "fixture",
    manifestKey: key,
    sourceRowCount: 1,
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
    observationContentHash: {
      observation_content_hash: "0".repeat(64),
      observation_content_hash_algorithm: "sha256",
      observation_content_hash_contract_version: 1,
      observation_content_hash_row_count: 1,
      observation_content_hash_columns: [
        "connector_id",
        "station_id",
        "timeseries_id",
        "pollutant_code",
        "observed_at_utc",
        "value",
        "verification_status",
      ],
      verification_status_counts: { P: 0, R: 0, null: 1 },
    },
    physicalSchema,
    fileEntries: [{
      key: key.replace("manifest.json", "part-00000.parquet"),
      bytes: 10,
      row_count: 1,
      etag_or_hash: "fixture",
      min_timeseries_id: connectorId * 100,
      max_timeseries_id: connectorId * 100,
      min_observed_at_utc: `${DAY}T00:00:00.000Z`,
      max_observed_at_utc: `${DAY}T00:00:00.000Z`,
      timeseries_row_counts: { [connectorId * 100]: 1 },
    }],
  });
}

test("observation manifests distinguish manifest contract from physical schema", () => {
  const schema2 = canonicalPollutant(
    7,
    "pm10",
    observationHistoryPhysicalSchemaForColumns(OBSERVATION_HISTORY_COLUMNS_V2),
  );
  const schema2Status = canonicalPollutant(
    7,
    "no2",
    observationHistoryPhysicalSchemaForColumns(
      OBSERVATION_HISTORY_COLUMNS_V2_STATUS,
    ),
  );
  const schema3 = canonicalPollutant(7, "pm25");
  assert.equal(schema2.manifest_schema_version, 3);
  assert.equal(schema2.history_schema_version, 2);
  assert.deepEqual(schema2.columns, OBSERVATION_HISTORY_COLUMNS_V2);
  assert.equal(schema2.writer_version, "parquet-wasm-zstd-v2");
  assert.equal(schema3.manifest_schema_version, 3);
  assert.equal(schema3.history_schema_version, 3);
  assert.deepEqual(schema3.columns, OBSERVATION_HISTORY_COLUMNS_V3);
  assert.equal(schema3.writer_version, "parquet-wasm-zstd-v3");
  for (const manifest of [schema2, schema2Status, schema3]) {
    assert.equal(
      validateV2ObservationsChildManifest(manifest, {
        key: manifest.manifest_key,
        kind: "pollutant",
        dayUtc: DAY,
        connectorId: 7,
      }).ok,
      true,
    );
  }

  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=7/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 7,
    runId: "fixture",
    manifestKey: connectorKey,
    pollutantManifests: [schema2, schema3],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  assert.equal(connector.history_schema_version, null);
  assert.equal(connector.columns, null);
  assert.equal(connector.writer_version, null);
  assert.deepEqual(
    connector.physical_schemas.map((value) => value.history_schema_version),
    [2, 3],
  );
  assert.equal(
    validateV2ObservationsChildManifest(connector, {
      key: connectorKey,
      kind: "connector",
      dayUtc: DAY,
      connectorId: 7,
    }).ok,
    true,
  );

  const malformedPollutant = {
    ...schema3,
    history_schema_version: null,
    columns: null,
    writer_version: null,
    physical_schemas: connector.physical_schemas,
  };
  delete malformedPollutant.manifest_hash;
  malformedPollutant.manifest_hash = createHash("sha256")
    .update(JSON.stringify(malformedPollutant))
    .digest("hex");
  const malformedValidation = validateV2ObservationsChildManifest(
    malformedPollutant,
    {
      key: malformedPollutant.manifest_key,
      kind: "pollutant",
      dayUtc: DAY,
      connectorId: 7,
    },
  );
  assert.equal(malformedValidation.ok, false);
  assert.ok(
    malformedValidation.failures.includes(
      "pollutant_physical_schemas_mixed",
    ),
  );
  assert.equal(
    malformedValidation.failures.includes("manifest_hash_mismatch"),
    false,
  );
  assert.equal(
    malformedValidation.stored_manifest_hash,
    malformedValidation.expected_manifest_hash,
  );

  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`,
    connectorManifests: [connector],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  assert.equal(day.history_schema_version, null);
  assert.equal(day.columns, null);
  assert.equal(day.writer_version, null);
  assert.deepEqual(
    day.physical_schemas.map((value) => value.history_schema_version),
    [2, 3],
  );
});

test("validator reports exact legacy connector contract failures", () => {
  const pollutant = canonicalPollutant(7, "pm10");
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=7/manifest.json`;
  const legacy = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 7,
    runId: "fixture",
    manifestKey: key,
    pollutantManifests: [pollutant],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  delete legacy.grain;
  delete legacy.profile;
  legacy.legacy_field = true;
  const validation = validateV2ObservationsChildManifest(legacy, {
    key,
    kind: "connector",
    dayUtc: DAY,
    connectorId: 7,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.failures.includes("grain_not_explicit_null"));
  assert.ok(validation.failures.includes("profile_not_explicit_null"));
  assert.ok(validation.failures.includes("manifest_hash_mismatch"));
  const classification = classifyRepairableV2ObservationsConnectorManifest(legacy, {
    key,
    dayUtc: DAY,
    connectorId: 7,
  });
  assert.equal(classification.repairable, true);
  assert.deepEqual(classification.identity_failures, []);
});

test("day repair normalises legacy pollutant paths before connector and day parents", async () => {
  const connectorId = 7;
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`;
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const pm10Prefix = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant=pm10`;
  const pm25Prefix = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant=pm2.5`;
  const pm10Rows = [
    { connector_id: connectorId, station_id: 70, timeseries_id: 700, pollutant_code: "pm10", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 10 },
    { connector_id: connectorId, station_id: 70, timeseries_id: 700, pollutant_code: "pm10", observed_at_utc: `${DAY}T01:00:00.000Z`, value: 11 },
  ];
  const pm25Rows = [
    { connector_id: connectorId, station_id: 71, timeseries_id: 701, pollutant_code: "pm25", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 5 },
    { connector_id: connectorId, station_id: 71, timeseries_id: 701, pollutant_code: "pm25", observed_at_utc: `${DAY}T01:00:00.000Z`, value: 6 },
  ];
  const pm10Bytes = rowsToObservationV2LegacyParquetBufferForTest(pm10Rows);
  const pm25Bytes = rowsToObservationV2LegacyParquetBufferForTest(pm25Rows);
  const legacy = {
    created_at_utc: "2026-07-17T14:07:48Z",
    current_prefix: `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/`,
    dataset: "observations",
    history_version: "v2",
    day_utc: DAY,
    connector_id: connectorId,
    pollutant_code: null,
    files: [],
    row_count: 4,
    total_bytes: pm10Bytes.byteLength + pm25Bytes.byteLength,
    file_count: 2,
    manifest_schema_version: 2,
    manifest_kind: "connector",
    domain: "observations",
    complete: true,
    writer: "uk_aq_prune_daily",
    writer_git_sha: null,
    generation_id: "legacy-generation",
    min_tseries_id: 700,
    max_tseries_id: 701,
    min_observed_at: `${DAY}T00:00:00Z`,
    max_observed_at: `${DAY}T01:00:00Z`,
    pollutant_manifests: [
      { pollutant_code: "pm10", manifest_key: `${pm10Prefix}/manifest.json`, row_count: 2, file_count: 1, total_bytes: pm10Bytes.byteLength },
      { pollutant_code: "pm2.5", manifest_key: `${pm25Prefix}/manifest.json`, row_count: 2, file_count: 1, total_bytes: pm25Bytes.byteLength },
    ],
  };
  legacy.manifest_hash = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
  const resolver = resolverFixture();
  try {
    writeObjects(resolver.dropboxRoot, {
      [connectorKey]: JSON.stringify(legacy, null, 2),
      [dayKey]: JSON.stringify({ history_version: "v2", domain: "observations", manifest_kind: "day", day_utc: DAY }, null, 2),
      [`${pm10Prefix}/part-00000.parquet`]: pm10Bytes,
      [`${pm25Prefix}/part-00000.parquet`]: pm25Bytes,
      [`${pm10Prefix}/manifest.json`]: JSON.stringify({ created_at_utc: legacy.created_at_utc, pollutant_code: "pm10" }),
      [`${pm25Prefix}/manifest.json`]: JSON.stringify({ created_at_utc: legacy.created_at_utc, pollutant_code: "pm2.5" }),
    });
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: dayRepairPlan(),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const keys = output.planning.proposals.map((proposal) => proposal.key);
    const pm10Key = `${PREFIX}/day_utc=${DAY}/connector_id=7/pollutant_code=pm10/manifest.json`;
    const pm25Key = `${PREFIX}/day_utc=${DAY}/connector_id=7/pollutant_code=pm25/manifest.json`;
    assert.ok(keys.includes(pm10Key));
    assert.ok(keys.includes(pm25Key));
    assert.ok(keys.includes(connectorKey));
    assert.ok(keys.includes(dayKey));
    assert.equal(keys.some((key) => key.endsWith(".parquet")), false);
    assert.deepEqual(
      fs.readFileSync(path.join(resolver.dropboxRoot, `${pm10Prefix}/part-00000.parquet`)),
      pm10Bytes,
    );
    const repairedPm10 = JSON.parse(
      output.planning.proposals.find((proposal) => proposal.key === pm10Key).proposed_body,
    );
    assert.equal(repairedPm10.manifest_schema_version, 3);
    assert.equal(repairedPm10.history_schema_version, 2);
    assert.deepEqual(repairedPm10.columns, OBSERVATION_HISTORY_COLUMNS_V2);
    assert.equal(repairedPm10.writer_version, "parquet-wasm-zstd-v2");
    const v3Path = path.join(resolver.dropboxRoot, "equivalent-v3.parquet");
    fs.writeFileSync(v3Path, rowsToObservationV2ParquetBufferForTest(pm10Rows));
    const [schema2Hash, schema3Hash] = await Promise.all([
      observationContentHashFromLocalParquet({
        filePaths: [path.join(resolver.dropboxRoot, `${pm10Prefix}/part-00000.parquet`)],
        connectorId,
      }),
      observationContentHashFromLocalParquet({
        filePaths: [v3Path],
        connectorId,
      }),
    ]);
    assert.equal(
      schema2Hash.observation_content_hash,
      schema3Hash.observation_content_hash,
    );
    assert.deepEqual(
      schema2Hash.verification_status_counts,
      schema3Hash.verification_status_counts,
    );
    const connectorProposal = output.planning.proposals.find((proposal) => proposal.key === connectorKey);
    const repairedConnector = JSON.parse(connectorProposal.proposed_body);
    assert.deepEqual(repairedConnector.pollutant_codes, ["pm10", "pm25"]);
    assert.equal(repairedConnector.row_count, 4);
    assert.equal(repairedConnector.file_count, 2);
    const repairedDay = JSON.parse(
      output.planning.proposals.find((proposal) => proposal.key === dayKey).proposed_body,
    );
    assert.equal(
      repairedDay.child_manifests.find((entry) => entry.connector_id === 7).manifest_hash,
      repairedConnector.manifest_hash,
    );
    const runState = JSON.parse(fs.readFileSync(resolver.runStateJson, "utf8"));
    assert.equal(runState.objects[pm10Key].structurally_validated, true);
    assert.equal(runState.objects[pm25Key].structurally_validated, true);
    assert.equal(runState.objects[connectorKey].source, "canonical_connector_manifest_proposal");
  } finally {
    resolver.cleanup();
  }
});

test("stale nonexistent canonical child is removed by metadata-only parent discovery", async () => {
  const connectorId = 7;
  const pm10 = canonicalPollutant(connectorId, "pm10");
  const staleC2h6 = canonicalPollutant(connectorId, "c2h6");
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`;
  const staleConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId,
    runId: "fixture",
    manifestKey: connectorKey,
    pollutantManifests: [pm10, staleC2h6],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const staleDay = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    runId: "fixture",
    manifestKey: dayKey,
    connectorManifests: [staleConnector],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  const resolver = resolverFixture();
  try {
    writeObjects(resolver.dropboxRoot, {
      [pm10.manifest_key]: JSON.stringify(pm10, null, 2),
      [connectorKey]: JSON.stringify(staleConnector, null, 2),
      [dayKey]: JSON.stringify(staleDay, null, 2),
    });
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: dayRepairPlan(),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const proposalKeys = output.planning.proposals.map((proposal) => proposal.key);
    assert.equal(proposalKeys.some((key) => key.includes("pollutant_code=c2h6")), false);
    assert.equal(proposalKeys.some((key) => key.endsWith(".parquet")), false);
    assert.deepEqual(
      proposalKeys.sort(),
      [connectorKey, dayKey].sort(),
    );
    const repairedConnector = JSON.parse(
      output.planning.proposals.find((proposal) => proposal.key === connectorKey).proposed_body,
    );
    assert.deepEqual(repairedConnector.pollutant_codes, ["pm10"]);
    assert.equal(
      output.planning.proposals.some((proposal) => proposal.kind === "pollutant_manifest"),
      false,
    );
  } finally {
    resolver.cleanup();
  }
});

test("real canonical data directory without a manifest remains fail-closed", async () => {
  const connectorId = 7;
  const pm10 = canonicalPollutant(connectorId, "pm10");
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId,
    runId: "fixture",
    manifestKey: connectorKey,
    pollutantManifests: [pm10],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    runId: "fixture",
    manifestKey: dayKey,
    connectorManifests: [connector],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  const resolver = resolverFixture();
  try {
    writeObjects(resolver.dropboxRoot, {
      [pm10.manifest_key]: JSON.stringify(pm10, null, 2),
      [connectorKey]: JSON.stringify(connector, null, 2),
      [dayKey]: JSON.stringify(day, null, 2),
      [`${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=c2h6/part-00000.parquet`]: "real-unrepresented-data",
    });
    await assert.rejects(
      () => runV2ObservationsRepair({ env: resolver.env, repairPlan: dayRepairPlan() }),
      /current canonical pollutant data has no manifest.*pollutant_code=c2h6/,
    );
  } finally {
    resolver.cleanup();
  }
});

test("legacy connector repair remains fail-closed when baseline data is not represented", async () => {
  const pm10 = canonicalPollutant(7, "pm10");
  const pm25 = canonicalPollutant(7, "pm25");
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=7/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY,
    connectorId: 7,
    runId: "fixture",
    manifestKey: connectorKey,
    pollutantManifests: [pm10, pm25],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  delete connector.grain;
  delete connector.profile;
  connector.legacy_field = true;
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: DAY,
    runId: "fixture",
    manifestKey: dayKey,
    connectorManifests: [connector],
    writerGitSha: null,
    backedUpAtUtc: "2026-07-17T14:07:48.000Z",
  });
  const resolver = resolverFixture();
  try {
    writeObjects(resolver.dropboxRoot, {
      [pm10.manifest_key]: JSON.stringify(pm10, null, 2),
      [pm25.parquet_object_keys[0]]: "unrepresented-baseline-parquet",
      [connectorKey]: JSON.stringify(connector, null, 2),
      [dayKey]: JSON.stringify(day, null, 2),
    });
    await assert.rejects(
      () => runV2ObservationsRepair({ env: resolver.env, repairPlan: dayRepairPlan() }),
      /cannot preserve baseline objects|canonical pollutant manifest unavailable|current canonical pollutant data has no manifest/,
    );
  } finally {
    resolver.cleanup();
  }
});
