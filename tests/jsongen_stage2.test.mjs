import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sha256Hex, r2GetObjectBounded } from '../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } from '../workers/shared/uk_aq_r2_history_canonical.mjs';
import { buildR2HistoryV2ObservationsRootManifest, buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsMonthManifest } from '../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { buildTimeseriesBindingSourceRangeManifest, buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRootKey, timeseriesBindingSourceRangeManifestKey } from '../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { getObservationHistoryGeneration } from '../workers/shared/uk_aq_observation_history_generation.mjs';
import { encodeObservationHistoryIndexV3Json } from '../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { buildObservationVerificationLatest, encodeObservationVerificationJson, OBSERVATION_VERIFICATION_LATEST_KEY } from '../workers/shared/uk_aq_observation_verification_overlay.mjs';
import { ROOT, CONTROL_KEY, BUCKET, ALGORITHM, canonicalJson, affectedMonths, createControl, monthKey, scopeKey } from '../scripts/jsongen/schema.mjs';
import { selectManagedPublications, readManagedControl, updateManagedControl } from '../scripts/jsongen/control.mjs';
import { readWriterInput, readBundle } from '../scripts/jsongen/inputs.mjs';
import { readCanonicalScopes, compareScopeMetadata } from '../scripts/jsongen/authority.mjs';
import { authenticateFinalPublication } from '../scripts/jsongen/writer-authentication.mjs';
import { reconcileManagedInputs, reconciliationArtifact, retainReconciliationReport, recordReconciliationRequired } from '../scripts/jsongen/reconcile.mjs';
import { createBudget } from '../scripts/jsongen/limits.mjs';

const identity = { connector_id: 1, timeseries_id: 212, station_id: 42, pollutant_code: 'pm25' };
const V3 = getObservationHistoryGeneration('v3');
const bindingPrefix = V3.timeseries_binding_index_prefix;
const ref = (bucket, key, bytes) => ({ bucket, key, sha256: sha256Hex(bytes), byte_size: bytes.length });
const declared = { bucket: 'canonical-test', key: 'evidence/final.json', sha256: 'a'.repeat(64), byte_size: 1 };
const row = (day, value = 1.1234567890123457) => ({ ...identity, observed_at_utc: `${day}T02:03:04.567Z`, value, source_status: 'original', verification_status: 'P' });
const scope = (day, count = 2) => ({ identity, day_utc: day, before: { state: 'present', row_count: 2, authority: declared },
  after: { state: count ? 'present' : 'authoritative_empty', row_count: count, authority: declared } });
