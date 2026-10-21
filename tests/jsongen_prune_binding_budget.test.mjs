import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { canonicalJson } from '../scripts/jsongen/schema.mjs';
import { createPruneOriginalMetadataCapture, PRUNE_BINDING_CAPTURE_DEADLINE_MS,
  PRUNE_BINDING_CAPTURE_CONCURRENCY } from '../scripts/jsongen/prune-original-metadata.mjs';
import { PRUNE_SIGNED_UPLOAD_DEADLINE_MS } from '../scripts/jsongen/prune-signed-upload.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { observationsGlobalOperationLockIdentity, OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV }
  from '../workers/shared/uk_aq_r2_history_writer.mjs';
import { writeFrozenCandidateObservationsToV2ForTest }
  from '../workers/uk_aq_prune_daily/phase_b_history_r2.mjs';
import { buildTimeseriesBindingSourceRootManifest, buildTimeseriesBindingSourceRangeManifest,
  timeseriesBindingSourceRangeManifestKey, TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND }
  from '../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';
import { buildTimeseriesBindingSourceState } from '../scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs';

const prefix = 'history/_index_v3/timeseries_binding';
const day = '2026-10-15';
const run = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb';

function fixture(count = 2) {
  const rows = Array.from({ length: count }, (_, i) => ({ connector_id: 1, station_id: i + 1,
    timeseries_id: 100 + i, pollutant_code: 'pm25', observed_at_utc: `${day}T01:00:00.000Z`,
    value: 1.5, verification_status: 'P' }));
  const scopes = rows.map(row => ({ ...row, day_utc: day, row_count: 1 }));
  const sourceIdentity = computePruneConnectorSourceIdentity(rows);
  const identity = { environment: 'TEST', index_generation: 'v3', canonical_bucket: 'canonical-test',
    writer: { identity: 'prune_daily_v3', invocation_id: run, attempt_id: run, git_sha: 'a'.repeat(40) },
    connector_id: 1, day_utc: day, source_identity: sourceIdentity };
  const lock = observationsGlobalOperationLockIdentity();
  const lockEnv = Object.fromEntries(Object.entries({ held: 'true', acquired: 'true', owner: 'prune_daily',
    runId: run, logicalIdentity: lock.logical_identity, classId: String(lock.class_id),
    objectId: String(lock.object_id), nonce: 'fixture', waitMs: '0', outcome: 'held' })
    .map(([key, value]) => [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV[key], value]));
  const objects = new Map(), byRange = new Map();
  for (const row of rows) {
    const key = `${prefix}/timeseries_id=${row.timeseries_id}.json`;
    const body = canonicalJson({ schema_version: 1, history_version: 'v2', index_kind: 'timeseries_binding',
      connector_id: 1, station_id: row.station_id, timeseries_id: row.timeseries_id, pollutant_code: row.pollutant_code });
    objects.set(key, body);
    const start = Math.floor(row.timeseries_id / 1000) * 1000;
    if (!byRange.has(start)) byRange.set(start, []);
    byRange.get(start).push({ timeseries_id: row.timeseries_id, relative_path: key, size: body.length, sha256: sha256Hex(body) });
  }
  const ranges = [...byRange].map(([start, units]) => {
    const range = buildTimeseriesBindingSourceRangeManifest({ bindingPrefix: prefix, rangeStart: start, units });
    const key = timeseriesBindingSourceRangeManifestKey(prefix, start);
    objects.set(key, canonicalJson(range));
    return { range_start: start, range_end: start + 999, manifest_key: key,
      source_range_hash: range.source_range_hash, unit_count: units.length };
  });
  const root = buildTimeseriesBindingSourceRootManifest({ bindingPrefix: prefix, ranges });
  const state = buildTimeseriesBindingSourceState({ bindingPrefix: prefix, sourceSchema: 'uk_aq_core',
    sourceFingerprint: 'f'.repeat(64), authoritativeTimeseriesCount: count,
    sourceTables: ['timeseries', 'phenomena', 'observed_properties']
      .map(table => ({ table, row_count: count, sha256_uncompressed: 'd'.repeat(64) })) });
  objects.set(`${prefix}/_manifests/root.json`, canonicalJson(root));
  objects.set(`${prefix}/_source_state.json`, canonicalJson(state));
  objects.set(`${prefix}/_manifests/_refresh_state.json`, canonicalJson({ schema_version: 1, history_version: 'v2',
    kind: TIMESERIES_BINDING_SOURCE_REFRESH_STATE_KIND, source_prefix: prefix,
    source_root_hash: root.source_root_hash, source_fingerprint: state.source_fingerprint }));
  const manager = createPruneOriginalMetadataCapture();
  return { rows, scopes, sourceIdentity, identity, lockEnv, objects, manager,
    capture: manager.beginOriginalAuthority(identity, lockEnv) };
}

