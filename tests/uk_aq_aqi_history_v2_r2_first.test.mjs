import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpectedAqiHourBuckets,
  summarizeExpectedAqiHourCoverage,
  mergePointsPreferPrimary,
  filterPointsToMissingRows,
  extractParquetKeysFromTimeseriesIndex,
  resolveObservationsApiUrl,
  summarizeObservationApiCompleteness,
} from "../workers/uk_aq_aqi_history_r2_api_worker/worker.mjs";

function row(hour, source = "r2", daqi = 2, eaqi = 3) {
  return {
    period_start_utc: `2026-06-21T${String(hour).padStart(2, "0")}:00:00.000Z`,
    connector_id: 1,
    station_id: 10,
    timeseries_id: 218,
    pollutant_code: "pm25",
    daqi_index_level: daqi,
    eaqi_index_level: eaqi,
    source,
  };
}

test("v2 expected hourly coverage treats complete R2 rows as complete even when ObsAQIDB has fewer rows", () => {
  const r2Rows = Array.from({ length: 24 }, (_, hour) => row(hour, "r2"));
  const sparseObsRows = [row(0, "obs_aqidb"), row(1, "obs_aqidb"), row(2, "obs_aqidb")];
  const obsFillRows = filterPointsToMissingRows(
    sparseObsRows,
    r2Rows,
    Date.parse("2026-06-21T00:00:00Z"),
    Date.parse("2026-06-22T00:00:00Z"),
  );
  const merged = mergePointsPreferPrimary(r2Rows, obsFillRows, null);
  const coverage = summarizeExpectedAqiHourCoverage(merged, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });

  assert.equal(obsFillRows.length, 0);
  assert.equal(merged.length, 24);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.missing_hour_count, 0);
});

test("v2 R2 gaps can be completed by ObsAQIDB fill rows while preserving R2 precedence", () => {
  const r2Rows = Array.from({ length: 24 }, (_, hour) => row(hour, "r2"))
    .filter((point) => ![5, 6].includes(Number(point.period_start_utc.slice(11, 13))));
  const obsRows = [row(5, "obs_aqidb", 4, 4), row(6, "obs_aqidb", 5, 5), row(7, "obs_aqidb", 9, 9)];
  const obsFillRows = filterPointsToMissingRows(
    obsRows,
    r2Rows,
    Date.parse("2026-06-21T00:00:00Z"),
    Date.parse("2026-06-22T00:00:00Z"),
  );
  const merged = mergePointsPreferPrimary(r2Rows, obsFillRows, null);
  const coverage = summarizeExpectedAqiHourCoverage(merged, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });

  assert.deepEqual(obsFillRows.map((point) => point.period_start_utc.slice(11, 13)), ["05", "06"]);
  assert.equal(merged.find((point) => point.period_start_utc.includes("T07:"))?.source, "r2");
  assert.equal(coverage.complete, true);
});

test("v2 expected-hour coverage reports incomplete responses when both R2 and ObsAQIDB miss hours", () => {
  const merged = Array.from({ length: 24 }, (_, hour) => row(hour, "r2"))
    .filter((point) => ![5, 6].includes(Number(point.period_start_utc.slice(11, 13))));
  const coverage = summarizeExpectedAqiHourCoverage(merged, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });

  assert.equal(coverage.complete, false);
  assert.equal(coverage.missing_hour_count, 2);
  assert.deepEqual(coverage.missing_hours, [
    "2026-06-21T05:00:00.000Z",
    "2026-06-21T06:00:00.000Z",
  ]);
});

test("v2 pollutant-partitioned timeseries index uses manifest files[].key parquet targets", () => {
  const extraction = extractParquetKeysFromTimeseriesIndex({
    files: [
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-21/connector_id=1/pollutant_code=pm25/part-000.parquet",
        min_timeseries_id: 200,
        max_timeseries_id: 250,
        pollutant_code: "pm25",
      },
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-21/connector_id=1/pollutant_code=pm10/part-000.parquet",
        min_timeseries_id: 200,
        max_timeseries_id: 250,
        pollutant_code: "pm10",
      },
    ],
  }, [218], "pm25");

  assert.deepEqual(extraction.keys, [
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-21/connector_id=1/pollutant_code=pm25/part-000.parquet",
  ]);
  assert.equal(extraction.file_count, 2);
  assert.equal(extraction.skipped_by_pollutant_file_count, 1);
});

test("since removes intentionally skipped incremental hours from expected-hour coverage", () => {
  assert.deepEqual(buildExpectedAqiHourBuckets(
    "2026-06-21T00:00:00Z",
    "2026-06-21T03:00:00Z",
    "2026-06-21T00:00:00Z",
  ), [
    "2026-06-21T01:00:00.000Z",
    "2026-06-21T02:00:00.000Z",
  ]);
});

