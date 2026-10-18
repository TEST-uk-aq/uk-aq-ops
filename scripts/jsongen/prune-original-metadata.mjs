// Transient, bounded copies of exact JSON metadata bytes already offered to the
// canonical writer. The writer's normal readback/finalization remains authority.
import { sha256Hex, r2GetObjectBounded } from '../../workers/shared/r2_sigv4.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { canonicalJson } from './schema.mjs';
import { validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND } from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { validTimeseriesBindingSourceState } from '../backup_r2/lib/timeseries_binding_source_state_v2.mjs';

const SHA = /^[0-9a-f]{64}$/;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_CAPTURE_OBJECTS = 4096;

export function createPruneOriginalMetadataCapture() {
  const bodies = new Map();
  let retainedBytes = 0;
  let originalSequence = 0;
  const retain = (id, value) => {
    const previous = bodies.get(id);
    const size = value?.body?.byteLength ?? Buffer.byteLength(value?.body || '');
    if (!size || size > MAX_OBJECT_BYTES || (!previous && bodies.size >= MAX_CAPTURE_OBJECTS)
      || retainedBytes - (previous?.byteLength || 0) + size > MAX_CAPTURE_BYTES) return false;
    const bytes = Buffer.from(value.body);
    bodies.set(id, bytes);
    retainedBytes += size - (previous?.byteLength || 0);
    return true;
  };
  return {
    recordPublishedObject(value) {
      try {
        const key = value?.key;
        const body = value?.body;
        if (typeof key !== 'string' || !key.endsWith('.json') || body == null) return;
        if (!retain(key, { body })) {
          retainedBytes -= bodies.get(key)?.byteLength || 0;
          bodies.delete(key);
        }
      } catch {
        // Optional evidence capture cannot change a canonical PUT result.
      }
    },
    body(key) { return bodies.get(key) || null; },
    beginOriginalAuthority(identity, lockContext) {
      const prefix = `original:${++originalSequence}:`;
      return originalAuthorityCapture({ identity, lockContext,
        retain: (phase, value) => retain(`${prefix}${phase}:${value.key}`, value),
        body: (phase, key) => bodies.get(`${prefix}${phase}:${key}`) || null,
        remainingBytes: () => MAX_CAPTURE_BYTES - retainedBytes,
        remainingObjects: () => MAX_CAPTURE_OBJECTS - bodies.size });
    },
  };
}

// This is an additive, explicitly versioned schema-1 envelope extension. Old
// final metadata keeps its original meaning. Same-key BEFORE and AFTER bytes
// occupy distinct slots in ONE shared 8 MiB / 4096-object capture budget.
const GENERATION = getObservationHistoryGeneration('v3');
const originalError = (code) => Object.assign(new Error(code), { original_authority_code: code });
const requireOriginal = (ok, code = 'contradictory_binding_authority') => {
  if (!ok) throw originalError(code);
};
const failureState = reason => reason?.includes('limit') ? 'oversized'
  : reason?.includes('contradictory') ? 'contradictory' : 'unavailable';
const physicalIdentity = (scope, connectorId) => ({ connector_id: connectorId,
  timeseries_id: scope.timeseries_id, station_id: scope.station_id, pollutant_code: scope.pollutant_code });

