// Stage A execution evidence only; never a receipt, control snapshot or baseline.
import { canonicalJson, same, requireValid, ROOT, ORDERING_BLOCKER } from './schema.mjs';
import { freeze, LIMITS } from './limits.mjs';

export const MAX_DIAGNOSTIC_REPORT_BYTES = 16 * 1024;
export const DIAGNOSTIC_SELECTION = freeze({
  connector_id: 1, timeseries_id: 212, pollutant: 'pm25', month_utc: '2026-09',
});
// No station/binding is invented from this diagnostic admission identity.
export const AUTHORITY_BLOCKERS = freeze([
  'authenticated_final_writer_handover', 'durable_verified_receipt_coverage',
  'current_canonical_source_status_binding', 'accepted_full_month_baseline',
  'authenticated_adjacent_month_pm_context', 'verified_immutable_pair_readback',
  'accepted_conditional_publication_protection',
]);
export const UNAVAILABLE_CAPABILITIES = freeze([
  'remote_authority_inspection', 'verified_change_registration', 'source_reconciliation',
  'monthly_observation_aqi_generation', 'managed_publication_upload',
  'managed_control_mutation', 'managed_selector_advancement',
]);
export const REMOTE_ACCESS = freeze({
  scope: 'diagnostic_process_only',
  accounting: 'no_remote_clients_invoked',
  canonical_r2: { reads: 0, writes: 0 }, derived_r2: { reads: 0, writes: 0 },
  dropbox: { reads: 0, writes: 0 }, postgresql: { reads: 0, writes: 0 },
  supabase: { reads: 0, writes: 0 },
  github_runner_setup_and_artifacts: 'outside_diagnostic_accounting_not_measured',
});
export const LIBRARIES = freeze([
  { file: 'schema.mjs', exports: ['assertReceipt', 'assertPublication', 'assertControl'] },
  { file: 'inputs.mjs', exports: ['readWriterInput'] },
  { file: 'authority.mjs', exports: ['readCanonicalScopes'] },
  { file: 'control-snapshot.mjs', exports: ['assertControlSnapshot'] },
  { file: 'report-validation.mjs', exports: ['assertReconciliationReport'] },
  { file: 'limits.mjs', exports: ['createBudget'] },
  { file: 'writer-authentication.mjs', exports: ['authenticateFinalPublication'] },
]);
export const INSTALLED_ONLY = freeze(['control.mjs', 'reconcile.mjs']);

// Closed, bounded runtime report schema. Reconciliation's existing report validator
// requires genuine control/source evidence; it cannot validate this local report.
export function assertDiagnosticReport(report) {
  const check = (ok) => requireValid(ok, 'invalid Stage A diagnostic report');
  const fields = ['schema_version', 'report_version', 'kind', 'environment', 'run',
    'implementation', 'selection', 'invocation_mode', 'duration_ms', 'diagnostic_results',
    'capabilities', 'authorities', 'authority_blockers', 'remote_access',
    'publication_eligible', 'selector', 'readiness', 'outcome', 'error_code'];
  const keys = (value, names) => value && typeof value === 'object'
    && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort());
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const numberText = value => value === null || (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value));
  check(keys(report, fields) && report.schema_version === 1 && report.report_version === 1
    && report.kind === 'uk_aq_jsongen_stage_a_diagnostic' && report.environment === 'TEST'
    && report.invocation_mode === 'local_diagnostic' && ['success', 'error'].includes(report.outcome)
    && Number.isSafeInteger(report.duration_ms) && report.duration_ms >= 0);
  check(keys(report.run, ['github_run_id', 'github_run_attempt', 'source_commit_sha'])
    && numberText(report.run.github_run_id) && numberText(report.run.github_run_attempt)
    && (report.run.source_commit_sha === null || sha(report.run.source_commit_sha)));
  check(report.selection === null || same(report.selection, DIAGNOSTIC_SELECTION));
  check(same(report.authorities, AUTHORITY_BLOCKERS.map(authority => ({
    authority, state: 'not_established', reason: 'authenticated_remote_evidence_unavailable_in_stage_a',
  }))) && same(report.authority_blockers, [...AUTHORITY_BLOCKERS, ORDERING_BLOCKER])
    && same(report.remote_access, REMOTE_ACCESS) && report.publication_eligible === false
    && same(report.selector, { state: 'disabled', blocker: ORDERING_BLOCKER,
      current_publication: 'not_inspected' }));
  check(keys(report.capabilities, ['available', 'unavailable'])
    && same(report.capabilities.unavailable, UNAVAILABLE_CAPABILITIES)
    && Array.isArray(report.capabilities.available)
    && report.capabilities.available.every(x => ['scope_admission', 'installed_library_inspection',
      'bounded_local_reporting'].includes(x)));
  check(Array.isArray(report.diagnostic_results) && report.diagnostic_results.length > 0
    && report.diagnostic_results.length <= 8 && report.diagnostic_results.every(result =>
      keys(result, ['code', 'status']) && /^[a-z_]{1,64}$/.test(result.code)
      && ['passed', 'failed'].includes(result.status)));
  if (report.implementation !== null) {
    const item = report.implementation;
    check(keys(item, ['package_name', 'package_version', 'node_version', 'managed_schema_version',
      'managed_root', 'aqi_algorithm_version', 'modules']) && item.package_name === 'uk-aq-ops'
      && typeof item.package_version === 'string' && item.package_version.length <= 64
      && /^v\d+\.\d+\.\d+$/.test(item.node_version) && item.managed_schema_version === 1
      && item.managed_root === ROOT && typeof item.aqi_algorithm_version === 'string'
      && item.aqi_algorithm_version.length <= 128 && Array.isArray(item.modules)
      && item.modules.length === LIBRARIES.length + INSTALLED_ONLY.length);
    check(item.modules.every((module, i) => keys(module, ['file', 'sha256', 'status'])
      && module.file === [...LIBRARIES.map(x => x.file), ...INSTALLED_ONLY][i]
      && /^[a-f0-9]{64}$/.test(module.sha256)
      && module.status === (i < LIBRARIES.length ? 'imported_exports_available' : 'installed_not_imported')));
  }
  const success = report.outcome === 'success';
  check(report.readiness === (success ? 'diagnostic_passed_publication_blocked' : 'diagnostic_failed')
    && (success ? report.error_code === null : /^[a-z_]{1,64}$/.test(report.error_code)));
  if (success) check(report.selection !== null && report.implementation !== null
    && sha(report.run.source_commit_sha) && report.duration_ms < LIMITS.duration_ms
    && same(report.diagnostic_results, ['test_scope_admitted', 'implementation_identified',
      'managed_libraries_available'].map(code => ({ code, status: 'passed' })))
    && same(report.capabilities.available, ['scope_admission', 'installed_library_inspection', 'bounded_local_reporting']));
  check(canonicalJson(report).length <= MAX_DIAGNOSTIC_REPORT_BYTES);
  return report;
}
