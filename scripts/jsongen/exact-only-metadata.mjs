// Metadata authentication only. Never reads or decodes canonical Parquet.
import { same } from './schema.mjs';
import { evidence } from './limits.mjs';
import { exactLeafFormatV3 } from '../../workers/shared/uk_aq_observation_history_exact_leaf_format_v3.mjs';
import { exactCanonicalHashVersionV3 } from '../../workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs';
import { encodeObservationHistoryIndexV3Json as json,
  validateObservationHistoryExactLeafScopedManifestArtifactV3,
  validateObservationHistoryExactLeafArtifactV3 }
  from '../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs';

export const exactIdentity = o => ({ key: o.key, byte_size: o.byte_size, sha256: o.sha256 });
export function exactMetadataArtifact(object, record = 'manifest') {
  const payload = object.value;
  const body = object.body ?? Buffer.from(object.bytes_base64, 'base64');
  return { ...exactIdentity(object.reference ?? object), body: Buffer.from(body).toString('utf8'), payload,
    kind: record === 'manifest' ? 'observation_history_index_v3_exact_leaf_scoped_manifest' : 'observation_history_index_v3_exact_leaf',
    publication_stage: record === 'manifest' ? 'scoped_manifest' : 'child_shard',
    dependencies: record === 'manifest'
      ? [{ ...payload.canonical_source_manifest, kind: 'canonical_manifest' },
        ...Object.values(payload.leaves_by_timeseries_id).map(t => ({ key: t[0], byte_size: t[1], sha256: t[2], kind: 'child_shard' }))]
      : payload.files.map(f => ({ ...exactIdentity(f), kind: 'canonical_parquet' })),
    publication_prerequisites: record === 'manifest' ? []
      : [{ ...exactIdentity(object.canonicalSource), kind: 'canonical_manifest' }],
  };
}

// The complete selector and leaf set are required even for a bounded currentness
// inspection. Capacity failures are affected-scope blockers, never partial proof.
export function authenticateExactOnlyMetadata({ selector, leaves, canonical, canonicalReference, scope }) {
  const p = selector.payload;
  evidence(exactLeafFormatV3(p).schema_version === 2, 'invalid_canonical_metadata', 'Explicit exact-only selector required');
  validateObservationHistoryExactLeafScopedManifestArtifactV3({ artifact: selector, exactLeaves: leaves });
  const source = { ...exactIdentity(canonicalReference), manifest_hash: canonical.manifest_hash,
    row_count: canonical.row_count, observation_content_hash: canonical.observation_content_hash,
    observation_content_hash_version: exactCanonicalHashVersionV3(canonical) };
  evidence(canonical.history_schema_version === 3 && canonical.writer_version === 'parquet-wasm-zstd-v3'
    && source.observation_content_hash_version === 1
    && p.history_schema_version === 3 && p.writer_version === canonical.writer_version,
  'unsupported_exact_only_physical_identity', 'Exact-only authority supports physical schema 3 / writer v3 / hash v1 only');
  evidence(same(p.canonical_source_manifest, source)
    && ['day_utc', 'connector_id', 'pollutant_code'].every(k => p[k] === scope[k] && canonical[k] === scope[k])
    && p.coverage.row_count === canonical.row_count && p.coverage.physical_file_count === canonical.files.length
    && p.coverage.min_observed_at_utc === canonical.min_observed_at_utc
    && p.coverage.max_observed_at_utc === canonical.max_observed_at_utc,
  'invalid_canonical_metadata', 'Exact-only selector contradicts authenticated canonical source');
  const counts = {}, files = new Map(), perFile = new Map();
  for (const leaf of leaves) {
    validateObservationHistoryExactLeafArtifactV3({ artifact: leaf });
    counts[leaf.payload.timeseries_id] = leaf.payload.row_count;
    for (const f of leaf.payload.files) files.set(f.key, [f.key, f.byte_size, f.sha256, f.row_count]);
    for (const s of leaf.payload.segments) {
      const c = perFile.get(s.file_key) || {};
      c[s.timeseries_id] = (c[s.timeseries_id] || 0) + s.row_count; perFile.set(s.file_key, c);
    }
  }
  evidence(same(counts, canonical.timeseries_row_counts)
    && same([...files.values()].sort(), canonical.files.map(f => [f.key, f.bytes, f.etag_or_hash, f.row_count]).sort())
    && canonical.files.every(f => same(perFile.get(f.key), f.timeseries_row_counts)),
  'invalid_canonical_metadata', 'Exact-only complete file/physical membership contradicts canonical source');
  // Authenticate byte-stable serialization as well as semantic validators.
  for (const a of [selector, ...leaves]) evidence(Buffer.from(a.body).equals(Buffer.from(json(a.payload))),
    'invalid_canonical_metadata', 'Exact-only metadata encoding mismatch');
  return { source, physical_identity: { history_schema_version: p.history_schema_version,
    writer_version: p.writer_version, physical_layout_version: p.physical_layout_version,
    decode_profile_id: p.decode_profile.version } };
}
