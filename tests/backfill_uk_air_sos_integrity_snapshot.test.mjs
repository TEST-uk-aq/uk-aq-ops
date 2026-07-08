import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('workers/uk_aq_backfill_local/run_job.ts', 'utf8');

test('UK-AIR SOS backfill ignores zero-byte integrity snapshots', () => {
  assert.match(src, /fs\.statSync\(snapshotPath\)\.size\s*<=\s*0/);
  assert.match(src, /ukAirSosIntegritySnapshotCache\.set\(snapshotPath,\s*null\)/);
});

