import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
  buildHistoryV2PollutantManifest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { runV2ObservationsRepair } from "../scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs";

const DAY = "2026-05-17";
const PREFIX = "history/v2/observations";
const ENV = {
  CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
  CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
  CFLARE_R2_ACCESS_KEY_ID: "key",
  CFLARE_R2_SECRET_ACCESS_KEY: "secret",
};

function installFakeR2(objects) {
  const originalFetch = globalThis.fetch;
  const puts = new Map();
  const bodyFor = (key) => puts.get(key) || objects[key];
  const keyFromUrl = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/[^/]+\//, "");
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsed = new URL(url);
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") || "";
      const keys = [...new Set([...Object.keys(objects), ...puts.keys()])].filter((key) => key.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size><ETag>\"${key}\"</ETag></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
    }
    const key = keyFromUrl(url);
    if (method === "HEAD") return bodyFor(key) ? new Response(null, { status: 200, headers: { etag: `\"${key}\"` } }) : new Response(null, { status: 404 });
    if (method === "GET") return bodyFor(key) ? new Response(bodyFor(key), { status: 200, headers: { etag: `\"${key}\"` } }) : new Response("not found", { status: 404 });
    if (method === "PUT") { puts.set(key, String(init.body)); return new Response("", { status: 200, headers: { etag: `\"${key}\"` } }); }
    return new Response("unsupported", { status: 405 });
  };
  return { puts, restore: () => { globalThis.fetch = originalFetch; } };
}

function pollutant(connectorId, code) {
  const key = `${PREFIX}/day_utc=${DAY}/connector_id=${connectorId}/pollutant_code=${code}/manifest.json`;
  return buildHistoryV2PollutantManifest({
    domain: "observations", dayUtc: DAY, connectorId, pollutantCode: code, runId: "fixture",
    manifestKey: key, writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z", sourceRowCount: 1,
    fileEntries: [{ key: key.replace("manifest.json", "part-00000.parquet"), bytes: 1, row_count: 1, etag_or_hash: "part", min_timeseries_id: connectorId, max_timeseries_id: connectorId, min_observed_at_utc: `${DAY}T00:00:00.000Z`, max_observed_at_utc: `${DAY}T00:00:00.000Z`, timeseries_row_counts: { [connectorId]: 1 } }],
  });
}

test("Phase 3 O3 repair preserves pollutant and connector siblings and is idempotent", async () => {
  const o3 = pollutant(1, "o3");
  const pm25 = pollutant(1, "pm25");
  const no2 = pollutant(2, "no2");
  const staleConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 1, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=1/manifest.json`, pollutantManifests: [pm25], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const siblingConnector = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: DAY, connectorId: 2, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/connector_id=2/manifest.json`, pollutantManifests: [no2], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const staleDay = buildHistoryV2DayManifest({ domain: "observations", dayUtc: DAY, runId: "fixture", manifestKey: `${PREFIX}/day_utc=${DAY}/manifest.json`, connectorManifests: [staleConnector, siblingConnector], writerGitSha: "fixture", backedUpAtUtc: "2026-05-18T00:00:00.000Z" });
  const objects = Object.fromEntries([[o3.manifest_key, JSON.stringify(o3, null, 2)], [pm25.manifest_key, JSON.stringify(pm25, null, 2)], [no2.manifest_key, JSON.stringify(no2, null, 2)], [staleConnector.manifest_key, JSON.stringify(staleConnector, null, 2)], [siblingConnector.manifest_key, JSON.stringify(siblingConnector, null, 2)], [staleDay.manifest_key, JSON.stringify(staleDay, null, 2)]]);
  const fake = installFakeR2(objects);
  const repairPlan = { history_version: "v2", domain: "observations", repair_plan: [{ kind: "observation_connector_manifest_repair", status: "planned", executes: false, day_utc: DAY, connector_id: 1, pollutant_code: "o3", requires_index_rebuild: false }] };
  try {
    const first = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan });
    assert.equal(first.status, "succeeded");
    assert.equal(fake.puts.size, 2);
    assert.deepEqual(JSON.parse(fake.puts.get(staleConnector.manifest_key)).pollutant_codes, ["o3", "pm25"]);
    assert.deepEqual(JSON.parse(fake.puts.get(staleDay.manifest_key)).connector_ids, [1, 2]);
    assert.equal([...fake.puts.keys()].some((key) => key.endsWith(".parquet") || key.includes("aqilevels")), false);
    const second = await runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan });
    assert.equal(second.status, "skipped_unchanged");
    assert.equal(fake.puts.size, 2);
  } finally { fake.restore(); }
});

test("Phase 3 executor rejects AQI and non-CIC-Test writes before R2 access", async () => {
  const plan = { history_version: "v2", domain: "observations", repair_plan: [{ kind: "aqi_rebuild", status: "planned", executes: false, day_utc: DAY, connector_id: 1 }] };
  await assert.rejects(runV2ObservationsRepair({ argv: ["--write-r2"], env: ENV, repairPlan: plan }), /Unsupported Phase 3 repair action/);
  const supported = { history_version: "v2", domain: "observations", repair_plan: [{ kind: "observation_index_repair", status: "planned", executes: false, day_utc: DAY, connector_id: 1 }] };
  await assert.rejects(runV2ObservationsRepair({ argv: ["--write-r2"], env: { ...ENV, CFLARE_R2_BUCKET: "uk-aq-history-live" }, repairPlan: supported }), /outside CIC-Test/);
});
