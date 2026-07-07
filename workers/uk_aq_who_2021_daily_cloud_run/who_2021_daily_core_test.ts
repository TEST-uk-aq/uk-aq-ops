import assert from "node:assert/strict";
import {
  addDays,
  buildDailyRefreshPayload,
  buildDayChunks,
  buildReadinessPayload,
  buildRunConfig,
  buildSummaryRefreshPayload,
  daysBetweenInclusive,
  latestCompleteDayUtc,
  mergeDailyRefreshRows,
  parsePollutantCodes,
  shouldRunReadinessGate,
  summarizeReadinessRows,
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
    minValidDays: 274,
    minFinalHourCoverageRatio: 0.9,
    readinessGateEnabled: true,
    summaryRefreshEnabled: true,
    chunkDays: 31,
  });

  assert.equal(config.startDayUtc, "2026-07-05");
  assert.equal(config.endDayUtc, "2026-07-06");
  assert.equal(config.latestCompleteDayUtc, "2026-07-06");
  assert.equal(config.sourceNetworkCode, "gov_uk_aurn");
  assert.equal(config.dryRun, false);
  assert.equal(config.minValidDays, 274);
  assert.equal(config.minFinalHourCoverageRatio, 0.9);
  assert.equal(shouldRunReadinessGate(config), true);
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
    minValidDays: 274,
    minFinalHourCoverageRatio: 0.9,
    readinessGateEnabled: true,
    summaryRefreshEnabled: true,
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
    minValidDays: 274,
    minFinalHourCoverageRatio: 0.95,
    readinessGateEnabled: true,
    summaryRefreshEnabled: true,
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
  assert.equal(shouldRunReadinessGate(config), false);
});

Deno.test("readiness and summary payloads use phase 3 settings", () => {
  const config = buildRunConfig({
    runMode: "daily",
    triggerMode: "scheduler",
    now: new Date("2026-07-07T14:00:00.000Z"),
    explicitStartDayUtc: "2026-07-02",
    explicitEndDayUtc: "2026-07-02",
    lookbackDays: 1,
    maturityDelayHours: 3,
    connectorId: 1,
    sourceNetworkCode: "gov_uk_aurn",
    pollutantCodes: ["pm25", "pm10", "no2"],
    minValidHoursPerDay: 18,
    minValidDays: 274,
    minFinalHourCoverageRatio: 0.95,
    readinessGateEnabled: true,
    summaryRefreshEnabled: true,
    chunkDays: 31,
  });

  assert.deepEqual(buildReadinessPayload(config), {
    p_as_of_day_utc: "2026-07-02",
    p_connector_id: 1,
    p_source_network_code: "gov_uk_aurn",
    p_pollutant_codes: ["pm25", "pm10", "no2"],
    p_min_final_hour_coverage_ratio: 0.95,
  });
  assert.deepEqual(buildSummaryRefreshPayload(config), {
    p_as_of_day_utc: "2026-07-02",
    p_connector_id: 1,
    p_source_network_code: "gov_uk_aurn",
    p_pollutant_codes: ["pm25", "pm10", "no2"],
    p_min_valid_days: 274,
    p_min_valid_hours_per_day: 18,
    p_dry_run: false,
  });
});

Deno.test("readiness summary defers until every pollutant is ready", () => {
  const rows = [
    {
      as_of_day_utc: "2026-07-02",
      connector_id: 1,
      source_network_code: "gov_uk_aurn",
      pollutant_code: "pm25",
      eligible_timeseries_count: 145,
      final_hour_timeseries_count: 145,
      final_hour_coverage_ratio: 1,
      final_hour_observed_at: "2026-07-03T00:00:00Z",
      pollutant_ready: true,
      all_pollutants_ready: false,
      already_completed: false,
    },
    {
      as_of_day_utc: "2026-07-02",
      connector_id: 1,
      source_network_code: "gov_uk_aurn",
      pollutant_code: "pm10",
      eligible_timeseries_count: 135,
      final_hour_timeseries_count: 100,
      final_hour_coverage_ratio: 0.7407,
      final_hour_observed_at: "2026-07-03T00:00:00Z",
      pollutant_ready: false,
      all_pollutants_ready: false,
      already_completed: false,
    },
  ];

  assert.deepEqual(summarizeReadinessRows(rows, "2026-07-02"), {
    checked: true,
    ready: false,
    already_completed: false,
    as_of_day_utc: "2026-07-02",
    final_hour_observed_at: "2026-07-03T00:00:00Z",
    pollutant_rows: rows,
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
