import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildR2HistoryReadIndexKey,
  resolveR2HistoryLayoutConfig,
} from '../../workers/uk_aq_db_size_metrics_api_worker/worker.mjs';

function fakeUrl(readVersion = '') {
  const url = new URL('https://example.test/api/r2_history_counts');
  if (readVersion) url.searchParams.set('read_version', readVersion);
  return url;
}

const html = await readFile(new URL('../../dashboard/index.html', import.meta.url), 'utf8');

assert.match(html, /r2VersionLabel = String\(r2Version\.label/, 'calendar label should use the active R2 version label from the API payload');
assert.match(html, /coverage-calendar-version/, 'calendar version badge must remain rendered');
assert.match(html, /background:\s*var\(--color-r2-observs\);\s*border:\s*0;/s, 'backup obs bars should be orange filled, not white bordered');
assert.match(html, /background:\s*var\(--color-r2-aqilevels\);\s*border:\s*0;/s, 'backup AQI bars should be yellow filled, not white bordered');
assert.match(html, /coverage-bar-aqilevels-striped[\s\S]*repeating-linear-gradient/, 'combined AQI backup style should remain striped');
assert.doesNotMatch(html, /coverage-bar-dropbox-only-observs\s*\{\s*background:\s*#ffffff[\s\S]*?border:\s*1px solid var\(--color-r2-observs\)/, 'obs backup bars must not use white orange-bordered style');
assert.doesNotMatch(html, /coverage-bar-dropbox-only-aqilevels\s*\{\s*background:\s*#ffffff[\s\S]*?border:\s*1px solid var\(--color-r2-aqilevels\)/, 'AQI backup bars must not use white yellow-bordered style');
assert.match(html, /payloadWarningParts/, 'connector-count warnings should render without failing the calendar');

const v1 = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: 'v1' }, fakeUrl());
assert.equal(v1.readVersion.label, 'R2_v1');
assert.equal(buildR2HistoryReadIndexKey(v1, 'observations'), 'history/_index/observations_latest.json');
assert.equal(buildR2HistoryReadIndexKey(v1, 'aqilevels'), 'history/_index/aqilevels_latest.json');

const v2 = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: 'v2' }, fakeUrl());
assert.equal(v2.readVersion.label, 'R2_v2');
assert.equal(buildR2HistoryReadIndexKey(v2, 'observations'), 'history/_index_v2/observations_timeseries_latest.json');
assert.equal(buildR2HistoryReadIndexKey(v2, 'aqilevels'), 'history/_index_v2/aqilevels_hourly_data_timeseries_latest.json');

assert.throws(
  () => resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3' }, fakeUrl()),
  /Invalid UK_AQ_R2_HISTORY_VERSION.*expected v1 or v2/,
);

assert.throws(
  () => resolveR2HistoryLayoutConfig({}, fakeUrl()),
  /Missing UK_AQ_R2_HISTORY_VERSION/,
);

const queryOverride = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: 'v1' }, fakeUrl('v2'));
assert.equal(queryOverride.readVersion.label, 'R2_v2');
assert.equal(queryOverride.readVersion.source, 'query');

console.log('dashboard R2 version/calendar/count checks passed');
