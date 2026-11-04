import '../../../tests/jsongen_test_environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as planner from '../uk_aq_plan_sos_light_v3_observation_metadata.mjs';
import * as verifier from '../../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs';
import { createCombinedLocalStore } from '../uk_aq_execute_v2_observations_repair_impl.mjs';
import { sha256Hex } from '../../../workers/shared/r2_sigv4.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } from '../../../workers/shared/uk_aq_r2_history_canonical.mjs';
import { buildR2HistoryV2ObservationsMonthManifest, buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsRootManifest, serializeR2HistoryV2ObservationsAggregateManifest }
  from '../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { buildObservationHistoryExactLeafIndexV3ScopedHierarchy, buildObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry, encodeObservationHistoryIndexV3Json as json }
  from '../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';

const base = 'history/v3/observations', rootKey = `${base}/_manifests/manifest.json`;
const identity = a => ({ key: a.key, byte_size: a.byte_size, sha256: a.sha256 });

function canonicalObjects(partitions) {
  const common = { domain: 'observations', dayUtc: '2026-10-10', writerGitSha: 'a'.repeat(40), backedUpAtUtc: null };
  const connector = buildHistoryV2ConnectorManifest({ ...common, connectorId: 1,
    manifestKey: `${base}/day_utc=2026-10-10/connector_id=1/manifest.json`, pollutantManifests: partitions.map(b => b.canonical_pollutant_manifest.payload) });
  const day = buildHistoryV2DayManifest({ ...common, manifestKey: `${base}/day_utc=2026-10-10/manifest.json`, connectorManifests: [connector] });
  const month = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: 2026, month: '10', dayManifests: [day] });
  const year = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: 2026, monthManifests: [month] });
  const root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [year] });
  const objects = new Map(partitions.flatMap(b => [...b.file_intents, b.canonical_pollutant_manifest]).map(a => [a.key, Buffer.from(a.body)]));
  for (const p of [connector, day]) objects.set(p.manifest_key, Buffer.from(JSON.stringify(p)));
  for (const [p, key] of [[month, `${base}/_manifests/year=2026/month=10/manifest.json`],
    [year, `${base}/_manifests/year=2026/manifest.json`], [root, rootKey]]) {
    objects.set(key, serializeR2HistoryV2ObservationsAggregateManifest(p, { basePrefix: base }));
  }
  return { objects, root };
}

function fixture(schema = 2, value = 10, pollutant = 'no2') {
  const rows = [1, 2].map(id => ({ connector_id: 1, station_id: id, timeseries_id: id, pollutant_code: pollutant,
    observed_at_utc: '2026-10-10T01:00:00.000Z', value: value + id, verification_status: 'P' }));
  const built = buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', rows,
    targetWriterGitSha: 'a'.repeat(40), backedUpAtUtc: null });
  const m = built.canonical_pollutant_manifest;
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({ metadata: built.target_metadata,
    canonicalManifest: { ...identity(m), manifest_hash: m.payload.manifest_hash, row_count: m.payload.row_count,
      observation_content_hash: m.payload.observation_content_hash, observation_content_hash_version: 1 }, exactSchemaVersion: schema });
  const { objects, root } = canonicalObjects([built]);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [hierarchy] });
  objects.set(latest.key, Buffer.from(latest.body));
  const reads = [];
  const store = { getObjectFromSourceIfExists(key, source) {
    assert.equal(source, 'dropbox'); reads.push(key);
    return objects.has(key) ? { key, body: objects.get(key), source: 'dropbox' } : null;
  } };
  const runState = { objects: {}, dropbox_currentness: { allowed: true, checkpoint: {
    observations_processed_source_root_hash: root.content_hash, observations_timeseries_latest: identity(latest) } } };
  return { rows, built, hierarchy, objects, reads, store, runState, latest,
    args: { runState, baselineStore: store, scopes: [built.scope] } };
}

