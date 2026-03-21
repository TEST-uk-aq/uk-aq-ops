import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAqilevelHistoryRowsByDayFromR2ObservationRows,
  buildAqilevelHistoryRowsByDayFromSourceObservations,
  buildCoveredIsoDaysForUtcRange,
  buildBackwardDayRange,
  computeRollingLocalRetentionWindow,
  DAQI_NO2_BREAKPOINTS,
  DAQI_PM10_ROLLING24H_BREAKPOINTS,
  DAQI_PM25_ROLLING24H_BREAKPOINTS,
  EAQI_NO2_BREAKPOINTS,
  EAQI_PM10_BREAKPOINTS,
  EAQI_PM25_BREAKPOINTS,
  extractConnectorIdsFromHistoryDayManifest,
  isRetryableSourceFetchError,
  isRetryableAqilevelsWriteError,
  isDayInRollingRetentionWindow,
  isSourceAcquisitionPendingError,
  lookupAqiIndexLevel,
  mapR2ObservationRowsToSourceObservations,
  parseRunMode,
  planAqilevelHistoryConnectorWrite,
  splitChunkLengthForRetry,
  shouldSkipCompletedDay,
} from "../workers/uk_aq_backfill_cloud_run/backfill_core.mjs";

test("parseRunMode accepts valid values and falls back on invalid", () => {
  assert.equal(parseRunMode("local_to_aqilevels", "obs_aqi_to_r2"), "local_to_aqilevels");
  assert.equal(parseRunMode("OBS_AQI_TO_R2", "local_to_aqilevels"), "obs_aqi_to_r2");
  assert.equal(parseRunMode("", "source_to_r2"), "source_to_r2");
  assert.equal(
    parseRunMode("r2_history_obs_to_aqilevels", "local_to_aqilevels"),
    "r2_history_obs_to_aqilevels",
  );
  assert.equal(parseRunMode("not-a-mode", "local_to_aqilevels"), "local_to_aqilevels");
});

test("buildBackwardDayRange returns newest-first days", () => {
  assert.deepEqual(
    buildBackwardDayRange("2026-03-01", "2026-03-05"),
    ["2026-03-05", "2026-03-04", "2026-03-03", "2026-03-02", "2026-03-01"],
  );
});

test("buildCoveredIsoDaysForUtcRange spans UTC day partitions needed for 24h AQI lookback", () => {
  assert.deepEqual(
    buildCoveredIsoDaysForUtcRange(
      "2025-02-27T01:00:00.000Z",
      "2025-02-28T00:00:00.000Z",
    ),
    ["2025-02-27"],
  );
  assert.deepEqual(
    buildCoveredIsoDaysForUtcRange(
      "2025-02-27T01:00:00.000Z",
      "2025-03-01T00:00:00.000Z",
    ),
    ["2025-02-27", "2025-02-28"],
  );
});

test("rolling local retention helper tracks 31/32 UTC-day windows around DST", () => {
  const normalWindow = computeRollingLocalRetentionWindow({
    nowUtc: new Date("2026-02-15T12:00:00Z"),
    timeZone: "Europe/London",
    localRetentionDays: 31,
  });
  assert.equal(normalWindow.retained_day_utc_count, 31);

  const dstCrossingWindow = computeRollingLocalRetentionWindow({
    nowUtc: new Date("2026-11-15T12:00:00Z"),
    timeZone: "Europe/London",
    localRetentionDays: 31,
  });
  assert.equal(dstCrossingWindow.retained_day_utc_count, 32);

  assert.equal(isDayInRollingRetentionWindow("2026-11-14", dstCrossingWindow), true);
  assert.equal(isDayInRollingRetentionWindow("2026-09-01", dstCrossingWindow), false);
});

test("shouldSkipCompletedDay honors force_replace", () => {
  assert.deepEqual(
    shouldSkipCompletedDay("complete", false),
    { skip: true, reason: "already_complete" },
  );
  assert.deepEqual(
    shouldSkipCompletedDay("complete", true),
    { skip: false, reason: "force_replace" },
  );
  assert.deepEqual(
    shouldSkipCompletedDay("error", false),
    { skip: false, reason: "needs_processing" },
  );
});

