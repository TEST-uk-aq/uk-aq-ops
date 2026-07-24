import {
  rowsToWho2021ParquetBytes,
  validateWho2021ParquetObjectKey,
} from "./who_2021_parquet.ts";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";

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
  });

  assert(bytes.byteLength > 100);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 4)), "PAR1");
  assertEquals(
    new TextDecoder().decode(bytes.slice(bytes.byteLength - 4)),
    "PAR1",
  );
});

Deno.test("WHO 2021 parquet object keys must match dataset", () => {
  validateWho2021ParquetObjectKey(
    "rolling_year_status",
    "history/v2/who_2021/rolling_year_status/as_of_day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
  );

  assertThrows(
    () =>
      validateWho2021ParquetObjectKey(
        "daily_status",
        "history/v2/who_2021/rolling_year_status/as_of_day_utc=2026-07-02/connector_id=1/pollutant_code=pm25/part-00000.parquet",
      ),
    Error,
    "does not match dataset",
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
  });

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
  });

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
      }),
    Error,
    "row count mismatch",
  );
});
