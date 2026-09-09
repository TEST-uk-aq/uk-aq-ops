import test from "node:test";
import assert from "node:assert/strict";

import {
  groupFingerprintRechecksByHour,
} from "../workers/uk_aq_prune_daily/fingerprint_recheck.mjs";
import {
  attachRepairPostRecheckOutcomes,
  classifyRepairReplayOutcome,
  summarizeRepairReplayOutcomes,
} from "../workers/uk_aq_prune_daily/server.mjs";

test("fingerprint rechecks are grouped into ordered one-hour windows", () => {
  const firstMismatch = {
    connector_id: "1",
    hour_start: "2026-07-01T22:00:00.000Z",
  };
  const secondConnectorSameHour = {
    connector_id: "7",
    hour_start: "2026-07-01T22:00:00.000Z",
  };
  const earlierMismatch = {
    connector_id: "3",
    hour_start: "2026-07-01T21:00:00.000Z",
  };

  assert.deepEqual(
    groupFingerprintRechecksByHour([
      firstMismatch,
      secondConnectorSameHour,
      earlierMismatch,
    ]),
    [
      {
        window_start: "2026-07-01T21:00:00.000Z",
        window_end: "2026-07-01T22:00:00.000Z",
        mismatches: [earlierMismatch],
      },
      {
        window_start: "2026-07-01T22:00:00.000Z",
        window_end: "2026-07-01T23:00:00.000Z",
        mismatches: [firstMismatch, secondConnectorSameHour],
      },
    ],
  );
});

test("fingerprint recheck grouping rejects an invalid hour", () => {
  assert.throws(
    () => groupFingerprintRechecksByHour([{ connector_id: "1", hour_start: "invalid" }]),
    /Invalid mismatch hour_start/,
  );
});

test("repair reporting distinguishes a completed attempt from zero applied rows", () => {
  const replayClassification = classifyRepairReplayOutcome({
    rowsSelected: 11_125,
    rowsSubmitted: 11_125,
    rowsReplayed: 0,
  });
  assert.deepEqual(replayClassification, {
    repair_attempted: true,
    replay_outcome: "not_applied",
    replay_not_applied_reason: "obs_aqidb_upsert_applied_zero_rows",
    receipt_semantics: "sync_attempt_audit_not_applied_row_evidence",
  });

  const [postRecheck] = attachRepairPostRecheckOutcomes([
    {
      connector_id: "1",
      hour_start: "2026-09-03T00:00:00.000Z",
      rows_selected: 11_125,
      rows_submitted: 11_125,
      rows_replayed: 0,
      receipts_upserted: 11_125,
      ...replayClassification,
    },
  ], [
    {
      connector_id: "1",
      hour_start: "2026-09-03T00:00:00.000Z",
      reason: "fingerprint_mismatch",
    },
  ]);

  assert.equal(postRecheck.post_repair_mismatch_remaining, true);
  assert.equal(postRecheck.operator_recovery_required, true);
  assert.match(postRecheck.operator_recovery_message, /authoritative recovery path/);
  assert.deepEqual(summarizeRepairReplayOutcomes([postRecheck]), {
    attempt_count: 1,
    applied_count: 0,
    success_count: 0,
    not_applied_count: 1,
    mismatch_remaining_after_attempt_count: 1,
  });
});
