import assert from "node:assert/strict";
import {
  addDays,
  buildDailyRefreshPayload,
  buildDayChunks,
  buildRunConfig,
  daysBetweenInclusive,
  latestCompleteDayUtc,
  mergeDailyRefreshRows,
  parsePollutantCodes,
} from "./who_2021_daily_core.ts";

Deno.test("latest complete day waits for maturity delay after UTC midnight", () => {
  assert.equal(
    latestCompleteDayUtc(new Date("2026-07-07T14:00:00.000Z"), 3),
    "2026-07-06",
  );
  assert.equal(
    latestCompleteDayUtc(new Date("2026-07-07T02:59:00.000Z"), 3),
    "2026-07-05",
  );
  assert.equal(
    latestCompleteDayUtc(new Date("2026-07-07T03:01:00.000Z"), 3),
    "2026-07-06",
  );
});

Deno.test("daily mode builds a latest-complete lookback window", () => {
  const config = buildRunConfig({
    runMode: "daily",
    triggerMode: "scheduler",
    now: new Date("2026-07-07T14:00:00.000Z"),
    lookbackDays: 2,
    maturityDelayHours: 3,
    connectorId: 1,
    sourceNetworkCode: "GOV_UK_AURN",
    pollutantCodes: ["pm25", "pm10", "no2"],
    minValidHoursPerDay: 18,
    chunkDays: 31,
  });

  assert.equal(config.startDayUtc, "2026-07-05");
  assert.equal(config.endDayUtc, "2026-07-06");
  assert.equal(config.latestCompleteDayUtc, "2026-07-06");
  assert.equal(config.sourceNetworkCode, "gov_uk_aurn");
  assert.equal(config.dryRun, false);
});

Deno.test("backfill requires explicit range and chunks inclusively", () => {
  const config = buildRunConfig({
    runMode: "backfill",
    triggerMode: "manual",
    now: new Date("2026-07-07T14:00:00.000Z"),
    explicitStartDayUtc: "2026-07-01",
    explicitEndDayUtc: "2026-07-05",
    lookbackDays: 2,
    maturityDelayHours: 3,
    connectorId: 1,
    sourceNetworkCode: "gov_uk_aurn",
    pollutantCodes: ["pm25"],
    minValidHoursPerDay: 18,
    chunkDays: 2,
  });
  const chunks = buildDayChunks(
    config.startDayUtc,
    config.endDayUtc,
    config.chunkDays,
  );

  assert.deepEqual(chunks, [
    { startDayUtc: "2026-07-01", endDayUtc: "2026-07-02" },
    { startDayUtc: "2026-07-03", endDayUtc: "2026-07-04" },
    { startDayUtc: "2026-07-05", endDayUtc: "2026-07-05" },
  ]);
  assert.equal(daysBetweenInclusive("2026-07-01", "2026-07-05"), 5);
  assert.equal(addDays("2026-07-05", 1), "2026-07-06");
});

Deno.test("refresh payload preserves hour-ending daily RPC inputs", () => {
  const config = buildRunConfig({
    runMode: "dry_run",
    triggerMode: "test",
    now: new Date("2026-07-07T14:00:00.000Z"),
    explicitStartDayUtc: "2026-07-02",
    explicitEndDayUtc: "2026-07-02",
    lookbackDays: 1,
    maturityDelayHours: 3,
    connectorId: 1,
    sourceNetworkCode: "gov_uk_aurn",
    pollutantCodes: parsePollutantCodes("PM25, pm10, no2, pm25"),
    minValidHoursPerDay: 18,
    chunkDays: 31,
  });
  const payload = buildDailyRefreshPayload(config, {
    startDayUtc: "2026-07-02",
    endDayUtc: "2026-07-02",
  });

  assert.deepEqual(payload, {
    p_start_day_utc: "2026-07-02",
    p_end_day_utc: "2026-07-02",
    p_connector_id: 1,
    p_source_network_code: "gov_uk_aurn",
    p_pollutant_codes: ["pm25", "pm10", "no2"],
    p_min_valid_hours_per_day: 18,
    p_dry_run: true,
  });
});

Deno.test("refresh summaries merge chunk rows", () => {
  const summary = mergeDailyRefreshRows([
    {
      start_day_utc: "2026-07-01",
      end_day_utc: "2026-07-01",
      connector_id: 1,
      source_network_code: "gov_uk_aurn",
      pollutant_codes: ["pm25"],
      candidate_timeseries_count: 10,
      candidate_timeseries_days: 10,
      source_hour_rows: 200,
      valid_timeseries_days: 8,
      not_enough_data_timeseries_days: 2,
      rows_upserted: 10,
      dry_run: false,
    },
    {
      start_day_utc: "2026-07-02",
      end_day_utc: "2026-07-02",
      connector_id: 1,
      source_network_code: "gov_uk_aurn",
      pollutant_codes: ["pm25"],
      candidate_timeseries_count: 12,
      candidate_timeseries_days: 12,
      source_hour_rows: 220,
      valid_timeseries_days: 9,
      not_enough_data_timeseries_days: 3,
      rows_upserted: 12,
      dry_run: false,
    },
  ]);

  assert.deepEqual(summary, {
    chunks: 2,
    candidate_timeseries_count: 12,
    candidate_timeseries_days: 22,
    source_hour_rows: 420,
    valid_timeseries_days: 17,
    not_enough_data_timeseries_days: 5,
    rows_upserted: 22,
  });
});