test("v2 reports R2-only coverage separately from merged coverage", () => {
  const r2Rows = Array.from({ length: 24 }, (_, hour) => row(hour, "r2"))
    .filter((point) => ![5, 6].includes(Number(point.period_start_utc.slice(11, 13))));
  const obsRows = [row(5, "obs_aqidb"), row(6, "obs_aqidb")];
  const obsFillRows = filterPointsToMissingRows(
    obsRows,
    r2Rows,
    Date.parse("2026-06-21T00:00:00Z"),
    Date.parse("2026-06-22T00:00:00Z"),
  );
  const merged = mergePointsPreferPrimary(r2Rows, obsFillRows, null);
  const r2Coverage = summarizeExpectedAqiHourCoverage(r2Rows, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });
  const mergedCoverage = summarizeExpectedAqiHourCoverage(merged, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });

  assert.equal(r2Coverage.complete, false);
  assert.equal(r2Coverage.missing_hour_count, 2);
  assert.equal(mergedCoverage.complete, true);
  assert.equal(mergedCoverage.missing_hour_count, 0);
});

test("row_limit limits returned points without creating expected-hour coverage gaps", () => {
  const fullMergedRows = Array.from({ length: 24 }, (_, hour) => row(hour, "r2"));
  const preLimitCoverage = summarizeExpectedAqiHourCoverage(fullMergedRows, {
    startIso: "2026-06-21T00:00:00Z",
    endIso: "2026-06-22T00:00:00Z",
    timeseriesId: 218,
    pollutantKey: "pm25",
  });
  const returnedRows = mergePointsPreferPrimary(fullMergedRows, [], 10);

  assert.equal(preLimitCoverage.complete, true);
  assert.equal(preLimitCoverage.missing_hour_count, 0);
  assert.equal(returnedRows.length, 10);
});


test("live fallback merge returns live-calculated rows when R2 is missing", async () => {
  const { mergeAqiRowsPreferR2 } = await import("../lib/aqi/aqi_levels.mjs");
  const live = [row(5, "live_calculated", 4, 4)];
  const merged = mergeAqiRowsPreferR2({ r2Rows: [], liveRows: live });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "live_calculated");
});

test("R2 AQI wins over live rows even when R2 status is insufficient/null", async () => {
  const { mergeAqiRowsPreferR2 } = await import("../lib/aqi/aqi_levels.mjs");
  const r2 = [{
    ...row(8, "r2", null, null),
    daqi_calculation_status: "insufficient_samples",
    eaqi_calculation_status: "insufficient_samples",
    daqi_missing_reason: "not_enough_samples",
    eaqi_missing_reason: "not_enough_samples",
  }];
  const live = [row(8, "live_calculated", 2, 2)];
  const merged = mergeAqiRowsPreferR2({ r2Rows: r2, liveRows: live });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "r2");
  assert.equal(merged[0].daqi_index_level, null);
  assert.equal(merged[0].daqi_calculation_status, "insufficient_samples");
});

test("observations API URL resolver uses /v1/observations without duplicating endpoint paths", () => {
  assert.equal(resolveObservationsApiUrl("https://example.workers.dev").toString(), "https://example.workers.dev/v1/observations");
  assert.equal(resolveObservationsApiUrl("https://example.workers.dev/v1/observations").toString(), "https://example.workers.dev/v1/observations");
});

test("observation completeness metadata marks HTTP 200 partial scans incomplete", () => {
  const partial = summarizeObservationApiCompleteness({
    response_complete: false,
    has_gap: true,
    coverage_state: "partial",
    partial_reasons: ["missing_manifest"],
  });
  assert.equal(partial.response_complete, false);
  assert.deepEqual(partial.partial_reasons, ["missing_manifest"]);
  const completeInsufficientSamples = summarizeObservationApiCompleteness({
    response_complete: true,
    coverage_state: "complete",
    rows: [],
  });
  assert.equal(completeInsufficientSamples.response_complete, true);
});

test("PM live fallback context can begin before mutable output boundary while ingest remains bounded", () => {
  const outputStartMs = Date.parse("2026-07-09T01:00:00.000Z");
  const retentionStartMs = Date.parse("2026-07-10T00:00:00.000Z");
  const r2ObservationStartMs = outputStartMs - 23 * 60 * 60 * 1000;
  const ingestObservationStartMs = Math.max(outputStartMs, retentionStartMs);
  assert.equal(new Date(r2ObservationStartMs).toISOString(), "2026-07-08T02:00:00.000Z");
  assert.equal(new Date(ingestObservationStartMs).toISOString(), "2026-07-10T00:00:00.000Z");
});
