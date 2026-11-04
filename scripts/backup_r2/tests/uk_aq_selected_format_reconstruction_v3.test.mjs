import assert from 'node:assert/strict';
import test from 'node:test';
import * as planner from '../uk_aq_plan_sos_light_v3_observation_metadata.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { buildObservationHistoryExactLeafIndexV3ScopedHierarchy, buildObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry } from '../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';

function fixture(schema = 1, day = '2026-10-10') {
  const built = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', targetWriterGitSha: 'a'.repeat(40),
    rows: [{ connector_id: 1, station_id: 1, timeseries_id: 1, pollutant_code: 'no2',
      observed_at_utc: `${day}T01:00:00.000Z`, value: 1, verification_status: 'P' }] });
  const m = built.canonical_pollutant_manifest;
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: built.target_metadata,
    canonicalManifest: { key: m.key, byte_size: m.byte_size, sha256: m.sha256, manifest_hash: m.payload.manifest_hash,
      row_count: m.payload.row_count, observation_content_hash: m.payload.observation_content_hash,
      observation_content_hash_version: 1 }, exactSchemaVersion: schema });
  const entry = planner.buildExactV3ManifestCatalogue({ manifestKeys: [m.key],
    getObject: () => ({ key: m.key, body: Buffer.from(m.body), source: 'dropbox' }) }).entries[0];
  return { built, hierarchy, entry };
}
function roots(...fixtures) {
  return validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact:
    buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: fixtures.map(f => f.hierarchy) }) }).roots;
}

test('mixed authenticated selections retain explicit per-scope formats and new scopes default to schema 1', () => {
  const one = fixture(), two = fixture(2, '2026-10-11'), fresh = fixture(1, '2026-10-12');
  const selectedRoots = roots(one, two);
  for (const [f, expected] of [[one, 1], [two, 2]]) {
    const selection = planner.resolveExactV3SelectedFormat({ entry: f.entry, selectedRoots,
      baselineManifestKeys: new Set([one.entry.key, two.entry.key]) });
    assert.equal(selection.schema_version, expected);
    assert.equal(selection.selector.key, f.hierarchy.scoped_manifest.key);
  }
  assert.equal(planner.resolveExactV3SelectedFormat({ entry: fresh.entry, selectedRoots,
    baselineManifestKeys: new Set([one.entry.key, two.entry.key]), assertNewScope: () => true }).schema_version, 1);
  assert.throws(() => planner.resolveExactV3SelectedFormat({ entry: two.entry, selectedRoots: [],
    baselineManifestKeys: new Set([two.entry.key]) }), /selected.format.*unavailable/i);
  assert.throws(() => planner.resolveExactV3SelectedFormat({ entry: two.entry,
    selectedRoots: [{ ...selectedRoots[1], exact_index_schema_version: 7 }],
    baselineManifestKeys: new Set([two.entry.key]) }), /format/);
});

test('schema-2 selection is blocked before legacy reconstruction without fresh physical/canonical capability', async () => {
  const f = fixture(2);
  await assert.rejects(() => planner.buildExactV3HierarchyForCatalogueEntry({ entry: f.entry,
    selectedFormat: { schema_version: 2, selector: roots(f)[0] }, proposalsByKey: new Map(),
    runState: { objects: {} }, store: { getObjectFromSourceIfExists: () => assert.fail('must block before schema-1 path') },
    combinedObject: () => assert.fail('must not fall back'), targetWriterGitSha: 'a'.repeat(40) }),
  /schema-2 reconstruction blocked.*held.operation.*current.object/i);
});

test('schema-1 reconstruction keeps its original bytes and aligned dependencies', async () => {
  const f = fixture();
  const objects = new Map([f.built.canonical_pollutant_manifest, ...f.built.file_intents]
    .map(a => [a.key, { key: a.key, body: Buffer.from(a.body), source: 'dropbox' }]));
  const h = await planner.buildExactV3HierarchyForCatalogueEntry({ entry: f.entry,
    selectedFormat: { schema_version: 1, selector: roots(f)[0] }, proposalsByKey: new Map(), runState: { objects: {} },
    store: { getObjectFromSourceIfExists: key => objects.get(key) }, targetWriterGitSha: 'a'.repeat(40) });
  assert.equal(h.scoped_manifest.body, f.hierarchy.scoped_manifest.body);
  assert.ok(h.aligned_source_manifest);
  assert.ok(h.exact_leaves.every(l => l.payload.source_aligned_child));
});

