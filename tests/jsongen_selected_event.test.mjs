// Targeted high-risk descriptor/complete-group/CAS boundary. No service I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.UK_AQ_ENV_NAME = 'TEST';
process.env.UK_AQ_JSONGEN_R2_BUCKET = 'fixture-derived-bucket';
process.env.UK_AQ_JSONGEN_R2_ENDPOINT = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
const { sourceAndOriginalEvent } = await import('./jsongen_prune_consumer_fixture.mjs');
const { connectPruneOutboxReader } = await import('../scripts/jsongen/prune-outbox-reader.mjs');
const { authenticatePruneHandover } = await import('../scripts/jsongen/prune-consumer-authentication.mjs');
const { consumePruneAcceptance } = await import('../scripts/jsongen/prune-consumer.mjs');
const { buildSelectedPruneEvent, retainSelectedPruneEvent } = await import('../scripts/jsongen/prune-selected-event.mjs');
const { buildPruneReceiptGroup, inspectPruneReceiptGroup, retainPruneReceiptGroup } = await import('../scripts/jsongen/prune-receipts.mjs');
const { assertPruneEventDescriptor, assertDescriptorReceipts, assertSelectedReceiptGroup } = await import('../scripts/jsongen/prune-event-schema.mjs');
const { assertControl, canonicalJson, CONTROL_KEY, createControl } = await import('../scripts/jsongen/schema.mjs');
const { updateManagedControl, readManagedControl, selectManagedPublications } = await import('../scripts/jsongen/control.mjs');
const { managedR2WriteConfig } = await import('../scripts/jsongen/r2-config.mjs');
const { createPruneHandoverBudget } = await import('../scripts/jsongen/limits.mjs');
const { sha256Hex } = await import('../workers/shared/r2_sigv4.mjs');
const env = { ...process.env, UK_AQ_GITHUB_REPO: 'fixture-org/fixture-ops',
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres',
  UK_AQ_JSONGEN_R2_WRITE_ACCESS_KEY_ID: 'fixture-write', UK_AQ_JSONGEN_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' };
const etag = body => `"${sha256Hex(body)}"`;
async function fixture(options, run) {
  const f = await sourceAndOriginalEvent(options.scopes ?? 9, { evidenceBundle: true, ...options,
    r2Endpoint: env.UK_AQ_JSONGEN_R2_ENDPOINT });
  const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const r2 = managedR2WriteConfig(env), previous = globalThis.fetch;
  const writes = [], controls = [];
  const hooks = {};
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); assert.equal(u.origin, env.UK_AQ_JSONGEN_R2_ENDPOINT);
    const key = decodeURIComponent(u.pathname.slice(`/${env.UK_AQ_JSONGEN_R2_BUCKET}/`.length));
    assert.ok(key.startsWith('managed/jsongen/v1/')); assert.ok(!key.endsWith('.parquet'));
    if (init.method === 'PUT') {
      writes.push(key);
      if (hooks.put) { const response = await hooks.put(key, init); if (response) return response; }
      const old = f.objects.get(key), headers = new Headers(init.headers);
      if ((headers.get('if-none-match') === '*' && old)
        || (headers.get('if-match') && (!old || headers.get('if-match') !== etag(old)))) return new Response(null, { status: 412 });
      const body = Buffer.from(init.body); f.objects.set(key, body);
      if (key === CONTROL_KEY) controls.push(assertControl(JSON.parse(body)));
      if (hooks.afterPut) await hooks.afterPut(key, init);
      return new Response(null, { status: 200, headers: { etag: etag(body) } });
    }
    assert.equal(init.method, 'GET');
    const body = f.objects.get(key);
    return new Response(body || null, { status: body ? 200 : 404,
      headers: body ? { 'content-length': String(body.length), etag: etag(body) } : {} });
  };
  const budget = createPruneHandoverBudget();
  try { await run({ f, reader, r2, budget, writes, controls, hooks }); }
  finally { globalThis.fetch = previous; await reader.close(); }
}
const handoverFor = async c => authenticatePruneHandover({ acceptance: await c.reader.read(c.f.key), derivedR2: c.r2, budget: c.budget });

