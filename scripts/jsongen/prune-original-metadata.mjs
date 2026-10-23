import { isEnvironmentName } from './environment.mjs';
// Transient, bounded copies of exact JSON metadata bytes already offered to the
// canonical writer. The writer's normal readback/finalization remains authority.
import { sha256Hex, r2GetObjectBounded } from '../../workers/shared/r2_sigv4.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { canonicalJson } from './schema.mjs';
import { observationsGlobalOperationLockContext } from '../../workers/shared/uk_aq_r2_history_writer.mjs';
import { validateTimeseriesBindingSourceRootManifest, validateTimeseriesBindingSourceRangeManifest,
  TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND } from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { validTimeseriesBindingSourceState } from '../backup_r2/lib/timeseries_binding_source_state_v2.mjs';

const SHA = /^[0-9a-f]{64}$/;
// Separate bounded R2 bundle capacity. The 32 MiB aggregate cap covers the
// observed ~4.38 MiB before/binding plus ~7.81 MiB final snapshot with margin;
// 8 MiB/object admits the known >1 MiB latest-global index. Legacy inline
// decoding retains its independent 8 MiB / 4096 / 1 MiB limits.
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_OBJECTS = 8192;
export const PRUNE_BINDING_CAPTURE_CONCURRENCY = 8;
// ~940 physical bindings plus root/source/refresh and range metadata cannot fit
// the pending PUT's 15-second transport budget at observed TEST throughput.
// Admit this entire optional window before starting; keep each GET at 15s.
export const PRUNE_BINDING_CAPTURE_DEADLINE_MS = 90_000;
const OPTIONAL_CAPTURE_BYTES = MAX_CAPTURE_BYTES / 2;
const OPTIONAL_CAPTURE_OBJECTS = MAX_CAPTURE_OBJECTS / 2;

