// Consumer adaptation only. No publication/deletion/receipt authority is minted.
import { sha256Hex } from './r2_sigv4.mjs';
import { exactLeafFormatV3 } from './uk_aq_observation_history_exact_leaf_format_v3.mjs';
import { scopedRootDescriptor, encodeObservationHistoryIndexV3Json } from './uk_aq_observation_history_exact_leaf_index_v3.mjs';
import { verifyObservationHistoryExactOnlyScopeV3 } from './uk_aq_observation_history_exact_only_verifier_v3.mjs';

export function rejectExactOnlyOriginalHandoverV3() {
  throw Object.assign(new Error('Schema-2 direct proof has no accepted durable original-evidence/receipt representation; retain source and require a versioned contract decision'), {
    code: 'PRUNE_EXACT_ONLY_DURABLE_HANDOVER_UNSUPPORTED',
    original_authority_code: 'exact_only_durable_handover_unsupported',
  });
}
const same = (a, b) => encodeObservationHistoryIndexV3Json(a) === encodeObservationHistoryIndexV3Json(b);
const id = o => ({ key: o.key, byte_size: o.byte_size, sha256: o.sha256 });

// The native R2 adapter requests checksum mode on HEAD, but availability is a
// per-object response fact. Probe before creating the proof: unsupported/missing
// checksum capability selects authenticated full GETs, not ETag-only evidence.
// Once checksum HEAD is admitted, later uncertainty fails closed in the verifier.
export async function verifySelectedExactOnlyConsumerScopeV3({
  scope, selector, canonical, getObject, headObject = null, assertOperationHeld,
}) {
  if (typeof assertOperationHeld !== 'function') throw new Error('schema-2 consumer requires the original held observations operation');
  let lost = false;
  const held = async () => {
    if (lost) throw new Error('schema-2 consumer operation was lost');
    try { if (await assertOperationHeld() === false) throw new Error('schema-2 consumer operation is not held'); }
    catch (error) { lost = true; throw error; }
  };
  const read = async key => { await held(); const object = await getObject({ key }); await held(); return object; };
  const object = await read(selector.key);
  const body = Buffer.from(object?.body ?? '');
  if (body.length !== selector.byte_size || sha256Hex(body) !== selector.sha256) throw new Error('selected schema-2 selector identity changed');
  const payload = JSON.parse(body.toString('utf8'));
  if (exactLeafFormatV3(payload).schema_version !== 2) throw new Error('selected exact format changed');
  if (!same(scopedRootDescriptor({ ...id(selector), payload }), selector)) throw new Error('selected exact format/coverage registry mismatch');
  const source = await read(payload.canonical_source_manifest.key);
  const sourceBody = Buffer.from(source?.body ?? '');
  const pollutant = JSON.parse(sourceBody.toString('utf8'));
  if (sourceBody.length !== payload.canonical_source_manifest.byte_size || sha256Hex(sourceBody) !== payload.canonical_source_manifest.sha256) throw new Error('selected canonical body changed');
  if (canonical && (canonical.key !== payload.canonical_source_manifest.key || canonical.byte_size !== sourceBody.length || canonical.sha256 !== sha256Hex(sourceBody))) throw new Error('selected canonical body differs from independently pinned canonical authority');
  let capable = typeof headObject === 'function';
  for (const file of typeof headObject === 'function' ? pollutant.files : []) {
    await held(); const head = await headObject({ key: file.key }); await held();
    if (!head || head.exists === false || head.key !== file.key) throw new Error('canonical file HEAD identity/absence contradiction');
    const size = head.byte_size ?? head.bytes;
    if (size != null && size !== file.bytes) throw new Error('canonical file HEAD size contradiction');
    if (head.byte_size != null && head.bytes != null && head.byte_size !== head.bytes) throw new Error('canonical file HEAD size aliases disagree');
    if (head.sha256 != null && (!/^[0-9a-f]{64}$/.test(head.sha256) || head.sha256 !== file.etag_or_hash)) throw new Error('canonical file HEAD checksum contradiction');
    if (head.sha256 == null || !Number.isSafeInteger(size) || typeof head.etag !== 'string' || !head.etag || head.exists !== true) capable = false;
  }
  const proof = await verifyObservationHistoryExactOnlyScopeV3({ scope,
    getObject: async ({ key }) => await read(key),
    headObject: capable ? headObject : null, assertOperationHeld: held,
  });
  if (!same(id(proof.selector), id(selector)) || proof.row_count !== selector.row_count) throw new Error('verified scope differs from original selected identity');
  await held();
  return { proof, identity_recheck: capable ? 'checksum_sha256_size_etag_head' : 'authenticated_complete_get_sha256' };
}
