import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAtomicConnectorDayDeletionPlan,
  classifyObsAqidbRpcWriteWindow,
  compareBuckets,
  fetchPruneFingerprintWindow,
  fetchRequiredObsAqidbFingerprints,
  recheckCompleteConnectorDays,
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

function rpcClient(rows, calls, error = null) {
  return {
    schema() {
      return { rpc(name, { window_start, window_end }) {
        calls.push({ name, window_start, window_end });
        if (error) return { data: null, error: { message: error } };
        return { data: rows.filter((row) => row.hour_start >= window_start && row.hour_start < window_end)
          .map((row) => ({ ...row, observation_count: row.observation_count.toString() })), error: null };
      } };
    },
  };
}

test("expired connector-day uses zero ObsAQIDB fingerprint RPCs at initial and complete recheck", async () => {
  const expired = bucket("2026-11-05T23:00:00.000Z");
  const ingestCalls = [];
  const observsCalls = [];
  const ingest = rpcClient([expired], ingestCalls);
  const observs = rpcClient([], observsCalls, "ObsAQIDB unavailable");
  const initial = await fetchPruneFingerprintWindow(
    ingest, observs, "2026-11-05T23:00:00.000Z", "2026-11-06T00:00:00.000Z", null, () => NOW,
  );
  const final = await recheckCompleteConnectorDays(ingest, observs, initial.ingestBuckets, null, () => NOW);
  assert.equal(ingestCalls.length, 2);
  assert.equal(observsCalls.length, 0);
  assert.equal(final.finalIngestBuckets.length, 1);
  assert.equal(final.mismatches.length, 0);
  assert.equal(final.deletableBuckets[0].comparison_status, "comparison_exempt_expired");
  assert.equal(buildAtomicConnectorDayDeletionPlan({
    currentBuckets: final.finalIngestBuckets, eligibleBuckets: final.deletableBuckets,
  }).plannedBuckets.length, 1);
  assert.equal(buildAtomicConnectorDayDeletionPlan({
    currentBuckets: final.finalIngestBuckets, eligibleBuckets: final.deletableBuckets,
    gateBlockedBuckets: [expired],
  }).plannedBuckets.length, 0);
});

test("mixed processing window queries only the required hour and required failure blocks", async () => {
  // Valid UTC hours in a single connector-day share one write-window class;
  // this bounded processing window spans the UTC boundary between two days.
  const expired = bucket("2026-11-05T23:00:00.000Z");
  const required = bucket("2026-11-06T00:00:00.000Z");
  const calls = [];
  const rows = await fetchRequiredObsAqidbFingerprints(
    rpcClient([required], calls), [expired, required], "observs", null, () => NOW,
  );
  assert.deepEqual(calls.map(({ window_start, window_end }) => [window_start, window_end]), [
    [required.hour_start, "2026-11-06T01:00:00.000Z"],
  ]);
  assert.equal(rows.length, 1);
  const failedCalls = [];
  await assert.rejects(fetchRequiredObsAqidbFingerprints(
    rpcClient([], failedCalls, "required hour unavailable"), [expired, required], "observs", null, () => NOW,
  ), /required hour unavailable/);
  assert.equal(failedCalls.length, 1);
  await assert.rejects(fetchPruneFingerprintWindow(
    rpcClient([required], []), rpcClient([], [], "required hour unavailable"),
    required.hour_start, "2026-11-06T01:00:00.000Z", null, () => NOW,
  ), /required hour unavailable/);
  await assert.rejects(recheckCompleteConnectorDays(
    rpcClient([required], []), rpcClient([], [], "required hour unavailable"),
    [required], null, () => NOW,
  ), /required hour unavailable/);
});

test("midnight expiry suppresses a pending ObsAQIDB read and uncertain hours stay blocked", async () => {
  const firstRequired = bucket("2026-11-06T00:00:00.000Z");
  const calls = [];
  const times = ["2026-11-09T23:59:59.999Z", "2026-11-10T00:00:00.000Z"];
  const rows = await fetchRequiredObsAqidbFingerprints(
    rpcClient([], calls, "unavailable"), [firstRequired], "observs", null,
    () => times.shift() ?? "2026-11-10T00:00:00.000Z",
  );
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 0);
  const failedCalls = [];
  const timesDuringFailure = [
    "2026-11-09T23:59:59.999Z", "2026-11-09T23:59:59.999Z", "2026-11-10T00:00:00.000Z",
  ];
  assert.deepEqual(await fetchRequiredObsAqidbFingerprints(
    rpcClient([], failedCalls, "expired during RPC"), [firstRequired], "observs", null,
    () => timesDuringFailure.shift() ?? "2026-11-10T00:00:00.000Z",
  ), []);
  assert.equal(failedCalls.length, 1);
  const uncertain = { ...firstRequired, max_observed_at: "invalid" };
  assert.equal(compareBuckets([uncertain], [], NOW).blockedUncertainBuckets.length, 1);
  await fetchRequiredObsAqidbFingerprints(rpcClient([], calls), [uncertain], "observs", null, () => NOW);
  assert.equal(calls.length, 0);
});

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
