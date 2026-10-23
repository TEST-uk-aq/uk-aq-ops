// Manual-only Stage 3B. Read-only is separate from explicit retention/CAS mode.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connectPruneOutboxReader, assertPruneAcceptanceKey, originalPruneAcceptance } from './prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup, retainPruneReceiptGroup, retainedPruneEvent } from './prune-receipts.mjs';
import { buildSelectedPruneEvent, retainSelectedPruneEvent, retainedSelectedPruneEvent } from './prune-selected-event.mjs';
import { managedR2ReadConfig, readManagedControl, managedR2WriteConfig, updateManagedControl, JSONgenControlError }
  from './control.mjs';
import { assertOpsEnvironment } from './admission.mjs';
import { assertManagedR2CredentialMode, managedR2Environment } from './r2-config.mjs';
import { readReceipt } from './inputs.mjs';
import { createPruneHandoverBudget, evidence, JSONgenEvidenceError } from './limits.mjs';
import { planPruneSelectedCoverage } from './prune-coverage-plan.mjs';
import { measurePruneConsumer } from './prune-consumer-measurements.mjs';
import { assertReadOnlyPruneResult, isReadOnlyPruneSuccess } from './prune-consumer-outcome.mjs';

export async function consumePruneAcceptance({ reader, key, derivedR2, mode = 'read-only', initializeControl = false,
  budget = createPruneHandoverBudget() }) {
  evidence(['read-only', 'retain'].includes(mode) && (!initializeControl || mode === 'retain'),
    'invalid_consumer_arguments', 'Explicit retain mode required for derived writes or initialization');
  try { assertManagedR2CredentialMode(derivedR2, mode === 'retain' ? 'write' : 'read'); }
  catch { evidence(false, 'invalid_r2_configuration', 'Operation-specific JSONgen R2 credentials required'); }
  key = structuredClone(assertPruneAcceptanceKey(key));
  evidence(key.environment === managedR2Environment(derivedR2), 'cross_environment_evidence', 'Requested source environment differs from configured storage');
  const measurement = measurePruneConsumer(budget);
  budget = measurement.budget;
  const finish = value => ({ ...value, resources: budget.snapshot(), metrics: measurement.finish() });
  const result = { schema_version: 1, kind: 'uk_aq_jsongen_prune_consumer_result', key,
    mode, read_only_complete: false, descriptor_retention: 'not_attempted',
    state: 'pending', discovery: 'original_primary_key_replay', original_evidence: 'pending',
    pending_source: 'pending', physical_scope_count: null, observation_count: null,
    partitions: null, bundle_retention: 'not_attempted', receipt_retention: 'not_attempted',
    registration: 'not_attempted', retry: 'original_primary_key_replay',
    receipt_eligible: false, handover_complete: false, publication_eligible: false,
    current_canonical_authority: 'not_inspected', supersession: 'not_evaluated' };
  // Only fixed, code-owned identifiers enter the report. An unexpected error's
  // message and stack may contain private evidence, SQL or an R2 URL.
  let failureStage = 'original_outbox_read';
  try {
    const acceptance = await reader.read(key);
    if (!acceptance) return finish({ ...result, state: 'incomplete', reason: 'original_acceptance_not_visible',
      retry: 'overlapping_discovery_and_periodic_historical_resweep' });
    originalPruneAcceptance(acceptance); // Reject a caller-invented reader result before reporting any authority.
    result.event_id = acceptance.event_id;
    result.original_evidence = 'original_gate_authenticated';
    failureStage = 'original_evidence';
    measurement.beginAuthentication();
    const handover = await authenticatePruneHandover({ acceptance, derivedR2, budget,
      onStage: stage => { failureStage = stage; measurement.stage(); } });
    measurement.authenticationFinished();
    const { result: authentication } = inspectAuthenticatedPruneHandover(handover);
    Object.assign(result, { original_evidence: authentication.original_final_evidence,
      pending_source: authentication.pending_source, physical_scope_count: authentication.physical_scope_count,
      observation_count: authentication.observation_count, authentication,
      receipt_eligible: authentication.receipt_eligible, missing_authority: authentication.missing_authority });
    // Stage 1 stops before constructing ANY receipt. Unsupported observations
    // remain authenticated/accounted in coverage, never admitted to schema 2.
    if (mode === 'read-only') {
      failureStage = 'selected_coverage_planning';
      const coverage = planPruneSelectedCoverage({ handover, budget });
      const completed = finish({ ...result, coverage, partitions: coverage.partitions,
        state: 'authenticated_read_only', read_only_complete: true,
        reason: 'original_authenticated_selected_coverage_planned_read_only_unretained',
        retry: 'none' });
      failureStage = 'read_only_outcome_validation';
      assertReadOnlyPruneResult(completed); budget.check();
      return completed;
    }
    failureStage = 'partition_construction';
    // A previous complete schema-2 registration keeps its exact wire identity.
    // The fresh control check is advisory; CAS rechecks both event families.
    const before = await readManagedControl(derivedR2, { budget });
    let legacy = before && Object.values(before.control.registered_changes).some(e =>
      e.receipt.schema_version === 2 && e.receipt.origin.authority.event_id === result.event_id);
    let legacyGroup = null;
    const proof = inspectAuthenticatedPruneHandover(handover);
    if (!legacy && !before?.control.authenticated_events?.[result.event_id]
      && proof.pending.pending_evidence.scope.physical_timeseries_days.every(s => ['pm25', 'pm10', 'no2'].includes(s.pollutant_code))) {
      // Recover partially retained schema-2 handovers too. Deterministic exact
      // receipt GETs replace listing; missing objects confer no legacy authority.
      legacyGroup = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover, budget }));
      for (const entry of legacyGroup.entries) {
        try {
          await readReceipt({ r2: derivedR2, reference: entry.receipt_object, expected: entry.receipt, budget });
          legacy = true; break;
        } catch (error) { if (error.status !== 404) throw error; }
      }
    }
    const group = legacy ? legacyGroup || inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover, budget }))
      : buildSelectedPruneEvent({ handover, budget });
    if (!legacy) {
      result.descriptor = group.descriptor_object;
      result.coverage_summary = group.event;
    }
    result.partitions = group.plan;
    result.expected_receipts = group.entries.map(e => ({ change_id: e.receipt.change_id, receipt: e.receipt_object,
      bundle: e.receipt.bundle.object }));
    result.group_sha256 = group.group_sha256;
    result.receipt_eligible = group.entries.length > 0;
    result.retention_progress = []; result.bundle_retention = 'incomplete'; result.receipt_retention = 'incomplete';
    failureStage = legacy ? 'receipt_retention' : 'descriptor_retention';
    if (!legacy) result.descriptor_retention = 'incomplete';
    const retainedToken = await (legacy ? retainPruneReceiptGroup : retainSelectedPruneEvent)({ handover, r2: derivedR2, budget,
      progress: progress => {
        if (progress.descriptor) {
          result.descriptor_retention = progress.descriptor;
          result.descriptor_outcome = progress.descriptor_outcome;
          failureStage = 'receipt_retention';
        } else result.retention_progress[progress.partition_index] = progress;
      } });
    const stored = (legacy ? retainedPruneEvent : retainedSelectedPruneEvent)(retainedToken);
    if (!legacy) Object.assign(result, { descriptor_retention: 'retained', descriptor_outcome: stored.descriptor_outcome });
    Object.assign(result, { state: 'retained', bundle_retention: 'retained', receipt_retention: 'verified_pending',
      receipt_coverage_complete: stored.receipt_coverage_complete, registration: 'pending' });
    if (group.entries.length === 0) Object.assign(result, { bundle_retention: 'not_applicable_no_selected_scopes',
      receipt_retention: 'not_applicable_no_selected_scopes' });
    failureStage = 'control_registration';
    if (initializeControl) await updateManagedControl({ r2: derivedR2, command: { type: 'initialize' }, budget });
    const registration = await updateManagedControl({ r2: derivedR2, command: { type: legacy ? 'retain_prune_event' : 'retain_selected_prune_event' },
      ...(legacy ? { authenticatedPruneEvent: retainedToken } : { authenticatedSelectedEvent: retainedToken }), budget });
    return finish({ ...result, state: 'registered', registration: 'registered', registration_outcome: registration.outcome,
      control_operation: { revision: registration.latest.control.revision, operation_id: registration.latest.control.operation_id,
        sha256: registration.latest.sha256 }, handover_complete: true, retry: 'none',
      recovery: 'deterministic_original_event_replay' });
  } catch (error) {
    // Never include PG errors, original bytea, observation rows or R2 URLs.
    const recognised = error instanceof JSONgenEvidenceError || error instanceof JSONgenControlError;
    const errorClass = error instanceof JSONgenEvidenceError ? 'evidence_error'
      : error instanceof JSONgenControlError ? 'control_error'
        : error instanceof TypeError ? 'unexpected_type_error'
          : error instanceof RangeError ? 'unexpected_range_error'
            : error instanceof SyntaxError ? 'unexpected_syntax_error'
              : error instanceof Error ? 'unexpected_error' : 'unexpected_non_error';
    return finish({ ...result, state: 'reconciliation_required',
      reason: recognised ? error.code : 'consumer_boundary_rejected',
      detail: recognised ? error.message : 'Input rejected at the independent consumer boundary',
      failure_stage: failureStage, error_class: errorClass,
      retry: 'replay_original_event_after_resolving_failure',
      control_operation: error instanceof JSONgenControlError ? error.attempted || null : null,
    });
  }
}

