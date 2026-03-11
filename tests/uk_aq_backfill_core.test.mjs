import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBackwardDayRange,
  computeRollingLocalRetentionWindow,
  isDayInRollingRetentionWindow,
  parseRunMode,
  shouldSkipCompletedDay,
} from "../workers/uk_aq_backfill_cloud_run/backfill_core.mjs";

test("parseRunMode accepts valid values and falls back on invalid", () => {
  assert.equal(parseRunMode("local_to_aqilevels", "obs_aqi_to_r2"), "local_to_aqilevels");
  assert.equal(parseRunMode("OBS_AQI_TO_R2", "local_to_aqilevels"), "obs_aqi_to_r2");
  assert.equal(parseRunMode("", "source_to_r2"), "source_to_r2");
  assert.equal(parseRunMode("not-a-mode", "local_to_aqilevels"), "local_to_aqilevels");
});

test("buildBackwardDayRange returns newest-first days", () => {
  assert.deepEqual(
    buildBackwardDayRange("2026-03-01", "2026-03-05"),
    ["2026-03-05", "2026-03-04", "2026-03-03", "2026-03-02", "2026-03-01"],
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
