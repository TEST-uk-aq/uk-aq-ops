#!/usr/bin/env node
// Read-only immutable-generation verifier. No migration/resume/repair entry point.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertLoadedLiveEnvironment, assertLiveRepository } from './index_v3_live_immutable_verify.mjs';
import { selectedCutoverGeneration, verifySelectedCutoverMetadata } from './index_v3_cutover_generation_evidence.mjs';
import { createSideBySideLockAssertion } from '../backup_r2/uk_aq_observation_history_migration_v3.mjs';
import { verifySideBySideSourceRoot } from '../backup_r2/lib/observation_history_migration_v3.mjs';
import { VerificationStore, readJsonBounded, MiB, GiB, demand, fileIdentity, same } from './bounded_verify_store.mjs';
import { readBoundedBaseline } from './bounded_verify_baseline.mjs';
import { boundedR2Reads, verifyBoundedDependencies, verifyBoundedLogicalOutput } from './bounded_verify_r2.mjs';
import { envelope } from './bounded_verify_journal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = `Usage (only inside the existing supervised global observations lock):
  node --max-old-space-size=4096 scripts/index_v3_migration/index_v3_bounded_immutable_verify.mjs \\
    --phase pre-cutover|read-cutover --expected-repository-git-sha SHA \\
    --expected-bucket BUCKET --plan-report PATH --checkpoint PATH \\
    --evidence-root PATH --scratch-directory PATH [--environment LIVE|TEST] \\
    [--r2-concurrency 1] [--batch-size 128] [--max-object-mib 128] \\
    [--max-file-rows 250000] [--max-uncompressed-mib 256] \\
    [--max-scratch-gib 32] [--cleanup-on-success true|false]

