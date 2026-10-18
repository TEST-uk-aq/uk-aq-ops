// Explicit fail-closed seam diagnostics for the inspected production writers.
// No caller-supplied final_verified/ok flag, receipt digest, callback or workflow
// status can mint authenticated writer evidence through this interface.
import { assertReceipt } from './schema.mjs';
import { freeze, evidence } from './limits.mjs';
import { inspectAuthenticatedPruneHandover, PRUNE_RECEIPT_AUTHORITY_GAPS } from './prune-consumer-authentication.mjs';
export const WRITER_SEAMS = freeze({
  prune_daily_v3: {
    boundary: 'workers/uk_aq_prune_daily/phase_b_history_r2.mjs:finalizePublishedPhaseBConnectors after validatePhaseBV3RunFinalizationResult',
    blockers: PRUNE_RECEIPT_AUTHORITY_GAPS.map(gap => gap.code),
    action: 'Replay the original immutable outbox and private pending source through prune-consumer.mjs. Schema-1 proof lacks original before-membership and selected-v3 binding authority; retain those writer-side fields or agree a versioned contract before minting receipts.',
  },
  integrity_v3: {
    boundary: 'scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py:run_v2_final_verification after complete APPLY/parent/index publication',
    blockers: ['installed_pro_runner_and_retained_test_evidence_unavailable', 'resolved_final_view_to_bundle_binding_missing'],
    action: 'Inspect the installed TEST runner and export a durable writer-owned handover from the verified resolved final view, source/status evidence, physical bindings and complete replacement/removal membership.',
  },
  sos_light_v3: {
    boundary: 'scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py:run_v2_final_verification before cleanup_successful_repair_overlay',
    blockers: ['installed_pro_runner_and_retained_test_evidence_unavailable', 'resolved_final_view_to_bundle_binding_missing'],
    action: 'Writer must bind complete source plus preserved Dropbox rows and admitted removals to final invocation VERIFY; a retained overlay or successful APPLY report alone is insufficient.',
  },
  ifw: {
    boundary: 'Future accepted canonical repair publication and final verification',
    blockers: ['ifw_canonical_repair_publication_not_accepted'],
    action: 'Do not activate a handover or trigger before the IFW canonical repair publication contract is accepted.',
  },
});
export function authenticateFinalPublication({ input, writerKind = null, pruneHandover = null }) {
  assertReceipt(input.receipt);
  evidence(input.bundle?.integrity === 'verified', 'unverified_bundle', 'complete bundle integrity must be verified first');
  const seam = Object.hasOwn(WRITER_SEAMS, writerKind) ? WRITER_SEAMS[writerKind] : null;
  if (writerKind === 'prune_daily_v3' && pruneHandover) {
    const { result } = inspectAuthenticatedPruneHandover(pruneHandover);
    evidence(input.receipt.writer.identity === 'prune_daily_v3'
      && input.receipt.writer.invocation_id === result.key.run_id,
    'contradictory_original_evidence', 'Receipt invocation differs from authenticated original Prune event');
    // Authenticated original completion and private bytes do not fill the
    // mandatory Stage 1 before/binding fields. Receipt/CAS validation stays strict.
    return freeze({ state: 'reconciliation_required', authenticated: false,
      original_event_authenticated: true, event_id: result.event_id,
      writer: { ...input.receipt.writer }, change_id: input.receipt.change_id,
      missing_proof: PRUNE_RECEIPT_AUTHORITY_GAPS.map(gap => gap.code), inspected_seam: seam,
      action: seam.action });
  }
  return freeze({ state: 'reconciliation_required', authenticated: false,
    writer: { ...input.receipt.writer }, change_id: input.receipt.change_id,
    receipt: input.receipt_object, bundle: input.receipt.bundle.object,
    declared_final_publication: input.receipt.source.final_publication,
    missing_proof: ['independent_originating_writer_and_invocation', 'original_final_verified_canonical_generation',
      'complete_final_rows_and_source_status_to_bundle_binding', 'original_verified_removal_membership',
      ...(seam?.blockers || ['writer_adapter_unavailable'])],
    inspected_seam: seam,
    action: seam?.action || 'Provide an accepted writer-owned adapter and independently retained final-publication evidence. No source reconstruction is authorised.',
  });
}
