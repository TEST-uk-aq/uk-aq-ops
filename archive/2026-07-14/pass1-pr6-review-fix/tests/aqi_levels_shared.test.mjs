import test from "node:test";
import assert from "node:assert/strict";
import {
  AQI_V1_NORMALIZED_COLUMNS,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
} from "../lib/aqi/aqi_levels.mjs";

function hourlyRows({ timeseriesId, stationId, connectorId, pollutantCode, startIso, hours, value }) {
  const start = new Date(startIso);
  return Array.from({ length: hours }, (_, index) => ({
    timeseries_id: timeseriesId,
    station_id: stationId,
    connector_id: connectorId,
    pollutant_code: pollutantCode,
    observed_at: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    value,
  }));
}

test("shared AQI logic returns normalized v1 shape", () => {
  const rows = buildAqilevelHistoryRowsForDayFromSourceObservations(
    hourlyRows({
      timeseriesId: 1001,
      stationId: 101,
      connectorId: 7,
      pollutantCode: "no2",
      startIso: "2025-01-02T00:00:00.000Z",
      hours: 1,
      value: 20,
    }),
    "2025-01-02",
    { computedAtUtc: "2026-06-13T12:00:00.000Z" },
  );

  assert.equal(rows.length, 1);
  for (const column of AQI_V1_NORMALIZED_COLUMNS) {
    assert.ok(Object.hasOwn(rows[0], column), `missing ${column}`);
  }
  assert.equal(rows[0].daqi_calculation_status, "ok");
  assert.equal(rows[0].eaqi_calculation_status, "ok");
  assert.equal(rows[0].daqi_input_averaging_code, "hourly_mean");
  assert.equal(rows[0].eaqi_input_averaging_code, "hourly_mean");
});

test("PM2.5 rolling 24h DAQI uses previous-day context", () => {
  const rows = buildAqilevelHistoryRowsForDayFromSourceObservations(
    hourlyRows({
      timeseriesId: 2001,
      stationId: 201,
      connectorId: 7,
      pollutantCode: "pm25",
      startIso: "2025-01-01T01:00:00.000Z",
      hours: 24,
      value: 12,
    }),
    "2025-01-02",
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp_hour_utc, "2025-01-02T00:00:00.000Z");
  assert.equal(rows[0].daqi_input_averaging_code, "rolling_24h_mean");
  assert.equal(rows[0].daqi_source_observation_count, 24);
  assert.equal(rows[0].daqi_required_observation_count, 24);
  assert.equal(rows[0].daqi_calculation_status, "ok");
  assert.equal(rows[0].daqi_index_level, 2);
});

test("PM10 rolling DAQI reports insufficient samples when previous context is incomplete", () => {
  const rows = buildAqilevelHistoryRowsForDayFromSourceObservations(
    hourlyRows({
      timeseriesId: 3001,
      stationId: 301,
      connectorId: 7,
      pollutantCode: "pm10",
      startIso: "2025-01-02T00:00:00.000Z",
      hours: 1,
      value: 20,
    }),
    "2025-01-02",
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].daqi_input_averaging_code, "rolling_24h_mean");
  assert.equal(rows[0].daqi_source_observation_count, 1);
  assert.equal(rows[0].daqi_calculation_status, "insufficient_samples");
  assert.equal(rows[0].daqi_missing_reason, "insufficient_rolling_24h_hours");
  assert.equal(rows[0].daqi_index_level, null);
  assert.equal(rows[0].eaqi_calculation_status, "ok");
});

test('shared AQI and observation precedence helpers keep R2 authoritative', async () => {
  const mod = await import('../lib/aqi/aqi_levels.mjs');
  const r2Aqi = [{ timeseries_id: 1, pollutant_code: 'pm25', timestamp_hour_utc: '2026-07-14T00:00:00Z', daqi_index_level: null, daqi_calculation_status: 'insufficient_samples' }];
  const liveAqi = [{ timeseries_id: 1, pollutant_code: 'pm25', timestamp_hour_utc: '2026-07-14T00:00:00Z', daqi_index_level: 2 }];
  const mergedAqi = mod.mergeAqiRowsPreferR2({ r2Rows: r2Aqi, liveRows: liveAqi });
  assert.equal(mergedAqi.length, 1);
  assert.equal(mergedAqi[0].source, 'r2');
  assert.equal(mergedAqi[0].daqi_index_level, null);

  const r2Obs = [{ timeseries_id: 1, pollutant_code: 'no2', observed_at_utc: '2026-07-14T01:00:00Z', value: 10 }];
  const ingestObs = [
    { timeseries_id: 1, pollutant_code: 'no2', observed_at_utc: '2026-07-14T01:00:00Z', value: 99 },
    { timeseries_id: 1, pollutant_code: 'no2', observed_at_utc: '2026-07-14T02:00:00Z', value: 12 },
  ];
  const mergedObs = mod.mergeObservationRowsPreferR2({ r2Rows: r2Obs, ingestRows: ingestObs });
  assert.equal(mergedObs.discarded_ingest_overlap_count, 1);
  assert.equal(mergedObs.rows.length, 2);
  assert.equal(mergedObs.rows.find((row) => row.observed_at_utc.startsWith('2026-07-14T01')).value, 10);
});

test('missing AQI hour windows are coalesced with PM context', async () => {
  const mod = await import('../lib/aqi/aqi_levels.mjs');
  const windows = mod.coalesceAqiMissingHourWindows([
    '2026-07-14T12:00:00Z',
    '2026-07-14T13:00:00Z',
    '2026-07-16T00:00:00Z',
  ], { contextHours: 23 });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].start_utc, '2026-07-13T13:00:00.000Z');
  assert.equal(windows[0].end_utc, '2026-07-14T14:00:00.000Z');
});
