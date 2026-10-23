// Authenticate retained ORIGINAL Prune evidence, never current canonical R2.
import { managedR2Environment } from './r2-config.mjs';
import { originalPruneAcceptance } from './prune-outbox-reader.mjs';
import { verifyPrunePendingSource } from './prune-pending-verification.mjs';
import { BUCKET, canonicalJson, same } from './schema.mjs';
import { createPruneHandoverBudget, evidence, freeze, parseJson } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { decodePruneMetadataEvidence } from './prune-metadata-codec.mjs';
import { decodePruneEvidenceBundle, PRUNE_EVIDENCE_BUNDLE_LIMITS,
  pruneEvidenceBundleIntentId } from './prune-evidence-bundle.mjs';
import { pruneEvidenceBundleIdentity } from './prune-final-evidence.mjs';
import { readImmutable } from './inputs.mjs';
import { authenticatePruneOriginalAuthority, prunePhysicalKey } from './prune-original-authority.mjs';
import { pruneOriginalPhysicalDigest } from './prune-original-identity.mjs';
import { validateR2HistoryV2ObservationsAggregateManifest, serializeR2HistoryV2ObservationsAggregateManifest }
  from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { validateObservationHistoryExactLeafArtifactV3, validateObservationHistoryExactLeafScopedManifestArtifactV3 }
  from '../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';

// Retained for precise diagnostics on legacy incomplete events only.
export const PRUNE_RECEIPT_AUTHORITY_GAPS = freeze([
  { code: 'original_before_membership_not_retained', field: 'scopes[].before',
    required: 'Original pre-replacement physical scope membership/count and byte-pinned authority, including any admitted removals.' },
  { code: 'original_binding_authority_not_retained', field: 'source.binding_authority',
    required: 'Original selected-v3 timeseries-binding authority and complete physical station/timeseries binding evidence.' },
]);
const authenticated = new WeakMap();
const SHA = /^[a-f0-9]{64}$/;
const check = (condition, field) => evidence(condition, 'contradictory_original_evidence', `Original authority mismatch: ${field}`);
const present = (condition, field) => evidence(condition, 'missing_original_authority', `Missing retained original authority: ${field}`);
const positive = n => Number.isSafeInteger(n) && n > 0;

// The legacy schema-2 receipt boundary still requires the complete original
// connector-day. Called by receipt planning, after original authentication;
// the independent read-only planner accounts for unsupported scopes separately.
export function assertPruneReceiptScopeEligibility(source) {
  const scopes = source?.scope?.physical_timeseries_days;
  present(Array.isArray(scopes) && scopes.length > 0, 'complete_original_source_scopes');
  evidence(scopes.every(scope => ['pm25', 'pm10', 'no2'].includes(scope?.pollutant_code)),
    'unsupported_receipt_scope', 'Complete original connector-day includes a pollutant outside Stage 1 receipt scope');
}

