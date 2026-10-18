// Explicit fail-closed seam diagnostics for the inspected production writers.
// No caller-supplied final_verified/ok flag, receipt digest, callback or workflow
// status can mint authenticated writer evidence through this interface.
import { assertReceipt } from './schema.mjs';
import { freeze, evidence } from './limits.mjs';
export const WRITER_SEAMS = freeze({
  prune_daily_v3: {
    boundary: 'workers/uk_aq_prune_daily/phase_b_history_r2.mjs:finalizePublishedPhaseBConnectors after validatePhaseBV3RunFinalizationResult',
    blockers: ['frozen_source_removed_before_final_batch_verification', 'durable_final_publication_to_bundle_binding_missing'],
    action: 'Writer must retain and hash its complete frozen canonical source before cleanup, then bind that source and bundle to the validated final batch while preserving existing deletion gates.',
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
export function authenticateFinalPublication({ input, writerKind = null }) {
  assertReceipt(input.receipt);
  evidence(input.bundle?.integrity === 'verified', 'unverified_bundle', 'complete bundle integrity must be verified first');
  const seam = Object.hasOwn(WRITER_SEAMS, writerKind) ? WRITER_SEAMS[writerKind] : null;
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
