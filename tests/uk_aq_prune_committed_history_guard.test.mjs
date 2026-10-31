import assert from "node:assert/strict";
import test from "node:test";
import { admitPruneFrozenConnectorSnapshot, PruneCommittedHistoryGuardError } from "../workers/uk_aq_prune_daily/committed_history_guard.mjs";
import { writeFrozenCandidateObservationsToV2ForTest, createPhaseBRunBudgetForTest } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import { computeObservationContentHash } from "../workers/shared/uk_aq_observation_content_hash.mjs";
import { computePruneConnectorSourceIdentity } from "../workers/shared/uk_aq_prune_connector_source_identity.mjs";
import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_LATEST_KEY,
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { encodeObservationHistoryIndexV3Json } from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import { OBSERVATION_HISTORY_SCHEMA_VERSION_V3, OBSERVATION_HISTORY_WRITER_VERSION_V3 } from "../workers/shared/uk_aq_observation_history_schema.mjs";
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION, OBSERVATION_HISTORY_ALIGNED_ROW_CAP, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION } from "../workers/shared/uk_aq_observation_history_target_writer.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import { canonicalJson, BUCKET } from '../scripts/jsongen/schema.mjs';
import { gzipSync } from 'node:zlib';
import { preparePruneOriginalAuthorityExtension, createPruneOriginalMetadataCapture,
  preparePruneOriginalMetadataSnapshot } from '../scripts/jsongen/prune-original-metadata.mjs';
import { describePrunePendingSource } from '../scripts/jsongen/prune-evidence.mjs';
import { preparePruneOriginalFinalEvidence } from '../scripts/jsongen/prune-final-evidence.mjs';
import { describePruneGateOutboxEvidence } from '../scripts/jsongen/prune-outbox.mjs';
import { decodePruneMetadataEvidence, compactPruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { observationsGlobalOperationLockIdentity, OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV } from '../workers/shared/uk_aq_r2_history_writer.mjs';

function originalLockEnv(runId) {
  const identity = observationsGlobalOperationLockIdentity();
  const values = { held: 'true', owner: 'prune_daily', runId, logicalIdentity: identity.logical_identity,
    classId: String(identity.class_id), objectId: String(identity.object_id), nonce: 'test-nonce',
    acquired: 'true', waitMs: '0', outcome: 'held' };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV[key], value]));
}
import { buildTimeseriesBindingSourceRootManifest, buildTimeseriesBindingSourceRangeManifest,
  timeseriesBindingSourceRangeManifestKey, TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND,
} from '../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { buildTimeseriesBindingSourceState } from '../scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs';
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

