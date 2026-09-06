import assert from 'node:assert/strict';
import test from 'node:test';
import { v2RuntimeAuthorityAdapters, parseObservationHistoryMigrationArgs } from '../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs';

function fixture({ missing = [], current = 'different', weakEvidence = false } = {}) {
  const roles = ['stable_observations_worker', 'stable_station_worker', 'cache_worker'];
  const components = roles.map((role, i) => ({ role, worker_name: `test-${i}`, git_commit_sha: `${i}`.repeat(40), deployment: { version_id: `version-${i}` } }));
  const deployed = new Map(components.map(c => [c.worker_name, current === 'exact' ? c.deployment.version_id : 'unrelated-version']));
  const commands = [];
  const rollbackEvidence = { payload_sha256: 'a'.repeat(64), payload: { repository: 'test/ops', components, cache_provenance: { pre_cutover_v2_cache_runtime: { version_id: 'version-2' } } } };
  const apiGet = async ({ workerName, suffix }) => {
    if (suffix === 'deployments') return { deployments: [{ id: 'deployment', created_on: '2026-08-01T00:00:00Z', versions: [{ version_id: deployed.get(workerName), percentage: 100 }], ...(weakEvidence ? { git_commit_sha: components[0].git_commit_sha } : {}) }] };
    const version = suffix.split('/')[1];
    if (missing.includes(version)) return null;
    return { id: version, resources: { bindings: [{ type: 'service', name: 'STATION_HISTORY', service: 'test-1' }] } };
  };
  const command = async (program, args) => {
    commands.push([program, args]);
    if (program === 'npx') deployed.set(args[args.indexOf('--name') + 1], args[3].split('@')[0]);
    const stdout = program === 'bash' ? 'test-1' : args[0] === 'repo' ? 'test/ops' : 'v2';
    return { ok: true, status: 0, stdout };
  };
  const adapters = v2RuntimeAuthorityAdapters({ rollbackEvidence, repositoryRoot: '.', env: { UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID: 'test', UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN: 'fake-test-token' }, apiGet, command });
  return { adapters, commands, deployed, rollbackEvidence };
}

test('expired pinned runtime fails closed; names, dates and commit labels cannot prove equivalence', async () => {
  const f = fixture({ missing: ['version-0'], weakEvidence: true });
  await assert.rejects(f.adapters.checkV2RuntimeRecoverability(), error => {
    assert.equal(error.runtimeRecoverability.components[0].state, 'unrecoverable');
    assert.equal(error.runtimeRecoverability.components[1].state, 'pinned_version_available_for_deploy');
    return /before canonical mutation/.test(error.message);
  });
  await assert.rejects(f.adapters.restoreV2RuntimeAuthority(), /requires successful pre-mutation/);
  assert.equal(f.commands.length, 0);
});
test('available pinned versions deploy in authority order and final verification checks selected identities', async () => {
  const f = fixture();
  assert.equal((await f.adapters.checkV2RuntimeRecoverability()).ok, true);
  const restored = await f.adapters.restoreV2RuntimeAuthority();
  assert.deepEqual(restored.components.map(c => c.disposition), Array(3).fill('deployed_pinned_historical_version'));
  assert.deepEqual(f.commands.map(([program]) => program), ['npx', 'npx', 'gh', 'npx']);
  const verified = await f.adapters.verifyV2RuntimeAuthority();
  assert.equal(verified.index_generation, 'v2');
  assert.equal(verified.observations_reader_generation, 'v2');
  assert.equal(verified.station_reader_generation, 'v2');
  assert.equal(verified.cache_station_binding_generation, 'v2');
  f.deployed.set('test-0', 'unauthorized');
  await assert.rejects(f.adapters.verifyV2RuntimeAuthority(), /not the pinned v2 version/);
});
test('exact current pinned identities skip redeployment, with fresh execution and final checks', async () => {
  const f = fixture({ current: 'exact', missing: ['version-0'] });
  const admission = await f.adapters.checkV2RuntimeRecoverability();
  assert.ok(admission.components.every(c => c.state === 'already_exact_pinned_version'));
  const restored = await f.adapters.restoreV2RuntimeAuthority();
  assert.ok(restored.components.every(c => c.disposition === 'confirmed_existing_pinned_runtime' && !c.deployed));
  assert.equal(f.commands.filter(([program]) => program === 'npx').length, 0);
  assert.equal((await f.adapters.verifyV2RuntimeAuthority()).complete, true);
});
test('cache must expose its pinned binding and API errors never become an alternative recovery route', async () => {
  const f = fixture({ current: 'exact', missing: ['version-2'] });
  await assert.rejects(f.adapters.checkV2RuntimeRecoverability(), /unrecoverable/);
});

test('diagnostic entrypoint cannot admit mutation or require old migration plan reconstruction', () => {
  const args = ['--mode', 'runtime-recoverability', '--transition', 'v3-rebuild', '--environment', 'TEST'];
  assert.equal(parseObservationHistoryMigrationArgs(args).mode, 'runtime-recoverability');
  assert.throws(() => parseObservationHistoryMigrationArgs([...args, '--apply']), /only with a mutation mode/);
});
test('runtime drift after admission is restored to the selected pinned identity', async () => {
  const f = fixture({ current: 'exact' });
  await f.adapters.checkV2RuntimeRecoverability();
  f.deployed.set('test-0', 'later-unauthorized');
  const restored = await f.adapters.restoreV2RuntimeAuthority();
  assert.equal(restored.components[0].disposition, 'deployed_pinned_historical_version');
  assert.equal(f.deployed.get('test-0'), 'version-0');
});
test('only the explicit Cloudflare missing-version response is treated as unavailable', async t => {
  const { rollbackEvidence } = fixture();
  let versionStatus = 404;
  let versionCode = 100146;
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: String(url).endsWith('/deployments'),
    status: String(url).endsWith('/deployments') ? 200 : versionStatus,
    json: async () => String(url).endsWith('/deployments')
      ? { success: true, result: { deployments: [{ id: 'current', created_on: '2026-09-01T00:00:00Z', versions: [{ version_id: 'other', percentage: 100 }] }] } }
      : { success: false, errors: [{ code: versionCode }] },
  }));
  const adapters = v2RuntimeAuthorityAdapters({ rollbackEvidence, repositoryRoot: '.', env: { UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID: 'test', UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN: 'fake-token' } });
  await assert.rejects(adapters.checkV2RuntimeRecoverability(), /unrecoverable before canonical mutation/);
  versionStatus = 403;
  await assert.rejects(adapters.checkV2RuntimeRecoverability(), /HTTP 403/);
  versionStatus = 404; versionCode = 10000;
  await assert.rejects(adapters.checkV2RuntimeRecoverability(), /HTTP 404/);
});