function addOverlay(t, f, changed) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage2f-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  f.runState.overlay_root = directory;
  f.runState.execution_path = 'sos_light';
  const s = changed.built.scope;
  const scopeId = `day_utc=${s.day_utc}/connector_id=${s.connector_id}/pollutant_code=${s.pollutant_code}`;
  const sourceDir = path.join(directory, 'source-evidence', scopeId);
  fs.mkdirSync(sourceDir, { recursive: true });
  const rowsBody = Buffer.from(JSON.stringify(changed.rows.map(({ observed_at_utc, ...r }) => ({ ...r, observed_at: observed_at_utc }))));
  const metadata = changed.built.target_metadata;
  const hash = Object.fromEntries(Object.entries(metadata).filter(([k]) => k.startsWith('observation_content_hash') || k === 'verification_status_counts'));
  const evidenceBody = Buffer.from(JSON.stringify({ schema_version: 1, enumeration_complete: true,
    day_utc: s.day_utc, connector_id: s.connector_id, requested_pollutant_set: [s.pollutant_code],
    canonical_rows_bytes: rowsBody.length, canonical_rows_sha256: sha256Hex(rowsBody), total_rows: changed.rows.length,
    per_pollutant_counts: { [s.pollutant_code]: changed.rows.length }, observation_content_hashes: { [s.pollutant_code]: hash } }));
  const rowsPath = path.join(sourceDir, 'obs_history_rows.json'), evidencePath = path.join(sourceDir, 'source-evidence.json');
  fs.writeFileSync(rowsPath, rowsBody); fs.writeFileSync(evidencePath, evidenceBody);
  f.runState.source_evidence_partitions = { [scopeId]: { identity: scopeId, ...s, rows_path: rowsPath, evidence_path: evidencePath,
    rows_sha256: sha256Hex(rowsBody), evidence_sha256: sha256Hex(evidenceBody) } };
  const overlay = new Map([...changed.objects].filter(([key]) => key.startsWith(`${base}/`)));
  for (const [key, body] of overlay) f.runState.objects[key] = { structurally_validated: true, proposed: true, built: true,
    proposal_owner: 'source_derived_observation_repair', bytes: body.length, sha256: sha256Hex(body) };
  const store = { getObjectFromSourceIfExists(key, source) {
    assert.equal(source, 'overlay');
    return overlay.has(key) ? { key, body: overlay.get(key), source: 'planned_overlay' } : null;
  } };
  f.args.repairOverlay = { store };
  return { overlay, rowsPath };
}

test('offline schema-2 reproduces original immutable bytes with only canonical backup and pinned compact latest', async () => {
  const f = fixture();
  const result = await planner.prepareOfflineExactV3Reconstruction(f.args);
  const prepared = result.scopes[0];
  assert.equal(prepared.hierarchy.scoped_manifest.body, f.hierarchy.scoped_manifest.body);
  assert.deepEqual(prepared.hierarchy.exact_leaves.map(identity), f.hierarchy.exact_leaves.map(identity));
  assert.equal(prepared.prepared_matches_checkpoint_selection, true);
  assert.equal(prepared.source_changed, false);
  assert.equal(result.read_only, true);
  for (const field of ['publication_eligible', 'repair_apply_eligible', 'original_writer_completion',
    'observation_event_created', 'jsongen_pending_created', 'jsongen_confirmed_created', 'source_deletion_eligible']) assert.equal(result[field], false);
  assert.equal(result.current_object_authority, null);
  assert.ok(f.reads.every(key => !key.startsWith('history/_index_v3/observations_timeseries/')));
  assert.ok(f.reads.includes(rootKey));
  assert.ok(f.built.file_intents.every(file => f.reads.includes(file.key)));
  assert.ok(prepared.hierarchy.exact_leaves.every(l => l.payload.files.every(file => !Object.hasOwn(file, 'etag'))));
  assert.throws(() => verifier.assertObservationHistoryExactOnlyProofUsableV3(prepared), /missing operation-local/);
});

