import {
  classifyObservationRowsForV2PollutantPartitions,
  parseOpenaqCsvObservations,
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
  ]);

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
