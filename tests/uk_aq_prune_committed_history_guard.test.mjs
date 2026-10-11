import assert from "node:assert/strict";
import test from "node:test";
import { admitPruneFrozenConnectorSnapshot, PruneCommittedHistoryGuardError } from "../workers/uk_aq_prune_daily/committed_history_guard.mjs";
import { writeFrozenCandidateObservationsToV2ForTest, createPhaseBRunBudgetForTest } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { computeObservationContentHash } from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { encodeObservationHistoryIndexV3Json } from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { OBSERVATION_HISTORY_SCHEMA_VERSION_V3, OBSERVATION_HISTORY_WRITER_VERSION_V3 } from "../workers/shared/uk_aq_observation_history_schema.mjs";
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION, OBSERVATION_HISTORY_ALIGNED_ROW_CAP, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION } from "../workers/shared/uk_aq_observation_history_target_writer.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
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
  const value = objects.get(key);
  return { body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, key.includes("/day_utc=") ? 2 : undefined)) };
};

function history(rows, fixtureConnectorId = connectorId) {
  const objects = new Map();
  const byCode = Map.groupBy(rows, (entry) => entry.pollutant_code);
  const pollutants = [...byCode].map(([code, partition]) => {
    const key = buildHistoryV2PollutantManifestKey(prefix, dayUtc, fixtureConnectorId, code);
    const hash = computeObservationContentHash(partition);
    const value = buildHistoryV2PollutantManifest({
      domain: "observations", dayUtc, connectorId: fixtureConnectorId, pollutantCode: code,
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
  const connectorKey = buildHistoryV2ConnectorManifestKey(prefix, dayUtc, fixtureConnectorId);
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations", dayUtc, connectorId: fixtureConnectorId, manifestKey: connectorKey,
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
  const scopedRoots = pollutants.map((pollutant) => {
    const scope = `day_utc=${dayUtc}/connector_id=${fixtureConnectorId}/pollutant_code=${pollutant.pollutant_code}`;
    const alignedKey = `${DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT}/_aligned/${scope}/manifest.json`;
    const pollutantBody = Buffer.from(JSON.stringify(pollutant, null, 2));
    const alignedBody = Buffer.from(encodeObservationHistoryIndexV3Json({
      kind: "observation_timeseries_aligned_source_manifest", index_generation: "v3", history_version: "v2",
      day_utc: dayUtc, connector_id: fixtureConnectorId, pollutant_code: pollutant.pollutant_code,
      canonical_source_manifest: {
        key: pollutant.manifest_key, byte_size: pollutantBody.length, sha256: sha256Hex(pollutantBody),
        manifest_hash: pollutant.manifest_hash, row_count: pollutant.row_count,
        observation_content_hash: pollutant.observation_content_hash,
      },
    }));
    objects.set(alignedKey, alignedBody);
    const scopedKey = `${DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT}/${scope}/manifest.json`;
    const scopedBody = Buffer.from(encodeObservationHistoryIndexV3Json({
      kind: "observation_timeseries_physical_leaf_scoped_manifest", index_generation: "v3", history_version: "v2",
      day_utc: dayUtc, connector_id: fixtureConnectorId, pollutant_code: pollutant.pollutant_code,
      source_aligned_scoped_manifest: { key: alignedKey, byte_size: alignedBody.length, sha256: sha256Hex(alignedBody) },
      coverage: { row_count: pollutant.row_count },
    }));
    objects.set(scopedKey, scopedBody);
    return {
      day_utc: dayUtc, connector_id: fixtureConnectorId, pollutant_code: pollutant.pollutant_code,
      key: scopedKey, byte_size: scopedBody.length, sha256: sha256Hex(scopedBody),
      row_count: pollutant.row_count, timeseries_count: 1, child_shard_count: 1,
      physical_leaf_count: 1, physical_file_count: 1,
      min_observed_at_utc: time, max_observed_at_utc: time,
    };
  }).sort((a, b) => a.pollutant_code.localeCompare(b.pollutant_code));
  const indexRoot = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT;
  const latestKey = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY;
  const latestPayload = {
    schema_version: 3, kind: "observation_timeseries_latest_global", index_generation: "v3",
    history_version: "v2", domain: "observations",
    history_schema_version: OBSERVATION_HISTORY_SCHEMA_VERSION_V3,
    writer_version: OBSERVATION_HISTORY_WRITER_VERSION_V3,
    physical_layout_version: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
    aligned_row_cap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
    exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
    index_root: indexRoot, min_day_utc: dayUtc, max_day_utc: dayUtc,
    day_count: 1, scoped_root_count: scopedRoots.length, child_shard_count: scopedRoots.length,
    physical_leaf_count: scopedRoots.length, physical_file_reference_count: scopedRoots.length,
    total_rows: rows.length, days: [dayUtc],
    key_layout: {
      scoped_manifest_key_template: `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}/manifest.json`,
      exact_leaf_key_template: `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}/timeseries_id={timeseries_id_9}.json`,
      aligned_source_index_root: `${indexRoot}/_aligned`, latest_key: latestKey,
    },
    day_summaries: [{
      day_utc: dayUtc, row_count: rows.length, scoped_root_count: scopedRoots.length,
      connector_ids: [fixtureConnectorId], pollutant_codes: scopedRoots.map((root) => root.pollutant_code), scoped_roots: scopedRoots,
    }],
  };
  objects.set(latestKey, Buffer.from(encodeObservationHistoryIndexV3Json(latestPayload)));
  return { objects, connector, connectorKey, monthKey, yearKey, rootKey };
}

const admit = (objects, rows) => admitPruneFrozenConnectorSnapshot({
  r2: {}, observationsPrefix: prefix, dayUtc, connectorId, rows, getObject: getObjectFrom(objects),
});

test("first publication ignores unreferenced connector objects and can reach writer", async () => {
  const old = history([{ ...row("pm25", 801), connector_id: 8 }], 8);
  const objects = old.objects;
  const orphan = history([row("pm25", 101)]);
  objects.set(orphan.connectorKey, orphan.connector);
  const orphanChildKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, "pm25");
  objects.set(orphanChildKey, history([row("pm25", 101, 13)]).objects.get(orphanChildKey));
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

test("pollutant omission and same-count changed content block; identical committed content is a no-op", async () => {
  const prior = [row("pm25", 101), row("no2", 201)];
  const old = history(prior);
  await assert.rejects(admit(old.objects, [row("pm25", 101, 13)]), /pollutant child set differs/);
  await assert.rejects(admit(old.objects, [row("pm25", 101, 13), row("no2", 201)]), /frozen observations differ/);
  await assert.rejects(admit(old.objects, prior), (error) => {
    assert.match(error.reason, /verified already-committed identical history/);
    assert.equal(error.next_action, "review_duplicate_historical_ingestdb_rows");
    return true;
  });
  let writes = 0;
  await assert.rejects(writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 2n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST", writer_git_sha: "a".repeat(40),
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity: {} },
    readFrozenRows: async function* () { yield* prior; },
    admitSnapshot: ({ rows }) => admit(old.objects, rows),
    connectorPublisher: async () => { writes++; },
    cleanupFrozenSource: () => {},
  }), { code: "PRUNE_COMMITTED_HISTORY_REPLACEMENT_BLOCKED" });
  assert.equal(writes, 0);
});

test("overwritten parent and child objects fail closed; unreferenced child does not establish authority", async () => {
  const old = history([row("pm25", 101)]);
  old.objects.set(old.monthKey, { ...old.objects.get(old.monthKey), content_hash: "0".repeat(64) });
  await assert.rejects(admit(old.objects, [row("pm25", 101)]), /content_hash mismatch/);
  const changedChild = history([row("pm25", 101, 13)]);
  const childKey = buildHistoryV2PollutantManifestKey(prefix, dayUtc, connectorId, "pm25");
  const intactParent = history([row("pm25", 101)]);
  intactParent.objects.set(childKey, changedChild.objects.get(childKey));
  await assert.rejects(admit(intactParent.objects, [row("pm25", 101)]), /original complete publication identity cannot be proved/);
  const orphan = history([row("pm25", 101)]);
  orphan.objects.delete(orphan.rootKey);
  await assert.rejects(admit(orphan.objects, [row("pm25", 102)]), /observations root is missing/);
  orphan.objects.delete(DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY);
  await assert.rejects(admit(orphan.objects, [row("pm25", 102)]), /observations root is missing/);
});

test("missing or contradictory index_v3 authority blocks before publication", async () => {
  const old = history([row("pm25", 101)]);
  old.objects.delete(DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY);
  await assert.rejects(admit(old.objects, [row("pm25", 101)]), /index_v3 latest authority is missing/);
  const contradictory = history([row("pm25", 101)]);
  const latestKey = DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY;
  const latest = JSON.parse(contradictory.objects.get(latestKey).toString("utf8"));
  latest.day_summaries[0].scoped_roots[0].row_count += 1;
  contradictory.objects.set(latestKey, Buffer.from(encodeObservationHistoryIndexV3Json(latest)));
  await assert.rejects(admit(contradictory.objects, [row("pm25", 101)]), /latest registry ordering or aggregate fields are contradictory/);
  const orphan = history([{ ...row("pm25", 801), connector_id: 8 }], 8);
  orphan.objects.set(latestKey, history([row("pm25", 101)]).objects.get(latestKey));
  await assert.rejects(admit(orphan.objects, [row("pm25", 101)]), /index_v3 authority contradicts absent connector hierarchy/);
});