export function createPruneOriginalMetadataCapture() {
  const bodies = new Map();
  const groups = new Map();
  const invalidFinal = new Set();
  const finalCaptureFailures = new Map();
  let retainedBytes = 0;
  let optionalBytes = 0;
  let optionalObjects = 0;
  let originalSequence = 0;
  const release = (id, optional = false) => {
    const bytes = bodies.get(id);
    if (!bytes) return;
    retainedBytes -= bytes.length;
    if (optional) { optionalBytes -= bytes.length; optionalObjects--; }
    bodies.delete(id);
  };
  const retain = (id, value, optional = false) => {
    const previous = bodies.get(id);
    const size = value?.body?.byteLength ?? Buffer.byteLength(value?.body || '');
    if (!size) return 'empty_object';
    if (size > MAX_OBJECT_BYTES) return 'per_object_limit';
    if (!previous && bodies.size >= MAX_CAPTURE_OBJECTS) return 'object_count_limit';
    if (retainedBytes - (previous?.byteLength || 0) + size > MAX_CAPTURE_BYTES) return 'byte_limit';
    if (optional && (!previous && optionalObjects >= OPTIONAL_CAPTURE_OBJECTS)) return 'optional_object_count_limit';
    if (optional && optionalBytes - (previous?.length || 0) + size > OPTIONAL_CAPTURE_BYTES) return 'optional_byte_limit';
    const bytes = Buffer.from(value.body);
    bodies.set(id, bytes);
    retainedBytes += size - (previous?.byteLength || 0);
    if (optional) { optionalBytes += size - (previous?.length || 0); if (!previous) optionalObjects++; }
    return null;
  };
  return {
    recordPublishedObject(value) {
      let key;
      try {
        key = value?.key;
        const body = value?.body;
        if (typeof key !== 'string' || !key.endsWith('.json') || body == null) return;
        const size = body.byteLength ?? Buffer.byteLength(body);
        // Final canonical metadata has priority over optional original capture.
        // Evict whole original groups, explicitly revoking their completeness.
        if (size > 0 && size <= MAX_OBJECT_BYTES) {
          for (const [id, group] of groups) {
            if (retainedBytes - (bodies.get(key)?.length || 0) + size <= MAX_CAPTURE_BYTES
              && (bodies.has(key) || bodies.size < MAX_CAPTURE_OBJECTS)) break;
            group.capture.invalidate('final_metadata_capacity_priority_limit');
            for (const slot of group.slots) release(slot, true);
            groups.delete(id);
          }
        }
        const failure = retain(key, { body });
        if (failure) {
          // Failed replacement keeps accounting atomic, but the old bytes
          // cannot stand in for the newly offered final version.
          invalidFinal.add(key);
          finalCaptureFailures.set(key, failure);
        } else {
          invalidFinal.delete(key);
          finalCaptureFailures.delete(key);
        }
      } catch {
        // Optional evidence capture cannot change a canonical PUT result.
        if (typeof key === 'string') {
          invalidFinal.add(key);
          finalCaptureFailures.set(key, 'capture_internal_failure');
        }
      }
    },
    body(key) { return invalidFinal.has(key) ? null : bodies.get(key) || null; },
    inspectFinalObject(key, expectedByteSize, expectedSha256) {
      if (invalidFinal.has(key)) {
        const failure = finalCaptureFailures.get(key);
        return { body: null, reason: ['byte_limit', 'object_count_limit', 'per_object_limit'].includes(failure)
          ? 'capture_resource_limit_exhaustion' : 'captured_object_invalidated' };
      }
      const bytes = bodies.get(key);
      if (!bytes) return { body: null, reason: 'required_object_never_captured' };
      if (bytes.byteLength !== expectedByteSize) return { body: null, reason: 'captured_byte_size_mismatch' };
      if (sha256Hex(bytes) !== expectedSha256) return { body: null, reason: 'captured_sha256_mismatch' };
      return { body: bytes, reason: null };
    },
    statistics() { return { retained_bytes: retainedBytes, retained_objects: bodies.size,
      optional_bytes: optionalBytes, optional_objects: optionalObjects,
      final_capture_failure_counts: Object.fromEntries([...finalCaptureFailures.values()]
        .reduce((counts, reason) => counts.set(reason, (counts.get(reason) || 0) + 1), new Map())) }; },
    beginOriginalAuthority(identity, lockEnv = process.env) {
      const prefix = `original:${++originalSequence}:`;
      const group = { slots: new Set(), capture: null };
      const lockContext = observationsGlobalOperationLockContext({ env: lockEnv,
        expectedOwner: 'prune_daily', expectedRunId: identity.writer.invocation_id });
      group.capture = originalAuthorityCapture({ identity, lockContext,
        retain: (phase, value) => {
          const slot = `${prefix}${phase}:${value.key}`;
          if (retain(slot, value, true)) return true;
          group.slots.add(slot); return false;
        },
        releasePhase: phase => {
          for (const slot of group.slots) if (slot.startsWith(`${prefix}${phase}:`)) {
            release(slot, true); group.slots.delete(slot);
          }
        },
        body: (phase, key) => bodies.get(`${prefix}${phase}:${key}`) || null,
        remainingBytes: () => Math.min(MAX_CAPTURE_BYTES - retainedBytes, OPTIONAL_CAPTURE_BYTES - optionalBytes),
        remainingObjects: () => Math.min(MAX_CAPTURE_OBJECTS - bodies.size, OPTIONAL_CAPTURE_OBJECTS - optionalObjects) });
      groups.set(prefix, group);
      return group.capture;
    },
  };
}

// This is an additive, explicitly versioned schema-1 envelope extension. Old
// final metadata keeps its original meaning. Same-key BEFORE and AFTER bytes
// occupy distinct slots in ONE shared bounded R2-bundle capture budget.
const GENERATION = getObservationHistoryGeneration('v3');
const originalError = (code) => Object.assign(new Error(code), { original_authority_code: code });
const requireOriginal = (ok, code = 'contradictory_binding_authority') => {
  if (!ok) throw originalError(code);
};
const failureState = reason => reason?.includes('limit') ? 'oversized'
  : reason?.includes('contradictory') ? 'contradictory' : 'unavailable';
