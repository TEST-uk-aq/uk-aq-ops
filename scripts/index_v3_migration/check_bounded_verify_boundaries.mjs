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
import { validateRecoveryUpdateStructure } from '../backup_r2/uk_aq_observation_history_migration_v3.mjs';
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
  const options = { checkpoint: cp, checkpointIdentity: cpIdentity, checkpointPath, store,
    validateUpdateStructure: validateRecoveryUpdateStructure, onEntry: async () => {} };
  const authenticated = await authenticateDiskJournal(options);
  assert.equal(authenticated.last_entry_sha256, old.last_entry_sha256);
  fs.copyFileSync(entryPath, path.join(entriesRoot, '0000000002.json'));
  await assert.rejects(authenticateDiskJournal(options), /beyond committed head/);
  fs.unlinkSync(path.join(entriesRoot, '0000000002.json'));
  entry.payload.previous_entry_sha256 = '0'.repeat(64); fs.writeFileSync(entryPath, JSON.stringify(entry));
  await assert.rejects(authenticateDiskJournal(options), /authentication failed/);
  // Structurally malformed but fully hash-authenticated updates must fail before
  // completion/index writes OR the baseline's prepared/publication replay callback.
  const completion = { key: 'one', evidence: { verified: true, durable: true } };
  const malformed = [
    ['empty update', {}],
    ['unknown field', { unexpected: true }],
    ...['prepared_records', 'prepared_state_updates', 'completed_objects', 'preparation_order_append', 'publication_evidence']
      .flatMap((key) => [[`empty ${key}`, { [key]: [] }], [`non-array ${key}`, { [key]: {} }]]),
    ['publication batch over 16', { publication_evidence: Array.from({ length: 17 }, (_, position) => ({ position })) }],
    ['equal publication positions', { publication_evidence: [{ position: 1 }, { position: 1 }] }],
    ['decreasing publication positions', { publication_evidence: [{ position: 2 }, { position: 1 }] }],
    ['invalid publication position', { publication_evidence: [{ position: -1 }] }],
    ['non-integer publication position', { publication_evidence: [{ position: 1.5 }] }],
    ['non-object publication', { publication_evidence: [null] }],
    ['duplicate state units', { prepared_state_updates: [{ unit_id: 'one', files_published: true }, { unit_id: 'one', remove_staging_refs: true }] }],
    ['state without transition', { prepared_state_updates: [{ unit_id: 'one' }] }],
    ['state missing unit', { prepared_state_updates: [{ files_published: true }] }],
    ['state false transition', { prepared_state_updates: [{ unit_id: 'one', files_published: false }] }],
    ['state non-boolean transition', { prepared_state_updates: [{ unit_id: 'one', remove_staging_refs: 1 }] }],
    ['state unknown field', { prepared_state_updates: [{ unit_id: 'one', files_published: true, unexpected: true }] }],
    ['prepared missing field', { prepared_records: [{ unit_id: 'one' }] }],
    ['prepared extra field', { prepared_records: [{ unit_id: 'one', record: {}, unexpected: true }] }],
    ['completion missing field', { completed_objects: [{ key: 'one' }] }],
    ['completion extra field', { completed_objects: [{ ...completion, unexpected: true }] }],
    ...[null, false, [], 1].map((value) => ['invalid clean-start structure', { clean_target_admission: value }]),
    ['final missing field', { final_state: { full_verification_complete: true } }],
    ['final extra field', { final_state: { full_verification_complete: true, cutover_ready: true, unexpected: true } }],
    ['final non-boolean', { final_state: { full_verification_complete: true, cutover_ready: 1 } }],
    ['cutover before verification', { final_state: { full_verification_complete: false, cutover_ready: true } }],
    ['malformed later field with valid completion', { completed_objects: [completion], prepared_state_updates: [{ unit_id: 'one' }] }],
  ];
  const valid = [
    { clean_target_admission: {} },
    { prepared_records: [{ unit_id: 'one', record: {} }], preparation_order_append: ['one'] },
    { completed_objects: [completion] },
    { prepared_state_updates: [{ unit_id: 'one', files_published: true }] },
    { prepared_state_updates: [{ unit_id: 'one', remove_staging_refs: true }] },
    { prepared_state_updates: [{ unit_id: 'one', files_published: true, remove_staging_refs: true }] },
    ...[[false, false], [true, false], [true, true]].map(([full_verification_complete, cutover_ready]) =>
      ({ final_state: { full_verification_complete, cutover_ready } })),
    { publication_evidence: Array.from({ length: 16 }, (_, position) => ({ position })) },
  ];
  const writeUpdate = (updates) => {
    store.run('DELETE FROM completed'); store.run('DELETE FROM journal');
    store.counters.completion_records = 0; store.counters.journal_entries = 0;
    const authenticatedEntry = writeEnvelope(entryPath, entry.kind, { ...entry.payload, previous_entry_sha256: null, updates });
    writeEnvelope(path.join(journalRoot, 'head.json'), 'uk_aq_observation_history_v3_recovery_head', {
      original_checkpoint_sha256: cpIdentity.sha256, immutable_authority_sha256: cp.authority_sha256,
      last_sequence: 1, last_entry_sha256: authenticatedEntry.payload_sha256 });
  };
  for (const [name, updates] of malformed) {
    assert.throws(() => validateRecoveryUpdateStructure(updates), undefined, name);
    writeUpdate(updates); let callbacks = 0;
    await assert.rejects(authenticateDiskJournal({ ...options, onEntry: async () => { callbacks++; } }), undefined, name);
    assert.equal(callbacks, 0, name);
    assert.equal(store.count('completed'), 0, name); assert.equal(store.count('journal'), 0, name);
    assert.equal(store.counters.completion_records, 0, name); assert.equal(store.counters.journal_entries, 0, name);
  }
  for (const updates of valid) {
    assert.doesNotThrow(() => validateRecoveryUpdateStructure(updates));
    writeUpdate(updates); let callbacks = 0;
    await authenticateDiskJournal({ ...options, onEntry: async () => { callbacks++; } });
    assert.equal(callbacks, 1); assert.equal(store.count('journal'), 1);
  }
  await assert.rejects(authenticateDiskJournal({ ...options, validateUpdateStructure: undefined }), /validator is required/);
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
  process.stdout.write(`PASS: disk plan/replay encodings, exact chain/tail refusal, shared update validator (${malformed.length} malformed / ${valid.length} valid structures; rejection before replay writes), publication DAG/hash and contradictory evidence refusal\n`);
} finally { store?.close(); fs.rmSync(work, { recursive: true }); }
