import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildFixedV3IntegrityObservationProposal,
} from "../workers/uk_aq_backfill_local/fixed_v3_integrity_observation_proposal.mjs";
import {
  readCanonicalObservationRows,
} from "../scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const writerGitSha = "7".repeat(40);
const backedUpAtUtc = "2026-09-18T10:11:12.000Z";
const scope = { day_utc: "2026-06-01", connector_id: 1, pollutant_code: "no2" };

function unevenTimeseriesRows() {
  const rows = [];
  for (const [timeseriesId, count, status] of [[101, 3, "P"], [202, 7, "R"], [303, 2, "P"]]) {
    for (let index = 0; index < count; index += 1) {
      rows.push({
        connector_id: scope.connector_id,
        station_id: 10 + timeseriesId,
        timeseries_id: timeseriesId,
        pollutant_code: scope.pollutant_code,
        observed_at_utc: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
        value: timeseriesId / 10 + index,
        verification_status: status,
      });
    }
  }
  return rows;
}

test("fixed-v3 Integrity proposal emits the shared writer's exact files and manifest", async () => {
  const rows = unevenTimeseriesRows();
  const proposal = buildFixedV3IntegrityObservationProposal({
    rows,
    dayUtc: scope.day_utc,
    connectorId: scope.connector_id,
    pollutantCode: scope.pollutant_code,
    targetWriterGitSha: writerGitSha,
    backedUpAtUtc,
    observationsPrefix: "history/v3/observations",
    indexRoot: "history/_index_v3/observations_timeseries",
  });
  const independentlyBuilt = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows,
    scope,
    targetWriterGitSha: writerGitSha,
    backedUpAtUtc,
    observationsPrefix: "history/v3/observations",
    indexRoot: "history/_index_v3/observations_timeseries",
  });

  assert.deepEqual(
    proposal.file_intents.map(({ key }) => key),
    independentlyBuilt.file_intents.map(({ key }) => key),
  );
  assert.ok(proposal.file_intents.every(({ key }) => key.startsWith("history/v3/observations/")));
  for (let index = 0; index < proposal.file_intents.length; index += 1) {
    const staged = proposal.file_intents[index];
    const expected = independentlyBuilt.file_intents[index];
    assert.deepEqual(Buffer.from(staged.body), Buffer.from(expected.body));
    assert.equal(staged.byte_size, staged.body.byteLength);
    assert.equal(staged.sha256, sha256Hex(staged.body));
    assert.equal(staged.byte_size, expected.byte_size);
    assert.equal(staged.sha256, expected.sha256);
  }

  const manifest = proposal.canonical_pollutant_manifest.payload;
  assert.equal(manifest.history_version, "v2");
  assert.equal(manifest.history_schema_version, 3);
  assert.equal(manifest.writer_version, "parquet-wasm-zstd-v3");
  assert.equal(manifest.writer_git_sha, writerGitSha);
  assert.equal(manifest.backed_up_at_utc, backedUpAtUtc);
  assert.equal(manifest.row_count, rows.length);
  assert.deepEqual(manifest.verification_status_counts, { P: 5, R: 7, null: 0 });
  assert.deepEqual(manifest.parquet_object_keys, proposal.file_intents.map(({ key }) => key));
  assert.deepEqual(
    manifest.files.map(({ key, bytes, etag_or_hash }) => ({ key, bytes, sha256: etag_or_hash })),
    proposal.file_intents.map(({ key, byte_size, sha256 }) => ({ key, bytes: byte_size, sha256 })),
  );

  const decoded = (await Promise.all(proposal.file_intents.map((intent) =>
    readCanonicalObservationRows({ body: intent.body, connectorId: scope.connector_id })
  ))).flat();
  assert.deepEqual(
    decoded.reduce((counts, row) => ({
      ...counts,
      [row.verification_status]: (counts[row.verification_status] || 0) + 1,
    }), {}),
    { P: 5, R: 7 },
  );
});

test("run_job selects exact-v3 only for repair proposals and retains the legacy fallback", () => {
  const source = readFileSync(
    join(repoRoot, "workers/uk_aq_backfill_local/run_job.ts"),
    "utf8",
  );
  assert.match(source, /HISTORY_R2_WRITE_VERSION === "v3"[\s\S]*INTEGRITY_PROPOSAL_MODE[\s\S]*UK_AQ_INTEGRITY_WORKER_PURPOSE"\) === "repair_proposal"[\s\S]*!INTEGRITY_SOURCE_EVIDENCE_ONLY/);
  assert.match(source, /if \(USE_FIXED_V3_INTEGRITY_PROPOSAL_WRITER\)[\s\S]*buildFixedV3IntegrityObservationProposal/);
  assert.match(source, /else \{[\s\S]*chunkRows\(canonicalPollutantRows, OBS_R2_PART_MAX_ROWS\)[\s\S]*rowsToObservationV2ParquetBuffer\(parquetRows\)/);
});