function history(rows, fixtureConnectorId = connectorId, physicalFiles = null) {
  const objects = new Map();
  const byCode = Map.groupBy(rows, (entry) => entry.pollutant_code);
  const pollutants = [...byCode].map(([code, partition]) => {
    const key = buildHistoryV2PollutantManifestKey(prefix, dayUtc, fixtureConnectorId, code);
    const hash = computeObservationContentHash(partition);
    const value = buildHistoryV2PollutantManifest({
      domain: "observations", dayUtc, connectorId: fixtureConnectorId, pollutantCode: code,
      manifestKey: key, sourceRowCount: partition.length,
      observationContentHash: hash, fileEntries: physicalFiles || [{
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
      schema_version: 1, exact_leaf_index_version: "exact-timeseries-leaf-v1",
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

// Small metadata-only fixture for the existing real admission and bounded GET
// seams. No signer, Parquet, database or network is involved.
async function originalAuthorityPublication(bindingFailure = null, scopeCount = 1) {
  const prior = history([{ ...row('pm25', 801), connector_id: 8 }], 8);
  const objects = prior.objects;
  const frozenRows = Array.from({ length: scopeCount }, (_, i) => ({ ...row('pm25', 102 + i), connector_id: 1 }));
  const frozenRow = frozenRows[0];
  const sourceIdentity = computePruneConnectorSourceIdentity(frozenRows);
  const scopes = frozenRows.map(r => ({ timeseries_id: r.timeseries_id, station_id: r.station_id, pollutant_code: r.pollutant_code, day_utc: dayUtc, row_count: 1 }));
  const bindingPrefix = 'history/_index_v3/timeseries_binding';
  const bindingKey = `${bindingPrefix}/timeseries_id=102.json`;
  const units = scopes.map(scope => {
    const key = `${bindingPrefix}/timeseries_id=${scope.timeseries_id}.json`;
    const body = canonicalJson({ schema_version: 1, history_version: 'v2', index_kind: 'timeseries_binding',
      connector_id: 1, timeseries_id: scope.timeseries_id, station_id: bindingFailure === 'identity' ? 99 : 71, pollutant_code: 'pm25' });
    objects.set(key, body);
    return { timeseries_id: scope.timeseries_id, relative_path: key, sha256: sha256Hex(body), size: body.length };
  });
  const range = buildTimeseriesBindingSourceRangeManifest({ bindingPrefix, rangeStart: 0, units });
  const rangeKey = timeseriesBindingSourceRangeManifestKey(bindingPrefix, 0);
  const root = buildTimeseriesBindingSourceRootManifest({ bindingPrefix,
    ranges: [{ range_start: 0, range_end: 999, manifest_key: rangeKey, source_range_hash: range.source_range_hash, unit_count: scopeCount }] });
  const source = buildTimeseriesBindingSourceState({ bindingPrefix, sourceSchema: 'uk_aq_core',
    sourceFingerprint: 'f'.repeat(64), authoritativeTimeseriesCount: scopeCount,
    sourceTables: ['timeseries', 'phenomena', 'observed_properties'].map(table => ({ table, row_count: table === 'timeseries' ? scopeCount : 1, sha256_uncompressed: 'd'.repeat(64) })) });
  const bindingRootKey = `${bindingPrefix}/_manifests/root.json`;
  objects.set(rangeKey, canonicalJson(range));
  objects.set(bindingRootKey, canonicalJson(root));
  objects.set(`${bindingPrefix}/_source_state.json`, canonicalJson(source));
  objects.set(`${bindingPrefix}/_manifests/_refresh_state.json`, canonicalJson({ schema_version: 1,
    kind: TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND, history_version: 'v2', source_prefix: bindingPrefix,
    source_root_hash: root.source_root_hash, source_fingerprint: source.source_fingerprint }));
  if (bindingFailure === 'missing') objects.delete(bindingRootKey);
  if (bindingFailure === 'oversized') objects.set(bindingRootKey, Buffer.alloc(1024 ** 2 + 1));
  if (bindingFailure === 'core') objects.set(`${bindingPrefix}/_manifests/_refresh_state.json`, canonicalJson({ schema_version: 1,
    kind: TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND, history_version: 'v2', source_prefix: bindingPrefix,
    source_root_hash: root.source_root_hash, source_fingerprint: '0'.repeat(64) }));
  const calls = [];
  let inFlight = 0; let maxInFlight = 0;
  const beforeBytes = (await getObjectFrom(objects)({ key: prior.rootKey })).body;
  const runId = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb';
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: 1, expected_row_count: BigInt(scopeCount) },
    runtime: { run_id: runId, environment: 'TEST', writer_git_sha: 'a'.repeat(40),
      history_write_version: 'v3', committed_prefix: prefix,
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      jsongen_pending_source: { enabled: true, signer: {} }, logStructured: () => {},
      r2: { bucket: 'canonical-test', adapter: { async getObjectBounded({ key }) {
        if (bindingFailure === 'deadline') throw new Error('Bounded R2 GET deadline exceeded');
        calls.push(key); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (bindingFailure === 'concurrent') await new Promise(resolve => setImmediate(resolve));
          const object = await getObjectFrom(objects)({ key });
          return { ...object, bytes: object.body.length };
        } finally { inFlight--; }
      } } } },
    streamClient: {}, frozen: { temp: { ndjsonPath: 'unused' }, counts: {}, sourceIdentity },
    originalAuthorityLockEnv: originalLockEnv(runId),
    admitSnapshot: args => admitPruneFrozenConnectorSnapshot({ ...args,
      ...(bindingFailure === 'before' ? { onOriginalAuthority: undefined } : {}) }),
    readAdmissionObject: async args => { calls.push(args.key); return getObjectFrom(objects)(args); },
    readFrozenRows: async function* () { yield* frozenRows; },
    uploadPendingSource: async () => { calls.push('upload'); return { state: 'put_acknowledged_unverified',
      pending_evidence: { scope: { physical_timeseries_days: scopes } } }; },
    connectorPublisher: async () => { calls.push('publish'); objects.set(prior.rootKey, Buffer.from('{"new":"root"}'));
      return { file_count: 1, total_bytes: 100n }; }, cleanupFrozenSource: () => {},
  });
  return { result, calls, beforeBytes, runId, scopes, sourceIdentity, frozenRow, frozenRows, bindingKey, bindingRootKey, rootKey: prior.rootKey, objects, maxInFlight };
}

test('original authority captures admitted absence and selected-v3 Core closure before replacement', async () => {
  const f = await originalAuthorityPublication();
  const original = f.result.jsongen_original_authority.snapshot();
  assert.equal(original.completeness, 'captured');
  assert.equal(original.before.admission, 'first_publication');
  assert.deepEqual(original.before.scopes[0].before, { state: 'authoritative_empty', row_count: 0,
    authority: original.before.hierarchy.at(-1) });
  assert.equal(original.before.absence.child_field, 'connector_id');
  assert.equal(original.before.absence.child_identity, 1);
  assert.deepEqual(Buffer.from(original.objects.find(o => o.key === f.rootKey).bytes_base64, 'base64'), f.beforeBytes);
  assert.equal(original.binding.bindings[0].authority.key, f.bindingKey);
  assert.equal(original.binding.root.key, f.bindingRootKey);
  assert.equal(f.calls.filter(key => key === f.bindingRootKey).length, 1);
  assert.equal(f.calls.some(key => key.includes('.parquet') || key.includes('_index_v2')), false);
  assert.ok(f.calls.indexOf('upload') < f.calls.indexOf(f.bindingRootKey));
  assert.equal(f.calls.at(-1), 'publish');
  const args = { capture: f.result.jsongen_original_authority,
    pending: { preparation_sha256: 'b'.repeat(64), source_evidence_sha256: 'c'.repeat(64),
      pending_evidence: { scope: { physical_timeseries_days: f.scopes } } },
    connector: { connector_manifest: { bucket: 'canonical-test' } }, finalBatch: { original: 'validated-batch' },
    runId: f.runId, dayUtc, connectorId: 1, writerGitSha: 'a'.repeat(40), sourceIdentity: f.sourceIdentity };
  const extension = preparePruneOriginalAuthorityExtension(args);
  assert.equal(extension.publication.original_final_batch_sha256, sha256Hex(canonicalJson(args.finalBatch)));
  assert.throws(() => preparePruneOriginalAuthorityExtension({ ...args, runId: 'another-original-event' }), /contradictory_original_authority_identity/);
  assert.throws(() => preparePruneOriginalAuthorityExtension({ ...args,
    sourceIdentity: { ...f.sourceIdentity, source_content_hash: '0'.repeat(64) } }), /contradictory_original_authority_identity/);
  assert.throws(() => preparePruneOriginalAuthorityExtension({ ...args,
    capture: { snapshot: () => ({ ...original, schema_version: 2 }) } }), /unsupported_original_authority_extension/);

  // Use that same real original capture in the existing final-preparation and
  // immutable-outbox byte selection, after the mocked canonical finalizer.
  const sourceBytes = Buffer.from(`${JSON.stringify(f.frozenRow)}\n`);
  const compressed = gzipSync(sourceBytes);
  const sourceEvidence = describePrunePendingSource({ source: sourceBytes, compressed, rows: [f.frozenRow],
    runId: f.runId, dayUtc, connectorId: 1, sourceIdentity: f.sourceIdentity });
  const source = { bucket: BUCKET,
    key: `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=1/day_utc=${dayUtc}`
      + `/invocation=${f.runId}/compressed_sha256=${sha256Hex(compressed)}/uncompressed_sha256=${sha256Hex(sourceBytes)}.ndjson.gz`,
    sha256: sha256Hex(compressed), byte_size: compressed.length,
    json_sha256: sha256Hex(sourceBytes), json_byte_size: sourceBytes.length };
  const pendingEvidence = { ...sourceEvidence, signed_upload: { intent_id: 'b'.repeat(64), object: source,
    disposition: 'put_acknowledged_unverified' } };
  const pending = { state: 'put_acknowledged_unverified', source, intent_id: 'b'.repeat(64), pending_evidence: pendingEvidence,
    source_evidence_sha256: sha256Hex(canonicalJson(sourceEvidence)), preparation_sha256: sha256Hex(canonicalJson(pendingEvidence)) };
  const metadataCapture = createPruneOriginalMetadataCapture();
  const refs = ['connector', 'pollutant', 'exact', 'day', 'aggregate', 'latest'].map(role => {
    const key = `${prefix}/${role}.json`; const body = canonicalJson({ role });
    metadataCapture.recordPublishedObject({ key, body });
    return { key, sha256: sha256Hex(body), byte_size: body.length, verified: true, durable: true };
  });
  const snapshot = preparePruneOriginalMetadataSnapshot({ capture: metadataCapture, bucket: 'canonical-test',
    dayUtc, connectorId: 1, runId: f.runId, writerGitSha: 'a'.repeat(40),
    canonicalReferences: refs.slice(0, 2), exactReferences: [refs[2]], dayReferences: [refs[3]],
    affectedDaysUtc: [dayUtc], aggregateReferences: [refs[4]], latestReferences: [refs[5]] });
  const connector = { run_id: f.runId, day_utc: dayUtc, connector_id: 1,
    manifest_key: refs[0].key, manifest_hash: 'e'.repeat(64), connector_manifest: { bucket: 'canonical-test', ...refs[0] },
    pollutant_manifests: sourceEvidence.scope.pollutant_partitions.map(p => ({ ...p, manifest: refs[1] })), scoped_roots: [] };
  const finalArgs = { ...args, pending, connector, originalMetadataSnapshot: snapshot,
    originalAuthorityCapture: f.result.jsongen_original_authority,
    finalization: { ok: true, affected_days_utc: [dayUtc],
      canonical_aggregate_result: { canonical_aggregate_authority_verified: true,
        parent_state_reread_under_lock: true, affected_days_utc: [dayUtc] },
      v3_publication: { exact_scopes: [{ ok: true }], latest_global: { ok: true } } } };
  const final = preparePruneOriginalFinalEvidence(finalArgs);
  assert.equal(final.envelope.schema_version, 1);
  assert.equal(final.envelope.original_authority_extension.schema_version, 2);
  const decoded = decodePruneMetadataEvidence(final.envelope);
  assert.equal(final.envelope.original_authority_extension.completeness, 'captured');
  assert.equal(decoded.original_authority_extension.publication.pending_preparation_sha256, pending.preparation_sha256);
  assert.equal(decoded.original_authority_extension.publication.original_final_batch_sha256,
    sha256Hex(canonicalJson(final.envelope.original_final_batch)));
  assert.equal(describePruneGateOutboxEvidence({ pending, connector, finalPreparation: final }).final_evidence_state, 'prepared_unverified');
  assert.deepEqual(JSON.parse(final.bytes).original_authority_extension, final.envelope.original_authority_extension);
  const oversized = preparePruneOriginalFinalEvidence({ ...finalArgs, originalAuthorityCapture: {
    snapshot: () => ({ ...original, objects: [{ ...original.objects[0], bytes_base64: 'a'.repeat(1024 ** 2) }] }) } });
  assert.equal(oversized.envelope.original_metadata_snapshot.completeness, 'not_captured');
  assert.equal(oversized.envelope.original_authority_extension.before.state, 'unavailable');
  assert.equal(oversized.envelope.original_authority_extension.objects, undefined);
  assert.ok(oversized.byte_size <= 1024 ** 2);
});

test('unavailable contradictory and oversized original authority evidence preserve canonical publication', async () => {
  for (const [failure, state] of [['missing', 'unavailable'], ['identity', 'contradictory'], ['core', 'contradictory'], ['oversized', 'oversized'], ['before', 'unavailable'], ['deadline', 'unavailable']]) {
    const f = await originalAuthorityPublication(failure);
    const original = f.result.jsongen_original_authority.snapshot();
    assert.equal(f.calls.at(-1), 'publish');
    assert.equal(f.result.jsongen_pending_source.state, 'put_acknowledged_unverified');
    assert.equal(original.before.state, failure === 'before' ? 'unavailable' : 'captured');
    assert.equal(original.binding.state, failure === 'before' ? 'captured' : state);
    assert.equal(original.completeness, state);
    if (failure === 'deadline') assert.equal(original.binding.reason, 'original_binding_capture_deadline');
  }
});

test('bounded concurrent original capture covers 433 scopes and lossless inline metadata capacity', async t => {
  const f = await originalAuthorityPublication('concurrent', 433);
  const original = f.result.jsongen_original_authority.snapshot();
  assert.equal(original.completeness, 'captured');
  assert.equal(original.binding.bindings.length, 433);
  assert.ok(f.maxInFlight > 1 && f.maxInFlight <= 8);
  const bindingCalls = f.calls.filter(key => key.startsWith('history/_index_v3/timeseries_binding/'));
  assert.equal(bindingCalls.length, 433 + 4);
  assert.equal(new Set(bindingCalls).size, bindingCalls.length);
  assert.deepEqual(original.binding.bindings.map(b => b.identity.timeseries_id), f.scopes.map(s => s.timeseries_id));
  // One large but admitted canonical JSON object demonstrates combined capacity;
  // these synthetic bytes establish no real AURN throughput/size distribution.
  const body = canonicalJson({ metadata: 'canonical-byte-evidence:'.repeat(30000) });
  const value = { schema_version: 1, pending_scope_membership: f.scopes,
    original_metadata_snapshot: { schema_version: 1, completeness: 'exact_writer_metadata_captured_unverified',
      required_object_count: 1, required_raw_byte_size: body.length,
      objects: [{ canonical_bucket: 'canonical-test', key: `${prefix}/large.json`, byte_size: body.length,
        sha256: sha256Hex(body), bytes_base64: body.toString('base64'), roles: ['canonical_manifest'] }] },
    original_authority_extension: original };
  const expanded = canonicalJson(value);
  assert.ok(expanded.length > 1024 ** 2);
  compactPruneMetadataEvidence(value);
  const compact = canonicalJson(value);
  assert.ok(compact.length < 1024 ** 2);
  const decoded = decodePruneMetadataEvidence(value);
  assert.deepEqual(decoded.original_authority_extension, original);
  assert.deepEqual(Buffer.from(decoded.original_metadata_snapshot.objects[0].bytes_base64, 'base64'), body);
  const repeated = JSON.parse(expanded);
  compactPruneMetadataEvidence(repeated);
  assert.deepEqual(value, repeated);
  assert.throws(() => decodePruneMetadataEvidence({ ...value, original_metadata_evidence:
    { ...value.original_metadata_evidence, codec: 'unknown' } }), /unsupported_original_metadata_encoding/);
  assert.throws(() => decodePruneMetadataEvidence({ ...value, original_metadata_evidence:
    { ...value.original_metadata_evidence, sha256: '0'.repeat(64) } }), /contradictory_original_metadata_encoding/);
  t.diagnostic(JSON.stringify({ synthetic_scopes: 433, retained_raw_metadata_bytes: body.length + original.required_raw_byte_size,
    expanded_inline_bytes: expanded.length, compressed_metadata_bytes: value.original_metadata_evidence.byte_size,
    compact_inline_bytes: compact.length, maximum_concurrency: f.maxInFlight }));
});

test('original capture deadline aborts in-flight reads and late responses cannot mutate evidence', async () => {
  const f = await originalAuthorityPublication('concurrent', 40);
  const manager = createPruneOriginalMetadataCapture();
  const capture = manager.beginOriginalAuthority(f.result.jsongen_original_authority.snapshot().identity, originalLockEnv(f.runId));
  const late = []; let aborted = 0;
  await capture.captureBindings({ physicalScopes: f.scopes, deadlineAtMs: Date.now() + 100,
    r2: { adapter: { getObjectBounded({ key, signal }) {
      if (key.includes('/timeseries_id=')) return new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted++; }, { once: true });
        late.push(() => { const body = f.objects.get(key); resolve({ body, bytes: body.length }); });
      });
      const body = f.objects.get(key); return Promise.resolve({ body, bytes: body.length });
    } } } });
  assert.ok(late.length > 0 && late.length <= 8);
  assert.equal(aborted, late.length);
  assert.equal(capture.snapshot().binding.reason, 'original_binding_capture_deadline');
  const settled = canonicalJson(capture.snapshot()); const accounting = manager.statistics();
  for (const resolve of late) resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(canonicalJson(capture.snapshot()), settled);
  assert.deepEqual(manager.statistics(), accounting);
  assert.equal(accounting.retained_bytes, 0);
});

