import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("workers/uk_aq_backfill_local/run_job.ts", "utf8");
const wrapperSource = readFileSync("scripts/uk_aq_backfill_local.sh", "utf8");

function bodyOf(functionName) {
  const start = source.indexOf(`function ${functionName}`) >= 0
    ? source.indexOf(`function ${functionName}`)
    : source.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} exists`);
  const nextFunction = source.indexOf("\nfunction ", start + 1);
  const nextAsyncFunction = source.indexOf("\nasync function ", start + 1);
  const candidates = [nextFunction, nextAsyncFunction].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("v2 observations writer classifies pollutant codes before grouping", () => {
  const body = bodyOf("exportObsConnectorRowsToR2V2");
  assert.match(body, /classifyObservationRowsForV2PollutantPartitions\(args\.rows\)/);
  assert.ok(
    body.indexOf("classifyObservationRowsForV2PollutantPartitions(args.rows)") <
      body.indexOf("groupObservationRowsByPollutant(sortedRows)"),
    "classification happens before pollutant grouping",
  );
  assert.match(body, /source_to_r2_v2_observations_missing_pollutant_code_rows_skipped/);
  assert.match(body, /rows_skipped_missing_pollutant_code/);
  assert.match(body, /example_missing_pollutant_rows/);
  assert.match(body, /pollutant_codes_written/);
});

test("v2 observations writer fails clearly when every row lacks a valid pollutant code", () => {
  const body = bodyOf("exportObsConnectorRowsToR2V2");
  assert.match(body, /args\.rows\.length > 0 && classification\.valid_rows\.length === 0/);
  assert.match(body, /No valid pollutant_code rows for v2 observation R2 write/);
});

test("v2 observations writer writes pollutant partitions and not connector-level parquet parts", () => {
  const body = bodyOf("exportObsConnectorRowsToR2V2");
  assert.match(body, /buildHistoryV2PartKey\([\s\S]*pollutantCode,[\s\S]*partIndex/);
  assert.doesNotMatch(body, /buildObsPartKey\(/);
  assert.doesNotMatch(body, /part-\$\{String\(partIndex\)/);
});

test("v1 observations writer still uses connector-level part keys", () => {
  const body = bodyOf("exportObsConnectorRowsToR2");
  assert.match(body, /if \(HISTORY_R2_WRITE_VERSION === "v2"\)/);
  assert.match(body, /buildObsPartKey\(args\.day_utc, args\.connector_id, partIndex\)/);
});

test("OpenAQ mapping keeps pollutant_code from source parameter if binding code is blank", () => {
  const body = bodyOf("parseOpenaqCsvObservations");
  assert.match(body, /const parameterRaw = String\(columns\[parameterIndex\]/);
  assert.match(body, /const pollutantCode = parseSourcePollutantCode\(parameterRaw\)/);
  assert.match(
    body,
    /pollutant_code: parseSourcePollutantCode\(String\(binding\.pollutant_code \|\| ""\)\) \|\| pollutantCode/,
  );
  assert.match(body, /source_parameter: parameterRaw/);
});

test("AQI writer carries part timeseries counts into v1 and v2 manifest builders", () => {
  const summaryBody = bodyOf("summarizeAqilevelsPartRows");
  assert.match(summaryBody, /timeseries_row_counts: Record<string, number>/);
  assert.match(summaryBody, /timeseriesRowCounts\[key\] = \(timeseriesRowCounts\[key\] \|\| 0\) \+ 1/);

  const v2PollutantBody = bodyOf("createAqiV2PollutantManifest");
  assert.match(v2PollutantBody, /timeseriesRowCounts = aggregateTimeseriesRowCounts\(filesWithCounts\)/);
  assert.match(v2PollutantBody, /timeseries_row_counts: timeseriesRowCounts/);
  assert.match(v2PollutantBody, /stripTimeseriesCountsFromFileEntries\(filesWithCounts\)/);

  const v2ConnectorBody = bodyOf("createAqiV2ConnectorManifest");
  assert.match(v2ConnectorBody, /timeseriesRowCounts = aggregateTimeseriesRowCounts/);
  assert.match(v2ConnectorBody, /timeseries_row_counts: timeseriesRowCounts/);

  const v1ConnectorBody = bodyOf("createAqiConnectorManifest");
  assert.match(v1ConnectorBody, /stripTimeseriesCountsFromFileEntries\(args\.fileEntries\)/);
  assert.match(v1ConnectorBody, /timeseries_row_counts: timeseriesRowCounts/);
});

test("local backfill wrapper adds targeted v2 AQI timeseries-count repair flags only when requested", () => {
  assert.match(wrapperSource, /UK_AQ_BACKFILL_REPAIR_MISSING_TIMESERIES_COUNTS:-false/);
  assert.match(wrapperSource, /UK_AQ_BACKFILL_INDEX_STRICT_MISSING_TIMESERIES_COUNTS:-false/);
  assert.match(wrapperSource, /refreshes v2 timeseries metadata/);
  assert.match(wrapperSource, /--history-version v2/);
  assert.match(wrapperSource, /--targeted/);
  assert.match(wrapperSource, /--domain aqilevels/);
  assert.match(wrapperSource, /--from-day "\$\{REQUESTED_FROM_DAY_UTC\}"/);
  assert.match(wrapperSource, /--to-day "\$\{REQUESTED_TO_DAY_UTC\}"/);
  assert.match(wrapperSource, /--compute-missing-timeseries-counts/);
  assert.match(wrapperSource, /--strict-missing-timeseries-counts/);
  assert.match(wrapperSource, /--connector-id "\$\{index_connector_id\}"/);
});

test("local backfill wrapper passes active history version to normal final index rebuild when set", () => {
  assert.match(wrapperSource, /INDEX_HISTORY_VERSION_RAW="\$\(trim "\$\{UK_AQ_R2_HISTORY_VERSION:-\}"\)"/);
  assert.match(wrapperSource, /Invalid UK_AQ_R2_HISTORY_VERSION for final index rebuild/);
  assert.match(wrapperSource, /index_cmd\+=\(--history-version "\$\{INDEX_HISTORY_VERSION\}"\)/);
});
