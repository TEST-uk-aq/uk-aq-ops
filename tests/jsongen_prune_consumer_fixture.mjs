// Local metadata fixture for the Stage 3B authority/retention boundary only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonicalJson, BUCKET } from '../scripts/jsongen/schema.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { describePrunePendingSource } from '../scripts/jsongen/prune-evidence.mjs';
import { preparePruneOriginalFinalEvidence, attachPruneOriginalEvidenceBundleReference } from '../scripts/jsongen/prune-final-evidence.mjs';
import { pruneEvidenceBundleIntentId } from '../scripts/jsongen/prune-evidence-bundle.mjs';
import { createPruneOriginalMetadataCapture, preparePruneOriginalMetadataSnapshot } from '../scripts/jsongen/prune-original-metadata.mjs';
import { observationsGlobalOperationLockIdentity, OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV } from '../workers/shared/uk_aq_r2_history_writer.mjs';
import { buildObservationHistoryV3SteadyStatePartition } from '../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs';
import { buildObservationHistoryExactLeafIndexV3Latest } from '../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { buildHistoryV2ConnectorManifest, buildHistoryV2DayManifest } from '../workers/shared/uk_aq_r2_history_canonical.mjs';
import { buildR2HistoryV2ObservationsRootManifest, buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsMonthManifest, serializeR2HistoryV2ObservationsAggregateManifest } from '../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { buildTimeseriesBindingSourceRangeManifest, buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey, TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND } from '../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { buildTimeseriesBindingSourceState } from '../scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs';

