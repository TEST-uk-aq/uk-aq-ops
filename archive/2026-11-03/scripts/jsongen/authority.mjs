// Read-only, configured-generation metadata inspection. Receipt paths are never
// used as current authority. This does not authenticate historical writer output.
import { r2GetObjectBounded, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { classifyManifestFileIdentity } from '../../workers/shared/uk_aq_r2_file_identity.mjs';
import { assertObservationHistoryGeneration, getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { validateR2HistoryV2ObservationsAggregateManifest, OBSERVATIONS_AGGREGATE_MANIFEST_KINDS } from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { assertV2ObservationsChildManifest } from '../backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs';
import { readObservationHistoryExactLeafDailyMetadataV3 } from '../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs';
import { encodeObservationHistoryIndexV3Json, observationHistoryIndexV3RangeForTimeseriesId } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION, OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION }
  from '../../workers/shared/uk_aq_observation_history_target_writer.mjs';
import { validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  timeseriesBindingSourceRootKey, TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND } from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { validTimeseriesBindingSourceState } from '../backup_r2/lib/timeseries_binding_source_state_v2.mjs';
import { physicalScopeDigest, assertInspectionScope } from './scope-authority.mjs';
import { OBSERVATION_VERIFICATION_LATEST_KEY, validateObservationVerificationLatest,
  validateObservationVerificationConnectorManifest, encodeObservationVerificationJson } from '../../workers/shared/uk_aq_observation_verification_overlay.mjs';
import { assertScope, assertReference, scopeKey, same, canonicalJson, BUCKET } from './schema.mjs';
import { createBudget, createInspectionBudget, evidence, parseJson, freeze, INSPECTION_CONCURRENCY, JSONgenEvidenceError } from './limits.mjs';
import { planInspection, planMetadataRequests } from './inspection-plan.mjs';
import { inspectionMap } from './inspection-runtime.mjs';

const inspectionSessions = new WeakSet();

const sha = /^[a-f0-9]{64}$/;
const descriptor = (bucket, key, body) => ({ bucket, key, byte_size: body.length, sha256: sha256Hex(body) });
const validUtcDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
export function validContinuity(continuity, identity) {
  const c = continuity;
  if (!c || typeof c !== 'object' || Array.isArray(c)
    || c.schema_version !== 1 || c.source !== 'sos_station_timeseries_site_refs'
    || typeof c.uk_air_ref !== 'string' || !c.uk_air_ref.trim()
    || !(c.site_ref === null || (typeof c.site_ref === 'string' && c.site_ref.trim()))
    || c.pollutant_code !== identity.pollutant_code
    || c.continuity_key !== `${identity.connector_id}:${c.uk_air_ref}:${identity.pollutant_code}`
    || !Array.isArray(c.members) || c.members.length < 2) return false;
  const allowed = ['schema_version', 'source', 'continuity_key', 'site_ref', 'uk_air_ref', 'pollutant_code', 'members'];
  if (Object.keys(c).some(key => !allowed.includes(key))) return false;
  const ids = new Set(); let topLevelCount = 0; let openEndedCount = 0; let previous = null;
  for (const member of c.members) {
    if (!member || typeof member !== 'object' || Array.isArray(member)
      || Object.keys(member).some(key => !['station_id', 'station_ref', 'timeseries_id', 'timeseries_ref',
        'valid_from_day_utc', 'valid_to_day_utc'].includes(key))
      || !Number.isSafeInteger(member.station_id) || member.station_id <= 0
      || !Number.isSafeInteger(member.timeseries_id) || member.timeseries_id <= 0
      || ![member.station_ref, member.timeseries_ref].every(ref => ref === undefined || ref === null
        || (typeof ref === 'string' && ref.trim().length > 0))
      || !validUtcDay(member.valid_from_day_utc)
      || !(member.valid_to_day_utc === null || validUtcDay(member.valid_to_day_utc))
      || (member.valid_to_day_utc !== null && member.valid_to_day_utc < member.valid_from_day_utc)
      || ids.has(member.timeseries_id)) return false;
    ids.add(member.timeseries_id);
    if (member.timeseries_id === identity.timeseries_id) {
      topLevelCount++;
      if (member.station_id !== identity.station_id) return false;
    }
    if (member.valid_to_day_utc === null) openEndedCount++;
    if (previous && (previous.valid_from_day_utc > member.valid_from_day_utc
      || (previous.valid_from_day_utc === member.valid_from_day_utc
        && previous.timeseries_id >= member.timeseries_id)
      || previous.valid_to_day_utc === null
      || member.valid_from_day_utc <= previous.valid_to_day_utc)) return false;
    previous = member;
  }
  return topLevelCount === 1 && openEndedCount <= 1;
}
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
// The caller may supply only independently accepted connector transition modes.
// A selected pointer without that acceptance remains diagnostic metadata.
export function selectVerificationStatusAuthority({ physicalIdentity, acceptedMode = null, selectedOverlay = false }) {
  const schema = physicalIdentity?.history_schema_version;
  evidence([3, 4].includes(schema)
    && physicalIdentity.writer_version === `parquet-wasm-zstd-v${schema}`,
  'unknown_verification_transition_state', 'verified scoped physical schema/writer identity required');
  evidence(acceptedMode === null || ['pre_overlay_accepted', 'overlay_accepted'].includes(acceptedMode),
    'invalid_verification_configuration', 'invalid accepted connector transition mode');
  if (acceptedMode === 'pre_overlay_accepted') {
    evidence(!selectedOverlay, 'invalid_verification_authority', 'pre-overlay mode contradicts selected overlay');
    return schema === 3 ? 'embedded_status_requires_writer_evidence' : 'overlay_authoritative_connector_unresolved';
  }
  if (acceptedMode === 'overlay_accepted')
    return selectedOverlay ? 'overlay_metadata_verified' : 'overlay_authoritative_connector_unresolved';
  return selectedOverlay || schema === 4
    ? 'overlay_authoritative_connector_unresolved' : 'unknown_verification_transition_state';
}

export async function readCanonicalScopes({ r2, generation, bindingPrefix = null, scopes,
  acceptedVerificationModes = null, budget = createBudget(), session = null }) {
  evidence(session === null || inspectionSessions.has(session), 'invalid_metadata_session', 'Internal shared inspection session required');
  assertObservationHistoryGeneration(generation);
  evidence(generation === getObservationHistoryGeneration('v3') && r2?.bucket && r2.bucket !== BUCKET,
    'invalid_canonical_configuration', 'explicit canonical v3 generation and separate canonical bucket required');
  bindingPrefix ??= generation.timeseries_binding_index_prefix;
  evidence(bindingPrefix === generation.timeseries_binding_index_prefix,
    'incorrect_binding_prefix_generation', 'selected v3 requires its own physical binding namespace');
  // A mode is supplied only by a separately accepted runtime transition source.
  // This inactive inspector cannot infer acceptance from pointer presence or 404.
  evidence(acceptedVerificationModes === null || (typeof acceptedVerificationModes === 'object'
    && !Array.isArray(acceptedVerificationModes) && Object.entries(acceptedVerificationModes).every(([id, mode]) =>
      /^[1-9]\d*$/.test(id) && ['pre_overlay_accepted', 'overlay_accepted'].includes(mode))),
  'invalid_verification_configuration', 'accepted connector modes are invalid');
  evidence(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= budget.limits.scopes,
    'resource_limit', 'canonical scope budget exceeded');
  scopes = structuredClone(scopes); scopes.forEach(session ? assertInspectionScope : assertScope);
  evidence(new Set(scopes.map(scopeKey)).size === scopes.length, 'invalid_scope', 'duplicate canonical scope');
  const base = generation.observations_prefix;
  const indexRoot = generation.observations_timeseries_index_prefix;
  const cache = session?.cache || new Map(); const provenance = session?.provenance || new Map();
  const missing = session?.missing || new Map();
  const memo = (key, operation) => {
    if (!session) return operation();
    if (!session.memo.has(key)) session.memo.set(key, Promise.resolve().then(operation));
    return session.memo.get(key);
  };
  const inspectIndex = object => {
    if (session?.indexed.has(object)) return;
    canonicalIndex(object); session?.indexed.add(object);
  };
  const allowed = key => key.endsWith('.json') && (
    key.startsWith(`${base}/`) || key.startsWith(`${indexRoot}/`) ||
    (bindingPrefix && key.startsWith(`${bindingPrefix}/`)) ||
    key === OBSERVATION_VERIFICATION_LATEST_KEY || key.startsWith('history/v3/verification/'));
  const read = async (key, fresh = false) => {
    evidence(allowed(key) && !key.includes('/../') && !key.includes('/./') && !/[\\\x00-\x20?#%]/.test(key),
      'invalid_canonical_metadata', 'metadata key outside explicitly configured domains');
    if (session) evidence(session.plannedKeys.has(key)
      || [...session.connectors].some(id => new RegExp(`^history/v3/verification/connector_id=${id}/manifests/[a-f0-9]{64}\\.json$`).test(key)),
    'invalid_canonical_metadata', 'Metadata dependency is outside the bounded requested-scope plan');
    if (session?.closed) throw session.failure || new JSONgenEvidenceError('resource_limit', 'Metadata inspection closed');
    if (!fresh && session?.inflight.has(key)) return session.inflight.get(key);
    if (!fresh && cache.has(key)) return cache.get(key);
    if (!fresh && missing.has(key)) throw missing.get(key);
    const acquire = async () => {
      let release = () => {}, active = false;
      try {
        const maxBytes = Math.min(budget.limits.metadata_bytes, budget.remainingBytes());
        evidence(maxBytes > 0, 'resource_limit', 'canonical metadata byte budget exhausted');
        release = budget.reserveBytes(maxBytes);
        budget.get('metadata');
        if (session) {
          session.stats[session.phase]++; session.active++;
          if (session.phase === 'initial_gets') session.initialKeys.add(key);
          if (session.phase === 'recheck_gets') session.recheckKeys.add(key);
          session.stats.peak_concurrency = Math.max(session.stats.peak_concurrency, session.active); active = true;
        }
        const object = await r2GetObjectBounded({ r2, key, max_bytes: maxBytes, timeout_ms: budget.timeout(), signal: session?.controller.signal });
        release(); release = () => {};
        if (session?.closed) throw session.failure;
        budget.bytes('metadata', object.bytes);
        if (session) session.stats[session.phase.replace('_gets', '_bytes')] += object.bytes;
        const result = { body: object.body, reference: descriptor(r2.bucket, key, object.body) };
        if (!fresh) {
          if (session) {
            evidence(session.stats.cache_bytes + object.bytes <= budget.limits.metadata_bytes,
              'resource_limit', 'Shared raw metadata cache byte cap exceeded');
            session.stats.cache_bytes += object.bytes;
          }
          // Record bytes even if JSON parsing fails; every observed identity
          // must participate in the final recheck, not only parseable objects.
          provenance.set(key, result.reference);
          result.value = parseJson(object.body); cache.set(key, result);
        }
        return result;
      } catch (error) {
        if (!fresh && !session?.closed) missing.set(key, error);
        if (session && (error.code === 'resource_limit' || session.controller.signal.aborted
          || /deadline|timeout|aborted/i.test(error.message))) session.cancel(error);
        throw error;
      } finally { release(); if (active) session.active--; }
    };
    const pending = acquire();
    if (!fresh && session) {
      session.inflight.set(key, pending);
      try { return await pending; } finally { session.inflight.delete(key); }
    }
    return pending;
  };
  if (session) session.read = read;
  const pinned = async reference => {
    const ref = { bucket: r2.bucket, key: reference.key, byte_size: reference.byte_size, sha256: reference.sha256 };
    assertReference(ref);
    const object = await read(ref.key);
    evidence(same(ref, object.reference), 'invalid_canonical_metadata', `metadata byte identity mismatch: ${ref.key}`);
    return object;
  };
  const hierarchy = scope => memo(`hierarchy:${scope.day_utc}:${scope.identity.connector_id}:${scope.identity.pollutant_code}`, async () => {
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
        if (i === 0 && session) session.rootAuthenticated = true;
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
  });
  const exact = async (scope, h) => {
    const id = scope.identity; const suffix = `day_utc=${scope.day_utc}/connector_id=${id.connector_id}/pollutant_code=${id.pollutant_code}`;
    const manifest = await read(`${indexRoot}/${suffix}/manifest.json`); inspectIndex(manifest);
    const aligned = await pinned(manifest.value.source_aligned_scoped_manifest); inspectIndex(aligned);
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
    await memo(`canonical_exact_members:${manifest.reference.key}`, () => {
      evidence(counts && typeof counts === 'object' && !Array.isArray(counts)
      && Object.values(counts).every(n => Number.isSafeInteger(n) && n > 0)
      && Object.values(counts).reduce((a, b) => a + b, 0) === h.pollutant.row_count,
    'invalid_canonical_metadata', 'complete canonical timeseries counts unavailable');
      evidence(same(Object.keys(manifest.value.leaves_by_timeseries_id).sort(), Object.keys(counts).sort()), 'invalid_canonical_metadata', 'exact/canonical physical member sets disagree');
    });
    const leafSet = manifest.value.leaves_by_timeseries_id;
    const tuple = leafSet[String(id.timeseries_id)];
    if (!tuple) return { membership: 'authoritative_absent', row_count: 0, index: manifest.reference };
    const leaf = await pinned({ key: tuple[0], byte_size: tuple[1], sha256: tuple[2] }); inspectIndex(leaf);
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
    const shard = await pinned(alignedChild); inspectIndex(shard);
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
    await memo(`aligned_members:${alignedChild.key}`, () => {
      evidence(Array.isArray(payload.timeseries)
      && same(payload.timeseries.map(t => t.timeseries_id), expectedIds)
      && payload.timeseries.every(t => Number.isSafeInteger(t.row_count) && t.row_count > 0
        && t.row_count === counts[String(t.timeseries_id)] && Array.isArray(t.segments)
        && t.segments.length > 0 && t.segments.every(s => Number.isSafeInteger(s.row_count)
          && s.row_count > 0 && shardFileKeys.has(s.file_key))
        && t.segments.reduce((n, s) => n + s.row_count, 0) === t.row_count),
    'invalid_canonical_metadata', 'aligned shard timeseries membership or row counts disagree');
      evidence(Array.isArray(payload.files) && payload.files.every(f => h.pollutant.files.some(s => {
        const identity = classifyManifestFileIdentity(s.etag_or_hash, { objectKey: f.key });
        return s.key === f.key && s.bytes === f.byte_size
          && identity.type === 'sha256' && identity.value === f.sha256;
      })), 'invalid_canonical_metadata', 'aligned shard file identity disagrees with exact/canonical files');
    });
    evidence(payload.timeseries.find(t => t.timeseries_id === id.timeseries_id)?.row_count === leaf.value.row_count
      && leaf.value.files.every(f => payload.files.some(s => s.key === f.key && s.sha256 === f.sha256 && s.byte_size === f.byte_size)),
    'invalid_canonical_metadata', 'Selected exact scope contradicts authenticated aligned membership');
    // Check file identity membership without ever fetching Parquet.
    for (const file of leaf.value.files) {
      const canonical = h.pollutant.files.find(f => f.key === file.key);
      const fileIdentity = canonical && classifyManifestFileIdentity(canonical.etag_or_hash, { objectKey: file.key });
      evidence(canonical && canonical.bytes === file.byte_size && fileIdentity.type === 'sha256' && fileIdentity.value === file.sha256,
        'invalid_canonical_metadata', 'exact file not pinned by canonical pollutant');
    }
    const physicalIdentity = Object.fromEntries(['history_schema_version', 'writer_version',
      'physical_layout_version'].map(field => [field, manifest.value[field]]));
    evidence([3, 4].includes(physicalIdentity.history_schema_version)
      && physicalIdentity.writer_version === `parquet-wasm-zstd-v${physicalIdentity.history_schema_version}`
      && physicalIdentity.physical_layout_version === OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION
      && [aligned.value, leaf.value, payload].every(value =>
        Object.entries(physicalIdentity).every(([field, expected]) => value[field] === expected)),
    'invalid_canonical_metadata', 'scoped physical schema/writer identity is contradictory');
    return { membership: 'present', row_count: metadata.rows[0].row_count,
      physical_identity: physicalIdentity,
      ...(session ? { scope_sha256: physicalScopeDigest(scope, leaf.value) } : {}),
      index: manifest.reference, leaf: leaf.reference, aligned_shard: shard.reference };
  };
  const binding = async identity => {
    const root = await memo('binding_completed_root', async () => {
      const root = validateTimeseriesBindingSourceRootManifest((await read(timeseriesBindingSourceRootKey(bindingPrefix))).value);
    evidence(root.source_prefix === bindingPrefix, 'invalid_binding_authority', 'wrong binding root');
    if (session) {
      const state = (await read(`${bindingPrefix}/_source_state.json`)).value;
      const refresh = (await read(`${bindingPrefix}/_manifests/_refresh_state.json`)).value;
      evidence(validTimeseriesBindingSourceState(state, { bindingPrefix, sourceSchema: state.source_schema })
        && typeof state.source_schema === 'string' && state.source_schema.length > 0
        && Number.isSafeInteger(state.authoritative_timeseries_count) && state.authoritative_timeseries_count >= 0
        && state.source_tables?.length === 3
        && ['timeseries', 'phenomena', 'observed_properties'].every(table => state.source_tables.filter(t => t.table === table
          && Number.isSafeInteger(t.row_count) && t.row_count >= 0 && sha.test(t.sha256_uncompressed || '')).length === 1)
        && refresh.schema_version === 1 && refresh.kind === TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND
        && refresh.history_version === 'v2' && refresh.source_prefix === bindingPrefix
        && refresh.source_fingerprint === state.source_fingerprint && refresh.source_root_hash === root.source_root_hash,
      'invalid_binding_authority', 'Completed selected-generation Core binding source/refresh authority unavailable or contradictory');
    }
      return root;
    });
    const rangeRef = root.ranges.find(r => r.range_start <= identity.timeseries_id && r.range_end >= identity.timeseries_id);
    evidence(rangeRef, 'invalid_binding_authority', 'physical binding range is not authoritative');
    const range = await memo(`binding_range:${rangeRef.manifest_key}`, () => read(rangeRef.manifest_key)
      .then(object => validateTimeseriesBindingSourceRangeManifest(object.value)));
    evidence(range.source_prefix === bindingPrefix && range.source_range_hash === rangeRef.source_range_hash
      && range.units.length === rangeRef.unit_count && range.range_start === rangeRef.range_start && range.range_end === rangeRef.range_end,
    'invalid_binding_authority', 'binding root/range mismatch');
    const unit = range.units.find(u => u.timeseries_id === identity.timeseries_id);
    evidence(unit && unit.relative_path === `${bindingPrefix}/timeseries_id=${identity.timeseries_id}.json`, 'invalid_binding_authority', 'physical binding absent');
    const object = await pinned({ key: unit.relative_path, byte_size: unit.size, sha256: unit.sha256 });
    const value = object.value;
    evidence([1, 2].includes(value.schema_version) && value.history_version === 'v2' && value.index_kind === 'timeseries_binding'
      && Object.entries(identity).every(([k, v]) => value[k] === v), 'invalid_binding_authority', 'physical binding identity mismatch');
    if (value.schema_version === 1) evidence(!Object.hasOwn(value, 'continuity'),
      'invalid_binding_authority', 'schema-1 binding cannot carry continuity');
    if (value.schema_version === 2) evidence(validContinuity(value.continuity, identity),
      'invalid_binding_authority', 'schema-2 continuity identity is contradictory');
    return object.reference;
  };
  const verification = async (identity, physical) => {
    const schemaVersion = physical?.physical_identity?.history_schema_version;
    // Stage 3C supports the current AURN schema-3 embedded-status contract.
    // Its effective values still require the authenticated original writer.
    // No Stage 3C adapter authenticates a connector overlay transition yet;
    // caller mode strings cannot supply that missing authority.
    const mode = session ? (identity.connector_id === 1 && schemaVersion === 3 ? 'pre_overlay_accepted' : null)
      : acceptedVerificationModes?.[String(identity.connector_id)] || null;
    evidence(schemaVersion === 3 || schemaVersion === 4,
      'unknown_verification_transition_state', 'physical schema identity is unavailable');
    // A known overlay cut-over must resolve its selected latest and exact manifest.
    // Only independently accepted pre-overlay mode can tolerate a missing pointer.
    let latestObject;
    try { latestObject = await memo('validated_verification_latest', async () => {
      const object = await read(OBSERVATION_VERIFICATION_LATEST_KEY);
      const latest = validateObservationVerificationLatest(object.value);
      evidence(Buffer.from(encodeObservationVerificationJson(latest)).equals(object.body), 'invalid_verification_authority', 'verification selector encoding mismatch');
      return { ...object, latest };
    }); }
    catch (error) {
      if (error.status === 404 && mode === 'pre_overlay_accepted')
        return { state: selectVerificationStatusAuthority({ physicalIdentity: physical.physical_identity,
          acceptedMode: mode }) };
      throw error;
    }
    const latest = latestObject.latest;
    const ref = latest.connectors.find(c => c.connector_id === identity.connector_id);
    if (!ref) {
      return { state: selectVerificationStatusAuthority({ physicalIdentity: physical.physical_identity,
        acceptedMode: mode }) };
    }
    // A selected overlay contradicts a stale pre-overlay mode even for schema 3.
    if (mode === 'pre_overlay_accepted')
      selectVerificationStatusAuthority({ physicalIdentity: physical.physical_identity,
        acceptedMode: mode, selectedOverlay: true });
    const object = await pinned(ref); const manifest = validateObservationVerificationConnectorManifest(object.value);
    evidence(Buffer.from(encodeObservationVerificationJson(manifest)).equals(object.body), 'invalid_verification_authority', 'verification manifest encoding mismatch');
    evidence(manifest.connector_id === identity.connector_id, 'invalid_verification_authority', 'verification connector mismatch');
    const entry = manifest.timeseries.find(t => t.timeseries_id === identity.timeseries_id);
    evidence(entry && entry.station_id === identity.station_id && entry.pollutant_code === identity.pollutant_code,
      'invalid_verification_authority', 'verification physical membership missing or contradictory');
    return { state: selectVerificationStatusAuthority({ physicalIdentity: physical.physical_identity,
      acceptedMode: mode, selectedOverlay: true }), manifest: object.reference, entry,
      scope_sha256: sha256Hex(canonicalJson(entry)) };
  };
  const inspectScope = async scope => {
    const result = { scope_key: scopeKey(scope), identity: scope.identity, day_utc: scope.day_utc, diagnostics: [] };
    try {
      const h = await hierarchy(scope); result.observations = { membership: h.membership, chain: h.chain, absent_at: h.absent_at ?? null };
      result.physical = h.membership === 'authoritative_absent' ? { membership: 'authoritative_absent', row_count: 0 } : await exact(scope, h);
    } catch (error) { result.diagnostics.push({ code: error.code || 'canonical_metadata_unavailable', detail: error.message }); }
    for (const [name, inspect] of [['binding', binding], ['verification', verification]]) {
      if (name === 'verification' && result.physical?.membership === 'authoritative_absent') {
        result.verification = { state: 'not_applicable_to_absent_scope' }; continue;
      }
      try { result[name] = await inspect(scope.identity, result.physical); }
      catch (error) {
        result.diagnostics.push({ code: error.code || `${name}_metadata_unavailable`, detail: error.message });
        if (name === 'verification') result.verification = { state:
          acceptedVerificationModes?.[String(scope.identity.connector_id)] === 'overlay_accepted'
            || result.physical?.physical_identity?.history_schema_version === 4
            ? 'overlay_authoritative_connector_unresolved' : 'unknown_verification_transition_state' };
      }
    }
    result.state = session?.closed ? 'not_inspected_resource_limit' : 'metadata_only'; return result;
  };
  const results = session
    ? await inspectionMap(scopes, inspectScope, { concurrency: INSPECTION_CONCURRENCY, stopped: () => session.closed })
    : await inspectionMap(scopes, inspectScope, { concurrency: 1 });
  for (let i = 0; i < results.length; i++) if (!results[i]) results[i] = {
    scope_key: scopeKey(scopes[i]), identity: scopes[i].identity, day_utc: scopes[i].day_utc,
    diagnostics: [{ code: 'resource_limit', detail: 'Scope not inspected after shared capacity/deadline cancellation' }],
    state: 'not_inspected_resource_limit' };
  // No lock and no transaction: recheck every observed metadata object, not just
  // the root, since verification/binding and unpublished children can change too.
  let stable = true;
  const diagnostics = [];
  for (const [key, first] of session ? [] : cache) {
    try { evidence(same(first.reference, (await read(key, true)).reference), 'canonical_metadata_changed_during_read', key); }
    catch (error) { stable = false; diagnostics.push({ code: error.code || 'canonical_metadata_unavailable', detail: error.message }); break; }
  }
  return freeze({ schema_version: 1, kind: 'uk_aq_jsongen_canonical_inspection',
    generation: { ...generation }, binding_prefix: bindingPrefix, read_consistent: stable,
    authority_complete: false, freshness: 'source_as_of_only', scopes: results,
    provenance: [...provenance.values()], diagnostics, resources: budget.snapshot() });
}

// One bounded selection shares a cache and final recheck, including Core/status
// authority and 404s. The complete manifest also accounts for unselected scopes.
// Separate invocations cannot be promoted to one coherent source snapshot.
export async function readCanonicalScopePages({ scopes, budget = createInspectionBudget(), partitionIndex = 0, ...canonical }) {
  const selection = planInspection(scopes, partitionIndex, budget.limits.scopes);
  const byKey = new Map(scopes.map(s => [scopeKey(s), s]));
  const selected = selection.selected_scope_keys.map(key => byKey.get(key));
  const requestPlan = planMetadataRequests(selected, canonical.generation);
  budget.configureMetadataLimit(requestPlan.metadata_get_allowance);
  const session = { cache: new Map(), provenance: new Map(), missing: new Map(), inflight: new Map(),
    memo: new Map(), indexed: new WeakSet(), controller: new AbortController(), closed: false, failure: null,
    phase: 'initial_gets', active: 0, initialKeys: new Set(), recheckKeys: new Set(),
    stats: { initial_gets: 0, recheck_gets: 0, closing_root_gets: 0,
      initial_bytes: 0, recheck_bytes: 0, closing_root_bytes: 0, cache_bytes: 0, peak_concurrency: 0 } };
  session.plannedKeys = new Set(requestPlan.deterministic_keys);
  session.connectors = new Set(selected.map(s => s.identity.connector_id));
  const previousMetadataGets = budget.snapshot().metadata_gets;
  const previousMetadataBytes = budget.snapshot().metadata_bytes;
  session.cancel = error => {
    if (session.closed) return;
    session.failure = error?.code ? error : new JSONgenEvidenceError('resource_limit', 'Metadata request deadline/cancellation boundary reached');
    session.closed = true; session.controller.abort(session.failure);
  };
  inspectionSessions.add(session);
  const started = new Date().toISOString();
  const timer = setTimeout(() => session.cancel(new JSONgenEvidenceError('resource_limit', 'Shared operation deadline exceeded')), budget.remainingMs());
  let page, stable = false, closingRoot = null;
  const diagnostics = [], rechecks = new Map();
  try {
    page = await readCanonicalScopes({ ...canonical, scopes: selected, budget, session });
    const rootKey = canonical.generation.observations_root_key;
    const observed = [...session.initialKeys].sort();
    for (const key of observed) rechecks.set(key, { key, state: 'not_rechecked', current: null });
    session.phase = 'recheck_gets';
    await inspectionMap(observed, async key => {
      try {
        const first = session.provenance.get(key);
        const wasAbsent = session.missing.get(key)?.status === 404;
        let current = null, absent = false;
        try { current = (await session.read(key, true)).reference; }
        catch (error) { if (error.status === 404) absent = true; else throw error; }
        const matched = first ? same(first, current) : wasAbsent && absent;
        rechecks.set(key, { key, state: matched ? 'matched' : 'changed', current });
        if (!matched) session.cancel(new JSONgenEvidenceError('canonical_metadata_changed_during_read', 'Observed metadata identity changed or was unavailable at its first read'));
      } catch (error) {
        rechecks.set(key, { key, state: 'unavailable', current: null }); session.cancel(error);
      }
    }, { concurrency: INSPECTION_CONCURRENCY, stopped: () => session.closed });
    if (!session.closed) {
      evidence(session.rootAuthenticated, 'canonical_metadata_unavailable', 'No authenticated selected observations root was inspected');
      session.phase = 'closing_root_gets';
      closingRoot = (await session.read(rootKey, true)).reference;
      evidence(same(session.provenance.get(rootKey), closingRoot), 'canonical_metadata_changed_during_read', 'Observations root changed during the closing recheck');
      budget.check(); stable = true;
    }
  } catch (error) { session.cancel(error); }
  finally { clearTimeout(timer); }
  if (session.failure) diagnostics.push({ code: session.failure.code || 'canonical_metadata_unavailable', detail: session.failure.message });
  // Every worker/request has settled or been aborted by the bounded GET wrapper.
  // Closing the session prevents a late adapter response from mutating evidence.
  session.closed = true;
  const selectedResults = new Map((page?.scopes || []).map(s => [s.scope_key, s]));
  const results = [...byKey.keys()].sort().map(key => selectedResults.get(key) || {
    scope_key: key, identity: byKey.get(key).identity, day_utc: byKey.get(key).day_utc,
    diagnostics: [], state: selection.selected_scope_keys.includes(key) ? 'not_inspected_resource_limit' : 'not_inspected_partition' });
  const provenance = [...session.provenance.values()].sort((a, b) => a.key.localeCompare(b.key));
  const unavailable = [...session.missing].filter(([, error]) => error.status === 404).map(([key]) => key).sort();
  const boundary = { generation: { ...canonical.generation }, scope_keys: selection.selected_scope_keys,
    metadata: provenance, unavailable_metadata_keys: unavailable };
  const source_as_of = { state: stable ? 'bounded_metadata_recheck_passed' : 'fresh_inspection_required',
    identity_sha256: sha256Hex(canonicalJson(boundary)), boundary,
    observations_root: session.provenance.get(canonical.generation.observations_root_key) || null,
    started_at_utc: started, finished_at_utc: new Date().toISOString(),
    consistency: 'shared_first_read_cache_then_all_observed_metadata_rechecked', completeness_fence: 'unavailable',
    limitations: ['No transactional snapshot or canonical lock; an intervening writer or ABA change can escape identical endpoint reads.',
      'No writer-owned complete inventory/freshness fence; source-as-of metadata cannot prove absolute latest canonical freshness.'] };
  return freeze({ schema_version: 3, kind: 'uk_aq_jsongen_canonical_inspection', generation: { ...canonical.generation },
    binding_prefix: canonical.generation.timeseries_binding_index_prefix, read_consistent: stable,
    authority_complete: false, freshness: 'source_as_of_only', scopes: results, provenance, diagnostics, source_as_of,
    page_count: selection.partition_count, page_scope_limit: selection.partition_size, selection,
    recheck_evidence: [...rechecks.values()].sort((a, b) => a.key.localeCompare(b.key)), closing_root: closingRoot,
    capacity: { ...requestPlan, metadata_get_limit: budget.metadataLimit(), ...session.stats,
      previous_metadata_gets: previousMetadataGets,
      previous_metadata_bytes: previousMetadataBytes,
      initial_keys: [...session.initialKeys].sort(), recheck_keys: [...session.recheckKeys].sort(),
      concurrency_limit: INSPECTION_CONCURRENCY, cache_byte_limit: budget.limits.metadata_bytes,
      elapsed_ms: budget.elapsedMs(), duration_limit_ms: budget.limits.duration_ms }, resources: budget.snapshot() });
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
