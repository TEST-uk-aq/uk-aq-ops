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

test("v3 preparation reaches complete batch admission before the first parent PUT", async () => {
  const parentKeys = ["day", "month", "year", "root"];
  let remainingRequestAllowance = 13;
  const stored = new Map([...parentKeys, latestKey].map(key => [key, Buffer.from(`old ${key}`)]));
  const verifiedKeys = [];
  const writes = [];
  const put = async ({ key, body }) => { writes.push(key); stored.set(key, body); };
  const batch = createV3ParentPublicationBatch({ parentKeys, latestKey,
    getObject: async ({ key }) => ({ key, body: stored.get(key) }), putIfChanged: put, putObject: put,
    assertOwned: async () => {},
    admit: count => {
      assert.equal(count, 14);
      if (count > remainingRequestAllowance) throw new Error("stopped_budget");
    },
    log: (event, fields) => { if (event === "parent_verified") verifiedKeys.push(fields.key); },
  });
  for (const key of [...parentKeys, latestKey]) await batch.getObject({ key });
  await batch.putIfChanged({ key: "day", body: Buffer.from("new day") });
  for (const key of parentKeys.slice(1)) await batch.putObject({ key, body: Buffer.from(`new ${key}`) });
  for (const key of parentKeys) assert.equal((await batch.getObject({ key })).body.toString(), `new ${key}`);
  await assert.rejects(batch.publishParents({ key: latestKey }), /stopped_budget/);
  assert.deepEqual(writes, []);
  assert.deepEqual(parentKeys.map(key => stored.get(key).toString()), parentKeys.map(key => `old ${key}`));
  remainingRequestAllowance = 14;
  await batch.publishParents({ key: latestKey });
  await batch.putIfChanged({ key: latestKey, body: Buffer.from("new latest") });
  assert.deepEqual(writes, [...parentKeys, latestKey]);
  assert.deepEqual(verifiedKeys, parentKeys);
});