function retainedMetadata(envelope, row, budget, { bundleMode = false } = {}) {
  const s = envelope.original_metadata_snapshot;
  present(s?.completeness === 'exact_writer_metadata_captured_unverified', 'original_metadata_snapshot');
  check(s.schema_version === 1 && s.capture_boundary === 'original_writer_put_bytes_after_verified_finalization'
    && s.writer_identity === row.writer_identity && s.invocation_id === row.run_id
    && s.writer_git_sha === row.writer_git_sha && s.connector_id === row.connector_id && s.day_utc === row.day_utc
    && same(s.affected_days_utc, envelope.original_final_batch.affected_days_utc), 'original_metadata_snapshot.identity');
  const objectLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.object_count : 4096;
  const objectByteLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.object_bytes : 1024 ** 2;
  const rawByteLimit = bundleMode ? PRUNE_EVIDENCE_BUNDLE_LIMITS.raw_bytes : 8 * 1024 ** 2;
  present(Array.isArray(s.objects) && s.objects.length > 0 && s.objects.length <= objectLimit, 'original_metadata_snapshot.objects');
  const objects = new Map(); let bytes = 0;
  const bucket = envelope.original_connector_publication.connector_manifest.bucket;
  check(typeof bucket === 'string' && bucket.length > 0 && bucket !== BUCKET, 'canonical_bucket');
  for (const object of s.objects) {
    budget.check();
    check(object.canonical_bucket === bucket && typeof object.key === 'string'
      && (object.key.startsWith('history/v3/observations/')
        || object.key.startsWith('history/_index_v3/observations_timeseries/')
        || object.key === 'history/_index_v3/observations_timeseries_latest.json')
      && object.key.endsWith('.json') && !object.key.split('/').some(p => !p || p === '.' || p === '..')
      && !objects.has(object.key) && positive(object.byte_size) && object.byte_size <= objectByteLimit
      && /^[a-f0-9]{64}$/.test(object.sha256 || '') && typeof object.bytes_base64 === 'string'
      && object.bytes_base64.length <= 4 * Math.ceil(object.byte_size / 3)
      && Array.isArray(object.roles) && object.roles.length > 0, 'original_metadata_snapshot.object');
    const body = Buffer.from(object.bytes_base64, 'base64');
    check(body.length === object.byte_size && body.toString('base64') === object.bytes_base64
      && sha256Hex(body) === object.sha256, 'original_metadata_snapshot.bytes');
    bytes += body.length; budget.bytes('metadata', body.length);
    objects.set(object.key, { ...object, value: parseJson(body) });
  }
  check(s.required_object_count === objects.size && s.required_raw_byte_size === bytes && bytes <= rawByteLimit,
    'original_metadata_snapshot.coverage');
  const lookup = (reference, role) => {
    present(reference && typeof reference.key === 'string', role);
    const object = objects.get(reference.key);
    present(object, `${role}.bytes`);
    check(object.sha256 === reference.sha256 && object.byte_size === reference.byte_size
      && (!reference.bucket || reference.bucket === bucket) && object.roles.includes(role), `${role}.reference`);
    return object.value;
  };
  return { objects, lookup };
}

