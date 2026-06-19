import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectorManifestKey,
  buildDayManifestKey,
  resolvePhaseBHistoryWritePrefixes,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const DAY = "2026-06-14";
const RUN_ID = "test-run";

function runManifestKey(prefix, runId = RUN_ID) {
  return `${prefix}/run_id=${runId}/run_manifest.json`;
}

test("Phase B v2 resolves AQI levels to v2 hourly data and debug prefixes", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" });

  assert.equal(resolved.history_write_version, "v2");
  assert.equal(resolved.aqilevels_prefix, "history/v2/aqilevels/hourly/data");
  assert.equal(resolved.aqilevels_hourly_debug_prefix_v2, "history/v2/aqilevels/hourly/debug");
  assert.equal(
    buildDayManifestKey(resolved.aqilevels_prefix, DAY),
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-14/manifest.json",
  );
  assert.equal(
    buildConnectorManifestKey(resolved.aqilevels_prefix, DAY, 7),
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-14/connector_id=7/manifest.json",
  );
});

test("Phase B v2 resolves run manifests to the v2 ops prefix even when legacy runs prefix is present", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({
    UK_AQ_R2_HISTORY_WRITE_VERSION: "v2",
    UK_AQ_R2_HISTORY_RUNS_PREFIX: "history/v1/_ops/observations/runs",
  });

  assert.equal(resolved.runs_prefix, "history/v2/_ops/observations/runs");
  assert.equal(
    runManifestKey(resolved.runs_prefix),
    "history/v2/_ops/observations/runs/run_id=test-run/run_manifest.json",
  );
});

test("Phase B v1 keeps existing v1 AQI levels and run manifest prefixes", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v1" });

  assert.equal(resolved.history_write_version, "v1");
  assert.equal(resolved.aqilevels_prefix, "history/v1/aqilevels/hourly");
  assert.equal(resolved.runs_prefix, "history/v1/_ops/observations/runs");
  assert.equal(
    buildDayManifestKey(resolved.aqilevels_prefix, DAY),
    "history/v1/aqilevels/hourly/day_utc=2026-06-14/manifest.json",
  );
  assert.equal(
    runManifestKey(resolved.runs_prefix),
    "history/v1/_ops/observations/runs/run_id=test-run/run_manifest.json",
  );
});

test("Phase B v2 write targets do not resolve AQI or run manifests under legacy v1 prefixes", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" });
  const dayManifestKey = buildDayManifestKey(resolved.aqilevels_prefix, DAY);
  const connectorManifestKey = buildConnectorManifestKey(resolved.aqilevels_prefix, DAY, 7);
  const runKey = runManifestKey(resolved.runs_prefix);

  assert.equal(dayManifestKey.startsWith("history/v1/aqilevels/hourly"), false);
  assert.equal(connectorManifestKey.startsWith("history/v1/aqilevels/hourly"), false);
  assert.equal(runKey.startsWith("history/v1/_ops/observations/runs"), false);
});
