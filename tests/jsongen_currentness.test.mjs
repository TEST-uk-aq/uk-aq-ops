// Narrow offline checks for currentness/coverage safety. All storage and SQL
// are synthetic adapters; no CLI or operational service is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { authenticatePruneHandover } from '../scripts/jsongen/prune-consumer-authentication.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup } from '../scripts/jsongen/prune-receipts.mjs';
import { prunePartitionArtifacts } from '../scripts/jsongen/prune-consumer-partitions.mjs';
import { connectPruneOutboxReader } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { decodePruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { reconcileManagedInputs, reconciliationArtifact } from '../scripts/jsongen/reconcile.mjs';
import { readCanonicalScopePages } from '../scripts/jsongen/authority.mjs';
import { physicalScopeDigest } from '../scripts/jsongen/scope-authority.mjs';
import { assertReconciliationReport } from '../scripts/jsongen/report-validation.mjs';
import { readManagedControl, selectManagedPublications } from '../scripts/jsongen/control.mjs';
import { canonicalJson, createControl, assertControl, monthKey, CONTROL_KEY } from '../scripts/jsongen/schema.mjs';
import { createBudget, createInspectionBudget } from '../scripts/jsongen/limits.mjs';
import { encodeCompactReport, decodeCompactReport } from '../scripts/jsongen/report-codec.mjs';
import { getObservationHistoryGeneration } from '../workers/shared/uk_aq_observation_history_generation.mjs';
import { buildR2HistoryV2ObservationsRootManifest } from '../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { buildObservationVerificationLatest, encodeObservationVerificationJson,
  OBSERVATION_VERIFICATION_LATEST_KEY } from '../workers/shared/uk_aq_observation_verification_overlay.mjs';

const G = getObservationHistoryGeneration('v3');
const env = { UK_AQ_ENV_NAME: 'TEST', UK_AQ_GITHUB_REPO: 'fixture-org/fixture-ops',
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres' };

function canonicalFixture(f) {
  const decoded = decodePruneMetadataEvidence(JSON.parse(f.row.final_evidence_bytes));
  const bodies = new Map(decoded.original_metadata_snapshot.objects.map(o => [o.key, Buffer.from(o.bytes_base64, 'base64')]));
  for (const o of decoded.original_authority_extension.objects.filter(o => o.phase === 'binding')) bodies.set(o.key, Buffer.from(o.bytes_base64, 'base64'));
  const gets = [], counts = new Map(); let hook = () => {};
  const r2 = { bucket: 'canonical-test', adapter: { async getObjectBounded({ key }) {
    assert.ok(key.endsWith('.json')); assert.notEqual(key, G.observations_timeseries_latest_key);
    gets.push(key); counts.set(key, (counts.get(key) || 0) + 1); hook(key, counts.get(key));
    if (!bodies.has(key)) throw Object.assign(new Error('synthetic missing metadata'), { status: 404 });
    const body = bodies.get(key); return { body, bytes: body.length, etag: '"fixture"' };
  } } };
  return { r2, bodies, gets, counts, generation: G, setHook: fn => { hook = fn; } };
}

async function setup(count = 2) {
  const f = await sourceAndOriginalEvent(count), reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const handover = await authenticatePruneHandover({ acceptance: await reader.read(f.key), derivedR2: f.r2 });
  const group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover }));
  const artifacts = prunePartitionArtifacts(group.plan), control = createControl();
  for (let i = 0; i < group.entries.length; i++) {
    const e = group.entries[i];
    // Synthetic storage is populated directly. No consumer retention/write
    // mode, registration command or remote mutation interface is run.
    f.objects.set(e.receipt_object.key, canonicalJson(e.receipt));
    f.objects.set(e.receipt.bundle.object.key, artifacts[i].body);
    control.registered_changes[e.receipt.change_id] = { ...e, registered_at_utc: '2026-10-10T02:00:00.000Z',
      state: 'verified_pending', ordering_state: 'unresolved', authentication_state: 'original_prune_event_authenticated' };
    for (const m of e.receipt.affected_months) {
      const k = monthKey(m.identity, m.month_utc);
      control.months[k] ||= { ...m, desired_change_ids: [], applied_change_ids: [], selected: null, state: 'pending', failure: null };
      control.months[k].desired_change_ids.push(e.receipt.change_id);
    }
  }
  Object.values(control.months).forEach(m => m.desired_change_ids.sort());
  f.objects.set(CONTROL_KEY, canonicalJson(assertControl(control)));
  f.r2.adapter.putObjectConditional = async () => { assert.fail('No write-mode interface may run'); };
  const controlRead = await readManagedControl(f.r2), canonical = canonicalFixture(f);
  return { f, reader, canonical, options: { derivedR2: f.r2, control: controlRead.control, controlRead, canonical, pruneReader: reader },
    scopes: Object.values(controlRead.control.registered_changes).flatMap(e => e.receipt.scopes) };
}

