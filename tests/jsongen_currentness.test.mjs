// Narrow offline checks for currentness/coverage safety. All storage and SQL
// are synthetic adapters; no CLI or operational service is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';
import { consumePruneAcceptance } from '../scripts/jsongen/prune-consumer.mjs';
import { connectPruneOutboxReader } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { decodePruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { reconcileManagedInputs, reconciliationArtifact } from '../scripts/jsongen/reconcile.mjs';
import { readCanonicalScopePages } from '../scripts/jsongen/authority.mjs';
import { physicalScopeDigest } from '../scripts/jsongen/scope-authority.mjs';
import { assertReconciliationReport } from '../scripts/jsongen/report-validation.mjs';
import { readManagedControl, selectManagedPublications } from '../scripts/jsongen/control.mjs';
import { canonicalJson } from '../scripts/jsongen/schema.mjs';
import { createBudget } from '../scripts/jsongen/limits.mjs';
import { getObservationHistoryGeneration } from '../workers/shared/uk_aq_observation_history_generation.mjs';
import { buildR2HistoryV2ObservationsRootManifest } from '../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { buildObservationVerificationLatest, encodeObservationVerificationJson,
  OBSERVATION_VERIFICATION_LATEST_KEY } from '../workers/shared/uk_aq_observation_verification_overlay.mjs';

const G = getObservationHistoryGeneration('v3');
const env = { UK_AQ_ENV_NAME: 'TEST', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
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
  const result = await consumePruneAcceptance({ reader, key: f.key, derivedR2: f.r2, mode: 'retain', initializeControl: true });
  assert.equal(result.state, 'registered');
  const controlRead = await readManagedControl(f.r2), canonical = canonicalFixture(f);
  return { f, reader, canonical, options: { derivedR2: f.r2, control: controlRead.control, controlRead, canonical, pruneReader: reader },
    scopes: Object.values(controlRead.control.registered_changes).flatMap(e => e.receipt.scopes) };
}

test('authenticated original matches exact current scope, while all-writer coverage and monthly publication stay blocked', async () => {
  const s = await setup();
  try {
    const r = await reconcileManagedInputs({ ...s.options, pruneDiscovery: {
      from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', mode: 'resweep' } });
    assert.equal(r.schema_version, 2); assert.equal(r.canonical.read_consistent, true);
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
    for (const k of ['source_as_of', 'page_count', 'page_scope_limit']) delete legacy.canonical[k];
    for (const s of legacy.canonical.scopes) delete s.physical.scope_sha256;
    assertReconciliationReport(legacy);
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

test('all partitions share one source-as-of recheck; changed root, new selector or missing Core completion fails closed', async () => {
  const s = await setup();
  try {
    const result = await readCanonicalScopePages({ ...s.canonical, scopes: s.scopes, budget: createBudget({ scopes: 1 }) });
    assert.equal(result.page_count, 2); assert.equal(result.scopes.length, 2); assert.equal(result.read_consistent, true);
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

test('multi-partition original events are fully accounted, missing retention/registration and exhausted metadata stay explicit', async () => {
  const s = await setup(1024);
  try {
    const entries = Object.values(s.options.control.registered_changes);
    assert.equal(entries.length, 8);
    const r = await reconcileManagedInputs({ ...s.options, budget: createBudget({ metadata_gets: 20 }) });
    assert.equal(r.changes.reduce((n, c) => n + c.scopes.length, 0), 1024);
    assert.equal(r.canonical.scopes.length, 1024); assert.equal(r.canonical.page_count, 8);
    assert.equal(r.canonical.read_consistent, false); assert.equal(r.stage3c.original_events[0].scope_count, 1024);
    assert.equal(r.stage3c.original_events[0].original_receipts_registered, true);
    // Preserve the existing cap even when the full detailed 1,024-scope report
    // exceeds it; never trim scopes to manufacture a retainable report.
    assert.throws(() => reconciliationArtifact(r), { code: 'resource_limit' });
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