test('strict descriptor and selected receipts bind complete original evidence; partial groups and forged capabilities reject', async () => {
  await fixture({ pollutants: ['pm25', 'pm10', 'no2', 'o3'] }, async c => {
    const handover = await handoverFor(c), event = buildSelectedPruneEvent({ handover, budget: c.budget });
    assertPruneEventDescriptor(event.descriptor);
    assertDescriptorReceipts(event.descriptor, event.descriptor_object, event.entries.map(e => e.receipt));
    assert.equal(event.event.original.scope_count, 9); assert.equal(event.event.selected.scope_count, 7);
    assert.equal(event.event.original.observation_count, 18); assert.equal(event.event.selected.observation_count, 14);
    assert.equal(event.entries.length, 3); assert.ok(event.entries.every(e => e.receipt.schema_version === 3));
    assert.doesNotMatch(JSON.stringify(event.descriptor), /"rows":|bytes_base64/);
    const receipts = event.entries.map(e => e.receipt);
    assert.throws(() => assertSelectedReceiptGroup(receipts.slice(1), event.descriptor_object, event.event, event.original_authority), /complete/);
    assert.throws(() => assertDescriptorReceipts(event.descriptor, { ...event.descriptor_object, sha256: '0'.repeat(64) }, receipts));
    const changed = structuredClone(event.descriptor); changed.coverage.scopes[0].extra = true;
    assert.throws(() => assertPruneEventDescriptor(changed));
    await assert.rejects(updateManagedControl({ r2: c.r2, command: { type: 'retain_selected_prune_event' },
      authenticatedSelectedEvent: { ...event } }), /capability/);
    assert.equal(c.writes.length, 0);
  });
});

test('v1 migration is one complete CAS; exact replay preserves revision; partial/conflicting control rejects', async () => {
  await fixture({ pollutants: ['pm25', 'pm10', 'no2', 'o3'] }, async c => {
    const baseline = createControl(); baseline.failure = { code: 'invalid_provenance', state: 'reconcile_required',
      at_utc: baseline.updated_at_utc, detail: 'Preserve unrelated failure' };
    const original = canonicalJson(baseline); c.f.objects.set(CONTROL_KEY, original);
    const result = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain', budget: c.budget });
    assert.equal(result.state, 'registered', JSON.stringify(result));
    assert.equal(result.descriptor_retention, 'retained'); assert.equal(result.publication_eligible, false);
    const control = JSON.parse(c.f.objects.get(CONTROL_KEY));
    assert.equal(control.schema_version, 2); assert.equal(control.control_id, baseline.control_id);
    assert.equal(control.previous.sha256, sha256Hex(original)); assert.equal(control.revision, 1);
    assert.deepEqual(control.failure, baseline.failure); assert.equal(c.controls.length, 1);
    assert.equal(Object.keys(control.authenticated_events).length, 1); assert.equal(Object.keys(control.registered_changes).length, 3);
    const incomplete = structuredClone(control); delete incomplete.registered_changes[Object.keys(incomplete.registered_changes)[0]];
    assert.throws(() => assertControl(incomplete));
    const conflict = structuredClone(control); conflict.authenticated_events[result.event_id].descriptor.sha256 = '0'.repeat(64);
    assert.throws(() => assertControl(conflict));
    const replay = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(replay.state, 'registered', JSON.stringify(replay)); assert.equal(replay.registration_outcome, 'already_retained');
    assert.equal(replay.control_operation.revision, 1); assert.equal(c.controls.length, 1);
    assert.throws(selectManagedPublications, { code: 'verified_event_ordering_unavailable' });
  });
});