LIVE is the default. TEST is for separately authorised real TEST acceptance.
Scratch is disposable, outside evidence/Dropbox/repository; no prior results
are resumed. Limit exhaustion fails closed, never samples or skips evidence.
No full-run timeout; the existing lock coordinator/heartbeat/supervisor must
remain alive. Read-cutover must precede the first normal v3-only write.
`;

export function parseBoundedVerifyArgs(argv) {
  const allowed = new Set(['phase', 'expected-repository-git-sha', 'expected-bucket', 'plan-report', 'checkpoint',
    'evidence-root', 'scratch-directory', 'environment', 'r2-concurrency', 'batch-size', 'max-object-mib',
    'max-file-rows', 'max-uncompressed-mib', 'max-scratch-gib', 'cleanup-on-success']);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2), value = argv[index + 1];
    demand(argv[index]?.startsWith('--') && allowed.has(name) && !Object.hasOwn(args, name) && value && !value.startsWith('--'),
      `Missing, repeated or unsupported bounded verifier argument: ${argv[index]}`);
    args[name] = value;
  }
  for (const name of ['phase', 'expected-repository-git-sha', 'expected-bucket', 'plan-report', 'checkpoint', 'scratch-directory'])
    demand(args[name], `Missing required --${name}`);
  demand(['pre-cutover', 'read-cutover'].includes(args.phase) && /^[0-9a-f]{40}$/.test(args['expected-repository-git-sha']),
    'Exact reviewed Git SHA and pre-cutover/read-cutover phase required');
  args.environment ||= 'LIVE';
  demand(['LIVE', 'TEST'].includes(args.environment), 'Environment must be LIVE or TEST');
  const integer = (name, fallback, max) => {
    const value = args[name] === undefined ? fallback : Number(args[name]);
    demand(Number.isSafeInteger(value) && value >= 1 && value <= max, `Invalid --${name} (1..${max})`); return value;
  };
  args.concurrency = integer('r2-concurrency', 1, 4);
  args.batchSize = integer('batch-size', 128, 1024);
  args.maxObjectBytes = integer('max-object-mib', 128, 256) * MiB;
  args.maxFileRows = integer('max-file-rows', 250000, 500000);
  args.maxUncompressedBytes = integer('max-uncompressed-mib', 256, 512) * MiB;
  args.maxScratchBytes = integer('max-scratch-gib', 32, 256) * GiB;
  demand(args['cleanup-on-success'] === undefined || ['true', 'false'].includes(args['cleanup-on-success']), 'Invalid cleanup option');
  args.cleanupOnSuccess = args['cleanup-on-success'] === 'true';
  return args;
}

function assertTestRepositoryAndEnvironment(args, generation) {
  const env = process.env, repository = 'TEST-uk-aq/uk-aq-ops';
  const names = [env.UKAQ_ENV_NAME, env.UK_AQ_ENV_NAME, env.ENVIRONMENT].filter((value) => String(value || '').trim());
  demand(names.length && names.every((value) => value.trim().toUpperCase() === 'TEST') &&
    env.UK_AQ_R2_HISTORY_VERSION === generation && env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION === 'v2' &&
    env.CFLARE_R2_BUCKET === args['expected-bucket'] && env.CFLARE_R2_BUCKET !== 'uk-aq-history-live',
  'Explicit TEST environment/generation/bucket required');
  const endpoint = new URL(env.CFLARE_R2_ENDPOINT);
  demand(endpoint.protocol === 'https:' && /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) &&
    !endpoint.hostname.startsWith('7e20426335c509cc77483210fa7ead0f.') && endpoint.pathname === '/' &&
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
    env.CFLARE_R2_ACCESS_KEY_ID && env.CFLARE_R2_SECRET_ACCESS_KEY, 'Explicit loaded TEST R2 account/credentials required');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20000 }).trim();
  demand(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)TEST-uk-aq\/uk-aq-ops(?:\.git)?\/?$/.test(git(['remote', 'get-url', 'origin'])) &&
    git(['branch', '--show-current']) === 'main' && git(['rev-parse', 'HEAD']) === args['expected-repository-git-sha'] &&
    !git(['status', '--porcelain=v1', '--untracked-files=normal']), 'TEST verifier requires clean reviewed TEST main');
  const gh = (command) => execFileSync('gh', command, { cwd: root, encoding: 'utf8', timeout: 20000 }).trim();
  demand(gh(['api', `repos/${repository}/commits/main`, '--jq', '.sha']) === args['expected-repository-git-sha'] &&
    gh(['variable', 'get', 'UKAQ_ENV_NAME', '--repo', repository]).toUpperCase() === 'TEST' &&
    gh(['variable', 'get', 'UK_AQ_R2_HISTORY_VERSION', '--repo', repository]) === generation,
  'Independently read TEST repository authority differs');
}

export async function verifyBoundedImmutableGeneration({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
  const args = parseBoundedVerifyArgs(argv);
  const generation = args.phase === 'pre-cutover' ? 'v2' : 'v3';
  if (args.environment === 'LIVE') {
    demand(args['expected-bucket'] === 'uk-aq-history-live', 'Reviewed LIVE bucket required');
    assertLoadedLiveEnvironment(args.phase); assertLiveRepository(args['expected-repository-git-sha'], generation);
  } else assertTestRepositoryAndEnvironment(args, generation);
  const report = readJsonBounded(path.resolve(args['plan-report']), 4 * MiB).value;
  demand(typeof report?.result?.migration_run_id === 'string' && report.result.migration_run_id.trim(), 'Plan report migration run ID missing');
  const lockAssertion = createSideBySideLockAssertion({ env: process.env, migrationRunId: report?.result?.migration_run_id });
  const lock = lockAssertion();
  let interrupted = null, store = null, completed = false;
  const stop = (signal) => { interrupted ||= new Error(`INTERRUPTED: ${signal}; all R2 evidence must be repeated under a new supervised session`); };
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  const assertHeld = () => { if (interrupted) throw interrupted; lockAssertion(); };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    store = await VerificationStore.open({ scratchDirectory: args['scratch-directory'],
      evidenceDirectory: path.dirname(path.resolve(args.checkpoint)), repositoryRoot: root, assertHeld,
      batchSize: args.batchSize, maxScratchBytes: args.maxScratchBytes });
    process.stderr.write(`Disposable verification scratch: ${store.root}\n`);
    store.progress(true);
    const baseline = await readBoundedBaseline({ checkpointPath: path.resolve(args.checkpoint), planReport: report,
      evidenceRoot: args['evidence-root'] || null, store, repositoryRoot: root, environment: args.environment,
      bucket: args['expected-bucket'] });
    const r2 = { endpoint: process.env.CFLARE_R2_ENDPOINT, bucket: args['expected-bucket'], region: process.env.CFLARE_R2_REGION || 'auto',
      access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID, secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY };
    const reads = boundedR2Reads({ r2, store, maxObjectBytes: args.maxObjectBytes });
    store.phase = 'verify-source-root-before';
    await verifySideBySideSourceRoot({ plan: baseline.plan, getObject: reads.getObject });
    await verifyBoundedDependencies({ baseline, reads, concurrency: args.concurrency });
    await verifyBoundedLogicalOutput({ baseline, reads, maxFileRows: args.maxFileRows, maxUncompressedBytes: args.maxUncompressedBytes });
    let selectedMetadata = null;
    if (args.phase === 'read-cutover') selectedMetadata = await verifySelectedCutoverMetadata({
      generation: selectedCutoverGeneration(process.env), ...reads });
    store.phase = 'final-source-and-evidence-anchors';
    await verifySideBySideSourceRoot({ plan: baseline.plan, getObject: reads.getObject });
    demand(same(await fileIdentity(args.checkpoint, assertHeld), {
      sha256: baseline.provenance.sha256, byte_size: baseline.provenance.byte_size }), 'Original checkpoint changed during verification');
    demand(envelope(path.join(baseline.journal.root, 'head.json'), baseline.journal.head.kind).identity.sha256 === baseline.journal.headIdentity.sha256 &&
      envelope(path.join(baseline.journal.root, 'manifest.json'), baseline.journal.manifest.kind).identity.sha256 === baseline.journal.manifestIdentity.sha256,
    'Recovery anchors changed during verification');
    demand(!store.get('SELECT key FROM objects WHERE verified!=1 LIMIT 1') &&
      store.counters.logical_partitions === baseline.unitCount, 'Incomplete verification cannot PASS');
    assertHeld();
    const result = { ok: true, state: 'COMPLETED', phase: args.phase, environment: args.environment, bucket: args['expected-bucket'],
      selected_generation: generation, immutable_migration_verified: true, source_root_unchanged: true,
      complete_v3_dependency_closure: true, recovery_reconciliation: { mode: 'EXACT', fail: 0, legacy_recovery_ordering: 0 },
      historical_migration_writer_git_sha: baseline.plan.target_writer_git_sha,
      current_verifier_git_sha: args['expected-repository-git-sha'], migration_run_id: baseline.plan.migration_run_id,
      plan_sha256: baseline.plan.plan_sha256, publication_schedule_sha256: baseline.scheduleSha256,
      checkpoint_evidence: baseline.provenance, selected_metadata: selectedMetadata,
      counters: store.counters, elapsed_seconds: Math.floor((Date.now() - store.started) / 1000),
      supervised_lock_session: { owner: lock.owner, run_id: lock.run_id, nonce: lock.nonce },
      accepted_only_with_successful_lock_coordinator_exit: true,
      deployed_path_verified: false, normal_v3_write_permitted: false, runtime_switch_performed: false };
    // One final result; progress has no ok/PASS field. A killed invocation leaves
    // IN_PROGRESS/INTERRUPTED and cannot supply a successful coordinator exit.
    store.state = 'VERIFIED_PENDING_COORDINATOR'; store.phase = 'finalise-result'; store.progress(true);
    assertHeld(); store.close(); assertHeld();
    process.stdout.write(JSON.stringify(result) + '\n'); completed = true;
    return 0;
  } catch (error) {
    if (store?.db) {
      store.state = interrupted ? 'INTERRUPTED' : 'FAILED';
      try { store.progress(true); } catch { /* Disk exhaustion must not hide original failure. */ }
    }
    process.stderr.write(JSON.stringify({ ok: false, state: interrupted ? 'INTERRUPTED' : 'FAILED',
      phase: store?.phase || 'admission', reason: error.message, cause: error.cause?.message || null,
      accepted_result: false, repeat_all_r2_checks: true }) + '\n');
    throw error;
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    try { store?.close(); } finally {
      if (completed && args.cleanupOnSuccess) fs.rmSync(store.root, { recursive: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBoundedImmutableGeneration().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
  });
}
