import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { buildR2HistoryV2ObservationsRootManifest,
  serializeR2HistoryV2ObservationsAggregateManifest } from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { ALGORITHM, BUCKET, ROOT, affectedMonths, canonicalJson, createControl,
  assertBundleRecords } from './schema.mjs';
import { selectManagedPublications } from './control.mjs';
import { readImmutableReceipt, readCompleteScopeBundle } from './inputs.mjs';
import { inspectCanonicalScope } from './canonical.mjs';
import { CLASSIFICATION, classifyScope, reconcileRegisteredChanges } from './reconcile.mjs';

const canonicalBucket = 'canonical-test-bucket';
const ref = (key, body = Buffer.from('x')) => ({ bucket: canonicalBucket, key,
  sha256: sha256Hex(body), byte_size: body.length });
const identity = { connector_id: 1, timeseries_id: 212, station_id: 9, pollutant_code: 'pm25' };
const scope = { identity, day_utc: '2026-09-30',
  before: { state: 'authoritative_empty', row_count: 0, authority: ref('prior') },
  after: { state: 'present', row_count: 1, authority: ref('current') } };
const row = { ...identity, observed_at_utc: '2026-09-30T23:00:00.123Z', value: 1.25,
  source_status: null, verification_status: 'P' };
const rootKey = 'history/v2/observations/_manifests/manifest.json';
function fixture() {
  const record = { identity, day_utc: scope.day_utc, state: 'present', rows: [row] };
  const plain = Buffer.from(`${JSON.stringify(record)}\n`);
  const gz = gzipSync(plain);
  const bundleRef = { bucket: BUCKET, key: `${ROOT}/bundles/${sha256Hex(gz)}.ndjson.gz`,
    sha256: sha256Hex(gz), byte_size: gz.length,
    json_sha256: sha256Hex(plain), json_byte_size: plain.length };
  const source = { index_generation: 'v3', history_version: 'v2',
    generation_authority: ref('generation'), observations_root: ref(rootKey),
    index_authority: ref('history/_index_v3/observations_timeseries/scope'),
    final_publication: ref('final'), verification_authority: ref('status'),
    binding_authority: ref('binding'), verified_at_utc: '2026-10-01T00:00:00.000Z' };
  const receipt = { schema_version: 1, kind: 'uk_aq_jsongen_verified_change',
    change_id: 'change-1', writer: { identity: 'Prune Daily', invocation_id: 'run-1' },
    source, scopes: [scope], affected_months: affectedMonths([scope]),
    rolling_aqi: { algorithm_version: ALGORITHM, preceding_hours: 23,
      following_hours: 23, minimum_valid_hours: 18 },
    bundle: { schema_version: 1, format: 'complete_scope_ndjson_gzip',
      change_id: 'change-1', object: bundleRef, scope_count: 1, row_count: 1 },
    verification: { state: 'canonical_final_verified', authority: ref('verify'),
      provenance_authority: ref('provenance'), scope_completeness_authority: ref('complete') },
    durability: { state: 'verified_pending', retained_receipt_authority: ref('outbox') } };
  const receiptBytes = canonicalJson(receipt);
  const receiptRef = { bucket: BUCKET, key: `${ROOT}/receipts/${sha256Hex(receiptBytes)}.json`,
    sha256: sha256Hex(receiptBytes), byte_size: receiptBytes.length };
  return { receipt, receiptRef, receiptBytes, gz, plain };
}
function fakeR2(bucket, objects, hook = null) {
  return { bucket, adapter: { async getObjectBounded({ key, maxBytes }) {
    const value = hook?.(key) ?? objects.get(key);
    if (!value) { const error = new Error('missing'); error.status = 404; throw error; }
    assert.ok(value.length <= maxBytes);
    return { body: value, bytes: value.length };
  } } };
}

test('receipt and bundle prove bytes and complete membership, not writer authentication', async () => {
  const f = fixture();
  const r2 = fakeR2(BUCKET, new Map([[f.receiptRef.key, f.receiptBytes],
    [f.receipt.bundle.object.key, f.gz]]));
  const receipt = await readImmutableReceipt({ r2, reference: f.receiptRef });
  const bundle = await readCompleteScopeBundle({ r2, receipt: receipt.receipt });
  assert.equal(bundle.records[0].rows[0].observed_at_utc, row.observed_at_utc);
  assert.equal(bundle.writer_authentication, 'unavailable');
  assert.deepEqual(receipt.receipt.affected_months.map((x) => x.month_utc), ['2026-09', '2026-10']);
});

test('corrupt compressed/uncompressed bytes and missing or duplicate records fail', async () => {
  const f = fixture();
  const broken = fakeR2(BUCKET, new Map([[f.receipt.bundle.object.key, Buffer.from(f.gz).fill(0, 0, 1)]]));
  await assert.rejects(readCompleteScopeBundle({ r2: broken, receipt: f.receipt }), /compressed bundle byte identity/);
  const wrongPlain = Buffer.from('wrong\n');
  const gz = gzipSync(wrongPlain);
  const changed = structuredClone(f.receipt);
  changed.bundle.object = { ...changed.bundle.object, key: `${ROOT}/bundles/${sha256Hex(gz)}.ndjson.gz`,
    sha256: sha256Hex(gz), byte_size: gz.length };
  await assert.rejects(readCompleteScopeBundle({ r2: fakeR2(BUCKET, new Map([[changed.bundle.object.key, gz]])),
    receipt: changed }), /uncompressed bundle byte identity/);
  for (const lines of ['','{"identity":{}}\n', `${f.plain}${f.plain}`]) {
    const body = Buffer.from(lines);
    const zipped = gzipSync(body);
    const candidate = structuredClone(f.receipt);
    candidate.bundle.object = { ...candidate.bundle.object,
      key: `${ROOT}/bundles/${sha256Hex(zipped)}.ndjson.gz`, sha256: sha256Hex(zipped),
      byte_size: zipped.length, json_sha256: sha256Hex(body), json_byte_size: body.length };
    if (!body.length) continue; // Stage 1 rejects zero-length uncompressed references.
    await assert.rejects(readCompleteScopeBundle({
      r2: fakeR2(BUCKET, new Map([[candidate.bundle.object.key, zipped]])), receipt: candidate }));
  }
});

