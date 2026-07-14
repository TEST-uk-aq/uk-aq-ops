import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { normalizePlan, runV2ObservationsRepair } from "../scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs";

const DAY = "2026-05-17";
const PREFIX = "history/v2/observations";
const ENV = {
  UK_AQ_ENV_NAME: "CIC-Test",
  CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
  CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
  CFLARE_R2_ACCESS_KEY_ID: "key",
  CFLARE_R2_SECRET_ACCESS_KEY: "secret",
};

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

test("whole-day manifest actions remain connector-less and reject a connector subset", () => {
  const valid = normalizePlan(observationsRepairPlan(repairAction({
    kind: "observation_day_manifest_repair",
    connector_id: null,
    pollutant_code: null,
    requires_index_rebuild: true,
  })));
  assert.deepEqual(valid.scopes, [{
    dayUtc: DAY,
    connectorId: null,
    needsConnector: false,
    needsDay: true,
    needsIndex: true,
    pollutantRepair: false,
    gap_types: ["connector_manifest_missing"],
    pollutant_codes: [],
  }]);
  assert.throws(
    () => normalizePlan(observationsRepairPlan(repairAction({ kind: "observation_day_manifest_repair" }))),
    /must have day_utc and no connector_id/,
  );
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

function installFakeR2(objects, { beforeRequest = null } = {}) {
  const originalFetch = globalThis.fetch;
  const puts = new Map();
  const requests = [];
  const bodyFor = (key) => puts.get(key) || objects[key];
  const keyFromUrl = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/[^/]+\//, "");
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const prefix = parsed.searchParams.get("prefix") || "";
    const key = keyFromUrl(url);
    requests.push({ method, key, prefix });
    await beforeRequest?.({ method, key, prefix, objects, puts, requests });
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const keys = [...new Set([...Object.keys(objects), ...puts.keys()])].filter((key) => key.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size><ETag>\"${key}\"</ETag></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
    }
    if (method === "HEAD") return bodyFor(key) ? new Response(null, { status: 200, headers: { etag: `\"${key}\"` } }) : new Response(null, { status: 404 });
    if (method === "GET") return bodyFor(key) ? new Response(bodyFor(key), { status: 200, headers: { etag: `\"${key}\"` } }) : new Response("not found", { status: 404 });
    if (method === "PUT") { puts.set(key, String(init.body)); return new Response("", { status: 200, headers: { etag: `\"${key}\"` } }); }
    return new Response("unsupported", { status: 405 });
  };
  return { puts, requests, restore: () => { globalThis.fetch = originalFetch; } };
}

function pollutant(connectorId, code) {
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${code}/manifest.json`;
  return buildHistoryV2PollutantManifest({
    domain: "observations", dayUtc: DAY, connectorId, pollutantCode: code, runId: "fixture",
    manifestKey: key, writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z", sourceRowCount: 1,
    fileEntries: [{ key: key.replace("manifest.json", "part-00000.parquet"), bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: connectorId, max_timeseries_id: connectorId, min_observed_at_utc: `${DAY}T00:00:00.000Z`, max_observed_at_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { [connectorId]: 1 } }],
  });
}

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

test("Phase 5 one-connector O3 repair stages the complete connector and day hierarchy, then is idempotent", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const no2 = pollutant(2, "no2");
  const staleConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const siblingConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=2/manifest.json`, pollutantManifests: [no2], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleConnector, siblingConnector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [no2.manifest_key, JSON.stringify(no2, null, 2)], [staleConnector.manifest_key, JSON.stringify(staleConnector, null, 2)], [siblingConnector.manifest_key, JSON.stringify(siblingConnector, null, 2)], [staleDay.manifest_key, JSON.stringify(staleDay, null, 2)]]);
  const fake = installFakeR2(objects);
  const repairPlan = observationsRepairPlan();
  try {
    const first = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan });
    assert.equal(first.status, "succeeded");
    assert.equal(fake.puts.size, 2);
    assert.deepEqual(first.planning.days[0].proposal_keys, [staleConnector.manifest_key, staleDay.manifest_key]);
    assert.deepEqual(first.planning.proposals.map((proposal) => proposal.kind), ["connector_manifest", "day_manifest"]);
    assert.deepEqual(JSON.parse(fake.puts.get(staleConnector.manifest_key)).pollutant_codes, ["o3", "pm25"]);
    assert.deepEqual(JSON.parse(fake.puts.get(staleDay.manifest_key)).connector_ids, [1, 2]);
    assert.equal([...fake.puts.keys()].some((key) => key.endsWith(".parquet") || key.includes("aqilevels")), false);
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan });
    assert.equal(second.status, "skipped_unchanged");
    assert.equal(fake.puts.size, 2);
  } finally { fake.restore(); }
});