const physicalIdentity = (scope, connectorId) => ({ connector_id: connectorId,
  timeseries_id: scope.timeseries_id, station_id: scope.station_id, pollutant_code: scope.pollutant_code });

function originalAuthorityCapture({ identity, lockContext, retain, body, releasePhase, remainingBytes, remainingObjects }) {
  identity = JSON.parse(JSON.stringify(identity));
  // The existing supervisor owns the session and kills protected children on
  // lock loss. Do not add another lock or claim a local boolean acquired it.
  const lock = lockContext?.valid === true && lockContext.held && lockContext.acquired
    && lockContext.owner === 'prune_daily' && lockContext.run_id === identity.writer.invocation_id
    ? { logical_identity: lockContext.logical_identity, owner: lockContext.owner, run_id: lockContext.run_id }
    : null;
  const keys = new Map();
  const pins = new Map();
  let admission = null;
  let beforeFailure = null;
  let binding = { state: 'unavailable', reason: 'binding_capture_not_attempted' };
  let scopes = null;
  let scopeMembershipValid = false;
  let revoked = null;
  let bindingJob = null;
  let bindingCaptureStartedAtMs = null;
  let bindingCaptureDurationMs = null;
  let bindingCaptureUniqueKeyCount = null;
  let bindingCaptureRequiredKeyCount = null;
  let bindingCaptureRetainedObjectCount = null;
  let beforeOpen = true;
  let abortCapture = null;
  const record = (phase, value) => {
    requireOriginal(!revoked, revoked || 'original_capture_closed');
    const previous = body(phase, value.key);
    requireOriginal(!previous || previous.equals(Buffer.from(value.body)), 'contradictory_original_metadata_replacement');
    if (previous) return;
    if (retain(phase, value, true)) throw originalError('original_metadata_capture_limit');
    keys.set(`${phase}:${value.key}`, { phase, key: value.key });
  };
  const reference = (phase, key) => {
    const bytes = body(phase, key);
    if (!bytes) throw originalError('original_metadata_bytes_unavailable');
    const id = `${phase}:${key}`;
    if (!pins.has(id)) pins.set(id, { bucket: identity.canonical_bucket, key, byte_size: bytes.length, sha256: sha256Hex(bytes) });
    return pins.get(id);
  };
  const before = () => {
    if (!lock || beforeFailure || !admission || !scopeMembershipValid) return { state: failureState(beforeFailure),
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
    invalidate(reason) {
      revoked = reason; beforeOpen = false; abortCapture?.();
      releasePhase('before'); releasePhase('binding');
      keys.clear(); pins.clear();
      beforeFailure = reason; binding = { state: failureState(reason), reason };
    },
    diagnostics() {
      const originalBefore = before();
      return { before_membership_state: originalBefore.state,
        before_membership_reason: originalBefore.reason || null,
        authoritative_previous_absence: originalBefore.state === 'captured',
        binding_authority_state: binding.state, binding_authority_reason: binding.reason || null,
        binding_capture_duration_ms: bindingCaptureDurationMs,
        binding_capture_unique_key_count: bindingCaptureUniqueKeyCount,
        binding_capture_required_key_count: bindingCaptureRequiredKeyCount,
        binding_capture_retained_object_count: bindingCaptureRetainedObjectCount,
        independent_consumer_authentication: 'outstanding' };
    },
    recordBeforeObject(value) {
      if (!beforeOpen || !lock) return;
      try { record('before', value); }
      catch (error) { beforeFailure ||= error.original_authority_code || 'original_before_unavailable'; }
    },
    recordBeforeAdmission(value) {
      if (!beforeOpen || !lock) return;
      try {
        if (admission) throw originalError('contradictory_before_admission');
        admission = JSON.parse(JSON.stringify(value));
      } catch (error) { beforeFailure ||= error.original_authority_code || 'original_before_unavailable'; }
    },
    captureBindings({ physicalScopes, r2, deadlineAtMs, admitRequest = () => true,
      getObject = r2GetObjectBounded, nowMs = Date.now }) {
      if (bindingJob) return bindingJob;
      beforeOpen = false;
      bindingCaptureStartedAtMs = nowMs();
      bindingJob = (async () => {
        const controller = new AbortController();
        const reads = new Map();
        let active = true;
        let timer;
        let rejectDeadline;
        let work;
        const checkActive = () => requireOriginal(active && !revoked && !controller.signal.aborted
          && nowMs() < deadlineAtMs && admitRequest(), revoked || 'original_binding_capture_deadline');
        abortCapture = () => {
          controller.abort();
          rejectDeadline?.(originalError(revoked || 'original_binding_capture_deadline'));
        };
        try {
          requireOriginal(lock, 'original_global_lock_context_unavailable');
          requireOriginal(Number.isSafeInteger(deadlineAtMs)
            && deadlineAtMs - nowMs() <= PRUNE_BINDING_CAPTURE_DEADLINE_MS,
            'original_binding_capture_deadline');
          requireOriginal(Array.isArray(physicalScopes) && physicalScopes.length > 0
            && physicalScopes.length <= 1024, 'original_scope_membership_unavailable');
          scopes = JSON.parse(JSON.stringify(physicalScopes));
          const seen = new Set();
          for (const scope of scopes) {
            const physicalKey = canonicalJson({ ...physicalIdentity(scope, identity.connector_id), day_utc: scope.day_utc }).toString();
            requireOriginal(scope.day_utc === identity.day_utc
              && (scope.connector_id === undefined || scope.connector_id === identity.connector_id)
              && Number.isSafeInteger(scope.timeseries_id) && scope.timeseries_id > 0
              && Number.isSafeInteger(scope.station_id) && scope.station_id > 0
              && typeof scope.pollutant_code === 'string' && Number.isSafeInteger(scope.row_count) && scope.row_count > 0
              && !seen.has(physicalKey), 'contradictory_physical_scope_membership');
            seen.add(physicalKey);
          }
          const rowCount = scopes.reduce((sum, scope) => sum + scope.row_count, 0);
          requireOriginal(Number.isSafeInteger(rowCount) && rowCount <= 100000
            && rowCount === identity.source_identity.source_content_hash_row_count,
          'contradictory_complete_source_scope_membership');
          scopeMembershipValid = true;
          checkActive();
          binding = { state: 'unavailable', reason: 'binding_capture_in_progress' };
          const read = async (key, expectedSize = MAX_OBJECT_BYTES) => {
            checkActive();
            requireOriginal(key.startsWith(`${GENERATION.timeseries_binding_index_prefix}/`), 'wrong_binding_generation');
            if (reads.has(key)) return reads.get(key);
            const promise = (async () => {
              const timeout = Math.min(15_000, Math.trunc(deadlineAtMs - nowMs()));
              requireOriginal(timeout > 0, 'original_binding_capture_deadline');
              requireOriginal(remainingObjects() > 0 && remainingBytes() > 0, 'original_metadata_capture_limit');
              const object = await getObject({ r2, key, max_bytes: Math.min(MAX_OBJECT_BYTES, expectedSize, remainingBytes()),
                timeout_ms: timeout, signal: controller.signal });
              checkActive(); // No late response may mutate settled evidence.
              record('binding', { key, body: object.body });
              let value;
              try { value = JSON.parse(body('binding', key).toString('utf8')); }
              catch { throw originalError('contradictory_binding_metadata_json'); }
              return { value, reference: reference('binding', key) };
            })();
            reads.set(key, promise);
            return promise;
          };
          const pool = async (items, callback) => {
            let next = 0;
            let firstFailure;
            // Drain every worker on failure as well as success. The read cache
            // still shares one request for any repeated physical key.
            await Promise.allSettled(Array.from({ length: Math.min(PRUNE_BINDING_CAPTURE_CONCURRENCY, items.length) }, async () => {
              try {
                while (next < items.length) { checkActive(); const index = next++; await callback(items[index], index); }
              } catch (error) {
                firstFailure ||= error;
                controller.abort();
              }
            }));
            if (firstFailure) throw firstFailure;
          };
          work = (async () => {
            const prefix = GENERATION.timeseries_binding_index_prefix;
            const [root, source, refresh] = await Promise.all([
              read(`${prefix}/_manifests/root.json`), read(`${prefix}/_source_state.json`), read(`${prefix}/_manifests/_refresh_state.json`),
            ]);
            let rootValue;
            try { rootValue = validateTimeseriesBindingSourceRootManifest(root.value); }
            catch { throw originalError('contradictory_binding_root'); }
            requireOriginal(rootValue.source_prefix === prefix);
            // New proposals write source state after root/refresh. Reused state
            // is also valid only when the SAME fingerprint/root closure agrees.
            requireOriginal(typeof source.value.source_schema === 'string' && source.value.source_schema.length > 0
              && validTimeseriesBindingSourceState(source.value, { bindingPrefix: prefix, sourceSchema: source.value.source_schema })
              && Number.isSafeInteger(source.value.authoritative_timeseries_count) && source.value.authoritative_timeseries_count >= 0
              && source.value.source_tables.length === 3
              && ['timeseries', 'phenomena', 'observed_properties'].every(table => source.value.source_tables
                .filter(t => t.table === table && Number.isSafeInteger(t.row_count) && t.row_count >= 0
                  && SHA.test(t.sha256_uncompressed || '')).length === 1)
              && refresh.value.schema_version === 1 && refresh.value.history_version === 'v2'
              && refresh.value.kind === TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND
              && refresh.value.source_prefix === prefix && refresh.value.source_root_hash === rootValue.source_root_hash
              && refresh.value.source_fingerprint === source.value.source_fingerprint,
            'binding_publisher_completion_unavailable_or_contradictory');
            const roots = new Map(rootValue.ranges.map(r => [r.range_start, r]));
            const requiredRanges = new Map();
            for (const scope of scopes) {
              const rootRef = roots.get(Math.floor(scope.timeseries_id / 1000) * 1000);
              requireOriginal(rootRef && scope.timeseries_id <= rootRef.range_end, 'physical_binding_not_in_selected_root');
              requiredRanges.set(rootRef.manifest_key, rootRef);
            }
            bindingCaptureRequiredKeyCount = 3 + requiredRanges.size
              + new Set(scopes.map(scope => scope.timeseries_id)).size;
            const ranges = new Map();
            await pool([...requiredRanges.values()], async rangeRef => {
              const range = await read(rangeRef.manifest_key);
              let value;
              try { value = validateTimeseriesBindingSourceRangeManifest(range.value); }
              catch { throw originalError('contradictory_binding_range'); }
              requireOriginal(value.source_prefix === prefix && value.range_start === rangeRef.range_start
                && value.range_end === rangeRef.range_end && value.source_range_hash === rangeRef.source_range_hash
                && value.units.length === rangeRef.unit_count);
              ranges.set(rangeRef.range_start, { reference: range.reference, units: new Map(value.units.map(u => [u.timeseries_id, u])) });
            });
            const bindings = new Array(scopes.length);
            await pool(scopes, async (scope, index) => {
              const range = ranges.get(Math.floor(scope.timeseries_id / 1000) * 1000);
              const unit = range.units.get(scope.timeseries_id);
              requireOriginal(unit?.relative_path === `${prefix}/timeseries_id=${scope.timeseries_id}.json`, 'physical_binding_not_in_selected_range');
              const object = await read(unit.relative_path, unit.size);
              const physical = physicalIdentity(scope, identity.connector_id);
              requireOriginal(object.reference.sha256 === unit.sha256 && object.reference.byte_size === unit.size
                && [1, 2].includes(object.value.schema_version) && object.value.history_version === 'v2'
                && object.value.index_kind === 'timeseries_binding'
                && Object.entries(physical).every(([k, v]) => object.value[k] === v)
                && (object.value.schema_version !== 1 || !Object.hasOwn(object.value, 'continuity')));
              checkActive();
              bindings[index] = { identity: physical, authority: object.reference, range: range.reference };
            });
            checkActive();
            requireOriginal(bindings.length === scopes.length && bindings.every(Boolean), 'original_binding_membership_incomplete');
            binding = { state: 'captured', publisher: 'core_snapshot_binding_publication',
              relationship: 'completed_core_binding_metadata_snapshot_not_prune_reconciliation',
              root: root.reference, source_state: source.reference, refresh_state: refresh.reference,
              source_root_hash: rootValue.source_root_hash, source_fingerprint: source.value.source_fingerprint, bindings };
          })();
          const expired = new Promise((_, reject) => {
            rejectDeadline = reject;
            timer = setTimeout(() => { controller.abort(); reject(originalError('original_binding_capture_deadline')); },
              Math.max(0, Math.trunc(deadlineAtMs - nowMs())));
          });
          await Promise.race([work, expired]);
        } catch (error) {
          active = false; controller.abort();
          bindingCaptureRetainedObjectCount = [...keys.values()].filter(entry => entry.phase === 'binding').length;
          const reason = revoked || error.original_authority_code || (Number(error.status) === 404 ? 'binding_metadata_absent'
            : /byte budget|content length exceeds/.test(error.message || '') ? 'original_metadata_capture_limit'
              : /deadline|timeout|timed out/i.test(error.message || '') ? 'original_binding_capture_deadline' : 'binding_metadata_unavailable_or_invalid');
          binding = { state: failureState(reason), reason };
          releasePhase('binding');
          for (const [key, entry] of keys) if (entry.phase === 'binding') keys.delete(key);
        } finally {
          bindingCaptureDurationMs = Math.max(0, nowMs() - bindingCaptureStartedAtMs);
          bindingCaptureUniqueKeyCount = reads.size;
          if (bindingCaptureRetainedObjectCount === null)
            bindingCaptureRetainedObjectCount = [...keys.values()].filter(entry => entry.phase === 'binding').length;
          active = false; clearTimeout(timer); controller.abort(); abortCapture = null;
          // r2GetObjectBounded settles on abort, including its adapter path.
          // Close mutation first, then drain all reads/work before publication.
          await Promise.allSettled([...reads.values(), work]);
          reads.clear();
        }
      })();
      return bindingJob;
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
  requireOriginal(isEnvironmentName(pending.pending_evidence.environment), 'invalid_original_environment');
  const expected = { environment: pending.pending_evidence.environment, index_generation: 'v3', canonical_bucket: connector.connector_manifest.bucket,
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
  if (requiredByteSize > MAX_CAPTURE_BYTES || ordered.length > MAX_CAPTURE_OBJECTS) reason ||= 'original_metadata_capture_limit';
  const objects = [];
  const missingReasonCounts = new Map();
  if (!reason) {
    for (const entry of ordered) {
      const inspected = capture?.inspectFinalObject(entry.key, entry.byte_size, entry.sha256)
        || { body: null, reason: 'required_object_never_captured' };
      if (!inspected.body) {
        const missingReason = inspected.reason || 'required_object_never_captured';
        missingReasonCounts.set(missingReason, (missingReasonCounts.get(missingReason) || 0) + 1);
        continue;
      }
      objects.push({ ...entry, body: inspected.body });
    }
  }
  const missingObjectCount = [...missingReasonCounts.values()].reduce((sum, count) => sum + count, 0);
  const reasonPriority = ['capture_resource_limit_exhaustion', 'captured_object_invalidated',
    'captured_byte_size_mismatch', 'captured_sha256_mismatch', 'required_object_never_captured'];
  if (missingObjectCount) reason ||= reasonPriority.find(code => missingReasonCounts.has(code)) || 'original_bytes_unavailable';
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
      captured_object_count: objects.length,
      missing_object_count: missingObjectCount,
      missing_reason_counts: Object.fromEntries(missingReasonCounts),
      capture_statistics: capture?.statistics?.() || null,
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
