import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  applyStagedProposals,
  normalizePlan,
  runV2ObservationsRepair,
} from "../scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs";
import { buildHistoryV2TimeseriesMetadataIndexPayload } from "../workers/shared/uk_aq_r2_history_index.mjs";

const DAY = "2026-05-17";
const PREFIX = "history/v2/observations";
const ENV = {
  UK_AQ_ENV_NAME: "CIC-Test",
  CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
  CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
  CFLARE_R2_ACCESS_KEY_ID: "key",
  CFLARE_R2_SECRET_ACCESS_KEY: "secret",
};
let parquetWasmInitialized = false;

function observationParquet(rows) {
  if (!parquetWasmInitialized) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const wasmPath = path.resolve(moduleDirectory, "../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
    parquetWasm.initSync({ module: fs.readFileSync(wasmPath) });
    parquetWasmInitialized = true;
  }
  const table = arrow.tableFromArrays({
    timeseries_id: rows.map((row) => row.timeseries_id),
    observed_at_utc: rows.map((row) => new Date(row.observed_at_utc)),
  });
  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const properties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.UNCOMPRESSED)
    .build();
  return Buffer.from(parquetWasm.writeParquet(wasmTable, properties));
}

function repairAction(overrides = {}) {
  return {
    kind: "observation_connector_manifest_repair",
    status: "planned",
    executes: false,
    data_changes_required: false,
    operator_action_required: false,
    day_utc: DAY,
    connector_id: 1,
    pollutant_code: "o3",
    requires_index_rebuild: false,
    gap_types: ["connector_manifest_missing"],
    ...overrides,
  };
}

function observationsRepairPlan(action = repairAction()) {
  return { history_version: "v2", domain: "observations", repair_plan: [action] };
}

function combinedResolverEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-index-test-"));
  const overlayRoot = path.join(root, "overlay");
  const dropboxRoot = path.join(root, "dropbox");
  const runStateJson = path.join(root, "run-state.json");
  fs.mkdirSync(overlayRoot, { recursive: true });
  fs.mkdirSync(dropboxRoot, { recursive: true });
  fs.writeFileSync(runStateJson, JSON.stringify({ objects: {}, tombstones: {} }));
  return {
    env: {
      ...ENV,
      UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT: overlayRoot,
      UK_AQ_R2_HISTORY_DROPBOX_ROOT: dropboxRoot,
      UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON: runStateJson,
    },
    dropboxRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeCombinedDropboxFixture(resolver, objects) {
  for (const [key, body] of Object.entries(objects)) {
    const target = path.join(resolver.dropboxRoot, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

test("whole-day manifest actions remain connector-less and reject a connector subset", () => {
  const valid = normalizePlan(observationsRepairPlan(repairAction({
    kind: "observation_day_manifest_repair",
    connector_id: null,
    pollutant_code: null,
    requires_index_rebuild: false,
  })));
  assert.deepEqual(valid.scopes, [{
    dayUtc: DAY,
    connectorId: null,
    needsConnector: false,
    needsDay: true,
    needsIndex: false,
    pollutantRepair: false,
    gap_types: ["connector_manifest_missing"],
    pollutant_codes: [],
    index_pollutant_codes: [],
  }]);
  assert.throws(
    () => normalizePlan(observationsRepairPlan(repairAction({ kind: "observation_day_manifest_repair" }))),
    /must have day_utc and no connector_id/,
  );
});

test("an index-only action does not become a pollutant-manifest repair", () => {
  const plan = normalizePlan(observationsRepairPlan(repairAction({
    kind: "observation_index_repair",
    connector_id: 1,
    pollutant_code: "o3",
    requires_index_rebuild: true,
  })));
  assert.equal(plan.scopes[0].pollutantRepair, false);
  assert.deepEqual(plan.scopes[0].pollutant_codes, []);
  assert.deepEqual(plan.scopes[0].index_pollutant_codes, ["o3"]);
});

test("an AQI day-manifest action does not expand into child indexes", () => {
  const plan = normalizePlan({
    history_version: "v2",
    domain: "aqilevels",
    repair_plan: [repairAction({
      kind: "aqi_day_manifest_repair",
      connector_id: null,
      pollutant_code: null,
      requires_index_rebuild: false,
    })],
  });
  assert.equal(plan.scopes[0].needsDay, true);
  assert.equal(plan.scopes[0].needsIndex, false);
  assert.equal(plan.scopes[0].connectorId, null);
});

test("AQI day-only repair retains all connectors without pollutant proposals", async () => {
  const aqiPrefix = "history/v2/aqilevels/hourly/data";
  const connectorIds = [1, 3, 6, 7];
  const connectors = connectorIds.map((connectorId) => {
    const pollutantCode = "pm25";
    const manifestKey = `${aqiPrefix}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
    const pollutant = buildHistoryV2PollutantManifest({
      domain: "aqilevels", grain: "hourly", profile: "data", dayUtc: DAY, connectorId, pollutantCode,
      runId: "fixture", manifestKey, sourceRowCount: 1, writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
      fileEntries: [{ key: manifestKey.replace("manifest.json", "part-00000.parquet"), bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: connectorId, max_timeseries_id: connectorId, min_timestamp_hour_utc: `${DAY}T00:00:00.000Z`, max_timestamp_hour_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { [connectorId]: 1 } }],
    });
    const connectorKey = `${aqiPrefix}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`;
    const manifest = buildHistoryV2ConnectorManifest({
      domain: "aqilevels", grain: "hourly", profile: "data", dayUtc: DAY, connectorId, runId: "fixture", manifestKey: connectorKey,
      pollutantManifests: [pollutant], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
    });
    return { pollutant, manifest };
  });
  const dayKey = `${aqiPrefix}/day_utc=${DAY}/manifest.json`;
  const staleDay = buildHistoryV2DayManifest({
    domain: "aqilevels", grain: "hourly", profile: "data", dayUtc: DAY, runId: "fixture", manifestKey: dayKey,
    connectorManifests: [connectors[0].manifest], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const objects = Object.fromEntries([
    ...connectors.flatMap(({ pollutant, manifest }) => [
      [pollutant.manifest_key, JSON.stringify(pollutant, null, 2)],
      [manifest.manifest_key, JSON.stringify(manifest, null, 2)],
    ]),
    [dayKey, JSON.stringify(staleDay, null, 2)],
  ]);
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects);
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: {
        history_version: "v2",
        domain: "aqilevels",
        repair_plan: [repairAction({
          kind: "aqi_day_manifest_repair", connector_id: null, pollutant_code: null, requires_index_rebuild: false,
        })],
      },
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    assert.deepEqual(output.planning.days[0].proposal_keys, [dayKey]);
    assert.equal(output.planning.proposals.some((proposal) => proposal.kind === "pollutant_manifest"), false);
    assert.equal(JSON.parse(output.planning.proposals[0].proposed_body).grain, "hourly");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

async function assertNoR2Access(operation) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("Unexpected R2 request");
  };
  try {
    await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0, "the executor must reject the input before any R2 request");
}

function installFakeR2(objects, { beforeRequest = null, etags: initialEtags = {} } = {}) {
  const originalFetch = globalThis.fetch;
  const puts = new Map();
  const requests = [];
  const etags = new Map(Object.entries(initialEtags));
  const bodyFor = (key) => puts.get(key) || objects[key];
  const keyFromUrl = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/[^/]+\//, "");
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const prefix = parsed.searchParams.get("prefix") || "";
    const key = keyFromUrl(url);
    requests.push({ method, key, prefix });
    const override = await beforeRequest?.({ method, key, prefix, objects, puts, requests, etags });
    if (override instanceof Response) return override;
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const keys = [...new Set([...Object.keys(objects), ...puts.keys()])].filter((key) => key.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
    }
    if (method === "HEAD") return bodyFor(key) ? new Response(null, { status: 200, headers: etags.has(key) ? { etag: etags.get(key) } : {} }) : new Response(null, { status: 404 });
    if (method === "GET") return bodyFor(key) ? new Response(bodyFor(key), { status: 200, headers: etags.has(key) ? { etag: etags.get(key) } : {} }) : new Response("not found", { status: 404 });
    if (method === "PUT") { puts.set(key, String(init.body)); etags.set(key, `\"${key}\"`); return new Response("", { status: 200, headers: { etag: `\"${key}\"` } }); }
    return new Response("unsupported", { status: 405 });
  };
  return { puts, requests, etags, restore: () => { globalThis.fetch = originalFetch; } };
}

function pollutant(connectorId, code) {
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${code}/manifest.json`;
  return buildHistoryV2PollutantManifest({
    domain: "observations", dayUtc: DAY, connectorId, pollutantCode: code, runId: "fixture",
    manifestKey: key, writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z", sourceRowCount: 1,
    fileEntries: [{ key: key.replace("manifest.json", "part-00000.parquet"), bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: connectorId, max_timeseries_id: connectorId, min_observed_at_utc: `${DAY}T00:00:00.000Z`, max_observed_at_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { [connectorId]: 1 } }],
  });
}

function pollutantForTimeseries(connectorId, code, timeseriesId) {
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${code}/manifest.json`;
  return buildHistoryV2PollutantManifest({
    domain: "observations", dayUtc: DAY, connectorId, pollutantCode: code, runId: "fixture",
    manifestKey: key, writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z", sourceRowCount: 1,
    fileEntries: [{ key: key.replace("manifest.json", "part-00000.parquet"), bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: timeseriesId, max_timeseries_id: timeseriesId, min_observed_at_utc: `${DAY}T00:00:00.000Z`, max_observed_at_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { [timeseriesId]: 1 } }],
  });
}

test("missing observation pollutant manifests are rebuilt from canonical readable parquet evidence", async () => {
  const o3 = pollutant(1, "o3");
  const pm25Key = `${PREFIX}/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/manifest.json`;
  const pm25PartKey = pm25Key.replace("manifest.json", "part-00000.parquet");
  const pm25Part = observationParquet([
    { timeseries_id: 101, observed_at_utc: `${DAY}T00:01:00.000Z` },
    { timeseries_id: 101, observed_at_utc: `${DAY}T00:02:00.000Z` },
    { timeseries_id: 102, observed_at_utc: `${DAY}T00:03:00.000Z` },
  ]);
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`;
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: connectorKey,
    pollutantManifests: [o3], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: dayKey,
    connectorManifests: [connector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const objects = {
    [o3.manifest_key]: JSON.stringify(o3, null, 2),
    [pm25PartKey]: pm25Part,
    [connectorKey]: JSON.stringify(connector, null, 2),
    [dayKey]: JSON.stringify(day, null, 2),
  };
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects);
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_pollutant_manifest_repair",
        connector_id: 1,
        pollutant_code: "pm25",
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.planning.blocked_scopes));
    const leaf = output.planning.proposals.find((proposal) => proposal.key === pm25Key);
    assert.ok(leaf, "the missing leaf manifest must be proposed");
    const payload = JSON.parse(leaf.proposed_body);
    assert.equal(payload.grain, null);
    assert.equal(payload.profile, null);
    assert.equal(payload.source_row_count, 3);
    assert.deepEqual(payload.parquet_object_keys, [pm25PartKey]);
    assert.deepEqual(payload.timeseries_row_counts, { 101: 2, 102: 1 });
    assert.equal(payload.min_observed_at_utc, `${DAY}T00:01:00.000Z`);
    assert.equal(payload.max_observed_at_utc, `${DAY}T00:03:00.000Z`);
    assert.equal(leaf.provenance.source, "parent_manifest_metadata");
    assert.deepEqual(output.planning.days[0].proposal_keys, [connectorKey, dayKey, pm25Key].sort());
    assert.equal(fake.puts.size, 0, "a dry run never writes parquet or metadata");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("shared v2 manifest builders retain explicit observation and AQI grain/profile contracts", () => {
  const observationManifest = pollutant(1, "pm25");
  assert.equal(Object.hasOwn(observationManifest, "grain"), true);
  assert.equal(Object.hasOwn(observationManifest, "profile"), true);
  assert.equal(observationManifest.grain, null);
  assert.equal(observationManifest.profile, null);

  const aqiManifest = buildHistoryV2PollutantManifest({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    dayUtc: DAY,
    connectorId: 1,
    pollutantCode: "pm25",
    runId: "fixture",
    manifestKey: `history/v2/aqilevels/hourly/data/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/manifest.json`,
    writerGitSha: "fixture",
    backedUpAtUtc: "2026-05-18T00:00:00.000Z",
    sourceRowCount: 1,
    fileEntries: [{ key: `history/v2/aqilevels/hourly/data/day_utc=${DAY}/connector_id=1/pollutant_code=pm25/part-00000.parquet`, bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: 1, max_timeseries_id: 1, min_timestamp_hour_utc: `${DAY}T00:00:00.000Z`, max_timestamp_hour_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { 1: 1 } }],
  });
  assert.equal(Object.hasOwn(aqiManifest, "grain"), true);
  assert.equal(Object.hasOwn(aqiManifest, "profile"), true);
  assert.equal(aqiManifest.grain, "hourly");
  assert.equal(aqiManifest.profile, "data");
});

function twoConnectorFixture() {
  const c1o3 = pollutant(1, "o3");
  const c1pm25 = pollutant(1, "pm25");
  const c2no2 = pollutant(2, "no2");
  const c2pm10 = pollutant(2, "pm10");
  const staleC1 = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [c1pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleC2 = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=2/manifest.json`, pollutantManifests: [c2no2], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleC1], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const values = [c1o3, c1pm25, c2no2, c2pm10, staleC1, staleC2, staleDay];
  return {
    objects: Object.fromEntries(values.map((value) => [value.manifest_key, JSON.stringify(value, null, 2)])),
    keys: { c1: staleC1.manifest_key, c2: staleC2.manifest_key, day: staleDay.manifest_key },
  };
}

test("a live-missing O3 index is proposed even when Dropbox has an identical stale copy", async () => {
  const indexKey = `history/_index_v2/observations_timeseries/day_utc=${DAY}/connector_id=1/pollutant_code=o3/manifest.json`;
  const indexBody = JSON.stringify({ source: "fixture", timeseries_row_counts: { 101: 1 } });
  const resolver = combinedResolverEnv();
  const fake = installFakeR2({});
  try {
    writeCombinedDropboxFixture(resolver, { [indexKey]: indexBody });
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_index_repair",
        connector_id: 1,
        pollutant_code: "o3",
        requires_index_rebuild: true,
      })),
      updateIndexes: async ({ r2 }) => {
        await r2.proposal_sink({ key: indexKey, body: indexBody, content_type: "application/json" });
        return { status: "planned" };
      },
    });
    const proposal = output.planning.proposals.find((candidate) => candidate.key === indexKey);
    assert.ok(proposal);
    assert.equal(proposal.old_sha256, null, "Dropbox must not provide the live target baseline");
    assert.equal(proposal.changed, true, "a missing live index cannot be skipped as unchanged");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("a Dropbox-only index source cannot leak O3 into a live connector manifest", async () => {
  const no2 = pollutant(1, "no2");
  const o3 = pollutant(1, "o3");
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`;
  const liveConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "live", manifestKey: connectorKey,
    pollutantManifests: [no2], writerGitSha: "live", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const liveDay = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "live", manifestKey: dayKey,
    connectorManifests: [liveConnector], writerGitSha: "live", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const liveObjects = {
    [no2.manifest_key]: JSON.stringify(no2, null, 2),
    [connectorKey]: JSON.stringify(liveConnector, null, 2),
    [dayKey]: JSON.stringify(liveDay, null, 2),
  };
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(liveObjects);
  try {
    writeCombinedDropboxFixture(resolver, {
      ...liveObjects,
      [o3.manifest_key]: JSON.stringify(o3, null, 2),
    });
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_connector_manifest_repair",
        connector_id: 1,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const connector = JSON.parse(output.planning.proposals.find((proposal) => proposal.key === connectorKey).proposed_body);
    assert.deepEqual(connector.pollutant_codes, ["no2"]);
    assert.equal(connector.parquet_object_keys.some((key) => key.includes("pollutant_code=o3")), false);
    assert.equal(connector.child_manifests.some((child) => child.pollutant_code === "o3"), false);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("an explicit O3 index repair uses its Dropbox leaf without making it a live hierarchy child", async () => {
  const no2 = pollutantForTimeseries(1, "no2", 101);
  const o3 = pollutantForTimeseries(1, "o3", 102);
  const connectorKey = `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`;
  const liveConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "live", manifestKey: connectorKey,
    pollutantManifests: [no2], writerGitSha: "live", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const liveDay = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "live", manifestKey: dayKey,
    connectorManifests: [liveConnector], writerGitSha: "live", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const liveObjects = {
    [no2.manifest_key]: JSON.stringify(no2, null, 2),
    [connectorKey]: JSON.stringify(liveConnector, null, 2),
    [dayKey]: JSON.stringify(liveDay, null, 2),
  };
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(liveObjects);
  try {
    writeCombinedDropboxFixture(resolver, {
      ...liveObjects,
      [o3.manifest_key]: JSON.stringify(o3, null, 2),
    });
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: {
        ...observationsRepairPlan(repairAction({
          kind: "observation_index_repair",
          connector_id: 1,
          pollutant_code: "o3",
          requires_index_rebuild: true,
        })),
        authoritative_core_timeseries: [
          { timeseries_id: 101, connector_id: 1, pollutant_code: "no2" },
          { timeseries_id: 102, connector_id: 1, pollutant_code: "o3" },
        ],
      },
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const o3Index = output.planning.proposals.find((proposal) =>
      proposal.key.includes(`/day_utc=${DAY}/connector_id=1/pollutant_code=o3/manifest.json`)
        && proposal.kind === "pollutant_timeseries_index"
    );
    assert.ok(o3Index, "the explicit index-only O3 leaf must produce an index proposal");
    assert.equal(o3Index.old_sha256, null);
    assert.equal(o3Index.changed, true);
    assert.equal(output.planning.proposals.some((proposal) => proposal.key === o3.manifest_key), false);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("targeted metadata repair hydrates and merges the exact live global object", async () => {
  const existingEntries = [
    metadataEntry({ dayUtc: "2026-05-16", rowCount: 8 }),
    metadataEntry({ dayUtc: DAY, rowCount: 99 }),
    metadataEntry({ dayUtc: DAY, domain: "aqilevels", rowCount: 7 }),
  ];
  const fixture = metadataRepairFixture({ existingEntries });
  const liveBody = fixture.objects[fixture.metadataKey];
  const liveEtag = 'W/"live-metadata-etag"';
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects, { etags: { [fixture.metadataKey]: liveEtag } });
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({ env: resolver.env, repairPlan: fixture.repairPlan });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const proposal = output.planning.proposals.find((candidate) => candidate.key === fixture.metadataKey);
    assert.ok(proposal);
    assert.equal(proposal.old_sha256, createHash("sha256").update(liveBody).digest("hex"));
    assert.equal(proposal.old_r2_etag, liveEtag);
    assert.equal(proposal.provenance.metadata_source, "existing_live_timeseries_metadata");
    assert.equal(proposal.target_pre_write_guard.planned_state, "existing");
    const payload = JSON.parse(proposal.proposed_body);
    const observationEntries = payload.observations_coverage.entries;
    assert.deepEqual(observationEntries.map((entry) => entry.day_utc), ["2026-05-16", DAY]);
    assert.equal(observationEntries.find((entry) => entry.day_utc === "2026-05-16").row_count, 8);
    assert.equal(observationEntries.find((entry) => entry.day_utc === DAY).row_count, 1);
    assert.equal(payload.aqi_coverage.entries.length, 1);
    assert.equal(payload.aqi_coverage.entries[0].row_count, 7);
    const metadata = output.planning.days[0].index.results[0].timeseries_metadata;
    assert.equal(metadata.existing_object_merged_count, 1);
    assert.equal(metadata.new_object_count, 0);
    assert.equal(metadata.preserved_entry_count, 2);
    assert.equal(metadata.replaced_entry_count, 1);
    assert.equal(metadata.metadata_operations[0].metadata_source, "existing_live_timeseries_metadata");
    assert.equal(fake.requests.some((request) => request.method === "GET" && request.key === fixture.metadataKey), true);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("confirmed live 404 creates metadata from core and ignores a Dropbox-only global object", async () => {
  const fixture = metadataRepairFixture();
  const dropboxPayload = buildHistoryV2TimeseriesMetadataIndexPayload({
    timeseriesId: 101,
    entries: [metadataEntry({ dayUtc: "2026-05-16" })],
  });
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(resolver, {
      ...fixture.objects,
      [fixture.metadataKey]: `${JSON.stringify(dropboxPayload, null, 2)}\n`,
    });
    const output = await runV2ObservationsRepair({ env: resolver.env, repairPlan: fixture.repairPlan });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const proposal = output.planning.proposals.find((candidate) => candidate.key === fixture.metadataKey);
    assert.equal(proposal.old_sha256, null);
    assert.equal(proposal.old_r2_etag, null);
    assert.equal(proposal.provenance.metadata_source, "authoritative_core_snapshot");
    assert.equal(proposal.target_pre_write_guard.planned_state, "missing");
    const payload = JSON.parse(proposal.proposed_body);
    assert.deepEqual(payload.observations_coverage.entries.map((entry) => entry.day_utc), [DAY]);
    const metadata = output.planning.days[0].index.results[0].timeseries_metadata;
    assert.equal(metadata.existing_object_merged_count, 0);
    assert.equal(metadata.new_object_count, 1);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("live metadata lookup failure blocks the complete plan instead of becoming a 404", async () => {
  const fixture = metadataRepairFixture();
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects, {
    beforeRequest: ({ method, key }) => method === "GET" && key === fixture.metadataKey
      ? new Response("forbidden", { status: 403 })
      : null,
  });
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({ env: resolver.env, repairPlan: fixture.repairPlan });
    assert.equal(output.status, "blocked_dependency");
    assert.equal(output.planning.blocked_scopes.some((scope) => scope.reason === "live_timeseries_metadata_lookup_failed"), true);
    assert.equal(output.planning.proposals.some((proposal) => proposal.kind === "timeseries_metadata"), false);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

for (const race of ["body", "etag", "created_after_planning"]) {
  test(`metadata target guard blocks a concurrent ${race.replaceAll("_", " ")}`, async () => {
    const existingEntries = [metadataEntry({ dayUtc: "2026-05-16" }), metadataEntry({ dayUtc: DAY, rowCount: 99 })];
    const fixture = metadataRepairFixture({ existingEntries: race === "created_after_planning" ? null : existingEntries });
    let metadataGetCount = 0;
    const fake = installFakeR2(fixture.objects, {
      etags: race === "etag" ? { [fixture.metadataKey]: '"etag-v1"' } : {},
      beforeRequest: ({ method, key, objects, etags }) => {
        if (method !== "GET" || key !== fixture.metadataKey || ++metadataGetCount !== 2) return null;
        if (race === "body") objects[key] = `${fixture.objects[key]} `;
        if (race === "etag") etags.set(key, '"etag-v2"');
        if (race === "created_after_planning") {
          const payload = buildHistoryV2TimeseriesMetadataIndexPayload({ timeseriesId: 101, entries: existingEntries });
          objects[key] = `${JSON.stringify(payload, null, 2)}\n`;
        }
        return null;
      },
    });
    const resolver = combinedResolverEnv();
    try {
      writeCombinedDropboxFixture(resolver, fixture.objects);
      const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: fixture.repairPlan });
      assert.equal(output.status, "failed");
      assert.match(output.application_failure.error, /concurrent_live_change target/);
      assert.equal(fake.puts.size, 0, "whole-plan target guard failure must occur before every PUT");
    } finally {
      fake.restore();
      resolver.cleanup();
    }
  });
}

test("unchanged merged metadata is skipped", async () => {
  const initial = metadataRepairFixture();
  const firstResolver = combinedResolverEnv();
  const firstFake = installFakeR2(initial.objects);
  let proposedBody;
  try {
    writeCombinedDropboxFixture(firstResolver, initial.objects);
    const first = await runV2ObservationsRepair({ env: firstResolver.env, repairPlan: initial.repairPlan });
    proposedBody = first.planning.proposals.find((proposal) => proposal.key === initial.metadataKey).proposed_body;
  } finally {
    firstFake.restore();
    firstResolver.cleanup();
  }
  const objects = { ...initial.objects, [initial.metadataKey]: proposedBody };
  const md5 = createHash("md5").update(proposedBody).digest("hex");
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects, { etags: { [initial.metadataKey]: `"${md5}"` } });
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({ env: resolver.env, repairPlan: initial.repairPlan });
    const proposal = output.planning.proposals.find((candidate) => candidate.key === initial.metadataKey);
    assert.equal(proposal.changed, false);
    assert.equal(proposal.target_pre_write_guard, null);
    const metadata = output.planning.days[0].index.results[0].timeseries_metadata;
    assert.equal(metadata.unchanged_object_count, 1);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("metadata write simulation GET-verifies the target and is idempotent", async () => {
  const fixture = metadataRepairFixture({
    existingEntries: [metadataEntry({ dayUtc: "2026-05-16" }), metadataEntry({ dayUtc: DAY, rowCount: 99 })],
  });
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects, { etags: { [fixture.metadataKey]: '"metadata-live-v1"' } });
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const first = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: fixture.repairPlan });
    assert.equal(first.status, "succeeded", JSON.stringify(first.application_failure));
    const metadataPut = fake.requests.findIndex((request) => request.method === "PUT" && request.key === fixture.metadataKey);
    const metadataVerify = fake.requests.findIndex((request, index) => index > metadataPut && request.method === "GET" && request.key === fixture.metadataKey);
    assert.ok(metadataPut >= 0 && metadataVerify > metadataPut);
    assert.equal([...fake.puts.keys()].some((key) => key.endsWith(".parquet")), false);
    const putCount = fake.requests.filter((request) => request.method === "PUT").length;
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: fixture.repairPlan });
    assert.equal(["skipped_unchanged", "succeeded"].includes(second.status), true);
    assert.equal(fake.requests.filter((request) => request.method === "PUT").length, putCount);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("day repairs preserve live connector siblings and expose Dropbox inventory drift", async () => {
  const fixture = twoConnectorFixture();
  const c3pm25 = pollutant(3, "pm25");
  const c3 = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 3, runId: "live", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=3/manifest.json`,
    pollutantManifests: [c3pm25], writerGitSha: "live", backedUpAtUtc: "2026-05-18T01:00:00.000Z",
  });
  const liveObjects = {
    ...fixture.objects,
    [c3pm25.manifest_key]: JSON.stringify(c3pm25, null, 2),
    [c3.manifest_key]: JSON.stringify(c3, null, 2),
  };
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(liveObjects);
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_day_manifest_repair",
        connector_id: null,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const proposal = output.planning.proposals[0];
    assert.deepEqual(JSON.parse(proposal.proposed_body).connector_ids, [1, 2, 3]);
    assert.equal(proposal.pre_write_guard.backup_inventory.state, "backup_drift");
    assert.deepEqual(proposal.pre_write_guard.backup_inventory.unexpected_keys, [c3.manifest_key]);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

function proposalFromManifest(manifest, kind = "pollutant_manifest") {
  const body = JSON.stringify(manifest);
  return {
    key: manifest.manifest_key,
    kind,
    body,
    bytes: Buffer.byteLength(body),
    changed: true,
    new_sha256: createHash("sha256").update(body).digest("hex"),
    dependencies: [],
    pre_write_guard: null,
  };
}

function metadataEntry({ dayUtc, timeseriesId = 101, pollutantCode = "pm10", domain = "observations", rowCount = 12 }) {
  return {
    domain,
    day_utc: dayUtc,
    connector_id: 1,
    pollutant_code: pollutantCode,
    row_count: rowCount,
    min_observed_at_utc: domain === "observations" ? `${dayUtc}T00:00:00.000Z` : null,
    max_observed_at_utc: domain === "observations" ? `${dayUtc}T23:00:00.000Z` : null,
    min_timestamp_hour_utc: domain === "aqilevels" ? `${dayUtc}T00:00:00.000Z` : null,
    max_timestamp_hour_utc: domain === "aqilevels" ? `${dayUtc}T23:00:00.000Z` : null,
    source_index_key: domain === "observations"
      ? `${PREFIX}/day_utc=${dayUtc}/connector_id=1/pollutant_code=${pollutantCode}/manifest.json`
      : `history/v2/aqilevels/hourly/data/day_utc=${dayUtc}/connector_id=1/pollutant_code=${pollutantCode}/manifest.json`,
    source_manifest_hash: `fixture-${timeseriesId}-${domain}-${dayUtc}`,
    backed_up_at_utc: `${dayUtc}T23:00:00.000Z`,
  };
}

function metadataRepairFixture({ timeseriesId = 101, pollutantCode = "pm10", existingEntries = null } = {}) {
  const pollutantManifest = pollutantForTimeseries(1, pollutantCode, timeseriesId);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pollutantManifest],
    writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`,
    connectorManifests: [connector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const metadataKey = `history/_index_v2/timeseries/timeseries_id=${timeseriesId}.json`;
  const objects = {
    [pollutantManifest.manifest_key]: JSON.stringify(pollutantManifest, null, 2),
    [connector.manifest_key]: JSON.stringify(connector, null, 2),
    [day.manifest_key]: JSON.stringify(day, null, 2),
  };
  if (existingEntries) {
    const payload = buildHistoryV2TimeseriesMetadataIndexPayload({
      timeseriesId,
      entries: existingEntries,
      generatedAt: `${DAY}T00:00:00.000Z`,
    });
    objects[metadataKey] = `${JSON.stringify(payload, null, 2)}\n`;
  }
  return {
    objects,
    pollutantManifest,
    connector,
    day,
    metadataKey,
    repairPlan: {
      ...observationsRepairPlan(repairAction({
        kind: "observation_index_repair",
        connector_id: 1,
        pollutant_code: pollutantCode,
        requires_index_rebuild: true,
      })),
      authoritative_core_timeseries: [{ timeseries_id: timeseriesId, connector_id: 1, pollutant_code: pollutantCode }],
    },
  };
}

function fourConnectorRepairFixture({ connectorOne = "malformed" } = {}) {
  const connectorIds = [1, 3, 6, 7];
  const entries = connectorIds.map((connectorId) => {
    const child = pollutantForTimeseries(connectorId, "pm25", connectorId);
    const manifest = buildHistoryV2ConnectorManifest({
      domain: "observations", dayUtc: DAY, connectorId, runId: "fixture",
      manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`,
      pollutantManifests: [child], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
    });
    return { child, manifest };
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`,
    connectorManifests: entries.map((entry) => entry.manifest), writerGitSha: "fixture",
    backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const staleLiveDay = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "stale-fixture",
    manifestKey: day.manifest_key,
    connectorManifests: entries.slice(1).map((entry) => entry.manifest), writerGitSha: "stale-fixture",
    backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const objects = Object.fromEntries([
    ...entries.map(({ child }) => [child.manifest_key, JSON.stringify(child, null, 2)]),
    ...entries.filter(({ manifest }) => manifest.connector_id !== 1 || connectorOne !== "missing")
      .map(({ manifest }) => [
        manifest.manifest_key,
        JSON.stringify(manifest.connector_id === 1 && connectorOne === "malformed"
          ? { ...manifest, grain: "invalid-old-live-grain" }
          : manifest, null, 2),
      ]),
    [day.manifest_key, JSON.stringify(staleLiveDay, null, 2)],
  ]);
  return { objects, entries, day };
}

function stagedConnectorAndDayProposals({ connector, day, liveSibling = null, siblingBody = null }) {
  const connectorProposal = proposalFromManifest(connector, "connector_manifest");
  const dayProposal = proposalFromManifest(day, "day_manifest");
  const expectedChildren = [{
    key: connector.manifest_key,
    content_sha256: connectorProposal.new_sha256,
    r2_etag: null,
    source: "planned_overlay",
    staged: true,
  }];
  if (liveSibling) {
    expectedChildren.push({
      key: liveSibling.manifest_key,
      content_sha256: createHash("sha256").update(siblingBody).digest("hex"),
      r2_etag: null,
      source: "live_r2",
      staged: false,
    });
  }
  dayProposal.dependencies = expectedChildren.map((child) => child.key);
  dayProposal.pre_write_guard = {
    prefix: `${PREFIX}/day_utc=${DAY}/connector_id=`,
    dayUtc: DAY,
    connectorId: null,
    kind: "connector",
    domain: "observations",
    expected_children: expectedChildren,
    expected_inventory_source: "live_r2_snapshot",
    backup_inventory: null,
    last_live_inventory: null,
  };
  return new Map([
    [connectorProposal.key, connectorProposal],
    [dayProposal.key, dayProposal],
  ]);
}

test("whole-plan preflight accepts a malformed live connector with a canonical staged replacement", async () => {
  const fixture = fourConnectorRepairFixture();
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_connector_manifest_repair",
        connector_id: 1,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const connectorProposal = output.planning.proposals.find((proposal) => proposal.kind === "connector_manifest");
    const dayProposal = output.planning.proposals.find((proposal) => proposal.kind === "day_manifest");
    assert.deepEqual(JSON.parse(connectorProposal.proposed_body).pollutant_codes, ["pm25"]);
    assert.deepEqual(JSON.parse(dayProposal.proposed_body).connector_ids, [1, 3, 6, 7]);
    assert.equal(output.planning.proposals.some((proposal) => proposal.key.endsWith(".parquet")), false);
    assert.equal(fake.puts.size, 0, "dry-run preflight must not PUT metadata or parquet");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("whole-plan preflight accepts a missing live child with a canonical staged replacement", async () => {
  const fixture = fourConnectorRepairFixture({ connectorOne: "missing" });
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_connector_manifest_repair",
        connector_id: 1,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    const dayProposal = output.planning.proposals.find((proposal) => proposal.kind === "day_manifest");
    assert.deepEqual(JSON.parse(dayProposal.proposed_body).connector_ids, [1, 3, 6, 7]);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("whole-plan preflight accepts an exact staged replacement when no old live children exist", async () => {
  const child = pollutantForTimeseries(1, "pm25", 1);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [child],
    writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`,
    connectorManifests: [connector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const fake = installFakeR2({});
  try {
    const output = await applyStagedProposals({
      r2: { endpoint: ENV.CFLARE_R2_ENDPOINT, bucket: ENV.CFLARE_R2_BUCKET, access_key_id: ENV.CFLARE_R2_ACCESS_KEY_ID, secret_access_key: ENV.CFLARE_R2_SECRET_ACCESS_KEY, region: "auto" },
      proposals: stagedConnectorAndDayProposals({ connector, day }),
      writeR2: false,
    });
    assert.equal(output.failure, null);
    assert.equal(output.results.get(connector.manifest_key).status, "planned");
    assert.equal(output.results.get(day.manifest_key).status, "planned");
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
  }
});

test("whole-plan preflight still rejects a malformed unstaged live connector", async () => {
  const connectorOne = pollutantForTimeseries(1, "pm25", 1);
  const connectorThree = pollutantForTimeseries(3, "pm25", 3);
  const stagedConnector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [connectorOne],
    writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const validSibling = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc: DAY, connectorId: 3, runId: "fixture",
    manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=3/manifest.json`, pollutantManifests: [connectorThree],
    writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const malformedSiblingBody = JSON.stringify({ ...validSibling, profile: "invalid-old-live-profile" });
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`,
    connectorManifests: [stagedConnector, validSibling], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const fake = installFakeR2({
    [stagedConnector.manifest_key]: JSON.stringify({ ...stagedConnector, grain: "invalid-old-live-grain" }),
    [validSibling.manifest_key]: malformedSiblingBody,
  });
  try {
    const output = await applyStagedProposals({
      r2: { endpoint: ENV.CFLARE_R2_ENDPOINT, bucket: ENV.CFLARE_R2_BUCKET, access_key_id: ENV.CFLARE_R2_ACCESS_KEY_ID, secret_access_key: ENV.CFLARE_R2_SECRET_ACCESS_KEY, region: "auto" },
      proposals: stagedConnectorAndDayProposals({ connector: stagedConnector, day, liveSibling: validSibling, siblingBody: malformedSiblingBody }),
      writeR2: false,
    });
    assert.equal(output.failure.key, day.manifest_key);
    assert.match(output.failure.error, /invalid connector manifest/i);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
  }
});

test("invalid canonical staged child content blocks before every guard and PUT", async () => {
  const fixture = fourConnectorRepairFixture();
  const connector = fixture.entries[0].manifest;
  const proposals = stagedConnectorAndDayProposals({ connector, day: fixture.day });
  const invalid = proposals.get(connector.manifest_key);
  invalid.body = "{}";
  invalid.bytes = 2;
  invalid.new_sha256 = createHash("sha256").update(invalid.body).digest("hex");
  const day = proposals.get(fixture.day.manifest_key);
  day.pre_write_guard.expected_children[0].content_sha256 = invalid.new_sha256;
  let guardCalls = 0;
  let putCalls = 0;
  const output = await applyStagedProposals({
    r2: {},
    proposals,
    writeR2: true,
    assertChildren: async () => { guardCalls += 1; },
    putObject: async () => { putCalls += 1; },
  });
  assert.equal(output.failure.key, connector.manifest_key);
  assert.equal(output.results.get(connector.manifest_key).failure_stage, "proposal_preflight");
  assert.equal(guardCalls, 0, "Pass 1 must validate every proposal before dependency guards");
  assert.equal(putCalls, 0);
});

test("write simulation verifies the staged connector before the strict parent guard and PUT", async () => {
  const fixture = fourConnectorRepairFixture();
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      argv: ["--write-r2"],
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_connector_manifest_repair",
        connector_id: 1,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "succeeded", JSON.stringify(output.application_failure));
    const connectorKey = fixture.entries[0].manifest.manifest_key;
    const dayKey = fixture.day.manifest_key;
    const connectorPut = fake.requests.findIndex((request) => request.method === "PUT" && request.key === connectorKey);
    const connectorVerify = fake.requests.findIndex((request, index) => index > connectorPut && request.method === "GET" && request.key === connectorKey);
    const strictParentRead = fake.requests.findIndex((request, index) => index > connectorVerify && request.method === "GET" && request.key === connectorKey);
    const dayPut = fake.requests.findIndex((request) => request.method === "PUT" && request.key === dayKey);
    assert.ok(connectorPut >= 0 && connectorVerify > connectorPut && strictParentRead > connectorVerify && dayPut > strictParentRead);
    assert.deepEqual([...fake.puts.keys()], [connectorKey, dayKey]);
    assert.equal([...fake.puts.keys()].some((key) => key.endsWith(".parquet")), false);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("strict parent write guard rejects a staged child corrupted after exact GET verification", async () => {
  const fixture = fourConnectorRepairFixture();
  const connectorKey = fixture.entries[0].manifest.manifest_key;
  const childPrefix = `${PREFIX}/day_utc=${DAY}/connector_id=`;
  let parentListCount = 0;
  const fake = installFakeR2(fixture.objects, {
    beforeRequest: ({ method, prefix, puts }) => {
      if (method === "GET" && prefix === childPrefix && ++parentListCount === 2) {
        puts.set(connectorKey, "{}");
      }
    },
  });
  const resolver = combinedResolverEnv();
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      argv: ["--write-r2"],
      env: resolver.env,
      repairPlan: observationsRepairPlan(repairAction({
        kind: "observation_connector_manifest_repair",
        connector_id: 1,
        pollutant_code: null,
        requires_index_rebuild: false,
      })),
    });
    assert.equal(output.status, "failed");
    assert.match(output.application_failure.error, /invalid connector manifest/i);
    assert.equal(fake.puts.has(connectorKey), true);
    assert.equal(fake.puts.has(fixture.day.manifest_key), false);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("whole-plan preflight blocks a genuine live R2 ETag change", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const connector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const day = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [connector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([o3, pm25, connector, day].map((manifest) => [manifest.manifest_key, JSON.stringify(manifest, null, 2)]));
  let pm25GetCount = 0;
  const fake = installFakeR2(objects, {
    etags: { [pm25.manifest_key]: '"live-etag-v1"' },
    beforeRequest: ({ method, key, etags }) => {
      if (method === "GET" && key === pm25.manifest_key && ++pm25GetCount === 2) {
        etags.set(key, '"live-etag-v2"');
      }
    },
  });
  const resolver = combinedResolverEnv();
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: observationsRepairPlan() });
    assert.equal(output.status, "failed");
    assert.match(output.application_failure.error, /child R2 ETag changed/);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("metadata proposal preflight rejects a late invalid proposal before any write", async () => {
  const valid = proposalFromManifest(pollutant(1, "pm25"));
  const invalid = {
    ...valid,
    key: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`,
    kind: "connector_manifest",
    body: "{}",
    bytes: 2,
  };
  const puts = [];
  const output = await applyStagedProposals({
    r2: {},
    proposals: new Map([[valid.key, valid], [invalid.key, invalid]]),
    writeR2: true,
    putObject: async ({ key }) => { puts.push(key); },
  });
  assert.equal(output.failure.key, invalid.key);
  assert.equal(output.results.get(invalid.key).failure_stage, "proposal_preflight");
  assert.deepEqual(puts, [], "no valid earlier proposal may be written before a later proposal fails preflight");
});

test("dry-run executes proposal preflight guards without writing", async () => {
  const valid = proposalFromManifest(pollutant(1, "pm25"));
  valid.pre_write_guard = { prefix: "history/v2/observations", expected_children: [] };
  let guardCalls = 0;
  let putCalls = 0;
  const output = await applyStagedProposals({
    r2: {},
    proposals: new Map([[valid.key, valid]]),
    writeR2: false,
    assertChildren: async ({ guard, allowStagedChildren }) => {
      guardCalls += 1;
      assert.equal(guard.prefix, "history/v2/observations");
      assert.equal(allowStagedChildren, true);
    },
    putObject: async () => { putCalls += 1; },
  });
  assert.equal(output.failure, null);
  assert.equal(guardCalls, 1);
  assert.equal(putCalls, 0);
  assert.equal(output.results.get(valid.key).status, "planned");
});

test("live connector and day guards receive canonical string keys", async () => {
  const fixture = twoConnectorFixture();
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(resolver, fixture.objects);
    const output = await runV2ObservationsRepair({
      argv: ["--write-r2"],
      env: resolver.env,
      repairPlan: observationsRepairPlan(),
    });
    assert.equal(output.status, "succeeded", JSON.stringify(output.application_failure));
    assert.deepEqual([...fake.puts.keys()].sort(), [fixture.keys.c1, fixture.keys.day].sort());
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 5 one-connector O3 repair stages the complete connector and day hierarchy, then is idempotent", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const no2 = pollutant(2, "no2");
  const staleConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const siblingConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=2/manifest.json`, pollutantManifests: [no2], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleConnector, siblingConnector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [no2.manifest_key, JSON.stringify(no2, null, 2)], [staleConnector.manifest_key, JSON.stringify(staleConnector, null, 2)], [siblingConnector.manifest_key, JSON.stringify(siblingConnector, null, 2)], [staleDay.manifest_key, JSON.stringify(staleDay, null, 2)]]);
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects);
  const repairPlan = observationsRepairPlan();
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const first = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan });
    assert.equal(first.status, "succeeded");
    assert.equal(fake.puts.size, 2);
    assert.deepEqual(first.planning.days[0].proposal_keys, [staleConnector.manifest_key, staleDay.manifest_key]);
    assert.deepEqual(first.planning.proposals.map((proposal) => proposal.kind), ["connector_manifest", "day_manifest"]);
    assert.deepEqual(JSON.parse(fake.puts.get(staleConnector.manifest_key)).pollutant_codes, ["o3", "pm25"]);
    assert.deepEqual(JSON.parse(fake.puts.get(staleDay.manifest_key)).connector_ids, [1, 2]);
    assert.equal([...fake.puts.keys()].some((key) => key.endsWith(".parquet") || key.includes("aqilevels")), false);
    writeCombinedDropboxFixture(resolver, Object.fromEntries(fake.puts));
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan });
    assert.equal(second.status, "skipped_unchanged");
    assert.equal(fake.puts.size, 2);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 5 stages two connector repairs into one proposed day and writes the three changed manifests only", async () => {
  const fixture = twoConnectorFixture();
  const plan = { history_version: "v2", domain: "observations", repair_plan: [
    repairAction({ connector_id: 1, pollutant_code: "o3" }),
    repairAction({ connector_id: 2, pollutant_code: "pm10" }),
  ] };
  const dryResolver = combinedResolverEnv();
  const dryFake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(dryResolver, fixture.objects);
    const dry = await runV2ObservationsRepair({ env: dryResolver.env, repairPlan: plan });
    assert.equal(dry.status, "planned");
    assert.equal(dryFake.puts.size, 0, "dry-run must not PUT any proposed object");
    assert.deepEqual(dry.planning.days[0].proposal_keys, [fixture.keys.c1, fixture.keys.c2, fixture.keys.day]);
    const proposedDay = JSON.parse(dry.planning.proposals.find((proposal) => proposal.key === fixture.keys.day).proposed_body);
    assert.deepEqual(proposedDay.connector_ids, [1, 2], "the day proposal must consume both proposed connector manifests");
  } finally {
    dryFake.restore();
    dryResolver.cleanup();
  }

  const writeResolver = combinedResolverEnv();
  const writeFake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(writeResolver, fixture.objects);
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: writeResolver.env, repairPlan: plan });
    assert.equal(output.status, "succeeded");
    assert.deepEqual([...writeFake.puts.keys()].sort(), [fixture.keys.c1, fixture.keys.c2, fixture.keys.day].sort());
  } finally {
    writeFake.restore();
    writeResolver.cleanup();
  }
});

