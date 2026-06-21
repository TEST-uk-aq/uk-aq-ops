import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../workers/uk_aq_dashboard_online_api_worker/node_modules/typescript/lib/typescript.js';

const source = readFileSync('workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts', 'utf8')
  .replace(/import[^;]+;\n/g, '')
  .replace(/\bexport\s+/g, '') +
  '\n({ resolveDropboxStatePath, storageCoverageCacheKey, dashboardCacheKey, parseDropboxBackupDays, buildStorageCoverageRows });';

const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/export \{\};?/g, '');

const helpers = vm.runInNewContext(js, {
  Array,
  Boolean,
  Date,
  Error,
  Headers,
  JSON,
  Map,
  Math,
  Number,
  Object,
  RegExp,
  Set,
  String,
  URL,
  URLSearchParams,
  console,
});

test('storage coverage Dropbox checkpoint defaults follow the active R2 history read version', () => {
  const v1 = helpers.resolveDropboxStatePath({ UK_AQ_R2_HISTORY_VERSION: 'v1' });
  assert.equal(v1.path, '/CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v1.json');
  assert.equal(v1.source, 'default:v1');
  assert.equal(v1.fallbackAttempted, false);
  assert.match(helpers.storageCoverageCacheKey({ UK_AQ_R2_HISTORY_VERSION: 'v1' }), /v1:/);

  const v2 = helpers.resolveDropboxStatePath({ UK_AQ_R2_HISTORY_VERSION: 'v2' });
  assert.equal(v2.path, '/CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2.json');
  assert.equal(v2.source, 'default:v2');
  assert.equal(v2.fallbackAttempted, false);
  assert.match(helpers.storageCoverageCacheKey({ UK_AQ_R2_HISTORY_VERSION: 'v2' }), /v2:/);
  assert.match(
    helpers.dashboardCacheKey(new URLSearchParams('include_storage_coverage=1'), { UK_AQ_R2_HISTORY_VERSION: 'v2' }),
    /r2_history_backup_state_v2\.json/,
  );
});

test('v2 mode does not silently fall back to a configured v1 Dropbox checkpoint', () => {
  const resolved = helpers.resolveDropboxStatePath({
    UK_AQ_R2_HISTORY_VERSION: 'v2',
    UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH: '_ops/checkpoints/r2_history_backup_state_v1.json',
  });
  assert.equal(resolved.path, '/CIC-Test/R2_history_backup/_ops/checkpoints/r2_history_backup_state_v2.json');
  assert.equal(resolved.source, 'default:v2_ignored_v1_env_override');
  assert.equal(resolved.fallbackAttempted, false);
  assert.match(resolved.warning, /ignored/i);
  assert.match(helpers.storageCoverageCacheKey({
    UK_AQ_R2_HISTORY_VERSION: 'v2',
    UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH: '_ops/checkpoints/r2_history_backup_state_v1.json',
  }), /r2_history_backup_state_v2\.json/);
});

test('v2 Dropbox backup days populate calendar backup overlay fields without changing R2 presence', () => {
  const dropboxDays = helpers.parseDropboxBackupDays({
    domains: {
      observations: {
        days: {
          '2026-06-12': {},
          '2026-06-13': {},
          '2026-06-14': {},
        },
      },
      aqilevels: {
        days: {
          '2026-06-12': {},
          '2026-06-13': {},
          '2026-06-14': {},
        },
      },
    },
  });
  const r2Days = {
    observations: new Set(['2026-06-12', '2026-06-13', '2026-06-14']),
    aqilevels: new Set(['2026-06-12', '2026-06-13', '2026-06-14']),
  };
  const rows = helpers.buildStorageCoverageRows([], [], r2Days, dropboxDays);
  for (const day of ['2026-06-12', '2026-06-13', '2026-06-14']) {
    const row = rows.find((item) => item.date === day);
    assert.ok(row, `expected storage coverage row for ${day}`);
    assert.equal(row.r2_observs, true);
    assert.equal(row.r2_aqilevels, true);
    assert.equal(row.dropbox_observs, true);
    assert.equal(row.dropbox_aqilevels, true);
  }
});