test("isSourceAcquisitionPendingError only treats known source fetch failures as pending", () => {
  assert.equal(
    isSourceAcquisitionPendingError(
      "breathelondon",
      "breathelondon_list_sensors_fetch_failed: HTTP 503 for https://api.breathelondon-communities.org/api/ListSensors",
    ),
    true,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "breathelondon",
      "breathelondon_clarity_fetch_failed: site_code=CLDP0001 species=IPM25 day_utc=2025-01-01: Operation timed out",
    ),
    true,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "sensorcommunity",
      "sensorcommunity_archive_index_fetch_failed: The signal has been aborted",
    ),
    true,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "sensorcommunity",
      "sensorcommunity_archive_csv_fetch_failed: 2025-12-13_sensor_123.csv: Operation timed out",
    ),
    true,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "sensorcommunity",
      "missing connector manifests for day=2025-12-13 after source_to_r2 export",
    ),
    false,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "openaq",
      "sensorcommunity_archive_index_fetch_failed: Operation timed out",
    ),
    false,
  );
  assert.equal(
    isSourceAcquisitionPendingError(
      "breathelondon",
      "missing connector manifests for day=2025-12-13 after source_to_r2 export",
    ),
    false,
  );
});

test("isRetryableSourceFetchError only treats transient source fetch failures as retryable", () => {
  assert.equal(
    isRetryableSourceFetchError(
      "uk_air_sos",
      "uk_air_sos_timeseries_fetch_failed: 25 timeseries failed: client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known",
    ),
    true,
  );
  assert.equal(
    isRetryableSourceFetchError(
      "breathelondon",
      "breathelondon_clarity_fetch_failed: site_code=CLDP0001 species=IPM25 day_utc=2025-01-01: HTTP 503 for https://api.breathelondon-communities.org/api/getClarityData/...",
    ),
    true,
  );
  assert.equal(
    isRetryableSourceFetchError(
      "sensorcommunity",
      "sensorcommunity_archive_csv_fetch_failed: 2025-12-13_sensor_123.csv: The signal has been aborted",
    ),
    true,
  );
  assert.equal(
    isRetryableSourceFetchError(
      "uk_air_sos",
      "Failed to parse UK-AIR SOS mirror /tmp/example.json: Unexpected token",
    ),
    false,
  );
  assert.equal(
    isRetryableSourceFetchError(
      "openaq",
      "ENOENT: no such file or directory, open '/tmp/location-4312692-20260131.csv.gz'",
    ),
    false,
  );
});

test("isRetryableAqilevelsWriteError only treats hourly write timeout failures as retryable", () => {
  assert.equal(
    isRetryableAqilevelsWriteError(
      "AQI levels hourly upsert RPC failed: canceling statement due to statement timeout",
    ),
    true,
  );
  assert.equal(
    isRetryableAqilevelsWriteError(
      "AQI levels hourly upsert RPC failed: HTTP 504",
    ),
    true,
  );
  assert.equal(
    isRetryableAqilevelsWriteError(
      "AQI levels hourly upsert RPC failed: service_role required",
    ),
    false,
  );
});

test("splitChunkLengthForRetry halves batches until the minimum size floor", () => {
  assert.deepEqual(splitChunkLengthForRetry(2000, 250), [1000, 1000]);
  assert.deepEqual(splitChunkLengthForRetry(501, 250), [251, 250]);
  assert.equal(splitChunkLengthForRetry(250, 250), null);
  assert.equal(splitChunkLengthForRetry(1, 1), null);
});

test("EAQI PM2.5 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(0, EAQI_PM25_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(5, EAQI_PM25_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(5.01, EAQI_PM25_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(15, EAQI_PM25_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(15.01, EAQI_PM25_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(50, EAQI_PM25_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(50.01, EAQI_PM25_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(90, EAQI_PM25_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(90.01, EAQI_PM25_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(140, EAQI_PM25_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(140.01, EAQI_PM25_BREAKPOINTS), 6);
});

test("DAQI PM2.5 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(11, DAQI_PM25_ROLLING24H_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(11.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(23, DAQI_PM25_ROLLING24H_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(23.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(35, DAQI_PM25_ROLLING24H_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(35.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(41, DAQI_PM25_ROLLING24H_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(41.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(47, DAQI_PM25_ROLLING24H_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(47.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(53, DAQI_PM25_ROLLING24H_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(53.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(58, DAQI_PM25_ROLLING24H_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(58.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(64, DAQI_PM25_ROLLING24H_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(64.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(70, DAQI_PM25_ROLLING24H_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(70.01, DAQI_PM25_ROLLING24H_BREAKPOINTS), 10);
});

