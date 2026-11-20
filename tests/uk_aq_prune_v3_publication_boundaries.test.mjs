import assert from "node:assert/strict";
import test from "node:test";
import { publishApprovedLatest, verifyAddOnlyLatestDiff } from "../scripts/operations/uk_aq_repair_observation_history_v3_latest.mjs";
import { r2PutObjectConditional, sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY as latestKey,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT as indexRoot,
  latestArtifactFromRoots,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { createV3ParentPublicationBatch } from "../workers/uk_aq_prune_daily/v3_parent_publication_batch.mjs";
import { createPhaseBRunBudgetForTest } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { createWorkerBudget } from "../workers/uk_aq_prune_daily/worker_budget.mjs";
import { ORIGINAL_OPERATION_ASSERTION_MAX_MS } from "../scripts/operations/lib/uk_aq_prune_original_operation.mjs";
import { R2_PUBLICATION_SAFETY_MARGIN_MS, R2_REQUEST_WORST_CASE_DURATION_MS } from "../workers/shared/r2_sigv4.mjs";

const dayUtc = "2026-06-01";
function scope(connectorId, day = dayUtc) {
  return { day_utc: day, connector_id: connectorId, pollutant_code: "no2",
    key: `${indexRoot}/day_utc=${day}/connector_id=${connectorId}/pollutant_code=no2/manifest.json`,
    byte_size: 12, sha256: sha256Hex(`${day}/${connectorId}`), row_count: 7,
    timeseries_count: 1, child_shard_count: 1, physical_leaf_count: 1, physical_file_count: 1,
    min_observed_at_utc: `${day}T00:00:00.000Z`, max_observed_at_utc: `${day}T06:00:00.000Z` };
}

function latest(roots) {
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latestArtifactFromRoots(roots, indexRoot, latestKey) });
}

test("approved repair preserves all existing scopes and sends only a conditional latest PUT", async () => {
  const sameDay = scope(2);
  const otherDay = scope(1, "2026-06-02");
  const selected = scope(1);
  const before = latest([sameDay, otherDay]);
  const after = latest([selected, sameDay, otherDay]);
  assert.equal(verifyAddOnlyLatestDiff(before, after, [selected], dayUtc, 1).added_row_count, 7);
  assert.throws(() => verifyAddOnlyLatestDiff(before, latest([selected, { ...sameDay, row_count: 8 }, otherDay]),
    [selected], dayUtc, 1), /Existing registry entry changed/);

  const original = Buffer.from(before.artifact.body);
  const proposed = after.artifact;
  const plan = { day_utc: dayUtc, connector_id: 1, backup_key: "backup", predecessor: { ...before.artifact, etag: '"original"' } };
  const approvedPlanSha = "plan";
  const verified = { plan, planSha: approvedPlanSha, before, proposed, scopes: [selected], recheck: async () => {} };
  let backupBody = Buffer.from("incorrect backup");
  let current = original;
  let status = 412;
  const writes = [];
  const options = { verified, approvedPlanSha, assertOwned: async () => {}, onAttempt() {},
    getObject: async ({ key }) => {
      const body = key === plan.backup_key ? backupBody : current;
      return { key, body, bytes: body.length, etag: '"stored"' };
    },
    putConditional: args => r2PutObjectConditional({ ...args, r2: { adapter: {
      putObjectConditional: async mutation => {
        writes.push(mutation);
        if (status === 200) current = mutation.body;
        return { status, etag: '"published"' };
      },
    } } }),
  };
  await assert.rejects(publishApprovedLatest({ ...options, approvedPlanSha: "different" }), /differs from the approved plan/);
  await assert.rejects(publishApprovedLatest(options), /Durable backup does not match/);
  assert.equal(writes.length, 0);
  backupBody = original;
  await assert.rejects(publishApprovedLatest(options), { code: "R2_PRECONDITION_FAILED" });
  assert.equal(writes.length, 1);
  assert.deepEqual(current, original);
  status = 200;
  const applied = await publishApprovedLatest(options);
  assert.equal(applied.sha256, proposed.sha256);
  assert.deepEqual(writes.map(({ key, if_match }) => [key, if_match]), [[latestKey, '"original"'], [latestKey, '"original"']]);
});

function parentPublicationFixture({ unchanged = false, loseLock = false, phaseBudget } = {}) {
  const parentKeys = ["day", "month", "year", "root"];
  const stored = new Map([...parentKeys, latestKey].map(key => [key, Buffer.from(`old ${key}`)]));
  const writes = [];
  const reads = [];
  const verifiedKeys = [];
  const budgets = [];
  const put = async ({ key, body }) => { writes.push(key); stored.set(key, body); };
  let allowance = Infinity;
  const batch = createV3ParentPublicationBatch({ parentKeys, latestKey,
    getObject: async ({ key }) => { reads.push(key); return { key, body: stored.get(key) }; },
    putIfChanged: async object => {
      await put(object);
      return { key: object.key, byte_size: object.byte_size, sha256: object.sha256,
        status: "succeeded", verified: true, post_put_get_verified: true };
    },
    putObject: put,
    assertOwned: async () => { if (loseLock && writes.length) throw new Error("original lock lost"); },
    admit: (requests, locks) => {
      budgets.push([requests, locks]);
      if (phaseBudget && phaseBudget.now_ms() + requests * R2_REQUEST_WORST_CASE_DURATION_MS
        + locks * ORIGINAL_OPERATION_ASSERTION_MAX_MS + R2_PUBLICATION_SAFETY_MARGIN_MS >= phaseBudget.deadline_ms) {
        throw new Error("stopped_budget");
      }
      if (requests > allowance) throw new Error("stopped_budget");
    },
    log: (event, fields) => { if (event === "parent_verified") verifiedKeys.push(fields.key); },
  });
  const artifact = key => {
    const body = Buffer.from(`${unchanged ? "old" : "new"} ${key}`);
    return { key, body, byte_size: body.length, sha256: sha256Hex(body) };
  };
  const prepare = async () => {
    for (const key of [...parentKeys, latestKey]) await batch.getObject({ key });
    await batch.putIfChanged(artifact("day"));
    // Unchanged aggregates are already suppressed by the hierarchy planner.
    if (!unchanged) for (const key of parentKeys.slice(1)) await batch.putObject(artifact(key));
    for (const key of parentKeys) assert.deepEqual((await batch.getObject({ key })).body, artifact(key).body);
  };
  return { batch, artifact, prepare, parentKeys, stored, writes, reads, verifiedKeys, budgets,
    setAllowance: value => { allowance = value; } };
}

