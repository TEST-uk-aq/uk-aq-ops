// Bounded identity/configuration regressions. TEST/LIVE below are synthetic
// labels over in-memory fixtures; no real database, R2 or other service access.
import './jsongen_test_environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { assertOpsEnvironment } from '../scripts/jsongen/admission.mjs';
import { managedR2ReadConfig, managedR2WriteConfig } from '../scripts/jsongen/r2-config.mjs';
import { connectPruneOutboxReader, assertPruneAcceptanceKey } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { authenticatePruneHandover } from '../scripts/jsongen/prune-consumer-authentication.mjs';
import { consumePruneAcceptance } from '../scripts/jsongen/prune-consumer.mjs';
import { buildSelectedPruneEvent, authenticateSelectedPruneInput, retainSelectedPruneEvent } from '../scripts/jsongen/prune-selected-event.mjs';
import { prunePartitionArtifacts } from '../scripts/jsongen/prune-consumer-partitions.mjs';
import { updateManagedControl, readManagedControl } from '../scripts/jsongen/control.mjs';
import { canonicalJson, assertReceipt, assertPruneAcceptanceAuthority } from '../scripts/jsongen/schema.mjs';
import { assertPruneEventDescriptor } from '../scripts/jsongen/prune-event-schema.mjs';
import { readReceipt, readPruneEventDescriptor } from '../scripts/jsongen/inputs.mjs';
import { createPruneHandoverBudget } from '../scripts/jsongen/limits.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';