function store(bucket = BUCKET) {
  const bodies = new Map(); const gets = [];
  const r2 = { endpoint: 'https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com', bucket, region: 'auto',
    adapter: { async getObjectBounded({ key, max_bytes }) {
      gets.push(key); assert.ok(!key.endsWith('.parquet'), 'metadata processing must never fetch Parquet');
      const body = bodies.get(key); if (!body) throw Object.assign(new Error('fixture object missing'), { status: 404 });
      assert.ok(body.length <= max_bytes, 'fixture respects bounded acquisition');
      return { body: Buffer.from(body), bytes: body.length, etag: '"fixture"' };
    } } };
  return { r2, bodies, gets };
}
function inputFixture({ days = ['2026-09-15'], change = 'A', records = null, empty = false } = {}) {
  const storage = store();
  const scopes = days.map(d => scope(d, empty ? 0 : 2));
  records ||= scopes.map(s => ({ identity, day_utc: s.day_utc, state: s.after.state, rows: empty ? [] : [row(s.day_utc), row(s.day_utc)] }));
  const ndjson = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const compressed = gzipSync(ndjson);
  const bundleRef = { ...ref(BUCKET, `${ROOT}/bundles/${sha256Hex(compressed)}.ndjson.gz`, compressed),
    json_sha256: sha256Hex(ndjson), json_byte_size: ndjson.length };
  const receipt = { schema_version: 1, kind: 'uk_aq_jsongen_verified_change', change_id: change,
    writer: { identity: 'fixture-writer', invocation_id: `invocation-${change}` },
    source: { index_generation: 'v3', history_version: 'v2', generation_authority: declared, observations_root: declared,
      index_authority: { ...declared, key: 'history/_index_v3/example.json' }, final_publication: declared,
      verification_authority: declared, binding_authority: declared, verified_at_utc: '2026-10-11T00:00:00.000Z' },
    scopes, affected_months: affectedMonths(scopes), rolling_aqi: { algorithm_version: ALGORITHM, preceding_hours: 23, following_hours: 23, minimum_valid_hours: 18 },
    bundle: { schema_version: 1, format: 'complete_scope_ndjson_gzip', change_id: change, object: bundleRef, scope_count: scopes.length, row_count: scopes.length * (empty ? 0 : 2) },
    verification: { state: 'canonical_final_verified', authority: declared, provenance_authority: declared, scope_completeness_authority: declared },
    durability: { state: 'verified_pending', retained_receipt_authority: declared } };
  const bytes = canonicalJson(receipt); const reference = ref(BUCKET, `${ROOT}/receipts/${sha256Hex(bytes)}.json`, bytes);
  storage.bodies.set(reference.key, bytes); storage.bodies.set(bundleRef.key, compressed);
  return { ...storage, receipt, reference, records, ndjson };
}
function register(control, fixture) {
  const r = fixture.receipt;
  control.registered_changes[r.change_id] = { receipt: r, receipt_object: fixture.reference,
    registered_at_utc: '2026-10-11T00:00:00.000Z', state: 'reconcile_required', ordering_state: 'unresolved', authentication_state: 'pending_writer_adapter' };
  for (const m of r.affected_months) {
    const k = monthKey(m.identity, m.month_utc);
    control.months[k] ||= { ...m, desired_change_ids: [], applied_change_ids: [], selected: null, state: 'reconcile_required', failure: null };
    control.months[k].desired_change_ids.push(r.change_id); control.months[k].desired_change_ids.sort();
  }
}
// Tiny canonical metadata is produced by the real shared builders. This is not
// a simulated production writer handover; writer authentication always fails.
function canonicalFixture(days = ['2026-09-15'], value = 1, conflictingAliases = false) {
  const storage = store('canonical-test'); const b = storage.bodies;
  const put = (key, payload) => b.set(key, Buffer.from(JSON.stringify(payload)));
  const dayManifests = [];
  for (const day of days) {
    const prepared = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity',
      rows: [row(day, typeof value === 'function' ? value(day) : value), row(day, typeof value === 'function' ? value(day) : value)], targetWriterGitSha: '1'.repeat(40), backedUpAtUtc: '2026-10-11T00:00:00.000Z' });
    const p = prepared.canonical_pollutant_manifest; b.set(p.key, p.body);
    for (const object of prepared.v3_hierarchy.publication_objects) b.set(object.key, Buffer.from(object.body));
    const common = { domain: 'observations', dayUtc: day, connectorId: 1, writerGitSha: '1'.repeat(40), backedUpAtUtc: '2026-10-11T00:00:00.000Z' };
    const connector = buildHistoryV2ConnectorManifest({ ...common, manifestKey: `${V3.observations_prefix}/day_utc=${day}/connector_id=1/manifest.json`, pollutantManifests: [p.payload] });
    put(connector.manifest_key, connector);
    const d = buildHistoryV2DayManifest({ ...common, manifestKey: `${V3.observations_prefix}/day_utc=${day}/manifest.json`, connectorManifests: [connector] });
    if (conflictingAliases) { d.child_manifests = []; const { manifest_hash, ...payload } = d; d.manifest_hash = sha256Hex(JSON.stringify(payload)); }
    put(d.manifest_key, d); dayManifests.push(d);
  }
  const basePrefix = V3.observations_prefix;
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix, year: '2026', month: '09', dayManifests });
  const monthKey = `${basePrefix}/_manifests/year=2026/month=09/manifest.json`; put(monthKey, month);
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix, year: '2026', monthManifests: [{ ...month, manifest_key: monthKey }] });
  const yearKey = `${basePrefix}/_manifests/year=2026/manifest.json`; put(yearKey, year);
  put(V3.observations_root_key, buildR2HistoryV2ObservationsRootManifest({ basePrefix, yearManifests: [{ ...year, manifest_key: yearKey }] }));
  const bindingKey = `${bindingPrefix}/timeseries_id=212.json`;
  put(bindingKey, { ...identity, schema_version: 1, history_version: 'v2', index_kind: 'timeseries_binding' });
  const bytes = b.get(bindingKey);
  const range = buildTimeseriesBindingSourceRangeManifest({ bindingPrefix, rangeStart: 0, rangeEnd: 999,
    units: [{ timeseries_id: 212, relative_path: bindingKey, size: bytes.length, sha256: sha256Hex(bytes), r2_md5: null }] });
  const rangeKey = timeseriesBindingSourceRangeManifestKey(bindingPrefix, 0, 999); put(rangeKey, range);
  put(timeseriesBindingSourceRootKey(bindingPrefix), buildTimeseriesBindingSourceRootManifest({ bindingPrefix,
    ranges: [{ range_start: 0, range_end: 999, manifest_key: rangeKey, source_range_hash: range.source_range_hash, unit_count: 1 }] }));
  b.set(OBSERVATION_VERIFICATION_LATEST_KEY, Buffer.from(encodeObservationVerificationJson(buildObservationVerificationLatest())));
  return { ...storage, generation: V3, bindingPrefix };
}
function controlStore() {
  const s = store(); const control = createControl();
  let controlBody = canonicalJson(control); let etag = `"${sha256Hex(controlBody)}"`;
  let controlPuts = 0; let reportPuts = 0; let onControlPut = null;
  s.r2.adapter.getObject = async ({ key }) => {
    if (key !== CONTROL_KEY) throw Object.assign(new Error('missing'), { status: 404 });
    return { body: Buffer.from(controlBody), bytes: controlBody.length, etag };
  };
  s.r2.adapter.putObjectConditional = async ({ key, body, if_match, if_none_match }) => {
    if (key === CONTROL_KEY) {
      controlPuts++;
      if (onControlPut) { const callback = onControlPut; onControlPut = null; callback(); }
      if (if_match !== etag) return { status: 412 };
      controlBody = Buffer.from(body); etag = `"${sha256Hex(controlBody)}"`;
      return { status: 200, etag };
    }
    reportPuts++;
    if (if_none_match !== '*' || s.bodies.has(key)) return { status: 412 };
    s.bodies.set(key, Buffer.from(body)); return { status: 200, etag: `"${sha256Hex(body)}"` };
  };
  const advance = () => {
    const old = JSON.parse(controlBody.toString('utf8'));
    const newer = { ...old, revision: old.revision + 1, operation_id: randomUUID(),
      previous: { revision: old.revision, operation_id: old.operation_id, sha256: sha256Hex(controlBody) },
      updated_at_utc: '2026-10-12T00:00:00.000Z',
      failure: { code: 'invalid_provenance', state: 'reconcile_required', at_utc: '2026-10-12T00:00:00.000Z', detail: 'newer diagnostic' } };
    controlBody = canonicalJson(newer); etag = `"${sha256Hex(controlBody)}"`;
  };
  return { ...s, advance, injectConflict(callback) { onControlPut = callback; },
    get controlPuts() { return controlPuts; }, get reportPuts() { return reportPuts; } };
}
function repinAlignedShard(c, changeShard) {
  const b = c.bodies; const shardKey = [...b.keys()].find(k => k.includes('/_aligned/') && k.includes('/range='));
  const shard = JSON.parse(b.get(shardKey)); changeShard(shard);
  const put = (key, value) => { const bytes = Buffer.from(encodeObservationHistoryIndexV3Json(value)); b.set(key, bytes); return ref(c.r2.bucket, key, bytes); };
  const shardRef = put(shardKey, shard);
  const alignedKey = shardKey.replace(/\/range=[^/]+\.json$/, '/manifest.json');
  const aligned = JSON.parse(b.get(alignedKey));
  Object.assign(aligned.children.find(x => x.key === shardKey), { sha256: shardRef.sha256, byte_size: shardRef.byte_size });
  const alignedRef = put(alignedKey, aligned);
  const leafKey = [...b.keys()].find(k => k.includes('/timeseries_id=') && k.endsWith('.json') && k.includes('observations_timeseries/'));
  const leaf = JSON.parse(b.get(leafKey));
  Object.assign(leaf.source_aligned_child, { sha256: shardRef.sha256, byte_size: shardRef.byte_size });
  const leafRef = put(leafKey, leaf);
  const exactKey = leafKey.replace(/\/timeseries_id=[^/]+\.json$/, '/manifest.json');
  const exact = JSON.parse(b.get(exactKey));
  exact.leaves_by_timeseries_id['212'] = [leafKey, leafRef.byte_size, leafRef.sha256];
  Object.assign(exact.source_aligned_scoped_manifest, { sha256: alignedRef.sha256, byte_size: alignedRef.byte_size });
  put(exactKey, exact);
  return shardKey;
}

