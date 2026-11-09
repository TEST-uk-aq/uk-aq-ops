import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAtomicConnectorDayDeletionPlan,
  classifyObsAqidbRpcWriteWindow,
  compareBuckets,
  repairableWithinObsAqidbWriteWindow,
  upsertObservsRowsChunk,
} from "../workers/uk_aq_prune_daily/server.mjs";

const NOW = "2026-11-09T12:00:00.000Z";

function bucket(hour, connector = "7", fingerprint = "source") {
  return {
    key: `${connector}|${hour}`,
    connector_id: connector,
    hour_start: hour,
    min_observed_at: hour,
    max_observed_at: hour,
    observation_count: 2n,
    fingerprint,
  };
}

test("RPC comparison uses UTC calendar midnights and reclassifies at midnight", () => {
  const lastExpired = bucket("2026-11-05T23:00:00.000Z");
  const firstRequired = bucket("2026-11-06T00:00:00.000Z");
  const lastRequired = bucket("2026-11-09T23:00:00.000Z");
  const firstFuture = bucket("2026-11-10T00:00:00.000Z");
  assert.equal(classifyObsAqidbRpcWriteWindow(lastExpired, NOW), "comparison_exempt_expired");
  assert.equal(classifyObsAqidbRpcWriteWindow(firstRequired, NOW), "comparison_required");
  assert.equal(classifyObsAqidbRpcWriteWindow(lastRequired, NOW), "comparison_required");
  assert.equal(classifyObsAqidbRpcWriteWindow(firstFuture, NOW), "blocked_uncertain");
  assert.equal(classifyObsAqidbRpcWriteWindow(firstRequired, "2026-11-10T00:00:00.000Z"), "comparison_exempt_expired");
  assert.equal(compareBuckets([firstRequired], [], "2026-11-09T23:59:59.999Z").mismatches.length, 1);
  const afterMidnight = compareBuckets([firstRequired], [], "2026-11-10T00:00:00.000Z");
  assert.equal(afterMidnight.mismatches.length, 0);
  assert.equal(afterMidnight.deletableBuckets[0].comparison_status, "comparison_exempt_expired");
  assert.equal(classifyObsAqidbRpcWriteWindow(firstRequired, "invalid"), "blocked_uncertain");
  assert.equal(classifyObsAqidbRpcWriteWindow({ ...firstRequired, min_observed_at: "bad" }, NOW), "blocked_uncertain");
});

test("expired missing ObsAQIDB hour stays in the complete plan only with valid gate evidence", () => {
  const expired = bucket("2026-11-05T23:00:00.000Z");
  const required = bucket("2026-11-06T00:00:00.000Z");
  const comparison = compareBuckets([expired, required], [required], NOW);
  assert.equal(comparison.comparisonRequiredCount, 1);
  assert.deepEqual(comparison.comparisonExemptBuckets, [{ connector_id: "7", hour_start: expired.hour_start }]);
  assert.equal(comparison.deletableBuckets[0].comparison_status, "comparison_exempt_expired");
  assert.equal(comparison.deletableBuckets[1].comparison_status, "comparison_required");
  const allowed = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [expired], eligibleBuckets: [comparison.deletableBuckets[0]],
  });
  assert.equal(allowed.plannedBuckets.length, 1);
  assert.equal(allowed.connectorDays[0].connector_day_atomic_delete_planned, true);
  const blocked = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [expired], eligibleBuckets: [comparison.deletableBuckets[0]],
    gateBlockedBuckets: [expired],
  });
  assert.equal(blocked.plannedBuckets.length, 0);
  assert.equal(blocked.blockedBuckets.length, 1);
});

test("an unresolved required mismatch blocks every hour of the connector-day", () => {
  const matched = bucket("2026-11-06T00:00:00.000Z");
  const required = bucket("2026-11-06T01:00:00.000Z");
  const comparison = compareBuckets([matched, required], [matched], NOW);
  assert.equal(comparison.mismatches.length, 1);
  assert.equal(comparison.mismatches[0].reason, "missing_in_observs");
  const plan = buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [matched, required], eligibleBuckets: comparison.deletableBuckets,
    unresolvedBuckets: comparison.mismatches,
  });
  assert.equal(plan.plannedBuckets.length, 0);
  assert.equal(plan.blockedBuckets.length, 2);
  assert.equal(repairableWithinObsAqidbWriteWindow(comparison.mismatches, [matched, required], NOW).length, 1);
  assert.equal(repairableWithinObsAqidbWriteWindow(comparison.mismatches, [matched, required], "2026-11-10T00:00:00.000Z").length, 0);
  const afterRepair = compareBuckets([matched, required], [matched, required], NOW);
  assert.equal(afterRepair.mismatches.length, 0);
  assert.equal(buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [matched, required], eligibleBuckets: afterRepair.deletableBuckets,
  }).plannedBuckets.length, 2);
});

test("future or invalid canonical hours block the complete connector-day", () => {
  const valid = bucket("2026-11-09T01:00:00.000Z");
  const future = bucket("2026-11-09T02:00:00.000Z");
  future.min_observed_at = "2026-11-10T00:00:00.000Z";
  const comparison = compareBuckets([valid, future], [valid], NOW);
  assert.equal(comparison.blockedUncertainBuckets.length, 1);
  assert.equal(buildAtomicConnectorDayDeletionPlan({
    currentBuckets: [valid, future], eligibleBuckets: comparison.deletableBuckets,
    unresolvedBuckets: comparison.mismatches,
  }).plannedBuckets.length, 0);
});

test("repair upsert never calls ObsAQIDB for expired or future observations", async () => {
  let calls = 0;
  const client = { schema() { return { rpc() { calls += 1; return { data: { observations_upserted: 1 }, error: null }; } }; } };
  const row = (observed_at) => ({ observed_at });
  await assert.rejects(upsertObservsRowsChunk(client, [row("2026-10-25T01:00:00.000Z")], NOW), /write window expired or uncertain/);
  await assert.rejects(upsertObservsRowsChunk(client, [row("2026-11-11T01:00:00.000Z")], NOW), /write window expired or uncertain/);
  assert.equal(calls, 0);
  assert.equal(await upsertObservsRowsChunk(client, [row("2026-11-08T01:00:00.000Z")], NOW), 1);
  assert.equal(calls, 1);
});
