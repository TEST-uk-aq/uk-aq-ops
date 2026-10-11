import assert from "node:assert/strict";
import test from "node:test";
import { admitPruneFrozenConnectorSnapshot, PruneCommittedHistoryGuardError } from "../workers/uk_aq_prune_daily/committed_history_guard.mjs";
import { writeFrozenCandidateObservationsToV2ForTest, createPhaseBRunBudgetForTest } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { computeObservationContentHash } from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildHistoryV2ConnectorManifest, buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest, buildHistoryV2DayManifestKey,
  buildHistoryV2PollutantManifest, buildHistoryV2PollutantManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest, buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest, buildR2HistoryV2ObservationsYearManifestKey,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";

const prefix = "history/v3/observations";
const dayUtc = "2026-07-21";
const connectorId = 7;
const time = "2026-07-21T00:00:00.000Z";
const row = (code, id, value = 12.5) => ({
  connector_id: connectorId, station_id: 71, timeseries_id: id,
  pollutant_code: code, observed_at_utc: time, value,
  verification_status: null,
});
const getObjectFrom = (objects) => async ({ key }) => {
  if (!objects.has(key)) throw Object.assign(new Error(`R2 GET failed (404) key=${key}`), { status: 404 });
  return { body: Buffer.from(JSON.stringify(objects.get(key))) };
};

function history(rows) {
  const objects = new Map();
  const byCode = Map.groupBy(rows, (entry) => entry.pollutant_code);
  const pollutants = [...byCode].map(([code, partition]) => {
    const key = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, code);
    const hash = computeObservationContentHash(partition);
    const value = buildHistoryV2PollutantManifest({
      domain: "observations", dayUtc, connectorId, pollutantCode: code,
      manifestKey: key, sourceRowCount: partition.length,
      observationContentHash: hash, fileEntries: [{
        key: key.replace("manifest.json", "part-00000.parquet"),
        row_count: partition.length, bytes: 100, etag_or_hash: "a".repeat(64),
        min_timeseries_id: Math.min(...partition.map((entry) => entry.timeseries_id)),
        max_timeseries_id: Math.max(...partition.map((entry) => entry.timeseries_id)),
        min_observed_at_utc: time, max_observed_at_utc: time,
      }], writerGitSha: "a".repeat(40), backedUpAtUtc: time,
    });
    objects.set(key, value);
    return value;
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(prefix, dayUtc, connectorId);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId, manifestKey: connectorKey,
    pollutantManifests: pollutants, writerGitSha: "a".repeat(40), backedUpAtUtc: time,
  });
  objects.set(connectorKey, connector);
  const dayKey = buildHistoryV2DayManifestKey(prefix, dayUtc);
  const day = buildHistoryV2DayManifest({
    domain: "observations", dayUtc, manifestKey: dayKey,
    connectorManifests: [connector], writerGitSha: "a".repeat(40), backedUpAtUtc: time,
  });
  objects.set(dayKey, day);
  const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(prefix, 2026, "07");
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: prefix, year: 2026, month: "07", dayManifests: [day] });
  objects.set(monthKey, month);
  const yearKey = buildR2HistoryV2ObservationsYearManifestKey(prefix, 2026);
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: prefix, year: 2026, monthManifests: [{ ...month, manifest_key: monthKey }] });
  objects.set(yearKey, year);
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  objects.set(rootKey, buildR2HistoryV2ObservationsRootManifest({ basePrefix: prefix, yearManifests: [{ ...year, manifest_key: yearKey }] }));
  return { objects, connector, connectorKey, monthKey, yearKey, rootKey };
}

const admit = (objects, rows) => admitPruneFrozenConnectorSnapshot({
  r2: {}, observationsPrefix: prefix, dayUtc, connectorId, rows, getObject: getObjectFrom(objects),
});

test("first publication ignores unreferenced connector objects and can reach writer", async () => {
  const old = history([row("pm25", 101)]);
  const objects = new Map([[old.connectorKey, old.connector]]);
  assert.equal((await admit(objects, [row("pm25", 102)])).admission, "first_publication");
  let writes = 0;
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST", writer_git_sha: "a".repeat(40),
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity: {} },
    readFrozenRows: async function* () { yield row("pm25", 102); },
    admitSnapshot: ({ rows }) => admit(objects, rows),
    connectorPublisher: async () => { writes++; return { file_count: 1, total_bytes: 100n }; },
    cleanupFrozenSource: () => {},
  });
  assert.equal(writes, 1);
  assert.equal(result.source_row_count, 1n);
});

test("a prior committed 100-row connector blocks a one-row late snapshot before writer invocation", async () => {
  const old = history(Array.from({ length: 100 }, (_, i) => ({ ...row("pm25", 101, i), observed_at_utc: new Date(Date.parse(time) + i * 60000).toISOString() })));
  let writes = 0;
  await assert.rejects(admit(old.objects, [row("pm25", 101, 101)]), (error) => {
    assert.ok(error instanceof PruneCommittedHistoryGuardError);
    assert.match(error.message, /connector=7 day_utc=2026-07-21/);
    assert.match(error.previous_authority, new RegExp(old.connector.manifest_hash));
    return true;
  });
  await assert.rejects(writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST", writer_git_sha: "a".repeat(40),
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity: {} },
    readFrozenRows: async function* () { yield row("pm25", 101, 101); },
    admitSnapshot: ({ rows }) => admit(old.objects, rows),
    connectorPublisher: async () => { writes++; },
    cleanupFrozenSource: () => {},
  }), { code: "PRUNE_COMMITTED_HISTORY_REPLACEMENT_BLOCKED" });
  assert.equal(writes, 0);
});

test("pollutant omission and same-count changed content both block, identical content admits retry", async () => {
  const prior = [row("pm25", 101), row("no2", 201)];
  const old = history(prior);
  await assert.rejects(admit(old.objects, [row("pm25", 101, 13)]), /pollutant child set differs/);
  await assert.rejects(admit(old.objects, [row("pm25", 101, 13), row("no2", 201)]), /frozen observations differ/);
  assert.equal((await admit(old.objects, prior)).admission, "identical_committed_content_retry");
});

test("overwritten parent and child objects fail closed; unreferenced child does not establish authority", async () => {
  const old = history([row("pm25", 101)]);
  old.objects.set(old.monthKey, { ...old.objects.get(old.monthKey), content_hash: "0".repeat(64) });
  await assert.rejects(admit(old.objects, [row("pm25", 101)]), /content_hash mismatch/);
  const changedChild = history([row("pm25", 101, 13)]);
  const childKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, "pm25");
  const intactParent = history([row("pm25", 101)]);
  intactParent.objects.set(childKey, changedChild.objects.get(childKey));
  await assert.rejects(admit(intactParent.objects, [row("pm25", 101)]), /identity disagrees/);
  const orphan = history([row("pm25", 101)]);
  orphan.objects.delete(orphan.rootKey);
  assert.equal((await admit(orphan.objects, [row("pm25", 102)])).admission, "first_publication");
});