test('root-proven absence is distinct from unknown 404 and changing root', async () => {
  const root = buildR2HistoryV2ObservationsRootManifest({ yearManifests: [{ year: 2025,
    content_hash: 'a'.repeat(64) }] });
  const body = serializeR2HistoryV2ObservationsAggregateManifest(root);
  const rootRef = ref(rootKey, body);
  const absent = await inspectCanonicalScope({ r2: fakeR2(canonicalBucket, new Map([[rootKey, body]])),
    scope, observationsRoot: rootRef, selectedGeneration: 'v2' });
  assert.equal(absent.state, 'authoritative_absent');
  assert.equal(absent.level, 'year');
  const v3RootKey = 'history/v3/observations/_manifests/manifest.json';
  const v3Root = buildR2HistoryV2ObservationsRootManifest({ basePrefix: 'history/v3/observations',
    yearManifests: [{ year: 2025, content_hash: 'a'.repeat(64) }] });
  const v3Body = serializeR2HistoryV2ObservationsAggregateManifest(v3Root,
    { basePrefix: 'history/v3/observations' });
  const v3Absent = await inspectCanonicalScope({ r2: fakeR2(canonicalBucket,
    new Map([[v3RootKey, v3Body]])), scope, observationsRoot: ref(v3RootKey, v3Body),
    selectedGeneration: 'v3' });
  assert.equal(v3Absent.state, 'authoritative_absent');
  const missing = await inspectCanonicalScope({ r2: fakeR2(canonicalBucket, new Map()),
    scope, observationsRoot: rootRef, selectedGeneration: 'v2' });
  assert.equal(missing.state, 'unresolved');
  let reads = 0;
  const changed = await inspectCanonicalScope({ r2: fakeR2(canonicalBucket, new Map(),
    () => ++reads === 1 ? body : Buffer.from('{}')), scope, observationsRoot: rootRef,
    selectedGeneration: 'v2' });
  assert.equal(changed.state, 'unresolved');
});

test('supersession and independent metadata are per scope and still fail closed', () => {
  const f = fixture();
  const absent = classifyScope({ receipt: f.receipt, scope, canonical: {
    state: 'authoritative_absent', level: 'pollutant', parent_key: 'parent',
    current_root_authenticated: true },
  bytesVerified: true, completeScopeValidated: true });
  assert.equal(absent.classification, CLASSIFICATION.SUPERSEDED);
  const current = classifyScope({ receipt: f.receipt, scope,
    canonical: { state: 'present', authority: scope.after.authority,
      current_root_authenticated: true },
    bytesVerified: true, completeScopeValidated: true });
  assert.equal(current.scope_dominance, 'current_manifest_identity_matches');
  assert.equal(current.classification, CLASSIFICATION.RECONCILIATION_REQUIRED);
  assert.match(current.final_writer_authentication.reason, /frozen source/);
});

test('scope membership/count and unproven empty claims remain blocked', () => {
  const f = fixture();
  const validRecord = { identity, day_utc: scope.day_utc, state: 'present', rows: [row] };
  assert.throws(() => assertBundleRecords([], f.receipt), /missing replacement scope/);
  assert.throws(() => assertBundleRecords([validRecord, validRecord], f.receipt), /missing replacement scope/);
  assert.throws(() => assertBundleRecords([{ ...validRecord, rows: [] }], f.receipt), /complete declared scope/);
  assert.throws(() => assertBundleRecords([{ ...validRecord,
    identity: { ...identity, timeseries_id: 213 } }], f.receipt), /duplicate or undeclared/);
  const empty = structuredClone(f.receipt);
  empty.scopes[0].after = { ...empty.scopes[0].after,
    state: 'authoritative_empty', row_count: 0 };
  empty.bundle.row_count = 0;
  const result = classifyScope({ receipt: empty, scope: empty.scopes[0],
    canonical: { state: 'unresolved', reason: '404 without parent' },
    bytesVerified: true, completeScopeValidated: true });
  assert.equal(result.classification, CLASSIFICATION.RECONCILIATION_REQUIRED);
  assert.ok(result.missing_proof.includes('independent authoritative removal evidence'));
});

test('managed publication selection remains disabled', () => {
  assert.throws(() => selectManagedPublications(), /Managed selection is disabled/);
});

test('unregistered retained writer receipt is reported; coverage remains unknown', async () => {
  const f = fixture();
  const result = await reconcileRegisteredChanges({ control: createControl(),
    r2: fakeR2(BUCKET, new Map([[f.receiptRef.key, f.receiptBytes]])),
    canonicalR2: fakeR2(canonicalBucket, new Map()),
    writerReceiptReferences: [{ change_id: f.receipt.change_id, receipt_object: f.receiptRef }] });
  assert.equal(result.missing_registration[0].state, 'missing_receipt_registration');
  assert.equal(result.missing_registration[0].evidence_state, 'immutable_attestation_only');
  assert.equal(result.registration_coverage, 'unknown');
});
