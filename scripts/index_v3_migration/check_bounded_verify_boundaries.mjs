#!/usr/bin/env node
// Narrow deterministic authentication/encoding checks. No network, migration,
// R2 fixtures, full-evidence verification or performance simulation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { VerificationStore, DiskPlan, MiB, sha256 } from './bounded_verify_store.mjs';
import { BoundedBaseline } from './bounded_verify_baseline.mjs';
import { authenticateDiskJournal } from './bounded_verify_journal.mjs';
import { readAndValidateRecoveryJournal } from './recovery_journal_authority.mjs';
import { buildObservationHistoryV3RecoveryReplayStateSha256 } from '../backup_r2/lib/observation_history_migration_v3.mjs';
import { persistShardedMigrationPlan, sha256StableMigrationJson } from '../backup_r2/lib/observation_history_migration_plan_store.mjs';
import { buildObservationHistoryIndexV3PublicationPlan } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';

assert(process.argv.length === 3, 'Pass an existing work directory outside the repository');
const work = fs.mkdtempSync(path.join(path.resolve(process.argv[2]), 'bounded-boundaries-'));
const evidence = path.join(work, 'evidence'); fs.mkdirSync(evidence);
let store;
try {
  store = await VerificationStore.open({ scratchDirectory: work, evidenceDirectory: evidence,
    repositoryRoot: path.resolve('scripts/../'), assertHeld: () => {}, maxScratchBytes: 16 * MiB, reserveBytes: MiB });
  // Same canonical bytes for a disk tree, including numeric keys and Unicode.
  const plan = { migration_run_id: 'boundary', plan_sha256: 'a'.repeat(64), environment: { environment: 'TEST' },
    target_writer_git_sha: 'b'.repeat(40), values: [{ '11': 'x', '2': 'y', z: '😀\n"' }, 4, null] };
  const reference = persistShardedMigrationPlan(path.join(evidence, 'plan'), plan);
  const disk = await new DiskPlan(store).importShards(reference, (value) => value);
  assert.equal(await disk.hash(disk.root), sha256StableMigrationJson(plan));
  assert.deepEqual(disk.value('values'), plan.values);
  // Exercise recursive array spans and split UTF-16 strings without generating
  // a large plan. These are authenticated existing-format shards, not R2 data.
  const splitRoot = path.join(evidence, 'split-plan'); fs.mkdirSync(splitRoot);
  let leafCount = 0;
  const leaf = (value) => {
    const position = leafCount++, name = `${String(position).padStart(8, '0')}.json`;
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    fs.writeFileSync(path.join(splitRoot, name), bytes);
    return { kind: 'leaf', position, name, byte_size: bytes.length, sha256: sha256(bytes) };
  };
  const splitPlan = { ...plan, values: [1, null, '😀'] };
  const tree = { kind: 'object', properties: Object.keys(splitPlan).sort().map((key) => ({ key,
    node: key === 'values' ? { kind: 'array', length: 3, parts: [{ count: 2, node: leaf([1, null]) },
      { count: 1, node: { kind: 'string', code_unit_length: 2, parts: [leaf('\ud83d'), leaf('\ude00')] } }] } : leaf(splitPlan[key]) })) };
  const payload = { format: reference.format, migration_run_id: splitPlan.migration_run_id,
    plan_sha256: splitPlan.plan_sha256, environment: 'TEST', target_writer_git_sha: splitPlan.target_writer_git_sha,
    full_plan_sha256: sha256StableMigrationJson(splitPlan), shard_count: leafCount, tree };
  const master = { kind: 'uk_aq_observation_history_v3_complete_plan_master', payload, payload_sha256: sha256StableMigrationJson(payload) };
  fs.writeFileSync(path.join(splitRoot, 'master.json'), JSON.stringify(master));
  const split = await new DiskPlan(store).importShards({ format: reference.format, master_path: path.join(splitRoot, 'master.json'),
    master_sha256: sha256StableMigrationJson(master), full_plan_sha256: payload.full_plan_sha256 }, (value) => value);
  assert.equal(await split.hash(split.root), payload.full_plan_sha256);
  assert.deepEqual(split.value('values'), splitPlan.values);
  // The shared replay encoding must remain byte-identical with disk iterators.
  const checkpoint = { progress_format: 'authenticated-journal-v1', clean_target_admission: { empty: true },
    authority_sha256: 'a'.repeat(64), migration_run_id: 'boundary', plan_sha256: 'b'.repeat(64),
    preparation_order: ['b', 'a'], prepared_units: {
      b: { prepared_plan_sha256: 'b'.repeat(64), files_published: false, target_file_intents: [{ key: 'b', staging_ref: { path: 'x' } }] },
      a: { prepared_plan_sha256: 'a'.repeat(64), files_published: true, target_file_intents: [{ key: 'a' }] } },
    completed_objects: { b: { verified: true, durable: true }, a: { verified: true, durable: true } },
    full_verification_complete: true, cutover_ready: true };
  const view = (entries) => ({ length: entries.length, *[Symbol.iterator]() { yield* entries; } });
  assert.equal(buildObservationHistoryV3RecoveryReplayStateSha256(checkpoint),
    buildObservationHistoryV3RecoveryReplayStateSha256({ ...checkpoint, prepared_units: {}, completed_objects: {}, preparation_order: [] }, {
      preparationOrder: { length: 2, *entries() { yield* checkpoint.preparation_order.entries(); } },
      preparedEntries: view(Object.entries(checkpoint.prepared_units).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))),
      completedEntries: view(Object.entries(checkpoint.completed_objects).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))),
    }));
  // Authenticate exact journal chain/terminal identity and reject uncommitted
  // tails and a changed payload. The disk reader must agree with the old reader.
  const checkpointPath = path.join(evidence, 'checkpoint.json');
  const journalRoot = `${checkpointPath}.recovery`, entriesRoot = path.join(journalRoot, 'entries');
  fs.mkdirSync(entriesRoot, { recursive: true });
  const cpIdentity = { sha256: 'c'.repeat(64), byte_size: 12 };
  const transition = { kind: 'v2-to-v3', source_index_generation: 'v2', target_index_generation: 'v3', authority_switch_required: true };
  const cp = { authority_sha256: 'd'.repeat(64), migration_run_id: 'boundary', plan_sha256: 'e'.repeat(64),
    transition, authority: { target_writer_git_sha: 'f'.repeat(40) } };
  const writeEnvelope = (file, kind, payload) => {
    const value = { schema_version: 1, kind, payload, payload_sha256: sha256StableMigrationJson(payload) };
    fs.writeFileSync(file, JSON.stringify(value)); return value;
  };
  writeEnvelope(path.join(journalRoot, 'manifest.json'), 'uk_aq_observation_history_v3_recovery_manifest', {
    original_checkpoint: { path: checkpointPath, ...cpIdentity }, immutable_authority_sha256: cp.authority_sha256,
    migration_run_id: cp.migration_run_id, transition, plan_sha256: cp.plan_sha256, target_writer_git_sha: cp.authority.target_writer_git_sha,
    recovery_implementation: { repository_head: 'f'.repeat(40), files: [{ path: 'x.mjs', byte_size: 1, sha256: '0'.repeat(64) }] } });
  const entryPath = path.join(entriesRoot, '0000000001.json');
  const entry = writeEnvelope(entryPath, 'uk_aq_observation_history_v3_recovery_entry', { sequence: 1,
    previous_entry_sha256: null, original_checkpoint_sha256: cpIdentity.sha256, immutable_authority_sha256: cp.authority_sha256,
    updates: { completed_objects: [{ key: 'one', evidence: { verified: true, durable: true } }] } });
  writeEnvelope(path.join(journalRoot, 'head.json'), 'uk_aq_observation_history_v3_recovery_head', {
    original_checkpoint_sha256: cpIdentity.sha256, immutable_authority_sha256: cp.authority_sha256,
    last_sequence: 1, last_entry_sha256: entry.payload_sha256 });
  const old = readAndValidateRecoveryJournal({ recoveryRoot: journalRoot, expectedCheckpointSha256: cpIdentity.sha256,
    expectedAuthoritySha256: cp.authority_sha256, expectedCheckpointByteSize: cpIdentity.byte_size });
  const options = { checkpoint: cp, checkpointIdentity: cpIdentity, checkpointPath, store, onEntry: async () => {} };
  const authenticated = await authenticateDiskJournal(options);
  assert.equal(authenticated.last_entry_sha256, old.last_entry_sha256);
  fs.copyFileSync(entryPath, path.join(entriesRoot, '0000000002.json'));
  await assert.rejects(authenticateDiskJournal(options), /beyond committed head/);
  fs.unlinkSync(path.join(entriesRoot, '0000000002.json'));
  entry.payload.previous_entry_sha256 = '0'.repeat(64); fs.writeFileSync(entryPath, JSON.stringify(entry));
  await assert.rejects(authenticateDiskJournal(options), /authentication failed/);
  // The SQLite eligible-node ordering and original streaming encoder must
  // produce EXACTLY the existing publication schedule SHA, including an edge
  // that is an order prerequisite rather than a content dependency.
  store.run('DELETE FROM completed');
  const artifact = (name, stage, dependencies = [], prerequisites = []) => {
    const body = JSON.stringify({ name }); return { key: `history/_index_v3/observations_timeseries/${name}.json`,
      body, byte_size: Buffer.byteLength(body), sha256: sha256(body), publication_stage: stage,
      dependencies, publication_prerequisites: prerequisites };
  };
  const external = { key: 'history/v3/observations/check.parquet', byte_size: 1, sha256: '1'.repeat(64),
    kind: 'canonical_parquet', verified: true, durable: true };
  const identity = (value) => ({ key: value.key, byte_size: value.byte_size, sha256: value.sha256 });
  const a = artifact('a', 'child_shard', [identity(external)]), b = artifact('b', 'child_shard', [], [identity(a)]);
  const c = artifact('c', 'scoped_manifest', [identity(a), identity(b)]);
  const expected = buildObservationHistoryIndexV3PublicationPlan({ objects: [c, b, a], externalReferences: [external] });
  const baseline = new BoundedBaseline(store);
  for (const value of [external, a, b, c]) store.run('INSERT INTO completed VALUES(?,?,?)', value.key,
    JSON.stringify({ ...identity(value), verified: true, durable: true, stored_sha256_verified: true }), 1);
  baseline.addObject(external, { external: 1, parquet: true });
  for (const value of expected.entries) {
    baseline.addObject(value, { v3: true });
    store.run('INSERT INTO publications(key,evidence) VALUES(?,?)', value.key, JSON.stringify({ ...identity(value),
      position: value.position, publication_stage: value.publication_stage, schedule_sha256: expected.schedule_sha256, post_put_get_verified: true }));
  }
  await baseline.scheduleAndAuthenticatePublications();
  assert.equal(baseline.scheduleSha256, expected.schedule_sha256);
  store.run("UPDATE publications SET evidence=json_set(evidence,'$.schedule_sha256',?)", '0'.repeat(64));
  store.run('UPDATE objects SET position=NULL WHERE v3=1');
  await assert.rejects(baseline.scheduleAndAuthenticatePublications(), /contradicts immutable schedule/);
  // Verify that bounded commits/yields do not truncate a live disk row cursor.
  for (let index = 0; index < 300; index++) {
    store.run('INSERT INTO logical_rows VALUES(?)', String(index)); await store.boundary();
  }
  let rows = 0;
  for (const _row of store.iterate('SELECT encoded FROM logical_rows ORDER BY encoded COLLATE BINARY')) {
    rows++; await store.boundary();
  }
  assert.equal(rows, 300);
  process.stdout.write('PASS: disk plan/replay encodings, exact chain/tail refusal, publication DAG/hash and contradictory evidence refusal\n');
} finally { store?.close(); fs.rmSync(work, { recursive: true }); }
