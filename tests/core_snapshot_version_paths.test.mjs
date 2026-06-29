import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TABLES, resolveCoreSnapshotPrefix } from '../scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs';
import { resolveDomainPrefixes } from '../scripts/backup_r2/build_backup_inventory.mjs';

test('core snapshot generation chooses v1 prefix for canonical v1 history version', () => {
  assert.equal(resolveCoreSnapshotPrefix({ UK_AQ_R2_HISTORY_VERSION: 'v1' }), 'history/v1/core');
});

test('core snapshot generation chooses v2 prefix for canonical v2 history version', () => {
  assert.equal(resolveCoreSnapshotPrefix({ UK_AQ_R2_HISTORY_VERSION: 'v2' }), 'history/v2/core');
});

test('core snapshot rejects deprecated split write version', () => {
  assert.throws(
    () => resolveCoreSnapshotPrefix({ UK_AQ_R2_HISTORY_WRITE_VERSION: 'v2', UK_AQ_R2_HISTORY_VERSION: 'v2' }),
    /UK_AQ_R2_HISTORY_WRITE_VERSION/,
  );
});

test('core snapshot requires canonical history version when prefix is not supplied', () => {
  assert.throws(
    () => resolveCoreSnapshotPrefix({}),
    /Missing UK_AQ_R2_HISTORY_VERSION/,
  );
});

test('backup inventory selects v2 core prefix for v2 backup version', () => {
  const prefixes = resolveDomainPrefixes('v2', {});
  assert.equal(prefixes.core, 'history/v2/core');
});

test('backup inventory preserves v1 core prefix for v1 backup version', () => {
  const prefixes = resolveDomainPrefixes('v1', {});
  assert.equal(prefixes.core, 'history/v1/core');
});


test('core snapshot default table set uses canonical networks table only', () => {
  assert.ok(DEFAULT_TABLES.includes('networks'));
  assert.equal(DEFAULT_TABLES.includes('uk_aq_networks'), false);
  assert.equal(DEFAULT_TABLES.includes('station_network_memberships'), false);
});
