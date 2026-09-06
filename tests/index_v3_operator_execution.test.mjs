import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOperatorRun, createOperatorProgress, withOperatorPhase, runOperatorCommand } from '../scripts/index_v3_migration/operator_execution.mjs';
const helper = fileURLToPath(new URL('../scripts/index_v3_migration/operator_execution.mjs', import.meta.url));
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uk-aq-operator-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('run directories use UTC seconds and never overwrite a same-second invocation', t => {
  const root = temp(t);
  const options = { root, operation: 'rollback', now: new Date('2026-09-06T00:15:30Z') };
  const a = createOperatorRun(options), b = createOperatorRun(options);
  fs.closeSync(a.fd); fs.closeSync(b.fd);
  assert.equal(path.basename(a.directory), '20260906T001530Z_rollback');
  assert.equal(path.basename(b.directory), '20260906T001530Z_rollback_1');
});
test('persistent run log tees both streams, redacts split secrets and preserves the child exit code', t => {
  const root = temp(t), entry = path.join(root, 'child.mjs');
  fs.writeFileSync(entry, `process.stdout.write('ordinary output\\n'); process.stderr.write('ordinary error\\n'); process.stdout.write('fake-'); setTimeout(() => { process.stdout.write('credential\\n'); process.exitCode=7; }, 10);`);
  const result = spawnSync(process.execPath, [helper, 'run', entry, '--mode', 'verify', '--work-dir', root], { encoding: 'utf8', env: { ...process.env, EXAMPLE_API_TOKEN: 'fake-credential' } });
  assert.equal(result.status, 7, result.stderr);
  const directory = path.join(root, 'runs', fs.readdirSync(path.join(root, 'runs'))[0]);
  const log = fs.readFileSync(path.join(directory, 'operator.log'), 'utf8');
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'run_report.json')));
  assert.match(result.stdout, /ordinary output/); assert.match(result.stderr, /ordinary error/);
  assert.match(log, /ordinary output/); assert.match(log, /ordinary error/); assert.match(log, /exit=7 status=failed/);
  assert.doesNotMatch(log + result.stdout + result.stderr, /fake-credential/);
  assert.deepEqual(report.evidence_paths, []);
  assert.equal(report.exit_code, 7); assert.equal(report.success, false); assert.equal(report.diagnostic_only, true);
});
test('run directory failure prevents starting the child', t => {
  const root = temp(t), marker = path.join(root, 'started'), entry = path.join(root, 'child.mjs');
  fs.writeFileSync(path.join(root, 'runs'), 'not a directory');
  fs.writeFileSync(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');`);
  const result = spawnSync(process.execPath, [helper, 'run', entry, '--mode', 'rollback', '--work-dir', root]);
  assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false);
});
test('progress write failure is diagnostic only and child status/error remains available', async t => {
  t.mock.method(process.stderr, 'write', () => { throw new Error('broken diagnostic sink'); });
  const reporter = createOperatorProgress({ label: 'diagnostic', total: 1 });
  assert.doesNotThrow(() => reporter.report(1));
  assert.equal(await withOperatorPhase('diagnostic phase', () => 42), 42);
  await assert.rejects(runOperatorCommand(process.execPath, ['-e', 'process.exit(9)'], { emit: false }), error => error.exitCode === 9);
});
test('silent synchronous work gets one 15-second heartbeat through parent logging', t => {
  const root = temp(t), entry = path.join(root, 'child.mjs');
  fs.writeFileSync(entry, `import { createOperatorProgress } from ${JSON.stringify(new URL('../scripts/index_v3_migration/operator_execution.mjs', import.meta.url).href)};
const p=createOperatorProgress({label:'Synchronous recovery',total:2,totalBytes:100});
p.report(1,{bytes:50});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,16000);
p.report(2,{bytes:100});`);
  const result = spawnSync(process.execPath, [helper, 'run', entry, '--mode', 'verify', '--work-dir', root], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const directory = path.join(root, 'runs', fs.readdirSync(path.join(root, 'runs'))[0]);
  const log = fs.readFileSync(path.join(directory, 'operator.log'), 'utf8');
  assert.match(log, /Synchronous recovery: start/);
  assert.match(log, /Synchronous recovery: active elapsed=00:00:15 objects=1\/2 bytes=50\/100 ETA~00:00:15/);
  assert.match(log, /Synchronous recovery: complete/);
  assert.equal((log.match(/: active elapsed=/g) || []).length, 1, log);
});

test('termination reaches a shell child and preserves cancellation status', async t => {
  const root = temp(t), entry = path.join(root, 'wait.sh'), target = path.join(root, 'target.mjs'), stopped = path.join(root, 'stopped');
  fs.writeFileSync(target, `import fs from 'node:fs'; process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(143);}); console.log('target ready'); setInterval(()=>{},1000);`);
  fs.writeFileSync(entry, '"' + process.execPath + '" "' + target + '"\n');
  const child = spawn(process.execPath, [helper, 'run', entry, 'verify', '--work-dir', root], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('controlled stop timed out')), 10000);
    child.stdout.on('data', data => { if (String(data).includes('target ready')) child.kill('SIGTERM'); });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(code, 143);
  assert.equal(fs.readFileSync(stopped, 'utf8'), 'stopped');
});

test('standalone preflight supervision installs only one Full preflight phase', t => {
  const root=temp(t), entry=path.join(root,'index_v3_preflight.sh');
  const preflight=fileURLToPath(new URL('../scripts/index_v3_migration/index_v3_preflight.sh', import.meta.url));
  const source=fs.readFileSync(preflight,'utf8').split('# Read-only Phase 6')[0];
  fs.writeFileSync(entry, source.replaceAll('$(dirname -- "${BASH_SOURCE[0]}")/operator_execution.mjs', helper)+'\nexit 0\n');
  const result=spawnSync('bash',[entry,'--stage','plan','--work-dir',root],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal((result.stderr.match(/Full preflight: start/g)||[]).length,1,result.stderr);
  assert.equal((result.stderr.match(/Full preflight: complete/g)||[]).length,1,result.stderr);
});
