import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../workers/uk_aq_dashboard_online_api_worker/node_modules/typescript/lib/typescript.js';

const source = readFileSync('workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts','utf8')
  .replace(/import[^;]+;\n/g,'')
  .split('export async function')[0]
  .replace('export function mergeStationSnapshotV2Rows','function mergeStationSnapshotV2Rows') + '\nmergeStationSnapshotV2Rows;';
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/export \{\};?/g, "");
const mergeStationSnapshotV2Rows = vm.runInNewContext(js, { Date, Map, Number, String, Array, JSON });

test('station_snapshot_v2 merge logic covers source values, overlap, -99, and AQI colours', () => {
  const result = mergeStationSnapshotV2Rows({
    ingestObservs: [
      { observed_at: '2026-06-17T08:15:00Z', value: 12.34567 },
      { observed_at: '2026-06-17T07:00:00Z', value: -99 },
    ],
    obsAqidbObservs: [{ observed_at: '2026-06-17T08:00:00Z', value: 13 }],
    r2Observs: [{ observed_at: '2026-06-17T06:00:00Z', value: 14 }],
    ingestAqi: [
      { observed_at: '2026-06-17T08:00:00Z', hourly_mean_ugm3: 11, rolling24h_mean_ugm3: 10, hourly_sample_count: 3, daqi_index_level: 2, eaqi_index_level: 1 },
      { observed_at: '2026-06-17T07:00:00Z', hourly_sample_count: 1 },
    ],
    r2Aqi: [{ observed_at: '2026-06-17T08:00:00Z', source: 'r2', hourly_mean_ugm3: 12, rolling24h_mean_ugm3: 9, hourly_sample_count: 4, daqi_index_level: 3, eaqi_index_level: 2 }],
  });
  assert.equal(result.overlap_detected, true);
  const exact = result.rows.find((row) => row.observed_at === '2026-06-17T08:15:00.000Z');
  assert.equal(exact.hour_bucket, '2026-06-17T08:00:00.000Z');
  assert.equal(exact.aqi_source, 'R2 History');
  assert.equal(exact.ingestdb_observs_value, 12.34567);
  assert.equal(exact.obsaqidb_observs_value, null);
  assert.equal(exact.daqi_colour, '#31CF00');
  assert.equal(exact.eaqi_colour, '#50CCAA');
  const obsExact = result.rows.find((row) => row.observed_at === '2026-06-17T08:00:00.000Z');
  assert.equal(obsExact.obsaqidb_observs_value, 13);
  assert.equal(obsExact.aqi_source, 'R2 History');
  const minus = result.rows.find((row) => row.observed_at === '2026-06-17T07:00:00.000Z');
  assert.equal(minus.ingestdb_observs_value, -99);
  assert.equal(minus.aqi_source, 'ObsAQIDB');
  assert.equal(minus.daqi_colour, null);
  const r2Only = result.rows.find((row) => row.observed_at === '2026-06-17T06:00:00.000Z');
  assert.equal(r2Only.r2_observs_value, 14);
});
