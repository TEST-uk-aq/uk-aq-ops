import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('workers/uk_aq_backfill_local/run_job.ts', 'utf8');

test('targeted merge proceeds with empty preservation when no local history exists', () => {
  // The previous behaviour threw; the new behaviour should treat missing local
  // history as "nothing to preserve" and continue with the replacement rows.
  assert.doesNotMatch(
    src,
    /throw new Error\(\s*`source_to_r2 targeted merge requires local Dropbox history manifests/,
  );
  assert.match(src, /const localObsRows = rawLocalObsRows \?\? \[\]/);
});

test('targeted merge logs a structured event when local history is missing', () => {
  assert.match(src, /source_to_r2_targeted_merge_no_local_history/);
  assert.match(src, /obs_local_missing:/);
  assert.match(src, /aqi_local_missing:/);
});

test('targeted merge records local-history-missing flag in checkpoint json', () => {
  assert.match(
    src,
    /sourceCheckpointJson\.targeted_local_history_missing\s*=\s*localHistoryMissing/,
  );
});

test('AQI branch in targeted merge uses effective (defaulted-empty) local AQI rows', () => {
  assert.match(src, /const effectiveLocalAqiRows = localAqiRows \?\? \[\]/);
  assert.match(src, /const preservedAqiRows = effectiveLocalAqiRows\.filter/);
});
