import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_OBSERVATIONS_COLUMNS_V1,
  buildConnectorManifestForTest,
  computeDayGateState,
} from "../workers/uk_aq_prune_daily/phase_b_backup_r2.mjs";

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
        key: "backup/observations/day_utc=2026-02-20/connector_id=4/part-00000.parquet",
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
  assert.deepEqual(manifest.columns, BACKUP_OBSERVATIONS_COLUMNS_V1);
  assert.ok(Array.isArray(manifest.parquet_object_keys));
  assert.equal(manifest.parquet_object_keys.length, 1);
  assert.equal(typeof manifest.manifest_hash, "string");
  assert.ok(manifest.manifest_hash.length > 10);
  assert.equal(manifest.backup_schema_name, "observations");
  assert.equal(manifest.backup_schema_version, 1);
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