test('authenticated zero-selected event registers descriptor without bundle, receipt, month or publication work', async () => {
  await fixture({ pollutants: ['o3', 'so2'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(r.state, 'registered', JSON.stringify(r));
    const control = assertControl(JSON.parse(c.f.objects.get(CONTROL_KEY)));
    assert.equal(r.coverage_summary.state, 'no_selected_scopes'); assert.equal(r.receipt_eligible, false);
    assert.deepEqual(control.months, {}); assert.deepEqual(control.registered_changes, {});
    assert.equal(c.writes.length, 2); assert.equal(Object.keys(control.authenticated_events).length, 1);
    const e = control.authenticated_events[r.event_id];
    assert.throws(() => assertSelectedReceiptGroup([], e.descriptor, { ...e.event, state: 'selected_coverage_planned',
      selected: { ...e.event.selected, scope_count: 1 } }, e.authority));
  });
});

test('partial immutable retention never registers; exact replay resolves orphan objects', async () => {
  await fixture({ pollutants: ['pm25', 'no2', 'o3'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl())); let failed = false;
    c.hooks.put = key => { if (key.includes('/receipts/') && !failed) { failed = true; return new Response(null, { status: 403 }); } };
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(r.state, 'reconciliation_required'); assert.equal(c.controls.length, 0);
    c.hooks.put = null;
    const replay = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(replay.state, 'registered', JSON.stringify(replay)); assert.equal(c.controls.length, 1);
  });
});

test('CAS conflict preserves unrelated state; lost acknowledgment resolves by exact readback without another PUT', async () => {
  await fixture({ pollutants: ['pm25', 'no2', 'o3'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl())); let conflict = false, lost = false;
    c.hooks.put = key => {
      if (key !== CONTROL_KEY || conflict) return;
      conflict = true; const control = JSON.parse(c.f.objects.get(key));
      const old = Buffer.from(c.f.objects.get(key)); control.revision++; control.previous = { revision: control.revision - 1,
        operation_id: control.operation_id, sha256: sha256Hex(old) }; control.operation_id = 'b2b3ea99-676f-49d0-ab98-f90a0737934d';
      control.failure = { code: 'invalid_provenance', state: 'reconcile_required', at_utc: control.updated_at_utc, detail: 'Concurrent failure' };
      c.f.objects.set(key, canonicalJson(control)); return new Response(null, { status: 412 });
    };
    c.hooks.afterPut = key => { if (key === CONTROL_KEY && !lost) { lost = true; throw new Error('lost acknowledgement'); } };
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(r.state, 'registered', JSON.stringify(r)); assert.equal(r.registration_outcome, 'confirmed_after_ambiguous_write');
    assert.equal(c.writes.filter(k => k === CONTROL_KEY).length, 2);
    assert.equal(JSON.parse(c.f.objects.get(CONTROL_KEY)).failure.detail, 'Concurrent failure');
  });
});

test('existing schema-2 event replays unchanged instead of creating a selected duplicate', async () => {
  await fixture({ pollutants: ['pm25', 'no2'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const handover = await handoverFor(c), group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover, budget: c.budget }));
    const token = await retainPruneReceiptGroup({ handover, r2: c.r2, budget: c.budget });
    await updateManagedControl({ r2: c.r2, command: { type: 'retain_prune_event' }, authenticatedPruneEvent: token, budget: c.budget });
    const before = await readManagedControl(c.r2);
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(r.state, 'registered', JSON.stringify(r)); assert.equal(r.registration_outcome, 'already_retained');
    assert.equal((await readManagedControl(c.r2)).sha256, before.sha256);
    assert.equal(r.descriptor_retention, 'not_attempted'); assert.equal(group.entries[0].receipt.schema_version, 2);
    const { reconcileManagedInputs } = await import('../scripts/jsongen/reconcile.mjs');
    const legacyReport = await reconcileManagedInputs({ derivedR2: c.r2, control: before.control, controlRead: before, pruneReader: c.reader });
    assert.equal(legacyReport.schema_version, 3);
    assert.ok(legacyReport.changes.every(x => x.authentication?.authenticated));
  });
});