function originalAuthorityCapture({ identity, lockContext, retain, body, remainingBytes, remainingObjects }) {
  identity = JSON.parse(JSON.stringify(identity));
  // The existing supervisor owns the session and kills protected children on
  // lock loss. Do not add another lock or claim a local boolean acquired it.
  const lock = lockContext?.valid === true && lockContext.owner === 'prune_daily'
    ? { logical_identity: lockContext.logical_identity, owner: lockContext.owner, run_id: lockContext.run_id }
    : null;
  const keys = new Map();
  let admission = null;
  let beforeFailure = null;
  let binding = { state: 'unavailable', reason: 'binding_capture_not_attempted' };
  let scopes = null;
  const record = (phase, value) => {
    if (!retain(phase, value)) throw originalError('original_metadata_capture_limit');
    keys.set(`${phase}:${value.key}`, { phase, key: value.key });
  };
  const reference = (phase, key) => {
    const bytes = body(phase, key);
    if (!bytes) throw originalError('original_metadata_bytes_unavailable');
    return { bucket: identity.canonical_bucket, key, byte_size: bytes.length, sha256: sha256Hex(bytes) };
  };
  const before = () => {
    if (!lock || beforeFailure || !admission || !scopes) return { state: failureState(beforeFailure),
      reason: !lock ? 'original_global_lock_context_unavailable'
        : beforeFailure || 'admitted_original_membership_unavailable' };
    try {
      requireOriginal(admission.admission === 'first_publication'
        && admission.membership === 'authoritative_empty' && admission.row_count === 0
        && admission.previous_authority === null
        && admission.observations_root_key === GENERATION.observations_root_key
        && Array.isArray(admission.hierarchy_keys) && admission.hierarchy_keys.length >= 1
        && admission.hierarchy_keys.length <= 4
        && admission.hierarchy_keys[0] === admission.observations_root_key
        && admission.hierarchy_keys.at(-1) === admission.authority_key
        && admission.absence?.parent_key === admission.authority_key,
      'contradictory_before_admission');
      const authority = reference('before', admission.authority_key);
      return { state: 'captured', admission: 'first_publication',
        original_observations_root: reference('before', admission.observations_root_key),
        hierarchy: admission.hierarchy_keys.map(key => reference('before', key)),
        index_discovery: reference('before', admission.index_discovery_key),
        absence: admission.absence, previous_authority: null,
        scopes: scopes.map(scope => ({ identity: physicalIdentity(scope, identity.connector_id),
          day_utc: identity.day_utc,
          before: { state: 'authoritative_empty', row_count: 0, authority },
          transition: 'first_publication_no_committed_observations' })) };
    } catch (error) { return { state: failureState(error.original_authority_code),
      reason: error.original_authority_code || 'original_before_unavailable' }; }
  };
  return {
    diagnostics() {
      const originalBefore = before();
      return { before_membership_state: originalBefore.state,
        before_membership_reason: originalBefore.reason || null,
        authoritative_previous_absence: originalBefore.state === 'captured',
        binding_authority_state: binding.state, binding_authority_reason: binding.reason || null,
        independent_consumer_authentication: 'outstanding' };
    },
    recordBeforeObject(value) {
      try { record('before', value); }
      catch (error) { beforeFailure ||= error.original_authority_code || 'original_before_unavailable'; }
    },
    recordBeforeAdmission(value) {
      try {
        if (admission) throw originalError('contradictory_before_admission');
        admission = JSON.parse(JSON.stringify(value));
      } catch (error) { beforeFailure ||= error.original_authority_code || 'original_before_unavailable'; }
    },
    async captureBindings({ physicalScopes, r2, deadlineAtMs, admitRequest = () => true,
      getObject = r2GetObjectBounded, nowMs = Date.now }) {
      try {
        requireOriginal(lock, 'original_global_lock_context_unavailable');
        requireOriginal(Array.isArray(physicalScopes) && physicalScopes.length > 0
          && physicalScopes.length <= 1024, 'original_scope_membership_unavailable');
        scopes = JSON.parse(JSON.stringify(physicalScopes));
        const seen = new Set();
        for (const scope of scopes) {
          requireOriginal(scope.day_utc === identity.day_utc && Number.isSafeInteger(scope.timeseries_id)
            && scope.timeseries_id > 0 && Number.isSafeInteger(scope.station_id) && scope.station_id > 0
            && typeof scope.pollutant_code === 'string' && Number.isSafeInteger(scope.row_count) && scope.row_count > 0
            && !seen.has(scope.timeseries_id), 'contradictory_physical_scope_membership');
          seen.add(scope.timeseries_id);
        }
        const read = async key => {
          requireOriginal(key.startsWith(`${GENERATION.timeseries_binding_index_prefix}/`), 'wrong_binding_generation');
          const cached = body('binding', key);
          if (!cached) {
            const timeout = Math.min(15_000, Math.trunc(deadlineAtMs - nowMs()));
            requireOriginal(timeout > 0 && admitRequest(), 'original_binding_capture_deadline');
            requireOriginal(remainingObjects() > 0 && remainingBytes() > 0, 'original_metadata_capture_limit');
            const object = await getObject({ r2, key, max_bytes: Math.min(MAX_OBJECT_BYTES, remainingBytes()), timeout_ms: timeout });
            record('binding', { key, body: object.body });
          }
          let value;
          try { value = JSON.parse(body('binding', key).toString('utf8')); }
          catch { throw originalError('contradictory_binding_metadata_json'); }
          return { value, reference: reference('binding', key) };
        };
        const prefix = GENERATION.timeseries_binding_index_prefix;
        const root = await read(`${prefix}/_manifests/root.json`);
        let rootValue;
        try { rootValue = validateTimeseriesBindingSourceRootManifest(root.value); }
        catch { throw originalError('contradictory_binding_root'); }
        requireOriginal(rootValue.source_prefix === prefix);
        const source = await read(`${prefix}/_source_state.json`);
        const refresh = await read(`${prefix}/_manifests/_refresh_state.json`);
        // Core writes source state LAST, only after its reconciliation and
        // root/range publication. A loose physical key or root alone is not
        // evidence that this separate publisher completed a matching chain.
        requireOriginal(typeof source.value.source_schema === 'string' && source.value.source_schema.length > 0
          && validTimeseriesBindingSourceState(source.value, { bindingPrefix: prefix, sourceSchema: source.value.source_schema })
          && Number.isSafeInteger(source.value.authoritative_timeseries_count) && source.value.authoritative_timeseries_count >= 0
          && source.value.source_tables.length === 3
          && ['timeseries', 'phenomena', 'observed_properties'].every(table => source.value.source_tables
            .filter(t => t.table === table && Number.isSafeInteger(t.row_count) && t.row_count >= 0
              && SHA.test(t.sha256_uncompressed || '')).length === 1)
          && refresh.value.schema_version === 1 && refresh.value.history_version === 'v2'
          && refresh.value.kind === TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND
          && refresh.value.source_prefix === prefix
          && refresh.value.source_root_hash === rootValue.source_root_hash
          && refresh.value.source_fingerprint === source.value.source_fingerprint,
        'binding_publisher_completion_unavailable_or_contradictory');
        const bindings = [];
        for (const scope of scopes) {
          const rangeRef = rootValue.ranges.find(r => r.range_start <= scope.timeseries_id && r.range_end >= scope.timeseries_id);
          requireOriginal(rangeRef, 'physical_binding_not_in_selected_root');
          const range = await read(rangeRef.manifest_key);
          let rangeValue;
          try { rangeValue = validateTimeseriesBindingSourceRangeManifest(range.value); }
          catch { throw originalError('contradictory_binding_range'); }
          requireOriginal(rangeValue.source_prefix === prefix && rangeValue.range_start === rangeRef.range_start
            && rangeValue.range_end === rangeRef.range_end && rangeValue.source_range_hash === rangeRef.source_range_hash
            && rangeValue.units.length === rangeRef.unit_count);
          const unit = rangeValue.units.find(u => u.timeseries_id === scope.timeseries_id);
          requireOriginal(unit?.relative_path === `${prefix}/timeseries_id=${scope.timeseries_id}.json`, 'physical_binding_not_in_selected_range');
          const object = await read(unit.relative_path);
          const physical = physicalIdentity(scope, identity.connector_id);
          requireOriginal(object.reference.sha256 === unit.sha256 && object.reference.byte_size === unit.size
            && [1, 2].includes(object.value.schema_version) && object.value.history_version === 'v2'
            && object.value.index_kind === 'timeseries_binding'
            && Object.entries(physical).every(([k, v]) => object.value[k] === v)
            && (object.value.schema_version !== 1 || !Object.hasOwn(object.value, 'continuity')));
          bindings.push({ identity: physical, authority: object.reference, range: range.reference });
        }
        requireOriginal(nowMs() <= deadlineAtMs && admitRequest(), 'original_binding_capture_deadline');
        binding = { state: 'captured', publisher: 'core_snapshot_binding_publication',
          relationship: 'completed_core_binding_metadata_snapshot_not_prune_reconciliation',
          root: root.reference, source_state: source.reference, refresh_state: refresh.reference,
          source_root_hash: rootValue.source_root_hash, source_fingerprint: source.value.source_fingerprint,
          bindings };
      } catch (error) {
        const reason = error.original_authority_code || (Number(error.status) === 404
          ? 'binding_metadata_absent' : /byte budget|content length exceeds/.test(error.message || '')
            ? 'original_metadata_capture_limit' : /deadline|timeout|timed out/i.test(error.message || '')
              ? 'original_binding_capture_deadline' : 'binding_metadata_unavailable_or_invalid');
        binding = { state: failureState(reason), reason };
      }
    },
    snapshot() {
      const originalBefore = before();
      const objects = [...keys.values()].map(({ phase, key }) => {
        const ref = reference(phase, key);
        return { phase, ...ref, bytes_base64: body(phase, key).toString('base64') };
      }).sort((a, b) => a.phase.localeCompare(b.phase) || a.key.localeCompare(b.key));
      return { schema_version: 1, kind: 'uk_aq_prune_original_scope_binding_authority',
        completeness: originalBefore.state === 'captured' && binding.state === 'captured' ? 'captured'
          : [originalBefore.state, binding.state].includes('oversized') ? 'oversized'
            : [originalBefore.state, binding.state].includes('contradictory') ? 'contradictory' : 'unavailable',
        capture_boundary: 'original_global_lock_before_canonical_replacement',
        identity, lock, before: originalBefore, binding,
        required_object_count: objects.length,
        required_raw_byte_size: objects.reduce((sum, o) => sum + o.byte_size, 0), objects };
    },
  };
}

