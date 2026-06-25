import {
  classifyObservationRowsForV2PollutantPartitions,
  createAqiConnectorManifest,
  createAqiV2ConnectorManifest,
  createAqiV2PollutantManifest,
  parseOpenaqCsvObservations,
  summarizeAqilevelsPartRows,
} from "./run_job.ts";
function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`assertEquals failed: actual=${actualJson} expected=${expectedJson}`);
  }
}

Deno.test("v2 classifier skips blank, null, and invalid pollutant_code rows", () => {
  const classified = classifyObservationRowsForV2PollutantPartitions([
    { timeseries_id: 1, station_id: 10, pollutant_code: "pm25", observed_at: "2026-06-08T00:00:00.000Z", value: 1 },
    { timeseries_id: 2, station_id: 20, pollutant_code: "", observed_at: "2026-06-08T01:00:00.000Z", value: 2, source_parameter: "pm10" },
    { timeseries_id: 3, station_id: 30, pollutant_code: null, observed_at: "2026-06-08T02:00:00.000Z", value: 3 },
    { timeseries_id: 4, station_id: 40, pollutant_code: "pm 10", observed_at: "2026-06-08T03:00:00.000Z", value: 4 },
    { timeseries_id: 5, station_id: 50, pollutant_code: "NO2", observed_at: "2026-06-08T04:00:00.000Z", value: 5 },
  ] as never);

  assertEquals(classified.valid_rows.map((row) => row.pollutant_code), ["pm25", "no2"]);
  assertEquals(classified.pollutant_codes_written, ["no2", "pm25"]);
  assertEquals(classified.rows_with_missing_pollutant_code, 3);
  assertEquals(classified.rows_skipped_missing_pollutant_code, 3);
  assertEquals(classified.example_missing_pollutant_rows.length, 3);
  assertEquals(classified.example_missing_pollutant_rows[0], {
    timeseries_id: 2,
    station_id: 20,
    observed_at: "2026-06-08T01:00:00.000Z",
    source_parameter: "pm10",
  });
});

Deno.test("OpenAQ CSV mapping populates pollutant_code from source parameter when binding code is blank at runtime", () => {
  const lookup = {
    connector_id: 6,
    station_refs: new Set(["42"]),
    binding_by_station_pollutant: new Map([["42|pm25", {
      timeseries_id: 1001,
      station_id: 42,
      station_ref: "42",
      timeseries_ref: "sensor-1",
      pollutant_code: "" as never,
    }]]),
    binding_by_timeseries_id: new Map(),
    binding_by_timeseries_ref: new Map(),
    binding_by_timeseries_ref_pollutant: new Map(),
  };
  const csvText = [
    "location_id,sensors_id,datetime,parameter,value",
    "42,sensor-1,2026-06-08T00:00:00Z,pm25,12.5",
  ].join("\n");

  const parsed = parseOpenaqCsvObservations({
    dayUtc: "2026-06-08",
    csvText,
    lookup,
    locationId: 42,
    includeMetFields: false,
  });

  assertEquals(parsed.mapped_records, 1);
  assertEquals(parsed.rows[0].pollutant_code, "pm25");
  assertEquals(parsed.rows[0].source_parameter, "pm25");
});

Deno.test("AQI part summary counts valid timeseries ids only", () => {
  const summary = summarizeAqilevelsPartRows([
    { timeseries_id: 123, timestamp_hour_utc: "2026-06-01T00:00:00.000Z", pollutant_code: "no2" },
    { timeseries_id: 123, timestamp_hour_utc: "2026-06-01T01:00:00.000Z", pollutant_code: "no2" },
    { timeseries_id: 124, timestamp_hour_utc: "2026-06-01T00:00:00.000Z", pollutant_code: "pm25" },
    { timeseries_id: 0, timestamp_hour_utc: "2026-06-01T02:00:00.000Z", pollutant_code: "pm10" },
    { timeseries_id: null, timestamp_hour_utc: "2026-06-01T03:00:00.000Z", pollutant_code: "pm10" },
    { timeseries_id: Number.NaN, timestamp_hour_utc: "2026-06-01T04:00:00.000Z", pollutant_code: "pm10" },
  ] as never);

  assertEquals(summary.min_timeseries_id, 123);
  assertEquals(summary.max_timeseries_id, 124);
  assertEquals(summary.timeseries_row_counts, { "123": 2, "124": 1 });
});

Deno.test("AQI v2 pollutant and connector manifests expose aggregated top-level timeseries row counts", () => {
  const no2Manifest = createAqiV2PollutantManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    pollutantCode: "no2",
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
    sourceRowCount: 3,
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
    fileEntries: [
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
        row_count: 3,
        bytes: 100,
        etag_or_hash: "etag-no2",
        min_timeseries_id: 123,
        max_timeseries_id: 124,
        min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-01T01:00:00.000Z",
        timeseries_row_counts: { "123": 2, "124": 1 },
      },
    ],
  });
  const pm25Manifest = createAqiV2PollutantManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    pollutantCode: "pm25",
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=pm25/manifest.json",
    sourceRowCount: 2,
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
    fileEntries: [
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=pm25/part-00000.parquet",
        row_count: 2,
        bytes: 90,
        etag_or_hash: "etag-pm25",
        min_timeseries_id: 123,
        max_timeseries_id: 125,
        min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-01T01:00:00.000Z",
        timeseries_row_counts: { "123": 1, "125": 1 },
      },
    ],
  });

  assertEquals(no2Manifest.timeseries_row_counts, { "123": 2, "124": 1 });
  assertEquals((no2Manifest.files as Array<Record<string, unknown>>)[0].timeseries_row_counts, undefined);
  assertEquals(
    Object.values(no2Manifest.timeseries_row_counts as Record<string, number>).reduce((sum, value) => sum + value, 0),
    no2Manifest.source_row_count,
  );

  const connectorManifest = createAqiV2ConnectorManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
    pollutantManifests: [no2Manifest, pm25Manifest],
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
  });

  assertEquals(connectorManifest.timeseries_row_counts, { "123": 3, "124": 1, "125": 1 });
  assertEquals(
    Object.values(connectorManifest.timeseries_row_counts as Record<string, number>).reduce((sum, value) => sum + value, 0),
    connectorManifest.source_row_count,
  );
});

Deno.test("AQI v1 connector manifest exposes top-level timeseries row counts without per-file duplicates", () => {
  const manifest = createAqiConnectorManifest({
    dayUtc: "2026-06-01",
    connectorId: 6,
    runId: "run-1",
    manifestKey: "history/v1/aqilevels/hourly/day_utc=2026-06-01/connector_id=6/manifest.json",
    sourceRowCount: 3,
    minTimestampHourUtc: "2026-06-01T00:00:00.000Z",
    maxTimestampHourUtc: "2026-06-01T02:00:00.000Z",
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
    fileEntries: [
      {
        key: "history/v1/aqilevels/hourly/day_utc=2026-06-01/connector_id=6/part-00000.parquet",
        row_count: 3,
        bytes: 100,
        etag_or_hash: "etag",
        min_timeseries_id: 123,
        max_timeseries_id: 124,
        min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-01T02:00:00.000Z",
        timeseries_row_counts: { "123": 2, "124": 1 },
      },
    ],
  });

  assertEquals(manifest.timeseries_row_counts, { "123": 2, "124": 1 });
  assertEquals((manifest.files as Array<Record<string, unknown>>)[0].timeseries_row_counts, undefined);
});
