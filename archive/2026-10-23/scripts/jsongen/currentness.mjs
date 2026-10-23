// Pure report projection. Authentication is supplied only by the existing
// independent writer adapter, never inferred from matching metadata or time.
import { same } from './schema.mjs';
import { WRITER_SEAMS } from './writer-authentication.mjs';

export function currentScopeMatch(change, item, canonical) {
  if (!canonical?.read_consistent || !change.authentication?.authenticated) return 'unavailable';
  const original = change.original_scope_authorities?.find(s => s.scope_key === item.scope_key);
  const now = canonical.scopes.find(s => s.scope_key === item.scope_key);
  if (!original || !now?.physical || now.diagnostics.length || !now.binding) return 'unavailable';
  if (now.physical.membership === 'authoritative_absent') return item.declared_state === 'authoritative_empty' ? 'matches' : 'differs';
  if (now.verification?.state !== 'embedded_status_requires_writer_evidence'
    || original.effective_status !== 'original_schema3_embedded_status_bound') return 'unavailable';
  return item.declared_state === 'present' && item.declared_scope.after.row_count === now.physical.row_count
    && original.physical_sha256 === now.physical.scope_sha256 && same(original.binding, now.binding)
    ? 'matches' : 'differs';
}

export function assessStage3C({ changes, canonical, originalGroups = [], discovery = null }) {
  const scopes = changes.flatMap(change => change.scopes.map(item => {
    const match = currentScopeMatch(change, item, canonical);
    // An exact authenticated before->after publication link is necessary.
    // Timestamp, insertion, control order and changed parent pins are excluded.
    // Presently admitted AURN first publications cannot claim replacement of
    // a prior present scope. Unsupported writers cannot enter this branch.
    const candidates = match === 'differs' ? changes.filter(later =>
      later.authentication?.authenticated && later.change_id !== change.change_id
      && later.authentication.original_acceptance.event_id !== change.authentication.original_acceptance.event_id
      && later.scopes.some(next => next.scope_key === item.scope_key
        && same(next.declared_scope.before, item.declared_scope.after)
        && currentScopeMatch(later, next, canonical) === 'matches')) : [];
    const supersession = candidates.length === 1 ? { state: 'authenticated', change_id: candidates[0].change_id,
      authority: candidates[0].authentication.original_acceptance } : { state: 'unproven', change_id: null, authority: null };
    const code = !change.authentication?.authenticated ? 'missing_original_writer_evidence'
      : match === 'matches' ? 'original_receipt_matches_current_physical_metadata'
      : match === 'unavailable' ? 'current_scope_authority_unavailable'
      : supersession.state === 'authenticated' ? 'authenticated_later_supersession'
      : candidates.length > 1 ? 'contradictory_later_writer_authority' : 'physical_metadata_changed_later_writer_unknown';
    return { change_id: change.change_id, scope_key: item.scope_key,
      ...(canonical?.schema_version === 3 ? { inspection_state: scopeInspectionState(canonical.scopes.find(s => s.scope_key === item.scope_key), canonical) } : {}),
      original_authentication: change.authentication?.authenticated ? 'authenticated' : 'unavailable',
      current_metadata_match: match, authenticated_supersession: supersession,
      writer_coverage: 'unknown', registration_coverage: change.registered ? 'registered_in_inspected_control' : 'missing_registration',
      source_as_of: canonical?.schema_version === 3 && !canonical.selection.selected_scope_keys.includes(item.scope_key)
        ? null : canonical?.source_as_of.identity_sha256 || null,
      freshness: 'unknown', reconciliation_state: 'reconciliation_required', publication_eligible: false,
      diagnostic: code };
  }));
  const events = originalGroups.map(group => {
    const retained = group.expected_changes.filter(id => changes.some(c => c.change_id === id && c.authentication?.authenticated));
    const registered = retained.filter(id => changes.find(c => c.change_id === id).registered);
    return { ...group, retained_changes: retained, registered_changes: registered,
      missing_retention: group.expected_changes.filter(id => !retained.includes(id)),
      missing_registration: group.expected_changes.filter(id => !registered.includes(id)),
      original_receipts_retained: retained.length === group.expected_changes.length,
      original_receipts_registered: registered.length === group.expected_changes.length };
  });
  const authenticated = changes.filter(c => c.authentication?.authenticated);
  const pending = (discovery?.events || []).filter(e => !events.some(g => g.event_id === e.event_id && g.original_receipts_registered));
  const knownMissing = changes.some(c => !c.registered) || events.some(g => !g.original_receipts_registered);
  const scopeKeys = canonical?.scopes.map(s => s.scope_key).sort() || [...new Set(changes.flatMap(c => c.scopes.map(s => s.scope_key)))].sort();
  return {
    original_authentication: { authenticated_receipts: authenticated.map(c => c.change_id).sort(),
      unavailable_receipts: changes.filter(c => !c.authentication?.authenticated).map(c => c.receipt) },
    current_metadata_inspected: canonical?.read_consistent === true && canonical.scopes.every(s =>
      s.physical && s.binding && !s.diagnostics.length && ['embedded_status_requires_writer_evidence',
        'not_applicable_to_absent_scope'].includes(s.verification?.state)),
    scopes, original_events: events, discovery,
    awaiting_consumption: pending,
    retained_unregistered: authenticated.filter(c => !c.registered).map(c => c.change_id).sort(),
    known_superseding_publications: scopes.filter(s => s.authenticated_supersession.state === 'authenticated')
      .map(s => ({ scope_key: s.scope_key, original_change_id: s.change_id, ...s.authenticated_supersession })),
    writer_coverage: 'unknown', all_required_receipts_retained: 'unknown', all_required_receipts_registered: 'unknown',
    registration_coverage: knownMissing ? 'known_registration_gaps' : changes.length ? 'known_registered_set_only' : 'unknown',
    writer_inventories: Object.entries(WRITER_SEAMS).map(([writer, seam]) => ({ writer, state: 'unavailable',
      reason: writer === 'prune_daily_v3'
        ? 'Optional AURN-only outbox can omit successful canonical gates; bounded overlapping discovery has no complete canonical inventory or commit/freshness fence.'
        : seam.blockers.join('; '),
      minimal_missing_contract: writer === 'prune_daily_v3'
        ? 'Writer-owned durable inventory of every applicable completed publication, including missing handovers, plus a scope-bound independently authenticated freshness/completeness fence.'
        : 'Accepted writer-owned complete replacement/removal handover and durable publication inventory, with independent final-source/status/binding authentication and a scope-bound freshness fence.' })),
    unknown_coverage: { scope_keys: scopeKeys, canonical_time_window: 'all_intervening_publications_through_inspected_source_as_of',
      receipt_time_windows: changes.map(c => ({ change_id: c.change_id,
        original_gate_completed_at_utc: c.original_verified_at_utc || null,
        inspected_through_utc: canonical?.source_as_of.finished_at_utc || null,
        timestamps_establish_canonical_order: false })),
      outside_requested_scopes: 'not_assessed', discovery_window: discovery ? { from: discovery.from, to: discovery.to } : null,
      discovery_time_meaning: 'accepted_at_insertion_not_commit_order',
      reason: 'No authenticated complete relevant-writer inventory; matching known receipts cannot exclude unretained or unregistered publications.' },
    source_as_of: canonical?.source_as_of || null,
    freshness: 'unknown', reconciliation_state: 'reconciliation_required', publication_eligible: false,
  };
}

export function scopeInspectionState(scope, canonical) {
  if (!scope) return 'not_inspected';
  if (scope.state === 'not_inspected_partition') return 'not_inspected_partition';
  if (scope.state === 'not_inspected_resource_limit') return 'not_inspected_resource_limit';
  if (!canonical.read_consistent) return 'incompatible_source_as_of';
  return scope.physical && scope.binding && !scope.diagnostics.length
    && ['embedded_status_requires_writer_evidence', 'not_applicable_to_absent_scope'].includes(scope.verification?.state)
    ? 'fully_inspected' : 'metadata_unavailable';
}
