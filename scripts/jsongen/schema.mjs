import { isEnvironmentName } from './environment.mjs';
// Managed JSONgen wire contracts. Validation checks shape/relationships, not the
// truth of writer attestations. No canonical reader or scope-dominance checker lives here.
import { assertSelectedReceiptOrigin, assertSelectedControlEvents } from './prune-event-schema.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AQI_ALGORITHM_VERSION, DAQI_PM_ROLLING24H_WINDOW_HOURS,
  DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../lib/aqi/aqi_levels.mjs';
import { assertObservationHistoryGeneration, getObservationHistoryGeneration }
  from '../../workers/shared/uk_aq_observation_history_generation.mjs';

export const ROOT = 'managed/jsongen/v1';
export const CONTROL_KEY = `${ROOT}/control/current.json`;
// The JSONgen bucket is deployment configuration, never a TEST/LIVE source pin.
// An empty value cannot authenticate managed references; runtime admission also
// requires the complete explicit endpoint/bucket configuration.
export const BUCKET = typeof process.env.UK_AQ_JSONGEN_R2_BUCKET === 'string'
  ? process.env.UK_AQ_JSONGEN_R2_BUCKET.trim() : '';
export const ALGORITHM = AQI_ALGORITHM_VERSION;
// Retained identifier for Stage 1 control compatibility. It denotes unverified
// canonical scope precedence/receipt coverage, not a missing global event counter.
export const ORDERING_BLOCKER = 'verified_event_ordering_unavailable';
export const FAILURE_CODES = Object.freeze([
  'missing_authenticated_baseline', 'corrupt_monthly_json',
  'missing_required_preceding_context', 'invalid_provenance',
  'missing_verified_replacement_bundle', 'incomplete_source_change_registration',
  'conditional_publication_conflict', 'ambiguous_r2_write_outcome',
  'superseded_publication_candidate', ORDERING_BLOCKER,
]);
export const LIFECYCLE_STATES = Object.freeze([
  'verified_pending', 'dispatch_attempted', 'dispatch_accepted', 'dispatch_ambiguous',
  'generation_attempted', 'selected', 'failed_retryable', 'superseded', 'reconcile_required',
]);
export const newPubID = () => randomUUID();
export function requireValid(condition, message) {
  if (!condition) throw new TypeError(`JSONgen: ${message}`);
}
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const text = (x) => typeof x === 'string' && x.length > 0 && x.length <= 1024;
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const id = (x) => Number.isSafeInteger(x) && x > 0;
const sha = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = (x) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const changeId = (x) => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(x);
const instant = (x) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)
  && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const day = (x) => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && instant(`${x}T00:00:00.000Z`);
