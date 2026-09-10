import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const directSource = readFileSync('workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts', 'utf8');
const stationSnapshotSource = readFileSync('workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts', 'utf8');

test('storage coverage source clears both storage coverage and R2 history-day caches on force refresh', () => {
  assert.match(directSource, /function clearStorageCoverageCaches\(\): void \{[\s\S]*storageCoverageCache = null;[\s\S]*r2HistoryDaysCache = null;/);
  assert.match(directSource, /if \(forceRefresh\) \{[\s\S]*clearStorageCoverageCaches\(\);[\s\S]*\}/);
});

test('v2 and v3 sources disable version-blind Supabase R2 window fallback', () => {
  assert.match(directSource, /!\["v2", "v3"\]\.includes\(r2_history_read_version\.version\)/);
  assert.match(directSource, /version-blind Supabase window fallback disabled for the selected serving generation/);
});

test('storage coverage response exposes actual R2 history diagnostics', () => {
  for (const field of [
    'r2_backup_window',
    'r2_backup_window_error',
    'r2_history_days_bucket',
    'r2_history_days_error',
    'r2_history_read_version_effective',
    'dropbox_backup_observations_earliest_day',
    'dropbox_backup_observations_latest_day',
    'dropbox_backup_aqilevels_earliest_day',
    'dropbox_backup_aqilevels_latest_day',
  ]) {
    assert.match(directSource, new RegExp(`${field}: payload\\.${field}`));
  }
});

test('v2 and v3 sources filter Dropbox checkpoint days to their explicit R2 history days', () => {
  assert.match(directSource, /function filterDropboxBackupDaysForReadVersion/);
  assert.match(directSource, /Active R2 history version is \$\{readVersion\.version\} but explicit \$\{readVersion\.version\} history-days data is unavailable/);
  assert.match(directSource, /before explicit \$\{readVersion\.version\} R2 history starts/);
});

test('Dropbox coverage reads only hierarchical v2 root and month shards', () => {
  assert.match(directSource, /_ops\/checkpoints\/r2_history_backup_state_v2/);
  assert.match(directSource, /parseHierarchicalStateMonthReferences/);
  assert.match(directSource, /parseHierarchicalMonthStateDays/);
  assert.doesNotMatch(directSource, /UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH/);
});

test('station snapshot follows stable observation generation while AQI remains legacy v2', () => {
  const apiRowsSource = stationSnapshotSource.match(/async function apiRows[\s\S]*?\n}/)?.[0] || '';
  assert.match(stationSnapshotSource, /const resolvedEnv = await resolveHistoryEnvironment\(env\)/);
  assert.match(stationSnapshotSource, /assertHistoryPayload\(j as JsonObject, resolvedEnv\)/);
  assert.match(stationSnapshotSource, /r2ObservationParams = \{ \.\.\.r2BaseParams, read_version: readVersion \}/);
  assert.match(stationSnapshotSource, /const r2AqiParams = \{ \.\.\.r2BaseParams, read_version: "v2", format: "objects" \}/);
  assert.match(apiRowsSource, /h\.set\("x-uk-aq-upstream-auth", token\)/);
  assert.doesNotMatch(apiRowsSource, /h\.set\("Authorization"/);
});