const USAGE = `Manual explicitly configured independent Prune consumer (no automatic execution or schedule).
  --help
  --execute-read-only --event-key-file PATH --output PATH
  --execute-read-only --discover recent|resweep --from UTC --to UTC
    [--limit 1..16] [--cursor-file PATH] [--process] --output PATH
  --execute-retain --event-key-file PATH [--initialize-control] --output PATH
  --execute-retain --discover recent|resweep --from UTC --to UTC --process
    [--limit 1..16] [--cursor-file PATH] [--initialize-control] --output PATH
Keys contain the full immutable primary key. Cursor files contain next from a
previous page in the SAME window. Repeated windows and historical resweeps are
mandatory: accepted_at is insertion time, never a safe commit-order checkpoint.
Only complete authenticated original first-publication evidence qualifies.
Read-only success authenticates the WHOLE original event and plans selected
coverage in memory; it never creates receipts or completes registration.
Retain mode writes the all-original descriptor and selected complete-scope
bundles/receipts, then registers the entire group through one control CAS.
Existing registered schema-2 events retain their original replay identity. It never selects or generates monthly publications.`;

async function jsonFile(filename) {
  const stat = await fs.stat(filename);
  evidence(stat.isFile() && stat.size <= 16 * 1024, 'invalid_consumer_arguments', 'Bounded JSON input file required');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
export async function runPruneConsumer(argv, { env = process.env } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: USAGE };
  const options = {}; const flags = new Set(['execute-read-only', 'execute-retain', 'initialize-control', 'process']);
  const values = new Set(['event-key-file', 'discover', 'from', 'to', 'limit', 'cursor-file', 'output']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    evidence(argv[i].startsWith('--') && !Object.hasOwn(options, name) && (flags.has(name) || values.has(name)),
      'invalid_consumer_arguments', 'Unknown or repeated consumer option');
    if (flags.has(name)) options[name] = true;
    else {
      evidence(argv[i + 1] && !argv[i + 1].startsWith('--'), 'invalid_consumer_arguments', 'Consumer option requires a value');
      options[name] = argv[++i];
    }
  }
  evidence(Boolean(options['execute-read-only']) !== Boolean(options['execute-retain'])
    && Boolean(options['event-key-file']) !== Boolean(options.discover),
    'invalid_consumer_arguments', 'Exactly one explicit read/retain execution mode and event/discovery mode required');
  evidence(!options['initialize-control'] || options['execute-retain'], 'invalid_consumer_arguments', 'Control initialization requires retain mode');
  evidence(!options['execute-retain'] || options['event-key-file'] || options.process,
    'invalid_consumer_arguments', 'Retain discovery requires explicit event processing');
  evidence(options.output, 'invalid_consumer_arguments', 'Explicit private local result path required');
  assertOpsEnvironment(env);
  if (options['event-key-file']) evidence(!options.process && !options.from && !options.to && !options.limit && !options['cursor-file'],
    'invalid_consumer_arguments', 'Event replay cannot include discovery options');
  else evidence(['recent', 'resweep'].includes(options.discover) && options.from && options.to
    && (!options.limit || /^[1-9]\d?$/.test(options.limit)) && Number(options.limit || 4) <= 16,
  'invalid_consumer_arguments', 'Explicit bounded discovery window required');
  const key = options['event-key-file'] ? assertPruneAcceptanceKey(await jsonFile(options['event-key-file'])) : null;
  const after = options['cursor-file'] ? await jsonFile(options['cursor-file']) : null;
  const accessConfig = options['execute-retain'] ? managedR2WriteConfig : managedR2ReadConfig;
  const derivedR2 = key || options.process ? accessConfig(env) : null;
  const reader = await connectPruneOutboxReader({ env });
  const execution = { mode: options['execute-retain'] ? 'retain' : 'read-only', initializeControl: Boolean(options['initialize-control']) };
  try {
    let report;
    if (key) report = await consumePruneAcceptance({ reader, key, derivedR2, ...execution });
    else {
      const discovery = await reader.discover({ from: options.from, to: options.to, after,
        limit: Number(options.limit || 4), mode: options.discover });
      const results = [];
      // One page/invocation, serial bounded events, each with its own 120s cap.
      // Never advance a cursor to acknowledge processing or infer precedence.
      if (options.process) for (const event of discovery.events)
        results.push(await consumePruneAcceptance({ reader, key: event.key, derivedR2, ...execution }));
      const readOnlyComplete = execution.mode === 'read-only' && results.length > 0 && results.every(isReadOnlyPruneSuccess);
      report = { schema_version: 1, kind: 'uk_aq_jsongen_prune_consumer_discovery', discovery, results,
        state: readOnlyComplete ? 'authenticated_read_only'
          : results.length && results.every(r => r.handover_complete) ? 'registered' : 'reconciliation_required',
        read_only_complete: readOnlyComplete,
        handover_complete: false, discovery_coverage_complete: false, publication_eligible: false };
    }
    if (options.output) {
      const reportBody = `${JSON.stringify(report, null, 2)}\n`;
      evidence(Buffer.byteLength(reportBody) <= 4 * 1024 ** 2,
        'resource_limit', 'Consumer report size limit exceeded');
      await fs.mkdir(path.dirname(options.output), { recursive: true });
      const temporary = `${options.output}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, reportBody, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, options.output);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    return report;
  } finally { await reader.close(); }
}

export function pruneConsumerExitCode(report) {
  return report?.help || isReadOnlyPruneSuccess(report) || report?.state === 'registered' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runPruneConsumer(process.argv.slice(2));
    // Only bounded counts and failure codes go to logs; detailed partition and
    // original-event identities remain in the explicitly requested local report.
    console.log(JSON.stringify(report.help ? report : { state: report.state, reason: report.reason || null,
      events_discovered: report.discovery?.events?.length ?? null, event_id: report.event_id || null,
      physical_scope_count: report.physical_scope_count ?? null, observation_count: report.observation_count ?? null,
      partition_count: report.partitions?.partition_count ?? null,
      missing_authority: report.missing_authority?.map(g => g.code) || [],
      registration: report.registration || 'not_attempted', retry: report.retry || 'overlap_and_resweep',
      handover_complete: report.handover_complete === true, publication_eligible: false }));
    process.exitCode = pruneConsumerExitCode(report);
  } catch (error) {
    console.error(JSON.stringify({ state: 'reconciliation_required',
      reason: error instanceof JSONgenEvidenceError ? error.code : 'consumer_unavailable',
      detail: error instanceof JSONgenEvidenceError ? error.message : 'Private consumer failed; inspect configuration without logging credentials',
      handover_complete: false, publication_eligible: false }));
    process.exitCode = 2;
  }
}
