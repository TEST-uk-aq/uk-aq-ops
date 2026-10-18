// Explicit manual TEST read-only wrapper. Importing this file does no I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reconcileManagedInputs, reconciliationArtifact } from './reconcile.mjs';
import { readManagedControl, managedR2Config } from './control.mjs';
import { connectPruneOutboxReader } from './prune-outbox-reader.mjs';
import { resolveObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { resolveR2HistoryIndexConfig } from '../../workers/shared/uk_aq_r2_history_index.mjs';
import { hasRequiredR2Config } from '../../workers/shared/r2_sigv4.mjs';
import { createInspectionBudget, evidence, JSONgenEvidenceError } from './limits.mjs';

const USAGE = `Manual TEST-only JSONgen Stage 3C reconciliation (read-only).
--execute-read-only --output PATH [--scopes-file PATH] [--retained-receipts-file PATH]
  [--inspection-partition 0..7]
  [--discover recent|resweep --from UTC --to UTC --limit 1..16 [--cursor-file PATH]]
Scope JSON is an array of {identity:{connector_id,timeseries_id,station_id,
pollutant_code},day_utc}, at most 1,024. Receipts are exact immutable descriptors,
at most 32 including control and discovered original partitions. Each metadata
invocation inspects one deterministic partition of at most 128 scopes. All other
scopes stay explicitly uninspected. Separate invocations have separate source-as-of
boundaries and must not be merged as one complete consistent inspection.
Uses existing TEST canonical/derived R2 configuration and optional restricted
private Prune reader. Requires an existing managed control; never initializes it.
Discovery is one overlapping page, never a completeness watermark. Repeat
overlapping windows and historical resweeps. Outputs private local JSON only.
Publication is disabled; no monthly generation, retention, registration or dispatch.`;

async function jsonFile(filename) {
  const stat = await fs.stat(filename);
  evidence(stat.isFile() && stat.size <= 1024 ** 2, 'invalid_inspection_arguments', 'Bounded local JSON file required');
  const body = await fs.readFile(filename);
  evidence(body.length <= 1024 ** 2, 'resource_limit', 'Input grew beyond its admitted size');
  return JSON.parse(body.toString('utf8'));
}

export async function runReconciliationInspection(argv, { env = process.env } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: USAGE };
  const options = {}, names = new Set(['output', 'scopes-file', 'retained-receipts-file', 'discover', 'from', 'to', 'limit', 'cursor-file', 'inspection-partition']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    evidence(argv[i].startsWith('--') && !Object.hasOwn(options, name), 'invalid_inspection_arguments', 'Unknown or repeated inspection option');
    if (name === 'execute-read-only') options[name] = true;
    else {
      evidence(names.has(name) && argv[i + 1] && !argv[i + 1].startsWith('--'),
        'invalid_inspection_arguments', 'Inspection option requires a value');
      options[name] = argv[++i];
    }
  }
  evidence(options['execute-read-only'] && options.output, 'invalid_inspection_arguments', 'Explicit read-only execution and private local output required');
  evidence(!options['inspection-partition'] || /^[0-7]$/.test(options['inspection-partition']),
    'invalid_inspection_arguments', 'Inspection partition must be 0..7');
  evidence(env.UK_AQ_ENV_NAME === 'TEST' && (!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY === 'TEST-uk-aq/uk-aq-ops'),
    'unapproved_environment', 'Manual inspection is TEST Ops only');
  evidence(options.discover ? ['recent', 'resweep'].includes(options.discover) && options.from && options.to
    && (!options.limit || /^[1-9]\d?$/.test(options.limit)) && Number(options.limit || 4) <= 16
    : !options.from && !options.to && !options.limit && !options['cursor-file'],
  'invalid_inspection_arguments', 'Explicit bounded discovery window required');
  const generation = resolveObservationHistoryGeneration(env);
  evidence(generation.version === 'v3', 'invalid_canonical_configuration', 'Selected complete-v3 generation required');
  const { r2 } = resolveR2HistoryIndexConfig(env);
  const endpoint = new URL(r2.endpoint);
  evidence(hasRequiredR2Config(r2) && endpoint.protocol === 'https:'
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
    && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password,
  'invalid_canonical_configuration', 'Existing private canonical R2 configuration required');
  const derivedR2 = managedR2Config(env), budget = createInspectionBudget();
  const requestedScopes = options['scopes-file'] ? await jsonFile(options['scopes-file']) : [];
  const retainedReceipts = options['retained-receipts-file'] ? await jsonFile(options['retained-receipts-file']) : [];
  const pruneDiscovery = options.discover ? { from: options.from, to: options.to, mode: options.discover,
    limit: Number(options.limit || 4), after: options['cursor-file'] ? await jsonFile(options['cursor-file']) : null } : null;
  // A missing control is a missing authority, never an invitation to synthesize
  // an empty revision or initialize real control during a diagnostic.
  const controlRead = await readManagedControl(derivedR2, { budget });
  evidence(controlRead, 'managed_control_unavailable', 'Existing managed control is unavailable; no control was initialized');
  let reader = null;
  try {
    if (env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL) reader = await connectPruneOutboxReader({ env });
    const report = await reconcileManagedInputs({ derivedR2, control: controlRead.control, controlRead,
      canonical: { r2, generation }, requestedScopes, retainedReceipts, pruneReader: reader, pruneDiscovery,
      inspectionPartition: Number(options['inspection-partition'] || 0), budget });
    const { body } = reconciliationArtifact(report, budget);
    evidence(body.length <= budget.limits.report_bytes, 'resource_limit', 'Private report exceeds existing output limit');
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    const temporary = `${options.output}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, options.output); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    return report;
  } finally { if (reader) await reader.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runReconciliationInspection(process.argv.slice(2));
    console.log(JSON.stringify(result.help ? result : { state: result.state,
      physical_scopes: result.canonical?.scopes.length || 0,
      read_consistent: result.canonical?.read_consistent || false,
      writer_coverage: result.stage3c.writer_coverage, publication_eligible: false }));
    if (!result.help) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ state: 'reconciliation_required',
      reason: error instanceof JSONgenEvidenceError ? error.code : 'inspection_unavailable',
      publication_eligible: false }));
    process.exitCode = 2;
  }
}
