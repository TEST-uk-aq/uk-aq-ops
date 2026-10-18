// Transient, bounded copies of exact JSON metadata bytes already offered to the
// canonical writer. The writer's normal readback/finalization remains authority.
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const SHA = /^[0-9a-f]{64}$/;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_CAPTURE_OBJECTS = 4096;

export function createPruneOriginalMetadataCapture() {
  const bodies = new Map();
  let retainedBytes = 0;
  return {
    recordPublishedObject(value) {
      try {
        const key = value?.key;
        const body = value?.body;
        if (typeof key !== 'string' || !key.endsWith('.json') || body == null) return;
        const bytes = Buffer.from(body);
        if (!bytes.byteLength || (!bodies.has(key) && bodies.size >= MAX_CAPTURE_OBJECTS)) return;
        const previous = bodies.get(key);
        retainedBytes -= previous?.byteLength || 0;
        if (bytes.byteLength > MAX_OBJECT_BYTES || retainedBytes + bytes.byteLength > MAX_CAPTURE_BYTES) {
          bodies.delete(key);
          return;
        }
        bodies.set(key, bytes);
        retainedBytes += bytes.byteLength;
      } catch {
        // Optional evidence capture cannot change a canonical PUT result.
      }
    },
    body(key) { return bodies.get(key) || null; },
  };
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