test("EAQI PM10 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(15, EAQI_PM10_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(15.01, EAQI_PM10_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(45, EAQI_PM10_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(45.01, EAQI_PM10_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(120, EAQI_PM10_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(120.01, EAQI_PM10_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(195, EAQI_PM10_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(195.01, EAQI_PM10_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(270, EAQI_PM10_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(270.01, EAQI_PM10_BREAKPOINTS), 6);
});

test("EAQI NO2 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(10, EAQI_NO2_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(10.01, EAQI_NO2_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(25, EAQI_NO2_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(25.01, EAQI_NO2_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(60, EAQI_NO2_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(60.01, EAQI_NO2_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(100, EAQI_NO2_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(100.01, EAQI_NO2_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(150, EAQI_NO2_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(150.01, EAQI_NO2_BREAKPOINTS), 6);
});

test("DAQI PM10 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(16, DAQI_PM10_ROLLING24H_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(16.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(33, DAQI_PM10_ROLLING24H_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(33.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(50, DAQI_PM10_ROLLING24H_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(50.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(58, DAQI_PM10_ROLLING24H_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(58.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(66, DAQI_PM10_ROLLING24H_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(66.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(75, DAQI_PM10_ROLLING24H_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(75.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(83, DAQI_PM10_ROLLING24H_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(83.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(91, DAQI_PM10_ROLLING24H_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(91.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(100, DAQI_PM10_ROLLING24H_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(100.01, DAQI_PM10_ROLLING24H_BREAKPOINTS), 10);
});

