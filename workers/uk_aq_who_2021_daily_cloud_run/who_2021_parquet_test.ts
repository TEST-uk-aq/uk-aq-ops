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
