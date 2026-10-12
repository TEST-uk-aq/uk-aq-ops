// Read-only, configured-generation metadata inspection. Receipt paths are never
// used as current authority. This does not authenticate historical writer output.
import { r2GetObjectBounded, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { classifyManifestFileIdentity } from '../../workers/shared/uk_aq_r2_file_identity.mjs';
import { assertObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { validateR2HistoryV2ObservationsAggregateManifest, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS } from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { assertV2ObservationsChildManifest } from '../backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs';
import { readObservationHistoryExactLeafDailyMetadataV3 } from '../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs';
import { encodeObservationHistoryIndexV3Json, observationHistoryIndexV3RangeForTimeseriesId } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION, OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION }
  from '../../workers/shared/uk_aq_observation_history_target_writer.mjs';
import { validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  timeseriesBindingSourceRootKey } from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { OBSERVATION_VERIFICATION_LATEST_KEY, validateObservationVerificationLatest,
  validateObservationVerificationConnectorManifest, encodeObservationVerificationJson } from '../../workers/shared/uk_aq_observation_verification_overlay.mjs';
import { assertScope, assertReference, scopeKey, same, canonicalJson, BUCKET } from './schema.mjs';
import { createBudget, evidence, parseJson, freeze } from './limits.mjs';

const sha = /^[a-f0-9]{64}$/;
const descriptor = (bucket, key, body) => ({ bucket, key, byte_size: body.length, sha256: sha256Hex(body) });
function child(parent, fields, parentKey, expectedKey, kind) {
  const lists = fields.map(field => {
    evidence(Array.isArray(parent[field]), 'invalid_canonical_metadata', `missing complete ${field}: ${parentKey}`);
    const entries = new Map();
    for (const entry of parent[field]) {
      const id = kind === 'connector' ? entry?.connector_id : entry?.pollutant_code;
      const segment = kind === 'connector' ? `connector_id=${id}` : `pollutant_code=${id}`;
      evidence((kind === 'connector' ? Number.isSafeInteger(id) && id > 0 : /^[a-z0-9_]+$/.test(id))
        && entry.manifest_key === `${parentKey.slice(0, -14)}/${segment}/manifest.json`
        && sha.test(entry.manifest_hash) && !entries.has(entry.manifest_key),
      'invalid_canonical_metadata', `invalid or duplicate ${field} membership`);
      entries.set(entry.manifest_key, entry);
    }
    return [...entries].sort(([a], [b]) => a.localeCompare(b));
  });
  evidence(same(lists[0], lists[1]), 'invalid_canonical_metadata', 'contradictory complete child aliases');
  return new Map(lists[0]).get(expectedKey) || null;
}
function canonicalIndex(object) {
  evidence(Buffer.from(encodeObservationHistoryIndexV3Json(object.value)).equals(object.body),
    'invalid_canonical_metadata', 'index object is not canonical JSON');
}

export async function readCanonicalScopes({ r2, generation, bindingPrefix = null, scopes, budget = createBudget() }) {
  assertObservationHistoryGeneration(generation);
  evidence(generation.version === 'v3' && r2?.bucket && r2.bucket !== BUCKET,
    'invalid_canonical_configuration', 'explicit canonical v3 generation and separate canonical bucket required');
  evidence(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= budget.limits.scopes,
    'resource_limit', 'canonical scope budget exceeded');
  scopes = structuredClone(scopes); scopes.forEach(assertScope);
  evidence(new Set(scopes.map(scopeKey)).size === scopes.length, 'invalid_scope', 'duplicate canonical scope');
  const base = generation.observations_prefix;
  const indexRoot = generation.observations_timeseries_index_prefix;
  const cache = new Map(); const provenance = new Map();
  const allowed = key => key.endsWith('.json') && (
    key.startsWith(`${base}/`) || key.startsWith(`${indexRoot}/`) ||
    (bindingPrefix && key.startsWith(`${bindingPrefix}/`)) ||
    key === OBSERVATION_VERIFICATION_LATEST_KEY || key.startsWith('history/v3/verification/'));
  const read = async (key, fresh = false) => {
    evidence(allowed(key) && !key.includes('/../') && !key.includes('/./') && !/[\\\x00-\x20?#%]/.test(key),
      'invalid_canonical_metadata', 'metadata key outside explicitly configured domains');
    if (!fresh && cache.has(key)) return cache.get(key);
    const maxBytes = Math.min(budget.limits.metadata_bytes, budget.remainingBytes());
    evidence(maxBytes > 0, 'resource_limit', 'canonical metadata byte budget exhausted');
    budget.get('metadata');
    const object = await r2GetObjectBounded({ r2, key, max_bytes: maxBytes, timeout_ms: budget.timeout() });
    budget.bytes('metadata', object.bytes);
    const result = { body: object.body, value: parseJson(object.body), reference: descriptor(r2.bucket, key, object.body) };
    if (!fresh) { cache.set(key, result); provenance.set(key, result.reference); }
    return result;
  };
  const pinned = async reference => {
    const ref = { bucket: r2.bucket, key: reference.key, byte_size: reference.byte_size, sha256: reference.sha256 };
    assertReference(ref);
    const object = await read(ref.key);
    evidence(same(ref, object.reference), 'invalid_canonical_metadata', `metadata byte identity mismatch: ${ref.key}`);
    return object;
  };
  const hierarchy = async scope => {
    const day = scope.day_utc; const id = scope.identity;
    const keys = [generation.observations_root_key,
      `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`,
      `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`,
      `${base}/day_utc=${day}/manifest.json`,
      `${base}/day_utc=${day}/connector_id=${id.connector_id}/manifest.json`,
      `${base}/day_utc=${day}/connector_id=${id.connector_id}/pollutant_code=${id.pollutant_code}/manifest.json`];
    let parent = null; const chain = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]; const hashField = i < 3 ? 'content_hash' : 'manifest_hash';
      const reference = i === 0 ? null : i <= 3
        ? parent.children.find(c => c.manifest_key === key)
        : child(parent, i === 4 ? ['connector_manifests', 'child_manifests'] : ['pollutant_manifests', 'child_manifests'], keys[i - 1], key, i === 4 ? 'connector' : 'pollutant');
      if (i > 0 && !reference) return { membership: 'authoritative_absent', absent_at: key, chain };
      // Referenced 404, timeout or invalid JSON throws; never interpreted as absence.
      const object = await read(key); const value = object.value;
      if (i < 3) {
        const validated = validateR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: base });
        evidence(same(value, validated), 'invalid_canonical_metadata', 'aggregate payload is noncanonical');
        const kinds = ['root', 'year', 'month'];
        evidence(value.kind === OBSERVATIONS_AGGREGATE_MANIFEST_KINDS[kinds[i]], 'invalid_canonical_metadata', 'wrong aggregate kind');
        // The shared validator owns kind/hash construction; compare the selected
        // child identity as well, so a root cannot masquerade as a year/month.
        evidence(i === 0 ? !Object.hasOwn(value, 'year') : String(value.year) === day.slice(0, 4),
          'invalid_canonical_metadata', `wrong aggregate level: ${kinds[i]}`);
        if (i === 2) evidence(String(value.month).padStart(2, '0') === day.slice(5, 7), 'invalid_canonical_metadata', 'wrong aggregate month');
      } else {
        const kind = i === 3 ? 'day' : i === 4 ? 'connector' : 'pollutant';
        assertV2ObservationsChildManifest(value, { key, kind, dayUtc: day, connectorId: i > 3 ? id.connector_id : null });
        validateCanonicalHistoryV2Manifest(value, { manifest_kind: kind, manifest_key: key, day_utc: day });
        if (i === 5) evidence(value.pollutant_code === id.pollutant_code, 'invalid_canonical_metadata', 'wrong pollutant');
      }
      if (reference) evidence(reference[hashField] === value[hashField], 'invalid_canonical_metadata', 'root-to-scope hash link mismatch');
      chain.push({ ...object.reference, logical_hash: value[hashField] }); parent = value;
    }
    return { membership: 'partition_present', chain, pollutant: parent };
  };
  const exact = async (scope, h) => {
    const id = scope.identity; const suffix = `day_utc=${scope.day_utc}/connector_id=${id.connector_id}/pollutant_code=${id.pollutant_code}`;
    const manifest = await read(`${indexRoot}/${suffix}/manifest.json`); canonicalIndex(manifest);
    const aligned = await pinned(manifest.value.source_aligned_scoped_manifest); canonicalIndex(aligned);
    evidence(aligned.reference.key === `${indexRoot}/_aligned/${suffix}/manifest.json`, 'invalid_canonical_metadata', 'wrong aligned scope');
    const source = aligned.value.canonical_source_manifest;
    const pollutant = h.chain.at(-1);
    evidence(source && source.key === pollutant.key && source.sha256 === pollutant.sha256 && source.byte_size === pollutant.byte_size
      && source.manifest_hash === h.pollutant.manifest_hash && source.row_count === h.pollutant.row_count
      && source.observation_content_hash === h.pollutant.observation_content_hash,
    'invalid_canonical_metadata', 'exact index does not select the root-authenticated pollutant');
    const metadata = await readObservationHistoryExactLeafDailyMetadataV3({
      source: { getIndexObject: async ({ key }) => { const object = await read(key); return { body: object.body, byte_size: object.body.length }; } },
      timeseriesId: id.timeseries_id, connectorId: id.connector_id, pollutantCode: id.pollutant_code,
      startUtc: `${scope.day_utc}T00:00:00.000Z`, endUtc: new Date(Date.parse(`${scope.day_utc}T00:00:00.000Z`) + 86400000).toISOString(),
      index: { root: indexRoot, alignedIndexRoot: `${indexRoot}/_aligned`, alignedDataRoot: base,
        indexGeneration: 'v3', historyVersion: 'v2', physicalLayoutVersion: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
        alignedRowCap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
        decodeProfileId: OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID,
        manifestKind: 'observation_timeseries_physical_leaf_scoped_manifest',
        leafKind: 'observation_timeseries_physical_leaf',
        additionalCommonFields: { exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION } },
    });
    evidence(metadata.coverage_complete, 'invalid_canonical_metadata', 'incomplete exact physical membership');
    const counts = h.pollutant.timeseries_row_counts;
    evidence(counts && typeof counts === 'object' && !Array.isArray(counts)
      && Object.values(counts).every(n => Number.isSafeInteger(n) && n > 0)
      && Object.values(counts).reduce((a, b) => a + b, 0) === h.pollutant.row_count,
    'invalid_canonical_metadata', 'complete canonical timeseries counts unavailable');
    const leafSet = manifest.value.leaves_by_timeseries_id;
    evidence(same(Object.keys(leafSet).sort(), Object.keys(counts).sort()), 'invalid_canonical_metadata', 'exact/canonical physical member sets disagree');
    const tuple = leafSet[String(id.timeseries_id)];
    if (!tuple) return { membership: 'authoritative_absent', row_count: 0, index: manifest.reference };
    const leaf = await pinned({ key: tuple[0], byte_size: tuple[1], sha256: tuple[2] }); canonicalIndex(leaf);
    evidence(metadata.rows.length === 1 && metadata.rows[0].row_count === counts[String(id.timeseries_id)],
      'invalid_canonical_metadata', 'exact/canonical row count mismatch');
    const alignedChild = leaf.value.source_aligned_child;
    const range = observationHistoryIndexV3RangeForTimeseriesId(id.timeseries_id);
    const rangeName = `${String(range.range_start).padStart(6, '0')}-${String(range.range_end).padStart(6, '0')}`;
    evidence(alignedChild?.key === `${indexRoot}/_aligned/${suffix}/range=${rangeName}.json`,
      'invalid_canonical_metadata', 'leaf aligned shard key/range is contradictory');
    const children = aligned.value.children;
    const descriptor = Array.isArray(children) && children.find(c => c.key === alignedChild.key);
    evidence(descriptor && children.filter(c => c.key === alignedChild.key).length === 1
      && descriptor.sha256 === alignedChild.sha256 && descriptor.byte_size === alignedChild.byte_size
      && descriptor.range_start === range.range_start && descriptor.range_end === range.range_end,
    'invalid_canonical_metadata', 'leaf is not an exact member of its aligned scope');
    const shard = await pinned(alignedChild); canonicalIndex(shard);
    const payload = shard.value;
    evidence(payload.kind === 'observation_timeseries_aligned_source_shard'
      && payload.key === alignedChild.key && payload.day_utc === scope.day_utc
      && payload.connector_id === id.connector_id && payload.pollutant_code === id.pollutant_code
      && payload.index_generation === 'v3' && payload.history_version === 'v2'
      && payload.physical_layout_version === OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION
      && payload.range_start === range.range_start && payload.range_end === range.range_end
      && same(payload.canonical_source_manifest, source),
    'invalid_canonical_metadata', 'aligned shard contradicts canonical pollutant source or scope');
    const expectedIds = Object.keys(counts).map(Number)
      .filter(n => n >= range.range_start && n <= range.range_end).sort((a, b) => a - b);
    const shardFileKeys = new Set(Array.isArray(payload.files) ? payload.files.map(f => f.key) : []);
    evidence(Array.isArray(payload.timeseries)
      && same(payload.timeseries.map(t => t.timeseries_id), expectedIds)
      && payload.timeseries.every(t => Number.isSafeInteger(t.row_count) && t.row_count > 0
        && t.row_count === counts[String(t.timeseries_id)] && Array.isArray(t.segments)
        && t.segments.length > 0 && t.segments.every(s => Number.isSafeInteger(s.row_count)
          && s.row_count > 0 && shardFileKeys.has(s.file_key))
        && t.segments.reduce((n, s) => n + s.row_count, 0) === t.row_count)
      && payload.timeseries.find(t => t.timeseries_id === id.timeseries_id)?.row_count === leaf.value.row_count,
    'invalid_canonical_metadata', 'aligned shard timeseries membership or row counts disagree');
    evidence(Array.isArray(payload.files) && leaf.value.files.every(f => payload.files.some(s =>
      s.key === f.key && s.sha256 === f.sha256 && s.byte_size === f.byte_size))
      && payload.files.every(f => h.pollutant.files.some(s => {
        const identity = classifyManifestFileIdentity(s.etag_or_hash, { objectKey: f.key });
        return s.key === f.key && s.bytes === f.byte_size
          && identity.type === 'sha256' && identity.value === f.sha256;
      })), 'invalid_canonical_metadata', 'aligned shard file identity disagrees with exact/canonical files');
    // Check file identity membership without ever fetching Parquet.
    for (const file of leaf.value.files) {
      const canonical = h.pollutant.files.find(f => f.key === file.key);
      const fileIdentity = canonical && classifyManifestFileIdentity(canonical.etag_or_hash, { objectKey: file.key });
      evidence(canonical && canonical.bytes === file.byte_size && fileIdentity.type === 'sha256' && fileIdentity.value === file.sha256,
        'invalid_canonical_metadata', 'exact file not pinned by canonical pollutant');
    }
    return { membership: 'present', row_count: metadata.rows[0].row_count,
      index: manifest.reference, leaf: leaf.reference, aligned_shard: shard.reference };
  };
  const binding = async identity => {
    evidence(['history/_index_v2/timeseries_binding', generation.timeseries_binding_index_prefix].includes(bindingPrefix),
      'binding_authority_unresolved', 'explicit accepted binding-prefix selection required; documentation/runtime routing differs');
    const root = validateTimeseriesBindingSourceRootManifest((await read(timeseriesBindingSourceRootKey(bindingPrefix))).value);
    evidence(root.source_prefix === bindingPrefix, 'invalid_binding_authority', 'wrong binding root');
    const rangeRef = root.ranges.find(r => r.range_start <= identity.timeseries_id && r.range_end >= identity.timeseries_id);
    evidence(rangeRef, 'invalid_binding_authority', 'physical binding range is not authoritative');
    const range = validateTimeseriesBindingSourceRangeManifest((await read(rangeRef.manifest_key)).value);
    evidence(range.source_prefix === bindingPrefix && range.source_range_hash === rangeRef.source_range_hash
      && range.units.length === rangeRef.unit_count && range.range_start === rangeRef.range_start && range.range_end === rangeRef.range_end,
    'invalid_binding_authority', 'binding root/range mismatch');
    const unit = range.units.find(u => u.timeseries_id === identity.timeseries_id);
    evidence(unit && unit.relative_path === `${bindingPrefix}/timeseries_id=${identity.timeseries_id}.json`, 'invalid_binding_authority', 'physical binding absent');
    const object = await pinned({ key: unit.relative_path, byte_size: unit.size, sha256: unit.sha256 });
    const value = object.value;
    evidence([1, 2].includes(value.schema_version) && value.history_version === 'v2' && value.index_kind === 'timeseries_binding'
      && Object.entries(identity).every(([k, v]) => value[k] === v), 'invalid_binding_authority', 'physical binding identity mismatch');
    return object.reference;
  };
  const verification = async identity => {
    const latestObject = await read(OBSERVATION_VERIFICATION_LATEST_KEY);
    const latest = validateObservationVerificationLatest(latestObject.value);
    evidence(Buffer.from(encodeObservationVerificationJson(latest)).equals(latestObject.body), 'invalid_verification_authority', 'verification selector encoding mismatch');
    const ref = latest.connectors.find(c => c.connector_id === identity.connector_id);
    if (!ref) return { state: 'embedded_status_requires_writer_evidence' };
    const object = await pinned(ref); const manifest = validateObservationVerificationConnectorManifest(object.value);
    evidence(Buffer.from(encodeObservationVerificationJson(manifest)).equals(object.body), 'invalid_verification_authority', 'verification manifest encoding mismatch');
    evidence(manifest.connector_id === identity.connector_id, 'invalid_verification_authority', 'verification connector mismatch');
    const entry = manifest.timeseries.find(t => t.timeseries_id === identity.timeseries_id);
    evidence(entry && entry.station_id === identity.station_id && entry.pollutant_code === identity.pollutant_code,
      'invalid_verification_authority', 'verification physical membership missing or contradictory');
    return { state: 'overlay_metadata_verified', manifest: object.reference, entry,
      scope_sha256: sha256Hex(canonicalJson(entry)) };
  };
  const results = [];
  for (const scope of scopes) {
    const result = { scope_key: scopeKey(scope), identity: scope.identity, day_utc: scope.day_utc, diagnostics: [] };
    try {
      const h = await hierarchy(scope); result.observations = { membership: h.membership, chain: h.chain, absent_at: h.absent_at ?? null };
      result.physical = h.membership === 'authoritative_absent' ? { membership: 'authoritative_absent', row_count: 0 } : await exact(scope, h);
    } catch (error) { result.diagnostics.push({ code: error.code || 'canonical_metadata_unavailable', detail: error.message }); }
    for (const [name, inspect] of [['binding', binding], ['verification', verification]]) {
      try { result[name] = await inspect(scope.identity); }
      catch (error) { result.diagnostics.push({ code: error.code || `${name}_metadata_unavailable`, detail: error.message }); }
    }
    result.state = 'metadata_only'; results.push(result);
  }
  // No lock and no transaction: recheck every observed metadata object, not just
  // the root, since verification/binding and unpublished children can change too.
  let stable = true;
  const diagnostics = [];
  for (const [key, first] of cache) {
    try { evidence(same(first.reference, (await read(key, true)).reference), 'canonical_metadata_changed_during_read', key); }
    catch (error) { stable = false; diagnostics.push({ code: error.code || 'canonical_metadata_unavailable', detail: error.message }); break; }
  }
  return freeze({ schema_version: 1, kind: 'uk_aq_jsongen_canonical_inspection',
    generation: { ...generation }, binding_prefix: bindingPrefix, read_consistent: stable,
    authority_complete: false, freshness: 'source_as_of_only', scopes: results,
    provenance: [...provenance.values()], diagnostics, resources: budget.snapshot() });
}

// This intentionally has no "authenticated" result. Different metadata pins
// are evidence of drift, not proof of chronological supersession or writer rows.
export function compareScopeMetadata(previous, current) {
  if (!previous || !current || previous.scope_key !== current.scope_key ||
      !previous.physical || !current.physical || previous.diagnostics?.length || current.diagnostics?.length) return 'unknown';
  if (previous.physical.membership !== current.physical.membership) return 'membership_changed';
  const pins = s => ({ physical: s.physical.leaf || s.physical,
    binding: s.binding, verification: s.verification?.scope_sha256 || s.verification });
  return same(pins(previous), pins(current)) ? 'same_scope_metadata' : 'scope_metadata_changed';
}
