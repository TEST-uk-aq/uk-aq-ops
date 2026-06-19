import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectorManifestKey,
  buildDayManifestKey,
  buildHistoryV2ConnectorManifestForTest,
  buildHistoryV2DayManifestForTest,
  buildHistoryV2PartKey,
  buildHistoryV2PollutantManifestForTest,
  buildHistoryV2PollutantManifestKey,
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


test("Phase B v2 AQI data paths are pollutant-partitioned and not connector-level parquet", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" });
  const pollutantManifestKey = buildHistoryV2PollutantManifestKey(resolved.aqilevels_prefix, "2026-06-13", 3, "pm25");
  const pollutantPartKey = buildHistoryV2PartKey(resolved.aqilevels_prefix, "2026-06-13", 3, "pm25", 0);
  const oldBadConnectorPartKey = `${resolved.aqilevels_prefix}/day_utc=2026-06-13/connector_id=3/part-00000.parquet`;

  assert.equal(
    pollutantManifestKey,
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-13/connector_id=3/pollutant_code=pm25/manifest.json",
  );
  assert.equal(
    pollutantPartKey,
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-13/connector_id=3/pollutant_code=pm25/part-00000.parquet",
  );
  assert.notEqual(pollutantPartKey, oldBadConnectorPartKey);
});

test("Phase B v2 AQI manifests point day and connector parents at child pollutant manifests", () => {
  const dataPrefix = "history/v2/aqilevels/hourly/data";
  const pollutantManifestKey = buildHistoryV2PollutantManifestKey(dataPrefix, "2026-06-13", 3, "pm25");
  const pollutantPartKey = buildHistoryV2PartKey(dataPrefix, "2026-06-13", 3, "pm25", 0);
  const pollutantManifest = buildHistoryV2PollutantManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    dayUtc: "2026-06-13",
    connectorId: 3,
    pollutantCode: "pm25",
    runId: "test-run",
    manifestKey: pollutantManifestKey,
    sourceRowCount: 2,
    fileEntries: [{
      key: pollutantPartKey,
      row_count: 2,
      bytes: 123,
      pollutant_code: "pm25",
      min_timeseries_id: 10,
      max_timeseries_id: 10,
      min_timestamp_hour_utc: "2026-06-13T00:00:00.000Z",
      max_timestamp_hour_utc: "2026-06-13T01:00:00.000Z",
      timeseries_row_counts: { 10: 2 },
    }],
    writerGitSha: "test-sha",
    backedUpAtUtc: "2026-06-15T00:00:00.000Z",
  });
  const connectorManifest = buildHistoryV2ConnectorManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    dayUtc: "2026-06-13",
    connectorId: 3,
    runId: "test-run",
    manifestKey: buildConnectorManifestKey(dataPrefix, "2026-06-13", 3),
    pollutantManifests: [pollutantManifest],
    writerGitSha: "test-sha",
    backedUpAtUtc: "2026-06-15T00:00:00.000Z",
  });
  const dayManifest = buildHistoryV2DayManifestForTest({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    dayUtc: "2026-06-13",
    runId: "test-run",
    manifestKey: buildDayManifestKey(dataPrefix, "2026-06-13"),
    connectorManifests: [connectorManifest],
    writerGitSha: "test-sha",
    backedUpAtUtc: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(pollutantManifest.history_version, "v2");
  assert.equal(pollutantManifest.domain, "aqilevels");
  assert.equal(pollutantManifest.profile, "data");
  assert.equal(pollutantManifest.pollutant_code, "pm25");
  assert.equal(pollutantManifest.files[0].key, pollutantPartKey);
  assert.deepEqual(pollutantManifest.timeseries_row_counts, { 10: 2 });
  assert.equal(connectorManifest.child_manifests[0].manifest_key, pollutantManifestKey);
  assert.equal(connectorManifest.child_manifests[0].pollutant_code, "pm25");
  assert.equal(dayManifest.child_manifests[0].manifest_key, connectorManifest.manifest_key);
  assert.deepEqual(dayManifest.pollutant_codes, ["pm25"]);
});

test("Phase B v2 AQI debug paths use the same pollutant partition shape", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" });
  assert.equal(
    buildHistoryV2PollutantManifestKey(resolved.aqilevels_hourly_debug_prefix_v2, DAY, 7, "pm10"),
    "history/v2/aqilevels/hourly/debug/day_utc=2026-06-14/connector_id=7/pollutant_code=pm10/manifest.json",
  );
  assert.equal(
    buildHistoryV2PartKey(resolved.aqilevels_hourly_debug_prefix_v2, DAY, 7, "pm10", 0),
    "history/v2/aqilevels/hourly/debug/day_utc=2026-06-14/connector_id=7/pollutant_code=pm10/part-00000.parquet",
  );
});
