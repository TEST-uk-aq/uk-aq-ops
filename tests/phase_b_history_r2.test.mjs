import test from "node:test";
import assert from "node:assert/strict";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import {
  HISTORY_AQILEVELS_COLUMNS,
  HISTORY_OBSERVATIONS_COLUMNS_V2,
  buildAqilevelConnectorManifestForTest,
  buildAqilevelDayManifestForTest,
  buildConnectorManifestForTest,
  computeDayGateState,
  dayWindowFromNow,
  normalizeAqilevelHistoryRowForTest,
  resolvePhaseBRuntimeConfig,
  rowsToAqilevelParquetBufferForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

test("connector manifest includes expected Phase B fields", () => {
  const manifest = buildConnectorManifestForTest({
    dayUtc: "2026-02-20",
    connectorId: 4,
    runId: "run-123",
    sourceRowCount: 3,
    minObservedAt: "2026-02-20T00:00:00.000Z",
    maxObservedAt: "2026-02-20T00:02:00.000Z",
    fileEntries: [
      {
        key: "history/v1/observations/day_utc=2026-02-20/connector_id=4/part-00000.parquet",
        bytes: 1200,
        row_count: 3,
        etag_or_hash: "etag-a",
      },
    ],
    writerGitSha: "abc123",
    backedUpAtUtc: "2026-03-02T11:00:00.000Z",
  });

  assert.equal(manifest.day_utc, "2026-02-20");
  assert.equal(manifest.connector_id, 4);
  assert.equal(manifest.run_id, "run-123");
  assert.equal(manifest.source_row_count, 3);
  assert.equal(manifest.file_count, 1);
  assert.equal(manifest.total_bytes, 1200);
  assert.deepEqual(manifest.columns, HISTORY_OBSERVATIONS_COLUMNS_V2);
  assert.ok(Array.isArray(manifest.parquet_object_keys));
  assert.equal(manifest.parquet_object_keys.length, 1);
  assert.equal(typeof manifest.manifest_hash, "string");
  assert.ok(manifest.manifest_hash.length > 10);
  assert.equal(manifest.history_schema_name, "observations");
  assert.equal(manifest.history_schema_version, 2);
});

test("day gate is only complete when all connector candidates are complete", () => {
  const pendingState = computeDayGateState([
    { status: "complete" },
    { status: "pending" },
  ]);
  assert.equal(pendingState.all_complete, false);
  assert.equal(pendingState.complete, 1);
  assert.equal(pendingState.pending, 1);

  const failedState = computeDayGateState([
    { status: "complete" },
    { status: "failed" },
  ]);
  assert.equal(failedState.all_complete, false);
  assert.equal(failedState.failed, 1);

  const completeState = computeDayGateState([
    { status: "complete" },
    { status: "complete" },
  ]);
  assert.equal(completeState.all_complete, true);
  assert.equal(completeState.complete, 2);
  assert.equal(completeState.pending, 0);
  assert.equal(completeState.in_progress, 0);
  assert.equal(completeState.failed, 0);
});

test("runtime config includes AQI levels prefix defaults", () => {
  const config = resolvePhaseBRuntimeConfig({});
  assert.equal(config.committed_prefix, "history/v1/observations");
  assert.equal(config.aqilevels_prefix, "history/v1/aqilevels/hourly");
  assert.equal(config.observations_part_max_rows, 500000);
  assert.equal(config.observations_row_group_size, 50000);
  assert.equal(config.aqilevels_part_max_rows, 1000000);
  assert.equal(config.aqilevels_row_group_size, 100000);
});

test("runtime config supports domain-specific parquet geometry overrides", () => {
  const config = resolvePhaseBRuntimeConfig({
    UK_AQ_R2_HISTORY_PART_MAX_ROWS: "900000",
    UK_AQ_R2_HISTORY_ROW_GROUP_SIZE: "90000",
    UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS: "250000",
    UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE: "25000",
    UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS: "1200000",
    UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE: "120000",
  });
  assert.equal(config.part_max_rows, 900000);
  assert.equal(config.row_group_size, 90000);
  assert.equal(config.observations_part_max_rows, 250000);
  assert.equal(config.observations_row_group_size, 25000);
  assert.equal(config.aqilevels_part_max_rows, 1200000);
  assert.equal(config.aqilevels_row_group_size, 120000);
});

test("Phase B eligibility tracks ingest retention days", () => {
  const windowDefault = dayWindowFromNow("2026-03-17T11:00:00.000Z", 7);
  assert.equal(windowDefault.ingest_retention_days, 7);
  assert.equal(windowDefault.phase_b_eligible_age_days, 8);
  assert.equal(windowDefault.latest_eligible_day_utc, "2026-03-09");
  assert.equal(windowDefault.latest_eligible_window_end_utc, "2026-03-10T00:00:00.000Z");

  const windowFiveDay = dayWindowFromNow("2026-03-17T11:00:00.000Z", 5);
  assert.equal(windowFiveDay.ingest_retention_days, 5);
  assert.equal(windowFiveDay.phase_b_eligible_age_days, 6);
  assert.equal(windowFiveDay.latest_eligible_day_utc, "2026-03-11");
  assert.equal(windowFiveDay.latest_eligible_window_end_utc, "2026-03-12T00:00:00.000Z");
});

test("AQI connector manifest exposes hourly schema metadata and pollutant coverage", () => {
  const manifest = buildAqilevelConnectorManifestForTest({
    dayUtc: "2026-04-30",
    connectorId: 9,
    runId: "aqi-run-123",
    sourceRowCount: 3,
    minTimeseriesId: 301,
    maxTimeseriesId: 303,
    minTimestampHourUtc: "2026-04-30T00:00:00.000Z",
    maxTimestampHourUtc: "2026-04-30T02:00:00.000Z",
    fileEntries: [
      {
        key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=9/part-00000.parquet",
        bytes: 1200,
        row_count: 2,
        etag_or_hash: "etag-a",
        min_timeseries_id: 301,
        max_timeseries_id: 302,
        min_timestamp_hour_utc: "2026-04-30T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-04-30T01:00:00.000Z",
        pollutant_codes: ["pm25", "no2"],
      },
      {
        key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=9/part-00001.parquet",
        bytes: 800,
        row_count: 1,
        etag_or_hash: "etag-b",
        min_timeseries_id: 303,
        max_timeseries_id: 303,
        min_timestamp_hour_utc: "2026-04-30T02:00:00.000Z",
        max_timestamp_hour_utc: "2026-04-30T02:00:00.000Z",
        pollutant_codes: ["pm10"],
      },
    ],
    writerGitSha: "abc123",
    backedUpAtUtc: "2026-05-01T00:00:00.000Z",
  });

  assert.equal(manifest.day_utc, "2026-04-30");
  assert.equal(manifest.connector_id, 9);
  assert.equal(manifest.source_row_count, 3);
  assert.equal(manifest.file_count, 2);
  assert.equal(manifest.total_bytes, 2000);
  assert.equal(manifest.history_schema_name, "aqilevels_hourly");
  assert.equal(manifest.history_schema_version, 1);
  assert.equal(manifest.grain, "hourly");
  assert.equal(manifest.writer_version, "parquet-wasm-zstd-v1");
  assert.deepEqual(manifest.columns, HISTORY_AQILEVELS_COLUMNS);
  assert.deepEqual(manifest.available_pollutants, ["no2", "pm10", "pm25"]);
  assert.deepEqual(manifest.files[0].pollutant_codes, ["pm25", "no2"]);
  assert.deepEqual(manifest.files[1].pollutant_codes, ["pm10"]);
});

test("AQI day manifest aggregates hourly connector manifests", () => {
  const connectorManifests = [
    buildAqilevelConnectorManifestForTest({
      dayUtc: "2026-04-30",
      connectorId: 3,
      runId: "aqi-run-123",
      sourceRowCount: 2,
      minTimeseriesId: 201,
      maxTimeseriesId: 202,
      minTimestampHourUtc: "2026-04-30T03:00:00.000Z",
      maxTimestampHourUtc: "2026-04-30T04:00:00.000Z",
      fileEntries: [
        {
          key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
          bytes: 500,
          row_count: 2,
          etag_or_hash: "etag-3",
          min_timeseries_id: 201,
          max_timeseries_id: 202,
          min_timestamp_hour_utc: "2026-04-30T03:00:00.000Z",
          max_timestamp_hour_utc: "2026-04-30T04:00:00.000Z",
          pollutant_codes: ["pm25"],
        },
      ],
      writerGitSha: "abc123",
      backedUpAtUtc: "2026-05-01T00:10:00.000Z",
    }),
    buildAqilevelConnectorManifestForTest({
      dayUtc: "2026-04-30",
      connectorId: 9,
      runId: "aqi-run-123",
      sourceRowCount: 1,
      minTimeseriesId: 301,
      maxTimeseriesId: 301,
      minTimestampHourUtc: "2026-04-30T10:00:00.000Z",
      maxTimestampHourUtc: "2026-04-30T10:00:00.000Z",
      fileEntries: [
        {
          key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=9/part-00000.parquet",
          bytes: 250,
          row_count: 1,
          etag_or_hash: "etag-9",
          min_timeseries_id: 301,
          max_timeseries_id: 301,
          min_timestamp_hour_utc: "2026-04-30T10:00:00.000Z",
          max_timestamp_hour_utc: "2026-04-30T10:00:00.000Z",
          pollutant_codes: ["no2", "pm10"],
        },
      ],
      writerGitSha: "abc123",
      backedUpAtUtc: "2026-05-01T00:20:00.000Z",
    }),
  ];

  const manifest = buildAqilevelDayManifestForTest({
    dayUtc: "2026-04-30",
    runId: "aqi-run-123",
    connectorManifests,
    writerGitSha: "abc123",
    backedUpAtUtc: "2026-05-01T00:30:00.000Z",
  });

  assert.equal(manifest.day_utc, "2026-04-30");
  assert.equal(manifest.connector_id, null);
  assert.deepEqual(manifest.connector_ids, [3, 9]);
  assert.equal(manifest.source_row_count, 3);
  assert.equal(manifest.file_count, 2);
  assert.equal(manifest.total_bytes, 750);
  assert.equal(manifest.history_schema_name, "aqilevels_hourly");
  assert.equal(manifest.history_schema_version, 1);
  assert.equal(manifest.grain, "hourly");
  assert.equal(manifest.writer_version, "parquet-wasm-zstd-v1");
  assert.deepEqual(manifest.available_pollutants, ["no2", "pm10", "pm25"]);
  assert.deepEqual(manifest.connector_manifests.map((entry) => entry.available_pollutants), [
    ["pm25"],
    ["no2", "pm10"],
  ]);
  assert.deepEqual(manifest.files[0].pollutant_codes, ["pm25"]);
  assert.deepEqual(manifest.files[1].pollutant_codes, ["no2", "pm10"]);
});

test("AQI history row parser preserves the normalized hourly shape", () => {
  const parsed = normalizeAqilevelHistoryRowForTest({
    connector_id: "9",
    station_id: "1575",
    timeseries_id: "354",
    pollutant_code: "PM25",
    timestamp_hour_utc: "2026-04-30T10:00:00.000Z",
    daqi_input_value_ugm3: "12.3",
    daqi_input_averaging_code: "rolling_24h_mean",
    daqi_index_level: "4",
    daqi_source_observation_count: "24",
    daqi_required_observation_count: "24",
    daqi_calculation_status: "ok",
    daqi_missing_reason: "",
    eaqi_input_value_ugm3: "11.2",
    eaqi_input_averaging_code: "hourly_mean",
    eaqi_index_level: "3",
    eaqi_source_observation_count: "1",
    eaqi_required_observation_count: "1",
    eaqi_calculation_status: "ok",
    eaqi_missing_reason: null,
    hourly_sample_count: "24",
    algorithm_version: "aqilevels_hourly_v1",
    computed_at_utc: "2026-04-30T10:05:00.000Z",
    hourly_mean_ugm3: "11.2",
    rolling24h_mean_ugm3: "12.3",
    no2_hourly_mean_ugm3: null,
    pm25_hourly_mean_ugm3: "11.2",
    pm10_hourly_mean_ugm3: null,
    pm25_rolling24h_mean_ugm3: "12.3",
    pm10_rolling24h_mean_ugm3: null,
    daqi_no2_index_level: null,
    daqi_pm25_rolling24h_index_level: "4",
    daqi_pm10_rolling24h_index_level: null,
    eaqi_no2_index_level: null,
    eaqi_pm25_index_level: "3",
    eaqi_pm10_index_level: null,
    updated_at: "2026-04-30T10:06:00.000Z",
  }, 9);

  assert.deepEqual(Object.keys(parsed), HISTORY_AQILEVELS_COLUMNS);
  assert.equal(parsed.connector_id, 9);
  assert.equal(parsed.station_id, 1575);
  assert.equal(parsed.timeseries_id, 354);
  assert.equal(parsed.pollutant_code, "pm25");
  assert.equal(parsed.timestamp_hour_utc, "2026-04-30T10:00:00.000Z");
  assert.equal(parsed.daqi_input_averaging_code, "rolling_24h_mean");
  assert.equal(parsed.eaqi_index_level, 3);
  assert.equal(parsed.updated_at, "2026-04-30T10:06:00.000Z");
});

test("AQI parquet writer preserves nullable text and timestamp column types", () => {
  const parquetBuffer = rowsToAqilevelParquetBufferForTest([
    {
      connector_id: 1,
      station_id: 101,
      timeseries_id: 1001,
      pollutant_code: "pm25",
      timestamp_hour_utc: "2025-01-01T00:00:00.000Z",
      daqi_input_value_ugm3: 12.5,
      daqi_input_averaging_code: "rolling_24h_mean",
      daqi_index_level: 2,
      daqi_source_observation_count: 24,
      daqi_required_observation_count: 24,
      daqi_calculation_status: "ok",
      daqi_missing_reason: null,
      eaqi_input_value_ugm3: 10.5,
      eaqi_input_averaging_code: "hourly_mean",
      eaqi_index_level: 1,
      eaqi_source_observation_count: 1,
      eaqi_required_observation_count: 1,
      eaqi_calculation_status: "ok",
      eaqi_missing_reason: null,
      hourly_sample_count: 1,
      algorithm_version: "aqilevels_hourly_v1",
      computed_at_utc: null,
      hourly_mean_ugm3: 10.5,
      rolling24h_mean_ugm3: 12.5,
      no2_hourly_mean_ugm3: null,
      pm25_hourly_mean_ugm3: 10.5,
      pm10_hourly_mean_ugm3: null,
      pm25_rolling24h_mean_ugm3: 12.5,
      pm10_rolling24h_mean_ugm3: null,
      daqi_no2_index_level: null,
      daqi_pm25_rolling24h_index_level: 2,
      daqi_pm10_rolling24h_index_level: null,
      eaqi_no2_index_level: null,
      eaqi_pm25_index_level: 1,
      eaqi_pm10_index_level: null,
      updated_at: null,
    },
  ]);

  const wasmTable = parquetWasm.readParquet(new Uint8Array(parquetBuffer));
  const table = arrow.tableFromIPC(wasmTable.intoIPCStream());
  const fields = new Map(table.schema.fields.map((field) => [field.name, String(field.type)]));

  assert.equal(fields.get("daqi_input_averaging_code"), "Utf8");
  assert.equal(fields.get("daqi_calculation_status"), "Utf8");
  assert.equal(fields.get("eaqi_input_averaging_code"), "Utf8");
  assert.equal(fields.get("eaqi_calculation_status"), "Utf8");
  assert.equal(fields.get("algorithm_version"), "Utf8");
  assert.match(fields.get("computed_at_utc"), /^Timestamp/);
  assert.match(fields.get("updated_at"), /^Timestamp/);
});
