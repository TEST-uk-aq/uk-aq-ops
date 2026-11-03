import './jsongen_test_environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { connectPruneOutboxReader } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from '../scripts/jsongen/prune-consumer-authentication.mjs';
import { consumePruneAcceptance } from '../scripts/jsongen/prune-consumer.mjs';
import { buildSelectedPruneEvent } from '../scripts/jsongen/prune-selected-event.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup } from '../scripts/jsongen/prune-receipts.mjs';
import { managedR2ReadConfig, managedR2WriteConfig } from '../scripts/jsongen/r2-config.mjs';
import { canonicalJson, CONTROL_KEY } from '../scripts/jsongen/schema.mjs';
import { selectManagedPublications } from '../scripts/jsongen/control.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryExactLeafIndexV3ScopedHierarchy } from '../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { preparePruneExactOnlyConnectorScopesV3, preparePruneExactOnlyBatchCompletionV3 }
  from '../workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs';
import { preparePruneOriginalFinalEvidenceWithExactOnlyCompletion } from '../scripts/jsongen/prune-final-evidence.mjs';
import { readCanonicalScopePages } from '../scripts/jsongen/authority.mjs';
import { currentScopeMatch } from '../scripts/jsongen/currentness.mjs';
import { getObservationHistoryGeneration } from '../workers/shared/uk_aq_observation_history_generation.mjs';

const env = { ...process.env, SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres',
  UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID: 'fixture-read', UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY: 'fixture-secret',
  UK_AQ_JSONGEN_R2_WRITE_ACCESS_KEY_ID: 'fixture-write', UK_AQ_JSONGEN_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' };
const G = getObservationHistoryGeneration('v3');
async function read(f, fn) {
  const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  try { return await fn(reader); } finally { await reader.close(); }
}
// Real credential-mode factories, fully intercepted local HTTP. No operational
// credentials, PostgreSQL, canonical network access, signer or external service.
async function transport(f, fn) {
  const previous = globalThis.fetch, writes = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); assert.equal(u.origin, env.UK_AQ_JSONGEN_R2_ENDPOINT);
    const key = decodeURIComponent(u.pathname.slice(`/${env.UK_AQ_JSONGEN_R2_BUCKET}/`.length));
    assert.ok(key.startsWith('managed/jsongen/v1/')); assert.ok(!key.endsWith('.parquet'));
    const old = f.objects.get(key), tag = body => `"${sha256Hex(body)}"`;
    if (init.method === 'PUT') {
      const h = new Headers(init.headers);
      if ((h.get('if-none-match') === '*' && old) || (h.get('if-match') && (!old || h.get('if-match') !== tag(old))))
        return new Response(null, { status: 412 });
      const body = Buffer.from(init.body); f.objects.set(key, body); writes.push(key);
      return new Response(null, { status: 200, headers: { etag: tag(body) } });
    }
    assert.equal(init.method, 'GET');
    return new Response(old || null, { status: old ? 200 : 404,
      headers: old ? { 'content-length': String(old.length), etag: tag(old) } : {} });
  };
  try { return await fn({ writes, readR2: managedR2ReadConfig(env), writeR2: managedR2WriteConfig(env) }); }
  finally { globalThis.fetch = previous; }
}

