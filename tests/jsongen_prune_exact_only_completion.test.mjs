import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { decodePruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { preparePruneOriginalFinalEvidence, preparePruneOriginalFinalEvidenceWithExactOnlyCompletion,
  attachPruneOriginalEvidenceBundleReference }
  from '../scripts/jsongen/prune-final-evidence.mjs';
import { describePruneGateOutboxEvidence, preparePrunePostCommitHandover } from '../scripts/jsongen/prune-outbox.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { prepareObservationHistoryExactOnlyScopeV3, acceptObservationHistoryExactOnlyScopeV3 }
  from '../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs';
import { prepareObservationHistoryExactOnlyPublicationV3, describeObservationHistoryExactOnlyCompletionV3,
  preparePruneExactOnlyBatchCompletionV3 }
  from '../workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs';

// Reuse the existing original-event fixture; exercise only the new preparatory
// boundary with actual serialized Parquet, local adapters and two whole series.
async function fixture({ checksumHead = true, operationRunId = null, pruneBatch = false } = {}) {
  const event = await sourceAndOriginalEvent(2);
  const envelope = JSON.parse(event.row.final_evidence_bytes);
  const decoded = decodePruneMetadataEvidence(envelope);
  const snapshot = decoded.original_metadata_snapshot;
  const objects = new Map(snapshot.objects.map(o => [o.key, Buffer.from(o.bytes_base64, 'base64')]));
  const rows = gunzipSync(event.objects.get(event.pendingRef.key)).toString().trim().split('\n')
    .map(line => { const { observed_at, ...row } = JSON.parse(line); return row; });
  const partition = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', rows,
    targetWriterGitSha: envelope.writer.git_sha, backedUpAtUtc: null });
  const prior = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity',
    rows: [{ ...rows[0], connector_id: 8, timeseries_id: 9001, station_id: 71 }],
    targetWriterGitSha: envelope.writer.git_sha, backedUpAtUtc: null });
  for (const a of prior.v3_hierarchy.publication_objects) objects.set(a.key, Buffer.from(a.body));
  for (const f of partition.file_intents) objects.set(f.key, Buffer.from(f.body));
  const count = { files: 0, heads: 0, finalize: 0, mutations: 0 };
  let held = true;
  const originalOperation = { run_id: event.row.run_id,
    async assertHeld() { if (!held) throw new Error('original lock lost'); } };
  const getObject = async ({ key }) => {
    if (key.endsWith('.parquet')) count.files++;
    const body = objects.get(key);
    return body ? { key, body, exists: true, bytes: body.length, etag: sha256Hex(body) }
      : { key, exists: false };
  };
  const headObject = async ({ key }) => {
    count.heads++;
    const body = objects.get(key);
    return { key, exists: true, bytes: body.length, sha256: sha256Hex(body), etag: sha256Hex(body) };
  };
  const assertOperationHeld = async () => { if (!held) throw new Error('original lock lost'); };
  const prepared = await prepareObservationHistoryExactOnlyScopeV3({ scope: partition.scope,
    getObject, headObject: checksumHead ? headObject : null, assertOperationHeld,
    ...(pruneBatch ? { originalOperation } : {}) });
  const run = { key: `history/v3/_ops/observations/runs/run_id=${event.row.run_id}/run_manifest.json`,
    body: Buffer.from(JSON.stringify({ run_id: event.row.run_id, completed: true })) };
  Object.assign(run, { byte_size: run.body.length, sha256: sha256Hex(run.body) });
  const publication = await prepareObservationHistoryExactOnlyPublicationV3({
    preparedScopes: [prepared], getObject, assertOperationHeld, runId: operationRunId || event.row.run_id,
    finalizeCanonicalHierarchy: async () => ({ ok: true }),
    finalizeRun: async () => { count.finalize++; objects.set(run.key, run.body); return { ok: true, artifact: run }; },
  });
  async function complete() {
    for (const entry of publication.plan.entries) {
      if (entry.publication_stage === 'latest_global') await publication.lifecycle.acceptCurrentRoot();
      await publication.lifecycle.beforePublish(entry, entry.exact_only_policy);
      objects.set(entry.key, Buffer.from(entry.body));
      await publication.lifecycle.afterReadback(entry);
    }
    if (!pruneBatch) {
      await publication.lifecycle.finalizeRun();
      return await publication.completedPublication();
    }
    return await preparePruneExactOnlyBatchCompletionV3(batchArgs());
  }
  function evidenceArgs(completion) {
    const exact = prepared.hierarchy.publication_objects;
    const kept = snapshot.objects.filter(o => !o.roles.includes('exact_v3_index') && !o.roles.includes('latest_global_index'));
    const captured = (artifact, role) => ({ key: artifact.key, sha256: artifact.sha256,
      byte_size: artifact.byte_size, canonical_bucket: envelope.original_connector_publication.connector_manifest.bucket,
      bytes_base64: Buffer.from(artifact.body).toString('base64'), roles: [role] });
    const capturedObjects = [...kept, ...exact.map(a => captured(a, 'exact_v3_index')),
      captured(publication.latest, 'latest_global_index')];
    const sourceEvidence = envelope.pending.source_evidence;
    return {
      pending: { state: 'put_acknowledged_unverified', intent_id: envelope.pending.intent_id,
        source: envelope.pending.object, pending_evidence: sourceEvidence,
        preparation_sha256: envelope.pending.preparation_sha256, source_evidence_sha256: envelope.pending.source_evidence_sha256 },
      connector: { ...envelope.original_connector_publication,
        scoped_roots: [{ scope: partition.scope, reference: prepared.proof.selector }] },
      finalization: { ok: true, affected_days_utc: [event.row.day_utc],
        connector_results: [{ day_utc: event.row.day_utc, connector_id: 1,
          partitions: [{ scoped_root: { evidence: prepared.proof.selector } }] }],
        day_results: [{ day_utc: event.row.day_utc, day_manifest: envelope.original_final_batch.day_manifest }],
        canonical_aggregate_result: { canonical_aggregate_authority_verified: true, parent_state_reread_under_lock: true,
          affected_days_utc: [event.row.day_utc], aggregate_manifests: envelope.original_final_batch.canonical_aggregate_references },
        v3_publication: { exact_scopes: [{ ok: true }], latest_global: { ok: true, objects: [publication.latest] } } },
      runId: event.row.run_id, dayUtc: event.row.day_utc, connectorId: 1, writerGitSha: event.row.writer_git_sha,
      sourceIdentity: envelope.pending.source_identity,
      originalMetadataSnapshot: { ...snapshot, objects: capturedObjects, required_object_count: capturedObjects.length,
        required_raw_byte_size: capturedObjects.reduce((sum, o) => sum + o.byte_size, 0) },
      originalAuthorityCapture: { snapshot: () => decoded.original_authority_extension },
      evidenceMode: 'r2_bundle', exactOnlyCompletion: completion,
    };
  }
  function batchArgs() {
    return { preparedScopes: [prepared], finalization: evidenceArgs(null).finalization,
      runId: event.row.run_id, originalOperation, expectedDays: [event.row.day_utc],
      expectedConnectorPublicationCount: 1, getObject };
  }
  return { event, prepared, publication, objects, complete, count, evidenceArgs, batchArgs,
    setHeld: value => { held = value; }, fileCount: partition.file_intents.length };
}