test('original capture capacity protects final bytes and requires the same validated lock invocation', async () => {
  const f = await originalAuthorityPublication();
  const identity = f.result.jsongen_original_authority.snapshot().identity;
  for (const env of [{ valid: true, owner: 'prune_daily', run_id: f.runId }, originalLockEnv('another-run'),
    { ...originalLockEnv(f.runId), [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: 'false' }]) {
    const manager = createPruneOriginalMetadataCapture(); const capture = manager.beginOriginalAuthority(identity, env);
    let reads = 0;
    await capture.captureBindings({ physicalScopes: f.scopes, deadlineAtMs: Date.now() + 1000,
      getObject: async () => { reads++; throw new Error('forbidden'); } });
    assert.equal(reads, 0); assert.equal(capture.snapshot().binding.reason, 'original_global_lock_context_unavailable');
  }
  const contradictory = createPruneOriginalMetadataCapture().beginOriginalAuthority({ ...identity,
    source_identity: computePruneConnectorSourceIdentity([f.frozenRow, { ...f.frozenRow, station_id: 999 }]) }, originalLockEnv(f.runId));
  let physicalReads = 0;
  await contradictory.captureBindings({ physicalScopes: [f.scopes[0], { ...f.scopes[0], station_id: 999 }],
    deadlineAtMs: Date.now() + 1000,
    getObject: async ({ key }) => { if (key === f.bindingKey) physicalReads++; return { body: f.objects.get(key) }; } });
  // Full scopes are distinct; the one canonical binding object contradicts one
  // of them. Reject that contradiction, without a timeseries-only scope rule.
  assert.equal(physicalReads, 1);
  assert.equal(contradictory.snapshot().binding.reason, 'contradictory_binding_authority');
  const manager = createPruneOriginalMetadataCapture();
  const capture = manager.beginOriginalAuthority(identity, originalLockEnv(f.runId));
  const key = `${prefix}/same-key.json`; const old = canonicalJson({ state: 'original' }); const final = canonicalJson({ state: 'final' });
  capture.recordBeforeObject({ key, body: old });
  manager.recordPublishedObject({ key, body: final });
  assert.deepEqual(Buffer.from(capture.snapshot().objects[0].bytes_base64, 'base64'), old);
  const accounting = manager.statistics();
  manager.recordPublishedObject({ key, body: Buffer.alloc(1024 ** 2 + 1) });
  assert.equal(manager.body(key), null); assert.deepEqual(manager.statistics(), accounting);
  manager.recordPublishedObject({ key, body: final });
  const mib = Buffer.from('"' + 'x'.repeat(1024 ** 2 - 2) + '"');
  for (let i = 0; i < 5; i++) capture.recordBeforeObject({ key: `${prefix}/original-${i}.json`, body: mib });
  assert.ok(manager.statistics().optional_bytes <= 4 * 1024 ** 2);
  for (let i = 0; i < 7; i++) manager.recordPublishedObject({ key: `${prefix}/final-${i}.json`, body: mib });
  assert.deepEqual(manager.statistics(), { retained_bytes: 7 * 1024 ** 2 + final.length, retained_objects: 8,
    optional_bytes: 0, optional_objects: 0 });
  assert.equal(capture.snapshot().completeness, 'oversized');
  assert.equal(capture.snapshot().binding.reason, 'final_metadata_capacity_priority_limit');
  assert.deepEqual(manager.body(key), final);
});

test("v3 signed source upload precedes publication and remains unverified", async () => {
  const calls = [];
  const frozenRow = row("pm25", 102);
  const sourceIdentity = computePruneConnectorSourceIdentity([frozenRow]);
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST", writer_git_sha: "a".repeat(40),
      run_id: "c771948f-9d20-4bd5-ac1d-6cef0a4f106a",
      jsongen_pending_source: { enabled: true, signer: { endpoint: "https://signer.test.example/v1/upload-intents" } },
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity },
    readFrozenRows: async function* () { yield frozenRow; },
    admitSnapshot: async () => ({ admission: "first_publication" }),
    uploadPendingSource: async () => { calls.push("upload"); return { state: "put_acknowledged_unverified", intent_id: "a".repeat(64), source: { key: "private/pending" } }; },
    connectorPublisher: async () => { calls.push("publish"); return { file_count: 1, total_bytes: 100n }; },
    cleanupFrozenSource: () => { calls.push("cleanup"); },
  });
  assert.deepEqual(calls, ["upload", "publish"]);
  assert.equal(result.jsongen_pending_source.state, "put_acknowledged_unverified");
});

