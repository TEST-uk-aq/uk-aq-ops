// Local operational result validation, not a new durable wire contract or an
// independent original-authentication authority. Used by CLI AND workflow.
import { same } from './schema.mjs';
import { assertPruneSelectedCoverage } from './prune-coverage-plan.mjs';
import { assertPruneAcceptanceKey, pruneAcceptanceId } from './prune-outbox-reader.mjs';
import { evidence } from './limits.mjs';

export function assertReadOnlyPruneResult(result) {
  const check = ok => evidence(ok, 'invalid_read_only_result', 'Completed read-only original authentication and coverage proof required');
  check(result?.schema_version === 1 && result.kind === 'uk_aq_jsongen_prune_consumer_result'
    && result.state === 'authenticated_read_only' && result.mode === 'read-only'
    && result.reason === 'original_authenticated_selected_coverage_planned_read_only_unretained'
    && result.read_only_complete === true && result.receipt_eligible === false
    && result.handover_complete === false && result.publication_eligible === false
    && result.bundle_retention === 'not_attempted' && result.receipt_retention === 'not_attempted'
    && result.descriptor_retention === 'not_attempted' && result.registration === 'not_attempted'
    && result.current_canonical_authority === 'not_inspected' && result.supersession === 'not_evaluated'
    && !result.expected_receipts && !result.control_operation);
  assertPruneAcceptanceKey(result.key);
  const a = result.authentication;
  check(result.event_id === pruneAcceptanceId(result.key) && a?.event_id === result.event_id
    && a.state === 'authenticated' && same(a.key, result.key)
    && a.original_gate === 'authenticated_committed_immutable_outbox'
    && a.original_final_evidence === 'authenticated_original_prune_attestation'
    && result.original_evidence === a.original_final_evidence
    && a.pending_source === 'source_bytes_verified' && result.pending_source === a.pending_source
    && a.receipt_eligible === false && a.publication_eligible === false
    && Array.isArray(a.missing_authority) && a.missing_authority.length === 0);
  const c = assertPruneSelectedCoverage(result.coverage);
  const m = result.metrics;
  check(m && ['elapsed_ms', 'authentication_elapsed_ms', 'cpu_user_ms', 'cpu_system_ms',
    'sampled_peak_heap_used_bytes', 'heap_samples', 'process_max_rss_bytes', 'private_r2_get_attempts',
    'private_r2_get_responses', 'private_r2_response_body_bytes'].every(k =>
    typeof m[k] === 'number' && Number.isFinite(m[k]) && m[k] >= 0)
    && m.authentication_elapsed_ms <= m.elapsed_ms && m.elapsed_ms <= 120000
    && m.heap_samples > 0 && m.sampled_peak_heap_used_bytes > 0 && m.process_max_rss_bytes > 0
    && m.private_r2_get_attempts === m.private_r2_get_responses
    && m.transfer_accounting === 'complete_response_bodies_excludes_protocol_overhead'
    && m.heap_measurement === 'stage_budget_and_interval_samples_not_exact_peak'
    && m.rss_measurement === 'process_lifetime_high_water_not_event_attributed');
  check(c.event_id === result.event_id && same(c.authority.key, result.key)
    && result.physical_scope_count === c.original.scope_count && a.physical_scope_count === result.physical_scope_count
    && result.observation_count === c.original.observation_count && a.observation_count === result.observation_count
    && same(result.partitions, c.partitions));
  return result;
}

export function assertReadOnlyPruneReport(report) {
  if (report?.kind === 'uk_aq_jsongen_prune_consumer_result') return assertReadOnlyPruneResult(report);
  evidence(report?.schema_version === 1 && report.kind === 'uk_aq_jsongen_prune_consumer_discovery'
    && report.state === 'authenticated_read_only' && report.read_only_complete === true
    && report.handover_complete === false && report.publication_eligible === false
    && report.discovery_coverage_complete === false && report.discovery?.coverage_complete === false
    && Array.isArray(report.discovery.events) && report.discovery.events.length > 0
    && report.discovery.events.length <= 16 && Array.isArray(report.results)
    && report.results.length === report.discovery.events.length,
  'invalid_read_only_result', 'Every visible original event on this bounded page must complete read-only authentication');
  const seen = new Set();
  for (const [i, result] of report.results.entries()) {
    assertReadOnlyPruneResult(result);
    const event = report.discovery.events[i];
    evidence(!seen.has(result.event_id) && result.event_id === event.event_id && same(result.key, event.key),
      'invalid_read_only_result', 'Read-only results do not match discovered original events');
    seen.add(result.event_id);
  }
  return report;
}

export function isReadOnlyPruneSuccess(report) {
  try { assertReadOnlyPruneReport(report); return true; } catch { return false; }
}