export function preparePruneOriginalAuthorityExtension({ capture, pending, connector, finalBatch,
  runId, dayUtc, connectorId, writerGitSha, sourceIdentity }) {
  if (!capture) return { schema_version: 1, kind: 'uk_aq_prune_original_scope_binding_authority',
    completeness: 'unavailable', reason: 'original_authority_not_captured' };
  const result = capture.snapshot();
  requireOriginal(result.schema_version === 1 && result.kind === 'uk_aq_prune_original_scope_binding_authority',
    'unsupported_original_authority_extension');
  const expected = { environment: 'TEST', index_generation: 'v3', canonical_bucket: connector.connector_manifest.bucket,
    writer: { identity: 'prune_daily_v3', invocation_id: runId, attempt_id: runId, git_sha: writerGitSha },
    connector_id: connectorId, day_utc: dayUtc, source_identity: sourceIdentity };
  requireOriginal(canonicalJson(result.identity).equals(canonicalJson(expected)), 'contradictory_original_authority_identity');
  const physicalScopes = pending.pending_evidence.scope.physical_timeseries_days.map(s => physicalIdentity(s, connectorId));
  if (result.before.state === 'captured') requireOriginal(canonicalJson(result.before.scopes.map(s => s.identity))
    .equals(canonicalJson(physicalScopes)), 'contradictory_original_authority_scopes');
  if (result.binding.state === 'captured') requireOriginal(canonicalJson(result.binding.bindings.map(s => s.identity))
    .equals(canonicalJson(physicalScopes)), 'contradictory_original_authority_bindings');
  return { ...result, publication: {
    pending_preparation_sha256: pending.preparation_sha256,
    source_evidence_sha256: pending.source_evidence_sha256,
    connector_manifest: connector.connector_manifest,
    original_final_batch_sha256: sha256Hex(canonicalJson(finalBatch)),
    transaction_state: 'prepared_before_original_gate_transaction' } };
}