test("v3 pending source failure cannot block canonical publication", async () => {
  const calls = [];
  const frozenRow = row("pm25", 102);
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0, maxSecondsPerRun: 1740, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST", writer_git_sha: "a".repeat(40),
      jsongen_pending_source: { enabled: true, signer: {} }, logStructured: () => {},
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity: {} },
    readFrozenRows: async function* () { yield frozenRow; },
    admitSnapshot: async () => ({ admission: "first_publication" }),
    uploadPendingSource: async () => { calls.push("upload"); throw new Error("derived unavailable"); },
    connectorPublisher: async () => { calls.push("publish"); return { file_count: 1, total_bytes: 100n }; },
    cleanupFrozenSource: () => { calls.push("cleanup"); },
  });
  assert.deepEqual(calls, ["upload", "publish"]);
  assert.equal(result.jsongen_pending_source.state, "no_intent");
  assert.equal(result.jsongen_pending_source.intent_id, null);
  assert.equal(result.jsongen_pending_source.source, null);
});

test("insufficient optional headroom skips signer while canonical connector publication continues", async () => {
  const calls = [];
  const frozenRow = row("pm25", 102);
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: 1n },
    runtime: {
      run_budget: createPhaseBRunBudgetForTest({ nowMs: () => 0, startedAtMs: 0,
        maxSecondsPerRun: 600, stopBeforeTimeoutSeconds: 60 }),
      history_write_version: "v3", committed_prefix: prefix, r2: {}, environment: "TEST",
      writer_git_sha: "a".repeat(40),
      jsongen_pending_source: { enabled: true, signer: {} },
    },
    streamClient: {}, frozen: { temp: { ndjsonPath: "unused" }, counts: {}, sourceIdentity: {} },
    readFrozenRows: async function* () { yield frozenRow; },
    admitSnapshot: async () => ({ admission: "first_publication" }),
    uploadPendingSource: async () => { calls.push("signer"); },
    connectorPublisher: async () => { calls.push("publish"); return { file_count: 1, total_bytes: 100n }; },
    cleanupFrozenSource: () => { calls.push("cleanup"); },
  });
  assert.deepEqual(calls, ["publish"]);
  assert.deepEqual(result.jsongen_pending_source, { state: "not_attempted" });
});

