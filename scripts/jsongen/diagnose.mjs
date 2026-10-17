// Independently runnable, import-safe Stage A. No remote helper is invoked here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ALGORITHM, ROOT, ORDERING_BLOCKER, canonicalJson } from './schema.mjs';
import { createBudget } from './limits.mjs';
import { assertDiagnosticReport, DIAGNOSTIC_SELECTION, AUTHORITY_BLOCKERS,
  UNAVAILABLE_CAPABILITIES, REMOTE_ACCESS, LIBRARIES, INSTALLED_ONLY } from './diagnostic-report.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultOutput = resolve(repoRoot, 'tmp/jsongen-diagnostic');
const admittedArguments = {
  '--environment': 'TEST', '--connector-id': '1', '--timeseries-id': '212',
  '--pollutant': 'pm25', '--month-utc': '2026-09',
};
function fail(code) { const error = new Error(code); error.diagnosticCode = code; throw error; }
function runNumber(value) { return /^[1-9]\d{0,19}$/.test(value || '') ? value : null; }

export async function diagnose(argv, { env = process.env } = {}) {
  const started = performance.now();
  const budget = createBudget();
  const report = {
    schema_version: 1, report_version: 1, kind: 'uk_aq_jsongen_stage_a_diagnostic',
    environment: 'TEST',
    run: { github_run_id: runNumber(env.GITHUB_RUN_ID),
      github_run_attempt: runNumber(env.GITHUB_RUN_ATTEMPT), source_commit_sha: null },
    implementation: null, selection: null, invocation_mode: 'local_diagnostic', duration_ms: 0,
    diagnostic_results: [], capabilities: { available: [], unavailable: [...UNAVAILABLE_CAPABILITIES] },
    authorities: AUTHORITY_BLOCKERS.map(authority => ({ authority, state: 'not_established',
      reason: 'authenticated_remote_evidence_unavailable_in_stage_a' })),
    authority_blockers: [...AUTHORITY_BLOCKERS, ORDERING_BLOCKER], remote_access: REMOTE_ACCESS,
    publication_eligible: false, selector: { state: 'disabled', blocker: ORDERING_BLOCKER,
      current_publication: 'not_inspected' },
    readiness: 'diagnostic_failed', outcome: 'error', error_code: null,
  };
  try {
    const supplied = {};
    if (!Array.isArray(argv) || argv.length !== Object.keys(admittedArguments).length * 2)
      fail('invalid_arguments');
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!Object.hasOwn(admittedArguments, key) || Object.hasOwn(supplied, key)
        || argv[i + 1] !== admittedArguments[key]) fail('scope_not_admitted');
      supplied[key] = argv[i + 1];
    }
    if (env.UKAQ_ENV_NAME !== undefined && env.UKAQ_ENV_NAME !== 'TEST') fail('test_environment_required');
    if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REPOSITORY !== 'TEST-uk-aq/uk-aq-ops'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.UKAQ_ENV_NAME !== 'TEST'
      || report.run.github_run_id === null || report.run.github_run_attempt === null))
      fail('github_test_dispatch_required');
    report.selection = { ...DIAGNOSTIC_SELECTION };
    report.diagnostic_results.push({ code: 'test_scope_admitted', status: 'passed' });
    report.capabilities.available.push('scope_admission');

    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)
      || (env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA !== commit)) fail('source_commit_unavailable');
    report.run.source_commit_sha = commit;
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    if (pkg.name !== 'uk-aq-ops' || Number(process.versions.node.split('.')[0]) < 20)
      fail('incompatible_implementation');
    report.diagnostic_results.push({ code: 'implementation_identified', status: 'passed' });

    const modules = [];
    for (const { file, exports: expected } of [...LIBRARIES, ...INSTALLED_ONLY.map(file => ({ file }))]) {
      budget.check();
      const url = new URL(file, import.meta.url);
      // Local availability inspection only. No reader/authenticator is called with
      // synthetic control, receipts or source evidence. Mutating modules stay unimported.
      const bytes = await readFile(url);
      if (bytes.length > 256 * 1024) fail('implementation_file_too_large');
      if (expected) {
        const library = await import(url.href);
        if (!expected.every(name => typeof library[name] === 'function')) fail('library_exports_unavailable');
      }
      modules.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'),
        status: expected ? 'imported_exports_available' : 'installed_not_imported' });
    }
    report.implementation = { package_name: pkg.name, package_version: pkg.version,
      node_version: process.version, managed_schema_version: 1, managed_root: ROOT,
      aqi_algorithm_version: ALGORITHM, modules };
    report.diagnostic_results.push({ code: 'managed_libraries_available', status: 'passed' });
    report.capabilities.available.push('installed_library_inspection', 'bounded_local_reporting');
    budget.check();
    report.outcome = 'success'; report.readiness = 'diagnostic_passed_publication_blocked';
  } catch (error) {
    // Never serialize arbitrary errors, arguments, environment values or source bodies.
    report.error_code = error.diagnosticCode || (error.code === 'resource_limit'
      ? 'resource_limit' : 'implementation_inspection_failed');
    report.diagnostic_results.push({ code: report.error_code, status: 'failed' });
  }
  report.duration_ms = Math.ceil(performance.now() - started);
  return assertDiagnosticReport(report);
}

export function diagnosticSummary(report) {
  assertDiagnosticReport(report);
  const scope = report.selection ? '1 / 212 / pm25 / 2026-09' : 'rejected';
  return `## Managed JSONgen Stage A diagnostic\n\n`
    + `- Outcome: **${report.outcome}** (${report.readiness})\n`
    + `- Environment: TEST; scope: ${scope}\n`
    + `- Source commit: ${report.run.source_commit_sha || 'unavailable'}\n`
    + `- Duration: ${report.duration_ms} ms\n`
    + `- Publication eligible: **false**; selector: **disabled**\n`
    + `- Data-service remote reads/writes: **0 / 0**; runner setup/artifacts not measured\n`
    + `- Authority blockers: ${report.authority_blockers.join(', ')}\n`
    + (report.error_code ? `- Error: ${report.error_code}\n` : '')
    + `\nSuccess establishes local diagnostic availability only. No managed publication is accepted.\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const report = await diagnose(argv);
  await mkdir(defaultOutput, { recursive: true });
  await writeFile(resolve(defaultOutput, 'report.json'), canonicalJson(report));
  await writeFile(resolve(defaultOutput, 'summary.md'), diagnosticSummary(report));
  console.log(JSON.stringify({ kind: report.kind, outcome: report.outcome,
    readiness: report.readiness, publication_eligible: false, error_code: report.error_code }));
  return report.outcome === 'success' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('JSONgen Stage A diagnostic could not produce its local report.');
    process.exitCode = 1;
  });
}
