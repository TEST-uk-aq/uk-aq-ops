import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TABLES,
  buildAuthoritativeTimeseriesBindingsFromCoreSnapshotRows,
  resolveCoreSnapshotPrefix,
} from '../scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs';
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
  assert.ok(DEFAULT_TABLES.includes('observed_property_mappings'));
  assert.equal(DEFAULT_TABLES.includes('uk_aq_networks'), false);
  assert.equal(DEFAULT_TABLES.includes('station_network_memberships'), false);
});

test('core snapshot binding resolver uses only stable authoritative identity fields', () => {
  const bindings = buildAuthoritativeTimeseriesBindingsFromCoreSnapshotRows({
    timeseriesRows: [{
      id: 3742, connector_id: 6, station_id: 91, phenomenon_id: 17,
    }],
    phenomenaRows: [{ id: 17, observed_property_id: 4 }],
    observedPropertiesRows: [{ id: 4, code: 'pm25', label: 'PM2.5' }],
  });
  assert.deepEqual(bindings, [{
    timeseries_id: 3742,
    connector_id: 6,
    pollutant_code: 'pm25',
    station_id: 91,
    phenomenon_id: 17,
    observed_property_id: 4,
  }]);
});

test('core snapshot binding resolver rejects guessed pollutant identity', () => {
  const bindings = buildAuthoritativeTimeseriesBindingsFromCoreSnapshotRows({
    timeseriesRows: [{ id: 3742, connector_id: 6, phenomenon_id: 17, label: 'PM2.5' }],
    phenomenaRows: [{ id: 17, observed_property_id: 4, label: 'PM2.5' }],
    observedPropertiesRows: [{ id: 4, notation: 'PM2.5', label: 'PM2.5' }],
  });
  assert.equal(bindings[0].pollutant_code, null);
});