test('same-session producer proof, checked batch and committed outbox confirm the same complete all-pollutant PENDING dataset', async () => {
  const f = await sourceAndOriginalEvent(6, { exactOnly: true, evidenceBundle: true, pollutants: ['pm25', 'pm10', 'no2', 'o3'] });
  const fileReads = f.fileGets.length;
  await read(f, async reader => {
    const h = await authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2: f.r2 });
    const proof = inspectAuthenticatedPruneHandover(h);
    assert.equal(proof.result.dataset_state, 'CONFIRMED'); assert.equal(proof.result.dataset_id, f.pendingRef.key);
    assert.equal(proof.result.original_gate, 'authenticated_committed_immutable_outbox');
    assert.equal(proof.result.physical_scope_count, 6); assert.equal(proof.result.observation_count, 12);
    assert.equal(f.fileGets.length, fileReads, 'consumer never reads canonical Parquet');
    const group = buildSelectedPruneEvent({ handover: h });
    assert.equal(group.event.original.scope_count, 6); assert.equal(group.event.selected.scope_count, 5);
    assert.equal(group.event.unsupported.scope_count, 1);
    assert.ok(group.entries.every(e => e.receipt.schema_version === 3));
    assert.equal(proof.result.publication_eligible, false); assert.throws(selectManagedPublications);
    await transport(f, async ({ writes, readR2, writeR2 }) => {
      const preview = await consumePruneAcceptance({ reader, key: f.key, derivedR2: readR2 });
      assert.equal(preview.dataset_state, 'CONFIRMED'); assert.equal(preview.read_only_complete, true); assert.equal(writes.length, 0);
      const retained = await consumePruneAcceptance({ reader, key: f.key, derivedR2: writeR2, mode: 'retain', initializeControl: true });
      assert.equal(retained.state, 'registered', JSON.stringify(retained));
      const identities = new Map([...f.objects].map(([k, b]) => [k, sha256Hex(b)]));
      const replay = await consumePruneAcceptance({ reader, key: f.key, derivedR2: writeR2, mode: 'retain' });
      assert.equal(replay.registration_outcome, 'already_retained');
      assert.deepEqual(new Map([...f.objects].map(([k, b]) => [k, sha256Hex(b)])), identities);
      assert.ok(identities.has(CONTROL_KEY));
    });
  });
  f.setOperationHeld(false);
  await assert.rejects(preparePruneOriginalFinalEvidenceWithExactOnlyCompletion(f.preparationArgs), /operation lost/);
  await assert.rejects(preparePruneExactOnlyBatchCompletionV3({ preparedScopes: f.exactOnlyPreparedScopes,
    finalization: f.finalization, originalOperation: { ...f.originalOperation }, runId: f.row.run_id,
    expectedDays: [f.row.day_utc], expectedConnectorPublicationCount: 1, getObject: async () => assert.fail() }));
});

test('missing, mismatched, generic or forged nested completion cannot confirm an authentic pending source', async () => {
  const mutations = [
    e => { delete e.original_final_batch.exact_only_completion; },
    e => { e.original_final_batch.exact_only_completion.dataset_id += '/other'; },
    e => { e.original_final_batch.exact_only_completion.invocation_id = '11111111-1111-4111-8111-111111111111'; },
    e => { e.original_final_batch.exact_only_completion.schema_version = 1; },
    e => { e.original_final_batch.exact_only_completion.source_identity.source_content_hash = 'f'.repeat(64); },
    e => { e.original_final_batch.exact_only_completion.batch_finalization.latest_global_references[0].sha256 = 'f'.repeat(64); },
    e => { e.original_final_batch.exact_only_completion.scopes[0].leaves = []; },
    e => { e.original_final_batch.exact_only_completion.scopes[0].physical_identity.decode_profile_id = 'unknown'; },
    e => { e.original_final_batch.exact_only_completion.scopes[0].files[0].row_group_count++; },
    e => { e.original_final_batch.exact_only_completion.scopes[0].canonical_chain.pop(); },
  ];
  for (const mutateOriginal of mutations) {
    const f = await sourceAndOriginalEvent(2, { exactOnly: true, evidenceBundle: true, mutateOriginal });
    await read(f, async reader => assert.rejects(authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2: f.r2 })));
  }
  const f = await sourceAndOriginalEvent(2, { exactOnly: true, evidenceBundle: true });
  await assert.rejects(authenticatePruneHandover({ acceptance: { ...f.row, committed: true }, derivedR2: f.r2 }),
    { code: 'unauthenticated_original_outbox' });
  f.setBody(Buffer.from('corrupt pending gzip'));
  await read(f, async reader => assert.rejects(authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2: f.r2 })));
  f.setVisible(false);
  await read(f, reader => transport(f, async ({ readR2 }) => {
    const result = await consumePruneAcceptance({ reader, key: f.key, derivedR2: readR2 });
    assert.equal(result.state, 'incomplete'); assert.equal(result.dataset_state, undefined);
  }));
});

