// Explicit manual configured read-only wrapper. Importing this file does no I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reconcileManagedInputs, reconciliationArtifact } from './reconcile.mjs';
import { reconcilePruneRegistrations } from './prune-registration.mjs';
import { registrationArtifact, assertPruneDiscoveryRequest } from './prune-registration-report.mjs';
import { readManagedControl, managedR2ReadConfig } from './control.mjs';
import { connectPruneOutboxReader } from './prune-outbox-reader.mjs';
import { assertOpsEnvironment } from './admission.mjs';
import { resolveObservationHistoryGeneration } from '../../workers/shared/uk_aq_observation_history_generation.mjs';
import { resolveR2HistoryIndexConfig } from '../../workers/shared/uk_aq_r2_history_index.mjs';
import { hasRequiredR2Config } from '../../workers/shared/r2_sigv4.mjs';
import { createInspectionBudget, createPruneHandoverBudget, evidence, JSONgenEvidenceError } from './limits.mjs';

const USAGE = `Manual explicitly configured JSONgen reconciliation (read-only).
Stage 3C currentness (default):
--execute-read-only --output PATH [--scopes-file PATH] [--retained-receipts-file PATH]
  [--inspection-partition 0..7]
  [--discover recent|resweep --from UTC --to UTC --limit 1..16 [--cursor-file PATH]]
Scope JSON is an array of {identity:{connector_id,timeseries_id,station_id,
pollutant_code},day_utc}, at most 1,024. Receipts are exact immutable descriptors,
at most 32 including control and discovered original partitions. Each metadata
invocation inspects one deterministic partition of at most 128 scopes. All other
scopes stay explicitly uninspected. Separate invocations have separate source-as-of
boundaries and must not be merged as one complete consistent inspection.
Uses explicitly configured canonical/derived R2 configuration and optional restricted
private Prune reader. Requires an existing managed control; never initializes it.
Requires explicit valid UK_AQ_ENV_NAME and the sourced UK_AQ_GITHUB_REPO. GitHub runs must
match that repository and use workflow_dispatch; missing configuration blocks.
Discovery is one overlapping page, never a completeness watermark. Repeat
overlapping windows and historical resweeps. Outputs private local JSON only.
Stage 3D Phase 1 registration coverage (separate private diagnostic v1):
--execute-read-only --prune-registration --output PATH
  --discover recent|resweep --from UTC --to UTC [--limit 1..16] [--cursor-file PATH]
This mode authenticates discovered AURN original events and compares complete
deterministic groups with exact retained references and one control snapshot.
It does not inspect current canonical metadata or accept scope/partition/receipt
inputs. Uses existing private READ credentials and restricted PostgreSQL reader;
no canonical R2 credentials required. Missing control gives unknown registration.
One shared existing 120s/192MiB original-handover budget covers the entire page;
32 receipt references and 1,024 distinct selected scopes maximum. Narrow the page
when capped. The report and exact control companion PATH.control.json are private
local files; stdout includes the report SHA-256/size. Exit 2 remains intentional.
Publication is disabled; no monthly generation, retention, registration or dispatch.`;

async function jsonFile(filename) {
  const stat = await fs.stat(filename);
  evidence(stat.isFile() && stat.size <= 1024 ** 2, 'invalid_inspection_arguments', 'Bounded local JSON file required');
  const body = await fs.readFile(filename);
  evidence(body.length <= 1024 ** 2, 'resource_limit', 'Input grew beyond its admitted size');
  return JSON.parse(body.toString('utf8'));
}

async function writePrivateFile(filename, body) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function runReconciliationInspection(argv, { env = process.env } = {}) {
  if (argv.length === 1 && argv[0] === '--help') return { help: USAGE };
  const options = {}, names = new Set(['output', 'scopes-file', 'retained-receipts-file', 'discover', 'from', 'to', 'limit', 'cursor-file', 'inspection-partition']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    evidence(argv[i].startsWith('--') && !Object.hasOwn(options, name), 'invalid_inspection_arguments', 'Unknown or repeated inspection option');
    if (['execute-read-only', 'prune-registration'].includes(name)) options[name] = true;
    else {
      evidence(names.has(name) && argv[i + 1] && !argv[i + 1].startsWith('--'),
        'invalid_inspection_arguments', 'Inspection option requires a value');
      options[name] = argv[++i];
    }
  }
  evidence(options['execute-read-only'] && options.output, 'invalid_inspection_arguments', 'Explicit read-only execution and private local output required');
  evidence(!options['inspection-partition'] || /^[0-7]$/.test(options['inspection-partition']),
    'invalid_inspection_arguments', 'Inspection partition must be 0..7');
  assertOpsEnvironment(env);
  evidence(options.discover ? ['recent', 'resweep'].includes(options.discover) && options.from && options.to
    && (!options.limit || /^[1-9]\d?$/.test(options.limit)) && Number(options.limit || 4) <= 16
    : !options.from && !options.to && !options.limit && !options['cursor-file'],
  'invalid_inspection_arguments', 'Explicit bounded discovery window required');
  if (options['prune-registration']) {
    evidence(options.discover && !options['scopes-file'] && !options['retained-receipts-file'] && !options['inspection-partition'],
      'invalid_inspection_arguments', 'Prune registration requires discovery only, without currentness inspection inputs');
    const pruneDiscovery = assertPruneDiscoveryRequest({ from: options.from, to: options.to, mode: options.discover,
      limit: Number(options.limit || 4), after: options['cursor-file'] ? await jsonFile(options['cursor-file']) : null });
    const derivedR2 = managedR2ReadConfig(env), budget = createPruneHandoverBudget();
    let reader = null;
    try {
      // Connection/privilege failures remain unavailable discovery, rather than
      // inventing an empty outbox page or logging a raw database exception.
      if (env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL) {
        try { reader = await connectPruneOutboxReader({ env }); } catch { /* reported as unavailable below */ }
      }
      const { report, controlBody, artifact } = await reconcilePruneRegistrations({ derivedR2, pruneReader: reader, pruneDiscovery, budget });
      // Companion bytes are exactly those compared, never a later control GET.
      if (controlBody) await writePrivateFile(`${options.output}.control.json`, controlBody);
      await writePrivateFile(options.output, artifact.body);
      return report;
    } finally { if (reader) await reader.close(); }
  }
  const generation = resolveObservationHistoryGeneration(env);
  evidence(generation.version === 'v3', 'invalid_canonical_configuration', 'Selected complete-v3 generation required');
  const { r2 } = resolveR2HistoryIndexConfig(env);
  const endpoint = new URL(r2.endpoint);
  evidence(hasRequiredR2Config(r2) && endpoint.protocol === 'https:'
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
    && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password,
  'invalid_canonical_configuration', 'Existing private canonical R2 configuration required');
  const derivedR2 = managedR2ReadConfig(env), budget = createInspectionBudget();
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
    await writePrivateFile(options.output, body);
    return report;
  } finally { if (reader) await reader.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runReconciliationInspection(process.argv.slice(2));
    const artifact = result.kind === 'uk_aq_jsongen_prune_registration_diagnostic' ? registrationArtifact(result) : null;
    console.log(JSON.stringify(result.help ? result : artifact
      ? { state: result.state, events_discovered: result.events.length,
        classifications: result.events.map(e => e.classification), control_state: result.control.state,
        control_sha256: result.control.snapshot?.sha256 || null,
        report_sha256: artifact.sha256, report_byte_size: artifact.byte_size,
        writer_coverage: result.writer_coverage, publication_eligible: false }
      : { state: result.state,
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
