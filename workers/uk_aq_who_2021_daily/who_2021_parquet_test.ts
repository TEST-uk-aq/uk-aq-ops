import {
  rowsToWho2021ParquetBytes,
  translateWho2021ParquetBatch,
  validateWho2021ParquetObjectKey,
} from "./who_2021_parquet.ts";
import assert from "node:assert/strict";
const assertEquals: typeof assert.deepEqual = assert.deepEqual;
const assertThrows = (fn: () => unknown, type: typeof Error, message: string) => assert.throws(fn, (error: unknown) => error instanceof type && error.message.includes(message));

const DAILY_ROW = {
  day_utc: "2026-07-02",
  day_window_start_exclusive_utc: "2026-07-02T00:00:00+00:00",
  day_window_end_inclusive_utc: "2026-07-03T00:00:00+00:00",
  connector_id: 1,
  source_network_code: "gov_uk_aurn",
  station_id: 477,
  timeseries_id: 394,
  pollutant_code: "pm25",
  daily_mean_ugm3: 6.5,
  valid_hour_count: 24,
  min_valid_hours_per_day: 18,
  timestamp_convention: "hour_ending",
  data_completeness_pct: 100,
  who_daily_guideline_ugm3: 15,
  has_enough_data: true,
  above_who_daily_guideline: false,
  status_code: "within_guideline",
  created_at: "2026-07-07T19:41:01.213457+00:00",
  updated_at: "2026-07-07T19:41:01.213457+00:00",
};

const ROLLING_ROW = {
  as_of_day_utc: "2026-07-02",
  window_start_day_utc: "2025-07-03",
  window_end_day_utc: "2026-07-02",
  connector_id: 1,
  source_network_code: "gov_uk_aurn",
  station_id: 477,
  timeseries_id: 394,
  pollutant_code: "pm25",
  rolling_year_mean_ugm3: null,
  valid_day_count: 1,
  valid_hour_count: 24,
  period_day_count: 365,
  min_valid_hours_per_day: 18,
  min_valid_days: 274,
  data_completeness_pct: 0.274,
  has_enough_data: false,
  who_yearly_guideline_ugm3: 5,
  above_who_yearly_guideline: null,
  who_daily_guideline_ugm3: 15,
  daily_above_guideline_days: 0,
  daily_allowance_days: 3,
  daily_above_guideline_days_beyond_allowance: 0,
  above_who_daily_guideline_approach: null,
  created_at: "2026-07-07T19:41:01.213457+00:00",
  updated_at: "2026-07-07T19:41:01.213457+00:00",
};

Deno.test("WHO 2021 daily rows convert to parquet bytes", () => {
  const bytes = rowsToWho2021ParquetBytes({
    dataset: "daily_status",
    object_key:
      "history/v2/who_2021/daily_status/day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    row_count: 1,
    rows_json: [DAILY_ROW],
  }, "history/v2/who_2021/");

  assert(bytes.byteLength > 100);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 4)), "PAR1");
  assertEquals(
    new TextDecoder().decode(bytes.slice(bytes.byteLength - 4)),
    "PAR1",
  );
});

Deno.test("WHO 2021 parquet object keys must match dataset", () => {
  const legacyPrefix = "history/v2/who_2021/";
  const datasets = [
    ["daily_status", "day_utc=2026-07-02"],
    ["rolling_year_status", "as_of_day_utc=2026-07-02"],
    ["calendar_year_status", "calendar_year=2025/period_type=complete_year"],
  ] as const;
  for (const [dataset, partition] of datasets) {
    const relative = `${dataset}/${partition}/connector_id=1/pollutant_code=pm25/part-00000.parquet`;
    const batch = {dataset, object_key: legacyPrefix + relative, row_count: 1, rows_json: [DAILY_ROW]};
    const unchanged = translateWho2021ParquetBatch(batch, legacyPrefix);
    assertEquals(unchanged, batch);
    const moved = translateWho2021ParquetBatch(batch, "who_2021/");
    assertEquals(moved.object_key, "who_2021/" + relative);
    assert.strictEqual(moved.rows_json, batch.rows_json);
    assertEquals(moved.row_count, batch.row_count);
    for (const key of ["who_2021/" + relative, "history/v2/observations/" + relative, legacyPrefix + "../" + relative, legacyPrefix + relative.replace(".parquet", ".json")]) {
      assert.throws(() => translateWho2021ParquetBatch({...batch, object_key: key}, "who_2021/"));
    }
    assert.throws(() => translateWho2021ParquetBatch(batch, ""));
  }

  validateWho2021ParquetObjectKey(
    "rolling_year_status",
    "history/v2/who_2021/rolling_year_status/as_of_day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    "history/v2/who_2021/",
  );

  assertThrows(
    () =>
      validateWho2021ParquetObjectKey(
        "daily_status",
        "history/v2/who_2021/rolling_year_status/as_of_day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
        "history/v2/who_2021/",
      ),
    Error,
    "dataset/key mismatch",
  );
});

Deno.test("WHO 2021 parquet handles true false null and all-null boolean columns", () => {
  const dailyRows = [
    { ...DAILY_ROW, has_enough_data: true, above_who_daily_guideline: true },
    {
      ...DAILY_ROW,
      timeseries_id: 395,
      has_enough_data: true,
      above_who_daily_guideline: false,
    },
    {
      ...DAILY_ROW,
      timeseries_id: 396,
      has_enough_data: false,
      above_who_daily_guideline: null,
    },
  ];
  const dailyBytes = rowsToWho2021ParquetBytes({
    dataset: "daily_status",
    object_key:
      "history/v2/who_2021/daily_status/day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    row_count: dailyRows.length,
    rows_json: dailyRows,
  }, "history/v2/who_2021/");

  const rollingRows = [
    { ...ROLLING_ROW, timeseries_id: 394 },
    { ...ROLLING_ROW, timeseries_id: 395 },
    { ...ROLLING_ROW, timeseries_id: 396 },
  ];
  const rollingBytes = rowsToWho2021ParquetBytes({
    dataset: "rolling_year_status",
    object_key:
      "history/v2/who_2021/rolling_year_status/as_of_day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    row_count: rollingRows.length,
    rows_json: rollingRows,
  }, "history/v2/who_2021/");

  assert(dailyBytes.byteLength > 100);
  assert(rollingBytes.byteLength > 100);
  assertEquals(new TextDecoder().decode(dailyBytes.slice(0, 4)), "PAR1");
  assertEquals(new TextDecoder().decode(rollingBytes.slice(0, 4)), "PAR1");
});

Deno.test("WHO 2021 parquet row count mismatches fail", () => {
  assertThrows(
    () =>
      rowsToWho2021ParquetBytes({
        dataset: "daily_status",
        object_key:
          "history/v2/who_2021/daily_status/day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
        row_count: 2,
        rows_json: [DAILY_ROW],
      }, "history/v2/who_2021/"),
    Error,
    "row count mismatch",
  );
});