test('receipt and gzip identities preserve precision, timestamps, duplicates and statuses, without authenticating writer', async () => {
  const f = inputFixture(); const input = await readWriterInput({ r2: f.r2, reference: f.reference });
  assert.deepEqual(input.bundle.records, f.records);
  assert.equal(input.bundle.logical[0].observation.observation_content_hash_row_count, 2);
  assert.equal(Object.hasOwn(input.bundle.logical[0].observation, 'canonical_rows'), false);
  for (const writerKind of ['prune_daily_v3', 'integrity_v3', 'sos_light_v3', 'ifw', null]) {
    const result = authenticateFinalPublication({ input, writerKind });
    assert.equal(result.authenticated, false); assert.ok(result.missing_proof.length > 0);
  }
  const bad = structuredClone(f.receipt); bad.bundle.object.json_sha256 = '0'.repeat(64);
  await assert.rejects(readBundle({ r2: f.r2, receipt: bad }), /uncompressed.*mismatch/);
  f.bodies.get(f.receipt.bundle.object.key)[10] ^= 1;
  await assert.rejects(readWriterInput({ r2: f.r2, reference: f.reference }), /SHA-256 mismatch/);
});

test('canonical receipt encoding and stable registered identity are enforced', async () => {
  const f = inputFixture();
  await assert.rejects(readWriterInput({ r2: f.r2, reference: f.reference, expected: { ...f.receipt, change_id: 'B' } }), /registered event/);
  const bytes = Buffer.from(JSON.stringify(f.receipt, null, 2));
  const reference = ref(BUCKET, `${ROOT}/receipts/${sha256Hex(bytes)}.json`, bytes); f.bodies.set(reference.key, bytes);
  await assert.rejects(readWriterInput({ r2: f.r2, reference }), /canonical encoding/);
});