test("Phase 5 stages two connector repairs into one proposed day and writes the three changed manifests only", async () => {
  const fixture = twoConnectorFixture();
  const plan = { history_version: "v2", domain: "observations", repair_plan: [
    repairAction({ connector_id: 1, pollutant_code: "o3" }),
    repairAction({ connector_id: 2, pollutant_code: "pm10" }),
  ] };
  const dryFake = installFakeR2(fixture.objects);
  try {
    const dry = await runV2ObservationsRepair({ env: ENV, repairPlan: plan });
    assert.equal(dry.status, "planned");
    assert.equal(dryFake.puts.size, 0, "dry-run must not PUT any proposed object");
    assert.deepEqual(dry.planning.days[0].proposal_keys, [fixture.keys.c1, fixture.keys.c2, fixture.keys.day]);
    const proposedDay = JSON.parse(dry.planning.proposals.find((proposal) => proposal.key === fixture.keys.day).proposed_body);
    assert.deepEqual(proposedDay.connector_ids, [1, 2], "the day proposal must consume both proposed connector manifests");
  } finally { dryFake.restore(); }

  const writeFake = installFakeR2(fixture.objects);
  try {
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: plan });
    assert.equal(output.status, "succeeded");
    assert.deepEqual([...writeFake.puts.keys()].sort(), [fixture.keys.c1, fixture.keys.c2, fixture.keys.day].sort());
  } finally { writeFake.restore(); }
});

test("Phase 5 day-only and index-only actions each produce one targeted proposal set", async () => {
  const fixture = twoConnectorFixture();
  const dayOnly = observationsRepairPlan(repairAction({ kind: "observation_day_manifest_repair", requires_index_rebuild: false }));
  const dayFake = installFakeR2(fixture.objects);
  try {
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: dayOnly });
    assert.equal(output.status, "succeeded");
    assert.deepEqual([...dayFake.puts.keys()], [fixture.keys.day]);
  } finally { dayFake.restore(); }

  const indexOnly = observationsRepairPlan(repairAction({ kind: "observation_index_repair", requires_index_rebuild: true }));
  const indexFake = installFakeR2(fixture.objects);
  try {
    const output = await runV2ObservationsRepair({ env: ENV, repairPlan: indexOnly });
    assert.equal(output.planning.days.length, 1);
    assert.ok(output.planning.days[0].index, "one day has one targeted index/latest/metadata proposal set");
    assert.equal(output.planning.proposals.some((proposal) => proposal.kind === "day_manifest"), false);
    assert.ok(output.planning.proposals.some((proposal) => proposal.kind === "observation_index"));
    assert.equal(indexFake.puts.size, 0);
  } finally { indexFake.restore(); }
});

test("Phase 7 index-only blocked work controls the scope and top-level repair result", async () => {
  const indexOnly = observationsRepairPlan(repairAction({
    kind: "observation_index_repair",
    requires_index_rebuild: true,
  }));
  const fake = installFakeR2({});
  try {
    const output = await runV2ObservationsRepair({
      env: ENV,
      repairPlan: indexOnly,
      updateIndexes: async () => ({
        blocked_dependency_count: 1,
        timeseries_metadata: { status: "blocked_dependency" },
      }),
    });
    assert.equal(output.ok, false);
    assert.equal(output.status, "blocked_dependency");
    assert.equal(output.results[0].status, "blocked_dependency");
    assert.equal(output.execution.status, "not_run");
    assert.equal(fake.puts.size, 0);
  } finally { fake.restore(); }
});

test("Phase 5 dry-run proposal bytes are deterministic and unchanged staged objects are skipped", async () => {
  const fixture = twoConnectorFixture();
  const plan = { history_version: "v2", domain: "observations", repair_plan: [
    repairAction({ connector_id: 1 }),
    repairAction({ connector_id: 2, pollutant_code: "pm10" }),
  ] };
  const firstFake = installFakeR2(fixture.objects);
  let first;
  try { first = await runV2ObservationsRepair({ env: ENV, repairPlan: plan }); } finally { firstFake.restore(); }
  const secondFake = installFakeR2(fixture.objects);
  try {
    const second = await runV2ObservationsRepair({ env: ENV, repairPlan: plan });
    assert.deepEqual(
      second.planning.proposals.map((proposal) => [proposal.key, proposal.new_sha256, proposal.proposed_body]),
      first.planning.proposals.map((proposal) => [proposal.key, proposal.new_sha256, proposal.proposed_body]),
    );
  } finally { secondFake.restore(); }

  const writeFake = installFakeR2(fixture.objects);
  try {
    await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: plan });
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: plan });
    assert.equal(second.status, "skipped_unchanged");
    assert.equal(second.planning.proposals.every((proposal) => proposal.changed === false), true);
  } finally { writeFake.restore(); }
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
  try {
    await assert.rejects(
      runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: observationsRepairPlan() }),
      /child key set changed before parent write/,
    );
    assert.equal(fake.puts.size, 0, "a blocked connector must prevent its own and dependent writes");
  } finally { fake.restore(); }
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
  try {
    await assert.rejects(
      runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: observationsRepairPlan() }),
      /child body changed before parent write/,
    );
    assert.deepEqual([...fake.puts.keys()], [staleConnector.manifest_key], "the changed day child blocks the day parent after the independent connector write");
    assert.equal(fake.puts.has(staleDay.manifest_key), false);
  } finally { fake.restore(); }
});