test('one actual file inspection survives final acceptance; existing envelope/outbox identify the same PENDING dataset', async () => {
  const f = await fixture();
  assert.equal(f.count.files, f.fileCount);
  const completion = await f.complete();
  assert.equal(f.count.files, f.fileCount, 'final acceptance and completion use identity HEADs, no second full inspection');
  assert.equal(f.count.heads, 8 * f.fileCount);
  assert.equal(f.count.finalize, 1);
  const args = f.evidenceArgs(completion);
  const preparation = await preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(args);
  const extension = preparation.envelope.original_final_batch.exact_only_completion;
  assert.equal(extension.dataset_id, f.event.pendingRef.key);
  assert.equal(extension.invocation_id, f.event.row.run_id);
  assert.equal(extension.scopes[0].row_count, 4); // duplicates preserved
  assert.equal(extension.scopes[0].physical_identity.decode_profile_id, 'hyparquet-direct-column-v1');
  assert.equal(preparation.envelope.authority_state, 'precommit_prepared_unverified');
  assert.equal(preparation.envelope.original_candidate_connector_gate.retained_transaction_proof, false);
  const b = preparation.bundle, identity = preparation.bundle_identity;
  const ref = { ...identity, bucket: f.event.pendingRef.bucket,
    key: 'managed/jsongen/v1/evidence-bundles/local.json.gz', intent_id: 'b'.repeat(64),
    compressed_sha256: b.sha256, compressed_byte_size: b.byte_size,
    uncompressed_sha256: b.json_sha256, uncompressed_byte_size: b.json_byte_size };
  const pointer = attachPruneOriginalEvidenceBundleReference(preparation, ref);
  const evidence = describePruneGateOutboxEvidence({ pending: args.pending, connector: args.connector, finalPreparation: pointer });
  assert.equal(evidence.final_evidence_state, 'prepared_unverified');
  const handover = preparePrunePostCommitHandover({ ...f.event.row, ...evidence,
    final_evidence_sha256: pointer.sha256, final_evidence_byte_size: pointer.byte_size });
  assert.equal(handover.message.pending.object.key, extension.dataset_id);
  assert.equal(handover.message.authority_state, 'requires_independent_authentication');
  assert.equal(handover.delivery_state, 'not_attempted');
  // Existing inline transport can also preserve the small versioned extension.
  const inline = await preparePruneOriginalFinalEvidenceWithExactOnlyCompletion({ ...args, evidenceMode: 'inline' });
  assert.deepEqual(JSON.parse(inline.bytes).original_final_batch.exact_only_completion, extension);
});

