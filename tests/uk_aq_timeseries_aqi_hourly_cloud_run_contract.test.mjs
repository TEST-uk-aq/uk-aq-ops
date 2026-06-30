import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(__dirname, "../workers/uk_aq_timeseries_aqi_hourly_cloud_run");

const runJobSrc = fs.readFileSync(path.join(workerDir, "run_job.ts"), "utf8");
const runServiceSrc = fs.readFileSync(path.join(workerDir, "run_service.ts"), "utf8");
const readmeSrc = fs.readFileSync(path.join(workerDir, "README.md"), "utf8");
const systemDocSrc = fs.readFileSync(
  path.resolve(__dirname, "../system_docs/uk-aq-timeseries-aqi-hourly.md"),
  "utf8",
);

test("hourly Cloud Run worker uses normalized helper rows and no legacy wide AQI fields", () => {
  assert.match(runJobSrc, /type HelperRow = \{/);
  assert.match(runJobSrc, /daqi_input_value_ugm3/);
  assert.match(runJobSrc, /eaqi_input_value_ugm3/);
  assert.match(runJobSrc, /hourly_sample_count/);
  assert.doesNotMatch(
    runJobSrc,
    /no2_hourly_mean_ugm3|pm25_hourly_mean_ugm3|pm10_hourly_mean_ugm3|pm25_rolling24h_mean_ugm3|pm10_rolling24h_mean_ugm3/,
  );
});

test("hourly Cloud Run worker still scopes targeted rebuilds with timeseries ids", () => {
  assert.match(
    runServiceSrc,
    /ALLOWED_RUN_MODES = new Set\(\["sync_hourly", "backfill", "reconcile_short", "reconcile_deep"\]\)/,
  );
  assert.match(runJobSrc, /const TIMESERIES_IDS = parseTimeseriesIdsCsv/);
  assert.match(runJobSrc, /args\.p_timeseries_ids = TIMESERIES_IDS/);
  assert.match(readmeSrc, /UK_AQ_AQI_TIMESERIES_IDS_CSV/);
  assert.match(systemDocSrc, /UK_AQ_AQI_TIMESERIES_IDS_CSV/);
});

test("hourly worker preflights missing station FKs and reports controlled continuation", () => {
  assert.match(runJobSrc, /fetchExistingStationIds/);
  assert.match(runJobSrc, /partitionRowsByExistingStations/);
  assert.match(runJobSrc, /missing_station_fk_unhandled_by_preflight/);
  assert.match(runJobSrc, /missing_station_fk_count/);
  assert.match(runJobSrc, /missing_station_fk_ids/);
  assert.match(runJobSrc, /skipped_missing_station_fk_rows/);
  assert.match(runJobSrc, /continued_after_missing_station_fk/);
  assert.match(runJobSrc, /uploadDropboxErrorLog/);
  assert.match(runJobSrc, /timeseries_aqi_hourly/);
  assert.match(
    runJobSrc,
    /station_id: missingStationIds\.length === 1 \? missingStationIds\[0\] : null/,
  );
  assert.match(readmeSrc, /sample capped at 20 rows/);
  assert.match(readmeSrc, /\/CIC-Test\/error_log\/YYYY-MM-DD/);
  for (const requiredDropboxSetting of [
    "DROPBOX_APP_KEY",
    "DROPBOX_APP_SECRET",
    "DROPBOX_REFRESH_TOKEN",
    "UK_AQ_DROPBOX_ROOT",
  ]) {
    assert.match(readmeSrc, new RegExp(requiredDropboxSetting));
    assert.match(systemDocSrc, new RegExp(requiredDropboxSetting));
  }
  assert.match(systemDocSrc, /refresh the mirrored stations table/);
});
