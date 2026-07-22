import {
  classifyObservationRowsForV2PollutantPartitions,
  createAqiV2ConnectorManifest,
  createAqiV2PollutantManifest,
  normaliseConcentrationUnitForComparison,
  parseOpenaqCsvObservations,
  parseUkAirFlatFileObservations,
  summarizeAqilevelsPartRows,
} from "./run_job.ts";

const propertyMapping = (sourceLabel: string, code: string, sourceUom = "ug/m3") => ({
  connector_id: 1,
  source_label: sourceLabel,
  source_uom: sourceUom,
  observed_property_id: 1,
  observed_property_code: code,
  mapping_kind: "raw_observed_property" as const,
  is_aqi_eligible: ["pm25", "pm10", "no2"].includes(code),
  is_active: true,
});
function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`assertEquals failed: actual=${actualJson} expected=${expectedJson}`);
  }
}

Deno.test("UK-AIR concentration-unit aliases preserve scale and reject a different scale", () => {
  assertEquals(
    ["ug/m3", "ugm-3", "ug m-3", "µg/m3", "μg/m3", "µg/m³", "μg/m³"]
      .map(normaliseConcentrationUnitForComparison),
    ["ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3"],
  );
  assertEquals(
    ["mg/m3", "mgm-3", "mg m-3", "mg/m³"]
      .map(normaliseConcentrationUnitForComparison),
    ["mg/m3", "mg/m3", "mg/m3", "mg/m3"],
  );
  assertEquals(
    normaliseConcentrationUnitForComparison("mg/m3") ===
      normaliseConcentrationUnitForComparison("ug/m3"),
    false,
  );
});

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
    ambiguous_station_pollutant_keys: new Set<string>(),
    ambiguous_timeseries_ref_keys: new Set<string>(),
    ambiguous_timeseries_ref_pollutant_keys: new Set<string>(),
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

Deno.test("UK-AIR CSV parses GMT hour-ending rows into UTC hour starts", () => {
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "EA8",
    csvText: [
      "Station metadata",
      "All Data GMT hour ending ",
      'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
      "17-05-2026,01:00,10,R,ugm-3",
      "17-05-2026,24:00,11,P,ugm-3",
      "18-05-2026,01:00,12,R,ugm-3",
    ].join("\n"),
    mappings: [{
      site_ref: "EA8",
      uk_air_ref: "EA8",
      pollutant_code: "pm10",
      station_id: 1,
      timeseries_id: 66,
      station_ref: "station-ea8",
      timeseries_ref: "timeseries-old",
      valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: "2026-05-17",
    }],
    propertyMappings: [propertyMapping("PM<sub>10</sub> particulate matter (Hourly measured)", "pm10")],
  });

  assertEquals(parsed.rows.map((row) => row.observed_at), [
    "2026-05-17T00:00:00.000Z",
    "2026-05-17T23:00:00.000Z",
  ]);
  assertEquals(parsed.rows.map((row) => row.value), [10, 11]);
  assertEquals(parsed.rows.map((row) => row.status), ["R", "P"]);
  assertEquals(parsed.rows.map((row) => row.timeseries_id), [66, 66]);
  assertEquals(parsed.units, ["ugm-3"]);
});

Deno.test("UK-AIR CSV mapping switches timeseries at the EA8 validity boundary", () => {
  const mappings = [
    {
      site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "pm10" as const,
      station_id: 1, timeseries_id: 66, station_ref: "station-ea8",
      timeseries_ref: "timeseries-old", valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: "2026-05-17",
    },
    {
      site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "pm10" as const,
      station_id: 1, timeseries_id: 95, station_ref: "station-ea8",
      timeseries_ref: "timeseries-new", valid_from_day_utc: "2026-05-18",
      valid_to_day_utc: null,
    },
  ];
  const csvText = [
    "Station metadata",
    "All Data GMT hour ending ",
    'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
    "17-05-2026,01:00,10,R,ugm-3",
    "18-05-2026,01:00,11,R,ugm-3",
  ].join("\n");

  const propertyMappings = [propertyMapping("PM<sub>10</sub> particulate matter (Hourly measured)", "pm10")];
  const before = parseUkAirFlatFileObservations({ dayUtc: "2026-05-17", siteRef: "EA8", csvText, mappings, propertyMappings });
  const after = parseUkAirFlatFileObservations({ dayUtc: "2026-05-18", siteRef: "EA8", csvText, mappings, propertyMappings });

  assertEquals(before.rows.map((row) => row.timeseries_id), [66]);
  assertEquals(after.rows.map((row) => row.timeseries_id), [95]);
});