test("Phase 4 accepts a complete integrity report fixture and retains its deterministic scope", async () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/uk_aq_v2_observations_integrity_report.json", import.meta.url));
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const connector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [o3, pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [connector.manifest_key, JSON.stringify(connector, null, 2)]]);
  const fake = installFakeR2(objects);
  try {
    const output = await runV2ObservationsRepair({ argv: ["--repair-plan-json", fixturePath], env: ENV });
    assert.equal(output.status, "planned");
    assert.equal(output.dry_run, true);
    assert.equal(output.planning.input_kind, "integrity_report");
    assert.deepEqual(output.planning.scopes, [{ dayUtc: DAY, connectorId: 1, needsConnector: true, needsDay: true, needsIndex: true, pollutantRepair: false, gap_types: ["connector_manifest_missing"] }]);
    assert.equal(fake.puts.size, 0);
  } finally { fake.restore(); }
});

test("Phase 4 rejects every unsupported integrity action before R2 access", async () => {
  for (const kind of [
    "observation_data_repair",
    "source_mapping_issue",
    "aqi_rebuild",
    "aqi_pollutant_manifest_repair",
    "aqi_connector_manifest_repair",
    "aqi_day_manifest_repair",
    "aqi_index_repair",
    "unknown_repair_action",
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(
        runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: observationsRepairPlan(repairAction({ kind })) }),
        /Unsupported Phase 4 repair action/,
      );
    });
  }
  for (const action of [
    repairAction({ history_version: "v1" }),
    repairAction({ domain: "aqilevels" }),
    repairAction({ data_changes_required: true }),
    repairAction({ operator_action_required: true }),
    repairAction({ executes: true }),
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(
        runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: observationsRepairPlan(action) }),
        /Unsupported history version|Unsupported domain|Unsafe Phase 4 repair action/,
      );
    });
  }
  await assertNoR2Access(async () => {
    await assert.rejects(
      runV2ObservationsRepair({
        argv: ["--write-r2"],
        env: ENV,
        repairPlan: { history_version_results: { v2: { history_version: "v2", observations: { repair_plan: [repairAction()] } } } },
      }),
      /Invalid complete integrity report/,
    );
  });
});

test("Phase 4 write gate requires the CIC-Test environment and bucket before R2 access", async () => {
  const plan = observationsRepairPlan(repairAction({ kind: "observation_pollutant_manifest_repair", requires_index_rebuild: true }));
  for (const [name, env, expected] of [
    ["missing environment", { ...ENV, UK_AQ_ENV_NAME: undefined }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["wrong environment with test bucket", { ...ENV, UK_AQ_ENV_NAME: "LIVE" }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["CIC-Test with live bucket", { ...ENV, CFLARE_R2_BUCKET: "uk-aq-history-live" }, /configured R2 bucket must be uk-aq-history-cic-test/],
    ["CIC-Test with R2_BUCKET overriding to live", { ...ENV, R2_BUCKET: "uk-aq-history-live" }, /configured R2 bucket must be uk-aq-history-cic-test/],
    ["wrong environment and live bucket", { ...ENV, UK_AQ_ENV_NAME: "LIVE", CFLARE_R2_BUCKET: "uk-aq-history-live" }, /UK_AQ_ENV_NAME must be CIC-Test/],
    ["CIC-Test with no bucket", { ...ENV, CFLARE_R2_BUCKET: undefined }, /configured R2 bucket must be uk-aq-history-cic-test/],
  ]) {
    await assertNoR2Access(async () => {
      await assert.rejects(runV2ObservationsRepair({ argv: ["--write-r2"], env, repairPlan: plan }), expected, name);
    });
  }
  await assertNoR2Access(async () => {
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: plan });
    assert.equal(output.status, "blocked_dependency");
    assert.equal(output.write_r2, true);
  });
  await assertNoR2Access(async () => {
    const output = await runV2ObservationsRepair({ argv: ["--write-r2"], env: { ...ENV, CFLARE_R2_BUCKET: "uk-aq-history-live", R2_BUCKET: "uk-aq-history-cic-test" }, repairPlan: plan });
    assert.equal(output.status, "blocked_dependency");
  });
});