test('offline schema-1 keeps exact bytes and aligned dependencies, and mixed reconstruction keeps both formats', async () => {
  const one = fixture(1), two = fixture(2, 10, 'pm25');
  const mixed = canonicalObjects([one.built, two.built]);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [one.hierarchy, two.hierarchy] });
  one.objects.clear();
  for (const [key, body] of mixed.objects) one.objects.set(key, body);
  one.objects.set(latest.key, Buffer.from(latest.body));
  one.runState.dropbox_currentness.checkpoint = { observations_processed_source_root_hash: mixed.root.content_hash,
    observations_timeseries_latest: identity(latest) };
  one.args.scopes.push(two.built.scope);
  const [a, b] = (await planner.prepareOfflineExactV3Reconstruction(one.args)).scopes;
  assert.equal(a.hierarchy.scoped_manifest.body, one.hierarchy.scoped_manifest.body);
  assert.deepEqual(a.hierarchy.publication_objects.map(x => x.body), one.hierarchy.publication_objects.map(x => x.body));
  assert.ok(a.hierarchy.aligned_source_manifest);
  assert.equal(b.hierarchy.aligned_source_manifest, undefined);
  assert.ok(b.hierarchy.publication_objects.every(a => [...a.dependencies, ...a.publication_prerequisites].every(d => !d.key.includes('/_aligned/'))));
  const reconciled = planner.reconcileReconstructedExactV3Hierarchies({ hierarchies: [a.hierarchy, b.hierarchy] });
  assert.equal(reconciled.latest.body, latest.body);
});

test('existing filesystem local-store adapters prepare baseline and repair bytes without transport', async t => {
  const f = fixture(), changed = fixture(2, 50);
  const overlay = addOverlay(t, f, changed);
  const directory = f.runState.overlay_root, dropbox = path.join(directory, 'dropbox');
  for (const [key, body] of f.objects) {
    const filename = path.join(dropbox, key);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, body);
  }
  for (const [key, body] of overlay.overlay) {
    const filename = path.join(directory, 'staged', key);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, body);
    f.runState.objects[key].local_path = filename;
  }
  const baselineState = path.join(directory, 'baseline-state.json'), overlayState = path.join(directory, 'overlay-state.json');
  fs.writeFileSync(baselineState, '{}'); fs.writeFileSync(overlayState, JSON.stringify(f.runState));
  const common = { overlayRoot: directory, dropboxRoot: dropbox, prefixes: [base], exactKeys: [f.latest.key] };
  f.args.baselineStore = createCombinedLocalStore({ ...common, runStateJson: baselineState });
  f.args.repairOverlay.store = createCombinedLocalStore({ ...common, runStateJson: overlayState });
  const result = await planner.prepareOfflineExactV3Reconstruction(f.args);
  assert.equal(result.scopes[0].hierarchy.scoped_manifest.body, changed.hierarchy.scoped_manifest.body);
  assert.equal(result.publication_eligible, false);
});

test('changed authenticated repair overlay yields new prepared identities and retains original selected identity', async t => {
  const f = fixture(), changed = fixture(2, 50);
  addOverlay(t, f, changed);
  const p = (await planner.prepareOfflineExactV3Reconstruction(f.args)).scopes[0];
  assert.equal(p.hierarchy.scoped_manifest.body, changed.hierarchy.scoped_manifest.body);
  assert.deepEqual(p.checkpoint_selected_selector, identity(f.hierarchy.scoped_manifest));
  assert.deepEqual(p.prepared_selector, identity(changed.hierarchy.scoped_manifest));
  assert.equal(p.source_changed, true);
  assert.equal(p.prepared_matches_checkpoint_selection, false);
});