test('940-scope capture completes beyond the old window with eight cached readers and unchanged GET limits', async () => {
  for (const deadline of [PRUNE_SIGNED_UPLOAD_DEADLINE_MS, PRUNE_BINDING_CAPTURE_DEADLINE_MS]) {
    const f = fixture(940), calls = new Set();
    let clock = 0, completed = 0, inFlight = 0, peak = 0;
    await f.capture.captureBindings({ physicalScopes: f.scopes, deadlineAtMs: deadline, nowMs: () => clock,
      getObject: async ({ key, max_bytes, timeout_ms }) => {
        assert.ok(!calls.has(key)); calls.add(key);
        assert.ok(timeout_ms > 0 && timeout_ms <= 15_000);
        assert.ok(max_bytes > 0 && max_bytes <= 8 * 1024 ** 2);
        inFlight++; peak = Math.max(peak, inFlight);
        await nextTurn();
        // Virtual elapsed time at ~16 completed GETs/s; no real sleeps or R2.
        if (++completed % 8 === 0) clock += 500;
        inFlight--;
        const body = f.objects.get(key); return { body, bytes: body.length };
      } });
    const original = f.capture.snapshot(), diagnostics = f.capture.diagnostics();
    assert.equal(inFlight, 0);
    assert.equal(peak, PRUNE_BINDING_CAPTURE_CONCURRENCY);
    assert.equal(diagnostics.binding_capture_required_key_count, 945); // 940 + two ranges + three completion objects
    assert.equal(diagnostics.binding_capture_unique_key_count, calls.size);
    if (deadline === PRUNE_SIGNED_UPLOAD_DEADLINE_MS) {
      assert.equal(original.binding.reason, 'original_binding_capture_deadline');
      assert.ok(calls.size < 945);
      assert.equal(f.manager.statistics().retained_bytes, 0);
    } else {
      assert.equal(original.binding.state, 'captured');
      assert.equal(original.binding.bindings.length, 940);
      assert.equal(calls.size, 945);
      assert.equal(diagnostics.binding_capture_retained_object_count, 945);
      assert.ok(clock > 15_000 && clock < PRUNE_BINDING_CAPTURE_DEADLINE_MS);
      assert.deepEqual(original.binding.bindings.map(binding => binding.identity.timeseries_id), f.rows.map(row => row.timeseries_id));
    }
  }
});

test('expiry drains bounded adapters; late responses cannot restore or mutate evidence', async () => {
  const f = fixture(40), late = [];
  let aborted = 0;
  await f.capture.captureBindings({ physicalScopes: f.scopes, deadlineAtMs: Date.now() + 50,
    r2: { adapter: { getObjectBounded({ key, signal }) {
      if (key.includes('/timeseries_id=')) return new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted++; }, { once: true });
        late.push(() => { const body = f.objects.get(key); resolve({ body, bytes: body.length }); });
      });
      const body = f.objects.get(key); return Promise.resolve({ body, bytes: body.length });
    } } } });
  assert.equal(late.length, PRUNE_BINDING_CAPTURE_CONCURRENCY);
  assert.equal(aborted, late.length);
  assert.equal(f.capture.snapshot().binding.reason, 'original_binding_capture_deadline');
  const snapshot = canonicalJson(f.capture.snapshot()), stats = f.manager.statistics();
  late.forEach(resolve => resolve()); await nextTurn();
  assert.deepEqual(canonicalJson(f.capture.snapshot()), snapshot);
  assert.deepEqual(f.manager.statistics(), stats);
  assert.equal(stats.retained_bytes, 0);
});