test("DAQI NO2 breakpoints classify decimal values without gaps", () => {
  assert.equal(lookupAqiIndexLevel(67, DAQI_NO2_BREAKPOINTS), 1);
  assert.equal(lookupAqiIndexLevel(67.01, DAQI_NO2_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(134, DAQI_NO2_BREAKPOINTS), 2);
  assert.equal(lookupAqiIndexLevel(134.01, DAQI_NO2_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(200, DAQI_NO2_BREAKPOINTS), 3);
  assert.equal(lookupAqiIndexLevel(200.01, DAQI_NO2_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(267, DAQI_NO2_BREAKPOINTS), 4);
  assert.equal(lookupAqiIndexLevel(267.01, DAQI_NO2_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(334, DAQI_NO2_BREAKPOINTS), 5);
  assert.equal(lookupAqiIndexLevel(334.01, DAQI_NO2_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(400, DAQI_NO2_BREAKPOINTS), 6);
  assert.equal(lookupAqiIndexLevel(400.01, DAQI_NO2_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(467, DAQI_NO2_BREAKPOINTS), 7);
  assert.equal(lookupAqiIndexLevel(467.01, DAQI_NO2_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(534, DAQI_NO2_BREAKPOINTS), 8);
  assert.equal(lookupAqiIndexLevel(534.01, DAQI_NO2_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(600, DAQI_NO2_BREAKPOINTS), 9);
  assert.equal(lookupAqiIndexLevel(600.01, DAQI_NO2_BREAKPOINTS), 10);
});

test("mapR2ObservationRowsToSourceObservations maps parquet observations through bindings and filters the window", () => {
  const bindingByTimeseriesId = new Map([
    [
      1001,
      {
        timeseries_id: 1001,
        station_id: 101,
        station_ref: "station-a",
        timeseries_ref: "station-a:no2",
        pollutant_code: "no2",
      },
    ],
    [
      1002,
      {
        timeseries_id: 1002,
        station_id: 101,
        station_ref: "station-a",
        timeseries_ref: "station-a:pm10",
        pollutant_code: "pm10",
      },
    ],
    [
      1003,
      {
        timeseries_id: 1003,
        station_id: 102,
        station_ref: "station-b",
        timeseries_ref: "station-b:humidity",
        pollutant_code: "humidity",
      },
    ],
  ]);

  const rows = mapR2ObservationRowsToSourceObservations({
    rows: [
      {
        timeseries_id: 1002,
        observed_at: new Date("2025-02-27T23:30:00.000Z"),
        value: 18.5,
      },
      {
        timeseries_id: 1001,
        observed_at: "2025-02-28T00:00:00.000Z",
        value: 42,
      },
      {
        timeseries_id: 1003,
        observed_at: "2025-02-28T00:00:00.000Z",
        value: 50,
      },
      {
        timeseries_id: 9999,
        observed_at: "2025-02-28T01:00:00.000Z",
        value: 1,
      },
      {
        timeseries_id: 1001,
        observed_at: "2025-02-28T02:00:00.000Z",
        value: null,
      },
      {
        timeseries_id: 1001,
        observed_at: "2025-03-01T00:00:00.000Z",
        value: 99,
      },
      {
        timeseries_id: 1002,
        observed_at: "2025-02-28T01:00:00.000Z",
        value: -1,
      },
    ],
    bindingByTimeseriesId,
    windowStartIso: "2025-02-27T01:00:00.000Z",
    windowEndIso: "2025-03-01T00:00:00.000Z",
    stationIdFilter: [101],
  });

  assert.deepEqual(rows, [
    {
      timeseries_id: 1001,
      station_id: 101,
      pollutant_code: "no2",
      observed_at: "2025-02-28T00:00:00.000Z",
      value: 42,
    },
    {
      timeseries_id: 1002,
      station_id: 101,
      pollutant_code: "pm10",
      observed_at: "2025-02-27T23:30:00.000Z",
      value: 18.5,
    },
  ]);
});

test("AQI breakpoint helper keeps null and negative inputs invalid", () => {
  assert.equal(lookupAqiIndexLevel(null, EAQI_PM25_BREAKPOINTS), null);
  assert.equal(lookupAqiIndexLevel(-0.01, EAQI_PM25_BREAKPOINTS), null);
});

test("extractConnectorIdsFromHistoryDayManifest uses committed connector_ids and connector_manifests", () => {
  assert.deepEqual(
    extractConnectorIdsFromHistoryDayManifest({
      connector_ids: [4, "7", 4, "bad"],
      connector_manifests: [
        { connector_id: 9 },
        { connector_id: "11" },
        { connector_id: 7 },
      ],
    }),
    [4, 7, 9, 11],
  );
});

test("planAqilevelHistoryConnectorWrite replaces when force_replace=true and skips when false", () => {
  assert.deepEqual(
    planAqilevelHistoryConnectorWrite({
      forceReplace: false,
      hasExistingManifest: true,
      outputRowCount: 24,
    }),
    {
      action: "skip",
      skip_reason: "already_complete",
      delete_existing: false,
      write_connector_manifest: false,
    },
  );

  assert.deepEqual(
    planAqilevelHistoryConnectorWrite({
      forceReplace: true,
      hasExistingManifest: true,
      outputRowCount: 24,
    }),
    {
      action: "replace",
      skip_reason: null,
      delete_existing: true,
      write_connector_manifest: true,
    },
  );

  assert.deepEqual(
    planAqilevelHistoryConnectorWrite({
      forceReplace: true,
      hasExistingManifest: true,
      outputRowCount: 0,
    }),
    {
      action: "delete",
      skip_reason: null,
      delete_existing: true,
      write_connector_manifest: false,
    },
  );
});

test("AQI history builders keep rolling 24h lookback across month boundaries and clamp output days", () => {
  const sourceRows = [
    { timeseries_id: 2001, station_id: 501, pollutant_code: "no2", observed_at: "2025-01-31T23:05:00.000Z", value: 40 },
    { timeseries_id: 2001, station_id: 501, pollutant_code: "no2", observed_at: "2025-01-31T23:35:00.000Z", value: 60 },
    { timeseries_id: 2001, station_id: 501, pollutant_code: "no2", observed_at: "2025-02-01T00:10:00.000Z", value: 70 },
    { timeseries_id: 2001, station_id: 501, pollutant_code: "no2", observed_at: "2025-02-01T00:40:00.000Z", value: 90 },
    { timeseries_id: 2002, station_id: 501, pollutant_code: "pm25", observed_at: "2025-01-31T23:10:00.000Z", value: 24 },
    { timeseries_id: 2002, station_id: 501, pollutant_code: "pm25", observed_at: "2025-02-01T00:10:00.000Z", value: 36 },
    { timeseries_id: 2002, station_id: 501, pollutant_code: "pm25", observed_at: "2025-02-01T01:10:00.000Z", value: 12 },
    { timeseries_id: 2003, station_id: 501, pollutant_code: "pm10", observed_at: "2025-01-31T23:20:00.000Z", value: 30 },
    { timeseries_id: 2003, station_id: 501, pollutant_code: "pm10", observed_at: "2025-02-01T00:20:00.000Z", value: 60 },
    { timeseries_id: 2003, station_id: 501, pollutant_code: "pm10", observed_at: "2025-02-01T01:20:00.000Z", value: 90 },
    { timeseries_id: 2002, station_id: 501, pollutant_code: "pm25", observed_at: "2025-02-02T00:05:00.000Z", value: 99 },
  ];

  const output = buildAqilevelHistoryRowsByDayFromSourceObservations({
    rows: sourceRows,
    fromDayUtc: "2025-02-01",
    toDayUtc: "2025-02-01",
  });

  assert.deepEqual(output.map((entry) => entry.day_utc), ["2025-02-01"]);
  assert.equal(output[0].rows.length, 2);
  assert.equal(output[0].rows[0].timestamp_hour_utc, "2025-02-01T00:00:00.000Z");
  assert.equal(output[0].rows[0].pm25_rolling24h_mean_ugm3, 30);
  assert.equal(output[0].rows[0].pm10_rolling24h_mean_ugm3, 45);
  assert.equal(output[0].rows[0].no2_hourly_sample_count, 2);
  assert.equal(output[0].rows[0].daqi_no2_index_level, 2);
  assert.equal(output[0].rows[0].eaqi_no2_index_level, 4);
  assert.equal(output[0].rows[1].timestamp_hour_utc, "2025-02-01T01:00:00.000Z");
  assert.equal(output[0].rows[1].pm25_rolling24h_mean_ugm3, 24);
  assert.equal(output[0].rows[1].pm10_rolling24h_mean_ugm3, 60);
  assert.equal(output[0].rows.every((row) => row.timestamp_hour_utc < "2025-02-02T00:00:00.000Z"), true);
});

test("R2 observation AQI build matches the existing source-observation AQI path row-for-row", () => {
  const connectorId = 4;
  const bindingByTimeseriesId = new Map([
    [2001, { timeseries_id: 2001, station_id: 501, station_ref: "station-501", timeseries_ref: "station-501:no2", pollutant_code: "no2" }],
    [2002, { timeseries_id: 2002, station_id: 501, station_ref: "station-501", timeseries_ref: "station-501:pm25", pollutant_code: "pm25" }],
    [2003, { timeseries_id: 2003, station_id: 501, station_ref: "station-501", timeseries_ref: "station-501:pm10", pollutant_code: "pm10" }],
  ]);
  const r2Rows = [
    { connector_id: connectorId, timeseries_id: 2001, observed_at: "2025-01-31T23:05:00.000Z", value: 40 },
    { connector_id: connectorId, timeseries_id: 2001, observed_at: "2025-01-31T23:35:00.000Z", value: 60 },
    { connector_id: connectorId, timeseries_id: 2001, observed_at: "2025-02-01T00:10:00.000Z", value: 70 },
    { connector_id: connectorId, timeseries_id: 2001, observed_at: "2025-02-01T00:40:00.000Z", value: 90 },
    { connector_id: connectorId, timeseries_id: 2002, observed_at: "2025-01-31T23:10:00.000Z", value: 24 },
    { connector_id: connectorId, timeseries_id: 2002, observed_at: "2025-02-01T00:10:00.000Z", value: 36 },
    { connector_id: connectorId, timeseries_id: 2002, observed_at: "2025-02-01T01:10:00.000Z", value: 12 },
    { connector_id: connectorId, timeseries_id: 2003, observed_at: "2025-01-31T23:20:00.000Z", value: 30 },
    { connector_id: connectorId, timeseries_id: 2003, observed_at: "2025-02-01T00:20:00.000Z", value: 60 },
    { connector_id: connectorId, timeseries_id: 2003, observed_at: "2025-02-01T01:20:00.000Z", value: 90 },
  ];

  const sourceRows = mapR2ObservationRowsToSourceObservations({
    rows: r2Rows,
    bindingByTimeseriesId,
    windowStartIso: "2025-01-31T01:00:00.000Z",
    windowEndIso: "2025-02-02T00:00:00.000Z",
  });
  const existingPathRows = buildAqilevelHistoryRowsByDayFromSourceObservations({
    rows: sourceRows,
    fromDayUtc: "2025-02-01",
    toDayUtc: "2025-02-01",
  })[0].rows.map((row) => ({ connector_id: connectorId, ...row }));

  const r2PathRows = buildAqilevelHistoryRowsByDayFromR2ObservationRows({
    rows: r2Rows,
    bindingByTimeseriesId,
    fromDayUtc: "2025-02-01",
    toDayUtc: "2025-02-01",
  })[0].rows.map((row) => ({ connector_id: connectorId, ...row }));

  const sortRows = (rows) => rows.slice().sort((left, right) =>
    left.connector_id - right.connector_id ||
    left.station_id - right.station_id ||
    left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc)
  );

  assert.deepEqual(sortRows(r2PathRows), sortRows(existingPathRows));
});