test('complete-scope membership rejects missing, duplicate, undeclared rows and finer timestamps', async () => {
  const record = inputFixture().records[0];
  for (const records of [[record, record], [{ ...record, day_utc: '2026-09-16' }], [{ ...record, rows: [] }],
    [{ ...record, rows: record.rows.map(r => ({ ...r, observed_at_utc: '2026-09-15T02:03:04.5678Z' })) }]]) {
    const f = inputFixture({ records });
    await assert.rejects(readWriterInput({ r2: f.r2, reference: f.reference }));
  }
  const f = inputFixture({ days: ['2026-09-15', '2026-09-16'], records: [record] });
  await assert.rejects(readWriterInput({ r2: f.r2, reference: f.reference }), /missing scope/);
  const empty = inputFixture({ empty: true });
  const result = await readWriterInput({ r2: empty.r2, reference: empty.reference });
  assert.equal(result.bundle.logical[0].absence_authority, 'independent_proof_required');
  assert.equal(result.bundle.writer_authenticated, false);
});

test('processing bounds reject oversized receipts, decompression, records, rows and metadata operations', async () => {
  for (const limit of [{ receipt_bytes: 1 }, { compressed_bytes: 1 }, { uncompressed_bytes: 1 }, { record_bytes: 1 }, { rows: 1 }]) {
    const f = inputFixture(); await assert.rejects(readWriterInput({ r2: f.r2, reference: f.reference, budget: createBudget(limit) }));
  }
  const f = inputFixture(); const receipt = structuredClone(f.receipt); receipt.bundle.object.json_byte_size = 1;
  await assert.rejects(readBundle({ r2: f.r2, receipt }), /decompressed byte budget/);
  const c = canonicalFixture();
  const result = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-15')], budget: createBudget({ metadata_gets: 1 }) });
  assert.equal(result.read_consistent, false);
});

