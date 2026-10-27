// Authenticated historical reconstruction from one explicitly pinned backup.
import { requireValid as check, same } from '../schema.mjs';
import { GENERATION as g, CHECKPOINT_KEY, parseJson } from './dropbox-reader.mjs';
import { assertSha256, validateHierarchicalStateRoot, assertSelectedBackupState,
  validateObservationMonthState, stateMonthEntry, validateVerificationInventory,
  VERIFICATION_LATEST_PATH } from '../../backup_r2/lib/hierarchical_backup_v2.mjs';
import { normalizeTimeseriesBindingPackRootState, validateTimeseriesBindingPackRangeState,
  timeseriesBindingPackRangeStateShardKey } from '../../backup_r2/lib/hierarchical_timeseries_binding_pack_sync_v1.mjs';
import { validateTimeseriesBindingBackupPackRootV1, validateTimeseriesBindingBackupPackV1,
  serializeTimeseriesBindingBackupPackV1 } from '../../backup_r2/lib/timeseries_binding_backup_pack_v1.mjs';
import { buildTimeseriesBindingSourceRangeManifest, buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey } from '../../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { OBSERVATIONS_AGGREGATE_MANIFEST_KINDS,
  validateR2HistoryV2ObservationsAggregateManifest } from '../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { assertV2ObservationsChildManifest } from '../../backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs';
import { classifyManifestFileIdentity } from '../../../workers/shared/uk_aq_r2_file_identity.mjs';
import { loadObservationVerificationAuthority, validateObservationVerificationLatest } from '../../../workers/shared/uk_aq_observation_verification_overlay.mjs';
import { selectVerificationStatusAuthority } from '../authority.mjs';
import { validateTimeseriesBinding } from '../../../workers/uk_aq_station_history/src/continuity.mjs';

const identity = ref => ({ sha256: ref.sha256, byte_size: ref.byte_size });
function unique(values, label) { check(new Set(values).size === values.length, `duplicate ${label}`); }
function childEntry(parent, childId, parentKey, kind) {
  const alias = kind === 'connector' ? 'connector_manifests' : 'pollutant_manifests';
  check(Array.isArray(parent[alias]) && same(parent[alias], parent.child_manifests), 'contradictory canonical child aliases');
  const idField = kind === 'connector' ? 'connector_id' : 'pollutant_code';
  const entries = parent.child_manifests;
  unique(entries.map(c => c[idField]), 'canonical children');
  for (const child of entries) {
    const id = child[idField];
    check(kind === 'connector' ? Number.isSafeInteger(id) && id > 0 : /^[a-z0-9_]+$/.test(id), 'invalid canonical child identity');
    check(child.manifest_key === `${parentKey.slice(0, -14)}/${idField}=${id}/manifest.json`, 'canonical child path mismatch');
    assertSha256(child.manifest_hash, 'child manifest hash');
  }
  if (kind === 'connector') check(same(parent.connector_ids, entries.map(c => c.connector_id)), 'connector membership aliases disagree');
  else check(same([...parent.pollutant_codes].sort(), entries.map(c => c.pollutant_code).sort()), 'pollutant membership aliases disagree');
  return entries.find(c => c[idField] === childId) || null;
}

