import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectorDayPlan,
  convertV1ObservationRowsToV2,
  normalizePollutantCode,
  parseArgs,
} from "../scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs";

test("normalizes pollutant labels used by core snapshots", () => {
  assert.equal(normalizePollutantCode("PM2.5"), "pm25");
  assert.equal(normalizePollutantCode("particulate matter PM10"), "pm10");
  assert.equal(normalizePollutantCode("Nitrogen dioxide"), "no2");
  assert.equal(normalizePollutantCode("ozone"), null);
});

test("converts local v1 observation rows to v2 rows with core metadata", () => {
  const bindings = new Map([
    [101, {
      timeseries_id: 101,
      station_id: 7609,
      connector_id: 3,
      pollutant_code: "pm25",
    }],
  ]);
  const converted = convertV1ObservationRowsToV2({
    connectorId: 3,
    bindingByTimeseriesId: bindings,
    rows: [
      { connector_id: 3, timeseries_id: 101, observed_at: "2026-04-03T01:00:00Z", value: "8.5" },
      { connector_id: 3, timeseries_id: 999, observed_at: "2026-04-03T01:00:00Z", value: "9.5" },
    ],
  });

  assert.equal(converted.missing_metadata_rows, 1);
  assert.deepEqual(converted.rows, [{
    connector_id: 3,
    station_id: 7609,
    timeseries_id: 101,
    pollutant_code: "pm25",
    observed_at_utc: "2026-04-03T01:00:00.000Z",
    value: 8.5,
  }]);
});

test("builds a v2 observations R2 write plan without local parquet output paths", async () => {
  const plan = await buildConnectorDayPlan({
    targetPrefix: "history/v2/observations",
    dayUtc: "2026-04-03",
    connectorId: 3,
    partMaxRows: 100,
    rows: [
      {
        connector_id: 3,
        station_id: 7609,
        timeseries_id: 101,
        pollutant_code: "pm25",
        observed_at_utc: "2026-04-03T01:00:00.000Z",
        value: 8.5,
      },
    ],
  });

  assert.equal(plan.connector_manifest_key, "history/v2/observations/day_utc=2026-04-03/connector_id=3/manifest.json");
  assert.equal(plan.pollutant_plans.length, 1);
  assert.equal(plan.pollutant_plans[0].parts[0].key, "history/v2/observations/day_utc=2026-04-03/connector_id=3/pollutant_code=pm25/part-00000.parquet");
  assert.equal(plan.pollutant_plans[0].parts[0].body.byteLength > 0, true);
});

test("defaults to dry-run and v2 target observations prefix", () => {
  const args = parseArgs(["--from-day", "2026-04-03", "--to-day", "2026-04-10"]);
  assert.equal(args.mode, "dry-run");
  assert.equal(args.targetPrefix, "history/v2/observations");
});