test('offline preparation blocks absent or contradictory baseline and selected-format authority', async () => {
  for (const fault of ['latest_absent', 'latest_identity', 'checkpoint', 'root', 'file_absent', 'file_altered', 'scope', 'duplicate_scope', 'missing_scope']) {
    const f = fixture();
    if (fault === 'latest_absent') f.objects.delete(f.latest.key);
    if (fault === 'latest_identity') f.runState.dropbox_currentness.checkpoint.observations_timeseries_latest.sha256 = '0'.repeat(64);
    if (fault === 'checkpoint') f.runState.dropbox_currentness.allowed = false;
    if (fault === 'root') f.runState.dropbox_currentness.checkpoint.observations_processed_source_root_hash = '0'.repeat(64);
    if (fault === 'file_absent') f.objects.delete(f.built.file_intents[0].key);
    if (fault === 'file_altered') f.objects.set(f.built.file_intents[0].key, Buffer.from('wrong'));
    if (fault === 'scope') f.args.scopes = [{ ...f.built.scope, pollutant_code: 'pm25' }];
    if (fault === 'duplicate_scope') f.args.scopes.push(f.built.scope);
    if (fault === 'missing_scope') f.args.scopes = [];
    await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /checkpoint|compact latest|root|missing|unavailable|mismatch|scope|identity/i, fault);
  }
});

test('missing non-derivable original leaf fields block rather than guessing historical ETags or a profile', async () => {
  const f = fixture();
  const tagged = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: { ...f.built.target_metadata, files: f.built.target_metadata.files.map(file => ({ ...file, etag: 'historical-etag',
      row_groups: file.row_groups.map(group => ({ ...group, segments: group.segments.map(segment => ({ ...segment, file_etag: 'historical-etag' })) })) })),
      segments: f.built.target_metadata.segments.map(segment => ({ ...segment, file_etag: 'historical-etag' })) },
    canonicalManifest: f.hierarchy.scoped_manifest.payload.canonical_source_manifest, exactSchemaVersion: 2 });
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [tagged] });
  f.objects.set(latest.key, Buffer.from(latest.body));
  f.runState.dropbox_currentness.checkpoint.observations_timeseries_latest = identity(latest);
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /selected.*identity.*(reproduc|unprov)|original.*bodies/i);
});

test('repair source evidence is rechecked after the whole subset is prepared', async t => {
  const f = fixture(), changed = fixture(2, 50);
  const overlay = addOverlay(t, f, changed);
  const original = f.store.getObjectFromSourceIfExists;
  let latestReads = 0;
  f.store.getObjectFromSourceIfExists = (key, source) => {
    if (key === f.latest.key && ++latestReads === 2) fs.writeFileSync(overlay.rowsPath, '[]');
    return original(key, source);
  };
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /source evidence changed/);
});

test('incomplete overlay provenance and altered source evidence fail before preparation succeeds', async t => {
  for (const fault of ['owner', 'hash', 'evidence', 'source_mismatch', 'file_missing']) {
    const f = fixture(), changed = fixture(2, 50);
    const overlay = addOverlay(t, f, changed);
    const key = changed.built.canonical_pollutant_manifest.key;
    if (fault === 'owner') f.runState.objects[key].proposal_owner = 'unknown';
    if (fault === 'hash') f.runState.objects[key].sha256 = '0'.repeat(64);
    if (fault === 'evidence') fs.writeFileSync(overlay.rowsPath, '[]');
    if (fault === 'source_mismatch') addOverlay(t, f, fixture(2, 60));
    if (fault === 'source_mismatch') f.args.repairOverlay.store = { getObjectFromSourceIfExists: key => overlay.overlay.has(key)
      ? { key, body: overlay.overlay.get(key), source: 'planned_overlay' } : null };
    if (fault === 'file_missing') overlay.overlay.delete(changed.built.file_intents[0].key);
    await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /overlay|source|evidence|mismatch|unavailable|disagree/i, fault);
  }
});