test('no checksum-capable HEAD retains complete-body identity reads without another physical inspection path', async () => {
  const f = await fixture({ checksumHead: false });
  await f.complete();
  assert.equal(f.count.files, 9 * f.fileCount);
  assert.equal(f.count.heads, 0);
});

test('copied proofs, incomplete finalisation and the real inactive publisher cannot grant completion', async () => {
  const f = await fixture();
  await assert.rejects(acceptObservationHistoryExactOnlyScopeV3({ ...f.prepared.proof }), /operation-local/);
  await assert.rejects(f.publication.finalize({
    putIfChanged: async () => { f.count.mutations++; }, getObject: async () => { f.count.mutations++; },
    recordDurableEvidence: async () => { f.count.mutations++; },
  }), /schema-2 publication inactive/);
  assert.equal(f.count.mutations, 0);
  await assert.rejects(f.publication.completedPublication(), /finalisation.*incomplete/);
  await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(f.evidenceArgs({})), /operation-local/);
});

test('changed pinned file or lost lock invalidates original proof and cannot resurrect completion', async () => {
  for (const mode of ['file', 'lock']) {
    const f = await fixture();
    const completion = await f.complete();
    const key = f.prepared.hierarchy.exact_leaves[0].payload.files[0].key;
    const original = f.objects.get(key);
    if (mode === 'file') f.objects.set(key, Buffer.concat([original, Buffer.from([0])]));
    else f.setHeld(false);
    await assert.rejects(f.publication.completedPublication(), /changed pinned|lock lost/);
    f.objects.set(key, original); f.setHeld(true);
    await assert.rejects(describeObservationHistoryExactOnlyCompletionV3(completion), /ended|usable/);
    await assert.rejects(f.publication.completedPublication(), /incomplete/);
  }
});

