// Focused local regressions for complete original authority and the read-only
// boundary. All HTTP calls terminate in the in-memory fixture below.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UK_AQ_ENV_NAME = 'TEST';
process.env.UK_AQ_JSONGEN_R2_BUCKET = 'fixture-derived-bucket';
process.env.UK_AQ_JSONGEN_R2_ENDPOINT = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
const { sourceAndOriginalEvent } = await import('./jsongen_prune_consumer_fixture.mjs');
const { connectPruneOutboxReader } = await import('../scripts/jsongen/prune-outbox-reader.mjs');
const { consumePruneAcceptance, pruneConsumerExitCode } = await import('../scripts/jsongen/prune-consumer.mjs');
const { assertReadOnlyPruneReport, isReadOnlyPruneSuccess } = await import('../scripts/jsongen/prune-consumer-outcome.mjs');
const { managedR2ReadConfig, managedR2WriteConfig } = await import('../scripts/jsongen/r2-config.mjs');
const { createPruneHandoverBudget } = await import('../scripts/jsongen/limits.mjs');
const { pruneOriginalPhysicalKey, pruneOriginalPhysicalDigest } = await import('../scripts/jsongen/prune-original-identity.mjs');
const { scopeKey, assertIdentity } = await import('../scripts/jsongen/schema.mjs');
const { physicalScopeDigest } = await import('../scripts/jsongen/scope-authority.mjs');
const { authenticatePruneHandover } = await import('../scripts/jsongen/prune-consumer-authentication.mjs');
const { buildPruneReceiptGroup, inspectPruneReceiptGroup } = await import('../scripts/jsongen/prune-receipts.mjs');
const { assertPruneReceiptGroup } = await import('../scripts/jsongen/schema.mjs');
const env = { ...process.env, UK_AQ_GITHUB_REPO: 'fixture-org/fixture-ops',
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres',
  UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID: 'fixture-read', UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY: 'fixture-secret',
  UK_AQ_JSONGEN_R2_WRITE_ACCESS_KEY_ID: 'fixture-write', UK_AQ_JSONGEN_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' };

async function fixture(options, run) {
  const f = await sourceAndOriginalEvent(options.scopes ?? 4, { evidenceBundle: true,
    ...options, r2Endpoint: env.UK_AQ_JSONGEN_R2_ENDPOINT });
  const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const previous = globalThis.fetch;
  const reads = []; let writes = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method !== 'GET') { writes++; throw new Error('Unexpected write in Stage 1'); }
    const u = new URL(url); assert.equal(u.origin, env.UK_AQ_JSONGEN_R2_ENDPOINT);
    const key = decodeURIComponent(u.pathname.slice(`/${env.UK_AQ_JSONGEN_R2_BUCKET}/`.length));
    assert.ok(key.startsWith('managed/jsongen/v1/')); assert.ok(!key.endsWith('.parquet'));
    reads.push(key);
    const body = f.objects.get(key);
    return new Response(body || null, { status: body ? 200 : 404,
      headers: body ? { 'content-length': String(body.length), etag: '"fixture"' } : {} });
  };
  try { await run({ f, reader, reads, writes: () => writes, derivedR2: managedR2ReadConfig(env) }); }
  finally { globalThis.fetch = previous; await reader.close(); }
}