// This checks original reference/source relationships retained by Prune's
// successful verifier. It neither recalculates publication success nor reads
// canonical observations. Missing required source authority still blocks receipts.
function bindOriginalPublication(e, row, source, metadata, onStage) {
  onStage('original_connector_manifest');
  const c = e.original_connector_publication;
  const manifest = metadata.lookup(c.connector_manifest, 'canonical_manifest');
  validateCanonicalHistoryV2Manifest(manifest, { manifest_key: row.history_manifest_key,
    manifest_kind: 'connector', connector_id: 1, day_utc: row.day_utc, domain: 'observations' });
  check(manifest.manifest_key === row.history_manifest_key && manifest.manifest_hash === row.history_manifest_hash
    && manifest.connector_id === 1 && manifest.day_utc === row.day_utc && manifest.history_version === 'v2'
    && manifest.source_row_count === Number(row.history_row_count)
    && manifest.file_count === Number(row.history_file_count) && manifest.total_bytes === Number(row.history_total_bytes),
  'connector_manifest.accepted_identity');
  const expected = source.scope.pollutant_partitions;
  check(Array.isArray(c.pollutant_manifests) && c.pollutant_manifests.length === expected.length
    && new Set(c.pollutant_manifests.map(p => p.pollutant_code)).size === expected.length,
  'complete_pollutant_partition_membership');
  const manifestChildren = manifest.pollutant_manifests;
  check(Array.isArray(manifestChildren) && manifestChildren.length === expected.length,
    'connector_manifest.complete_pollutant_children');
  for (const partition of expected) {
    onStage('original_pollutant_manifest');
    const p = c.pollutant_manifests.find(p => p.pollutant_code === partition.pollutant_code);
    present(p, 'original_pollutant_publication');
    const m = metadata.lookup(p.manifest, 'canonical_manifest');
    validateCanonicalHistoryV2Manifest(m, { manifest_key: p.manifest.key, manifest_kind: 'pollutant',
      day_utc: row.day_utc, connector_id: 1, pollutant_code: partition.pollutant_code, domain: 'observations' });
    check(p.row_count === partition.row_count && p.observation_content_hash === partition.observation_content_hash
      && p.observation_content_hash_contract_version === partition.observation_content_hash_contract_version
      && same(p.verification_status_counts, partition.verification_status_counts)
      && m.pollutant_code === partition.pollutant_code && m.connector_id === 1 && m.day_utc === row.day_utc
      && m.manifest_key === p.manifest.key && m.manifest_hash === p.manifest.semantic_manifest_hash
      && m.row_count === partition.row_count && m.observation_content_hash === partition.observation_content_hash
      && m.observation_content_hash_contract_version === partition.observation_content_hash_contract_version
      && same(m.verification_status_counts, partition.verification_status_counts)
      && manifestChildren.filter(child => child.manifest_key === m.manifest_key && child.manifest_hash === m.manifest_hash).length === 1,
    'pollutant.content_and_effective_status');
    const counts = {};
    for (const scope of source.scope.physical_timeseries_days.filter(s => s.pollutant_code === partition.pollutant_code))
      counts[scope.timeseries_id] = (counts[scope.timeseries_id] || 0) + scope.row_count;
    check(same(counts, m.timeseries_row_counts), 'pollutant.complete_timeseries_membership');
    check(Array.isArray(p.files) && Array.isArray(m.files) && p.files.length === m.files.length
      && p.files.every(file => m.files.filter(f => f.key === file.key && f.row_count === file.row_count
        && f.bytes === file.byte_size && f.etag_or_hash === file.sha256
        && same(f.timeseries_row_counts || null, file.timeseries_row_counts)).length === 1), 'pollutant.original_file_identities');
    const roots = c.scoped_roots?.filter(r => r.scope.pollutant_code === partition.pollutant_code);
    check(roots?.length === 1 && roots[0].scope.day_utc === row.day_utc && roots[0].scope.connector_id === 1,
      'original_exact_scope');
    onStage('original_exact_scope');
    const index = metadata.lookup(roots[0].reference, 'exact_v3_index');
    check(index.index_generation === 'v3' && index.day_utc === row.day_utc && index.connector_id === 1
      && index.pollutant_code === partition.pollutant_code
      && same(Object.keys(index.leaves_by_timeseries_id || {}).sort(), Object.keys(counts).sort()),
    'original_exact_scope.complete_membership');
    // Embedded status is attested by the original Prune verifier. A schema-4
    // transition would need original overlay/transition authority, absent here.
    present(index.history_schema_version === 3 && index.writer_version === 'parquet-wasm-zstd-v3',
      'original_effective_status.schema3_embedded_or_authenticated_overlay_transition');
    const artifact = (reference, kind, stage) => {
      const payload = metadata.lookup(reference, 'exact_v3_index');
      const object = metadata.objects.get(reference.key);
      return { kind, publication_stage: stage, key: reference.key, sha256: reference.sha256,
        byte_size: reference.byte_size, body: Buffer.from(object.bytes_base64, 'base64').toString(), payload };
    };
    const aligned = metadata.lookup(index.source_aligned_scoped_manifest, 'exact_v3_index');
    check(aligned.canonical_source_manifest?.key === p.manifest.key
      && aligned.canonical_source_manifest.sha256 === p.manifest.sha256
      && aligned.canonical_source_manifest.byte_size === p.manifest.byte_size
      && aligned.canonical_source_manifest.manifest_hash === m.manifest_hash
      && aligned.canonical_source_manifest.observation_content_hash === partition.observation_content_hash,
    'original_exact_to_canonical_source_relationship');
    const leaves = [];
    for (const [id, tuple] of Object.entries(index.leaves_by_timeseries_id)) {
      onStage('original_exact_leaf');
      const reference = { key: tuple[0], byte_size: tuple[1], sha256: tuple[2] };
      const leaf = artifact(reference, 'observation_history_index_v3_exact_leaf', 'child_shard');
      validateObservationHistoryExactLeafArtifactV3({ artifact: leaf });
      check(leaf.payload.timeseries_id === Number(id) && leaf.payload.row_count === counts[id], 'original_leaf_row_membership');
      const shard = metadata.lookup(leaf.payload.source_aligned_child, 'exact_v3_index');
      check(same(shard.canonical_source_manifest, aligned.canonical_source_manifest)
        && aligned.children.some(child => child.key === leaf.payload.source_aligned_child.key
          && child.sha256 === leaf.payload.source_aligned_child.sha256 && child.byte_size === leaf.payload.source_aligned_child.byte_size),
      'original_aligned_parent_child_relationship');
      check(leaf.payload.files.every(file => m.files.some(f => f.key === file.key && f.bytes === file.byte_size
        && f.etag_or_hash === file.sha256)), 'original_exact_file_identity');
      leaves.push(leaf);
    }
    onStage('original_exact_scope_membership');
    validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact: artifact(roots[0].reference,
      'observation_history_index_v3_exact_leaf_scoped_manifest', 'scoped_manifest'), exactLeaves: leaves });
  }
  check(c.scoped_roots.length === expected.length, 'complete_exact_scope_membership');
}

