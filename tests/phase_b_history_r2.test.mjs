import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_OBSERVATIONS_COLUMNS_V2,
  buildConnectorManifestForTest,
  computeDayGateState,
  dayWindowFromNow,
  resolvePhaseBRuntimeConfig,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

test("connector manifest includes expected Phase B fields", () => {
  const manifest = buildConnectorManifestForTest({
    dayUtc: "2026-02-20",
    connectorId: 4,
    runId: "run-123",
    sourceRowCount: 3,
    minObservedAt: "2026-02-20T00:00:00.000Z",
    maxObservedAt: "2026-02-20T00:02:00.000Z",
    fileEntries: [
      {
        key: "history/v1/observations/day_utc=2026-02-20/connector_id=4/part-00000.parquet",
        bytes: 1200,
        row_count: 3,
        etag_or_hash: "etag-a",
      },
    ],
    writerGitSha: "abc123",
    backedUpAtUtc: "2026-03-02T11:00:00.000Z",
  });

  assert.equal(manifest.day_utc, "2026-02-20");
  assert.equal(manifest.connector_id, 4);
  assert.equal(manifest.run_id, "run-123");
  assert.equal(manifest.source_row_count, 3);
  assert.equal(manifest.file_count, 1);
  assert.equal(manifest.total_bytes, 1200);
  assert.deepEqual(manifest.columns, HISTORY_OBSERVATIONS_COLUMNS_V2);
  assert.ok(Array.isArray(manifest.parquet_object_keys));
  assert.equal(manifest.parquet_object_keys.length, 1);
  assert.equal(typeof manifest.manifest_hash, "string");
  assert.ok(manifest.manifest_hash.length > 10);
  assert.equal(manifest.history_schema_name, "observations");
  assert.equal(manifest.history_schema_version, 2);
});

test("day gate is only complete when all connector candidates are complete", () => {
  const pendingState = computeDayGateState([
    { status: "complete" },
    { status: "pending" },
  ]);
  assert.equal(pendingState.all_complete, false);
  assert.equal(pendingState.complete, 1);
  assert.equal(pendingState.pending, 1);

  const failedState = computeDayGateState([
    { status: "complete" },
    { status: "failed" },
  ]);
  assert.equal(failedState.all_complete, false);
  assert.equal(failedState.failed, 1);

  const completeState = computeDayGateState([
    { status: "complete" },
    { status: "complete" },
  ]);
  assert.equal(completeState.all_complete, true);
  assert.equal(completeState.complete, 2);
  assert.equal(completeState.pending, 0);
  assert.equal(completeState.in_progress, 0);
  assert.equal(completeState.failed, 0);
});

test("runtime config includes AQI levels prefix defaults", () => {
  const config = resolvePhaseBRuntimeConfig({});
  assert.equal(config.committed_prefix, "history/v1/observations");
  assert.equal(config.aqilevels_prefix, "history/v1/aqilevels");
  assert.equal(config.observations_part_max_rows, 500000);
  assert.equal(config.observations_row_group_size, 50000);
  assert.equal(config.aqilevels_part_max_rows, 1000000);
  assert.equal(config.aqilevels_row_group_size, 100000);
});

test("runtime config supports domain-specific parquet geometry overrides", () => {
  const config = resolvePhaseBRuntimeConfig({
    UK_AQ_R2_HISTORY_PART_MAX_ROWS: "900000",
    UK_AQ_R2_HISTORY_ROW_GROUP_SIZE: "90000",
    UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS: "250000",
    UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE: "25000",
    UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS: "1200000",
    UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE: "120000",
  });
  assert.equal(config.part_max_rows, 900000);
  assert.equal(config.row_group_size, 90000);
  assert.equal(config.observations_part_max_rows, 250000);
  assert.equal(config.observations_row_group_size, 25000);
  assert.equal(config.aqilevels_part_max_rows, 1200000);
  assert.equal(config.aqilevels_row_group_size, 120000);
});

test("Phase B eligibility tracks ingest retention days", () => {
  const windowDefault = dayWindowFromNow("2026-03-17T11:00:00.000Z", 7);
  assert.equal(windowDefault.ingest_retention_days, 7);
  assert.equal(windowDefault.phase_b_eligible_age_days, 8);
  assert.equal(windowDefault.latest_eligible_day_utc, "2026-03-09");
  assert.equal(windowDefault.latest_eligible_window_end_utc, "2026-03-10T00:00:00.000Z");

  const windowFiveDay = dayWindowFromNow("2026-03-17T11:00:00.000Z", 5);
  assert.equal(windowFiveDay.ingest_retention_days, 5);
  assert.equal(windowFiveDay.phase_b_eligible_age_days, 6);
  assert.equal(windowFiveDay.latest_eligible_day_utc, "2026-03-11");
  assert.equal(windowFiveDay.latest_eligible_window_end_utc, "2026-03-12T00:00:00.000Z");
});
