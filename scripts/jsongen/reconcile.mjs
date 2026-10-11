// Read-only Stage 2 diagnostics. There is deliberately no publication mutator.
import { assertControl, assertReceipt, assertReference, affectedMonths, same, scopeKey, requireValid } from './schema.mjs';
import { readImmutableReceipt, readCompleteScopeBundle } from './inputs.mjs';
import { inspectCanonicalScope } from './canonical.mjs';

export const RECONCILIATION_LIMITS = Object.freeze({ receipts: 16, scopes: 8,
  metadata_gets: 192 });
export const CLASSIFICATION = Object.freeze({
  CURRENT_AND_AUTHENTICATED: 'CURRENT_AND_AUTHENTICATED',
  SUPERSEDED: 'SUPERSEDED',
  INDEPENDENT_AND_CURRENT: 'INDEPENDENT_AND_CURRENT',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
});

export function authenticateWriterFinalPublication(receipt) {
  assertReceipt(receipt);
  const writer = receipt.writer.identity.toLowerCase();
  const reason = writer.includes('prune')
    ? 'Prune removes the complete frozen source before final batch verification; no retained complete final replacement proves bundle membership'
    : writer.includes('integrity')
      ? 'Integrity final VERIFY and retained source-cache/overlay evidence do not independently bind arbitrary bundle bytes to complete final canonical replacement'
      : 'No installed writer adapter independently binds final verified canonical publication and complete replacement rows to this bundle';
  return { state: 'unavailable', reason,
    required_action: 'Retain a complete writer-owned final source and implement a verified writer-specific handover adapter' };
}

export function classifyScope({ receipt, scope, canonical, bytesVerified,
  receiptBytesVerified = false, completeScopeValidated,
  registrationState = 'registered' }) {
  assertReceipt(receipt);
  const writerAuth = authenticateWriterFinalPublication(receipt);
  const after = scope.after;
  const metadataCurrent = canonical?.current_root_authenticated === true
    && canonical?.state === 'present'
    && after.state === 'present'
    && after.authority.key === canonical.authority?.key
    && after.authority.sha256 === canonical.authority?.sha256
    && after.authority.byte_size === canonical.authority?.byte_size
    && (canonical.authority?.scope_row_count == null
      || canonical.authority?.scope_row_count === after.row_count);
  const provenRemoved = canonical?.current_root_authenticated === true
    && canonical?.state === 'authoritative_absent';
  const superseded = (provenRemoved && after.state === 'present')
    || (canonical?.current_root_authenticated === true
      && canonical?.state === 'present' && after.state === 'authoritative_empty')
    || (canonical?.current_root_authenticated === true
      && canonical?.state === 'present' && after.state === 'present'
      && canonical.authority?.scope_row_count !== null
      && canonical.authority?.scope_row_count !== undefined
      && canonical.authority.scope_row_count !== after.row_count);
  const missing = [];
  if (!bytesVerified) missing.push('immutable receipt/bundle byte integrity');
  if (!completeScopeValidated) missing.push('complete replacement membership');
  if (writerAuth.state !== 'authenticated') missing.push('writer final-publication authentication');
  if (canonical?.state === 'unresolved' || !canonical) missing.push('stable current canonical metadata');
  if (canonical?.current_root_authenticated !== true) missing.push('selected current canonical root identity');
  if (canonical?.binding_authority !== 'authenticated') missing.push('physical binding authority');
  if (canonical?.verification_authority !== 'authenticated') missing.push('effective verification/status authority');
  if (after.state === 'authoritative_empty' && !provenRemoved) missing.push('independent authoritative removal evidence');
  if (registrationState !== 'complete') missing.push('complete writer receipt registration coverage');
  const classification = superseded ? CLASSIFICATION.SUPERSEDED : CLASSIFICATION.RECONCILIATION_REQUIRED;
  return {
    change_id: receipt.change_id, writer: receipt.writer.identity,
    invocation_id: receipt.writer.invocation_id,
    generation: receipt.source.generation_authority,
    identity: scope.identity, day_utc: scope.day_utc, scope_key: scopeKey(scope),
    receipt_identity: null, bundle_identity: receipt.bundle.object,
    receipt_bytes_verified: Boolean(receiptBytesVerified),
    bundle_bytes_verified: Boolean(bytesVerified),
    complete_scope_validated: Boolean(completeScopeValidated),
    final_writer_authentication: writerAuth, canonical_authority: canonical,
    binding_authority: canonical?.binding_authority ?? 'unresolved',
    removal_evidence: provenRemoved ? { level: canonical.level, parent_key: canonical.parent_key } : null,
    scope_dominance: superseded ? 'superseded_by_current_canonical_state'
      : metadataCurrent ? 'current_manifest_identity_matches' : 'unknown',
    classification, registration_coverage: registrationState,
    affected_months: affectedMonths([scope]),
    pm_context: scope.identity.pollutant_code === 'no2' ? null
      : { preceding_hours: 23, following_hours: 23, minimum_valid_hours: 18,
        adjacent_month_authority: 'unresolved' },
    outcome: 'reconciliation_required', missing_proof: missing,
    required_action: superseded ? 'Preserve any independent current scopes and reconcile coverage'
      : 'Authenticate final writer source, binding/status and registration coverage before publication',
  };
}