test('selected reconciliation reads descriptor and fresh source, reports original versus selected coverage, and fails closed without them', async () => {
  const { reconcileManagedInputs, reconciliationArtifact } = await import('../scripts/jsongen/reconcile.mjs');
  const { assertReconciliationReport } = await import('../scripts/jsongen/report-validation.mjs');
  for (const pollutants of [['pm25', 'no2', 'o3'], ['o3', 'so2']]) {
    await fixture({ pollutants }, async c => {
      c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
      const retained = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
      assert.equal(retained.state, 'registered');
      const read = await readManagedControl(c.r2);
      const report = await reconcileManagedInputs({ derivedR2: c.r2, control: read.control, controlRead: read, pruneReader: c.reader });
      assertReconciliationReport(report, { controlRead: read });
      assert.equal(report.schema_version, 4); assert.equal(report.publication_selection, 'disabled');
      const e = report.authenticated_events[0];
      assert.equal(e.event.original.scope_count, 9); assert.equal(e.event.selected.scope_count, pollutants.includes('pm25') ? 6 : 0);
      assert.equal(e.original_authenticated, true); assert.equal(e.descriptor_retained, true);
      assert.equal(e.selected_receipts_retained, true); assert.equal(e.registered, true);
      assert.equal(report.stage3c.original_events.length, 0);
      assert.equal(report.changes.length, pollutants.includes('pm25') ? 2 : 0);
      assertReconciliationReport(JSON.parse(reconciliationArtifact(report).body));
      const bad = structuredClone(report); bad.authenticated_events[0].event.original.scope_count++;
      assert.throws(() => assertReconciliationReport(bad));
      c.f.objects.delete(e.descriptor.key);
      const missing = await reconcileManagedInputs({ derivedR2: c.r2, control: read.control, controlRead: read, pruneReader: c.reader });
      assert.equal(missing.authenticated_events[0].original_authenticated, false);
      assert.equal(missing.authenticated_events[0].descriptor_retained, false);
      assert.ok(missing.changes.every(x => !x.authentication?.authenticated));
    });
  }
});