function authenticateFinalHierarchy(e, row, metadata) {
  const day = row.day_utc, base = 'history/v3/observations';
  const keys = [`${base}/_manifests/manifest.json`, `${base}/_manifests/year=${day.slice(0, 4)}/manifest.json`,
    `${base}/_manifests/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/manifest.json`, `${base}/day_utc=${day}/manifest.json`];
  let parent = null; let root;
  for (let i = 0; i < keys.length; i++) {
    const object = metadata.objects.get(keys[i]); present(object, 'complete_final_root_to_day_metadata');
    const value = object.value;
    if (i < 3) {
      const parsed = validateR2HistoryV2ObservationsAggregateManifest(value, { basePrefix: base });
      check(Buffer.from(object.bytes_base64, 'base64').equals(serializeR2HistoryV2ObservationsAggregateManifest(parsed, { basePrefix: base }))
        && value.kind === `uk_aq_observations_${['root', 'year', 'month'][i]}_manifest`
        && (i === 0 || String(value.year) === day.slice(0, 4)) && (i !== 2 || value.month === day.slice(5, 7)), 'final_aggregate_identity');
    } else validateCanonicalHistoryV2Manifest(value, { manifest_key: keys[i], manifest_kind: 'day', day_utc: day, domain: 'observations' });
    if (parent) {
      const references = parent.children.filter(child => child.manifest_key === keys[i]);
      check(references.length === 1 && references[0][i === 3 ? 'manifest_hash' : 'content_hash']
        === value[i === 3 ? 'manifest_hash' : 'content_hash'], 'final_root_to_day_relationship');
    }
    if (i === 0) root = { bucket: object.canonical_bucket, key: object.key, sha256: object.sha256, byte_size: object.byte_size };
    parent = value;
  }
  check(same(parent.connector_manifests, parent.child_manifests)
    && parent.connector_manifests.filter(c => c.connector_id === 1 && c.manifest_key === row.history_manifest_key
      && c.manifest_hash === row.history_manifest_hash).length === 1, 'final_day_to_accepted_connector');
  return root;
}

export function inspectAuthenticatedPruneHandover(value) {
  const result = authenticated.get(value);
  evidence(result, 'unauthenticated_original_outbox', 'Independent original gate and private source authentication required');
  return result;
}