test("startup and Phase A consume the all-changed parent/latest allowance before the first parent PUT", async () => {
  const launch = 100_000;
  let now = launch + 300_000;
  const workerBudget = createWorkerBudget(launch, () => now);
  const phaseBudget = createPhaseBRunBudgetForTest({ nowMs: workerBudget.nowMs, workerBudget });
  assert.equal(phaseBudget.limiting_clock, "worker_wide");
  assert.equal(phaseBudget.elapsed_worker_before_phase_b_ms, 300_010);
  assert.equal(phaseBudget.local_deadline_ms - phaseBudget.deadline_ms, 300_010);
  const fixture = parentPublicationFixture({ phaseBudget });
  await fixture.prepare();
  now = workerBudget.deadlineMs - 1_635_500 - 10;
  await assert.rejects(fixture.batch.publishParents(fixture.artifact(latestKey)), /stopped_budget/);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.budgets, [[13, 5]]);
  assert.equal(fixture.batch.lastVerified, null);
});

test("v3 preparation reaches complete batch admission before the first parent PUT", async () => {
  const f = parentPublicationFixture();
  await f.prepare();
  f.setAllowance(12);
  await assert.rejects(f.batch.publishParents(f.artifact(latestKey)), /stopped_budget/);
  assert.deepEqual(f.budgets, [[13, 5]]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.verifiedKeys, []);
  assert.deepEqual(f.parentKeys.map(key => f.stored.get(key).toString()), f.parentKeys.map(key => `old ${key}`));

  f.setAllowance(13);
  f.reads.length = 0;
  await f.batch.publishParents(f.artifact(latestKey));
  assert.deepEqual(f.reads, [...f.parentKeys, latestKey, "month", "year", "root"]);
  const result = await f.batch.putIfChanged(f.artifact(latestKey));
  await f.batch.finishLatest({ ok: true, objects: [{ ...result, durable: true }] });
  assert.deepEqual(f.writes, [...f.parentKeys, latestKey]);
  assert.deepEqual(f.verifiedKeys, f.parentKeys);
  assert.equal(f.batch.lastVerified, latestKey);
});

test("exact unchanged parents and latest avoid PUT and keep live latest verification", async () => {
  const f = parentPublicationFixture({ unchanged: true });
  await f.prepare();
  f.reads.length = 0;
  await f.batch.publishParents(f.artifact(latestKey));
  const result = await f.batch.putIfChanged(f.artifact(latestKey));
  assert.equal(result.status, "skipped_unchanged");
  assert.equal(result.post_put_get_verified, true);
  // The real finaliser performs this independent durability GET after the
  // adapter has verified the unchanged latest on the origin.
  await f.batch.getObject({ key: latestKey });
  await f.batch.finishLatest({ ok: true, objects: [{ ...result, durable: true }] });
  assert.deepEqual(f.budgets, [[2, 1]]);
  assert.deepEqual(f.reads, [...f.parentKeys, latestKey, latestKey, latestKey]);
  assert.deepEqual(f.writes, []);
});

test("v3 batch fails closed on a changed predecessor or original lock loss between writes", async () => {
  const drifted = parentPublicationFixture();
  await drifted.prepare();
  drifted.stored.set("month", Buffer.from("changed month"));
  await assert.rejects(drifted.batch.publishParents(drifted.artifact(latestKey)), /predecessor changed/);
  assert.deepEqual(drifted.writes, []);

  const inconsistent = parentPublicationFixture();
  await inconsistent.batch.getObject({ key: "month" });
  inconsistent.stored.set("month", Buffer.from("transiently changed month"));
  await assert.rejects(inconsistent.batch.getObject({ key: "month" }), /changed during preparation/);
  inconsistent.stored.set("month", Buffer.from("old month"));
  await assert.rejects(inconsistent.batch.publishParents(inconsistent.artifact(latestKey)), /changed during preparation/);
  assert.deepEqual(inconsistent.writes, []);

  const interrupted = parentPublicationFixture({ loseLock: true });
  await interrupted.prepare();
  await assert.rejects(interrupted.batch.publishParents(interrupted.artifact(latestKey)), /original lock lost/);
  assert.deepEqual(interrupted.writes, ["day"]);
  assert.equal(interrupted.batch.lastVerified, "day");
  await assert.rejects(interrupted.batch.putIfChanged(interrupted.artifact(latestKey)), /outside the admitted/);
});
