#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
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

Detected instance/project/zone/machine identity and visible resources are reported
at admission and recorded with concurrency in the audit and initial authority.
Clean empty-v3 target is mandatory: canonical observations, exact indexes,
bindings, latest metadata, and v3 observation operational records.
Planning checks emptiness; fresh migrate rechecks under the global lock before
the first v3 write. No automatic deletion. Non-empty targets require manual cleanup.
Authenticated resume verifies the original clean start; it never runs a delta.

Required shared options:
  --mode plan|migrate|verify --environment TEST --transition v2-to-v3
  --expected-bucket <exact TEST bucket> --migration-run-id <stable run ID>
  --target-writer-git-sha <exact reviewed writer commit>
  --writer-limits-json <accepted limits JSON> --report-out <audit JSON>
  --expected-plan-sha256 <plan hash>  Required for migrate/verify
  --apply --writers-frozen --checkpoint-out <path>  Required for migrate
  --checkpoint-in <path>  Required for verify; also for authenticated resume
  Resume requires checkpoint-in and checkpoint-out to be the same path.

No deployment, deletion, runtime authority switch or LIVE mode exists here.
Help does not query metadata or R2. Normal/local runner bounds remain 1/4 CPU
and 1/16 publication (default/maximum), regardless of machine resources.`;

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