export async function openBackupSource(reader, options) {
  const checkpoint = await reader.read(CHECKPOINT_KEY, { expected: { sha256: options.checkpointSha256 } });
  const state = assertSelectedBackupState(g, validateHierarchicalStateRoot(
    parseJson(checkpoint.body, CHECKPOINT_KEY), g.backup_state_prefix, g));
  check(state.observations.processed_source_root_hash === options.observationsRoot,
    'completed checkpoint processed observation root differs from selected identity');
  const root = await aggregate(g.observations_root_key, options.observationsRoot);
  unique(state.observations.years.map(y => y.year), 'checkpoint years');
  check(root.children.length === state.observations.years.length && root.children.every(c =>
    state.observations.years.some(y => Number(y.year) === c.year && y.processed_source_year_hash === c.content_hash)),
  'checkpoint observation years are incomplete or contradict canonical root');
  const packState = normalizeTimeseriesBindingPackRootState(state);
  check(packState.verified && packState.pack_root_relative_path === `${g.timeseries_binding_pack_prefix}/root.json`,
    'completed v3 binding pack checkpoint required');
  const packRoot = validateTimeseriesBindingBackupPackRootV1(await reader.json(packState.pack_root_relative_path,
    { expected: { sha256: packState.processed_pack_root_sha256, byte_size: packState.pack_root_size } }),
  { packPrefix: g.timeseries_binding_pack_prefix });
  check(packRoot.source_prefix === g.timeseries_binding_index_prefix
    && packRoot.source_root_hash === packState.processed_source_root_hash, 'v3 binding authority mismatch');
  const reconstructedRoot = buildTimeseriesBindingSourceRootManifest({ bindingPrefix: packRoot.source_prefix,
    ranges: packRoot.ranges.map(r => ({ ...r, unit_count: r.member_count,
      manifest_key: timeseriesBindingSourceRangeManifestKey(packRoot.source_prefix, r.range_start, r.range_end) })) });
  check(reconstructedRoot.source_root_hash === packRoot.source_root_hash, 'packed binding source-root membership mismatch');
  check(packRoot.ranges.length === packState.ranges.length, 'incomplete packed checkpoint range set');
  for (const r of packRoot.ranges) check(packState.ranges.some(s =>
    s.range_start === r.range_start && s.range_end === r.range_end && s.processed_source_range_hash === r.source_range_hash
    && s.pack_relative_path === r.pack_relative_path && s.pack_sha256 === r.pack_sha256
    && s.pack_size === r.pack_size && s.member_count === r.member_count), 'pack root/checkpoint disagreement');
  const bindings = new Map(), memberEvidence = new Map(), authorities = new Map(), months = new Map();
  const monthDetails = new Map(), yearManifests = new Map();
  // One bounded range cache. All source bodies are also on disk, so moving
  // between ranges never causes another Dropbox download of an existing pack.
  let cachedRange = null;
  const verification = state.verification;
  let verificationInventory = null, latest = null;
  if (verification) {
    check(verification.processed_source_root_hash && verification.latest?.verified
      && verification.latest.copied_at && verification.connector_manifests.every(c => c.verified && c.copied_at),
    'verification checkpoint incomplete');
    verificationInventory = validateVerificationInventory({ source_root_hash: verification.processed_source_root_hash,
      latest: verification.latest, connector_manifests: verification.connector_manifests });
    latest = validateObservationVerificationLatest(await reader.json(VERIFICATION_LATEST_PATH,
      { expected: identity(verificationInventory.latest) }));
    check(latest.connectors.length === verificationInventory.connector_manifests.length && latest.connectors.every(c =>
      verificationInventory.connector_manifests.some(ref => ref.connector_id === c.connector_id
        && ref.relative_path === c.key && ref.sha256 === c.sha256 && ref.byte_size === c.byte_size)),
    'verification latest/checkpoint membership mismatch');
  }
  async function aggregate(key, expectedHash) {
    const raw = await reader.json(key);
    const canonical = validateR2HistoryV2ObservationsAggregateManifest(raw, { basePrefix: g.observations_prefix });
    check(canonical.content_hash === expectedHash, `canonical aggregate identity mismatch: ${key}`);
    return canonical;
  }
  async function month(day) {
    const ym = day.slice(0, 7);
    if (months.has(ym)) return months.get(ym);
    const yearRef = root.children.find(c => c.year === Number(day.slice(0, 4)));
    if (!yearRef) {
      months.set(ym, null);
      monthDetails.set(ym, { manifest: null, year_reference: null, year_manifest: null,
        month_reference: null, state_entry: stateMonthEntry(state, day.slice(0, 4), day.slice(5, 7)), state_shard: null });
      return null;
    }
    let year = yearManifests.get(yearRef.manifest_key);
    if (!year) {
      year = await aggregate(yearRef.manifest_key, yearRef.content_hash);
      check(year.kind === OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.year
        && year.year === Number(day.slice(0, 4)), `canonical year identity mismatch: ${yearRef.manifest_key}`);
      yearManifests.set(yearRef.manifest_key, year);
    }
    const monthRef = year.children.find(c => c.month === day.slice(5, 7));
    if (!monthRef) {
      months.set(ym, null);
      monthDetails.set(ym, { manifest: null, year_reference: yearRef, year_manifest: year,
        month_reference: null, state_entry: stateMonthEntry(state, day.slice(0, 4), day.slice(5, 7)), state_shard: null });
      return null;
    }
    const manifest = await aggregate(monthRef.manifest_key, monthRef.content_hash);
    check(manifest.kind === OBSERVATIONS_AGGREGATE_MANIFEST_KINDS.month
      && manifest.year === Number(day.slice(0, 4)) && manifest.month === day.slice(5, 7),
    `canonical month identity mismatch: ${monthRef.manifest_key}`);
    const summary = stateMonthEntry(state, day.slice(0, 4), day.slice(5, 7));
    check(summary?.processed_source_month_hash === manifest.content_hash && summary.state_shard_hash,
      `selected checkpoint month incomplete: ${ym}`);
    const key = `${g.backup_state_prefix}/observations/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}.json`;
    check(summary.state_shard_key === key, 'checkpoint month path mismatch');
    const shard = validateObservationMonthState(await reader.json(key, { expected: { sha256: summary.state_shard_hash } }),
      day.slice(0, 4), day.slice(5, 7));
    unique(shard.days.map(d => d.day_utc), 'checkpoint days');
    check(shard.processed_source_month_hash === manifest.content_hash && manifest.children.length === shard.days.length
      && manifest.children.every(c => shard.days.some(d => d.day_utc === c.day_utc && d.manifest_hash === c.manifest_hash && d.copied_at)),
    `checkpoint month child completion mismatch: ${ym}`);
    months.set(ym, manifest);
    monthDetails.set(ym, { manifest, year_reference: yearRef, year_manifest: year,
      month_reference: monthRef, state_entry: summary, state_shard: shard, state_shard_key: key });
    return manifest;
  }
  async function canonical(ref, { kind, day, connectorId = null }, parent = null) {
    const raw = await reader.json(ref.manifest_key);
    assertV2ObservationsChildManifest(raw, { key: ref.manifest_key, kind, dayUtc: day, connectorId });
    validateCanonicalHistoryV2Manifest(raw);
    check(raw.manifest_hash === ref.manifest_hash, 'canonical parent/child hash mismatch');
    unique(raw.files.map(f => f.key), 'canonical files');
    check(same([...raw.parquet_object_keys].sort(), raw.files.map(f => f.key).sort()), 'canonical file aliases disagree');
    if (parent) {
      for (const field of ['source_row_count', 'row_count', 'file_count', 'total_bytes'])
        check(ref[field] === raw[field], 'canonical child summary mismatch');
      const prefix = ref.manifest_key.slice(0, -13);
      check(same(parent.files.filter(f => f.key.startsWith(prefix)), raw.files), 'canonical parent/child files disagree');
    }
    return raw;
  }
  async function pollutant(day, connectorId, code) {
    const m = await month(day), dayRef = m?.children.find(c => c.day_utc === day);
    if (!dayRef) return null; // authenticated parent omission, never a failed GET
    const d = await canonical(dayRef, { kind: 'day', day });
    const connectorRef = childEntry(d, connectorId, dayRef.manifest_key, 'connector');
    if (!connectorRef) return null;
    const c = await canonical(connectorRef, { kind: 'connector', day, connectorId }, d);
    const pollutantRef = childEntry(c, code, connectorRef.manifest_key, 'pollutant');
    if (!pollutantRef) return null;
    const p = await canonical(pollutantRef, { kind: 'pollutant', day, connectorId }, c);
    check(p.pollutant_code === code && p.child_manifests.length === 0, 'pollutant manifest identity mismatch');
    check(p.files.reduce((n, f) => n + f.row_count, 0) === p.row_count, 'pollutant file row-count mismatch');
    if (p.timeseries_row_counts) check(Object.entries(p.timeseries_row_counts).every(([id, count]) =>
      /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && Number.isSafeInteger(count) && count > 0)
      && Object.values(p.timeseries_row_counts).reduce((sum, n) => sum + n, 0) === p.row_count,
    'canonical physical-series count metadata invalid');
    for (const file of p.files) {
      check(file.key.startsWith(`${g.observations_prefix}/day_utc=${day}/connector_id=${connectorId}/pollutant_code=${code}/`)
        && /^part-\d+\.parquet$/.test(file.key.split('/').at(-1))
        && Number.isSafeInteger(file.bytes) && file.bytes > 0 && Number.isSafeInteger(file.row_count) && file.row_count > 0,
      'canonical Parquet identity/scope invalid');
      const hash = classifyManifestFileIdentity(file.sha256 || file.etag_or_hash, { objectKey: file.key });
      check(hash.type === 'sha256', `backup lacks independently verifiable Parquet content SHA-256: ${file.key}`);
      if (file.sha256 && file.etag_or_hash && /^[a-f0-9]{64}$/.test(file.etag_or_hash))
        check(file.sha256 === file.etag_or_hash, 'conflicting canonical file SHA-256 identities');
    }
    return p;
  }
  async function binding(timeseriesId, connectorId, code) {
    if (bindings.has(timeseriesId)) {
      const b = bindings.get(timeseriesId);
      check((connectorId == null || b.connector_id === connectorId) && (code == null || b.pollutant_code === code), 'physical timeseries scope conflict');
      return b;
    }
    const ref = packRoot.ranges.find(r => timeseriesId >= r.range_start && timeseriesId <= r.range_end);
    check(ref, `physical binding absent from backed-up pack root: ${timeseriesId}`);
    if (cachedRange?.range_start !== ref.range_start) {
      const s = packState.ranges.find(r => r.range_start === ref.range_start);
      check(s.state_shard_key === timeseriesBindingPackRangeStateShardKey(g.backup_state_prefix, ref.range_start, ref.range_end),
        'binding pack state shard path mismatch');
      const shard = validateTimeseriesBindingPackRangeState(await reader.json(s.state_shard_key,
        { expected: { sha256: s.state_shard_hash } }), ref.range_start, ref.range_end);
      check(shard.verified && shard.processed_source_range_hash === ref.source_range_hash
        && shard.pack_relative_path === ref.pack_relative_path && shard.pack_sha256 === ref.pack_sha256
        && shard.pack_size === ref.pack_size && shard.member_count === ref.member_count, 'binding pack range checkpoint mismatch');
      const object = await reader.read(ref.pack_relative_path, { expected: { sha256: ref.pack_sha256, byte_size: ref.pack_size } });
      const raw = parseJson(object.body, ref.pack_relative_path);
      check(Array.isArray(raw.members), 'packed binding members unavailable');
      const range = buildTimeseriesBindingSourceRangeManifest({ bindingPrefix: g.timeseries_binding_index_prefix,
        rangeStart: ref.range_start, rangeEnd: ref.range_end,
        units: raw.members.map(m => ({ timeseries_id: m.timeseries_id, relative_path: m.relative_path,
          size: m.size, sha256: m.sha256, r2_md5: null })) });
      check(range.source_range_hash === ref.source_range_hash, 'packed binding source-range identity mismatch');
      cachedRange = validateTimeseriesBindingBackupPackV1(raw, range);
      check(serializeTimeseriesBindingBackupPackV1(cachedRange).bytes.equals(object.body), 'binding pack is not deterministic canonical JSON');
    }
    const member = cachedRange.members.find(m => m.timeseries_id === timeseriesId);
    check(member, `physical binding missing from authenticated pack: ${timeseriesId}`);
    const b = parseJson(Buffer.from(member.body_base64, 'base64'), member.relative_path);
    validateTimeseriesBinding(b, { timeseriesId, connectorId: connectorId ?? b.connector_id, pollutant: code ?? b.pollutant_code });
    check(!b.continuity, 'logical continuity requires a separately accepted bootstrap extension; select physical bindings');
    check(bindings.size < options.limits.series, 'invocation physical-series limit exceeded; select a smaller batch');
    bindings.set(timeseriesId, b);
    memberEvidence.set(timeseriesId, { key: member.relative_path, sha256: member.sha256, byte_size: member.size,
      pack_key: ref.pack_relative_path, pack_state_shard_key: s.state_shard_key,
      source_range_hash: ref.source_range_hash });
    return b;
  }
  async function authority(connectorId) {
    if (authorities.has(connectorId)) return authorities.get(connectorId);
    const mode = options.verificationModes[connectorId];
    check(mode, `explicit accepted verification mode required for connector ${connectorId}`);
    // No absent-pointer inference: pre-overlay is an explicit operator input,
    // recorded as a selected-backup assumption, never current R2 attestation.
    const bucket = { get: async key => {
      if (key === VERIFICATION_LATEST_PATH && !verificationInventory) return null;
      const ref = key === VERIFICATION_LATEST_PATH ? verificationInventory.latest
        : verificationInventory?.connector_manifests.find(c => c.relative_path === key);
      check(ref, 'verification object not authenticated by selected checkpoint');
      const object = await reader.read(key, { expected: identity(ref) });
      return { arrayBuffer: async () => Uint8Array.from(object.body).buffer };
    } };
    const a = await loadObservationVerificationAuthority({ bucket, connectorId });
    check(mode === 'overlay_accepted' ? a.overlay_authoritative : !a.overlay_authoritative,
      'operator verification mode contradicts selected backup');
    authorities.set(connectorId, a); return a;
  }
  async function observationMonthSnapshot(monthUtc, dayUts = []) {
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(monthUtc || ''), 'invalid selected observation month');
    const manifest = await month(`${monthUtc}-01`);
    const detail = monthDetails.get(monthUtc);
    check(detail, `selected Dropbox month ancestry was not captured: ${monthUtc}`);
    check(manifest || !detail.state_entry,
      `Dropbox checkpoint retains month state absent from its authenticated observations root: ${monthUtc}`);
    const refs = new Map((manifest?.children || []).map(child => [child.day_utc, child.manifest_hash]));
    const stateDays = new Map((detail.state_shard?.days || []).map(day => [day.day_utc, day]));
    const selectedDays = [...new Set(dayUts)].sort();
    for (const dayUtc of selectedDays) {
      check(dayUtc.startsWith(`${monthUtc}-`) && /^\d{4}-\d{2}-\d{2}$/.test(dayUtc),
        `selected day does not belong to Dropbox month ${monthUtc}`);
      const manifestHash = refs.get(dayUtc) || null;
      const stateDay = stateDays.get(dayUtc);
      check(Boolean(manifestHash) === Boolean(stateDay),
        `Dropbox month/day completion evidence contradicts membership: ${dayUtc}`);
      if (stateDay) check(stateDay.manifest_hash === manifestHash && stateDay.copied_at,
        `Dropbox day completion evidence mismatch: ${dayUtc}`);
    }
    const objectRef = key => key ? reader.inventory.get(key) || null : null;
    return {
      month_utc: monthUtc,
      processed_source_month_hash: detail.state_entry?.processed_source_month_hash || null,
      source_month_content_hash: manifest?.content_hash || null,
      month_manifest: objectRef(detail.month_reference?.manifest_key),
      year_manifest: objectRef(detail.year_reference?.manifest_key),
      observations_root_manifest: objectRef(g.observations_root_key),
      month_state_shard: objectRef(detail.state_shard_key),
      year_manifest_content_hash: detail.year_manifest?.content_hash || null,
      selected_days: selectedDays.map(dayUtc => ({ day_utc: dayUtc,
        state: refs.has(dayUtc) ? 'authenticated_membership' : 'authenticated_absence',
        manifest_hash: refs.get(dayUtc) || null,
        manifest_key: manifest?.children.find(child => child.day_utc === dayUtc)?.manifest_key || null,
        copied_at: stateDays.get(dayUtc)?.copied_at || null })),
    };
  }
  function assertStatusMode(physical, connectorId, a) {
    // Keep the managed inspector's transition validator intact and reuse it.
    const selected = selectVerificationStatusAuthority({ physicalIdentity: physical,
      acceptedMode: options.verificationModes[connectorId], selectedOverlay: a.overlay_authoritative });
    check(['embedded_status_requires_writer_evidence', 'overlay_metadata_verified'].includes(selected),
      'backed-up physical schema/verification authority unresolved');
    return selected;
  }
  return { pollutant, binding, authority, assertStatusMode, observationMonthSnapshot, bindings, memberEvidence, authorities,
    checkpoint: { key: CHECKPOINT_KEY, sha256: checkpoint.sha256, byte_size: checkpoint.byte_size,
      processed_observations_root_hash: options.observationsRoot,
      processed_verification_root_hash: verification?.processed_source_root_hash || null,
      processed_binding_root_hash: packRoot.source_root_hash },
    current_authority: 'not_established_offline_backup_reconstruction',
    verification_mode_provenance: 'explicit_operator_selected_backup_transition_mode_not_independent_current_acceptance' };
}
