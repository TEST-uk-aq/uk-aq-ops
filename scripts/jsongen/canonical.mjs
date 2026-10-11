// Read-only, bounded inspection of the committed v2 observation hierarchy and
// selected v3 scoped metadata. This is metadata evidence, not a locked snapshot.
import { TextDecoder } from 'node:util';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { validateR2HistoryV2ObservationsAggregateManifest,
  serializeR2HistoryV2ObservationsAggregateManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifestKey,
  buildR2HistoryV2ObservationsMonthManifestKey } from '../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs';
import { validateCanonicalHistoryV2Manifest } from '../../workers/shared/uk_aq_r2_history_manifest_validation.mjs';
import { buildObservationHistoryV3ScopedManifestReadKey } from '../../workers/shared/uk_aq_observation_history_reader_v3.mjs';
import { validateObservationHistoryIndexV3ScopedManifestBody } from '../../workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs';
import { getObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { readObservationHistoryExactLeafDailyMetadataV3 } from '../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs';
import { encodeObservationHistoryIndexV3Json } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION, OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID, OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION }
  from '../../workers/shared/uk_aq_observation_history_target_writer.mjs';
import { assertScope, assertReference, requireValid } from './schema.mjs';
import { readBoundedObject } from './inputs.mjs';

export const CANONICAL_LIMITS = Object.freeze({ metadata_bytes: 2 * 1024 * 1024,
  max_gets: 24, max_elapsed_ms: 60_000 });
const decoder = new TextDecoder('utf-8', { fatal: true });
const IDX = 'history/_index_v3/observations_timeseries';
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exactIdentity(actual, expected) {
  requireValid(actual?.key === expected.key && actual?.byte_size === expected.byte_size
    && actual?.sha256 === expected.sha256, 'exact index object identity mismatch');
}

function child(parent, alias, field, value, expectedKey) {
  const left = parent.child_manifests;
  const right = parent[alias];
  requireValid(Array.isArray(left) && Array.isArray(right)
    && JSON.stringify(left) === JSON.stringify(right), 'canonical child aliases disagree');
  const seen = new Set();
  for (const item of left) {
    requireValid(item && !seen.has(item[field]), 'duplicate canonical child');
    seen.add(item[field]);
    requireValid(typeof item.manifest_key === 'string' && /^[a-f0-9]{64}$/.test(item.manifest_hash),
      'incomplete canonical child reference');
  }
  const item = left.find((x) => x[field] === value);
  if (item) requireValid(item.manifest_key === expectedKey, 'non-canonical child path');
  return item ?? null;
}