Deno.test("UK-AIR CSV repair fails closed for ambiguous mappings", () => {
  let message = "";
  try {
    parseUkAirFlatFileObservations({
      dayUtc: "2026-05-17",
      siteRef: "EA8",
      csvText: [
        "Station metadata",
        "All Data GMT hour ending ",
        'Date,time,"Nitrogen dioxide (Hourly measured)",status,unit',
        "17-05-2026,01:00,10,R,ugm-3",
      ].join("\n"),
      mappings: [1, 2].map((timeseriesId) => ({
        site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "no2" as const,
        station_id: 1, timeseries_id: timeseriesId, station_ref: "station-ea8",
        timeseries_ref: `timeseries-${timeseriesId}`,
        valid_from_day_utc: "2020-01-01", valid_to_day_utc: null,
      })),
      propertyMappings: [propertyMapping("Nitrogen dioxide (Hourly measured)", "no2")],
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("matches=2")) throw new Error(`Expected ambiguous mapping failure, got: ${message}`);
});

Deno.test("UK-AIR CSV parses every mapped pollutant triplet", () => {
  const labels = [
    ["Ozone", "o3"],
    ["Nitric oxide", "no"],
    ["Nitrogen oxides as nitrogen dioxide", "nox_as_no2"],
    ["Sulphur dioxide", "so2"],
    ["Carbon monoxide", "co"],
  ] as const;
  const mappings = labels.map(([, code], index) => ({
    site_ref: "MULTI", uk_air_ref: "MULTI", pollutant_code: code,
    station_id: 10, timeseries_id: 100 + index, station_ref: "station-multi",
    timeseries_ref: `timeseries-${code}`, valid_from_day_utc: null,
    valid_to_day_utc: null,
  }));
  const header = ["Date", "time", ...labels.flatMap(([label]) => [label, "status", "unit"])];
  const row = ["17-05-2026", "01:00", ...labels.flatMap((_, index) => [String(index + 1), "R", "ugm-3"])];
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "MULTI",
    csvText: ["All Data GMT hour ending", header.join(","), row.join(",")].join("\n"),
    mappings,
    propertyMappings: labels.map(([label, code]) => propertyMapping(label, code)),
  });
  assertEquals(parsed.rows.map((item) => item.pollutant_code), labels.map(([, code]) => code));
  assertEquals(parsed.rows.map((item) => item.value), [1, 2, 3, 4, 5]);
});

Deno.test("UK-AIR CSV fails closed for an unmapped source label", () => {
  let message = "";
  try {
    parseUkAirFlatFileObservations({
      dayUtc: "2026-05-17",
      siteRef: "EA8",
      csvText: [
        "All Data GMT hour ending",
        "Date,time,Ozone,status,unit",
        "17-05-2026,01:00,1,R,ugm-3",
      ].join("\n"),
      mappings: [],
      propertyMappings: [],
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("unmapped_source_label")) throw new Error(message);
});

Deno.test("UK-AIR CSV ignores only explicitly ignored source labels", () => {
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "EA8",
    csvText: [
      "All Data GMT hour ending",
      "Date,time,Instrument note,status,unit",
      "17-05-2026,01:00,1,R,text",
    ].join("\n"),
    mappings: [],
    propertyMappings: [{
      connector_id: 1, source_label: "Instrument note", source_uom: null,
      observed_property_id: null, observed_property_code: null,
      mapping_kind: "ignored", is_aqi_eligible: false, is_active: true,
    }],
  });
  assertEquals(parsed.rows, []);
  assertEquals(parsed.skipped_ignored_properties, 1);
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