const config = environment => ({ ...process.env, UK_AQ_ENV_NAME: environment,
  UK_AQ_GITHUB_REPO: 'fixture-org/fixture-ops', GITHUB_ACTIONS: undefined, GITHUB_REPOSITORY: undefined,
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres',
  UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID: 'fixture-read', UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY: 'fixture-secret',
  UK_AQ_JSONGEN_R2_WRITE_ACCESS_KEY_ID: 'fixture-write', UK_AQ_JSONGEN_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' });
async function fixture(environment, run, { scopes = 7, pollutants = ['no2', 'pm25', 'o3'] } = {}) {
  const env = config(environment);
  const f = await sourceAndOriginalEvent(scopes, { environment, pollutants, evidenceBundle: true,
    r2Endpoint: env.UK_AQ_JSONGEN_R2_ENDPOINT });
  const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const readR2 = managedR2ReadConfig(env), writeR2 = managedR2WriteConfig(env);
  const previous = globalThis.fetch, puts = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(url); assert.equal(target.origin, env.UK_AQ_JSONGEN_R2_ENDPOINT);
    const key = decodeURIComponent(target.pathname.slice(`/${env.UK_AQ_JSONGEN_R2_BUCKET}/`.length));
    assert.ok(key.startsWith('managed/jsongen/v1/')); assert.ok(!key.endsWith('.parquet'));
    const old = f.objects.get(key), etag = body => `"${sha256Hex(body)}"`;
    if (init.method === 'PUT') {
      const h = new Headers(init.headers); puts.push(key);
      if ((h.get('if-none-match') === '*' && old) || (h.get('if-match') && (!old || h.get('if-match') !== etag(old))))
        return new Response(null, { status: 412 });
      const body = Buffer.from(init.body); f.objects.set(key, body);
      return new Response(null, { headers: { etag: etag(body) } });
    }
    assert.equal(init.method, 'GET');
    return new Response(old || null, { status: old ? 200 : 404,
      headers: old ? { etag: etag(old), 'content-length': String(old.length) } : {} });
  };
  try { await run({ env, f, reader, readR2, writeR2, puts }); }
  finally { globalThis.fetch = previous; await reader.close(); }
}

test('unknown or malformed selected input rejects with controlled conflicting_selected_receipt before artifact access', async () => {
  await fixture('TEST', async c => {
    const h = await authenticatePruneHandover({ acceptance: await c.reader.read(c.f.key), derivedR2: c.readR2 });
    const event = buildSelectedPruneEvent({ handover: h }), entry = event.entries[0];
    const input = { ...entry, bundle: { integrity: 'verified', records: prunePartitionArtifacts(event.plan)[0].records } };
    assert.equal(authenticateSelectedPruneInput({ input, handover: h }).authenticated, true);
    for (const bad of [null, {}, { ...input, receipt: null },
      { ...input, receipt: { ...entry.receipt, change_id: 'unknown-selected-change' } }]) {
      assert.throws(() => authenticateSelectedPruneInput({ input: bad, handover: h }),
        { name: 'JSONgenEvidenceError', code: 'conflicting_selected_receipt' });
    }
    assert.throws(() => authenticateSelectedPruneInput({ input, handover: { ...h } }), { code: 'unauthenticated_original_outbox' });
    assert.equal(c.puts.length, 0);
  });
});

test('explicit canonical environment and repository/manual admission have no inferred or default environment', () => {
  for (const environment of [undefined, null, '', ' ', 'test', 'TEST ', 'TEST\n', 1, 'A'.repeat(33)]) {
    const env = config(environment);
    assert.throws(() => assertOpsEnvironment(env), { code: 'unapproved_environment' });
    assert.throws(() => managedR2ReadConfig(env), { code: 'invalid_r2_configuration' });
  }
  for (const environment of ['TEST', 'LIVE']) assert.doesNotThrow(() => assertOpsEnvironment(config(environment)));
  for (const env of [{ ...config('TEST'), UK_AQ_GITHUB_REPO: '' },
    { ...config('TEST'), GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'another/repository', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { ...config('TEST'), GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture-org/fixture-ops', GITHUB_EVENT_NAME: 'push' }])
    assert.throws(() => assertOpsEnvironment(env), { code: 'unapproved_environment' });
  assert.throws(() => managedR2ReadConfig({ ...config('TEST'), UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID: undefined }),
    { code: 'invalid_r2_configuration' });
  assert.throws(() => managedR2WriteConfig({ ...config('TEST'), CFLARE_R2_ACCESS_KEY_ID: 'fixture-write' }),
    { code: 'invalid_r2_configuration' });
});

test('reader binds key/cursor and SQL discovery parameters to configured environment and Supabase project', async () => {
  await fixture('TEST', async c => {
    const from = '2026-10-10T01:00:00.000Z', to = '2026-10-10T03:00:00.000Z';
    const after = { from, to, mode: 'resweep', accepted_at: c.f.row.accepted_at, key: c.f.key };
    await c.reader.discover({ from, to, mode: 'resweep', limit: 1, after });
    const q = c.f.queries.findLast(q => q.sql.includes('ORDER BY'));
    assert.match(q.sql, /WHERE environment=\$1/); assert.doesNotMatch(q.sql, /environment='TEST'/);
    assert.match(q.sql, /LIMIT \$4/); assert.match(q.sql, /\$5::timestamptz,\$6::uuid,\$7::uuid,\$8::date,\$9::integer/);
    assert.deepEqual(q.args, ['TEST', from, to, 2, after.accepted_at, c.f.key.run_id, c.f.key.attempt_id, c.f.key.day_utc, 1]);
    const before = c.f.queries.length;
    const other = { ...c.f.key, environment: 'LIVE' };
    assert.doesNotThrow(() => assertPruneAcceptanceKey(other)); // Pure shape is not runtime authority.
    await assert.rejects(c.reader.read(other), { code: 'cross_environment_evidence' });
    await assert.rejects(c.reader.discover({ from, to, mode: 'resweep', after: { ...after, key: other } }), { code: 'cross_environment_evidence' });
    assert.equal(c.f.queries.length, before);
    await assert.rejects(connectPruneOutboxReader({ env: { ...c.env,
      UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.bbbbbbbbbbbbbbbbbbbb.supabase.co/postgres' }, Client: c.f.Client }),
    { code: 'reader_configuration_required' });
    c.f.row.environment = 'LIVE';
    await assert.rejects(c.reader.discover({ from, to }), { code: 'cross_environment_evidence' });
  });
});

test('one shared consumer authenticates a synthetic LIVE source only with matching explicit configuration', async () => {
  await fixture('LIVE', async c => {
    const h = await authenticatePruneHandover({ acceptance: await c.reader.read(c.f.key), derivedR2: c.readR2 });
    const event = buildSelectedPruneEvent({ handover: h });
    assertPruneEventDescriptor(event.descriptor); event.entries.forEach(e => assertReceipt(e.receipt));
    assertPruneAcceptanceAuthority(event.original_authority);
    assert.equal(event.original_authority.key.environment, 'LIVE');
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.writeR2, mode: 'retain', initializeControl: true });
    assert.equal(r.state, 'registered', JSON.stringify(r)); assert.equal(r.publication_eligible, false);
    assert.equal(r.coverage_summary.original.scope_count, 7); assert.equal(r.coverage_summary.selected.scope_count, 5);
  });
});

test('configuration/source mismatches reject at authentication, retention, readback and control without granting authority', async () => {
  await fixture('TEST', async c => {
    const acceptance = await c.reader.read(c.f.key), otherRead = managedR2ReadConfig(config('LIVE')),
      otherWrite = managedR2WriteConfig(config('LIVE'));
    await assert.rejects(authenticatePruneHandover({ acceptance, derivedR2: otherRead }), { code: 'cross_environment_evidence' });
    const budget = createPruneHandoverBudget();
    const h = await authenticatePruneHandover({ acceptance, derivedR2: c.readR2, budget });
    await assert.rejects(retainSelectedPruneEvent({ handover: h, r2: otherWrite, budget }), { code: 'cross_environment_evidence' });
    assert.equal(c.puts.length, 0);
    const token = await retainSelectedPruneEvent({ handover: h, r2: c.writeR2, budget });
    const event = buildSelectedPruneEvent({ handover: h, budget });
    await assert.rejects(readPruneEventDescriptor({ r2: otherRead, reference: event.descriptor_object }), { code: 'cross_environment_evidence' });
    await assert.rejects(readReceipt({ r2: otherRead, reference: event.entries[0].receipt_object }), { code: 'cross_environment_evidence' });
    const count = c.puts.length;
    await assert.rejects(updateManagedControl({ r2: otherWrite, command: { type: 'retain_selected_prune_event' },
      authenticatedSelectedEvent: token, budget }), /configured control environment/);
    assert.equal(c.puts.length, count);
    const registered = await consumePruneAcceptance({ reader: c.reader, key: c.f.key,
      derivedR2: c.writeR2, mode: 'retain', initializeControl: true });
    assert.equal(registered.state, 'registered');
    await assert.rejects(readManagedControl(otherRead), { code: 'cross_environment_evidence' });
    const original = JSON.parse(c.f.row.final_evidence_bytes);
    for (const mutate of [e => { e.environment = 'LIVE'; },
      e => { e.original_metadata_evidence.identity.environment = 'LIVE'; }]) {
      const envelope = structuredClone(original); mutate(envelope); c.f.setEnvelope(envelope);
      await assert.rejects(authenticatePruneHandover({ acceptance: await c.reader.read(c.f.key), derivedR2: c.readR2 }),
        { code: 'contradictory_original_evidence' });
    }
    const { encodePruneEvidenceBundle } = await import('../scripts/jsongen/prune-evidence-bundle.mjs');
    const { gunzipSync } = await import('node:zlib');
    const payload = JSON.parse(gunzipSync(c.f.objects.get(original.original_metadata_evidence.reference.key)));
    payload.original_final_evidence.original_authority_extension.identity.environment = 'LIVE';
    assert.throws(() => encodePruneEvidenceBundle(payload.original_final_evidence),
      { original_authority_code: 'evidence_bundle_environment_mismatch' });
  });
});

test('unchanged TEST golden derivations preserve original/descriptor/partition/bundle/receipt identities byte-for-byte', async () => {
  await fixture('TEST', async c => {
    const acceptance = await c.reader.read(c.f.key);
    const h = await authenticatePruneHandover({ acceptance, derivedR2: c.readR2 });
    const event = buildSelectedPruneEvent({ handover: h });
    const vector = { acceptance_id: acceptance.event_id, acceptance_sha256: sha256Hex(canonicalJson(c.f.row)),
      post_commit_sha256: acceptance.post_commit_reference.sha256,
      original_objects: [...c.f.objects].map(([key, body]) => ({ key, sha256: sha256Hex(body), byte_size: body.length })),
      descriptor: event.descriptor_object, group_sha256: event.group_sha256, partitions: event.plan.partitions, receipts: event.entries };
    // Captured twice from reviewed a75f696 before any follow-up edits. All wire
    // bytes/digests participate; no runtime-only configuration fields are added.
    assert.equal(sha256Hex(canonicalJson(vector)), '2bee3bd8d5a83d67eb50fb896129c0ce48184eea60ad515888c481640b1717bc');
  }, { scopes: 37, pollutants: ['no2', 'pm10', 'pm25', 'o3', 'so2'] });
});