test('immutable conflicts, changed event references and restarted budgets fail closed', async () => {
  await fixture({ pollutants: ['o3', 'so2'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const handover = await handoverFor(c);
    assert.throws(() => buildSelectedPruneEvent({ handover, budget: createPruneHandoverBudget() }),
      { code: 'operation_budget_mismatch' });
    const event = buildSelectedPruneEvent({ handover, budget: c.budget });
    c.f.objects.set(event.descriptor_object.key, Buffer.from('conflict'));
    await assert.rejects(retainSelectedPruneEvent({ handover, r2: c.r2, budget: c.budget }), { code: 'conflicting_immutable_object' });
    assert.equal(c.controls.length, 0); c.f.objects.delete(event.descriptor_object.key);
    const first = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(first.state, 'registered');
    const changed = JSON.parse(c.f.objects.get(CONTROL_KEY));
    changed.authenticated_events[first.event_id].descriptor.sha256 = 'f'.repeat(64);
    changed.authenticated_events[first.event_id].descriptor.key = `managed/jsongen/v1/authenticated-events/${'f'.repeat(64)}.json`;
    c.f.objects.set(CONTROL_KEY, canonicalJson(assertControl(changed)));
    const replay = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(replay.state, 'reconciliation_required'); assert.equal(replay.failure_stage, 'control_registration');
    assert.equal(c.controls.length, 1);
  });
});

test('a legacy populated control migrates without dropping receipts, dependencies or failures', async () => {
  await fixture({ pollutants: ['pm25', 'no2'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const handover = await handoverFor(c);
    const token = await retainPruneReceiptGroup({ handover, r2: c.r2, budget: c.budget });
    await updateManagedControl({ r2: c.r2, command: { type: 'retain_prune_event' }, authenticatedPruneEvent: token, budget: c.budget });
    const before = await readManagedControl(c.r2);
    const second = await sourceAndOriginalEvent(4, { evidenceBundle: true, pollutants: ['pm25', 'no2', 'o3'],
      dayUtc: '2026-08-10', runId: '0f332187-53d8-4424-9448-16047a9ce5f2', r2Endpoint: env.UK_AQ_JSONGEN_R2_ENDPOINT });
    for (const [key, value] of second.objects) c.f.objects.set(key, value);
    const reader = await connectPruneOutboxReader({ env, Client: second.Client });
    try {
      const r = await consumePruneAcceptance({ reader, key: second.key, derivedR2: c.r2, mode: 'retain' });
      assert.equal(r.state, 'registered', JSON.stringify(r));
      const after = await readManagedControl(c.r2);
      assert.equal(after.control.schema_version, 2); assert.equal(after.control.control_id, before.control.control_id);
      assert.equal(after.control.previous.sha256, before.sha256); assert.equal(after.control.revision, before.control.revision + 1);
      for (const [key, entry] of Object.entries(before.control.registered_changes)) assert.deepEqual(after.control.registered_changes[key], entry);
      for (const [key, entry] of Object.entries(before.control.months)) assert.deepEqual(after.control.months[key], entry);
      assert.deepEqual(after.control.failure, before.control.failure);
    } finally { await reader.close(); }
  });
});

test('940 original scopes produce all six selected partitions within one handover budget and compact control', async () => {
  const pollutants = [...Array(153).fill('no2'), ...Array(134).fill('pm10'), ...Array(146).fill('pm25'), ...Array(507).fill('o3')];
  await fixture({ scopes: 940, pollutants }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain', budget: c.budget });
    assert.equal(r.state, 'registered', JSON.stringify(r));
    assert.equal(r.expected_receipts.length, 6); assert.equal(r.physical_scope_count, 940);
    assert.equal(r.coverage_summary.selected.scope_count, 433); assert.equal(r.coverage_summary.unsupported.scope_count, 507);
    assert.equal(r.observation_count, 1880); // Synthetic 2-row scopes, not real TEST data.
    assert.ok(r.descriptor.byte_size <= 8 * 1024 ** 2);
    assert.ok(c.f.objects.get(CONTROL_KEY).length <= 4 * 1024 ** 2);
    const used = r.resources;
    assert.ok(used.derived_bytes + used.metadata_bytes + used.decompressed_bytes <= 192 * 1024 ** 2);
    assert.equal(used.derived_puts, 14); // descriptor + six bundle/receipt pairs + CAS
    console.log(JSON.stringify({ synthetic_scopes: 940, synthetic_rows: 1880, selected_partitions: 6,
      descriptor_bytes: r.descriptor.byte_size, control_bytes: c.f.objects.get(CONTROL_KEY).length,
      charged_bytes: used.derived_bytes + used.metadata_bytes + used.decompressed_bytes,
      puts: used.derived_puts, elapsed_ms: r.metrics.elapsed_ms }));
  });
});

test('unregistered retained schema-2 receipts recover their original group identity', async () => {
  await fixture({ pollutants: ['pm25', 'no2'] }, async c => {
    c.f.objects.set(CONTROL_KEY, canonicalJson(createControl()));
    const handover = await handoverFor(c);
    await retainPruneReceiptGroup({ handover, r2: c.r2, budget: c.budget });
    const r = await consumePruneAcceptance({ reader: c.reader, key: c.f.key, derivedR2: c.r2, mode: 'retain' });
    assert.equal(r.state, 'registered', JSON.stringify(r)); assert.equal(r.descriptor_retention, 'not_attempted');
    const control = assertControl(JSON.parse(c.f.objects.get(CONTROL_KEY)));
    assert.equal(control.schema_version, 1); assert.ok(Object.values(control.registered_changes).every(e => e.receipt.schema_version === 2));
  });
});