const month = (x) => typeof x === 'string' && /^\d{4}-\d\d$/.test(x) && day(`${x}-01`);
const key = (x) => text(x) && !x.split('/').some((s) => !s || s === '.' || s === '..') && !/[\\\x00-\x20?#%]/.test(x);
function fields(value, required, optional = []) {
  requireValid(object(value), 'expected object');
  requireValid(required.every((k) => Object.hasOwn(value, k)), `missing field (${required.join(', ')})`);
  requireValid(Object.keys(value).every((k) => [...required, ...optional].includes(k)), 'unknown field');
}
function header(value, kind) {
  requireValid(value.schema_version === 1 && value.kind === `uk_aq_jsongen_${kind}`, 'schema/kind mismatch');
}
export function canonicalJson(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return Buffer.from(`${JSON.stringify(sort(value))}\n`);
}
export const same = (a, b) => canonicalJson(a).equals(canonicalJson(b));
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function ids(value) {
  requireValid(Array.isArray(value) && value.every(changeId)
    && same(value, [...new Set(value)].sort()), 'change IDs must be a sorted unique SET, never event order');
}
export function assertIdentity(value) {
  fields(value, ['connector_id', 'timeseries_id', 'station_id', 'pollutant_code']);
  requireValid(id(value.connector_id) && id(value.timeseries_id) && id(value.station_id)
    && ['pm25', 'pm10', 'no2'].includes(value.pollutant_code), 'invalid physical identity');
  return value;
}
export function monthKey(identity, monthUtc) {
  assertIdentity(identity);
  requireValid(month(monthUtc), 'invalid month');
  return `${identity.connector_id}:${identity.timeseries_id}:${identity.station_id}:${identity.pollutant_code}:${monthUtc}`;
}
// Immutable R2 keys use explicit path components. monthKey() is only the
// private control-map key and must never appear in a publication object path.
export function publicationPrefix(identity, monthUtc, pubID) {
  assertIdentity(identity);
  requireValid(month(monthUtc) && uuid(pubID), 'invalid publication month/UUIDv4');
  return `${ROOT}/publications/connector_id=${identity.connector_id}`
    + `/timeseries_id=${identity.timeseries_id}/station_id=${identity.station_id}`
    + `/pollutant=${identity.pollutant_code}/month_utc=${monthUtc}/${pubID}`;
}
export function assertReference(value, { managed = false, gzip = false } = {}) {
  fields(value, ['bucket', 'key', 'sha256', 'byte_size'], gzip ? ['json_sha256', 'json_byte_size'] : []);
  requireValid(text(value.bucket) && key(value.key) && sha(value.sha256)
    && integer(value.byte_size) && value.byte_size > 0, 'invalid object reference');
  if (managed) requireValid(value.bucket === BUCKET && value.key.startsWith(`${ROOT}/`), 'outside managed storage');
  if (gzip) requireValid(value.key.endsWith('.gz') && sha(value.json_sha256)
    && integer(value.json_byte_size) && value.json_byte_size > 0, 'missing uncompressed evidence');
  return value;
}
export function assertSource(value) {
  fields(value, ['index_generation', 'history_version', 'generation_authority', 'observations_root',
    'index_authority', 'final_publication', 'verification_authority', 'binding_authority', 'verified_at_utc']);
  requireValid(value.index_generation === 'v3' && value.history_version === 'v2'
    && instant(value.verified_at_utc), 'only verified index_v3 source authority is supported');
  for (const name of ['generation_authority', 'observations_root', 'index_authority',
    'final_publication', 'verification_authority', 'binding_authority']) assertReference(value[name]);
  requireValid(value.index_authority.key.startsWith('history/_index_v3/'), 'not an index_v3 authority');
  // Canonical physical paths are explicitly pinned by the writer, never derived
  // from index generation, and never fetched by these foundations.
  return value;
}
// Stage 1 receipts deliberately did not encode a complete generation descriptor.
// Keep their immutable wire format readable. This checks only namespace coupling;
// it never authenticates the writer, the current selector, or the referenced bytes.
export function inspectSourceGeneration(value, generation) {
  assertSource(value);
  assertObservationHistoryGeneration(generation);
  requireValid(generation === getObservationHistoryGeneration('v3'), 'selected complete-v3 generation required');
  const under = (reference, prefix) => reference.key.startsWith(`${prefix}/`);
  const coupled = reference => [generation.observations_prefix, generation.core_prefix,
    generation.observations_runs_prefix, generation.index_root_prefix].some(prefix => under(reference, prefix));
  const references = [value.generation_authority, value.observations_root, value.index_authority,
    value.final_publication, value.verification_authority, value.binding_authority];
  const mismatch = value.observations_root.key !== generation.observations_root_key
    || !under(value.index_authority, generation.observations_timeseries_index_prefix)
    || !under(value.binding_authority, generation.timeseries_binding_index_prefix)
    || references.some(reference => reference.bucket !== value.observations_root.bucket
      || reference.bucket === BUCKET)
    || [value.generation_authority, value.final_publication, value.verification_authority]
      .some(reference => reference.key.startsWith('history/v2/') || reference.key.startsWith('history/_index_v2/'));
  if (mismatch) return { state: 'selected_v3_source_generation_mismatch',
    detail: 'Declared observation root, index, binding or generation-coupled authority contradicts selected complete v3.' };
  if (![value.generation_authority, value.final_publication, value.verification_authority].every(coupled))
    return { state: 'selected_v3_source_authority_unresolved',
      detail: 'A declared authority has no provable selected-v3 namespace; retain the receipt as historical evidence.' };
  return { state: 'selected_v3_source_namespace_consistent',
    detail: 'Declared references use one selected-v3 namespace; currentness and final writer publication remain unproven.' };
}
function membership(value) {
  fields(value, ['state', 'row_count', 'authority']);
  requireValid(['present', 'authoritative_empty'].includes(value.state) && integer(value.row_count)
    && (value.state === 'authoritative_empty') === (value.row_count === 0), 'invalid scope membership');
  assertReference(value.authority);
}
export function assertScope(value) {
  fields(value, ['identity', 'day_utc', 'before', 'after']);
  assertIdentity(value.identity);
  requireValid(day(value.day_utc), 'invalid UTC replacement day');
  membership(value.before); membership(value.after);
  return value;
}
export const scopeKey = (s) => `${monthKey(s.identity, s.day_utc.slice(0, 7))}:${s.day_utc}`;
export function affectedMonths(scopes) {
  const result = new Map();
  for (const scope of scopes) {
    assertScope(scope);
    const days = [scope.day_utc];
    if (scope.identity.pollutant_code !== 'no2') {
      // Complete UTC day replacement can influence endpoints on the next day.
      days.push(new Date(Date.parse(`${scope.day_utc}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    }
    for (const d of days) {
      const m = d.slice(0, 7);
      result.set(monthKey(scope.identity, m), { identity: scope.identity, month_utc: m });
    }
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
export function assertReceipt(value) {
  fields(value, ['schema_version', 'kind', 'change_id', 'writer', 'source', 'scopes',
    'affected_months', 'rolling_aqi', 'bundle', 'verification', 'durability'], [2, 3].includes(value.schema_version) ? ['origin'] : []);
  requireValid([1, 2, 3].includes(value.schema_version) && value.kind === 'uk_aq_jsongen_verified_change', 'receipt schema/kind mismatch');
  requireValid(changeId(value.change_id), 'invalid stable change ID');
  fields(value.writer, ['identity', 'invocation_id'], [2, 3].includes(value.schema_version) ? ['attempt_id', 'git_sha'] : []);
  requireValid(text(value.writer.identity) && text(value.writer.invocation_id), 'writer invocation required');
  assertSource(value.source);
  requireValid(Array.isArray(value.scopes) && value.scopes.length > 0, 'complete replacement scopes required');
  value.scopes.forEach(assertScope);
  requireValid(new Set(value.scopes.map(scopeKey)).size === value.scopes.length, 'duplicate replacement scope');
  requireValid(same(value.affected_months, affectedMonths(value.scopes)), 'affected month/context set mismatch');
  const pm = value.scopes.some((s) => s.identity.pollutant_code !== 'no2');
  requireValid(same(value.rolling_aqi, { algorithm_version: ALGORITHM,
    preceding_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
    following_hours: pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0,
    minimum_valid_hours: pm ? DAQI_PM_ROLLING24H_REQUIRED_HOURS : 1 }), 'rolling dependency mismatch');
  fields(value.bundle, ['schema_version', 'format', 'change_id', 'object', 'scope_count', 'row_count']);
  requireValid(value.bundle.schema_version === 1 && value.bundle.format === 'complete_scope_ndjson_gzip'
    && value.bundle.change_id === value.change_id && value.bundle.scope_count === value.scopes.length && integer(value.bundle.row_count)
    && value.bundle.row_count === value.scopes.reduce((n, s) => n + s.after.row_count, 0), 'bundle scope/count mismatch');
  assertReference(value.bundle.object, { managed: true, gzip: true });
  requireValid(value.bundle.object.key === `${ROOT}/bundles/${value.bundle.object.sha256}.ndjson.gz`, 'bundle must be immutable');
  fields(value.verification, ['state', 'authority', 'provenance_authority', 'scope_completeness_authority']);
  requireValid(value.verification.state === 'canonical_final_verified', 'provisional changes are ineligible');
  assertReference(value.verification.authority);
  if (value.schema_version === 1) for (const field of ['provenance_authority', 'scope_completeness_authority']) assertReference(value.verification[field]);
  fields(value.durability, ['state', 'retained_receipt_authority']);
  requireValid(value.durability.state === 'verified_pending', 'immutable receipt must describe verified pending handoff');
  if (value.schema_version === 1) assertReference(value.durability.retained_receipt_authority);
  else {
    if (value.schema_version === 2) assertPruneReceiptOrigin(value);
    else assertSelectedReceiptOrigin(value);
    for (const authority of [value.verification.provenance_authority, value.verification.scope_completeness_authority,
      value.durability.retained_receipt_authority]) requireValid(same(authority, value.origin.authority),
    'original PostgreSQL authority must not be substituted by an R2 reference');
  }
  return value;
}

// Version 2 preserves Stage 1 rows/scopes/bundles. Only original gate/provenance
// authority is typed PostgreSQL evidence, never a fabricated R2 object or copy.
export function assertPruneAcceptanceAuthority(a) {
  fields(a, ['schema_version', 'kind', 'relation', 'key', 'event_id', 'writer_git_sha',
    'final_evidence_sha256', 'final_evidence_byte_size', 'post_commit_reference_sha256']);
  fields(a.key, ['environment', 'writer_identity', 'run_id', 'attempt_id', 'day_utc', 'connector_id']);
  requireValid(a.schema_version === 1 && a.kind === 'uk_aq_jsongen_prune_acceptance_authority'
    && a.relation === 'uk_aq_ops.prune_jsongen_gate_acceptance_outbox'
    && isEnvironmentName(a.key.environment) && a.key.writer_identity === 'prune_daily_v3' && a.key.connector_id === 1
    && uuid(a.key.run_id) && a.key.attempt_id === a.key.run_id && day(a.key.day_utc)
    && a.event_id === digest(a.key) && /^[a-f0-9]{40}$/.test(a.writer_git_sha)
    && sha(a.final_evidence_sha256) && id(a.final_evidence_byte_size) && a.final_evidence_byte_size <= 1024 ** 2
    && sha(a.post_commit_reference_sha256), 'invalid original PostgreSQL acceptance authority');
  return a;
}
export function pruneScopeCoverage(scopes) {
  return digest([...scopes].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b))));
}
export function pruneGroupDigest(origin) {
  const { partition_index: _index, group_sha256: _hash, ...group } = origin;
  return digest(group);
}
function assertPruneReceiptOrigin(receipt) {
  const o = receipt.origin;
  fields(o, ['authority', 'pending_source', 'source_identity', 'source_status', 'global_lock',
    'coverage_sha256', 'partition_index', 'partitions', 'scope_count', 'row_count', 'group_sha256']);
  assertPruneAcceptanceAuthority(o.authority); assertReference(o.pending_source, { managed: true, gzip: true });
  fields(o.source_identity, ['source_content_hash', 'source_content_hash_contract_version', 'source_content_hash_row_count']);
  requireValid(sha(o.source_identity.source_content_hash) && o.source_identity.source_content_hash_contract_version === 1
    && o.source_identity.source_content_hash_row_count === o.row_count && id(o.row_count) && o.row_count <= 100000,
  'invalid original frozen source identity');
  requireValid(o.source_status?.schema_version === 1 && o.source_status.classification === 'original_source_status_unavailable'
    && o.source_status.source_status === null && o.source_status.null_meaning === 'no_original_provider_status_asserted',
  'original AURN provider status must remain explicitly unavailable');
  fields(o.source_status, ['schema_version', 'classification', 'source_boundary', 'source_status', 'null_meaning']);
  requireValid(o.source_status.source_boundary === 'uk_aq_phase_b_history_compact_rows_v1.status', 'unrecognized original source-status boundary');
  fields(o.global_lock, ['logical_identity', 'owner', 'run_id']);
  requireValid(same(o.global_lock, { logical_identity: 'uk_aq:r2_history:v2:observations_global_operation',
    owner: 'prune_daily', run_id: o.authority.key.run_id }), 'original global lock identity mismatch');
  requireValid(receipt.writer.identity === 'prune_daily_v3' && receipt.writer.invocation_id === o.authority.key.run_id
    && receipt.writer.attempt_id === o.authority.key.attempt_id && receipt.writer.git_sha === o.authority.writer_git_sha
    && receipt.scopes.length <= 128 && receipt.scopes.every(s => s.identity.connector_id === 1
      && s.day_utc === o.authority.key.day_utc && s.before.state === 'authoritative_empty' && s.after.state === 'present'),
  'version-2 receipts require authenticated original AURN first publication');
  requireValid(id(o.scope_count) && o.scope_count <= 1024 && sha(o.coverage_sha256)
    && Array.isArray(o.partitions) && o.partitions.length > 0 && o.partitions.length <= 32
    && integer(o.partition_index) && o.partition_index < o.partitions.length
    && new Set(o.partitions.map(p => p.change_id)).size === o.partitions.length, 'invalid complete original partition set');
  for (const p of o.partitions) {
    fields(p, ['change_id', 'scope_count', 'row_count', 'coverage_sha256', 'bundle_sha256']);
    requireValid(changeId(p.change_id) && id(p.scope_count) && p.scope_count <= 128
      && id(p.row_count) && p.row_count <= 100000 && sha(p.coverage_sha256) && sha(p.bundle_sha256), 'invalid original partition identity');
  }
  const p = o.partitions[o.partition_index];
  requireValid(p.change_id === receipt.change_id && p.scope_count === receipt.scopes.length
    && p.row_count === receipt.bundle.row_count && p.coverage_sha256 === pruneScopeCoverage(receipt.scopes)
    && p.bundle_sha256 === receipt.bundle.object.sha256
    && o.partitions.reduce((n, p) => n + p.scope_count, 0) === o.scope_count
    && o.partitions.reduce((n, p) => n + p.row_count, 0) === o.row_count
    && o.group_sha256 === pruneGroupDigest(o), 'receipt partition/group coverage mismatch');
}
export function assertPruneReceiptGroup(receipts) {
  requireValid(Array.isArray(receipts) && receipts.length > 0 && receipts.length <= 32, 'complete original event receipts required');
  receipts.forEach(assertReceipt);
  const ordered = [...receipts].sort((a, b) => a.origin?.partition_index - b.origin?.partition_index);
  const origin = ordered[0].origin;
  requireValid(ordered.every((r, i) => r.schema_version === 2 && r.origin.partition_index === i
    && r.origin.group_sha256 === origin.group_sha256 && same(r.origin.authority, origin.authority))
    && ordered.length === origin.partitions.length, 'missing, duplicate or conflicting original event partition');
  const scopes = ordered.flatMap(r => r.scopes);
  requireValid(new Set(scopes.map(scopeKey)).size === origin.scope_count && scopes.length === origin.scope_count
    && pruneScopeCoverage(scopes) === origin.coverage_sha256
    && ordered.reduce((n, r) => n + r.bundle.row_count, 0) === origin.row_count,
  'incomplete whole-connector-day registration');
  return ordered;
}
// One NDJSON record per complete UTC-day scope. Validate without normalising,
// rounding, sorting, deduplicating, filling hours or dropping null row stations.
export function assertBundleRecord(value, scope) {
  assertScope(scope);
  fields(value, ['identity', 'day_utc', 'state', 'rows']);
  requireValid(same(value.identity, scope.identity) && value.day_utc === scope.day_utc
    && value.state === scope.after.state && Array.isArray(value.rows)
    && value.rows.length === scope.after.row_count, 'bundle record does not replace complete declared scope');
  for (const row of value.rows) {
    fields(row, ['connector_id', 'timeseries_id', 'station_id', 'pollutant_code',
      'observed_at_utc', 'value', 'source_status', 'verification_status']);
    requireValid(row.connector_id === scope.identity.connector_id && row.timeseries_id === scope.identity.timeseries_id
      && row.pollutant_code === scope.identity.pollutant_code && (row.station_id === null || row.station_id === scope.identity.station_id)
      && instant(row.observed_at_utc) && row.observed_at_utc.slice(0, 10) === scope.day_utc
      && typeof row.value === 'number' && Number.isFinite(row.value)
      && (row.source_status === null || typeof row.source_status === 'string')
      && [null, 'P', 'R'].includes(row.verification_status), 'invalid original observation row');
  }
  return value;
}
export function assertBundleRecords(records, receipt) {
  assertReceipt(receipt);
  requireValid(Array.isArray(records) && records.length === receipt.scopes.length, 'missing replacement scope');
  const expected = new Map(receipt.scopes.map((scope) => [scopeKey(scope), scope]));
  for (const record of records) {
    const k = scopeKey(record);
    const scope = expected.get(k);
    requireValid(scope, 'duplicate or undeclared replacement scope');
    assertBundleRecord(record, scope);
    expected.delete(k);
  }
  requireValid(expected.size === 0, 'incomplete replacement bundle');
  return records;
}
export function assertFailure(value) {
  fields(value, ['code', 'state', 'at_utc', 'detail']);
  requireValid(FAILURE_CODES.includes(value.code) && ['failed_retryable', 'superseded', 'reconcile_required'].includes(value.state)
    && instant(value.at_utc) && text(value.detail), 'invalid failure state');
  return value;
}
function coverage(value) {
  fields(value, ['authority_complete', 'observations_complete', 'aqi_complete', 'row_count', 'missing_hour_count', 'reasons']);
  requireValid(value.authority_complete === true && typeof value.observations_complete === 'boolean'
    && typeof value.aqi_complete === 'boolean' && integer(value.row_count) && integer(value.missing_hour_count)
    && Array.isArray(value.reasons) && value.reasons.every(text), 'invalid coverage/completeness');
  requireValid((value.observations_complete && value.aqi_complete) || value.reasons.length > 0, 'incomplete coverage needs reasons');
}
export function assertPublication(value) {
  fields(value, ['schema_version', 'kind', 'pub_id', 'identity', 'month_utc', 'source',
    'applied_change_ids', 'algorithm_version', 'context', 'coverage', 'observations', 'aqi', 'evidence']);
  header(value, 'monthly_publication');
  requireValid(uuid(value.pub_id) && month(value.month_utc), 'UUIDv4 pubID/month required');
  assertIdentity(value.identity); assertSource(value.source); ids(value.applied_change_ids);
  requireValid(!value.applied_change_ids.includes(value.pub_id), 'pubID must be separate from verified change IDs');
  requireValid(value.algorithm_version === ALGORITHM, 'AQI algorithm mismatch');
  coverage(value.coverage);
  const prefix = publicationPrefix(value.identity, value.month_utc, value.pub_id);
  for (const product of ['observations', 'aqi']) {
    const descriptor = value[product];
    fields(descriptor, ['pub_id', 'object']);
    requireValid(descriptor.pub_id === value.pub_id, 'mismatched monthly pair');
    assertReference(descriptor.object, { managed: true, gzip: true });
    requireValid(descriptor.object.key === `${prefix}/${product}.${descriptor.object.sha256}.json.gz`, 'invalid immutable product key');
  }
  assertReference(value.evidence, { managed: true });
  requireValid(value.evidence.key === `${ROOT}/evidence/${value.evidence.sha256}.json`, 'immutable publication evidence required');
  requireValid(Array.isArray(value.context), 'context must be explicit');
  if (value.identity.pollutant_code === 'no2') requireValid(value.context.length === 0, 'NO2 has no rolling context');
  else {
    requireValid(value.context.length === 1, 'authenticated preceding-month PM context required');
    const c = value.context[0];
    fields(c, ['identity', 'month_utc', 'pub_id', 'manifest', 'observations', 'applied_change_ids', 'start_utc', 'end_exclusive_utc']);
    const start = Date.parse(`${value.month_utc}-01T00:00:00.000Z`);
    requireValid(same(c.identity, value.identity) && uuid(c.pub_id)
      && c.month_utc === new Date(start - 1).toISOString().slice(0, 7)
      && c.start_utc === new Date(start - 23 * 3600000).toISOString()
      && c.end_exclusive_utc === new Date(start).toISOString(), 'PM preceding 23-hour context mismatch');
    assertManifestReference(c.manifest); assertReference(c.observations, { managed: true, gzip: true }); ids(c.applied_change_ids);
    requireValid(c.observations.key === `${publicationPrefix(c.identity, c.month_utc, c.pub_id)}/observations.${c.observations.sha256}.json.gz`, 'context publication identity mismatch');
  }
  return value;
}
export function assertManifestReference(value) {
  assertReference(value, { managed: true });
  requireValid(value.key === `${ROOT}/manifests/${value.sha256}.json`, 'immutable manifest reference required');
}
export function createControl({ now = new Date().toISOString() } = {}) {
  return assertControl({ schema_version: 1, kind: 'uk_aq_jsongen_control', control_key: CONTROL_KEY,
    control_id: randomUUID(), revision: 0, operation_id: randomUUID(), previous: null, updated_at_utc: now,
    ordering: { state: 'unresolved', reason: ORDERING_BLOCKER }, registered_changes: {}, months: {},
    freshness: { state: 'unknown', source_as_of: null }, failure: null });
}
export function assertControl(value) {
  fields(value, ['schema_version', 'kind', 'control_key', 'control_id', 'revision', 'operation_id',
    'previous', 'updated_at_utc', 'ordering', 'registered_changes', 'months', 'freshness', 'failure'],
  value.schema_version === 2 ? ['authenticated_events'] : []);
  requireValid([1, 2].includes(value.schema_version) && value.kind === 'uk_aq_jsongen_control', 'control schema/kind mismatch');
  if (value.schema_version === 2) requireValid(Object.hasOwn(value, 'authenticated_events'), 'control-v2 event map required');
  requireValid(value.control_key === CONTROL_KEY && uuid(value.control_id) && uuid(value.operation_id)
    && integer(value.revision) && instant(value.updated_at_utc), 'invalid control identity');
  if (value.revision === 0) requireValid(value.previous === null, 'initial control has no predecessor');
  else {
    fields(value.previous, ['revision', 'operation_id', 'sha256']);
    requireValid(value.previous.revision === value.revision - 1 && uuid(value.previous.operation_id)
      && value.previous.operation_id !== value.operation_id && sha(value.previous.sha256), 'invalid revision evidence');
  }
  requireValid(same(value.ordering, { state: 'unresolved', reason: ORDERING_BLOCKER }), 'canonical scope precedence and receipt coverage are not yet authenticated');
  fields(value.freshness, ['state', 'source_as_of']);
  requireValid(['unknown', 'pending', 'reconcile_required'].includes(value.freshness.state), 'absolute currentness is not established');
  if (value.freshness.source_as_of !== null) assertSource(value.freshness.source_as_of);
  if (value.failure !== null) assertFailure(value.failure);
  requireValid(object(value.registered_changes) && object(value.months), 'invalid control maps');
  const expected = new Map();
  for (const [eventId, entry] of Object.entries(value.registered_changes)) {
    fields(entry, ['receipt', 'receipt_object', 'registered_at_utc', 'state', 'ordering_state', 'authentication_state']);
    assertReceipt(entry.receipt); assertReference(entry.receipt_object, { managed: true });
    requireValid(entry.receipt_object.sha256 === digest(entry.receipt)
      && entry.receipt_object.byte_size === canonicalJson(entry.receipt).length, 'receipt evidence mismatch');
    requireValid(eventId === entry.receipt.change_id && instant(entry.registered_at_utc)
      && LIFECYCLE_STATES.includes(entry.state) && entry.state !== 'selected'
      && entry.ordering_state === 'unresolved' && entry.authentication_state === ([2, 3].includes(entry.receipt.schema_version)
        ? 'original_prune_event_authenticated' : 'pending_writer_adapter'), 'invalid unresolved-scope registered change');
    requireValid(entry.receipt_object.key === `${ROOT}/receipts/${entry.receipt_object.sha256}.json`, 'immutable receipt reference required');
    for (const m of entry.receipt.affected_months) {
      const k = monthKey(m.identity, m.month_utc);
      if (!expected.has(k)) expected.set(k, []);
      expected.get(k).push(eventId);
    }
  }
  const groups = new Map();
  for (const entry of Object.values(value.registered_changes)) if (entry.receipt.schema_version === 2) {
    const id = entry.receipt.origin.authority.event_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry.receipt);
  }
  for (const receipts of groups.values()) assertPruneReceiptGroup(receipts);
  if (value.schema_version === 2) assertSelectedControlEvents(value);
  else requireValid(Object.values(value.registered_changes).every(e => e.receipt.schema_version !== 3),
    'selected receipts require control v2');
  for (const [k, entry] of Object.entries(value.months)) {
    fields(entry, ['identity', 'month_utc', 'desired_change_ids', 'applied_change_ids', 'selected', 'state', 'failure']);
    requireValid(k === monthKey(entry.identity, entry.month_utc), 'month map identity mismatch');
    ids(entry.desired_change_ids); ids(entry.applied_change_ids);
    requireValid(same(entry.desired_change_ids, (expected.get(k) || []).sort()), 'registered desired changes dropped or invented');
    requireValid(entry.applied_change_ids.every((x) => entry.desired_change_ids.includes(x)), 'unknown applied change');
    requireValid(['pending', 'failed_retryable', 'reconcile_required'].includes(entry.state), 'invalid month state');
    if (entry.failure !== null) assertFailure(entry.failure);
    if (entry.selected !== null) {
      fields(entry.selected, ['manifest', 'publication']);
      assertManifestReference(entry.selected.manifest); assertPublication(entry.selected.publication);
      requireValid(entry.selected.manifest.sha256 === digest(entry.selected.publication)
        && entry.selected.manifest.byte_size === canonicalJson(entry.selected.publication).length, 'selected manifest evidence mismatch');
      requireValid(same(entry.selected.publication.identity, entry.identity) && entry.selected.publication.month_utc === entry.month_utc
        && same(entry.selected.publication.applied_change_ids, entry.applied_change_ids), 'selected dependency/identity mismatch');
    } else requireValid(entry.applied_change_ids.length === 0, 'applied dependencies without selection');
  }
  requireValid([...expected.keys()].every((k) => Object.hasOwn(value.months, k)), 'affected month omitted');
  return value;
}