export async function inspectCanonicalScope({ r2, scope, observationsRoot,
  selectedGeneration, observationsPrefix = null, indexRoot = IDX }) {
  const pinned = new Map();
  let prefix;
  let gets = 0;
  const started = Date.now();
  const read = async (key) => {
    requireValid(++gets <= CANONICAL_LIMITS.max_gets
      && Date.now() - started <= CANONICAL_LIMITS.max_elapsed_ms, 'canonical inspection budget exceeded');
    const body = await readBoundedObject({ r2, key, expectedBucket: observationsRoot.bucket,
      maxBytes: CANONICAL_LIMITS.metadata_bytes });
    const digest = sha256Hex(body);
    if (pinned.has(key)) requireValid(pinned.get(key) === digest, 'canonical metadata changed during inspection');
    else pinned.set(key, digest);
    return { body, digest, json: JSON.parse(decoder.decode(body)) };
  };
  const recheck = async () => { for (const key of [...pinned.keys()]) await read(key); };
  const aggregate = (object) => {
    const value = validateR2HistoryV2ObservationsAggregateManifest(object.json,
      { basePrefix: prefix });
    requireValid(object.body.equals(serializeR2HistoryV2ObservationsAggregateManifest(value,
      { basePrefix: prefix })), 'non-canonical aggregate manifest bytes');
    return value;
  };
  const unresolved = (reason, extra = {}) => ({ state: 'unresolved', reason,
    metadata_gets: gets, ...extra });
  const absent = async (level, parentKey) => {
    await recheck();
    return { state: 'authoritative_absent', level, parent_key: parentKey,
      current_root_authenticated: true, selected_generation: selectedGeneration,
      metadata_gets: gets, binding_authority: 'unresolved',
      verification_authority: 'unresolved' };
  };
  try {
    assertScope(scope);
    assertReference(observationsRoot);
    requireValid(selectedGeneration === 'v2' || selectedGeneration === 'v3',
      'independently selected current canonical generation required');
    const selected = getObservationHistoryGeneration(selectedGeneration);
    requireValid(selected.observations_root_key === observationsRoot.key
      && (observationsPrefix === null
      || observationsPrefix === selected.observations_prefix) && indexRoot === IDX,
    'explicit validated canonical observations root and v3 index required');
    prefix = selected.observations_prefix;
    requireValid(observationsRoot?.bucket === r2?.bucket
      && observationsRoot.key === buildR2HistoryV2ObservationsRootManifestKey(prefix),
    'explicit canonical observations root required');
    const date = scope.day_utc;
    const year = Number(date.slice(0, 4));
    const month = date.slice(5, 7);
    const root = await read(observationsRoot.key);
    requireValid(root.body.length === observationsRoot.byte_size
      && root.digest === observationsRoot.sha256,
    'selected current root identity changed');
    const rootManifest = aggregate(root);
    requireValid(rootManifest.kind === 'uk_aq_observations_root_manifest', 'incorrect observations root kind');
    const yr = rootManifest.children.find((x) => x.year === year);
    if (!yr) return await absent('year', observationsRoot.key);
    const yearKey = buildR2HistoryV2ObservationsYearManifestKey(prefix, year);
    requireValid(yr.manifest_key === yearKey, 'root/year link mismatch');
    const yearObject = await read(yearKey);
    const yearManifest = aggregate(yearObject);
    requireValid(yearManifest.kind === 'uk_aq_observations_year_manifest'
      && yearManifest.year === year && yearManifest.content_hash === yr.content_hash, 'year authority mismatch');
    const mo = yearManifest.children.find((x) => x.month === month);
    if (!mo) return await absent('month', yearKey);
    const monthKey = buildR2HistoryV2ObservationsMonthManifestKey(prefix, year, month);
    requireValid(mo.manifest_key === monthKey, 'year/month link mismatch');
    const monthObject = await read(monthKey);
    const monthManifest = aggregate(monthObject);
    requireValid(monthManifest.kind === 'uk_aq_observations_month_manifest'
      && monthManifest.year === year && monthManifest.month === month
      && monthManifest.content_hash === mo.content_hash, 'month authority mismatch');
    const dy = monthManifest.children.find((x) => x.day_utc === date);
    if (!dy) return await absent('day', monthKey);
    const dayKey = `${prefix}/day_utc=${date}/manifest.json`;
    requireValid(dy.manifest_key === dayKey, 'month/day link mismatch');
    const day = await read(dayKey);
    validateCanonicalHistoryV2Manifest(day.json, { domain: 'observations', manifest_kind: 'day',
      day_utc: date, manifest_key: dayKey });
    requireValid(day.json.manifest_hash === dy.manifest_hash, 'day parent hash mismatch');
    const cid = scope.identity.connector_id;
    const connectorKey = `${prefix}/day_utc=${date}/connector_id=${cid}/manifest.json`;
    const cn = child(day.json, 'connector_manifests', 'connector_id', cid, connectorKey);
    if (!cn) return await absent('connector', dayKey);
    const connector = await read(connectorKey);
    validateCanonicalHistoryV2Manifest(connector.json, { domain: 'observations',
      manifest_kind: 'connector', day_utc: date, connector_id: cid, manifest_key: connectorKey });
    requireValid(connector.json.manifest_hash === cn.manifest_hash, 'connector parent hash mismatch');
    const pol = scope.identity.pollutant_code;
    const pollutantKey = `${prefix}/day_utc=${date}/connector_id=${cid}/pollutant_code=${pol}/manifest.json`;
    const pl = child(connector.json, 'pollutant_manifests', 'pollutant_code', pol, pollutantKey);
    if (!pl) return await absent('pollutant', connectorKey);
    const pollutant = await read(pollutantKey);
    validateCanonicalHistoryV2Manifest(pollutant.json, { domain: 'observations',
      manifest_kind: 'pollutant', day_utc: date, connector_id: cid,
      pollutant_code: pol, manifest_key: pollutantKey });
    requireValid(pollutant.json.manifest_hash === pl.manifest_hash, 'pollutant parent hash mismatch');
    const indexKey = buildObservationHistoryV3ScopedManifestReadKey({ dayUtc: date,
      connectorId: cid, pollutantCode: pol, indexRoot });
    let index;
    let scopeRows = null;
    if (selected.version === 'v3') {
      const nextDay = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();
      const metadata = await readObservationHistoryExactLeafDailyMetadataV3({
        source: { getIndexObject: async ({ key }) => {
          const value = await read(key);
          return { body: value.body, byte_size: value.body.length };
        } },
        timeseriesId: scope.identity.timeseries_id, connectorId: cid,
        pollutantCode: pol, startUtc: `${date}T00:00:00.000Z`, endUtc: nextDay,
        index: { root: IDX, alignedIndexRoot: `${IDX}/_aligned`, alignedDataRoot: prefix,
          indexGeneration: 'v3', historyVersion: 'v2',
          physicalLayoutVersion: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
          alignedRowCap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
          decodeProfileId: OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID,
          manifestKind: 'observation_timeseries_physical_leaf_scoped_manifest',
          leafKind: 'observation_timeseries_physical_leaf',
          additionalCommonFields: { exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION } },
      });
      requireValid(metadata.response_complete && metadata.rows.length === 1,
        'exact v3 timeseries membership is missing or incomplete');
      scopeRows = metadata.rows[0].row_count;
      index = await read(indexKey);
      requireValid(Buffer.from(encodeObservationHistoryIndexV3Json(index.json)).equals(index.body),
        'non-canonical exact scoped manifest bytes');
      const alignedRef = index.json.source_aligned_scoped_manifest;
      const alignedKey = `${IDX}/_aligned/day_utc=${date}/connector_id=${cid}/pollutant_code=${pol}/manifest.json`;
      requireValid(alignedRef?.key === alignedKey && sha(alignedRef.sha256),
        'exact scoped manifest lacks aligned parent identity');
      const aligned = await read(alignedKey);
      exactIdentity({ key: alignedKey, byte_size: aligned.body.length, sha256: aligned.digest }, alignedRef);
      requireValid(Buffer.from(encodeObservationHistoryIndexV3Json(aligned.json)).equals(aligned.body)
        && aligned.json.kind === 'observation_timeseries_aligned_source_manifest',
      'invalid aligned scoped manifest');
      const source = aligned.json.canonical_source_manifest;
      requireValid(source?.key === pollutantKey && source.sha256 === pollutant.digest
        && source.byte_size === pollutant.body.length
        && source.manifest_hash === pollutant.json.manifest_hash
        && source.row_count === pollutant.json.row_count
        && source.observation_content_hash === pollutant.json.observation_content_hash,
      'aligned v3 source disagrees with current canonical pollutant');
      const tuple = index.json.leaves_by_timeseries_id?.[String(scope.identity.timeseries_id)];
      requireValid(Array.isArray(tuple) && tuple.length === 3, 'exact timeseries leaf missing');
      const leaf = await read(tuple[0]);
      exactIdentity({ key: tuple[0], byte_size: leaf.body.length, sha256: leaf.digest },
        { key: tuple[0], byte_size: tuple[1], sha256: tuple[2] });
      requireValid(Buffer.from(encodeObservationHistoryIndexV3Json(leaf.json)).equals(leaf.body)
        && leaf.json.row_count === scopeRows, 'exact leaf row identity mismatch');
      const shardRef = leaf.json.source_aligned_child;
      const shardDescriptor = aligned.json.children?.find((entry) => entry.key === shardRef?.key);
      requireValid(shardDescriptor, 'exact leaf lacks aligned child parent');
      exactIdentity(shardRef, shardDescriptor);
      const shard = await read(shardRef.key);
      exactIdentity({ key: shardRef.key, byte_size: shard.body.length, sha256: shard.digest }, shardRef);
      requireValid(Buffer.from(encodeObservationHistoryIndexV3Json(shard.json)).equals(shard.body)
        && shard.json.kind === 'observation_timeseries_aligned_source_shard'
        && shard.json.canonical_source_manifest?.sha256 === pollutant.digest
        && shard.json.timeseries?.some((entry) => entry.timeseries_id === scope.identity.timeseries_id
          && entry.row_count === scopeRows), 'aligned shard contradicts exact leaf');
    } else {
      index = await read(indexKey);
      const payload = index.json;
      const validated = validateObservationHistoryIndexV3ScopedManifestBody({ key: indexKey,
        body: index.body, indexRoot, physicalIdentity: {
          history_schema_version: payload.history_schema_version,
          writer_version: payload.writer_version,
          physical_layout_version: payload.physical_layout_version } });
      requireValid(validated.source.key === pollutantKey
        && validated.source.sha256 === pollutant.digest
        && validated.source.manifest_hash === pollutant.json.manifest_hash
        && validated.source.row_count === pollutant.json.row_count
        && validated.source.observation_content_hash === pollutant.json.observation_content_hash
        && validated.coverage.timeseries_ids.includes(scope.identity.timeseries_id),
      'v3 scoped physical authority disagrees with canonical pollutant');
    }
    await recheck();
    return { state: 'present', metadata_gets: gets,
      current_root_authenticated: true, selected_generation: selectedGeneration,
      authority: { bucket: r2.bucket, key: pollutantKey, sha256: pollutant.digest,
        byte_size: pollutant.body.length, manifest_hash: pollutant.json.manifest_hash,
        observation_content_hash: pollutant.json.observation_content_hash,
        row_count: pollutant.json.row_count, scope_row_count: scopeRows },
      index: { key: indexKey, sha256: index.digest },
      binding_authority: 'unresolved', verification_authority: 'unresolved' };
  } catch (error) {
    return unresolved(error?.status === 404 ? 'required_canonical_child_missing_or_root_unavailable'
      : String(error?.message || error));
  }
}