test('root-to-exact metadata and binding are inspected without Parquet or observation latest GETs', async () => {
  const c = canonicalFixture(); const result = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-15')] });
  assert.deepEqual(result.scopes[0].diagnostics, []);
  assert.equal(result.scopes[0].physical.membership, 'present');
  assert.equal(result.scopes[0].physical.row_count, 2);
  assert.equal(result.read_consistent, true); assert.equal(result.authority_complete, false);
  assert.equal(c.gets.includes(V3.observations_timeseries_latest_key), false);
});

test('only complete parent membership proves absence; a referenced 404 and contradictory aliases fail closed', async () => {
  const c = canonicalFixture();
  let result = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-16', 0)] });
  assert.equal(result.scopes[0].physical.membership, 'authoritative_absent');
  c.bodies.delete(`${V3.observations_prefix}/day_utc=2026-09-15/manifest.json`);
  result = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.length);
  const d = canonicalFixture(['2026-09-15'], 1, true);
  result = await readCanonicalScopes({ ...d, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('contradictory complete child aliases')));
});

test('per-scope drift keeps independent days and mixed receipts distinct; does not assert authenticated supersession', async () => {
  const first = await readCanonicalScopes({ ...canonicalFixture(['2026-09-15', '2026-09-16']), scopes: [scope('2026-09-15'), scope('2026-09-16')] });
  const changed = canonicalFixture(['2026-09-15', '2026-09-16'], day => day === '2026-09-15' ? 2 : 1);
  const second = await readCanonicalScopes({ ...changed, scopes: [scope('2026-09-15'), scope('2026-09-16')] });
  assert.equal(compareScopeMetadata(first.scopes[0], second.scopes[0]), 'scope_metadata_changed');
  assert.equal(compareScopeMetadata(first.scopes[1], second.scopes[1]), 'same_scope_metadata');
  assert.equal(compareScopeMetadata(first.scopes[0], first.scopes[1]), 'unknown');
});

test('reconciliation preserves delayed/independent changes and PM months, detects missing retention/registration, never claims a frontier', async () => {
  const a = inputFixture({ days: ['2026-09-15', '2026-09-30'], change: 'A' });
  const b = inputFixture({ days: ['2026-09-15', '2026-09-16'], change: 'B' });
  const retained = inputFixture({ change: 'C' });
  for (const [key, body] of [...b.bodies, ...retained.bodies]) a.bodies.set(key, body);
  const control = createControl(); register(control, b); register(control, a); // A arrives late.
  const before = canonicalJson(control);
  const report = await reconcileManagedInputs({ derivedR2: a.r2, control, retainedReceipts: [retained.reference], canonical: canonicalFixture(['2026-09-15', '2026-09-16']) });
  assert.equal(report.complete_change_coverage, false); assert.equal(report.freshness, 'unknown');
  assert.equal(report.changes.find(c => c.change_id === 'A').scopes.length, 2);
  assert.ok(report.changes.every(c => c.state === 'reconciliation_required'));
  assert.ok(report.changes.find(c => c.change_id === 'C').diagnostics.some(d => d.code === 'retained_receipt_missing_registration'));
  assert.deepEqual(report.months.find(m => m.month_key.endsWith('2026-10')).desired_change_ids, ['A']);
  assert.deepEqual(report.months.find(m => m.month_key.endsWith('2026-09')).desired_change_ids, ['A', 'B']);
  assert.ok(canonicalJson(control).equals(before));
  assert.throws(() => selectManagedPublications(), /disabled/);
  a.bodies.delete(a.receipt.bundle.object.key);
  const missing = await reconcileManagedInputs({ derivedR2: a.r2, control, canonical: canonicalFixture() });
  assert.ok(missing.changes.find(c => c.change_id === 'A').diagnostics.some(d => d.code === 'missing_retained_bundle'));
  assert.equal(reconciliationArtifact(report).reference.key.startsWith(`${ROOT}/evidence/`), true);
});

test('immutable reconciliation retention resolves duplicate/ambiguous PUT by exact readback', async () => {
  const s = store(); const report = await reconcileManagedInputs({ derivedR2: s.r2, control: createControl(), canonical: canonicalFixture() });
  s.r2.adapter.putObjectConditional = async ({ key, body, if_none_match }) => {
    assert.equal(if_none_match, '*'); s.bodies.set(key, Buffer.from(body)); return { status: 409 };
  };
  const retained = await retainReconciliationReport({ r2: s.r2, report });
  assert.equal(retained.outcome, 'confirmed_after_ambiguous_write');
  s.r2.adapter.putObjectConditional = async () => ({ status: 412 });
  assert.equal((await retainReconciliationReport({ r2: s.r2, report })).outcome, 'already_retained');
  s.bodies.set(retained.reference.key, Buffer.from('corrupt'));
  await assert.rejects(retainReconciliationReport({ r2: s.r2, report }));
});

