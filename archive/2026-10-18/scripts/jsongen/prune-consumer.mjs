// Manual-only, read-only Stage 3B safe boundary. No import starts remote work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connectPruneOutboxReader, assertPruneAcceptanceKey, originalPruneAcceptance } from './prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from './prune-consumer-authentication.mjs';
import { planPruneScopePartitions } from './prune-consumer-partitions.mjs';
import { managedR2Config } from './control.mjs';
import { createBudget, evidence, JSONgenEvidenceError } from './limits.mjs';

export async function consumePruneAcceptance({ reader, key, derivedR2, budget = createBudget() }) {
  key = structuredClone(assertPruneAcceptanceKey(key));
  const result = { schema_version: 1, kind: 'uk_aq_jsongen_prune_consumer_result', key,
    state: 'pending', discovery: 'original_primary_key_replay', original_evidence: 'pending',
    pending_source: 'pending', physical_scope_count: null, observation_count: null,
    partitions: null, bundle_retention: 'not_attempted', receipt_retention: 'not_attempted',
    registration: 'not_attempted', retry: 'original_primary_key_replay',
    receipt_eligible: false, handover_complete: false, publication_eligible: false,
    current_canonical_authority: 'not_inspected', supersession: 'not_evaluated' };
  try {
    const acceptance = await reader.read(key);
    if (!acceptance) return { ...result, state: 'incomplete', reason: 'original_acceptance_not_visible',
      retry: 'overlapping_discovery_and_periodic_historical_resweep' };
    originalPruneAcceptance(acceptance); // Reject a caller-invented reader result before reporting any authority.
    result.event_id = acceptance.event_id;
    result.original_evidence = 'original_gate_authenticated';
    const handover = await authenticatePruneHandover({ acceptance, derivedR2, budget });
    const { result: authentication } = inspectAuthenticatedPruneHandover(handover);
    Object.assign(result, { original_evidence: authentication.original_final_evidence,
      pending_source: authentication.pending_source, physical_scope_count: authentication.physical_scope_count,
      observation_count: authentication.observation_count, authentication,
      missing_authority: authentication.missing_authority });
    result.partitions = planPruneScopePartitions({ handover, budget });
    // The immutable original event and confirmed pending object already survive
    // interruption. Do not create a parallel receipt register or mint weakened
    // Stage 1 receipts to work around missing original writer authority.
    return { ...result, state: 'reconciliation_required', reason: 'mandatory_original_receipt_authority_missing',
      registration: 'blocked_missing_original_authority', retry: 'requires_writer_evidence_or_accepted_versioned_contract',
      recovery: 'replay_existing_original_event_and_pending_source_without_prune_rerun', resources: budget.snapshot() };
  } catch (error) {
    // Never include PG errors, original bytea, observation rows or R2 URLs.
    return { ...result, state: 'reconciliation_required',
      reason: error instanceof JSONgenEvidenceError ? error.code : 'consumer_boundary_rejected',
      detail: error instanceof JSONgenEvidenceError ? error.message : 'Input rejected at the independent consumer boundary',
      resources: budget.snapshot() };
  }
}

const USAGE = `Manual TEST-only independent Prune consumer (read-only; no schedule).
  --help
  --execute-read-only --event-key-file PATH --output PATH
  --execute-read-only --discover recent|resweep --from UTC --to UTC
    [--limit 1..16] [--cursor-file PATH] [--process] --output PATH
Keys contain the full immutable primary key. Cursor files contain next from a
previous page in the SAME window. Repeated windows and historical resweeps are
mandatory: accepted_at is insertion time, never a safe commit-order checkpoint.
No VERIFIED receipt can be created from the currently retained schema-1 proof.`;

async function jsonFile(filename) {
  const stat = await fs.stat(filename);
  evidence(stat.isFile() && stat.size <= 16 * 1024, 'invalid_consumer_arguments', 'Bounded JSON input file required');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
export async function runPruneConsumer(argv, { env = process.env } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: USAGE };
  const options = {}; const flags = new Set(['execute-read-only', 'process']);
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
  evidence(options['execute-read-only'] && Boolean(options['event-key-file']) !== Boolean(options.discover),
    'invalid_consumer_arguments', 'Explicit read-only execution and exactly one event/discovery mode required');
  evidence(options.output, 'invalid_consumer_arguments', 'Explicit private local result path required');
  evidence(env.UK_AQ_ENV_NAME === 'TEST', 'unapproved_environment', 'TEST environment required');
  if (options['event-key-file']) evidence(!options.process && !options.from && !options.to && !options.limit && !options['cursor-file'],
    'invalid_consumer_arguments', 'Event replay cannot include discovery options');
  else evidence(['recent', 'resweep'].includes(options.discover) && options.from && options.to
    && (!options.limit || /^[1-9]\d?$/.test(options.limit)) && Number(options.limit || 4) <= 16,
  'invalid_consumer_arguments', 'Explicit bounded discovery window required');
  const key = options['event-key-file'] ? assertPruneAcceptanceKey(await jsonFile(options['event-key-file'])) : null;
  const after = options['cursor-file'] ? await jsonFile(options['cursor-file']) : null;
  const derivedR2 = key || options.process ? managedR2Config(env) : null;
  const reader = await connectPruneOutboxReader({ env });
  try {
    let report;
    if (key) report = await consumePruneAcceptance({ reader, key, derivedR2 });
    else {
      const discovery = await reader.discover({ from: options.from, to: options.to, after,
        limit: Number(options.limit || 4), mode: options.discover });
      const results = [];
      // One page/invocation, serial bounded events, each with its own 60s cap.
      // Never advance a cursor to acknowledge processing or infer precedence.
      if (options.process) for (const event of discovery.events)
        results.push(await consumePruneAcceptance({ reader, key: event.key, derivedR2 }));
      report = { schema_version: 1, kind: 'uk_aq_jsongen_prune_consumer_discovery', discovery, results,
        state: 'reconciliation_required', handover_complete: false, publication_eligible: false };
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
      handover_complete: false, publication_eligible: false }));
    if (!report.help) process.exitCode = 2; // Read success is not a completed handover.
  } catch (error) {
    console.error(JSON.stringify({ state: 'reconciliation_required',
      reason: error instanceof JSONgenEvidenceError ? error.code : 'consumer_unavailable',
      detail: error instanceof JSONgenEvidenceError ? error.message : 'Private consumer failed; inspect configuration without logging credentials',
      handover_complete: false, publication_eligible: false }));
    process.exitCode = 2;
  }
}
