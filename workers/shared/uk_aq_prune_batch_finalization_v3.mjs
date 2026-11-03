// Existing mandatory Prune batch validation, shared with its operation-local adapter.
const sameDays = (a, b) => Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b);

// Identity of the already-required result, not a new R2 object or receipt.
export function pruneBatchFinalizationIdentityV3(result) {
  const refs = values => {
    if (!Array.isArray(values) || !values.length) throw new Error('Missing original batch identities');
    const seen = new Set();
    return values.map(o => {
      if (typeof o?.key !== 'string' || seen.has(o.key) || !Number.isSafeInteger(o.byte_size)
        || o.byte_size <= 0 || !/^[a-f0-9]{64}$/.test(o.sha256 || '')) throw new Error('Invalid original batch identity');
      seen.add(o.key);
      return { key: o.key, byte_size: o.byte_size, sha256: o.sha256 };
    }).sort((a, b) => a.key.localeCompare(b.key));
  };
  return {
    affected_days_utc: [...result.affected_days_utc],
    day_manifests: refs(result.day_results?.map(r => r.day_manifest)),
    canonical_aggregate_references: refs(result.canonical_aggregate_result?.aggregate_manifests),
    exact_scope_references: refs(result.connector_results?.flatMap(c => c.partitions.map(p => p.scoped_root.evidence))),
    latest_global_references: refs(result.v3_publication?.latest_global?.objects),
    exact_scope_publication_count: result.v3_publication?.exact_scopes?.length,
  };
}

export function validatePhaseBV3RunFinalizationResult({
  result,
  expectedDays,
  expectedConnectorPublicationCount,
}) {
  const aggregate = result?.canonical_aggregate_result;
  const exactScopes = result?.v3_publication?.exact_scopes;
  if (result?.ok !== true ||
      !sameDays(result?.affected_days_utc, expectedDays) ||
      aggregate?.canonical_aggregate_authority_verified !== true ||
      aggregate?.parent_state_reread_under_lock !== true ||
      !sameDays(aggregate?.affected_days_utc, expectedDays) ||
      !Array.isArray(exactScopes) ||
      exactScopes.length !== expectedConnectorPublicationCount ||
      exactScopes.some((publication) => publication?.ok !== true) ||
      result?.v3_publication?.latest_global?.ok !== true) {
    throw new Error("Phase B v3 run finalization did not establish complete canonical/latest authority");
  }
  return result;
}