test('all 37 original pollutants authenticate, selected coverage is deterministic and no object is written', async () => {
  const pollutants = ['123c6h3ch33', '124c6h3ch33', '135c6h3ch33', 'c2h6', 'c6h14', 'c6h5c2h5', 'c6h5ch3',
    'c6h6', 'c7h16', 'c8h18', 'ch2chcch3ch2', 'ch2chch3', 'ch2chchch2', 'ch32chch2ch2ch3', 'ch33cch2chch32',
    'cish3cchchch3', 'co', 'h2cch2', 'h2cchch2ch2ch3', 'h2cchch2ch3', 'h3cch23ch3', 'h3cch2ch2ch3', 'h3cch2ch3',
    'h3cch2chch32', 'h3cchch32', 'hcch', 'mpc6h4ch32', 'no', 'no2', 'nox_as_no2', 'o3', 'oc6h4ch32',
    'pm10', 'pm25', 'so2', 'transh3cchchch3', 'transh3chcchch2ch3'];
  await fixture({ scopes: 37, pollutants }, async ({ f, reader, reads, writes, derivedR2 }) => {
    const before = [...f.objects.keys()];
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    assert.equal(r.state, 'authenticated_read_only', JSON.stringify(r));
    assertReadOnlyPruneReport(r); assert.equal(pruneConsumerExitCode(r), 0);
    assert.deepEqual([r.coverage.original.pollutant_count, r.physical_scope_count, r.observation_count], [37, 37, 74]);
    assert.deepEqual([r.coverage.selected.scope_count, r.coverage.selected.observation_count], [3, 6]);
    assert.deepEqual([r.coverage.unsupported.scope_count, r.coverage.unsupported.observation_count], [34, 68]);
    assert.equal(r.partitions.partition_count, 3);
    assert.equal(r.coverage.scopes.filter(s => s.disposition === 'authenticated_not_selected_unsupported_pollutant').length, 34);
    assert.equal(r.receipt_eligible, false); assert.equal(r.handover_complete, false);
    assert.equal(reads.length, 2); assert.equal(r.metrics.private_r2_get_attempts, 2);
    assert.equal(r.metrics.private_r2_response_body_bytes, [...f.objects.values()].reduce((n, b) => n + b.length, 0));
    assert.ok(r.metrics.authentication_elapsed_ms >= 0 && r.metrics.sampled_peak_heap_used_bytes > 0);
    assert.ok(r.metrics.process_max_rss_bytes > 0 && r.metrics.cpu_user_ms >= 0);
    assert.equal(r.coverage.descriptor_preview.persisted, false);
    assert.doesNotMatch(JSON.stringify(r), /"rows":\[|bytes_base64|1\.2345678901234567|signed_url|source_status":"R"/);
    const replay = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    assert.deepEqual(replay.coverage, r.coverage);
    const retain = await consumePruneAcceptance({ reader, key: f.key, derivedR2: managedR2WriteConfig(env), mode: 'retain' });
    assert.equal(retain.reason, 'unsupported_receipt_scope'); assert.equal(retain.receipt_retention, 'not_attempted');
    assert.equal(writes(), 0); assert.deepEqual([...f.objects.keys()], before);
  });
});

test('corrupt original binding for an unsupported pollutant invalidates the whole event', async () => {
  await fixture({ pollutants: ['pm25', 'o3'], mutateOriginal: e => {
    e.original_authority_extension.binding.bindings.find(b => b.identity.pollutant_code === 'o3').identity.station_id += 100;
  } }, async ({ f, reader, writes, derivedR2 }) => {
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    assert.equal(r.state, 'reconciliation_required'); assert.equal(r.reason, 'invalid_original_scope_authority');
    assert.equal(r.failure_stage, 'original_physical_scope_binding');
    assert.equal(pruneConsumerExitCode(r), 2); assert.equal(r.receipt_retention, 'not_attempted');
    assert.equal(writes(), 0); assert.equal(r.coverage, undefined);
  });
});

test('zero selected scopes is successful authenticated planning without an empty receipt', async () => {
  await fixture({ pollutants: ['o3', 'so2'] }, async ({ f, reader, writes, derivedR2 }) => {
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    assertReadOnlyPruneReport(r); assert.equal(pruneConsumerExitCode(r), 0);
    assert.equal(r.coverage.state, 'no_selected_scopes'); assert.equal(r.coverage.selected.scope_count, 0);
    assert.equal(r.coverage.unsupported.scope_count, r.physical_scope_count);
    assert.equal(r.partitions.partition_count, 0); assert.equal(r.expected_receipts, undefined); assert.equal(writes(), 0);
  });
});

test('existing complete supported schema-2 receipt group remains valid and wholly unretained', async () => {
  await fixture({ scopes: 3, pollutants: ['no2', 'pm10', 'pm25'] }, async ({ f, reader, writes, derivedR2 }) => {
    const handover = await authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2 });
    const group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover }));
    assertPruneReceiptGroup(group.entries.map(e => e.receipt));
    assert.ok(group.entries.every(e => e.receipt.schema_version === 2 && e.receipt.origin.scope_count === 3
      && e.receipt.origin.row_count === 6));
    assert.equal(writes(), 0); assert.equal(f.objects.size, 2);
  });
});