test('builder refuses an omitted or contradictory selected format', async () => {
  const f = fixture();
  for (const selectedFormat of [undefined, { schema_version: 7 }]) {
    await assert.rejects(() => planner.buildExactV3HierarchyForCatalogueEntry({ entry: f.entry, selectedFormat }), /selected.format/);
  }
});

test('legacy v3 migration refuses schema-2 selection before rewriting canonical source', async () => {
  const { inventoryAuthoritativeCanonicalObservationHistory } = await import('../lib/observation_history_migration_v3.mjs');
  const f = fixture(2), latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [f.hierarchy] });
  const reads = [];
  await assert.rejects(() => inventoryAuthoritativeCanonicalObservationHistory({
    observationsPrefix: 'history/v3/observations', v2IndexRoot: 'history/_index_v3/observations_timeseries', v2LatestKey: latest.key,
    getR2Object: async ({ key }) => { reads.push(key); if (key === latest.key) return { key, body: Buffer.from(latest.body) };
      throw new Error('must not reach canonical rewrite inventory'); } }), /schema-2.*rebuild.*unsupported/i);
  assert.deepEqual(reads, [latest.key]);
});

test('legacy Integrity APPLY adapter refuses schema-2 selectors before source loading', async () => {
  const { buildValidatedIntegrityObservationHistoryV3Partitions } = await import('../lib/observation_history_integrity_writer_v3.mjs');
  const f = fixture(2);
  assert.throws(() => buildValidatedIntegrityObservationHistoryV3Partitions({ runState: {},
    validatedProposal: { objects: [{ key: f.hierarchy.scoped_manifest.key, body: Buffer.from(f.hierarchy.scoped_manifest.body) }], prefixes: [] } }),
  /schema-2.*APPLY.*unsupported/i);
});

test('dedicated SOS-light APPLY rejects schema-2 selector bytes before complete-day deletion admission', async () => {
  const { validateDedicatedSosHistoricalProposalV3 } = await import('../lib/sos_light_v3_proposal_validation.mjs');
  const f = fixture(2);
  assert.throws(() => validateDedicatedSosHistoricalProposalV3({ runState: {}, proposal: {
    objects: [{ key: f.hierarchy.scoped_manifest.key, body: Buffer.from(f.hierarchy.scoped_manifest.body) }], prefixes: [] } }),
  /schema-2.*APPLY.*unsupported/i);
});

test('full fallback retains authenticated schema-2 format authority and rejects a missing checkpoint identity', () => {
  const f = fixture(2), latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [f.hierarchy] });
  const store = { getObjectFromSourceIfExists: () => ({ key: latest.key, body: Buffer.from(latest.body) }) };
  const runState = { dropbox_currentness: { allowed: true, checkpoint: { observations_timeseries_latest: {
    key: latest.key, byte_size: latest.byte_size, sha256: latest.sha256 } } } };
  const finalCatalogue = { entries: [{ ...f.entry, summary: { ...f.entry.summary, row_count: 99 } }],
    by_scope: new Map([[f.entry.scope_id, f.entry]]) };
  const authority = planner.resolveExactV3PlanningAuthority({ runState, store, finalCatalogue,
    delta: { affected_scope_ids: new Set(), removed_scope_ids: new Set() } });
  assert.equal(authority.mode, 'full_canonical_reconstruction_fallback');
  assert.equal(planner.resolveExactV3SelectedFormat({ entry: f.entry, selectedRoots: authority.selected_roots,
    baselineManifestKeys: new Set([f.entry.key]) }).schema_version, 2);
  assert.throws(() => planner.resolveExactV3PlanningAuthority({ runState: {}, store, finalCatalogue }), /authenticated compact latest/);
});