test('authenticated original matches exact current scope, while all-writer coverage and monthly publication stay blocked', async () => {
  const s = await setup();
  try {
    const r = await reconcileManagedInputs({ ...s.options, pruneDiscovery: {
      from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', mode: 'resweep' } });
    assert.equal(r.schema_version, 3); assert.equal(r.canonical.read_consistent, true);
    assert.ok(r.stage3c.scopes.every(s => s.original_authentication === 'authenticated' && s.current_metadata_match === 'matches'));
    assert.equal(r.stage3c.original_events[0].original_receipts_registered, true);
    assert.ok(reconciliationArtifact(r).body.length <= 4 * 1024 ** 2);
    assert.equal(r.stage3c.awaiting_consumption.length, 0);
    assert.equal(r.stage3c.writer_coverage, 'unknown'); assert.equal(r.stage3c.publication_eligible, false);
    assert.equal(r.stage3c.writer_inventories.length, 4); assert.equal(r.stage3c.discovery.coverage_complete, false);
    assert.equal(r.uncovered_scopes.length, 0); assert.equal(reconciliationArtifact(r).reference.byte_size > 0, true);
    const legacy = structuredClone(r); legacy.schema_version = 1; delete legacy.stage3c;
    for (const c of legacy.changes) { delete c.original_scope_authorities; delete c.original_verified_at_utc; }
    legacy.canonical.schema_version = 1;
    for (const k of ['source_as_of', 'page_count', 'page_scope_limit', 'selection', 'recheck_evidence', 'closing_root', 'capacity']) delete legacy.canonical[k];
    for (const s of legacy.canonical.scopes) delete s.physical.scope_sha256;
    assertReconciliationReport(legacy);
    const version2 = structuredClone(r); version2.schema_version = 2; version2.canonical.schema_version = 2;
    for (const k of ['selection', 'recheck_evidence', 'closing_root', 'capacity']) delete version2.canonical[k];
    version2.stage3c.scopes.forEach(scope => { delete scope.inspection_state; });
    version2.stage3c.original_events.forEach(group => { delete group.expected_scope_keys; });
    assertReconciliationReport(version2);
    assert.throws(selectManagedPublications);
    const falseComplete = structuredClone(r); falseComplete.stage3c.writer_coverage = 'complete';
    assert.throws(() => assertReconciliationReport(falseComplete), { code: 'invalid_report' });
    const mixed = structuredClone(r); mixed.canonical.scopes[0].binding.sha256 = 'f'.repeat(64);
    assert.throws(() => assertReconciliationReport(mixed), { code: 'invalid_report' });
    const stale = structuredClone(r); stale.canonical.source_as_of.identity_sha256 = 'f'.repeat(64);
    assert.throws(() => assertReconciliationReport(stale), { code: 'invalid_report' });
  } finally { await s.reader.close(); }
});

test('unrelated root and aligned-parent identities do not supersede unaffected physical scopes', async () => {
  const s = await setup();
  try {
    const root = JSON.parse(s.canonical.bodies.get(G.observations_root_key));
    const newer = buildR2HistoryV2ObservationsRootManifest({ basePrefix: G.observations_prefix,
      yearManifests: [...root.children.map(c => ({ ...c })), { year: 2025,
        manifest_key: `${G.observations_prefix}/_manifests/year=2025/manifest.json`, content_hash: 'a'.repeat(64) }] });
    s.canonical.bodies.set(G.observations_root_key, canonicalJson(newer));
    const r = await reconcileManagedInputs(s.options);
    assert.ok(r.stage3c.scopes.every(s => s.current_metadata_match === 'matches' && s.authenticated_supersession.state === 'unproven'));
    const leaf = JSON.parse(s.canonical.bodies.get(r.canonical.scopes[0].physical.leaf.key));
    const prior = physicalScopeDigest(s.scopes[0], leaf);
    leaf.source_aligned_child.sha256 = 'b'.repeat(64);
    assert.equal(physicalScopeDigest(s.scopes[0], leaf), prior);
  } finally { await s.reader.close(); }
});

test('changed current physical files and a bare later-writer claim cannot authenticate supersession', async () => {
  const s = await setup(1);
  try {
    const changed = await sourceAndOriginalEvent(2), canonical = canonicalFixture(changed);
    const r = await reconcileManagedInputs({ ...s.options, canonical });
    assert.equal(r.stage3c.scopes[0].original_authentication, 'authenticated');
    assert.equal(r.stage3c.scopes[0].current_metadata_match, 'differs');
    assert.equal(r.stage3c.scopes[0].authenticated_supersession.state, 'unproven');
    assert.equal(r.stage3c.known_superseding_publications.length, 0);
    assert.ok(r.uncovered_scopes.length > 0);
    const fake = structuredClone(r); fake.stage3c.scopes[0].authenticated_supersession.state = 'authenticated';
    assert.throws(() => assertReconciliationReport(fake), { code: 'invalid_report' });
  } finally { await s.reader.close(); }
});

test('one selection rechecks shared authority; changed root, new selector or missing Core completion fails closed', async () => {
  const s = await setup();
  try {
    const result = await readCanonicalScopePages({ ...s.canonical, scopes: s.scopes, budget: createBudget({ scopes: 1 }) });
    assert.equal(result.page_count, 2); assert.equal(result.scopes.length, 2); assert.equal(result.read_consistent, true);
    assert.equal(result.scopes.filter(s => s.state === 'not_inspected_partition').length, 1);
    assert.equal(s.canonical.counts.get(G.observations_root_key), 3);
    const drift = canonicalFixture(s.f);
    drift.setHook((key, n) => { if (key === G.observations_root_key && n === 2) drift.bodies.set(key, Buffer.from('{}')); });
    const changed = await readCanonicalScopePages({ ...drift, scopes: s.scopes, budget: createBudget({ scopes: 1 }) });
    assert.equal(changed.read_consistent, false); assert.equal(changed.source_as_of.state, 'fresh_inspection_required');
    const appearing = canonicalFixture(s.f), statusKey = 'history/_index_v3/verification/latest.json';
    appearing.setHook((key, n) => { if (key === statusKey && n === 2) appearing.bodies.set(key, Buffer.from('{}')); });
    assert.equal((await readCanonicalScopePages({ ...appearing, scopes: s.scopes })).read_consistent, false);
    const missing = canonicalFixture(s.f); missing.bodies.delete(`${G.timeseries_binding_index_prefix}/_source_state.json`);
    const r = await reconcileManagedInputs({ ...s.options, canonical: missing });
    assert.ok(r.stage3c.scopes.every(s => s.current_metadata_match === 'unavailable'));
    const missingRoot = canonicalFixture(s.f); missingRoot.bodies.delete(G.observations_root_key);
    const absentRoot = await reconcileManagedInputs({ ...s.options, canonical: missingRoot });
    assert.equal(absentRoot.canonical.read_consistent, false);
    assert.ok(absentRoot.canonical.scopes.every(s => s.physical === undefined));
    const overlay = canonicalFixture(s.f);
    overlay.bodies.set(OBSERVATION_VERIFICATION_LATEST_KEY, Buffer.from(encodeObservationVerificationJson(
      buildObservationVerificationLatest({ connectorManifests: [{ connector_id: 1, byte_size: 1, sha256: 'a'.repeat(64),
        key: `history/v3/verification/connector_id=1/manifests/${'a'.repeat(64)}.json` }] }))));
    const unaccepted = await reconcileManagedInputs({ ...s.options,
      canonical: { ...overlay, acceptedVerificationModes: { 1: 'overlay_accepted' } } });
    assert.ok(unaccepted.stage3c.scopes.every(s => s.current_metadata_match === 'unavailable'));
    assert.equal(unaccepted.stage3c.current_metadata_inspected, false);
  } finally { await s.reader.close(); }
});

test('multi-partition original events are fully accounted, missing retention/registration and exhausted metadata stay explicit', async t => {
  const s = await setup(1024);
  try {
    const entries = Object.values(s.options.control.registered_changes);
    assert.equal(entries.length, 8);
    const r = await reconcileManagedInputs(s.options);
    assert.equal(r.changes.reduce((n, c) => n + c.scopes.length, 0), 1024);
    assert.equal(r.canonical.scopes.length, 1024); assert.equal(r.canonical.page_count, 8);
    assert.equal(r.canonical.read_consistent, true); assert.equal(r.stage3c.original_events[0].scope_count, 1024);
    assert.equal(r.stage3c.scopes.filter(s => s.current_metadata_match === 'matches').length, 128);
    assert.equal(r.stage3c.scopes.filter(s => s.inspection_state === 'not_inspected_partition').length, 896);
    assert.equal(r.stage3c.current_metadata_inspected, false);
    assert.equal(r.stage3c.original_events[0].original_receipts_registered, true);
    const artifact = reconciliationArtifact(r), wire = JSON.parse(artifact.body);
    assert.ok(artifact.body.length <= 4 * 1024 ** 2);
    assert.deepEqual(decodeCompactReport(wire), JSON.parse(canonicalJson(r)));
    assertReconciliationReport(wire);
    t.diagnostic(JSON.stringify({ accounted_scopes: 1024, inspected_scopes: 128,
      compact_bytes: artifact.body.length, expanded_bytes: wire.expanded_byte_size,
      metadata_gets: r.resources.metadata_gets, get_allowance: r.canonical.capacity.metadata_get_limit }));
    const missingPartition = structuredClone(r); missingPartition.canonical.selection.partitions.pop();
    assert.throws(() => assertReconciliationReport(missingPartition), { code: 'invalid_report' });
    const overlapping = structuredClone(r);
    overlapping.canonical.selection.partitions[1].scope_keys[0] = overlapping.canonical.selection.partitions[0].scope_keys[0];
    assert.throws(() => assertReconciliationReport(overlapping), { code: 'invalid_report' });
    const another = await readCanonicalScopePages({ ...s.canonical, scopes: s.scopes, partitionIndex: 1 });
    assert.equal(another.selection.selected_partition, 1); assert.equal(another.read_consistent, true);
    const combined = structuredClone(r);
    const foreign = another.scopes.find(x => x.state === 'metadata_only');
    combined.canonical.scopes[combined.canonical.scopes.findIndex(x => x.scope_key === foreign.scope_key)] = foreign;
    assert.throws(() => assertReconciliationReport(combined), { code: 'invalid_report' });
    const controlRead = await readManagedControl(s.f.r2);
    // Use a real empty synthetic control from before registration, rather than
    // inventing partial schema-2 registration (which assertControl rejects).
    const { createControl } = await import('../scripts/jsongen/schema.mjs');
    s.f.objects.delete(entries[1].receipt_object.key);
    const missing = await reconcileManagedInputs({ ...s.options, control: createControl(), controlRead: null,
      retainedReceipts: [entries[0].receipt_object], budget: createBudget({ metadata_gets: 20 }) });
    assert.equal(missing.canonical.scopes.length, 1024);
    const event = missing.stage3c.original_events[0];
    assert.equal(event.missing_retention.length, 1); assert.equal(event.missing_registration.length, 8);
    assert.equal(missing.stage3c.retained_unregistered.length, 7);
    assert.equal(controlRead.control.revision, s.options.control.revision);
  } finally { await s.reader.close(); }
});

test('128 distinct series fit the planned GET envelope with deduplicated four-worker reads and complete rechecks', async t => {
  const s = await setup(128);
  try {
    let active = 0, peak = 0;
    const original = s.canonical.r2.adapter.getObjectBounded;
    s.canonical.r2.adapter.getObjectBounded = async args => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await original(args); }
      finally { active--; }
    };
    const r = await reconcileManagedInputs(s.options), c = r.canonical;
    assert.equal(c.read_consistent, true); assert.equal(r.stage3c.current_metadata_inspected, true);
    assert.equal(r.stage3c.scopes.filter(s => s.current_metadata_match === 'matches').length, 128);
    assert.ok(c.resources.metadata_gets > 512); assert.ok(c.capacity.metadata_get_allowance > 512);
    assert.equal(c.resources.metadata_gets, s.canonical.gets.length);
    assert.equal(c.capacity.initial_gets * 2 + 1, c.resources.metadata_gets);
    assert.equal(c.resources.metadata_gets, 541); assert.equal(c.capacity.metadata_get_allowance, 543);
    assert.equal(c.capacity.initial_bytes, c.capacity.recheck_bytes);
    assert.equal(c.resources.metadata_bytes - c.capacity.previous_metadata_bytes,
      c.capacity.initial_bytes * 2 + c.capacity.closing_root_bytes);
    assert.equal(c.capacity.initial_gets, new Set(s.canonical.gets).size);
    assert.ok(peak > 1 && peak <= 4); assert.equal(c.capacity.peak_concurrency, peak);
    assert.ok(c.recheck_evidence.every(e => e.state === 'matched'));
    for (const [key, count] of s.canonical.counts) assert.equal(count, key === G.observations_root_key ? 3 : 2);
    const noRechecks = structuredClone(r); noRechecks.canonical.recheck_evidence.pop();
    assert.throws(() => assertReconciliationReport(noRechecks), { code: 'invalid_report' });
    const bypass = structuredClone(r); bypass.canonical.capacity.initial_gets--;
    assert.throws(() => assertReconciliationReport(bypass), { code: 'invalid_report' });
    const byteBypass = structuredClone(r); byteBypass.canonical.capacity.recheck_bytes--;
    assert.throws(() => assertReconciliationReport(byteBypass), { code: 'invalid_report' });
    const compact = encodeCompactReport(r);
    assertReconciliationReport(compact);
    t.diagnostic(JSON.stringify({ scopes: 128, metadata_gets: c.resources.metadata_gets,
      get_allowance: c.capacity.metadata_get_limit, max_concurrency: peak, compact_bytes: canonicalJson(compact).length }));
    const missing = structuredClone(compact); missing.nodes.pop();
    assert.throws(() => assertReconciliationReport(missing), { code: 'invalid_report' });
    const badHash = structuredClone(compact); badHash.expanded_sha256 = 'f'.repeat(64);
    assert.throws(() => assertReconciliationReport(badHash), { code: 'invalid_report' });
    const falseReady = structuredClone(r); falseReady.publication_selection = 'enabled';
    assert.throws(() => assertReconciliationReport(encodeCompactReport(falseReady)), { code: 'invalid_report' });
    assert.throws(selectManagedPublications);
  } finally { await s.reader.close(); }
});

test('shared timeout aborts concurrent requests, drains workers and rejects late cache/evidence writes', async () => {
  const f = await sourceAndOriginalEvent(8), c = canonicalFixture(f);
  const decoded = decodePruneMetadataEvidence(JSON.parse(f.row.final_evidence_bytes));
  const scopes = decoded.original_authority_extension.before.scopes.map(s => ({ identity: s.identity, day_utc: s.day_utc }));
  const original = c.r2.adapter.getObjectBounded, pending = []; let aborted = 0;
  c.r2.adapter.getObjectBounded = async args => {
    if (!args.key.includes('/timeseries_id=')) return original(args);
    args.signal.addEventListener('abort', () => { aborted++; }, { once: true });
    return new Promise(resolve => pending.push(() => resolve({ body: c.bodies.get(args.key), bytes: c.bodies.get(args.key).length })));
  };
  const result = await readCanonicalScopePages({ ...c, scopes, budget: createInspectionBudget({ duration_ms: 200 }) });
  assert.equal(result.read_consistent, false); assert.equal(result.source_as_of.state, 'fresh_inspection_required');
  assert.ok(aborted > 1 && aborted <= 4); assert.ok(pending.length <= 4);
  assert.ok(result.scopes.some(s => s.state === 'not_inspected_resource_limit'));
  const before = canonicalJson(result);
  pending.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(canonicalJson(result), before);
});