test('mismatched source, batch and selected leaf bytes cannot prepare optional schema-2 evidence', async () => {
  const f = await fixture();
  const completion = await f.complete();
  for (const mutate of [
    a => { a.sourceIdentity = { ...a.sourceIdentity, source_content_hash: 'f'.repeat(64) }; },
    a => { a.finalization.v3_publication.latest_global.ok = false; },
    a => { a.finalization.v3_publication.latest_global.objects = []; },
    a => { a.connector.pollutant_manifests = []; },
    a => { a.exactOnlyCompletion = structuredClone(completion); },
    a => { a.originalMetadataSnapshot.objects = a.originalMetadataSnapshot.objects.filter(o => o.key !== f.prepared.hierarchy.exact_leaves[0].key); },
  ]) {
    const args = f.evidenceArgs(completion); mutate(args);
    await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(args), /JSONgen|operation-local/);
  }
});

test('an index-only operation cannot confirm a historical observation event with unchanged data', async () => {
  const f = await fixture({ operationRunId: '11111111-1111-4111-8111-111111111111' });
  const before = Buffer.from(f.event.row.final_evidence_bytes);
  const completion = await f.complete();
  await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(f.evidenceArgs(completion)), /differs from original frozen publication/);
  // The index module has no PENDING upload, outbox or receipt writer. Its only
  // mutation entry is still hard-inactive; historical original bytes stay put.
  assert.deepEqual(f.event.row.final_evidence_bytes, before);
  assert.equal(f.count.mutations, 0);
});

test('normal original lock release rejects the old completion directly at evidence preparation', async () => {
  const f = await fixture();
  const completion = await f.complete();
  const args = f.evidenceArgs(completion);
  const prepared = await preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(args);
  assert.equal(prepared.envelope.original_final_batch.exact_only_completion.dataset_id, f.event.pendingRef.key);
  const reads = { files: f.count.files, heads: f.count.heads };

  // Normal release only: do not re-enter publication/proof methods or perform
  // a failing recheck that could invalidate the cached handle before use.
  f.setHeld(false);
  await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(args), /original lock lost/);
  assert.deepEqual({ files: f.count.files, heads: f.count.heads }, reads);
  assert.throws(() => preparePruneOriginalFinalEvidence(args), /asynchronous operation-bound/);
  // Removing the handle or supplying its detached data cannot bypass the
  // asynchronous boundary through the legacy synchronous schema-1 entry.
  assert.throws(() => preparePruneOriginalFinalEvidence({ ...args, exactOnlyCompletion: null }),
    { code: 'PRUNE_EXACT_ONLY_DURABLE_HANDOVER_UNSUPPORTED' });
});

test('Prune completion uses the checked original batch without a late run-summary object', async () => {
  const f = await fixture({ pruneBatch: true });
  const completion = await f.complete();
  const description = await describeObservationHistoryExactOnlyCompletionV3(completion);
  assert.equal(description.schema_version, 2);
  assert.equal(description.run, undefined);
  assert.equal(f.count.finalize, 0, 'late report writer is not a prerequisite');
  assert.equal([...f.objects.keys()].some(k => k.includes('/_ops/observations/runs/')), false);
  const result = await preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(f.evidenceArgs(completion));
  assert.equal(result.envelope.authority_state, 'precommit_prepared_unverified');
  assert.equal(result.envelope.original_final_batch.exact_only_completion.dataset_id, f.event.pendingRef.key);
  assert.equal(f.count.files, f.fileCount, 'the original physical inspection is reused');
  for (const mutate of [
    a => { a.finalization.v3_publication.latest_global.ok = false; },
    a => { a.finalization.canonical_aggregate_result.parent_state_reread_under_lock = false; },
    a => { a.finalization.v3_publication.exact_scopes = []; },
    a => { a.finalization.connector_results = []; },
    a => { a.finalization.v3_publication.latest_global.objects = [{ key: 'wrong', byte_size: 1, sha256: 'f'.repeat(64) }]; },
    a => { a.originalOperation = { ...a.originalOperation }; },
  ]) {
    const args = f.batchArgs(); mutate(args);
    await assert.rejects(preparePruneExactOnlyBatchCompletionV3(args));
  }
  f.setHeld(false);
  await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(f.evidenceArgs(completion)), /original lock lost/);
});
