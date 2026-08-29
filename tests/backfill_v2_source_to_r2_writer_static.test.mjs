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
  assert.match(body, /classifyObservationRowsForV2PollutantPartitions\(rowsForWrite\)/);
  assert.ok(
    body.indexOf("classifyObservationRowsForV2PollutantPartitions(rowsForWrite)") <
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
  assert.match(body, /rowsForWrite\.length > 0 && classification\.valid_rows\.length === 0/);
  assert.match(body, /No valid pollutant_code rows for v2 observation R2 write/);
});

test("v2 observations writer writes pollutant partitions and not connector-level parquet parts", () => {
  const body = bodyOf("exportObsConnectorRowsToR2V2");
  assert.match(body, /buildHistoryV2PartKey\([\s\S]*pollutantCode,[\s\S]*partIndex/);
  assert.doesNotMatch(body, /buildObsPartKey\(/);
  assert.doesNotMatch(body, /part-\$\{String\(partIndex\)/);
});

test("direct live source-to-R2 routes fail closed outside Integrity proposal apply", () => {
  const body = bodyOf("assertSharedCanonicalMutationRoute");
  assert.match(body, /DIRECT_R2_MUTATION_MODES\.has\(runMode\)/);
  assert.match(body, /!dryRun && !integrityProposalMode/);
  assert.match(body, /direct live R2 mutation is retired/);
});

test("OpenAQ mapping fails closed when a binding lacks a canonical pollutant", () => {
  const body = bodyOf("parseOpenaqCsvObservations");
  assert.match(body, /const parameterRaw = String\(columns\[parameterIndex\]/);
  assert.match(body, /const pollutantCode = parseSourcePollutantCode\(parameterRaw\)/);
  assert.match(body, /const canonicalPollutant = parseSourcePollutantCode\(String\(binding\.pollutant_code \|\| ""\)\)/);
  assert.match(body, /openaq_mapping_missing_canonical_pollutant/);
  assert.match(body, /pollutant_code: canonicalPollutant/);
  assert.match(body, /source_parameter: parameterRaw/);
});

test("UK-AIR source-to-R2 requires valid flat-file mappings before fetching observations", () => {
  const guardBody = bodyOf("assertSosFlatFileMappingsForBackfill");
  assert.match(source, /sos_station_timeseries_site_refs/);
  assert.match(guardBody, /missing_timeseries_ids/);
  assert.match(guardBody, /ambiguous_site_pollutant_sample/);
  assert.match(guardBody, /UK-AIR flat-file mapping guard failed/);

  assert.match(source, /assertSosFlatFileMappingsForBackfill/);
  assert.ok(
    source.indexOf("assertSosFlatFileMappingsForBackfill") <
      source.indexOf("processSosTimeseriesBatch"),
    "mapping guard runs before UK-AIR source fetches",
  );
});

test("UK-AIR observation status is canonicalised for new R2 v2 writes", () => {
  assert.match(source, /status\?: string \| null/);
  assert.match(source, /status: datapoint\.status/);
  assert.match(source, /status_values/);
  assert.match(source, /HISTORY_OBSERVATIONS_COLUMNS[\s\S]*"status"/);
  assert.match(
    source,
    /HISTORY_OBSERVATIONS_COLUMNS_R2_V2[\s\S]*"verification_status"/,
  );
  assert.match(source, /serializeCanonicalObservationV2Parquet/);
  assert.match(source, /normalizeUkAirVerificationStatus/);
});

test("retired direct AQI R2 backfill is rejected before its historical adapter can run", () => {
  assert.match(
    source,
    /const DIRECT_R2_MUTATION_MODES = new Set<RunMode>\(\[[\s\S]*"r2_history_obs_to_aqilevels"[\s\S]*\]\);/,
  );
  const mainBody = bodyOf("main");
  assert.ok(
    mainBody.indexOf("assertSharedCanonicalMutationRoute") <
      mainBody.indexOf("runR2HistoryObsToAqilevels"),
    "direct-mutation retirement guard runs before the historical AQI adapter",
  );
});

test("local backfill wrapper adds targeted v2 AQI timeseries-count repair flags only when requested", () => {
  assert.match(wrapperSource, /UK_AQ_BACKFILL_REPAIR_MISSING_TIMESERIES_COUNTS:-false/);
  assert.match(wrapperSource, /UK_AQ_BACKFILL_INDEX_STRICT_MISSING_TIMESERIES_COUNTS:-false/);
  assert.match(wrapperSource, /refreshes v2 daily indexes/);
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

test("v2 AQI rebuild allows connector-scoped refresh without full-day non-target guard", () => {
  const body = bodyOf("runR2HistoryObsToAqilevels");
  assert.match(
    body,
    /const allowConnectorScopedV2AqiRefresh = HISTORY_R2_WRITE_VERSION === "v2" &&\s+hasConnectorFilter/,
  );
  assert.match(
    body,
    /if \(hasConnectorFilter && !allowConnectorScopedV2AqiRefresh\) \{[\s\S]*loadExistingAqiConnectorManifest/,
  );
  assert.match(
    body,
    /const unresolvedNonTargetAfterRefresh =\s+hasConnectorFilter && !allowConnectorScopedV2AqiRefresh\s+\? nonTargetConnectors\.filter/,
  );
  assert.match(body, /r2_history_obs_to_aqilevels_day_skipped_connector_filter_incomplete/);
  assert.match(body, /connector_scoped_v2_aqi_refresh: allowConnectorScopedV2AqiRefresh/);
});