test("Phase 5 day-only action proposes a parent built from every live connector", async () => {
  const connectorIds = [1, 3, 6, 7];
  const connectorManifests = connectorIds.map((connectorId) => {
    const child = pollutant(connectorId, "pm25");
    const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/manifest.json`;
    return {
      child,
      manifest: buildHistoryV2ConnectorManifest({
        domain: "observations", dayUtc: DAY, connectorId, runId: "fixture", manifestKey: key,
        pollutantManifests: [child], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
      }),
    };
  });
  const dayKey = `${PREFIX}/day_utc=${DAY}/manifest.json`;
  const staleDay = buildHistoryV2DayManifest({
    domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: dayKey,
    connectorManifests: [connectorManifests[0].manifest], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z",
  });
  const objects = Object.fromEntries([
    ...connectorManifests.flatMap(({ child, manifest }) => [
      [child.manifest_key, JSON.stringify(child, null, 2)],
      [manifest.manifest_key, JSON.stringify(manifest, null, 2)],
    ]),
    [dayKey, JSON.stringify(staleDay, null, 2)],
  ]);
  const dayOnly = observationsRepairPlan(repairAction({
    kind: "observation_day_manifest_repair",
    connector_id: null,
    pollutant_code: null,
    requires_index_rebuild: false,
  }));
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects);
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({ env: resolver.env, repairPlan: dayOnly });
    assert.equal(output.status, "planned", JSON.stringify(output.application_failure));
    assert.deepEqual(output.planning.days[0].proposal_keys, [dayKey]);
    const proposedDay = JSON.parse(output.planning.proposals[0].proposed_body);
    assert.deepEqual(proposedDay.connector_ids, connectorIds, "a connector-less day repair must retain every live connector child");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 7 index-only blocked work controls the scope and top-level repair result", async () => {
  const indexOnly = observationsRepairPlan(repairAction({
    kind: "observation_index_repair",
    requires_index_rebuild: true,
  }));
  const fake = installFakeR2({});
  const connectorIds = [];
  const resolver = combinedResolverEnv();
  try {
    const output = await runV2ObservationsRepair({
      env: resolver.env,
      repairPlan: indexOnly,
      updateIndexes: async ({ connectorId }) => {
        connectorIds.push(connectorId);
        return {
        blocked_dependency_count: 1,
        timeseries_metadata: { status: "blocked_dependency" },
        };
      },
    });
    assert.equal(output.ok, false);
    assert.equal(output.status, "blocked_dependency");
    assert.equal(output.results[0].status, "blocked_dependency");
    assert.equal(output.execution.status, "not_run");
    assert.deepEqual(connectorIds, [1], "an index-only scope must not rebuild sibling connectors");
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 5 dry-run proposal bytes are deterministic and unchanged staged objects are skipped", async () => {
  const fixture = twoConnectorFixture();
  const plan = { history_version: "v2", domain: "observations", repair_plan: [
    repairAction({ connector_id: 1 }),
    repairAction({ connector_id: 2, pollutant_code: "pm10" }),
  ] };
  const firstResolver = combinedResolverEnv();
  const firstFake = installFakeR2(fixture.objects);
  let first;
  try {
    writeCombinedDropboxFixture(firstResolver, fixture.objects);
    first = await runV2ObservationsRepair({ env: firstResolver.env, repairPlan: plan });
  } finally {
    firstFake.restore();
    firstResolver.cleanup();
  }
  const secondResolver = combinedResolverEnv();
  const secondFake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(secondResolver, fixture.objects);
    const second = await runV2ObservationsRepair({ env: secondResolver.env, repairPlan: plan });
    assert.deepEqual(
      second.planning.proposals.map((proposal) => [proposal.key, proposal.new_sha256, proposal.proposed_body]),
      first.planning.proposals.map((proposal) => [proposal.key, proposal.new_sha256, proposal.proposed_body]),
    );
  } finally {
    secondFake.restore();
    secondResolver.cleanup();
  }

  const writeResolver = combinedResolverEnv();
  const writeFake = installFakeR2(fixture.objects);
  try {
    writeCombinedDropboxFixture(writeResolver, fixture.objects);
    await runV2ObservationsRepair({ argv: ["--write-r2"], env: writeResolver.env, repairPlan: plan });
    writeCombinedDropboxFixture(writeResolver, Object.fromEntries(writeFake.puts));
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: writeResolver.env, repairPlan: plan });
    assert.equal(second.status, "skipped_unchanged");
    assert.equal(second.planning.proposals.every((proposal) => proposal.changed === false), true);
  } finally {
    writeFake.restore();
    writeResolver.cleanup();
  }
});

test("Phase 6 blocks a connector parent when the fresh child list gains a sibling", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const added = pollutant(1, "so2");
  const staleConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleConnector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [staleConnector.manifest_key, JSON.stringify(staleConnector, null, 2)], [staleDay.manifest_key, JSON.stringify(staleDay, null, 2)]]);
  const prefix = `${PREFIX}/day_utc=${DAY}/connector_id=1/pollutant_code=`;
  let childListCount = 0;
  const fake = installFakeR2(objects, {
    beforeRequest: ({ method, prefix: requestPrefix }) => {
      if (method === "GET" && requestPrefix === prefix && ++childListCount === 2) {
        objects[added.manifest_key] = JSON.stringify(added, null, 2);
      }
    },
  });
  const resolver = combinedResolverEnv();
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: observationsRepairPlan() });
    assert.equal(output.status, "failed");
    assert.match(output.application_failure.error, /concurrent_live_change pollutant child key inventory changed/);
    assert.equal(fake.puts.size, 0, "a blocked connector must prevent its own and dependent writes");
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 6 blocks a day parent when a freshly read child body changes", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const no2 = pollutant(2, "no2");
  const staleConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const siblingConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=2/manifest.json`, pollutantManifests: [no2], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const changedSibling = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "changed-fixture", manifestKey: siblingConnector.manifest_key, pollutantManifests: [no2], writerGitSha: "changed-fixture", backedUpAtUtc: "2026-05-18T00:01:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleConnector, siblingConnector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [no2.manifest_key, JSON.stringify(no2, null, 2)], [staleConnector.manifest_key, JSON.stringify(staleConnector, null, 2)], [siblingConnector.manifest_key, JSON.stringify(siblingConnector, null, 2)], [staleDay.manifest_key, JSON.stringify(staleDay, null, 2)]]);
  let siblingGetCount = 0;
  const fake = installFakeR2(objects, {
    beforeRequest: ({ method, key }) => {
      if (method === "GET" && key === siblingConnector.manifest_key && ++siblingGetCount === 2) {
        objects[siblingConnector.manifest_key] = JSON.stringify(changedSibling, null, 2);
      }
    },
  });
  const resolver = combinedResolverEnv();
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: observationsRepairPlan() });
    assert.equal(output.status, "failed");
    assert.match(output.application_failure.error, /concurrent_live_change connector child content changed/);
    assert.deepEqual([...fake.puts.keys()], [], "the full-plan preflight blocks every write when a day child changes");
    assert.equal(fake.puts.has(staleDay.manifest_key), false);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 4 accepts a complete integrity report fixture and retains its deterministic scope", async () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/uk_aq_v2_observations_integrity_report.json", import.meta.url));
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const connector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [o3, pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [connector.manifest_key, JSON.stringify(connector, null, 2)]]);
  const resolver = combinedResolverEnv();
  const fake = installFakeR2(objects);
  try {
    writeCombinedDropboxFixture(resolver, objects);
    const output = await runV2ObservationsRepair({
      argv: [
        "--repair-plan-json", fixturePath,
        "--overlay-root", resolver.env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT,
        "--dropbox-root", resolver.env.UK_AQ_R2_HISTORY_DROPBOX_ROOT,
        "--run-state-json", resolver.env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON,
      ],
      env: resolver.env,
      updateIndexes: async () => ({}),
    });
    assert.equal(output.status, "planned");
    assert.equal(output.dry_run, true);
    assert.equal(output.planning.input_kind, "integrity_report");
    assert.deepEqual(output.planning.scopes, [{ dayUtc: DAY, connectorId: 1, needsConnector: true, needsDay: true, needsIndex: true, pollutantRepair: false, gap_types: ["connector_manifest_missing"], pollutant_codes: [], index_pollutant_codes: [] }]);
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
    resolver.cleanup();
  }
});

