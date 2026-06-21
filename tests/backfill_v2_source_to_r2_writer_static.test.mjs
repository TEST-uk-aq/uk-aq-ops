import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("workers/uk_aq_backfill_local/run_job.ts", "utf8");

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
