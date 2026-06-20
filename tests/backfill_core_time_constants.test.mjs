import test from "node:test";
import assert from "node:assert/strict";
import {
  addUtcHours,
  computeRollingLocalRetentionWindow,
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