test("a prior committed 100-row connector blocks a one-row late snapshot before writer invocation", async () => {
  const old = history(Array.from({ length: 100 }, (_, i) => ({ ...row("pm25", 101, i), observed_at_utc: new Date(Date.parse(time) + i * 60000).toISOString() })));
  let writes = 0;
  await assert.rejects(admit(old.objects, [row("pm25", 101, 101)]), (error) => {
    assert.ok(error instanceof PruneCommittedHistoryGuardError);
    assert.equal(error.isolatable, true);
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
  await assert.rejects(admit(old.objects, [row("pm25", 101, 13), row("no2", 201)]), (error) => {
    assert.match(error.reason, /frozen observations differ/);
    assert.equal(error.isolatable, true);
    return true;
  });
  await assert.rejects(admit(old.objects, prior), (error) => {
    assert.match(error.reason, /verified already-committed identical history/);
    assert.equal(error.next_action, "review_original_publication_evidence_or_duplicate_historical_rows");
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
  await assert.rejects(admit(old.objects, [row("pm25", 101)]), (error) => {
    assert.match(error.message, /index_v3 latest authority is missing/);
    assert.equal(error.isolatable, false);
    return true;
  });
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


test('schema-2 committed history uses rejection metadata; post-write retains actual file proof and receipt denial', async () => {
  const { buildObservationHistoryV3SteadyStatePartition } = await import('../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs');
  const { buildObservationHistoryExactLeafIndexV3ScopedHierarchy, buildObservationHistoryExactLeafIndexV3Latest } = await import('../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs');
  const { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 } = await import('../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs');
  const { verifyCanonicalHierarchy, verifyV3Authority } = await import('../scripts/index_v3_migration/index_v3_steady_state_post_write_verify.mjs');
  const { assertPruneOriginalExactEvidenceV3 } = await import('../scripts/jsongen/prune-final-evidence.mjs');
  const source = Array.from({ length: 1026 }, (_, i) => ({ ...row('no2', i < 1025 ? 101 : 201), observed_at_utc: new Date(Date.parse(time) + Math.min(i, 1024) * 60000).toISOString() }));
  const prepared = buildObservationHistoryV3SteadyStatePartition({ source: 'prune_daily', rows: source,
    targetWriterGitSha: 'a'.repeat(40), writerLimits: ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 });
  const prior = history(source, connectorId, prepared.canonical_pollutant_manifest.payload.files);
  for (const file of prepared.file_intents) prior.objects.set(file.key, Buffer.from(file.body));
  const canonicalKey = prepared.canonical_pollutant_manifest.key;
  const canonical = prior.objects.get(canonicalKey);
  const canonicalBody = (await getObjectFrom(prior.objects)({ key: canonicalKey })).body;
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: prepared.target_metadata,
    exactSchemaVersion: 2, canonicalManifest: { key: canonicalKey, byte_size: canonicalBody.length,
      sha256: sha256Hex(canonicalBody), manifest_hash: canonical.manifest_hash, row_count: source.length,
      observation_content_hash: canonical.observation_content_hash, observation_content_hash_version: 1 } });
  for (const entry of hierarchy.publication_objects) prior.objects.set(entry.key, Buffer.from(entry.body));
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [hierarchy] });
  prior.objects.set(latest.key, Buffer.from(latest.body));
  let fileReads = 0, alignedReads = 0, held = true, selectorReads = 0;
  assert.equal(prepared.file_intents.length, 2);
  const getObject = async ({ key }) => {
    if (key.endsWith('.parquet')) fileReads++;
    if (key === hierarchy.scoped_manifest.key) selectorReads++;
    if (key.includes('/_aligned/')) alignedReads++;
    const result = await getObjectFrom(prior.objects)({ key });
    // Native S3 GET shape: no manufactured stored checksum.
    return { key, body: result.body, bytes: result.body.length, etag: sha256Hex(result.body) };
  };
  const headObject = async ({ key }) => { const b = prior.objects.get(key);return { key, exists: true, bytes: b.length, etag: sha256Hex(b) }; };
  const assertOperationHeld = () => { if (!held) throw new Error('original lock lost'); };
  const args = { r2: {}, observationsPrefix: prefix, dayUtc, connectorId, rows: source, getObject, headObject, assertOperationHeld };
  await assert.rejects(admitPruneFrozenConnectorSnapshot(args), error => error.isolatable === true && /authenticated already-committed metadata/.test(error.reason));
  assert.equal(fileReads, 0);assert.equal(alignedReads, 0);
  await assert.rejects(admitPruneFrozenConnectorSnapshot({ ...args, rows: source.map((r, i) => i ? r : { ...r, value: 13 }) }), /frozen observations differ/);
  assert.equal(fileReads, 0);
  const accepted = { day_utc: dayUtc, connector_id: connectorId, pollutant_codes: ['no2'], source_row_count: source.length };
  selectorReads = 0;
  const current = await verifyCanonicalHierarchy({ getObject, headObject, accepted, candidateManifestKey: prior.connectorKey, assertOperationHeld });
  assert.equal(selectorReads, 1);
  const verified = await verifyV3Authority({ getObject, headObject, accepted, canonical: current, environment: 'TEST', assertOperationHeld });
  assert.equal(verified.reconciliation.counts.FAIL, 0);
  assert.equal(verified.selected_probe.timeseries_id, 101);assert.equal(alignedReads, 0);
  assert.equal(selectorReads, 3); // initial selection, independent read and closing recheck
  // Reusing a snapshot after its one canonical->index handoff is forbidden.
  await assert.rejects(verifyV3Authority({ getObject, headObject, accepted, canonical: current, environment: 'TEST', assertOperationHeld }), /another or ended operation/);
  const lost = await verifyCanonicalHierarchy({ getObject, headObject, accepted,
    candidateManifestKey: prior.connectorKey, assertOperationHeld });
  held = false;
  await assert.rejects(verifyV3Authority({ getObject, headObject, accepted, canonical: lost,
    environment: 'TEST', assertOperationHeld }), /original lock lost/);
  held = true;
  await assert.rejects(verifyV3Authority({ getObject, headObject, accepted, canonical: lost,
    environment: 'TEST', assertOperationHeld }), /another or ended operation/);
  const { verifySelectedExactOnlyConsumerScopeV3 } = await import('../workers/shared/uk_aq_observation_history_exact_only_consumer_v3.mjs');
  const selector = latest.payload.day_summaries[0].scoped_roots[0];
  const capableHead = async ({key}) => ({ ...await headObject({key}), sha256: sha256Hex(prior.objects.get(key)) });
  const direct = await verifySelectedExactOnlyConsumerScopeV3({ scope: prepared.scope, selector,
    getObject, headObject: capableHead, assertOperationHeld });
  assert.equal(direct.identity_recheck, 'checksum_sha256_size_etag_head');
  const incompleteAlias = await verifySelectedExactOnlyConsumerScopeV3({ scope: prepared.scope, selector,
    getObject, headObject: async args => ({ ...await capableHead(args), byte_size: null }), assertOperationHeld });
  assert.equal(incompleteAlias.identity_recheck, 'authenticated_complete_get_sha256');
  const incompleteLength = async args => ({ ...await capableHead(args), bytes: null });
  const incomplete = await verifyCanonicalHierarchy({ getObject, headObject: incompleteLength, accepted,
    candidateManifestKey: prior.connectorKey, assertOperationHeld });
  await verifyV3Authority({ getObject, headObject: incompleteLength, accepted, canonical: incomplete,
    environment: 'TEST', assertOperationHeld });
  for (const overrides of [{ sha256: 'f'.repeat(64), bytes: null }, { sha256: null, bytes: 1 }]) {
    const before = fileReads;
    await assert.rejects(verifyCanonicalHierarchy({ getObject,
      headObject: async args => ({ ...await capableHead(args), ...overrides }), accepted,
      candidateManifestKey: prior.connectorKey, assertOperationHeld }), /contradictory canonical HEAD/);
    assert.equal(fileReads, before);
  }
  const savedLeaf = prior.objects.get(hierarchy.exact_leaves[0].key);
  prior.objects.delete(hierarchy.exact_leaves[0].key);
  await assert.rejects(admitPruneFrozenConnectorSnapshot(args), /missing|404/);
  prior.objects.set(hierarchy.exact_leaves[0].key, savedLeaf);
  const changed = await verifyCanonicalHierarchy({ getObject, headObject, accepted,
    candidateManifestKey: prior.connectorKey, assertOperationHeld });
  const advancedLatest = JSON.parse(Buffer.from(latest.body).toString('utf8'));
  advancedLatest.day_summaries[0].scoped_roots[0].sha256 = 'f'.repeat(64);
  prior.objects.set(latest.key, Buffer.from(encodeObservationHistoryIndexV3Json(advancedLatest)));
  await assert.rejects(verifyV3Authority({ getObject, headObject, accepted, canonical: changed,
    environment: 'TEST', assertOperationHeld }), /selected scope identity changed/);
  prior.objects.set(latest.key, Buffer.from(latest.body));

  await assert.rejects(verifySelectedExactOnlyConsumerScopeV3({ scope: prepared.scope, selector,
    getObject, headObject: async args => ({ ...await capableHead(args), sha256: 'f'.repeat(64) }), assertOperationHeld }), /HEAD checksum contradiction/);
  await assert.rejects(verifyV3Authority({ getObject, headObject, accepted, canonical: { ...current, pollutants: current.pollutants.map(p => ({ ...p })) }, environment: 'TEST' }), /original held observations operation/);
  const evidenceObject = payload => ({ roles: ['exact_v3_index'], bytes_base64: Buffer.from(encodeObservationHistoryIndexV3Json(payload)).toString('base64') });
  assertPruneOriginalExactEvidenceV3([evidenceObject(prepared.v3_hierarchy.scoped_manifest.payload)]);
  assert.throws(() => assertPruneOriginalExactEvidenceV3([evidenceObject(hierarchy.scoped_manifest.payload)]), { code: 'PRUNE_EXACT_ONLY_DURABLE_HANDOVER_UNSUPPORTED' });
  held = false;
  await assert.rejects(admitPruneFrozenConnectorSnapshot(args), /original lock lost/);
});