const etag = body => `"${sha256Hex(body)}"`;
export async function sourceAndOriginalEvent(scopes = 1024, options = {}) {
  const environment = options.environment ?? 'TEST';
  const run = options.runId || 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb', day = options.dayUtc || '2026-10-10';
  const key = { environment, writer_identity: 'prune_daily_v3', run_id: run, attempt_id: run, day_utc: day, connector_id: 1 };
  // Spread the 1,024-scope case across original 1,000-ID ranges so no retained
  // shard exceeds the writer's unchanged 1 MiB per-object capture ceiling.
  const rows = Array.from({ length: scopes }, (_, i) => ({ connector_id: 1, station_id: i + 1, timeseries_id: i + 1 + Math.floor(i / 512) * 1000,
    pollutant_code: options.pollutants?.[i % options.pollutants.length] || 'pm25', observed_at_utc: `${day}T01:02:03.004Z`, observed_at: `${day}T01:02:03.${options.aliasMismatch ? '005' : '004'}Z`,
    value: 1.2345678901234567, verification_status: ['P', 'R', null][i % 3] })).flatMap(r => [r, { ...r }]);
  const source = Buffer.concat(rows.map(canonicalJson)), compressed = gzipSync(source, { mtime: 0 });
  const sourceIdentity = computePruneConnectorSourceIdentity(rows);
  const object = { bucket: BUCKET, key: `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=1/day_utc=${day}`
    + `/invocation=${run}/compressed_sha256=${sha256Hex(compressed)}/uncompressed_sha256=${sha256Hex(source)}.ndjson.gz`,
  sha256: sha256Hex(compressed), byte_size: compressed.length, json_sha256: sha256Hex(source), json_byte_size: source.length };
  const intent = createHash('sha256').update(JSON.stringify(['uk_aq_jsongen_upload_intent_v1', BUCKET, object.key,
    'prune_daily_v3', run, 'v3', 1, day, 'connector_day_observations_ndjson_gzip', object.byte_size, object.sha256,
    object.json_byte_size, object.json_sha256, 'connector_day', 1, day])).digest('hex');
  const unsigned = describePrunePendingSource({ source, compressed, rows, runId: run, dayUtc: day, connectorId: 1, sourceIdentity, environment });
  const description = { ...unsigned, signed_upload: { intent_id: intent, object, disposition: 'put_acknowledged_unverified' } };
  const pending = { state: 'put_acknowledged_unverified', intent_id: intent, source: object, pending_evidence: description,
    source_evidence_sha256: sha256Hex(canonicalJson(unsigned)), preparation_sha256: sha256Hex(canonicalJson(description)) };
  const base = 'history/v3/observations', git = '4'.repeat(40), bucket = 'canonical-test';
  const common = { domain: 'observations', dayUtc: day, writerGitSha: git, backedUpAtUtc: null };
  const canon = rows.map(({ observed_at, ...r }) => r);
  const partition = r => buildObservationHistoryV3SteadyStatePartition({ source: 'integrity', rows: r, targetWriterGitSha: git, backedUpAtUtc: null });
  const prior = partition([{ ...canon[0], connector_id: 8, timeseries_id: 9001, station_id: 71 }]);
  const currents = [...new Set(canon.map(r => r.pollutant_code))].sort()
    .map(code => partition(canon.filter(r => r.pollutant_code === code)));
  const connectorFor = (id, p) => buildHistoryV2ConnectorManifest({ ...common, connectorId: id,
    manifestKey: `${base}/day_utc=${day}/connector_id=${id}/manifest.json`, pollutantManifests: [p].flat().map(p => p.payload) });
  const previous = connectorFor(8, prior.canonical_pollutant_manifest), manifest = connectorFor(1, currents.map(c => c.canonical_pollutant_manifest));
  const hierarchy = connectors => {
    const d = buildHistoryV2DayManifest({ ...common, manifestKey: `${base}/day_utc=${day}/manifest.json`, connectorManifests: connectors });
    const m = buildR2HistoryV2ObservationsMonthManifest({ basePrefix: base, year: day.slice(0, 4), month: day.slice(5, 7), dayManifests: [d] });
    const mk = `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`;
    const y = buildR2HistoryV2ObservationsYearManifest({ basePrefix: base, year: day.slice(0, 4), monthManifests: [{ ...m, manifest_key: mk }] });
    const yk = `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`;
    const r = buildR2HistoryV2ObservationsRootManifest({ basePrefix: base, yearManifests: [{ ...y, manifest_key: yk }] });
    return [{ key: `${base}/_manifests/manifest.json`, body: serializeR2HistoryV2ObservationsAggregateManifest(r, { basePrefix: base }) },
      { key: yk, body: serializeR2HistoryV2ObservationsAggregateManifest(y, { basePrefix: base }) },
      { key: mk, body: serializeR2HistoryV2ObservationsAggregateManifest(m, { basePrefix: base }) },
      { key: d.manifest_key, body: Buffer.from(JSON.stringify(d)) }];
  };
  const capture = createPruneOriginalMetadataCapture(), lockIdentity = observationsGlobalOperationLockIdentity();
  const lock = { held: 'true', acquired: 'true', owner: 'prune_daily', runId: run, logicalIdentity: lockIdentity.logical_identity,
    classId: String(lockIdentity.class_id), objectId: String(lockIdentity.object_id), nonce: 'fixture-nonce', waitMs: '0', outcome: 'held' };
  const original = capture.beginOriginalAuthority({ environment, index_generation: 'v3', canonical_bucket: bucket,
    writer: { identity: 'prune_daily_v3', invocation_id: run, attempt_id: run, git_sha: git }, connector_id: 1, day_utc: day, source_identity: sourceIdentity },
  Object.fromEntries(Object.entries(lock).map(([k, v]) => [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV[k], v])));
  const old = hierarchy([previous]); old.forEach(o => original.recordBeforeObject(o));
  const oldLatest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [prior.v3_hierarchy] });
  original.recordBeforeObject({ key: oldLatest.key, body: Buffer.from(oldLatest.body) });
  original.recordBeforeAdmission({ admission: 'first_publication', membership: 'authoritative_empty', row_count: 0, previous_authority: null,
    observations_root_key: old[0].key, hierarchy_keys: old.map(o => o.key), authority_key: old.at(-1).key,
    absence: { parent_key: old.at(-1).key, child_field: 'connector_id', child_identity: 1 }, index_discovery_key: oldLatest.key });
  const prefix = 'history/_index_v3/timeseries_binding', bindings = new Map(), byRange = new Map();
  for (const s of unsigned.scope.physical_timeseries_days) {
    const k = `${prefix}/timeseries_id=${s.timeseries_id}.json`, body = canonicalJson({ schema_version: 1, history_version: 'v2',
      index_kind: 'timeseries_binding', connector_id: 1, timeseries_id: s.timeseries_id, station_id: s.station_id, pollutant_code: s.pollutant_code });
    bindings.set(k, body); const start = Math.floor(s.timeseries_id / 1000) * 1000;
    if (!byRange.has(start)) byRange.set(start, []);
    byRange.get(start).push({ timeseries_id: s.timeseries_id, relative_path: k, size: body.length, sha256: sha256Hex(body) });
  }
  const ranges = [...byRange].map(([start, units]) => {
    const r = buildTimeseriesBindingSourceRangeManifest({ bindingPrefix: prefix, rangeStart: start, units });
    const k = timeseriesBindingSourceRangeManifestKey(prefix, start); bindings.set(k, canonicalJson(r));
    return { range_start: start, range_end: start + 999, manifest_key: k, source_range_hash: r.source_range_hash, unit_count: units.length };
  });
  const root = buildTimeseriesBindingSourceRootManifest({ bindingPrefix: prefix, ranges });
  const sourceState = buildTimeseriesBindingSourceState({ bindingPrefix: prefix, sourceSchema: 'uk_aq_core',
    sourceFingerprint: 'f'.repeat(64), authoritativeTimeseriesCount: scopes,
    sourceTables: ['timeseries', 'phenomena', 'observed_properties'].map(table => ({ table, row_count: scopes, sha256_uncompressed: 'd'.repeat(64) })) });
  bindings.set(`${prefix}/_manifests/root.json`, canonicalJson(root)); bindings.set(`${prefix}/_source_state.json`, canonicalJson(sourceState));
  bindings.set(`${prefix}/_manifests/_refresh_state.json`, canonicalJson({ schema_version: 1, kind: TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND,
    history_version: 'v2', source_prefix: prefix, source_root_hash: root.source_root_hash, source_fingerprint: sourceState.source_fingerprint }));
  await original.captureBindings({ physicalScopes: unsigned.scope.physical_timeseries_days, r2: { bucket }, deadlineAtMs: Date.now() + 15000,
    getObject: async ({ key }) => ({ body: bindings.get(key), bytes: bindings.get(key).length }) });
  assert.equal(original.snapshot().completeness, 'captured');
  const add = o => { const body = Buffer.from(o.body); capture.recordPublishedObject({ key: o.key, body });
    return { key: o.key, sha256: sha256Hex(body), byte_size: body.length, verified: true, durable: true }; };
  const children = currents.map(c => c.canonical_pollutant_manifest), childRefs = children.map(add), connectorRef = add({ key: manifest.manifest_key, body: JSON.stringify(manifest) });
  const exact = currents.flatMap(c => c.v3_hierarchy.publication_objects.map(add)), finals = hierarchy([previous, manifest]).map(add);
  const latest = add(buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [prior.v3_hierarchy, ...currents.map(c => c.v3_hierarchy)] }));
  const pin = r => ({ key: r.key, sha256: r.sha256, byte_size: r.byte_size });
  const connector = { manifest_key: manifest.manifest_key, manifest_hash: manifest.manifest_hash, run_id: run, day_utc: day, connector_id: 1,
    source_row_count: rows.length, file_count: manifest.file_count, total_bytes: manifest.total_bytes,
    connector_manifest: { bucket, ...pin(connectorRef) }, pollutant_manifests: children.map((child, i) => ({
      ...unsigned.scope.pollutant_partitions.find(p => p.pollutant_code === child.payload.pollutant_code),
      manifest: { bucket, ...pin(childRefs[i]), semantic_manifest_hash: child.payload.manifest_hash }, files: child.payload.files.map(f => ({ key: f.key,
        row_count: f.row_count, byte_size: f.bytes, sha256: f.etag_or_hash, timeseries_row_counts: f.timeseries_row_counts || null })) })),
    scoped_roots: currents.map(c => ({ scope: { connector_id: 1, day_utc: day, pollutant_code: c.canonical_pollutant_manifest.payload.pollutant_code },
      reference: pin(c.v3_hierarchy.scoped_manifest) })) };
  const snapshot = preparePruneOriginalMetadataSnapshot({ capture, bucket, dayUtc: day, connectorId: 1, runId: run, writerGitSha: git,
    canonicalReferences: [connectorRef, ...childRefs], exactReferences: exact, dayReferences: [finals.at(-1)], affectedDaysUtc: [day],
    aggregateReferences: finals.slice(0, 3), latestReferences: [latest] });
  let prepared = preparePruneOriginalFinalEvidence({ pending, connector, runId: run, dayUtc: day, connectorId: 1, writerGitSha: git,
    evidenceMode: options.evidenceBundle ? 'r2_bundle' : 'inline',
    sourceIdentity, originalMetadataSnapshot: snapshot, originalAuthorityCapture: original,
    finalization: { ok: true, affected_days_utc: [day], day_results: [{ day_utc: day, day_manifest: finals.at(-1) }],
      canonical_aggregate_result: { canonical_aggregate_authority_verified: true, parent_state_reread_under_lock: true,
        affected_days_utc: [day], aggregate_manifests: finals.slice(0, 3) },
      v3_publication: { exact_scopes: currents.map(() => ({ ok: true })), latest_global: { ok: true, objects: [latest] } } } });
  let bundleObject = null;
  if (options.mutateOriginal) {
    assert.equal(options.evidenceBundle, true);
    options.mutateOriginal(prepared.envelope);
    // Re-encode through the real bundle codec, preserving consistent transport
    // hashes while leaving semantic authority corruption for the reader to find.
    const { encodePruneEvidenceBundle } = await import('../scripts/jsongen/prune-evidence-bundle.mjs');
    prepared.bundle = encodePruneEvidenceBundle(prepared.envelope);
  }
  if (options.evidenceBundle) {
    const b = prepared.bundle, identity = prepared.bundle_identity;
    const bundleKey = `managed/jsongen/v1/evidence-bundles/prune_daily_v3/connector_id=1/day_utc=${day}/invocation=${run}/compressed_sha256=${b.sha256}.json.gz`;
    const ref = { ...identity, bucket: BUCKET, key: bundleKey, compressed_byte_size: b.byte_size,
      compressed_sha256: b.sha256, uncompressed_byte_size: b.json_byte_size, uncompressed_sha256: b.json_sha256 };
    ref.intent_id = pruneEvidenceBundleIntentId({ ...ref, identity });
    bundleObject = [bundleKey, b.body];
    prepared = attachPruneOriginalEvidenceBundleReference(prepared, ref);
  }
  const row = { ...key, event_schema_version: 1, writer_git_sha: git, accepted_at: `${day}T02:00:00.123456Z`, ...sourceIdentity,
    history_manifest_key: manifest.manifest_key, history_manifest_hash: manifest.manifest_hash, history_row_count: rows.length,
    history_file_count: manifest.file_count, history_total_bytes: manifest.total_bytes, gate_history_completed_at: `${day}T02:00:00.000Z`,
    gate_completion_source: 'prune_daily_phase_b', candidate_ready_marker: 'PRUNE_FIRST_DELETE_READY:v1',
    connector_manifest_byte_sha256: connectorRef.sha256, connector_manifest_byte_size: connectorRef.byte_size,
    pending_disposition: 'put_acknowledged_unverified', pending_intent_id: intent, pending_bucket: BUCKET, pending_object_key: object.key,
    pending_compressed_sha256: object.sha256, pending_compressed_byte_size: object.byte_size, pending_ndjson_sha256: object.json_sha256,
    pending_ndjson_byte_size: object.json_byte_size, original_source_status_provenance: 'original_source_status_unavailable',
    final_evidence_state: 'prepared_unverified', final_evidence_bytes: prepared.bytes, final_evidence_sha256: prepared.sha256, final_evidence_byte_size: prepared.byte_size };
  let visible = true, hook = null; const objects = new Map([[object.key, compressed], ...(bundleObject ? [bundleObject] : [])]), queries = [];
  class Client {
    async connect() {} async end() {}
    async query(sql, args) { queries.push({ sql, args }); assert.doesNotMatch(sql, /history_candidates|prune_connector_day_gates/);
      if (sql.startsWith('SELECT current_setting')) return { rows: [{ read_only: true, default_read_only: true, restricted_role: true,
        reader_membership: true, reader_policy: true, can_read: true, can_mutate: false, can_accept: false }] };
      if (sql.includes('FROM uk_aq_ops.prune_jsongen_gate_acceptance_outbox')) return { rows: visible ? [{ ...row }] : [] };
      assert.match(sql, /^(BEGIN READ ONLY|COMMIT|ROLLBACK)$/); return { rows: [] }; }
  }
  const get = async ({ key }) => { assert.ok(key.startsWith('managed/jsongen/v1/')); assert.ok(!key.endsWith('.parquet'));
    if (!objects.has(key)) throw Object.assign(new Error('fixture missing'), { status: 404 });
    const body = objects.get(key); return { body: Buffer.from(body), bytes: body.length, etag: etag(body) }; };
  const r2 = { bucket: BUCKET, region: 'auto', endpoint: options.r2Endpoint || process.env.UK_AQ_JSONGEN_R2_ENDPOINT,
    adapter: { getObject: get, getObjectBounded: get, async putObjectConditional(args) {
      if (hook) { const result = await hook(args); if (result) return result; }
      const old = objects.get(args.key);
      if ((args.if_none_match === '*' && old) || (args.if_match && (!old || args.if_match !== etag(old)))) return { status: 412 };
      objects.set(args.key, Buffer.from(args.body)); return { status: 200, etag: etag(args.body) }; } } };
  return { Client, row, key, r2, objects, queries, pendingRef: object, setVisible: v => { visible = v; }, setHook: v => { hook = v; },
    setBody: v => { objects.set(object.key, v); }, setEnvelope: e => { row.final_evidence_bytes = canonicalJson(e);
      row.final_evidence_sha256 = sha256Hex(row.final_evidence_bytes); row.final_evidence_byte_size = row.final_evidence_bytes.length; } };
}
