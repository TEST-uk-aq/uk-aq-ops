import './jsongen_test_environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { decodePruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import * as verifier from '../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs';
import { buildObservationHistoryExactLeafIndexV3Latest, validateObservationHistoryExactLeafIndexV3LatestRegistry, latestArtifactFromRoots }
  from '../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 } from '../workers/shared/uk_aq_observation_history_index_v3.mjs';

async function fixture() {
  const event = await sourceAndOriginalEvent(2);
  const envelope = JSON.parse(event.row.final_evidence_bytes);
  const decoded = decodePruneMetadataEvidence(envelope);
  const objects = new Map(decoded.original_metadata_snapshot.objects.map(o => [o.key, Buffer.from(o.bytes_base64, 'base64')]));
  const rows = gunzipSync(event.objects.get(event.pendingRef.key)).toString().trim().split('\n')
    .map(line => { const { observed_at, ...row } = JSON.parse(line); return row; });
  const built = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', rows,
    targetWriterGitSha: envelope.writer.git_sha, backedUpAtUtc: null });
  for (const f of built.file_intents) objects.set(f.key, Buffer.from(f.body));
  const reads = []; let held = true;
  const getObject = async ({ key }) => {
    reads.push(key); const body = objects.get(key);
    return body ? { key, body, bytes: body.length, exists: true, etag: sha256Hex(body) } : { key, exists: false };
  };
  const assertOperationHeld = async () => { if (!held) throw new Error('fixture operation lost'); };
  const prepared = await verifier.prepareObservationHistoryExactOnlyScopeV3({ scope: built.scope, getObject, assertOperationHeld });
  for (const a of prepared.hierarchy.publication_objects) objects.set(a.key, Buffer.from(a.body));
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [prepared.hierarchy] });
  objects.set(latest.key, Buffer.from(latest.body));
  const selected = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest }).roots[0];
  reads.length = 0;
  return { built, objects, reads, prepared, selected, latest,
    args: { scope: built.scope, selected, getObject, assertOperationHeld }, loseLock: () => { held = false; } };
}

test('existing schema-2 reconstruction freshly inspects complete canonical files and preserves immutable identities', async () => {
  const f = await fixture();
  const result = await verifier.reconstructObservationHistoryExactOnlyScopeV3(f.args);
  assert.equal(result.hierarchy.scoped_manifest.body, f.prepared.hierarchy.scoped_manifest.body);
  assert.deepEqual(result.hierarchy.exact_leaves.map(l => [l.key, l.sha256]), f.prepared.hierarchy.exact_leaves.map(l => [l.key, l.sha256]));
  for (const file of f.built.file_intents) assert.ok(f.reads.includes(file.key));
  assert.equal(result.publication_eligible, false);
  assert.equal(result.observation_event_created, false);
  assert.equal(result.selected_format.schema_version, 2);
  assert.equal(result.hierarchy.aligned_source_manifest, undefined);
  assert.equal(OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3, false);
});

test('schema-2 reconstruction rejects copied proofs, absent physical bytes, selector conflicts and lost operation', async () => {
  for (const fault of ['file', 'selector', 'leaf', 'leaf_absent', 'profile', 'lock', 'format']) {
    const f = await fixture();
    if (fault === 'file') f.objects.delete(f.built.file_intents[0].key);
    if (fault === 'selector') f.args.selected = { ...f.selected, sha256: '0'.repeat(64) };
    if (fault === 'leaf_absent') f.objects.delete(f.prepared.hierarchy.exact_leaves[0].key);
    if (fault === 'profile') {
      const payload = structuredClone(f.prepared.hierarchy.scoped_manifest.payload);
      payload.decode_profile.profile_id = 'unsupported';
      const { encodeObservationHistoryIndexV3Json } = await import('../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs');
      const body = Buffer.from(encodeObservationHistoryIndexV3Json(payload));
      f.objects.set(f.selected.key, body);
      f.args.selected = { ...f.selected, byte_size: body.length, sha256: sha256Hex(body) };
      const latest = latestArtifactFromRoots([f.args.selected], f.latest.payload.index_root, f.latest.key);
      f.objects.set(latest.key, Buffer.from(latest.body));
    }
    if (fault === 'leaf') f.objects.set(f.prepared.hierarchy.exact_leaves[0].key, Buffer.from('{}'));
    if (fault === 'lock') f.loseLock();
    if (fault === 'format') f.args.selected = { ...f.selected, exact_index_schema_version: 1 };
    await assert.rejects(() => verifier.reconstructObservationHistoryExactOnlyScopeV3({ ...f.args,
      previousProof: JSON.parse(JSON.stringify(f.prepared.proof)) }), /missing|mismatch|lost|format|unsupported/i);
  }
});


test('mixed rebuilt hierarchy preserves independent schema-1 aligned and schema-2 direct dependencies', async () => {
  const f = await fixture();
  const result = await verifier.reconstructObservationHistoryExactOnlyScopeV3(f.args);
  const one = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', targetWriterGitSha: 'a'.repeat(40),
    rows: [{ connector_id: 8, station_id: 71, timeseries_id: 9001, pollutant_code: 'no2',
      observed_at_utc: `${f.built.scope.day_utc}T01:00:00.000Z`, value: 1, verification_status: null }] });
  const { reconcileReconstructedExactV3Hierarchies } = await import('../scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs');
  const mixed = reconcileReconstructedExactV3Hierarchies({ hierarchies: [one.v3_hierarchy, result.hierarchy] });
  const registry = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: mixed.latest });
  assert.deepEqual(registry.roots.map(r => r.exact_index_schema_version || 1).sort(), [1, 2]);
  assert.ok(one.v3_hierarchy.scoped_manifest.payload.source_aligned_scoped_manifest);
  assert.ok(result.hierarchy.scoped_manifest.payload.canonical_source_manifest);
  assert.equal(result.hierarchy.scoped_manifest.payload.source_aligned_scoped_manifest, undefined);
  assert.ok(result.hierarchy.publication_objects.every(a => [...a.dependencies, ...a.publication_prerequisites]
    .every(d => !d.key.includes('/_aligned/'))));
});

test('independent reconstruction inspector explicitly refuses schema 4 capability', async () => {
  const { inspectPinnedCanonicalObservationFilesV3 } = await import('../workers/shared/uk_aq_observation_history_target_writer.mjs');
  assert.throws(() => inspectPinnedCanonicalObservationFilesV3([], {
    historySchemaVersion: 4, writerVersion: 'parquet-wasm-zstd-v4' }), /schema 4 is unsupported/);
});
