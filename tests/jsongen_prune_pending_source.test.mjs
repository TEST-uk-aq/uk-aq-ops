import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { BUCKET } from '../scripts/jsongen/schema.mjs';
import { preparePrunePendingSource, retainPrunePendingSource } from '../scripts/jsongen/prune-pending-source.mjs';
import { resolvePhaseBRuntimeConfig } from '../workers/uk_aq_prune_daily/phase_b_history_r2.mjs';

const runId = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb';
const dayUtc = '2026-10-10';
const row = { connector_id: 1, station_id: 5, timeseries_id: 8, pollutant_code: 'pm25',
  observed_at: `${dayUtc}T01:02:03.004Z`, observed_at_utc: `${dayUtc}T01:02:03.004Z`,
  value: 1.23456789012345, verification_status: 'P' };

test('pending handover defaults off and never enters the v2 Prune path', () => {
  assert.equal(resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3' }).jsongen_pending_source.enabled, false);
  assert.equal(resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v2',
    UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED: 'true' }).jsongen_pending_source.enabled, false);
  const enabled = resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3',
    UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED: 'true' }).jsongen_pending_source;
  assert.equal(enabled.enabled, true);
  assert.match(enabled.config_error, /TEST environment required/);
});

test('pending source retains exact duplicate frozen rows and deterministic private identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsongen-pending-'));
  try {
    const sourcePath = path.join(root, 'source.ndjson');
    const original = Buffer.from(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
    fs.writeFileSync(sourcePath, original);
    const candidate = { path: sourcePath, runId, dayUtc, connectorId: 1, expectedRowCount: 2,
      sourceIdentity: computePruneConnectorSourceIdentity([row, row]) };
    const first = preparePrunePendingSource(candidate);
    const second = preparePrunePendingSource(candidate);
    assert.deepEqual(first.source.reference, second.source.reference);
    assert.deepEqual(first.descriptor.reference, second.descriptor.reference);
    assert.deepEqual(gunzipSync(first.source.body), original);
    assert.equal(first.descriptor.reference.key.includes('/prune/pending/'), true);
    assert.equal(JSON.parse(first.descriptor.body).state, 'pending_unverified');
    assert.equal(JSON.parse(first.descriptor.body).receipt, null);

    const objects = new Map();
    const r2 = { bucket: BUCKET, endpoint: 'https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com',
      region: 'auto', adapter: {
        async putObjectConditional({ key, body }) {
          if (objects.has(key)) return { status: 412 };
          objects.set(key, Buffer.from(body));
          return { status: 200, etag: '"source"' };
        },
        async getObjectBounded({ key }) { const body = objects.get(key); return { body, bytes: body.length }; },
      } };
    const retained = await retainPrunePendingSource({ r2, ...candidate });
    assert.equal(retained.state, 'pending_unverified');
    assert.equal(objects.size, 2);
    await retainPrunePendingSource({ r2, ...candidate });
    assert.equal(objects.size, 2);
    objects.set(retained.source.key, Buffer.from('wrong'));
    await assert.rejects(retainPrunePendingSource({ r2, ...candidate }), /Pending source readback unavailable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
