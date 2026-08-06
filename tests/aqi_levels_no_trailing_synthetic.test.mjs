import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAqilevelHistoryRowsForDayFromSourceObservations,
} from "../lib/aqi/aqi_levels.mjs";

test("PM AQI fills internal gaps but stops at the latest actual observation", () => {
  const startMs = Date.parse("2026-08-05T00:00:00.000Z");
  const missingHours = new Set([
    "2026-08-06T12:00:00.000Z",
    "2026-08-06T13:00:00.000Z",
  ]);
  const sourceRows = Array.from({ length: 46 }, (_, index) => ({
    connector_id: 1,
    station_id: 101,
    timeseries_id: 1001,
    pollutant_code: "pm25",
    observed_at: new Date(startMs + index * 60 * 60 * 1000).toISOString(),
    value: 12,
  })).filter((row) => !missingHours.has(row.observed_at));

  const rows = buildAqilevelHistoryRowsForDayFromSourceObservations(
    sourceRows,
    "2026-08-06",
  );

  assert.equal(rows.at(-1)?.timestamp_hour_utc, "2026-08-06T21:00:00.000Z");
  assert.equal(
    rows.some((row) => row.timestamp_hour_utc === "2026-08-06T22:00:00.000Z"),
    false,
  );

  for (const timestamp of missingHours) {
    const row = rows.find((candidate) => candidate.timestamp_hour_utc === timestamp);
    assert.ok(row, `missing internal PM AQI row for ${timestamp}`);
    assert.equal(row.daqi_calculation_status, "ok");
    assert.notEqual(row.daqi_index_level, null);
    assert.equal(row.eaqi_calculation_status, "missing_input");
    assert.equal(row.eaqi_index_level, null);
  }
});
