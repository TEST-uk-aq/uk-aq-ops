import test from "node:test";
import assert from "node:assert/strict";
import {
  addUtcHours,
  computeRollingLocalRetentionWindow,
  mapR2ObservationRowsToSourceObservations,
} from "../workers/uk_aq_backfill_local/backfill_core.mjs";

test("backfill core hour math uses defined shared time constants", () => {
  assert.equal(
    addUtcHours("2026-06-08T00:00:00.000Z", 2),
    "2026-06-08T02:00:00.000Z",
  );

  const window = computeRollingLocalRetentionWindow({
    nowUtc: new Date("2026-06-20T12:00:00.000Z"),
    timeZone: "Europe/London",
    localRetentionDays: 2,
    scanExtraDays: 1,
  });

  assert.equal(window.current_local_day, "2026-06-20");
  assert.equal(window.local_window_start_day, "2026-06-18");
  assert.equal(window.local_window_end_day, "2026-06-19");
  assert.deepEqual(window.retained_day_utc, [
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
  ]);
});

test("R2 observation source mapper preserves explicit connector id", () => {
  const rows = mapR2ObservationRowsToSourceObservations({
    rows: [{
      timeseries_id: 1001,
      observed_at: "2026-06-22T00:15:00.000Z",
      value: 24,
    }],
    bindingByTimeseriesId: new Map([[
      1001,
      {
        timeseries_id: 1001,
        station_id: 501,
        station_ref: "station-501",
        timeseries_ref: "ts-1001",
        pollutant_code: "no2",
      },
    ]]),
    windowStartIso: "2026-06-22T00:00:00.000Z",
    windowEndIso: "2026-06-23T00:00:00.000Z",
    connectorId: 1,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].connector_id, 1);
});