test('index-only schema-1 to schema-2 equivalence authenticates unchanged source without changing historical receipts', async () => {
  const f = await sourceAndOriginalEvent(3);
  await read(f, async reader => {
    const handover = await authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2: f.r2 });
    const proof = inspectAuthenticatedPruneHandover(handover);
    assert.equal(proof.result.dataset_state, undefined, 'schema-1 result meanings preserved');
    const historical = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover }));
    const originalBytes = historical.entries.map(e => canonicalJson(e.receipt));
    for (const c of f.currents) {
      const m = c.canonical_pollutant_manifest;
      const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: c.target_metadata, exactSchemaVersion: 2,
        canonicalManifest: { key: m.key, sha256: m.sha256, byte_size: m.byte_size, manifest_hash: m.payload.manifest_hash,
          row_count: m.payload.row_count, observation_content_hash: m.payload.observation_content_hash, observation_content_hash_version: 1 } });
      for (const a of hierarchy.publication_objects) f.canonicalObjects.set(a.key, Buffer.from(a.body));
    }
    const reads = [];
    const r2 = { bucket: 'canonical-test', adapter: { async getObjectBounded({ key }) {
      assert.ok(key.endsWith('.json')); reads.push(key);
      const body = f.canonicalObjects.get(key);
      if (!body) throw Object.assign(new Error('fixture absent'), { status: 404 });
      return { body, bytes: body.length, etag: '"fixture"' };
    } } };
    const scopes = Object.values(proof.scopes);
    const canonical = await readCanonicalScopePages({ r2, generation: G, scopes });
    assert.equal(canonical.read_consistent, true);
    assert.ok(canonical.scopes.every(s => s.physical?.exact_index_schema_version === 2 && !s.diagnostics.length), JSON.stringify(canonical.scopes));
    const change = { authentication: { authenticated: true }, original_scope_authorities: Object.values(proof.scopeAuthorities) };
    for (const s of canonical.scopes) {
      const item = { scope_key: s.scope_key, declared_state: 'present', declared_scope: proof.scopes[s.scope_key] };
      assert.equal(currentScopeMatch(change, item, canonical), 'matches');
      const changed = structuredClone(canonical); changed.scopes.find(n => n.scope_key === s.scope_key).physical.canonical_source.sha256 = 'f'.repeat(64);
      assert.equal(currentScopeMatch(change, item, changed), 'unavailable');
    }
    assert.ok(!reads.some(k => k.includes('/_aligned/')));
    assert.deepEqual(historical.entries.map(e => canonicalJson(e.receipt)), originalBytes);
    assert.equal(f.objects.size, 1, 'conversion metadata inspection creates no PENDING, receipt or publication');
    const selectorKey = f.currents[0].v3_hierarchy.scoped_manifest.key;
    const selector = JSON.parse(f.canonicalObjects.get(selectorKey)); selector.history_schema_version = 4;
    f.canonicalObjects.set(selectorKey, Buffer.from(JSON.stringify(selector)));
    const blocked = await readCanonicalScopePages({ r2, generation: G, scopes });
    assert.ok(blocked.scopes.every(s => s.diagnostics.length > 0));
  });
});

test('normal schema-1 owning-writer seam performs no optional physical reads or original-session calls', async () => {
  const f = await sourceAndOriginalEvent(1);
  const prepared = await preparePruneExactOnlyConnectorScopesV3({ partitions: f.currents,
    canonical: null, originalOperation: { assertHeld: () => assert.fail() }, getObject: () => assert.fail() });
  assert.deepEqual(prepared, []);
});