export async function authenticatePruneHandover({ acceptance, derivedR2, budget = createPruneHandoverBudget(),
  onStage = () => {} }) {
  onStage('original_outbox_evidence');
  const { row, bytes, executionEnvironment } = originalPruneAcceptance(acceptance);
  evidence(row.environment === executionEnvironment && managedR2Environment(derivedR2) === executionEnvironment
    && acceptance.key.environment === executionEnvironment
    && acceptance.post_commit_reference.message.environment === row.environment,
  'cross_environment_evidence', 'Original acceptance and configured reader/storage environments must agree');
  const message = acceptance.post_commit_reference.message;
  present(row.final_evidence_state === 'prepared_unverified' && bytes, 'final_evidence_bytes');
  check(bytes.length === Number(row.final_evidence_byte_size) && bytes.length <= 1024 ** 2
    && sha256Hex(bytes) === row.final_evidence_sha256, 'final_evidence_bytes.sha256');
  budget.bytes('metadata', bytes.length);
  let e = parseJson(bytes);
  check(canonicalJson(e).equals(bytes) && e.schema_version === 1
    && e.kind === 'uk_aq_jsongen_prune_original_final_evidence_preparation'
    && e.authority_state === 'precommit_prepared_unverified' && e.environment === row.environment
    && e.index_generation === 'v3' && same(e.writer, message.writer)
    && e.connector_id === 1 && e.day_utc === row.day_utc, 'final_evidence.original_writer');
  const bundlePointer = e.original_metadata_evidence?.codec === 'immutable_r2_json_gzip_v1';
  let bundleMode = false;
  if (bundlePointer) {
    onStage('immutable_bundle_reference');
    const pointer = e.original_metadata_evidence;
    const ref = pointer.reference;
    const identity = pointer.identity;
    present(pointer.schema_version === 1 && e.original_metadata_snapshot?.schema_version === 3
      && e.original_metadata_snapshot.completeness === 'externalized_unverified'
      && e.original_metadata_snapshot.representation === 'immutable_r2_json_gzip_v1'
      && e.original_authority_extension?.schema_version === 3
      && e.original_authority_extension.completeness === 'externalized_unverified'
      && e.original_authority_extension.kind === 'uk_aq_prune_original_scope_binding_authority'
      && ref?.conditional_create === 'if_none_match_star', 'versioned_original_evidence_bundle_reference');
    check(ref.bucket === derivedR2?.bucket && SHA.test(ref.sha256 || '')
      && Number.isSafeInteger(ref.byte_size) && ref.byte_size > 0
      && ref.byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.compressed_bytes
      && SHA.test(ref.json_sha256 || '') && Number.isSafeInteger(ref.json_byte_size)
      && ref.json_byte_size > 0 && ref.json_byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.json_bytes
      && Number.isSafeInteger(ref.object_count) && ref.object_count > 0
      && ref.object_count <= PRUNE_EVIDENCE_BUNDLE_LIMITS.object_count
      && Number.isSafeInteger(ref.raw_byte_size) && ref.raw_byte_size > 0
      && ref.raw_byte_size <= PRUNE_EVIDENCE_BUNDLE_LIMITS.raw_bytes
      && SHA.test(ref.intent_id || '') && typeof ref.key === 'string'
      && ref.key === `managed/jsongen/v1/evidence-bundles/prune_daily_v3/connector_id=${row.connector_id}`
        + `/day_utc=${row.day_utc}/invocation=${encodeURIComponent(row.run_id)}`
        + `/compressed_sha256=${ref.sha256}.json.gz`, 'immutable_bundle_key_and_bounds');
    check(identity?.writer_identity === row.writer_identity
      && identity.environment === row.environment
      && identity.invocation_id === row.run_id && identity.attempt_id === row.attempt_id
      && identity.writer_git_sha === row.writer_git_sha && identity.index_generation === 'v3'
      && identity.connector_id === row.connector_id && identity.day_utc === row.day_utc
      && identity.object_type === 'prune_original_final_evidence_bundle_gzip'
      && identity.source_evidence_sha256 === e.pending?.source_evidence_sha256
      && identity.source_identity_sha256 === sha256Hex(canonicalJson(e.pending?.source_identity))
      && identity.scope?.kind === 'connector_day' && identity.scope.connector_id === row.connector_id
      && identity.scope.day_utc === row.day_utc
      && pruneEvidenceBundleIntentId({ bucket: ref.bucket, key: ref.key, identity,
        compressed_byte_size: ref.byte_size, compressed_sha256: ref.sha256,
        uncompressed_byte_size: ref.json_byte_size, uncompressed_sha256: ref.json_sha256 }) === ref.intent_id,
    'bundle_reference_original_invocation_binding');
    evidence(ref.byte_size + ref.json_byte_size <= budget.remainingBytes(), 'resource_limit',
      'Evidence bundle exceeds remaining bounded decode budget');
    onStage('immutable_bundle_readback');
    const compressed = await readImmutable({ r2: derivedR2,
      reference: { bucket: ref.bucket, key: ref.key, sha256: ref.sha256, byte_size: ref.byte_size },
      maxBytes: PRUNE_EVIDENCE_BUNDLE_LIMITS.compressed_bytes, budget, domain: 'metadata' });
    evidence(ref.json_byte_size <= budget.remainingBytes(), 'resource_limit',
      'Evidence bundle decompression exceeds remaining bounded decode budget');
    onStage('immutable_bundle_decode');
    const decodedBytes = decodePruneEvidenceBundle({ compressed,
      reference: { byte_size: ref.byte_size, sha256: ref.sha256,
        json_byte_size: ref.json_byte_size, json_sha256: ref.json_sha256 },
      expected: { environment: row.environment, writer_identity: row.writer_identity,
        invocation_id: row.run_id, attempt_id: row.attempt_id,
        writer_git_sha: row.writer_git_sha, connector_id: row.connector_id, day_utc: row.day_utc } });
    budget.bytes('decompressed', ref.json_byte_size);
    check(same(identity, pruneEvidenceBundleIdentity(decodedBytes))
      && decodedBytes.pending?.intent_id === e.pending.intent_id
      && same(decodedBytes.pending?.object, e.pending.object)
      && decodedBytes.pending?.preparation_sha256 === e.pending.preparation_sha256
      && decodedBytes.pending?.source_evidence_sha256 === e.pending.source_evidence_sha256
      && same(decodedBytes.pending?.source_identity, e.pending.source_identity)
      && same(decodedBytes.original_candidate_connector_gate, e.original_candidate_connector_gate)
      && decodedBytes.original_metadata_snapshot.required_object_count
        === e.original_metadata_snapshot.required_object_count
      && decodedBytes.original_metadata_snapshot.required_raw_byte_size
        === e.original_metadata_snapshot.required_raw_byte_size
      && decodedBytes.original_authority_extension.required_object_count
        === e.original_authority_extension.required_object_count
      && decodedBytes.original_authority_extension.required_raw_byte_size
        === e.original_authority_extension.required_raw_byte_size
      && decodedBytes.original_authority_extension.before.state === e.original_authority_extension.before.state
      && decodedBytes.original_authority_extension.binding.state === e.original_authority_extension.binding.state
      && ref.object_count === decodedBytes.original_metadata_snapshot.objects.length
        + decodedBytes.original_authority_extension.objects.length
      && ref.raw_byte_size === decodedBytes.original_metadata_snapshot.required_raw_byte_size
        + decodedBytes.original_authority_extension.required_raw_byte_size,
    'bundle_pointer_shell_identity');
    e = decodedBytes;
    bundleMode = true;
  } else {
    onStage('inline_evidence_decode');
    present(e.original_metadata_evidence && e.original_metadata_snapshot?.schema_version === 2
      && e.original_authority_extension?.schema_version === 2, 'compressed_original_before_and_binding_authority');
    evidence(Number.isSafeInteger(e.original_metadata_evidence.json_byte_size)
      && Number.isSafeInteger(e.original_metadata_evidence.byte_size)
      && e.original_metadata_evidence.json_byte_size + e.original_metadata_evidence.byte_size <= budget.remainingBytes(),
    'resource_limit', 'Original compressed metadata exceeds remaining decode budget');
    let decoded;
    try { decoded = decodePruneMetadataEvidence(e); } catch (error) {
      evidence(false, error.original_authority_code || 'invalid_original_metadata_encoding', 'Original compressed metadata failed strict decoding');
    }
    budget.bytes('metadata', e.original_metadata_evidence.byte_size + e.original_metadata_evidence.json_byte_size);
    // Legacy inline bytes remain decoded and validated under their unchanged codec.
    e.original_metadata_snapshot = decoded.original_metadata_snapshot;
    e.original_authority_extension = decoded.original_authority_extension;
  }
  const p = e.pending; const c = e.original_connector_publication; const gate = e.original_candidate_connector_gate;
  check(p?.intent_id === row.pending_intent_id && same(p.object, message.pending.object)
    && same(p.source_identity, message.source_identity) && c?.run_id === row.run_id && c.connector_id === 1
    && c.day_utc === row.day_utc && c.manifest_key === row.history_manifest_key && c.manifest_hash === row.history_manifest_hash
    && c.connector_manifest.key === row.history_manifest_key
    && c.connector_manifest.sha256 === row.connector_manifest_byte_sha256
    && c.connector_manifest.byte_size === Number(row.connector_manifest_byte_size)
    && c.source_row_count === Number(row.history_row_count) && c.file_count === Number(row.history_file_count)
    && c.total_bytes === Number(row.history_total_bytes)
    && Number(row.history_row_count) === message.source_identity.source_content_hash_row_count
    && gate?.candidate_run_id === row.run_id && gate.connector_manifest_key === row.history_manifest_key
    && gate.connector_manifest_hash === row.history_manifest_hash && same(gate.source_identity, message.source_identity)
    && gate.expected_ready_marker === row.candidate_ready_marker, 'accepted_gate_source_and_manifest');
  // The envelope truthfully predates COMMIT. Its authority comes from the actual
  // immutable committed SELECT, never a mutable READY row or a message string.
  check(gate.transaction_state === 'not_asserted_in_preparation' && gate.retained_transaction_proof === false,
    'precommit_envelope_boundary');
  const batch = e.original_final_batch;
  onStage('original_finalization');
  present(batch?.validation?.boundary === 'validatePhaseBV3RunFinalizationResult'
    && batch.observed_boundary === 'validated_v3_run_finalizer_returned'
    && batch.validation.canonical_aggregate_authority_verified === true
    && batch.validation.parent_state_reread_under_lock === true
    && positive(batch.validation.exact_scope_publication_count)
    && batch.validation.all_exact_scope_publications_ok === true && batch.validation.latest_global_ok === true
    && Array.isArray(batch.affected_days_utc) && batch.affected_days_utc.includes(row.day_utc)
    && new Set(batch.affected_days_utc).size === batch.affected_days_utc.length,
  'validated_required_v3_finalisation');
  onStage('original_metadata_snapshot');
  const metadata = retainedMetadata(e, row, budget, { bundleMode });
  onStage('original_finalization_references');
  for (const [field, role] of [['canonical_aggregate_references', 'aggregate_manifest'],
    ['exact_scope_references', 'exact_v3_index'], ['latest_global_references', 'latest_global_index']]) {
    present(Array.isArray(batch[field]) && batch[field].length > 0, `original_final_batch.${field}`);
    check(new Set(batch[field].map(r => r.key)).size === batch[field].length, `original_final_batch.${field}.duplicates`);
    batch[field].forEach(ref => metadata.lookup(ref, role));
  }
  metadata.lookup(batch.day_manifest, 'day_manifest');
  check(same(batch.exact_scope_references, c.scoped_roots.map(r => r.reference).sort((a, b) => a.key.localeCompare(b.key))),
    'original_final_batch.exact_scope_references');
  for (const day of batch.affected_days_utc)
    present(metadata.objects.get(`history/v3/observations/day_utc=${day}/manifest.json`)?.roles.includes('day_manifest'),
      'original_final_batch.complete_affected_day_metadata');
  present(p.source_evidence, 'complete_original_source_evidence');
  const { signed_upload: signed, ...unsigned } = p.source_evidence;
  check(sha256Hex(canonicalJson(unsigned)) === p.source_evidence_sha256
    && sha256Hex(canonicalJson(p.source_evidence)) === p.preparation_sha256
    && signed?.intent_id === p.intent_id && same(signed.object, p.object)
    && signed.disposition === 'put_acknowledged_unverified', 'original_signed_source_description');
  onStage('private_pending_source');
  const pending = await verifyPrunePendingSource({ r2: derivedR2, reference: p.object, intentId: p.intent_id,
    runId: row.run_id, dayUtc: row.day_utc, connectorId: 1,
    expectedRowCount: message.source_identity.source_content_hash_row_count,
    sourceIdentity: message.source_identity, expectedEvidenceSha256: p.source_evidence_sha256, environment: row.environment, budget });
  check(same(pending.pending_evidence, unsigned)
    && same(p.original_source_status, unsigned.original_source_status)
    && same(p.effective_verification_status, unsigned.effective_verification_status)
    && row.original_source_status_provenance === unsigned.original_source_status.classification,
  'complete_source_scope_and_status_provenance');
  onStage('original_publication_references');
  bindOriginalPublication(e, row, unsigned, metadata, onStage);
  onStage('original_final_hierarchy');
  const root = authenticateFinalHierarchy(e, row, metadata);
  onStage('original_physical_scope_binding');
  const original = authenticatePruneOriginalAuthority({ envelope: e, row, source: unsigned,
    budget, bundleMode });
  onStage('authenticated_scope_construction');
  const bucket = root.bucket;
  const pin = r => ({ bucket: r.bucket || bucket, key: r.key, sha256: r.sha256, byte_size: r.byte_size });
  const sources = {}; const scopes = {}; const scopeAuthorities = {};
  const originalBindings = new Map(e.original_authority_extension.binding.bindings.map(b =>
    [prunePhysicalKey({ identity: b.identity, day_utc: row.day_utc }), b.authority]));
  for (const partition of unsigned.scope.pollutant_partitions) {
    const child = c.pollutant_manifests.find(p => p.pollutant_code === partition.pollutant_code);
    const index = pin(c.scoped_roots.find(p => p.scope.pollutant_code === partition.pollutant_code).reference);
    sources[partition.pollutant_code] = { index_generation: 'v3', history_version: 'v2',
      generation_authority: index, observations_root: root, index_authority: index,
      final_publication: root, verification_authority: pin(child.manifest),
      binding_authority: original.bindingRoot, verified_at_utc: new Date(row.gate_history_completed_at).toISOString() };
    for (const s of unsigned.scope.physical_timeseries_days.filter(s => s.pollutant_code === partition.pollutant_code)) {
      const identity = { connector_id: 1, timeseries_id: s.timeseries_id, station_id: s.station_id, pollutant_code: s.pollutant_code };
      scopes[prunePhysicalKey(s)] = { identity, day_utc: row.day_utc, before: original.beforeScopes[prunePhysicalKey(s)],
        after: { state: 'present', row_count: s.row_count, authority: pin(child.manifest) } };
      const indexValue = metadata.objects.get(index.key).value;
      const tuple = indexValue.leaves_by_timeseries_id[String(s.timeseries_id)];
      const leaf = metadata.objects.get(tuple[0]);
      scopeAuthorities[prunePhysicalKey(s)] = {
        scope_key: prunePhysicalKey(s), physical_sha256: pruneOriginalPhysicalDigest(scopes[prunePhysicalKey(s)], leaf.value),
        leaf: pin(leaf), index, binding: originalBindings.get(prunePhysicalKey(s)),
        effective_status: 'original_schema3_embedded_status_bound' };
    }
  }
  const authority = { schema_version: 1, kind: 'uk_aq_jsongen_prune_acceptance_authority',
    relation: 'uk_aq_ops.prune_jsongen_gate_acceptance_outbox', key: acceptance.key, event_id: acceptance.event_id,
    writer_git_sha: row.writer_git_sha, final_evidence_sha256: row.final_evidence_sha256,
    final_evidence_byte_size: Number(row.final_evidence_byte_size), post_commit_reference_sha256: acceptance.post_commit_reference.sha256 };
  const result = freeze({ state: 'authenticated', event_id: acceptance.event_id, key: acceptance.key,
    original_gate: 'authenticated_committed_immutable_outbox', original_final_evidence: 'authenticated_original_prune_attestation',
    pending_source: 'source_bytes_verified', physical_scope_count: unsigned.scope.physical_timeseries_days.length,
    observation_count: unsigned.original_ndjson.row_count,
    effective_status: 'original_schema3_embedded_status_bound',
    source_status: unsigned.original_source_status.classification,
    receipt_eligible: false, missing_authority: [],
    current_canonical_authority: 'not_inspected', publication_eligible: false });
  // Keep actual rows out of public machine-readable results and log summaries.
  const token = Object.freeze({ event_id: result.event_id });
  authenticated.set(token, freeze({ operationBudget: budget, result, pending, authority, sources, scopes, scopeAuthorities, writer: e.writer,
    original_source_status: unsigned.original_source_status, source_identity: unsigned.source_identity,
    original_global_lock: original.lock, original_evidence_sha256: row.final_evidence_sha256,
    post_commit_reference_sha256: acceptance.post_commit_reference.sha256,
    original_evidence_bundle: bundlePointer ? parseJson(bytes).original_metadata_evidence.reference : null }));
  return token;
}
