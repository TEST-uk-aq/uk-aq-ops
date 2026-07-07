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
  buildPruneComparisonRowsQueryForTest,
  resolvePhaseBRuntimeConfig,
  resolvePhaseBHistoryWritePrefixes,
  shouldResetManifestlessV2ResumeForTest,
  writeCommittedV2PartAndCheckpointForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const DAY = "2026-06-14";
const RUN_ID = "test-run";

function runManifestKey(prefix, runId = RUN_ID) {
  return `${prefix}/run_id=${runId}/run_manifest.json`;
}

test("Phase B observations include source-provided DAQI index properties by default", () => {
  const resolved = resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: "v2" });

  assert.deepEqual(
    resolved.observations_pollutant_codes,
    ["pm25", "pm10", "no2", "pm25index", "pm10index", "no2index"],
  );
});

test("Phase B resets a stale v2 checkpoint when cleanup already removed all partial objects", () => {
  assert.equal(shouldResetManifestlessV2ResumeForTest({
    connectorManifestExists: false,
    existingEntryCount: 0,
    resumePartIndex: 2,
    resumeParts: [{ key: "missing-part.parquet" }],
  }), true);

  assert.equal(shouldResetManifestlessV2ResumeForTest({
    connectorManifestExists: false,
    existingEntryCount: 0,
    resumePartIndex: 0,
    resumeParts: [],
  }), false);
});

test("Phase B v2 resolves AQI levels to v2 hourly data and debug prefixes", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_VERSION: "v2" });

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