async function publication(t, { headroom = 1_000_000, failure, timeBudgetLoss = false } = {}) {
  const f = fixture(), calls = [], logs = [];
  const directory = mkdtempSync(join(tmpdir(), 'prune-binding-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.ndjson');
  writeFileSync(path, Buffer.concat(f.rows.map(canonicalJson)));
  let budgetNow = 0, active = 0;
  const started = Date.now();
  const runtime = { environment: 'TEST', history_write_version: 'v3', committed_prefix: 'history/v3/observations',
    run_id: run, writer_git_sha: 'a'.repeat(40), jsongen_pending_source: { enabled: true, signer: {} },
    run_budget: { started_at_ms: 0, deadline_ms: headroom, now_ms: () => budgetNow },
    logStructured: (_severity, event, fields) => logs.push({ event, ...fields }),
    r2: { bucket: 'canonical-test', adapter: { async getObjectBounded({ key, signal }) {
      calls.push(key); active++;
      try {
        if (failure === 'upload') return await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        if (key.includes('/timeseries_id=') && failure === 'binding') throw new Error('missing binding');
        if (timeBudgetLoss && key.includes('/timeseries_id=')) budgetNow = headroom - 200_000;
        await nextTurn(undefined, { signal }); const body = f.objects.get(key); return { body, bytes: body.length };
      } finally { active--; }
    } } } };
  const result = await writeFrozenCandidateObservationsToV2ForTest({
    candidate: { day_utc: day, connector_id: 1, expected_row_count: BigInt(f.rows.length) }, runtime,
    streamClient: {}, frozen: { temp: { ndjsonPath: path }, counts: {}, sourceIdentity: f.sourceIdentity },
    originalAuthorityLockEnv: f.lockEnv, readFrozenRows: async function* () { yield* f.rows; },
    admitSnapshot: async () => ({ admission: 'first_publication' }),
    uploadPendingSource: async ({ deadlineAtMs, prepared }) => {
      calls.push('upload');
      assert.ok(prepared.body.length > 0);
      assert.ok(deadlineAtMs <= Date.now() + 15_000 && deadlineAtMs >= started + 15_000);
      if (failure === 'upload') throw new Error('signer unavailable');
      return { state: 'put_acknowledged_unverified' };
    },
    connectorPublisher: async () => { assert.equal(active, 0); calls.push('publish'); return { file_count: 1, total_bytes: 100n }; },
    cleanupFrozenSource: () => {},
  });
  assert.equal(calls.at(-1), 'publish');
  return { result, calls, logs };
}

test('extra capture headroom is required before optional reads or signer; canonical publication remains reachable', async t => {
  const skipped = await publication(t, { headroom: 600_000 }); // admits old 575.5s, excludes new 650.5s
  assert.deepEqual(skipped.calls, ['publish']);
  assert.equal(skipped.result.jsongen_pending_source.failure_code, 'insufficient_headroom');
  const accepted = await publication(t);
  assert.equal(accepted.result.jsongen_pending_source.state, 'put_acknowledged_unverified');
  assert.equal(accepted.result.jsongen_original_authority.snapshot().binding.state, 'captured');
  assert.equal(accepted.calls.filter(key => key.startsWith(prefix)).length, 6);
});

test('binding failure, lost optional headroom and early upload failure all settle before canonical publication', async t => {
  for (const options of [{ failure: 'binding' }, { timeBudgetLoss: true }, { failure: 'upload' }]) {
    const { result } = await publication(t, options);
    assert.equal(result.jsongen_original_authority.snapshot().binding.state, 'unavailable');
    assert.equal(result.jsongen_pending_source.state, options.failure === 'upload' ? 'no_intent' : 'put_acknowledged_unverified');
  }
});
