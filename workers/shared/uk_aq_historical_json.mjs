// Derived chart delivery only. These keys never overlap managed JSONgen or canonical history.
export const HISTORY_JSON_PREFIX = 'manual/chart-history/v1';
export const HISTORY_JSON_ALGORITHM = 'aqilevels_hourly_v3';
export const HISTORY_JSON_MAX_MANIFEST_BYTES = 16 * 1024;
export const SHA256 = /^[a-f0-9]{64}$/;
export const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function check(condition, code) { if (!condition) throw new Error(code); }
export function monthBounds(month) {
  check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''), 'month_invalid');
  const start = `${month}-01T00:00:00.000Z`, date = new Date(start);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start_utc: start, end_utc: date.toISOString() };
}
export function validIdentity(id) {
  return ['connector_id', 'station_id', 'timeseries_id'].every(k => Number.isSafeInteger(id?.[k]) && id[k] > 0)
    && ['pm25', 'pm10', 'no2'].includes(id?.pollutant_code);
}
export function sameIdentity(a, b) {
  return validIdentity(a) && validIdentity(b)
    && ['connector_id', 'station_id', 'timeseries_id', 'pollutant_code'].every(k => a[k] === b[k]);
}
export function identityPath(id, month) {
  check(validIdentity(id), 'identity_invalid'); monthBounds(month);
  return `connector_id=${id.connector_id}/timeseries_id=${id.timeseries_id}/station_id=${id.station_id}/pollutant=${id.pollutant_code}/month_utc=${month}`;
}
export function selectionKey(id, month) { return `${HISTORY_JSON_PREFIX}/selections/${identityPath(id, month)}.json`; }
export function objectKey(manifest, kind) {
  check(['observations', 'aqi'].includes(kind), 'object_kind_invalid');
  return `${HISTORY_JSON_PREFIX}/publications/${identityPath(manifest.identity, manifest.month_utc)}/${manifest.pub_id}/${kind}.${manifest.objects[kind].sha256}.json.gz`;
}
export function validateSelection(m, expectedIdentity = m?.identity, expectedMonth = m?.month_utc) {
  check(m?.schema_version === 1 && m.kind === 'uk_aq_historical_json_pair_selection', 'selection_schema_invalid');
  check(sameIdentity(m.identity, expectedIdentity) && m.month_utc === expectedMonth, 'selection_identity_invalid');
  const bounds = monthBounds(m.month_utc);
  check(m.interval?.start_utc === bounds.start_utc && m.interval?.end_utc === bounds.end_utc, 'selection_period_invalid');
  check(UUID4.test(m.pub_id || '') && m.algorithm_version === HISTORY_JSON_ALGORITHM, 'selection_version_invalid');
  check(SHA256.test(m.source_id || '') && m.source?.generation === 'v3'
    && ['checkpoint_sha256', 'evidence_sha256', 'candidate_sha256', 'binding_sha256', 'verification_sha256', 'month_content_hash', 'terminal_manifest_hash']
      .every(k => SHA256.test(m.source[k] || '')), 'selection_source_invalid');
  check(m.source.edge_day_proofs && ['first','last','context'].every(k => Object.hasOwn(m.source.edge_day_proofs,k)
    && (m.source.edge_day_proofs[k] === null || SHA256.test(m.source.edge_day_proofs[k]))), 'selection_edge_proof_invalid');
  check(m.source.source_complete === true && m.source.terminal_complete === true && m.source.context_complete === true,
    'selection_source_incomplete');
  check(m.admission?.mode === 'manual_isolated_test' && m.admission.managed_publication_eligible === false
    && Array.isArray(m.admission.unresolved_managed_authority) && m.admission.readback_verified === true,
    'selection_admission_invalid');
  for (const kind of ['observations', 'aqi']) {
    const o = m.objects?.[kind];
    check(o && o.content_encoding === 'gzip' && o.content_type === 'application/json' && SHA256.test(o.sha256 || '') && SHA256.test(o.json_sha256 || '')
      && Number.isSafeInteger(o.byte_size) && o.byte_size > 0 && o.byte_size <= 8 * 1024 ** 2
      && Number.isSafeInteger(o.json_byte_size) && o.json_byte_size > 0 && o.json_byte_size <= 32 * 1024 ** 2
      && Number.isSafeInteger(o.row_count) && o.row_count >= 0
      && o.pub_id === m.pub_id && o.source_id === m.source_id && o.algorithm_version === m.algorithm_version,
    'selection_object_invalid');
  }
  check(typeof m.completeness?.observations === 'boolean'
    && ['daqi', 'eaqi'].every(k => typeof m.completeness?.[k]?.evaluated_complete === 'boolean'), 'selection_completeness_invalid');
  return m;
}