test('selected partition planning retains whole scopes and existing 128-scope limits', async () => {
  await fixture({ scopes: 257, pollutants: ['pm25', 'o3'] }, async ({ f, reader, derivedR2 }) => {
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    assertReadOnlyPruneReport(r);
    assert.deepEqual(r.partitions.partitions.map(p => p.scope_count), [128, 1]);
    assert.equal(r.coverage.selected.observation_count, 258); assert.equal(r.observation_count, 514);
  });
});

test('CLI/workflow outcome validation rejects partial pages, forged counts, writes and zero-exit-like state alone', async () => {
  await fixture({ pollutants: ['pm25', 'o3'] }, async ({ f, reader, derivedR2 }) => {
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2 });
    const report = { schema_version: 1, kind: 'uk_aq_jsongen_prune_consumer_discovery', state: 'authenticated_read_only',
      read_only_complete: true, handover_complete: false, publication_eligible: false, discovery_coverage_complete: false,
      discovery: { coverage_complete: false, events: [{ key: f.key, event_id: r.event_id }] }, results: [r] };
    assertReadOnlyPruneReport(report); assert.equal(pruneConsumerExitCode(report), 0);
    for (const mutate of [x => { x.results = []; }, x => { x.results[0].coverage.original.observation_count++; },
      x => { x.results[0].registration = 'registered'; }, x => { delete x.results[0].metrics; },
      x => { x.results[0].coverage.scopes.pop(); },
      x => { x.results[0].coverage.partitions.partitions[0].binding.scopes.pop(); }]) {
      const bad = structuredClone(report); mutate(bad); assert.equal(isReadOnlyPruneSuccess(bad), false);
      assert.equal(pruneConsumerExitCode(bad), 2);
    }
    assert.equal(pruneConsumerExitCode({ state: 'authenticated_read_only' }), 2);
  });
});

test('resource exhaustion stays non-success and supported physical digests retain their meaning', async () => {
  await fixture({ pollutants: ['pm25', 'o3'] }, async ({ f, reader, derivedR2 }) => {
    const r = await consumePruneAcceptance({ reader, key: f.key, derivedR2,
      budget: createPruneHandoverBudget({ total_bytes: 1 }) });
    assert.equal(r.reason, 'resource_limit'); assert.equal(pruneConsumerExitCode(r), 2);
  });
  const scope = { identity: { connector_id: 1, timeseries_id: 1, station_id: 1, pollutant_code: 'pm25' }, day_utc: '2026-10-15' };
  const leaf = { ...scope.identity, day_utc: scope.day_utc, history_schema_version: 3, writer_version: 'parquet-wasm-zstd-v3',
    physical_layout_version: 'timeseries-aligned-v2', row_count: 1, min_observed_at_utc: '2026-10-15T00:00:00.000Z',
    max_observed_at_utc: '2026-10-15T00:00:00.000Z', files: [], segments: [] };
  assert.equal(pruneOriginalPhysicalKey(scope), scopeKey(scope));
  assert.equal(pruneOriginalPhysicalDigest(scope, leaf), physicalScopeDigest(scope, leaf));
  assert.throws(() => assertIdentity({ ...scope.identity, pollutant_code: 'o3' }));
});
