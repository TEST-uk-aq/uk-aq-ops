import assert from "node:assert/strict";
import {
  evaluateLatestCurrentValue,
} from "./latest_value_policy.mjs";
import {
  applyEligibleRowsToLatestState,
  latestStateKey,
  serializeLatestState,
} from "./latest_state_core.mjs";

type Candidate = {
  ackId: string;
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  matrixPollutant: string | null;
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    ackId: "ack-1",
    connector_id: 10,
    timeseries_id: 101,
    observed_at: "2026-07-16T10:00:00.000Z",
    value: 20,
    matrixPollutant: "pm25",
    ...overrides,
  };
}

function applyDecodedCandidates(
  state: Map<string, Record<string, unknown>>,
  candidates: Candidate[],
  ingestedAt: string,
) {
  const acknowledgementIds = candidates.map((row) => row.ackId);
  const eligibleRows = candidates.flatMap((row) => {
    const decision = evaluateLatestCurrentValue({
      matrixPollutant: row.matrixPollutant,
      value: row.value,
    });
    if (!decision.eligible || typeof row.value !== "number") return [];
    return [{
      connector_id: row.connector_id,
      timeseries_id: row.timeseries_id,
      observed_at: row.observed_at,
      value: row.value,
      value_float8_hex: null,
      status: null,
    }];
  });
  return {
    acknowledgementIds,
    eligibleRows,
    stateApply: applyEligibleRowsToLatestState(state, eligibleRows, ingestedAt),
  };
}

Deno.test("latest-state current-value policy prevents invalid transitions and preserves valid ordering", () => {
  const state = new Map<string, Record<string, unknown>>();
  const initial = candidate({ value: 18, observed_at: "2026-07-16T09:00:00.000Z" });
  const initialResult = applyDecodedCandidates(state, [initial], "2026-07-16T09:01:00.000Z");
  assert.equal(initialResult.stateApply.applied_new, 1);

  const invalidThenNewer = applyDecodedCandidates(state, [
    candidate({ ackId: "ack-invalid", value: -99, observed_at: "2026-07-16T10:00:00.000Z" }),
    candidate({ ackId: "ack-valid", value: 21, observed_at: "2026-07-16T11:00:00.000Z" }),
  ], "2026-07-16T11:01:00.000Z");
  assert.deepEqual(invalidThenNewer.acknowledgementIds, ["ack-invalid", "ack-valid"]);
  assert.equal(invalidThenNewer.eligibleRows.length, 1);
  assert.equal(invalidThenNewer.stateApply.applied_newer, 1);
  assert.equal(state.get(latestStateKey(10, 101))?.value, 21);

  const zero = applyDecodedCandidates(new Map(), [candidate({ value: 0 })], "2026-07-16T10:01:00.000Z");
  assert.equal(zero.stateApply.applied_new, 1);

  assert.equal(evaluateLatestCurrentValue({ matrixPollutant: "pm25", value: 500.01 }).eligible, false);
  assert.equal(evaluateLatestCurrentValue({ matrixPollutant: "pm10", value: 600.01 }).eligible, false);
  assert.equal(evaluateLatestCurrentValue({ matrixPollutant: "no2", value: -1 }).eligible, false);
  assert.equal(evaluateLatestCurrentValue({ matrixPollutant: "o3", value: 20 }).eligible, false);
});

Deno.test("an invalid-only batch leaves the persisted latest state unchanged", () => {
  const originalUpdatedAt = "2026-07-16T09:01:00.000Z";
  const originalIngestedAt = "2026-07-16T09:01:00.000Z";
  const state = new Map<string, Record<string, unknown>>([[
    latestStateKey(10, 101),
    {
      connector_id: 10,
      timeseries_id: 101,
      observed_at: "2026-07-16T09:00:00.000Z",
      value: 18,
      value_float8_hex: null,
      status: null,
      ingested_at: originalIngestedAt,
    },
  ]]);
  const before = serializeLatestState(state, originalUpdatedAt);

  const invalidOnly = applyDecodedCandidates(state, [
    candidate({ ackId: "ack-null", value: null, observed_at: "2026-07-16T10:00:00.000Z" }),
    candidate({ ackId: "ack-negative", value: -99, observed_at: "2026-07-16T10:01:00.000Z" }),
    candidate({ ackId: "ack-unknown", matrixPollutant: null, observed_at: "2026-07-16T10:02:00.000Z" }),
  ], "2026-07-16T10:03:00.000Z");
  const stateTransitionCount = invalidOnly.stateApply.applied_new + invalidOnly.stateApply.applied_newer;
  const after = stateTransitionCount > 0
    ? serializeLatestState(state, "2026-07-16T10:03:00.000Z")
    : before;

  assert.equal(stateTransitionCount, 0);
  assert.deepEqual(invalidOnly.acknowledgementIds, ["ack-null", "ack-negative", "ack-unknown"]);
  assert.equal(after, before);
  assert.equal(state.get(latestStateKey(10, 101))?.ingested_at, originalIngestedAt);
});