async function canonicalObjects(f) {
  const { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } = await import('../../../workers/shared/uk_aq_r2_history_canonical.mjs');
  const { buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsYearManifest,
    buildR2HistoryV2ObservationsRootManifest, serializeR2HistoryV2ObservationsAggregateManifest }
    = await import('../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs');
  const base = 'history/v3/observations', day = f.entry.scope.day_utc;
  const common = { domain: 'observations', dayUtc: day, writerGitSha: 'a'.repeat(40), backedUpAtUtc: null };
  const connector = buildHistoryV2ConnectorManifest({ ...common, connectorId: 1,
    manifestKey: `${base}/day_utc=${day}/connector_id=1/manifest.json`, pollutantManifests: [f.built.canonical_pollutant_manifest.payload] });
  const d = buildHistoryV2DayManifest({ ...common, manifestKey: `${base}/day_utc=${day}/manifest.json`, connectorManifests: [connector] });
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: 2026, month: '10', dayManifests: [d] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [year] });
  const objects = new Map([[connector.manifest_key, Buffer.from(JSON.stringify(connector))],
    [d.manifest_key, Buffer.from(JSON.stringify(d))],
    ...[month, year, root].map((p, i) => [`${base}/_manifests/${['year=2026/month=10/manifest.json', 'year=2026/manifest.json', 'manifest.json'][i]}`,
      serializeR2HistoryV2ObservationsAggregateManifest(p, { basePrefix: base })])]);
  const store = { getObjectFromSourceIfExists: key => objects.has(key) ? { key, body: objects.get(key) } : null };
  return { objects, store, connector };
}

test('new-scope default requires canonical ancestor absence, not a missing local pollutant file', async () => {
  const f = fixture();
  const { objects, store, connector } = await canonicalObjects(f);
  assert.throws(() => planner.assertPinnedExactV3ScopeAbsent({ scope: f.entry.scope, store }), /already exists/);
  for (const delta of [{ pollutant_code: 'pm25' }, { connector_id: 2 }, { day_utc: '2026-10-11' }, { day_utc: '2026-11-01' }, { day_utc: '2027-01-01' }]) {
    assert.equal(planner.assertPinnedExactV3ScopeAbsent({ scope: { ...f.entry.scope, ...delta }, store }), true);
  }
  objects.delete(connector.manifest_key);
  assert.throws(() => planner.assertPinnedExactV3ScopeAbsent({ scope: { ...f.entry.scope, pollutant_code: 'pm25' }, store }), /manifest unavailable/);
});

test('schema-2 selected removal cannot enter the legacy exact/aligned prefix deletion path', () => {
  const f = fixture(2);
  assert.throws(() => planner.resolveExactV3SelectedFormat({ entry: f.entry, selectedRoots: roots(f),
    baselineManifestKeys: new Set([f.entry.key]), removing: true }), /schema-2.*removal.*blocked/i);
});


test('legacy v3 rebuild authenticates complete canonical membership and actual selectors', async () => {
  const { inventoryAuthoritativeCanonicalObservationHistory } = await import('../lib/observation_history_migration_v3.mjs');
  const f = fixture(), two = fixture(2);
  const { objects } = await canonicalObjects(f);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [f.hierarchy] });
  objects.set(latest.key, Buffer.from(latest.body));
  for (const a of [...f.built.file_intents, f.built.canonical_pollutant_manifest, ...f.hierarchy.publication_objects]) objects.set(a.key, Buffer.from(a.body));
  const args = { observationsPrefix: 'history/v3/observations', v2IndexRoot: 'history/_index_v3/observations_timeseries', v2LatestKey: latest.key,
    getR2Object: async ({ key }) => objects.has(key) ? { key, body: objects.get(key) } : null };
  const inventory = await inventoryAuthoritativeCanonicalObservationHistory(args);
  assert.equal(inventory.partitions.length, 1);
  objects.set(f.hierarchy.scoped_manifest.key, Buffer.from(two.hierarchy.scoped_manifest.body));
  await assert.rejects(() => inventoryAuthoritativeCanonicalObservationHistory(args), /selector identity\/format mismatch/);
  const unrelated = fixture(1, '2026-10-11');
  const incomplete = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [unrelated.hierarchy] });
  objects.set(latest.key, Buffer.from(incomplete.body));
  await assert.rejects(() => inventoryAuthoritativeCanonicalObservationHistory(args), /registry.*canonical scope/);
});