export async function reconcileRegisteredChanges({ control, r2, canonicalR2,
  currentObservationsRoot = null, currentGeneration = null,
  writerReceiptReferences = [] }) {
  assertControl(control);
  requireValid(Array.isArray(writerReceiptReferences)
    && writerReceiptReferences.length <= RECONCILIATION_LIMITS.receipts,
  'writer receipt reference limit exceeded');
  const entries = Object.entries(control.registered_changes);
  requireValid(entries.length <= RECONCILIATION_LIMITS.receipts
    && entries.reduce((n, [, e]) => n + e.receipt.scopes.length, 0) <= RECONCILIATION_LIMITS.scopes,
  'reconciliation batch limit exceeded; partition the intake');
  const diagnostics = [];
  let metadataGets = 0;
  for (const [changeId, entry] of entries) {
    let input = null;
    let bundle = null;
    let receiptError = null;
    let bundleError = null;
    try {
      input = await readImmutableReceipt({ r2, reference: entry.receipt_object });
      requireValid(same(input.receipt, entry.receipt) && input.receipt.change_id === changeId,
        'control/immutable receipt mismatch');
    } catch (error) { receiptError = String(error?.message || error); input = null; }
    if (input) {
      try { bundle = await readCompleteScopeBundle({ r2, receipt: input.receipt }); }
      catch (error) { bundleError = String(error?.message || error); }
    }
    for (const scope of entry.receipt.scopes) {
      const canonical = await inspectCanonicalScope({ r2: canonicalR2, scope,
        observationsRoot: currentObservationsRoot, selectedGeneration: currentGeneration });
      metadataGets += canonical.metadata_gets ?? 0;
      requireValid(metadataGets <= RECONCILIATION_LIMITS.metadata_gets,
        'canonical metadata GET budget exceeded');
      diagnostics.push({ ...classifyScope({ receipt: entry.receipt, scope, canonical,
        receiptBytesVerified: Boolean(input), bytesVerified: Boolean(bundle),
        completeScopeValidated: Boolean(bundle),
        registrationState: 'unknown_complete_coverage' }),
        receipt_identity: entry.receipt_object,
        receipt_error: receiptError, bundle_error: bundleError,
        bundle_state: bundle ? 'complete_scope_validated' : bundleError ? 'unavailable_or_invalid' : 'not_read' });
    }
  }
  const missingRegistration = [];
  for (const evidence of writerReceiptReferences) {
    requireValid(typeof evidence?.change_id === 'string' && evidence?.receipt_object,
      'writer outbox reference requires change ID and immutable receipt identity');
    assertReference(evidence.receipt_object, { managed: true });
    let retained;
    try {
      retained = await readImmutableReceipt({ r2, reference: evidence.receipt_object });
      requireValid(retained.receipt.change_id === evidence.change_id, 'outbox/receipt change ID mismatch');
    } catch (error) {
      missingRegistration.push({ change_id: evidence.change_id,
        receipt_identity: evidence.receipt_object, state: 'missing_or_invalid_writer_receipt',
        reason: String(error?.message || error),
        required_action: 'Recover the original retained writer receipt; do not rerun canonical repair' });
      continue;
    }
    const registered = control.registered_changes[evidence.change_id];
    if (!registered || !same(registered.receipt_object, evidence.receipt_object)) {
      missingRegistration.push({ change_id: evidence.change_id,
        receipt_identity: evidence.receipt_object,
        state: registered ? 'conflicting_receipt_registration' : 'missing_receipt_registration',
        evidence_state: 'immutable_attestation_only',
        required_action: 'Authenticate original writer publication, then replay or repair registration without rerunning canonical repair' });
    }
  }
  return { outcome: 'reconciliation_required', registration_coverage: 'unknown',
    reason: 'No authenticated complete cross-writer outbox/frontier is available',
    diagnostics, missing_registration: missingRegistration,
    metadata_gets: metadataGets, source_as_of: control.freshness.source_as_of };
}
