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
  rowsToObservationV2ParquetBufferForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { runV2ObservationsRepair } from "../scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs";
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

function canonicalPollutant(connectorId, pollutantCode) {
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
  const pm10Bytes = rowsToObservationV2ParquetBufferForTest([
    { connector_id: connectorId, station_id: 70, timeseries_id: 700, pollutant_code: "pm10", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 10 },
    { connector_id: connectorId, station_id: 70, timeseries_id: 700, pollutant_code: "pm10", observed_at_utc: `${DAY}T01:00:00.000Z`, value: 11 },
  ]);
  const pm25Bytes = rowsToObservationV2ParquetBufferForTest([
    { connector_id: connectorId, station_id: 71, timeseries_id: 701, pollutant_code: "pm25", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 5 },
    { connector_id: connectorId, station_id: 71, timeseries_id: 701, pollutant_code: "pm25", observed_at_utc: `${DAY}T01:00:00.000Z`, value: 6 },
  ]);
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
      /cannot preserve baseline objects/,
    );
  } finally {
    resolver.cleanup();
  }
});