export function preparePruneOriginalMetadataSnapshot({
  capture, bucket, dayUtc, connectorId, runId, writerGitSha,
  canonicalReferences, exactReferences, dayReferences, affectedDaysUtc,
  aggregateReferences, latestReferences,
}) {
  const groups = [
    ['canonical_manifest', canonicalReferences],
    ['exact_v3_index', exactReferences],
    ['day_manifest', dayReferences],
    ['aggregate_manifest', aggregateReferences],
    ['latest_global_index', latestReferences],
  ];
  const missingGroups = groups.filter(([role, values]) => !Array.isArray(values)
    || values.length === 0 || (role === 'day_manifest' &&
      (!Array.isArray(affectedDaysUtc) || values.length !== affectedDaysUtc.length)))
    .map(([role]) => role);
  const expected = new Map();
  let reason = missingGroups.length ? 'missing_publication_references' : null;
  for (const [role, references] of groups) {
    for (const reference of Array.isArray(references) ? references : []) {
      const key = reference?.key;
      const size = Number(reference?.byte_size);
      const sha256 = reference?.sha256;
      if (typeof key !== 'string' || !key || !Number.isSafeInteger(size) || size <= 0
        || !SHA.test(sha256 || '') || reference?.verified !== true
        || reference?.durable !== true) {
        reason ||= 'invalid_publication_reference';
        continue;
      }
      const prior = expected.get(key);
      if (prior && (prior.byte_size !== size || prior.sha256 !== sha256)) {
        reason ||= 'conflicting_publication_reference';
        continue;
      }
      if (prior) prior.roles.push(role);
      else expected.set(key, { key, byte_size: size, sha256, roles: [role] });
    }
  }
  const ordered = [...expected.values()].sort((a, b) => Buffer.compare(
    Buffer.from(a.key), Buffer.from(b.key)));
  const requiredByteSize = ordered.reduce((sum, entry) => sum + entry.byte_size, 0);
  // Base64 alone would fill the database's 1 MiB field above this bound.
  if (requiredByteSize > 786432) reason ||= 'metadata_payload_exceeds_1mib';
  const objects = [];
  const missing = [];
  if (!reason) {
    for (const entry of ordered) {
      const body = capture?.body(entry.key);
      if (!body || body.byteLength !== entry.byte_size || sha256Hex(body) !== entry.sha256) {
        missing.push(entry.key);
        continue;
      }
      objects.push({ ...entry, body });
    }
  }
  if (missing.length) reason ||= 'original_bytes_unavailable';
  const base = {
    schema_version: 1, day_utc: dayUtc, affected_days_utc: affectedDaysUtc,
    connector_id: connectorId,
    writer_identity: 'prune_daily_v3', invocation_id: runId,
    writer_git_sha: writerGitSha,
    required_object_count: ordered.length, required_raw_byte_size: requiredByteSize,
  };
  if (reason || !bucket || !runId || !writerGitSha) {
    return {
      ...base, completeness: 'not_captured',
      reason: reason || 'missing_original_identity',
      missing_roles: missingGroups,
      missing_keys_preview: missing.slice(0, 10),
      required_keys_preview: ordered.slice(0, 10).map(entry => entry.key),
      captured_object_count: objects.length,
    };
  }
  return {
    ...base, completeness: 'exact_writer_metadata_captured_unverified',
    capture_boundary: 'original_writer_put_bytes_after_verified_finalization',
    objects: objects.map(({ body, ...entry }) => ({
      roles: [...new Set(entry.roles)].sort(), canonical_bucket: bucket,
      key: entry.key, byte_size: entry.byte_size, sha256: entry.sha256,
      bytes_base64: body.toString('base64'),
    })),
  };
}