test("Phase 4 rejects every unsupported integrity action before R2 access", async () => {
  const resolver = combinedResolverEnv();
  try {
  for (const kind of [
    "observation_data_repair",
    "source_mapping_issue",
    "aqi_rebuild",
    "unknown_repair_action",
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(
        runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: observationsRepairPlan(repairAction({ kind })) }),
        /Unsupported Phase 4 repair action/,
      );
    });
  }
  for (const action of [
    repairAction({ history_version: "v1" }),
    repairAction({ domain: "invalid_domain" }),
    repairAction({ data_changes_required: true }),
    repairAction({ operator_action_required: true }),
    repairAction({ executes: true }),
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(
        runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: observationsRepairPlan(action) }),
        /Unsupported history version|Unsupported domain|Unsafe Phase 4 repair action/,
      );
    });
  }
  await assertNoR2Access(async () => {
    await assert.rejects(
      runV2ObservationsRepair({
        argv: ["--write-r2"],
        env: resolver.env,
        repairPlan: { history_version_results: { v2: { history_version: "v2", observations: { repair_plan: [repairAction()] } } } },
      }),
      /Invalid complete integrity report/,
    );
  });
  } finally {
    resolver.cleanup();
  }
});

test("Phase 4 write gate requires the CIC-Test environment and bucket before R2 access", async () => {
  const plan = observationsRepairPlan(repairAction({ kind: "observation_pollutant_manifest_repair", requires_index_rebuild: true }));
  const resolver = combinedResolverEnv();
  try {
  for (const [name, env, expected] of [
    ["missing environment", { ...ENV, UK_AQ_ENV_NAME: undefined }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["wrong environment with test bucket", { ...ENV, UK_AQ_ENV_NAME: "LIVE" }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["CIC-Test with live bucket", { ...ENV, CFLARE_R2_BUCKET: "uk-aq-history-live" }, /configured R2 bucket must be uk-aq-history-cic-test/],
    ["CIC-Test with R2_BUCKET overriding to live", { ...ENV, R2_BUCKET: "uk-aq-history-live" }, /configured R2 bucket must be uk-aq-history-cic-test/],
    ["wrong environment and live bucket", { ...ENV, UK_AQ_ENV_NAME: "LIVE", CFLARE_R2_BUCKET: "uk-aq-history-live" }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["CIC-Test with no bucket", { ...ENV, CFLARE_R2_BUCKET: undefined }, /configured R2 bucket must be uk-aq-history-cic-test/],
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(runV2ObservationsRepair({ argv: ["--write-r2"], env: { ...resolver.env, ...env }, repairPlan: plan }), expected, name);
    });
  }
  const fake = installFakeR2({});
  try {
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: resolver.env, repairPlan: plan });
    assert.equal(output.status, "blocked_dependency");
    assert.equal(output.write_r2, true);
    const overridden = await runV2ObservationsRepair({ argv: ["--write-r2"], env: { ...resolver.env, CFLARE_R2_BUCKET: "uk-aq-history-live", R2_BUCKET: "uk-aq-history-cic-test" }, repairPlan: plan });
    assert.equal(overridden.status, "blocked_dependency");
  } finally {
    fake.restore();
  }
  } finally {
    resolver.cleanup();
  }
});