test("Phase B v2 Dropbox prune comparison uses the same observations pollutant allow-list", () => {
  const query = buildPruneComparisonRowsQueryForTest({
    runtime: {
      history_write_version: "v2",
      observations_pollutant_codes: ["PM10", "pm25", "NO2", "pm25index", "pm10index", "no2index", "pm10", ""],
    },
    connectorId: 2,
    dayStart: "2026-07-02T00:00:00.000Z",
    dayEnd: "2026-07-03T00:00:00.000Z",
  });

  assert.match(query.sql, /uk_aq_phase_b_history_rows_v2/);
  assert.doesNotMatch(query.sql, /uk_aq_phase_b_history_rows\(/);
  assert.match(query.sql, /lower\(pollutant_code\) = any\(\$6::text\[\]\)/);
  assert.deepEqual(query.params, [
    2,
    "2026-07-02T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
    null,
    null,
    ["pm10", "pm25", "no2", "pm25index", "pm10index", "no2index"],
  ]);
  assert.equal(query.comparison_filter_mode, "v2_observations_pollutant_allow_list");
  assert.equal(query.comparison_scope, "history_eligible_observations");
});

test("Phase B v2 observation checkpoints count only rows eligible for history", async () => {
  const committedPrefix = "history/v2/observations";
  const written = new Map();
  const checkpointCalls = [];
  const logEvents = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/bucket\//, ""));
    if (init.method === "PUT") {
      written.set(key, Buffer.from(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200, headers: { etag: `etag-${written.size}` } });
    }
    if (init.method === "HEAD") {
      return written.has(key)
        ? new Response(null, {
          status: 200,
          headers: { etag: "etag-head", "content-length": String(written.get(key).byteLength) },
        })
        : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected fetch ${init.method} ${url}`);
  };

  try {
    const result = await writeCommittedV2PartAndCheckpointForTest({
      streamClient: {},
      runtime: {
        run_id: RUN_ID,
        history_write_version: "v2",
        committed_prefix: committedPrefix,
        observations_pollutant_codes: ["pm10", "pm25"],
        observations_row_group_size: 1000,
        checkpoint_client_for_test: {
          async query(_sql, params) {
            checkpointCalls.push(params);
            return { rows: [], rowCount: 1 };
          },
        },
        logStructured(severity, event, fields) {
          logEvents.push({ severity, event, fields });
        },
        r2: {
          endpoint: "https://r2.example.test",
          bucket: "bucket",
          region: "auto",
          access_key_id: "key",
          secret_access_key: "secret",
        },
      },
      dayUtc: DAY,
      connectorId: 7,
      partIndex: 0,
      rows: [
        { connector_id: 7, station_id: 1, timeseries_id: 101, pollutant_code: "pm10", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 10 },
        { connector_id: 7, station_id: 1, timeseries_id: 102, pollutant_code: "temperature", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 18 },
        { connector_id: 7, station_id: 1, timeseries_id: 103, pollutant_code: "pm25", observed_at_utc: `${DAY}T00:00:00.000Z`, value: 8 },
      ],
      committedParts: [],
      observedRows: 0n,
      totalBytes: 0n,
    });

    assert.equal(result.observedRows, 2n);
    assert.equal(result.committedParts.length, 2);
    assert.equal(written.has(buildHistoryV2PartKey(committedPrefix, DAY, 7, "pm10", 0)), true);
    assert.equal(written.has(buildHistoryV2PartKey(committedPrefix, DAY, 7, "pm25", 0)), true);
    assert.equal(written.has(buildHistoryV2PartKey(committedPrefix, DAY, 7, "temperature", 0)), false);
    assert.equal(checkpointCalls.length, 1);
    assert.equal(checkpointCalls[0][6], "2");

    const plan = logEvents.find((entry) => entry.event === "phase_b_history_connector_pollutant_plan");
    assert.deepEqual(plan.fields.source_pollutant_codes, ["pm10", "pm25", "temperature"]);
    assert.deepEqual(plan.fields.write_pollutant_codes, ["pm10", "pm25"]);
    assert.deepEqual(plan.fields.excluded_pollutant_codes, ["temperature"]);
    assert.equal(plan.fields.row_count, 3);
    assert.equal(plan.fields.eligible_for_history_count, 2);
    assert.equal(plan.fields.excluded_row_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Phase B rejects deprecated split write version", () => {
  assert.throws(
    () => resolvePhaseBHistoryWritePrefixes({
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_WRITE_VERSION: "v2",
    }),
    /UK_AQ_R2_HISTORY_WRITE_VERSION/,
  );
});

test("Phase B v2 resolves run manifests to the v2 ops prefix even when legacy runs prefix is present", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({
    UK_AQ_R2_HISTORY_VERSION: "v2",
    UK_AQ_R2_HISTORY_RUNS_PREFIX: "history/v1/_ops/observations/runs",
  });

  assert.equal(resolved.runs_prefix, "history/v2/_ops/observations/runs");
  assert.equal(
    runManifestKey(resolved.runs_prefix),
    "history/v2/_ops/observations/runs/run_id=test-run/run_manifest.json",
  );
});

test("Phase B v1 keeps existing v1 AQI levels and run manifest prefixes", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_VERSION: "v1" });

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
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_VERSION: "v2" });
  const dayManifestKey = buildDayManifestKey(resolved.aqilevels_prefix, DAY);
  const connectorManifestKey = buildConnectorManifestKey(resolved.aqilevels_prefix, DAY, 7);
  const runKey = runManifestKey(resolved.runs_prefix);

  assert.equal(dayManifestKey.startsWith("history/v1/aqilevels/hourly"), false);
  assert.equal(connectorManifestKey.startsWith("history/v1/aqilevels/hourly"), false);
  assert.equal(runKey.startsWith("history/v1/_ops/observations/runs"), false);
});


test("Phase B v2 AQI data paths are pollutant-partitioned and not connector-level parquet", () => {
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_VERSION: "v2" });
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
  const resolved = resolvePhaseBHistoryWritePrefixes({ UK_AQ_R2_HISTORY_VERSION: "v2" });
  assert.equal(
    buildHistoryV2PollutantManifestKey(resolved.aqilevels_hourly_debug_prefix_v2, DAY, 7, "pm10"),
    "history/v2/aqilevels/hourly/debug/day_utc=2026-06-14/connector_id=7/pollutant_code=pm10/manifest.json",
  );
  assert.equal(
    buildHistoryV2PartKey(resolved.aqilevels_hourly_debug_prefix_v2, DAY, 7, "pm10", 0),
    "history/v2/aqilevels/hourly/debug/day_utc=2026-06-14/connector_id=7/pollutant_code=pm10/part-00000.parquet",
  );
});

import { parquetMetadata } from "hyparquet";
import {
  HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2,
  HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2,
  discoverPendingAqilevelDaysForTest,
  exportAqilevelDayToR2ForTest,
  rowsToAqilevelDataV2ParquetBufferForTest,
  rowsToAqilevelDebugV2ParquetBufferForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

function parquetColumnNames(buffer) {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return parquetMetadata(arrayBuffer).schema.map((field) => field.name).filter((name) => name !== "arrow_schema");
}

const AQI_ROW = Object.freeze({ connector_id: 7, station_id: 11, timeseries_id: 101, pollutant_code: "pm10", timestamp_hour_utc: "2026-06-14T00:00:00.000Z", daqi_input_value_ugm3: 12.5, daqi_input_averaging_code: "hourly", daqi_index_level: 2, daqi_source_observation_count: 18, daqi_required_observation_count: 18, daqi_calculation_status: "ok", daqi_missing_reason: null, eaqi_input_value_ugm3: 12.5, eaqi_input_averaging_code: "hourly", eaqi_index_level: 1, eaqi_source_observation_count: 18, eaqi_required_observation_count: 18, eaqi_calculation_status: "ok", eaqi_missing_reason: null, hourly_sample_count: 18, algorithm_version: "test-v1", computed_at_utc: "2026-06-14T00:05:00.000Z" });

test("Phase B v2 AQI Parquet writers split data and debug columns", () => {
  const dataBuffer = rowsToAqilevelDataV2ParquetBufferForTest([AQI_ROW]);
  const debugBuffer = rowsToAqilevelDebugV2ParquetBufferForTest([AQI_ROW]);
  assert.deepEqual(parquetColumnNames(dataBuffer), HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2);
  assert.deepEqual(parquetColumnNames(debugBuffer), HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2);
});

test("Phase B v2 AQI debug manifests use debug profile and debug columns", () => {
  const debugPrefix = "history/v2/aqilevels/hourly/debug";
  const pollutantManifest = buildHistoryV2PollutantManifestForTest({ domain: "aqilevels", grain: "hourly", profile: "debug", dayUtc: DAY, connectorId: 7, pollutantCode: "pm10", runId: "test-run", manifestKey: buildHistoryV2PollutantManifestKey(debugPrefix, DAY, 7, "pm10"), sourceRowCount: 1, fileEntries: [{ key: buildHistoryV2PartKey(debugPrefix, DAY, 7, "pm10", 0), row_count: 1, bytes: 456, pollutant_code: "pm10", min_timeseries_id: 101, max_timeseries_id: 101, min_timestamp_hour_utc: "2026-06-14T00:00:00.000Z", max_timestamp_hour_utc: "2026-06-14T00:00:00.000Z", timeseries_row_counts: { 101: 1 } }], writerGitSha: "test-sha", backedUpAtUtc: "2026-06-15T00:00:00.000Z" });
  assert.equal(pollutantManifest.profile, "debug");
  assert.deepEqual(pollutantManifest.columns, HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2);
});

test("Phase B v2 AQI discovery requires both data and debug day manifests", async () => {
  const dataPrefix = "history/v2/aqilevels/hourly/data";
  const debugPrefix = "history/v2/aqilevels/hourly/debug";
  const client = { async query() { return { rows: ["2026-06-16", "2026-06-15", "2026-06-14"].map((day_utc) => ({ day_utc })) }; } };
  const headKeys = [];
  const existing = new Set([buildDayManifestKey(dataPrefix, "2026-06-16"), buildDayManifestKey(debugPrefix, "2026-06-16"), buildDayManifestKey(dataPrefix, "2026-06-15"), buildDayManifestKey(debugPrefix, "2026-06-14")]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method, "HEAD");
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/bucket\//, ""));
    headKeys.push(key);
    return new Response(null, { status: existing.has(key) ? 200 : 404, headers: existing.has(key) ? { "content-length": "1" } : {} });
  };
  try {
    const pending = await discoverPendingAqilevelDaysForTest({ client, latestEligibleDayUtc: "2026-06-16", runtime: { history_write_version: "v2", max_candidates_per_run: 10, aqilevels_prefix: dataPrefix, aqilevels_hourly_debug_prefix_v2: debugPrefix, r2: { endpoint: "https://r2.example.test", bucket: "bucket", region: "auto", access_key_id: "key", secret_access_key: "secret" } } });
    assert.deepEqual(pending, ["2026-06-14", "2026-06-15"]);
    assert.deepEqual(headKeys, [buildDayManifestKey(dataPrefix, "2026-06-16"), buildDayManifestKey(debugPrefix, "2026-06-16"), buildDayManifestKey(dataPrefix, "2026-06-15"), buildDayManifestKey(debugPrefix, "2026-06-15"), buildDayManifestKey(dataPrefix, "2026-06-14")]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Phase B v2 AQI export writes data and debug profile objects and manifests", async () => {
  const dataPrefix = "history/v2/aqilevels/hourly/data";
  const debugPrefix = "history/v2/aqilevels/hourly/debug";
  const written = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "source.example.test") {
      const rpcName = parsed.pathname.split("/").pop();
      if (rpcName === "connector_counts") return Response.json([{ connector_id: 7, expected_row_count: "1" }]);
      if (rpcName === "rows") return Response.json(JSON.parse(init.body || "{}").p_after_timeseries_id === null ? [AQI_ROW] : []);
    }
    const key = decodeURIComponent(parsed.pathname.replace(/^\/bucket\//, ""));
    if (init.method === "PUT") { written.set(key, Buffer.from(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 200, headers: { etag: `etag-${written.size}` } }); }
    if (init.method === "HEAD") return written.has(key) ? new Response(null, { status: 200, headers: { etag: "etag-head", "content-length": String(written.get(key).byteLength) } }) : new Response(null, { status: 404 });
    throw new Error(`Unexpected fetch ${init.method} ${url}`);
  };
  try {
    const result = await exportAqilevelDayToR2ForTest({ dayUtc: DAY, runtime: { history_write_version: "v2", run_id: "test-run", writer_git_sha: "test-sha", aqilevels_prefix: dataPrefix, aqilevels_hourly_debug_prefix_v2: debugPrefix, aqilevels_row_group_size: 1000, aqilevels_part_max_rows: 1000, aqilevels_source_max_pages: 10, cursor_fetch_rows: 1000, aqilevels_source: { base_url: "https://source.example.test", privileged_key: "secret", rpc_schema: "uk_aq_ops", connector_counts_rpc: "connector_counts", rows_rpc: "rows" }, r2: { endpoint: "https://r2.example.test", bucket: "bucket", region: "auto", access_key_id: "key", secret_access_key: "secret" } } });
    assert.equal(written.has(buildHistoryV2PartKey(dataPrefix, DAY, 7, "pm10", 0)), true);
    assert.equal(written.has(buildHistoryV2PartKey(debugPrefix, DAY, 7, "pm10", 0)), true);
    assert.equal(written.has(buildHistoryV2PollutantManifestKey(dataPrefix, DAY, 7, "pm10")), true);
    assert.equal(written.has(buildHistoryV2PollutantManifestKey(debugPrefix, DAY, 7, "pm10")), true);
    assert.equal(written.has(buildConnectorManifestKey(dataPrefix, DAY, 7)), true);
    assert.equal(written.has(buildConnectorManifestKey(debugPrefix, DAY, 7)), true);
    assert.equal(written.has(buildDayManifestKey(dataPrefix, DAY)), true);
    assert.equal(written.has(buildDayManifestKey(debugPrefix, DAY)), true);
    assert.equal(result.file_count, 1);
    assert.equal(result.debug_file_count, 1);
    assert.equal(result.debug_day_manifest_key, buildDayManifestKey(debugPrefix, DAY));
    assert.equal(JSON.parse(written.get(buildDayManifestKey(dataPrefix, DAY)).toString("utf8")).profile, "data");
    assert.equal(JSON.parse(written.get(buildDayManifestKey(debugPrefix, DAY)).toString("utf8")).profile, "debug");
  } finally { globalThis.fetch = originalFetch; }
});
