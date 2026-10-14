#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { admitGcpRunner, GCP_PROFILE } from './lib/observation_history_migration_gcp.mjs';
import { main as sharedMain } from './uk_aq_observation_history_migration_v3.mjs';
import { superviseOperatorInvocation, finishOperatorProgress } from '../index_v3_migration/operator_execution.mjs';

const HELP = `Usage:
  node scripts/backup_r2/uk_aq_observation_history_migration_v3_gcp.mjs [options]

GCP-only complete TEST v2-to-v3 clean build. GCE metadata admission is mandatory
before any planning/R2 access, including in the child holding the global lock.
  --runner-profile gcp-c4a-32  Supported profile (default: gcp-c4a-32)
  c4a-standard-32, arm64, >=32 available CPUs, >=120 GiB visible RAM
  --partition-concurrency <1..24>    Persistent CPU workers (default: 16)
  --publication-concurrency <1..96> Independent publications/reads (default: 64)
  --inventory-concurrency <1..64>    Source inventory reads (default: 32)
  --mode locked-clean-build --apply --writers-frozen --checkpoint-out PATH
    --post-plan-approval-file PATH    One lock through approval and verification

Detected instance/project/zone/machine identity and visible resources are reported
at admission and recorded with concurrency in the audit and initial authority.
Clean empty-v3 target is mandatory: canonical observations, exact indexes,
bindings, latest metadata, and v3 observation operational records.
Planning checks emptiness; fresh migrate rechecks under the global lock before
the first v3 write. No automatic deletion. Non-empty targets require manual cleanup.
Interrupted normal GCP builds restart from a manually proven clean target and a
new run ID. Authenticated resume is exceptional engineering work only.

Required shared options:
  --mode plan|migrate|verify|locked-clean-build --environment TEST --transition v2-to-v3
  --expected-bucket <exact TEST bucket> --migration-run-id <stable run ID>
  --target-writer-git-sha <exact reviewed writer commit>
  --writer-limits-json <accepted limits JSON> --report-out <audit JSON>
  --expected-plan-sha256 <plan hash>  Required for migrate/verify
  --apply --writers-frozen --checkpoint-out <path>  Required for migrate
  --checkpoint-in <path>  Required for separate verify; exceptional resume only
  Combined mode requires a new checkpoint-out and post-plan approval file.

No deployment, deletion, runtime authority switch or LIVE mode exists here.
Help does not query metadata or R2. Normal/local runner bounds remain 1/4 CPU
and 1/16 publication (default/maximum), regardless of machine resources.`;

const TEST_BUCKET_PATTERN = /^uk-aq-history-cic-test(?:-[a-z0-9]+)*$/;
const TEST_R2_ACCOUNT = '41a81f781d3bd7234fde0b25df51e879';
function oneValue(argv, flag) {
  const positions = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (positions.length !== 1 || !argv[positions[0] + 1] || argv[positions[0] + 1].startsWith('--')) {
    throw new Error(`TEST GCP admission requires exactly one ${flag}`);
  }
  return argv[positions[0] + 1];
}
function assertTestEnvironment(argv, env = process.env) {
  const selectedBucket = oneValue(argv, '--expected-bucket');
  if (oneValue(argv, '--environment') !== 'TEST' || !TEST_BUCKET_PATTERN.test(selectedBucket) ||
      env.CFLARE_R2_BUCKET !== selectedBucket ||
      [env.UKAQ_ENV_NAME, env.UK_AQ_ENV_NAME, env.ENVIRONMENT].filter(Boolean).some((value) => value.toUpperCase() !== 'TEST') ||
      env.UK_AQ_R2_HISTORY_VERSION !== 'v2') {
    throw new Error('TEST GCP migration requires the pinned TEST environment and R2 bucket');
  }
  let endpoint;
  try { endpoint = new URL(env.CFLARE_R2_ENDPOINT); } catch { throw new Error('TEST R2 endpoint is missing or malformed'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== `${TEST_R2_ACCOUNT}.r2.cloudflarestorage.com` ||
      (endpoint.pathname !== '/' && endpoint.pathname !== '') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('TEST GCP migration requires the pinned TEST Cloudflare account');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  if (remote.status !== 0 || !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)TEST-uk-aq\/uk-aq-ops(?:\.git)?\/?$/.test(remote.stdout.trim())) {
    throw new Error('TEST GCP migration requires the TEST-uk-aq/uk-aq-ops checkout');
  }
}

export async function mainGcp({ argv = process.argv.slice(2) } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); return 0; }
  let profile = GCP_PROFILE;
  const sharedArgs = [];
  let profileSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runner-profile') {
      if (profileSeen || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--runner-profile requires one explicit profile');
      profileSeen = true;
      profile = argv[++i];
    } else sharedArgs.push(argv[i]);
  }
  assertTestEnvironment(sharedArgs);
  const runnerPermit = await admitGcpRunner({ profile });
  process.stderr.write(`GCE admission: ${JSON.stringify(runnerPermit)}\n`);
  // Re-enter this file when the lock coordinator starts its child; that process
  // must independently obtain its own unforgeable in-process admission permit.
  return sharedMain({ argv: sharedArgs, runnerPermit, entrypoint: fileURLToPath(import.meta.url) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const execution = process.env.UK_AQ_OPERATOR_SUPERVISED === '1' || process.argv.includes('--help') || process.argv.includes('-h')
    ? mainGcp() : superviseOperatorInvocation(process.argv[1], process.argv.slice(2));
  execution.then((code) => { finishOperatorProgress(code ? 'failed' : 'complete'); process.exitCode = code; })
    .catch((error) => { finishOperatorProgress('failed'); process.stderr.write(`${error.stack || error}\n`); process.exitCode = error.exitCode || 1; });
}