test('bounded GET rejects buffered adapters and oversized streams, cancels without retry', async () => {
  await assert.rejects(r2GetObjectBounded({ r2: { adapter: { getObject() { assert.fail(); } } }, key: 'x', max_bytes: 8 }), /getObjectBounded/);
  const original = globalThis.fetch; let calls = 0; let cancelled = false;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; },
  })); };
  try {
    await assert.rejects(r2GetObjectBounded({ r2: { endpoint: 'https://example.invalid', bucket: 'x', region: 'auto', access_key_id: 'fixture', secret_access_key: 'fixture' }, key: 'x', max_bytes: 8 }), /byte budget exceeded/);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

// A successful intake register does not establish all canonical writes were seen.
test('requested uncovered canonical scope, unavailable status, and mid-read drift stay unresolved', async () => {
  const c = canonicalFixture(); const derived = store();
  const report = await reconcileManagedInputs({ derivedR2: derived.r2, control: createControl(), canonical: c, requestedScopes: [scope('2026-09-15')] });
  assert.equal(report.uncovered_scopes[0].code, 'canonical_scope_without_registered_receipt');
  assert.equal(report.complete_change_coverage, false);
  c.bodies.delete(OBSERVATION_VERIFICATION_LATEST_KEY);
  const missing = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-15')] });
  assert.ok(missing.scopes[0].diagnostics.some(d => d.code === 'verification_metadata_unavailable'));
  const d = canonicalFixture(); const get = d.r2.adapter.getObjectBounded; let roots = 0;
  d.r2.adapter.getObjectBounded = async args => {
    if (args.key === V3.observations_root_key && ++roots === 2) d.bodies.set(args.key, Buffer.from('{}'));
    return get(args);
  };
  const changed = await readCanonicalScopes({ ...d, scopes: [scope('2026-09-15')] });
  assert.equal(changed.read_consistent, false);
  assert.equal(changed.diagnostics[0].code, 'canonical_metadata_changed_during_read');
});

test('reconciliation failure is fenced to exact inspected control bytes and survives a stale inspection', async () => {
  const s = controlStore(); const controlRead = await readManagedControl(s.r2);
  const report = await reconcileManagedInputs({ derivedR2: s.r2, control: controlRead.control, controlRead });
  assert.equal(report.control_snapshot.byte_provenance, 'exact_read');
  assert.equal(report.control_snapshot.sha256, controlRead.sha256);
  s.advance();
  const result = await recordReconciliationRequired({ r2: s.r2, report });
  assert.equal(result.outcome, 'stale_reconciliation_inspection');
  assert.equal(result.new_inspection_required, true);
  assert.equal(s.controlPuts, 0);
  assert.equal(s.reportPuts, 1);
  assert.equal((await readManagedControl(s.r2)).control.failure.detail, 'newer diagnostic');
  assert.ok(s.bodies.has(result.reference.key));
});

test('CAS conflict rereads the expected snapshot instead of applying an old diagnostic', async () => {
  const s = controlStore(); const controlRead = await readManagedControl(s.r2);
  const report = await reconcileManagedInputs({ derivedR2: s.r2, control: controlRead.control, controlRead });
  s.injectConflict(() => s.advance());
  const result = await recordReconciliationRequired({ r2: s.r2, report });
  assert.equal(result.outcome, 'stale_reconciliation_inspection');
  assert.equal(s.controlPuts, 1);
  assert.equal((await readManagedControl(s.r2)).control.failure.detail, 'newer diagnostic');
  assert.ok(s.bodies.has(result.reference.key));
});

test('valid original-byte report retains and records a diagnostic while projection-only reports cannot record', async () => {
  const s = controlStore(); const controlRead = await readManagedControl(s.r2);
  const report = await reconcileManagedInputs({ derivedR2: s.r2, control: controlRead.control, controlRead });
  const result = await recordReconciliationRequired({ r2: s.r2, report });
  assert.equal(result.control.outcome, 'written');
  assert.equal((await readManagedControl(s.r2)).control.revision, controlRead.control.revision + 1);
  assert.match((await readManagedControl(s.r2)).control.failure.detail, /Stage 2 evidence/);
  const projection = await reconcileManagedInputs({ derivedR2: s.r2, control: (await readManagedControl(s.r2)).control });
  await assert.rejects(recordReconciliationRequired({ r2: s.r2, report: projection }), /original-byte control inspection/);
});

test('existing Stage 1 global failure transition remains valid without a Stage 2 snapshot', async () => {
  const s = controlStore();
  const result = await updateManagedControl({ r2: s.r2, command: { type: 'record_failure', failure: {
    code: 'invalid_provenance', state: 'reconcile_required',
    at_utc: '2026-10-12T00:00:00.000Z', detail: 'legacy diagnostic',
  } } });
  assert.equal(result.outcome, 'written');
  assert.equal((await readManagedControl(s.r2)).control.failure.detail, 'legacy diagnostic');
});

test('malformed provenance, contradictory scope evidence and positive authentication fail before retention', async () => {
  const f = inputFixture(); const c = createControl(); register(c, f);
  const report = await reconcileManagedInputs({ derivedR2: f.r2, control: c, canonical: canonicalFixture(),
    requestedScopes: [scope('2026-09-15')] });
  const badProvenance = structuredClone(report); badProvenance.control_snapshot.registered_change_ids = [];
  assert.throws(() => reconciliationArtifact(badProvenance), /registered receipt|registered change coverage/);
  const badScope = structuredClone(report); badScope.changes[0].scopes[0].declared_state = 'authoritative_empty';
  assert.throws(() => reconciliationArtifact(badScope), /scope evidence/);
  const badAuthentication = structuredClone(report); badAuthentication.changes[0].authentication.authenticated = true;
  assert.throws(() => reconciliationArtifact(badAuthentication), /writer authentication/);
  const s = controlStore();
  await assert.rejects(retainReconciliationReport({ r2: s.r2, report: badAuthentication }), /writer authentication/);
  assert.equal(s.reportPuts, 0);
});

test('aligned shard must be present with exact bytes, canonical source and timeseries membership', async () => {
  const c = canonicalFixture(); const key = [...c.bodies.keys()].find(k => k.includes('/_aligned/') && k.includes('/range='));
  assert.ok(key);
  c.bodies.delete(key);
  let result = await readCanonicalScopes({ ...c, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.length);

  const digest = canonicalFixture(); const digestKey = [...digest.bodies.keys()].find(k => k.includes('/_aligned/') && k.includes('/range='));
  const original = digest.bodies.get(digestKey);
  const sameSizeDifferentDigest = Buffer.from(original.toString('utf8').replace('"range_start": 0', '"range_start": 1'));
  assert.notDeepEqual(sameSizeDifferentDigest, original);
  assert.equal(sameSizeDifferentDigest.length, original.length);
  digest.bodies.set(digestKey, sameSizeDifferentDigest);
  result = await readCanonicalScopes({ ...digest, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('identity mismatch')));

  const size = canonicalFixture(); const sizeKey = [...size.bodies.keys()].find(k => k.includes('/_aligned/') && k.includes('/range='));
  size.bodies.set(sizeKey, Buffer.concat([size.bodies.get(sizeKey), Buffer.from('\n')]));
  result = await readCanonicalScopes({ ...size, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('identity mismatch')));

  const source = canonicalFixture(); repinAlignedShard(source, shard => { shard.canonical_source_manifest.sha256 = '0'.repeat(64); });
  result = await readCanonicalScopes({ ...source, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('canonical pollutant source')));

  const count = canonicalFixture(); repinAlignedShard(count, shard => { shard.timeseries[0].row_count++; });
  result = await readCanonicalScopes({ ...count, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('row counts')));

  const membership = canonicalFixture(); repinAlignedShard(membership, shard => { shard.timeseries[0].timeseries_id = 999; });
  result = await readCanonicalScopes({ ...membership, scopes: [scope('2026-09-15')] });
  assert.equal(result.scopes[0].physical, undefined);
  assert.ok(result.scopes[0].diagnostics.some(d => d.detail.includes('membership')));
});
