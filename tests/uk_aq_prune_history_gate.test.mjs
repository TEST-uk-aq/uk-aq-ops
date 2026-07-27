import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { isAcceptedPruneHistoryDayManifestKey } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { filterBucketsByConnectorHistoryGate } from "../workers/uk_aq_prune_daily/server.mjs";
import {
  canonicalObservationConnectorManifestKey,
  connectorDayGateKey,
  isValidConnectorHistoryGateEvidence,
  setConnectorDayGateIncomplete,
} from "../workers/shared/uk_aq_connector_day_gate.mjs";

test("prune history day manifest gate accepts v1 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v1/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate accepts v2 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate rejects missing or empty keys", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey(null), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(undefined), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(""), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("   "), false);
});

test("prune history day manifest gate rejects non-day and malformed paths", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-6-12/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/not-manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v3/observations/day_utc=2026-06-12/manifest.json"), false);
});

test("prune history day manifest gate rejects connector and pollutant manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/manifest.json"),
    false,
  );
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/pollutant_code=no2/manifest.json"),
    false,
  );
});

test("connector-day gate separates deletion authority and Integrity write modes", async () => {
  const dayUtc = "2026-06-12";
  const completeConnectorTwo = {
    day_utc: dayUtc,
    connector_id: 2,
    history_done: true,
    history_manifest_key: canonicalObservationConnectorManifestKey(dayUtc, 2),
    history_manifest_hash: "a".repeat(64),
    history_completed_at: "2026-06-13T01:02:03.000Z",
  };
  assert.equal(isValidConnectorHistoryGateEvidence(completeConnectorTwo), true);
  for (const missingField of [
    "history_manifest_key",
    "history_manifest_hash",
    "history_completed_at",
  ]) {
    assert.equal(
      isValidConnectorHistoryGateEvidence({ ...completeConnectorTwo, [missingField]: null }),
      false,
      `${missingField} must fail closed`,
    );
  }

  const gateMap = new Map([
    [connectorDayGateKey(dayUtc, 2), true],
  ]);
  const buckets = [1, 2].map((connectorId) => ({
    connector_id: String(connectorId),
    hour_start: `${dayUtc}T05:00:00.000Z`,
    observation_count: 10n,
  }));
  const preRepair = filterBucketsByConnectorHistoryGate(buckets, gateMap);
  const postRepair = filterBucketsByConnectorHistoryGate(buckets, gateMap);
  const aggregateDayHistoryDone = false;
  assert.equal(aggregateDayHistoryDone, false);
  for (const result of [preRepair, postRepair]) {
    assert.deepEqual(result.allowedBuckets.map((bucket) => bucket.connector_id), ["2"]);
    assert.deepEqual(result.blockedBuckets.map((bucket) => bucket.connector_id), ["1"]);
    assert.equal(result.blockedBuckets[0].day_utc, dayUtc);
    assert.equal(result.blockedBuckets[0].reason, "history_not_complete_for_connector_day");
  }

  // Aggregate day truth is deliberately absent from the connector map and
  // therefore cannot grant connector 1 deletion authority.
  const aggregateDayGate = new Map([[dayUtc, true]]);
  assert.equal(aggregateDayGate.get(dayUtc), true);
  assert.equal(preRepair.blockedBuckets.some((bucket) => bucket.connector_id === "1"), true);

  const simulatedGateState = new Map([
    [connectorDayGateKey(dayUtc, 1), true],
    [connectorDayGateKey(dayUtc, 2), true],
  ]);
  const fakeClient = {
    async query(_sql, params) {
      simulatedGateState.set(connectorDayGateKey(params[0], params[1]), false);
      return { rowCount: 1, rows: [] };
    },
  };
  await setConnectorDayGateIncomplete(fakeClient, { day_utc: dayUtc, connector_id: 1 });
  assert.equal(simulatedGateState.get(connectorDayGateKey(dayUtc, 1)), false);
  assert.equal(simulatedGateState.get(connectorDayGateKey(dayUtc, 2)), true);

  const implementationPath = path.resolve(
    "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
  );
  const python = spawnSync("python3", [
    "-c",
    [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('integrity_impl', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps([module.integrity_connector_gate_writes_allowed(mode) for mode in ['check_only', 'repair_dry_run', 'repair_apply']]))",
    ].join("; "),
    implementationPath,
  ], { encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout.trim()), [false, false, true]);
});
