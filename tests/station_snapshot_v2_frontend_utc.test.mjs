import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('station_snapshot_v2/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
const start = script.indexOf('function parseUtcDate');
const end = script.indexOf('function fieldPresenceFlag');
assert.ok(start >= 0 && end > start, 'UTC formatter block is present');
const formatterBlock = script.slice(start, end) + '\n({ formatUtcDateTime, fmtDate });';
const { formatUtcDateTime, fmtDate } = vm.runInNewContext(formatterBlock, { Date, Number, String, isNullish: (v) => v === null || v === undefined || v === '' });

test('Station Snapshot v2 frontend formats BST-sensitive ISO timestamps in UTC with Z', () => {
  assert.equal(formatUtcDateTime('2026-06-18T22:30:15Z', { exact: true }), '18/06/2026 22:30:15Z');
});

test('Station Snapshot v2 frontend formats database UTC strings safely', () => {
  assert.equal(formatUtcDateTime('2026-06-18 22:30:15+00', { exact: true }), '18/06/2026 22:30:15Z');
});

test('Station Snapshot v2 frontend formats UTC hour buckets and exact observation times', () => {
  assert.equal(fmtDate('2026-06-18T18:52:46Z', 'bucket'), '18/06/2026 18:00Z');
  assert.equal(fmtDate('2026-06-18T18:52:46Z', 'exact'), '18/06/2026 18:52:46Z');
});