test('offline inspector refuses unsupported physical schema and rechecks changed local bytes', async () => {
  const f = fixture();
  const original = f.store.getObjectFromSourceIfExists;
  let reads = 0;
  f.store.getObjectFromSourceIfExists = (key, source) => {
    if (key === f.built.file_intents[0].key && ++reads === 2) f.objects.set(key, Buffer.from('changed after inspection'));
    return original(key, source);
  };
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /changed|mismatch/);
  await assert.rejects(() => verifier.prepareOfflineObservationHistoryScopeV3({ scope: f.built.scope,
    exactSchemaVersion: 2, getObject: async ({ key }) => {
      const body = key.endsWith('/manifest.json') && key.includes('/pollutant_code=')
        ? Buffer.from(json({ ...f.built.canonical_pollutant_manifest.payload, history_schema_version: 4, writer_version: 'parquet-wasm-zstd-v4' }))
        : f.objects.get(key);
      return body ? { key, body } : null;
    } }), /schema|writer|mismatch|hash/i);
});

test('overlay removals never resurrect pinned baseline bodies through exact or prefix tombstones', async () => {
  for (const fault of ['exact', 'prefix', 'exact_prefix', 'deleted']) {
    const f = fixture();
    const key = f.built.canonical_pollutant_manifest.key;
    f.args.repairOverlay = { store: { getObjectFromSourceIfExists: () => null } };
    if (fault === 'exact' || fault === 'deleted') f.runState.tombstones = { [key]: { [fault === 'exact' ? 'proposed' : 'deleted']: true } };
    if (fault === 'prefix') f.runState.tombstone_prefixes = [{ prefix: key.slice(0, key.lastIndexOf('/')), proposed: true }];
    if (fault === 'exact_prefix') f.runState.tombstone_prefixes = [{ prefix: key, proposed: true, exact_object: true }];
    await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /tombstone|removed|removal/i, fault);
  }
});

test('overlay replacements may satisfy a tombstoned scope but never borrow omitted original files', async t => {
  const f = fixture(), changed = fixture(2, 50);
  const overlay = addOverlay(t, f, changed);
  f.runState.tombstone_prefixes = [{ prefix: `${base}/day_utc=2026-10-10`, proposed: true }];
  assert.equal((await planner.prepareOfflineExactV3Reconstruction(f.args)).scopes[0].source_changed, true);
  const key = changed.built.file_intents[0].key;
  overlay.overlay.delete(key); delete f.runState.objects[key];
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /tombstone|removed|removal/i);
});

test('offline source provenance cannot be relabelled by the preparation adapter', async () => {
  const f = fixture();
  const original = f.store.getObjectFromSourceIfExists;
  f.store.getObjectFromSourceIfExists = (key, source) => {
    const object = original(key, source);
    return object ? { ...object, source: 'live_r2' } : null;
  };
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /source|provenance/i);
});

test('unchanged overlay records retain pinned baseline authority and do not shadow it', async () => {
  for (const changedBody of [false, true]) {
    const f = fixture();
    const key = f.built.canonical_pollutant_manifest.key;
    f.runState.objects[key] = { structurally_validated: true, proposed: true, changed: false,
      status: 'skipped_unchanged', built: true };
    f.args.repairOverlay = { store: { getObjectFromSourceIfExists: candidate => candidate === key
      ? { key, source: 'overlay', body: changedBody ? Buffer.from('untrusted unused bytes') : f.objects.get(key) } : null } };
    const result = await planner.prepareOfflineExactV3Reconstruction(f.args);
    assert.equal(result.scopes[0].source_changed, false);
    assert.equal(result.scopes[0].hierarchy.scoped_manifest.body, f.hierarchy.scoped_manifest.body);
  }
});

test('changed overlays require independently pinned source evidence rather than legacy self-described files', async t => {
  const f = fixture(), changed = fixture(2, 50);
  addOverlay(t, f, changed);
  const retained = Object.values(f.runState.source_evidence_partitions)[0];
  const directory = path.join(f.runState.overlay_root, 'day_utc=2026-10-10', 'connector_id=1');
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(retained.rows_path, path.join(directory, 'obs_history_rows.json'));
  fs.copyFileSync(retained.evidence_path, path.join(directory, 'source-evidence.json'));
  delete f.runState.source_evidence_partitions;
  f.runState.execution_path = 'generic_integrity';
  await assert.rejects(() => planner.prepareOfflineExactV3Reconstruction(f.args), /pinned.*source|source.*provenance/i);
});
